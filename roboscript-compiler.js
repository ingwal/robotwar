// RoboScript single-pass compiler.
// See roboscript.md for the language specification.
//
// Usage:
//   const { bytecode, vars, error } = RoboScriptCompiler.compile(source);
//   if (!error) RoboScript.register('mybot', 'My Bot', 'desc', bytecode);
//
// Bytecode format: flat JS array compatible with roboscript.js interpreter.
//   Even indices: packed instruction word  op | (dst<<8) | (a<<16) | (b<<24)
//   Odd  indices: float immediate (literal value, or jump target word-index)
//
// Register assignment:
//   0 – 123  user vars + temporaries  (vars grow upward from 0; temps fill above)
//   124 – 127 function return value registers
//   128 – 191 sensor registers        (read-only; compiler returns these by index)
//   192 – 255 output registers        (written via WRO opcode)
//
// Persistent store (separate 256-entry Float64Array, not the register file):
//   0 –  63  mem[0..63] — MLDS/MSTS with literal index
//   64 – 255 named arrays — allocated by 'arr name[n]' declarations
//   Dynamic mem[expr] and name[expr] use MGET/MSET with a register index.

(function (global) {
  'use strict';

  // ---- Token types ----
  const T = {
    NUM:'NUM', IDENT:'IDENT',
    PLUS:'+', MINUS:'-', STAR:'*', SLASH:'/', PCT:'%', CARET:'^',
    EQ:'==', NEQ:'!=', LT:'<', LE:'<=', GT:'>', GE:'>=',
    ASSIGN:'=',
    LP:'(', RP:')', LB:'[', RB:']', COMMA:',', DOT:'.',
    IF:'if', THEN:'then', ELSEIF:'elseif', ELSE:'else', END:'end',
    WHILE:'while', DO:'do', LOOP:'loop',
    BREAK:'break', CONTINUE:'continue',
    AND:'and', OR:'or', NOT:'not',
    FUNCTION:'function', RETURN:'return',
    ARR:'arr',
    EOF:'EOF',
  };

  const KW = new Set([
    'if','then','elseif','else','end','while','do','loop',
    'break','continue','and','or','not',
    'function','return',
    'arr',
  ]);

  // ---- Lexer ----
  function lex(src) {
    const toks = [];
    let i = 0, ln = 1;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { ln++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      // line comment
      if (c === '-' && src[i+1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
      // number
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i+1] ?? ''))) {
        const s = i;
        while (i < src.length && /[0-9.]/.test(src[i])) i++;
        if (i < src.length && /[eE]/.test(src[i])) {
          i++;
          if (i < src.length && /[+\-]/.test(src[i])) i++;
          while (i < src.length && /[0-9]/.test(src[i])) i++;
        }
        toks.push({ t: T.NUM, v: parseFloat(src.slice(s, i)), ln });
        continue;
      }
      // identifier / keyword
      if (/[a-zA-Z_]/.test(c)) {
        const s = i;
        while (i < src.length && /\w/.test(src[i])) i++;
        const text = src.slice(s, i);
        toks.push({ t: KW.has(text) ? text : T.IDENT, v: text, ln });
        continue;
      }
      // two-char operators
      const two = src.slice(i, i + 2);
      if (two === '==') { toks.push({ t: T.EQ,  ln }); i += 2; continue; }
      if (two === '!=') { toks.push({ t: T.NEQ, ln }); i += 2; continue; }
      if (two === '<=') { toks.push({ t: T.LE,  ln }); i += 2; continue; }
      if (two === '>=') { toks.push({ t: T.GE,  ln }); i += 2; continue; }
      // single-char
      const MAP = {
        '+':T.PLUS,'-':T.MINUS,'*':T.STAR,'/':T.SLASH,'%':T.PCT,'^':T.CARET,
        '=':T.ASSIGN,'(':T.LP,')':T.RP,'[':T.LB,']':T.RB,',':T.COMMA,'.':T.DOT,
        '<':T.LT,'>':T.GT,
      };
      if (MAP[c]) { toks.push({ t: MAP[c], ln }); i++; continue; }
      throw new Error(`Unexpected character '${c}' at line ${ln}`);
    }
    toks.push({ t: T.EOF, ln });
    return toks;
  }

  // ---- Constants shared with the interpreter ----
  const OP = {
    MOV:0x01,LDF:0x02,ADD:0x03,SUB:0x04,MUL:0x05,DIV:0x06,MOD:0x07,POW:0x08,
    NEG:0x09,SIN:0x0A,COS:0x0B,AT2:0x0C,SQT:0x0D,ABS:0x0E,FLR:0x0F,
    MIN:0x10,MAX:0x11,RND:0x12,ISN:0x13,
    CEQ:0x20,CNE:0x21,CLT:0x22,CLE:0x23,CGT:0x24,CGE:0x25,AND:0x26,OR:0x27,NOT:0x28,
    JMP:0x30,JNZ:0x31,JZ:0x32,CALL:0x33,RET:0x34,
    SCN:0x40,WLD:0x41,RDS:0x42,WRO:0x43,
    MLDS:0x44,MSTS:0x45,MGET:0x46,MSET:0x47,
    HLT:0xFF,
  };

  const SENSOR_BASE  = 128;
  const OUTPUT_BASE  = 192;
  const RETURN_BASE  = 124;  // registers 124-127: function return values (4 slots)

  // Sensor register offsets (read via direct register reference or RDS)
  const SENSOR = {
    'me.x':0,'me.z':1,'me.heading':2,'me.turret':3,'me.hp':4,'me.maxHp':5,
    'me.blocked':6,'me.wallHit':7,'me.robotHit':8,'me.hitAngle':9,
    'world.arena':10,'world.time':11,'world.radarRange':12,
    'world.howitzer.ready':13,'world.howitzer.maxRange':14,
    'radio.tipX':15,'radio.tipZ':16,
    'me.teamId':17,'world.bulletSpeed':18,
    'world.firstFrame':19,
    'scan.friendly':20,'scan.dist':21,'scan.angle':22,
    'radio.posX':23,'radio.posZ':24,
    'radio.pos2X':30,'radio.pos2Z':31,'radio.pos3X':32,'radio.pos3Z':33,
    'radio.deathTeamId':25,'radio.deathX':26,'radio.deathZ':27,
    'radio.tipVX':28,'radio.tipVZ':29,
  };

  // Output register offsets (written via WRO)
  const OUTPUT = {
    'out.moveX':0,'out.moveZ':1,'out.speed':2,'out.aim':3,'out.fire':4,
    'out.howitzerX':5,'out.howitzerZ':6,
    'out.radioX':7,'out.radioZ':8,
    'out.sendPos':9,
    'out.radioVX':10,'out.radioVZ':11,
  };

  // ---- Compiler ----
  function compile(source) {
    let toks;
    try { toks = lex(source); }
    catch (e) { return { bytecode: null, vars: null, error: e.message }; }

    const PERSISTENT_SIZE = 256;  // must match roboscript.js
    const MEM_LIMIT       = 64;   // highest allowed mem[] literal index + 1

    const code    = [];   // flat bytecode array
    const vars    = {};   // varName → register number
    let nextVar   = 0;    // next unused variable register (grows up from 0)
    let tempNext  = 0;    // temporary register watermark (reset per statement)
    const loops   = [];   // loop-context stack { breaks:[], cont:number }
    const funcs   = {};   // funcName → { startPC, numParams, numReturns, frameBase }
    let currentFn = null; // non-null while compiling a function body
    const arrays  = {};   // arrName → { base, size }
    let arrNext   = MEM_LIMIT;  // next free offset in persistent store for named arrays

    let pos = 0;
    const peek  = ()  => toks[pos];
    const adv   = ()  => toks[pos++];
    const chk   = (t) => toks[pos].t === t;
    function eat(t) {
      if (!chk(t)) fail(`expected '${t}', got '${toks[pos].t}'`);
      return adv();
    }
    function fail(msg) { throw new Error(`${msg} (line ${toks[pos]?.ln ?? '?'})`); }

    // ---- Register allocation ----
    function allocVar(name) {
      if (name in vars) return vars[name];
      if (nextVar >= RETURN_BASE) fail('Too many variables — function frames exceed register budget');
      return (vars[name] = nextVar++);
    }
    function beginStmt() { tempNext = nextVar; }
    function allocTmp()  { if (tempNext >= RETURN_BASE) fail('Out of registers — too many local variables or expression too large'); return tempNext++; }
    function endStmt()   { tempNext = nextVar; }

    // ---- Bytecode emission ----
    //   emit(op, dst, a, b, imm)
    //   dst/a/b are register indices; imm is the float immediate (second word).
    function emit(op, dst, a, b, imm = 0) {
      const word = ((op & 0xFF) | ((dst & 0xFF) << 8) | ((a & 0xFF) << 16) | ((b & 0xFF) << 24)) >>> 0;
      code.push(word, imm);
    }

    // Returns the index of the imm slot just emitted, for later back-patching.
    function emitJMP(tgt = 0) { const s = code.length + 1; emit(OP.JMP,  0, 0, 0, tgt); return s; }
    function emitJZ (r, tgt=0){ const s = code.length + 1; emit(OP.JZ,   r, 0, 0, tgt); return s; }
    function emitCALL(tgt)    {                             emit(OP.CALL, 0, 0, 0, tgt);             }

    const curPC  = ()      => code.length;          // word-index of next instruction
    const patch  = (s, t)  => { code[s] = t; };     // back-patch imm slot s to target t

    // ---- Expression parser ----
    // Each function returns the register index that holds the result.
    // Sensor/var/mem[i] reads return their register directly (no copy emitted).
    // All other operations allocate a fresh temporary and emit into it.

    const CMP_OPS = {
      [T.EQ]:OP.CEQ,[T.NEQ]:OP.CNE,[T.LT]:OP.CLT,[T.LE]:OP.CLE,[T.GT]:OP.CGT,[T.GE]:OP.CGE,
    };

    function expr()  { return eOr(); }

    function eOr() {
      let r = eAnd();
      while (chk(T.OR)) {
        adv();
        const q = eAnd(), d = allocTmp();
        emit(OP.OR, d, r, q);
        r = d;
      }
      return r;
    }

    function eAnd() {
      let r = eNot();
      while (chk(T.AND)) {
        adv();
        const q = eNot(), d = allocTmp();
        emit(OP.AND, d, r, q);
        r = d;
      }
      return r;
    }

    function eNot() {
      if (chk(T.NOT)) {
        adv();
        const r = eNot(), d = allocTmp();
        emit(OP.NOT, d, r, 0);
        return d;
      }
      return eCmp();
    }

    function eCmp() {
      const r = eAdd();
      const op = CMP_OPS[peek().t];
      if (op !== undefined) {
        adv();
        const q = eAdd(), d = allocTmp();
        emit(op, d, r, q);
        return d;
      }
      return r;
    }

    function eAdd() {
      let r = eMul();
      while (chk(T.PLUS) || chk(T.MINUS)) {
        const op = adv().t === T.PLUS ? OP.ADD : OP.SUB;
        const q = eMul(), d = allocTmp();
        emit(op, d, r, q);
        r = d;
      }
      return r;
    }

    function eMul() {
      let r = ePow();
      while (chk(T.STAR) || chk(T.SLASH) || chk(T.PCT)) {
        const t = adv().t;
        const op = t === T.STAR ? OP.MUL : t === T.SLASH ? OP.DIV : OP.MOD;
        const q = ePow(), d = allocTmp();
        emit(op, d, r, q);
        r = d;
      }
      return r;
    }

    function ePow() {
      const r = eUnary();
      if (chk(T.CARET)) {
        adv();
        const q = ePow(), d = allocTmp();  // right-associative
        emit(OP.POW, d, r, q);
        return d;
      }
      return r;
    }

    function eUnary() {
      if (chk(T.MINUS)) {
        adv();
        const r = eUnary(), d = allocTmp();
        emit(OP.NEG, d, r, 0);
        return d;
      }
      return ePrim();
    }

    // One-arg math builtins → emit unary instruction
    const UNI = { sin:OP.SIN, cos:OP.COS, sqrt:OP.SQT, abs:OP.ABS, floor:OP.FLR, wallDist:OP.WLD, isnan:OP.ISN };
    // Two-arg builtins → emit binary instruction
    const BIN = { min:OP.MIN, max:OP.MAX, atan2:OP.AT2, scan:OP.SCN };

    function ePrim() {
      const tok = peek();

      // Number literal
      if (tok.t === T.NUM) {
        adv();
        const d = allocTmp();
        emit(OP.LDF, d, 0, 0, tok.v);
        return d;
      }

      // Parenthesised expression
      if (tok.t === T.LP) {
        adv();
        const r = expr();
        eat(T.RP);
        return r;
      }

      if (tok.t === T.IDENT) {
        const name = adv().v;

        // Dotted access: me.x, out.aim, scan.dist, world.time,
        // world.howitzer.ready, … (up to two dots supported)
        if (chk(T.DOT)) {
          adv();
          let q = `${name}.${eat(T.IDENT).v}`;
          if (chk(T.DOT)) { adv(); q = `${q}.${eat(T.IDENT).v}`; }
          if (q in SENSOR) return SENSOR_BASE + SENSOR[q];  // direct reg ref, no copy
          if (q in OUTPUT) return OUTPUT_BASE + OUTPUT[q];   // output reg is readable too
          fail(`Unknown field '${q}'`);
        }

        // Function call
        if (chk(T.LP)) {
          adv();
          if (name === 'rand') {
            eat(T.RP);
            const d = allocTmp();
            emit(OP.RND, d, 0, 0);
            return d;
          }
          if (name in UNI) {
            const a = expr(); eat(T.RP);
            const d = allocTmp();
            emit(UNI[name], d, a, 0);
            return d;
          }
          if (name in BIN) {
            const a = expr(); eat(T.COMMA); const b = expr(); eat(T.RP);
            const d = allocTmp();
            emit(BIN[name], d, a, b);
            return d;
          }
          // User-defined function call (single-value expression context)
          if (name in funcs) {
            const fn = funcs[name];
            if (fn.numReturns === 0) fail(`'${name}' returns no value`);
            const args = [];
            if (!chk(T.RP)) {
              args.push(expr());
              while (chk(T.COMMA)) { adv(); args.push(expr()); }
            }
            eat(T.RP);
            if (args.length !== fn.numParams)
              fail(`'${name}': expected ${fn.numParams} argument(s), got ${args.length}`);
            for (let i = 0; i < args.length; i++) {
              if (args[i] !== fn.frameBase + i) emit(OP.MOV, fn.frameBase + i, args[i], 0);
            }
            emitCALL(fn.startPC);
            // Copy first return value to a fresh temp so nested calls don't clobber it.
            const d = allocTmp();
            emit(OP.MOV, d, RETURN_BASE, 0);
            return d;
          }
          fail(`Unknown function '${name}'`);
        }

        // mem[i] read — literal index 0..63: MLDS; expression index: MGET
        if (name === 'mem' && chk(T.LB)) {
          adv();
          if (chk(T.NUM) && toks[pos + 1]?.t === T.RB) {
            const itok = eat(T.NUM);
            const idx = itok.v | 0;
            if (!Number.isInteger(itok.v) || idx < 0 || idx >= MEM_LIMIT)
              fail(`mem index must be an integer 0..${MEM_LIMIT - 1}`);
            eat(T.RB);
            const d = allocTmp(); emit(OP.MLDS, d, 0, 0, idx); return d;
          } else {
            const idxReg = expr(); eat(T.RB);
            const d = allocTmp(); emit(OP.MGET, d, idxReg, 0, 0); return d;
          }
        }

        // Named array read — arr[literal]: MLDS(base+k); arr[expr]: MGET(base)
        if (chk(T.LB) && name in arrays) {
          adv();
          const arr = arrays[name];
          if (chk(T.NUM) && toks[pos + 1]?.t === T.RB) {
            const itok = eat(T.NUM);
            const k = itok.v | 0;
            if (!Number.isInteger(itok.v) || k < 0 || k >= arr.size)
              fail(`index ${k} out of bounds for '${name}[${arr.size}]'`);
            eat(T.RB);
            const d = allocTmp(); emit(OP.MLDS, d, 0, 0, arr.base + k); return d;
          } else {
            const idxReg = expr(); eat(T.RB);
            const d = allocTmp(); emit(OP.MGET, d, idxReg, 0, arr.base); return d;
          }
        }

        // Plain variable (auto-declared on first use)
        return allocVar(name);
      }

      fail(`Unexpected token '${tok.t}'`);
    }

    // ---- Statement parser ----

    const BLOCK_END = new Set([T.END, T.ELSE, T.ELSEIF, T.EOF]);

    function stmtList() {
      while (!BLOCK_END.has(peek().t)) stmt();
    }

    function stmt() {
      beginStmt();
      const tok = peek();
      if      (tok.t === T.IF)       { adv(); stmtIf(); }
      else if (tok.t === T.WHILE)    { adv(); stmtWhile(); }
      else if (tok.t === T.LOOP)     { adv(); stmtLoop(); }
      else if (tok.t === T.BREAK)    { adv(); stmtBreak(); }
      else if (tok.t === T.CONTINUE) { adv(); stmtContinue(); }
      else if (tok.t === T.RETURN)   { adv(); stmtReturn(); }
      else if (tok.t === T.ARR)      { adv(); compileArrayDef(); }
      else if (tok.t === T.IDENT)    { stmtAssign(); }
      else fail(`Expected statement, got '${tok.t}'`);
      endStmt();
    }

    function stmtIf() {
      // 'if' already consumed
      const endJmps = [];

      const cond0 = expr(); eat(T.THEN);
      let falseJmp = emitJZ(cond0, 0);
      stmtList();
      endJmps.push(emitJMP(0));

      while (peek().t === T.ELSEIF) {
        adv();
        patch(falseJmp, curPC());
        beginStmt();
        const c = expr(); eat(T.THEN);
        falseJmp = emitJZ(c, 0);
        endStmt();
        stmtList();
        endJmps.push(emitJMP(0));
      }

      if (peek().t === T.ELSE) {
        adv();
        patch(falseJmp, curPC());
        stmtList();
      } else {
        patch(falseJmp, curPC());
      }

      eat(T.END);
      const endPC = curPC();
      for (const s of endJmps) patch(s, endPC);
    }

    function stmtWhile() {
      // 'while' already consumed
      const top = curPC();
      beginStmt();
      const cond = expr(); eat(T.DO);
      const skipJmp = emitJZ(cond, 0);
      endStmt();

      const ctx = { breaks: [], cont: top };
      loops.push(ctx);
      stmtList();
      loops.pop();

      emit(OP.JMP, 0, 0, 0, top);
      eat(T.END);

      const endPC = curPC();
      patch(skipJmp, endPC);
      for (const s of ctx.breaks) patch(s, endPC);
    }

    function stmtLoop() {
      // 'loop' already consumed — infinite loop; exit via break
      const top = curPC();
      const ctx = { breaks: [], cont: top };
      loops.push(ctx);
      stmtList();
      loops.pop();

      emit(OP.JMP, 0, 0, 0, top);
      eat(T.END);

      const endPC = curPC();
      for (const s of ctx.breaks) patch(s, endPC);
    }

    function stmtBreak() {
      if (!loops.length) fail("'break' outside loop");
      loops[loops.length - 1].breaks.push(emitJMP(0));
    }

    function stmtContinue() {
      if (!loops.length) fail("'continue' outside loop");
      emit(OP.JMP, 0, 0, 0, loops[loops.length - 1].cont);
    }

    function stmtReturn() {
      if (!currentFn) fail("'return' outside function");
      // Return value list ends when the next token can't start an expression.
      const canStart = new Set([T.NUM, T.IDENT, T.LP, T.MINUS, T.NOT]);
      const vals = [];
      if (canStart.has(peek().t)) {
        vals.push(expr());
        while (chk(T.COMMA)) { adv(); vals.push(expr()); }
      }
      if (currentFn.returns >= 0 && currentFn.returns !== vals.length)
        fail(`inconsistent return value count in '${currentFn.name}'`);
      currentFn.returns = vals.length;
      for (let i = 0; i < vals.length; i++) {
        if (vals[i] !== RETURN_BASE + i) emit(OP.MOV, RETURN_BASE + i, vals[i], 0);
      }
      emit(OP.RET, 0, 0, 0);
    }

    function compileFunctionDef() {
      const fname = eat(T.IDENT).v;
      if (fname in funcs) fail(`Duplicate function '${fname}'`);
      eat(T.LP);
      const params = [];
      if (!chk(T.RP)) {
        params.push(eat(T.IDENT).v);
        while (chk(T.COMMA)) { adv(); params.push(eat(T.IDENT).v); }
      }
      eat(T.RP);

      const startPC   = curPC();
      const frameBase = nextVar;

      // Function gets its own variable namespace; outer scope is restored after.
      // nextVar keeps advancing so the frame is permanently carved from the pool.
      const outerVars = Object.assign({}, vars);
      for (const k of Object.keys(vars)) delete vars[k];

      for (const p of params) allocVar(p);

      const outerFn = currentFn;
      currentFn = { name: fname, returns: -1 };

      stmtList();

      emit(OP.RET, 0, 0, 0);  // implicit return at end of body
      eat(T.END);

      const numReturns = currentFn.returns < 0 ? 0 : currentFn.returns;
      currentFn = outerFn;
      funcs[fname] = { startPC, numParams: params.length, numReturns, frameBase };

      for (const k of Object.keys(vars)) delete vars[k];
      Object.assign(vars, outerVars);
      // nextVar is NOT restored — the function's register frame is permanent.
    }

    function stmtAssign() {
      const name = adv().v;

      // out.x = expr  or  me.x = expr (error)
      if (chk(T.DOT)) {
        adv();
        const field = eat(T.IDENT).v;
        const q = `${name}.${field}`;
        eat(T.ASSIGN);
        const r = expr();
        if (q in OUTPUT) { emit(OP.WRO, OUTPUT[q], r, 0); return; }
        if (q in SENSOR) fail(`'${q}' is read-only`);
        fail(`Unknown field '${q}'`);
      }

      // Bare function call as statement: foo(args)  (return values discarded)
      if (chk(T.LP) && name in funcs) {
        adv();
        const fn = funcs[name];
        const args = [];
        if (!chk(T.RP)) {
          args.push(expr());
          while (chk(T.COMMA)) { adv(); args.push(expr()); }
        }
        eat(T.RP);
        if (args.length !== fn.numParams)
          fail(`'${name}': expected ${fn.numParams} argument(s), got ${args.length}`);
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== fn.frameBase + i) emit(OP.MOV, fn.frameBase + i, args[i], 0);
        }
        emitCALL(fn.startPC);
        return;
      }

      // mem[i] = expr — literal index: MSTS; expression index: MSET
      if (name === 'mem' && chk(T.LB)) {
        adv();
        if (chk(T.NUM) && toks[pos + 1]?.t === T.RB) {
          const itok = eat(T.NUM);
          const idx = itok.v | 0;
          if (!Number.isInteger(itok.v) || idx < 0 || idx >= MEM_LIMIT)
            fail(`mem index must be an integer 0..${MEM_LIMIT - 1}`);
          eat(T.RB); eat(T.ASSIGN);
          const r = expr();
          emit(OP.MSTS, 0, r, 0, idx);
        } else {
          const idxReg = expr(); eat(T.RB); eat(T.ASSIGN);
          const r = expr();
          emit(OP.MSET, 0, idxReg, r, 0);
        }
        return;
      }

      // arr[i] = expr — literal index: MSTS(base+k); expression index: MSET(base)
      if (chk(T.LB) && name in arrays) {
        adv();
        const arr = arrays[name];
        if (chk(T.NUM) && toks[pos + 1]?.t === T.RB) {
          const itok = eat(T.NUM);
          const k = itok.v | 0;
          if (!Number.isInteger(itok.v) || k < 0 || k >= arr.size)
            fail(`index ${k} out of bounds for '${name}[${arr.size}]'`);
          eat(T.RB); eat(T.ASSIGN);
          const r = expr();
          emit(OP.MSTS, 0, r, 0, arr.base + k);
        } else {
          const idxReg = expr(); eat(T.RB); eat(T.ASSIGN);
          const r = expr();
          emit(OP.MSET, 0, idxReg, r, arr.base);
        }
        return;
      }

      // multi-assign: a, b = foo(...)
      if (chk(T.COMMA)) {
        const targets = [name];
        while (chk(T.COMMA)) { adv(); targets.push(eat(T.IDENT).v); }
        eat(T.ASSIGN);
        const fname = eat(T.IDENT).v;
        if (!(fname in funcs)) fail(`multi-assign right-hand side must be a user-defined function call`);
        const fn = funcs[fname];
        if (targets.length !== fn.numReturns)
          fail(`'${fname}' returns ${fn.numReturns} value(s), but ${targets.length} target(s) given`);
        eat(T.LP);
        const args = [];
        if (!chk(T.RP)) {
          args.push(expr());
          while (chk(T.COMMA)) { adv(); args.push(expr()); }
        }
        eat(T.RP);
        if (args.length !== fn.numParams)
          fail(`'${fname}': expected ${fn.numParams} argument(s), got ${args.length}`);
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== fn.frameBase + i) emit(OP.MOV, fn.frameBase + i, args[i], 0);
        }
        emitCALL(fn.startPC);
        for (let i = 0; i < targets.length; i++) {
          const vr = allocVar(targets[i]);
          if (vr !== RETURN_BASE + i) emit(OP.MOV, vr, RETURN_BASE + i, 0);
        }
        return;
      }

      // varName = expr
      eat(T.ASSIGN);
      const r = expr();
      const vr = allocVar(name);
      if (vr !== r) emit(OP.MOV, vr, r, 0);
    }

    // ---- Array declarations ----
    function compileArrayDef() {
      if (currentFn) fail("'arr' declarations must be at the top level, not inside a function");
      const name = eat(T.IDENT).v;
      if (name in arrays) fail(`Duplicate array declaration '${name}'`);
      if (name in vars)   fail(`'${name}' is already declared as a variable`);
      eat(T.LB);
      const sizeTok = eat(T.NUM);
      const size = sizeTok.v | 0;
      if (!Number.isInteger(sizeTok.v) || size < 1) fail('array size must be a positive integer');
      eat(T.RB);
      if (arrNext + size > PERSISTENT_SIZE)
        fail(`array '${name}[${size}]' exceeds persistent storage (${PERSISTENT_SIZE - arrNext} slots remaining)`);
      arrays[name] = { base: arrNext, size };
      arrNext += size;
    }

    // ---- Top-level ----
    // Function definitions and array declarations emit no main-body code and can
    // appear freely; a single JMP at the start of bytecode skips function bodies.
    try {
      let mainJmpSlot = -1;
      while (!chk(T.EOF)) {
        if (peek().t === T.FUNCTION) {
          if (mainJmpSlot < 0) mainJmpSlot = emitJMP(0);
          adv();
          compileFunctionDef();
        } else if (peek().t === T.ARR) {
          adv();
          compileArrayDef();
        } else {
          if (mainJmpSlot >= 0) { patch(mainJmpSlot, curPC()); mainJmpSlot = -1; }
          stmt();
        }
      }
      if (mainJmpSlot >= 0) patch(mainJmpSlot, curPC());
      emit(OP.HLT, 0, 0, 0, 0);
      return { bytecode: code, vars, arrays, error: null };
    } catch (e) {
      return { bytecode: null, vars: null, error: e.message };
    }
  }

  global.RoboScriptCompiler = { compile };
})(window);
