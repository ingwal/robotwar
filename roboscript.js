// RoboScript bytecode interpreter and validator.
// See roboscript.md for the full language and instruction-set specification.
//
// Bytecode format: flat array of JS numbers, two words per instruction.
//   word 0 (integer): op | (dst << 8) | (a << 16) | (b << 24)
//   word 1 (float):   immediate value (used by LDF; jump target pc for JMP/JNZ/JZ)
//
// Register map (256 floats):
//   0 – 63   persistent mem[]  (saved to / restored from me.mem._vmem each frame)
//   64 – 127 temporaries       (zeroed at the start of each frame)
//   128 – 191 sensor registers (read-only; loaded from me / world each frame)
//   192 – 255 output registers (written by WRO; consumed at frame end)
//
// Exposes: RoboScript.{ makeInterpreter, register, validateBytecode, OP, SID, OID }

(function (global) {
  'use strict';

  const BUDGET      = 4000;  // max instructions executed per frame
  const MEM_SIZE    = 64;    // persistent registers
  const SENSOR_BASE = 128;
  const OUTPUT_BASE = 192;

  // ---- Sensor IDs (used with RDS / direct register access) ----
  const SID = {
    ME_X: 0, ME_Z: 1, ME_HEADING: 2, ME_TURRET: 3,
    ME_HP: 4, ME_MAXHP: 5, ME_BLOCKED: 6, ME_WALLHIT: 7,
    ME_ROBOTHIT: 8, ME_HITANGLE: 9,
    ARENA: 10, TIME: 11, RADAR_RANGE: 12,
    SCAN_FRIENDLY: 20, SCAN_DIST: 21, SCAN_ANGLE: 22,
  };

  // ---- Output IDs (used with WRO) ----
  // HOW_X / HOW_Z: NaN = don't fire howitzer (set to NaN by default each frame).
  const OID = {
    MOVE_X: 0, MOVE_Z: 1, SPEED: 2, AIM: 3, FIRE: 4,
    HOW_X: 5, HOW_Z: 6,
  };

  // ---- Opcodes ----
  const OP = {
    MOV: 0x01, LDF: 0x02,
    ADD: 0x03, SUB: 0x04, MUL: 0x05, DIV: 0x06, MOD: 0x07, POW: 0x08,
    NEG: 0x09, SIN: 0x0A, COS: 0x0B, AT2: 0x0C, SQT: 0x0D,
    ABS: 0x0E, FLR: 0x0F, MIN: 0x10, MAX: 0x11, RND: 0x12,
    CEQ: 0x20, CNE: 0x21, CLT: 0x22, CLE: 0x23, CGT: 0x24, CGE: 0x25,
    AND: 0x26, OR:  0x27, NOT: 0x28,
    JMP: 0x30, JNZ: 0x31, JZ:  0x32,
    SCN: 0x40, WLD: 0x41, RDS: 0x42, WRO: 0x43,
    HLT: 0xFF,
  };
  const VALID_OPS = new Set(Object.values(OP));

  // ---- Interpreter ----

  function makeInterpreter(bytecode, name = 'User', description = 'RoboScript strategy') {
    // One shared register file per interpreter instance.  Safe because think()
    // calls are sequential (never concurrent) and temps are zeroed each call.
    const reg = new Float64Array(256);

    return {
      name,
      description,
      think(me, world) {
        // Restore persistent memory from the previous frame.
        const vmem = me.mem._vmem ?? (me.mem._vmem = new Float64Array(MEM_SIZE));
        for (let i = 0; i < MEM_SIZE; i++) reg[i] = vmem[i];

        // Zero temporaries so stale values don't leak between robots that
        // share this interpreter instance within the same frame.
        reg.fill(0, MEM_SIZE, SENSOR_BASE);

        // Load sensor registers.
        reg[SENSOR_BASE + SID.ME_X]        = me.x;
        reg[SENSOR_BASE + SID.ME_Z]        = me.z;
        reg[SENSOR_BASE + SID.ME_HEADING]  = me.heading;
        reg[SENSOR_BASE + SID.ME_TURRET]   = me.turret;
        reg[SENSOR_BASE + SID.ME_HP]       = me.hp;
        reg[SENSOR_BASE + SID.ME_MAXHP]    = me.maxHp;
        reg[SENSOR_BASE + SID.ME_BLOCKED]  = me.blocked  ? 1 : 0;
        reg[SENSOR_BASE + SID.ME_WALLHIT]  = me.wallHit  ? 1 : 0;
        reg[SENSOR_BASE + SID.ME_ROBOTHIT] = me.robotHit ? 1 : 0;
        reg[SENSOR_BASE + SID.ME_HITANGLE] = me.hitAngle ?? 0;
        reg[SENSOR_BASE + SID.ARENA]       = world.arena;
        reg[SENSOR_BASE + SID.TIME]        = world.time;
        reg[SENSOR_BASE + SID.RADAR_RANGE] = world.radarRange;

        // Default outputs.
        reg[OUTPUT_BASE + OID.MOVE_X] = me.x;   // stay in place
        reg[OUTPUT_BASE + OID.MOVE_Z] = me.z;
        reg[OUTPUT_BASE + OID.SPEED]  = 1.0;
        reg[OUTPUT_BASE + OID.AIM]    = NaN;    // don't rotate turret
        reg[OUTPUT_BASE + OID.FIRE]   = 0;
        reg[OUTPUT_BASE + OID.HOW_X]  = NaN;   // don't fire howitzer
        reg[OUTPUT_BASE + OID.HOW_Z]  = NaN;

        // Execute bytecode.
        const len = bytecode.length;
        let pc = 0, budget = BUDGET;
        while (pc < len && budget-- > 0) {
          const w0  = bytecode[pc];
          const imm = bytecode[pc + 1];
          pc += 2;
          const op  =  w0         & 0xFF;
          const dst = (w0 >>>  8) & 0xFF;
          const a   = (w0 >>> 16) & 0xFF;
          const b   = (w0 >>> 24) & 0xFF;

          switch (op) {
            // Data movement
            case OP.MOV: reg[dst] = reg[a]; break;
            case OP.LDF: reg[dst] = imm;   break;

            // Arithmetic
            case OP.ADD: reg[dst] = reg[a] + reg[b]; break;
            case OP.SUB: reg[dst] = reg[a] - reg[b]; break;
            case OP.MUL: reg[dst] = reg[a] * reg[b]; break;
            case OP.DIV: reg[dst] = reg[b] !== 0 ? reg[a] / reg[b] : 0; break;
            case OP.MOD: reg[dst] = reg[b] !== 0 ? reg[a] % reg[b] : 0; break;
            case OP.POW: reg[dst] = reg[a] ** reg[b]; break;
            case OP.NEG: reg[dst] = -reg[a]; break;

            // Math functions
            case OP.SIN: reg[dst] = Math.sin(reg[a]); break;
            case OP.COS: reg[dst] = Math.cos(reg[a]); break;
            case OP.AT2: reg[dst] = Math.atan2(reg[a], reg[b]); break;
            case OP.SQT: reg[dst] = Math.sqrt(reg[a]); break;
            case OP.ABS: reg[dst] = Math.abs(reg[a]); break;
            case OP.FLR: reg[dst] = Math.floor(reg[a]); break;
            case OP.MIN: reg[dst] = Math.min(reg[a], reg[b]); break;
            case OP.MAX: reg[dst] = Math.max(reg[a], reg[b]); break;
            case OP.RND: reg[dst] = Math.random(); break;

            // Comparisons (produce 0.0 or 1.0)
            case OP.CEQ: reg[dst] = reg[a] === reg[b] ? 1 : 0; break;
            case OP.CNE: reg[dst] = reg[a] !== reg[b] ? 1 : 0; break;
            case OP.CLT: reg[dst] = reg[a] <   reg[b] ? 1 : 0; break;
            case OP.CLE: reg[dst] = reg[a] <=  reg[b] ? 1 : 0; break;
            case OP.CGT: reg[dst] = reg[a] >   reg[b] ? 1 : 0; break;
            case OP.CGE: reg[dst] = reg[a] >=  reg[b] ? 1 : 0; break;

            // Logical (short-circuit semantics on 0/non-zero)
            case OP.AND: reg[dst] = (reg[a] !== 0 && reg[b] !== 0) ? 1 : 0; break;
            case OP.OR:  reg[dst] = (reg[a] !== 0 || reg[b] !== 0) ? 1 : 0; break;
            case OP.NOT: reg[dst] = reg[a] !== 0 ? 0 : 1; break;

            // Control flow (imm = target word-index, i.e. the new value of pc)
            case OP.JMP: pc = imm | 0; break;
            case OP.JNZ: if (reg[dst] !== 0) pc = imm | 0; break;
            case OP.JZ:  if (reg[dst] === 0) pc = imm | 0; break;

            // Sensors / I/O
            case OP.SCN: {
              const hit = world.scan(reg[a], reg[b]);
              reg[dst]                             = hit ? (hit.friendly ? -hit.dist : hit.dist) : 0;
              reg[SENSOR_BASE + SID.SCAN_FRIENDLY] = hit && hit.friendly ? 1 : 0;
              reg[SENSOR_BASE + SID.SCAN_DIST]     = hit ? hit.dist : 0;
              reg[SENSOR_BASE + SID.SCAN_ANGLE]    = reg[a];
              break;
            }
            case OP.WLD: reg[dst] = world.wallDist(reg[a]); break;
            case OP.RDS: reg[dst] = reg[SENSOR_BASE + a]; break;
            case OP.WRO: reg[OUTPUT_BASE + dst] = reg[a]; break;

            case OP.HLT: pc = len; break;
            default:     pc = len; break;  // unknown opcode → halt
          }
        }

        // Save persistent memory for next frame.
        for (let i = 0; i < MEM_SIZE; i++) vmem[i] = reg[i];

        // Build the output object the game engine expects.
        const hx = reg[OUTPUT_BASE + OID.HOW_X];
        const hz = reg[OUTPUT_BASE + OID.HOW_Z];
        const out = {
          moveTo: { x: reg[OUTPUT_BASE + OID.MOVE_X], z: reg[OUTPUT_BASE + OID.MOVE_Z] },
          speed:  reg[OUTPUT_BASE + OID.SPEED],
          aim:    Number.isNaN(reg[OUTPUT_BASE + OID.AIM]) ? null : reg[OUTPUT_BASE + OID.AIM],
          fire:   reg[OUTPUT_BASE + OID.FIRE] !== 0,
        };
        if (!Number.isNaN(hx) && !Number.isNaN(hz)) out.fireHowitzer = { x: hx, z: hz };
        return out;
      },
    };
  }

  // ---- Validator ----
  // Returns an error string on failure, or null if the bytecode is valid.
  function validateBytecode(bytecode) {
    if (!Array.isArray(bytecode) && !ArrayBuffer.isView(bytecode))
      return 'bytecode must be an array';
    if (bytecode.length % 2 !== 0)
      return 'bytecode length must be even (two words per instruction)';
    if (bytecode.length > 16000)
      return 'bytecode exceeds 8000-instruction limit';
    const len = bytecode.length;
    for (let i = 0; i < len; i += 2) {
      const w0 = bytecode[i];
      if (!Number.isFinite(w0) || (w0 | 0) !== w0)
        return `word at index ${i} is not a 32-bit integer`;
      const op  =  w0         & 0xFF;
      const dst = (w0 >>>  8) & 0xFF;
      const a   = (w0 >>> 16) & 0xFF;
      if (!VALID_OPS.has(op))
        return `unknown opcode 0x${op.toString(16)} at instruction ${i / 2}`;
      const imm = bytecode[i + 1];
      if (op === OP.JMP || op === OP.JNZ || op === OP.JZ) {
        const target = imm | 0;
        if (target < 0 || target >= len || target % 2 !== 0)
          return `jump target ${imm} out of range or misaligned at instruction ${i / 2}`;
      }
      if (op === OP.RDS && a >= 64)
        return `RDS sensor id ${a} out of range at instruction ${i / 2}`;
      if (op === OP.WRO && dst >= 7)
        return `WRO output id ${dst} out of range at instruction ${i / 2}`;
    }
    return null;
  }

  // ---- Registration ----
  // Validate, then add a strategy entry to the global Strategies object.
  function register(key, name, description, bytecode) {
    const err = validateBytecode(bytecode);
    if (err) throw new Error('RoboScript: ' + err);
    if (!global.Strategies) throw new Error('RoboScript: Strategies not loaded');
    global.Strategies[key] = makeInterpreter(bytecode, name, description);
    return key;
  }

  global.RoboScript = { makeInterpreter, register, validateBytecode, OP, SID, OID, SENSOR_BASE, OUTPUT_BASE };
})(window);
