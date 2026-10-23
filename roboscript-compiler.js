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
//   0 – 63   mem[0..63]   (persistent; written back to me.mem each frame)
//   64 – 127 user vars + temporaries  (vars grow upward from 64; temps fill above)
//   128 – 191 sensor registers        (read-only; compiler returns these by index)
//   192 – 255 output registers        (written via WRO opcode)

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
    EOF:'EOF',
  };

  const KW = new Set([
    'if','then','elseif','else','end','while','do','loop',
    'break','continue','and','or','not',
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
    MIN:0x10,MAX:0x11,RND:0x12,
    CEQ:0x20,CNE:0x21,CLT:0x22,CLE:0x23,CGT:0x24,CGE:0x25,AND:0x26,OR:0x27,NOT:0x28,
    JMP:0x30,JNZ:0x31,JZ:0x32,
    SCN:0x40,WLD:0x41,RDS:0x42,WRO:0x43,HLT:0xFF,
  };

  const SENSOR_BASE = 128;
  const OUTPUT_BASE = 192;

  // Sensor register offsets (read via direct register reference or RDS)
  const SENSOR = {
    'me.x':0,'me.z':1,'me.heading':2,'me.turret':3,'me.hp':4,'me.maxHp':5,
    'me.blocked':6,'me.wallHit':7,'me.robotHit':8,'me.hitAngle':9,
    'world.arena':10,'world.time':11,'world.radarRange':12,
    'world.howitzer.ready':13,'world.howitzer.maxRange':14,
    'radio.tipX':15,'radio.tipZ':16,
    'scan.friendly':20,'scan.dist':21,'scan.angle':22,
  };

  // Output register offsets (written via WRO)
  const OUTPUT = {
    'out.moveX':0,'out.moveZ':1,'out.speed':2,'out.aim':3,'out.fire':4,
    'out.howitzerX':5,'out.howitzerZ':6,
    'out.radioX':7,'out.radioZ':8,
  };

  // ---- Compiler ----
  function compile(source) {
    let toks;
    try { toks = lex(source); }
    catch (e) { return { bytecode: null, vars: null, error: e.message }; }

    const code    = [];   // flat bytecode array
    const vars    = {};   // varName → register number
    let nextVar   = 64;   // next unused variable register (grows up from 64)
    let tempNext  = 64;   // temporary register watermark (reset per statement)
    const loops   = [];   // loop-context stack { breaks:[], cont:number }

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
      if (nextVar >= 128) fail('Too many variables (max 64)');
      return (vars[name] = nextVar++);
    }
    function beginStmt() { tempNext = nextVar; }
    function allocTmp()  { if (tempNext >= 128) fail('Expression too complex'); return tempNext++; }
    function endStmt()   { tempNext = nextVar; }

    // ---- Bytecode emission ----
    //   emit(op, dst, a, b, imm)
    //   dst/a/b are register indices; imm is the float immediate (second word).
    function emit(op, dst, a, b, imm = 0) {
      const word = ((op & 0xFF) | ((dst & 0xFF) << 8) | ((a & 0xFF) << 16) | ((b & 0xFF) << 24)) >>> 0;
      code.push(word, imm);
    }

    // Returns the index of the imm slot just emitted, for later back-patching.
    function emitJMP(tgt = 0) { const s = code.length + 1; emit(OP.JMP, 0, 0, 0, tgt); return s; }
    function emitJZ (r, tgt=0){ const s = code.length + 1; emit(OP.JZ,  r, 0, 0, tgt); return s; }

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
    const UNI = { sin:OP.SIN, cos:OP.COS, sqrt:OP.SQT, abs:OP.ABS, floor:OP.FLR, wallDist:OP.WLD };
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
          fail(`Unknown function '${name}'`);
        }

        // mem[i] read — index must be a compile-time integer literal 0..63
        if (name === 'mem') {
          eat(T.LB);
          const itok = eat(T.NUM);
          const idx = itok.v | 0;
          if (!Number.isInteger(itok.v) || idx < 0 || idx >= 64)
            fail(`mem index must be an integer 0..63`);
          eat(T.RB);
          return idx;  // mem[i] lives at register i — no instruction needed
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

      // mem[i] = expr
      if (name === 'mem' && chk(T.LB)) {
        adv();
        const itok = eat(T.NUM);
        const idx = itok.v | 0;
        if (!Number.isInteger(itok.v) || idx < 0 || idx >= 64)
          fail(`mem index must be an integer 0..63`);
        eat(T.RB);
        eat(T.ASSIGN);
        const r = expr();
        if (idx !== r) emit(OP.MOV, idx, r, 0);
        return;
      }

      // varName = expr
      eat(T.ASSIGN);
      const r = expr();
      const vr = allocVar(name);
      if (vr !== r) emit(OP.MOV, vr, r, 0);
    }

    // ---- Top-level ----
    try {
      stmtList();
      if (!chk(T.EOF)) fail(`Unexpected token '${peek().t}'`);
      emit(OP.HLT, 0, 0, 0, 0);
      return { bytecode: code, vars, error: null };
    } catch (e) {
      return { bytecode: null, vars: null, error: e.message };
    }
  }

  global.RoboScriptCompiler = { compile };
})(window);
