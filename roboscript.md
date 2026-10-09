# Robot War — User Strategy Bytecode System

## Overview

Users could write their own robot strategy in a small domain-specific
language, compile it in the browser, and upload the resulting bytecode
to the site. The server stores it and injects it as a strategy when a
match is created. This document analyses the implementation difficulty
of each layer and proposes a concrete language design.

---

## Difficulty Assessment

### 1. Bytecode interpreter (inside the game loop)

**Effort: Low–Medium (~1–2 days)**

The interpreter replaces the JavaScript `think()` call with a bytecode
execution loop. The game already calls `think(me, world)` once per
frame and expects a plain object back. A bytecode strategy just needs
to be a different kind of "think function" that runs a few hundred
instructions instead of native JS.

Key design points:

- **Register machine, not stack machine.** A small fixed set of named
  registers (`x`, `z`, `heading`, `hp`, …) fed from `me`/`world` makes
  the instruction set tiny and the interpreter dead simple. A stack
  machine is more flexible but adds ~30% more opcode surface.

- **Instruction set size.** ~30–40 opcodes covers everything:
  arithmetic, comparison, conditional jump, read-sensor,
  write-output. Fewer opcodes = fewer security holes.

- **Execution budget.** Cap at e.g. 4 000 instructions per frame. If
  the program loops past the budget, treat it as a `think()` returning
  the last valid output. This prevents infinite loops from stalling
  the game loop. One counter incremented per opcode is sufficient.

- **Memory model.** A flat array of 64 floats (the robot's "memory")
  maps directly to `me.mem`.  No heap, no GC, no closures. Each frame
  the interpreter reads memory from the previous frame and writes new
  values into it.

- **Security.** Because the interpreter is pure JavaScript running
  inside the same origin, the main risk is CPU abuse (infinite loops —
  solved above) and attempts to break out of the sandbox. With a
  register/flat-memory model there is no way to access JS objects; the
  only communication channel is the fixed opcode set. No `eval`, no
  `Function`, no prototype access.

Verdict: straightforward to build. The main gotcha is getting the
execution budget right so a tight inner loop (e.g. "search 12 random
points in one frame") doesn't time out, while still blocking true
infinite loops.

### 2. Compiler (browser-side)

**Effort: Medium (~3–5 days)**

A recursive-descent single-pass compiler for a simple imperative
language is about 300–500 lines of JavaScript. No external
dependencies, no build step — a plain `<script>` tag on the "upload
strategy" page.

The hard parts are:

- **Expression parsing with operator precedence** (the classic Pratt /
  precedence-climbing technique solves this in ~50 lines).

- **Loop and if/else code generation** — requires forward jumps that
  need to be back-patched once the block end is known. Manageable but
  requires care.

- **Helpful error messages** — easy to do badly, important for
  usability. Tracking line/column in the lexer and surfacing them in
  errors is worth the extra effort.

No type system needed: everything is a float (matching the game's
world model).

### 3. Server-side storage and injection

**Effort: Low (~1 day)**

Store the compiled bytecode as a JSON array (or base64-encoded binary)
in a database row alongside the user's name and strategy
description. When building a match, fetch the bytecode for any
participating user-submitted strategy and pass it to the front end as
a `userStrategy` object. The front end creates an interpreter instance
the same way it creates a built-in strategy — it just routes to the
interpreter's `think()` wrapper instead of native JS.

### 4. Validation / static analysis

**Effort: Low (~half a day)**

Before storing, verify: bytecode length ≤ N, all opcodes are valid,
all jump targets are in-range, no opcode takes an out-of-range
register index. This is a single linear pass and catches all malformed
inputs without executing anything.

---

## The Mini Language: RoboScript

RoboScript is intentionally minimal — closer to BASIC than to C. Every
value is a float. There are no pointers, no objects, no closures, no
strings.

### Sensor/output names

These are the only names wired into the runtime. Everything else is a
user variable.

**Readable (from `me` / `world`):**

| Name | Value |
|------|-------|
| `me.x` | robot x position |
| `me.z` | robot z position |
| `me.heading` | current heading (radians) |
| `me.turret` | current turret angle |
| `me.hp` | current hit points |
| `me.maxHp` | max hit points |
| `me.blocked` | 1 if stuck >0.5s, else 0 |
| `me.wallHit` | 1 if touching a wall this frame |
| `me.robotHit` | 1 if touching another robot this frame |
| `me.hitAngle` | direction of collision |
| `mem[0..63]` | 64 floats of persistent memory |
| `world.arena` | half-size of the arena |
| `world.time` | elapsed battle time |
| `world.radarRange` | max radar range |

**Sensor calls (consume the one scan-per-frame budget):**

```
scan(angle, width)   -- fires the radar; returns 0 (miss), or dist (positive) if enemy,
                        or -dist (negative) if friendly. Stores angle+dist in scan.angle/scan.dist
scan.angle           -- angle of last scan result (set whether hit or miss)
scan.dist            -- distance of last scan result (0 if miss)
scan.friendly        -- 1 if last scan hit a friendly, 0 otherwise
wallDist(angle)      -- distance to nearest wall in that direction (unlimited calls/frame)
```

**Writable outputs (consumed at end of `think()`):**

| Name | Effect |
|------|--------|
| `out.moveX` | moveTo.x |
| `out.moveZ` | moveTo.z |
| `out.speed` | speed fraction 0..1.3 |
| `out.aim` | turret aim angle (NaN = don't move turret) |
| `out.fire` | non-zero = fire |

### Syntax

```roboscript
-- line comments with --
-- variables declared on first assignment; all floats

sweep = me.turret

loop
  sweep = sweep + 0.15
  d = scan(sweep, 0.17)
  if d > 0 then    -- positive dist = enemy
    out.aim  = sweep
    out.fire = 1
    break
  end
  if d < 0 then    -- negative dist = friendly
    break
  end
end

if me.blocked or me.wallHit then
  out.moveX = -me.x
  out.moveZ = -me.z
end

out.speed = 1.0
```

#### Language constructs

```
-- assignment
x = expr

-- arithmetic
+  -  *  /  %  ^     (standard precedence; ^ is power)
-expr                 (unary negate)

-- comparison (return 0.0 or 1.0)
==  !=  <  <=  >  >=

-- logical
and  or  not          (short-circuit on 1.0/0.0)

-- conditionals
if expr then
  ...
elseif expr then
  ...
else
  ...
end

-- loops
loop
  ...
  if expr then break end
  if expr then continue end
end

while expr do
  ...
end

-- built-in calls
scan(angle, width)    -- returns signed dist as above
wallDist(angle)       -- returns float
sin(x)  cos(x)  atan2(y, x)  sqrt(x)  abs(x)  min(a,b)  max(a,b)  floor(x)  rand()

-- persistent memory (survives between frames)
mem[0]  mem[1]  ...  mem[63]   -- read and write like variables
```

No functions, no recursion, no arrays beyond `mem[]`. The absence of
user-defined functions keeps the compiler one-pass and the bytecode
flat.

### Bytecode instruction set

Each instruction is two 32-bit words: `[opcode | dst<<8 | src1<<16 |
src2<<24]` and a float immediate. Registers 0–63 are
`mem[]`. Registers 64–127 are temporaries/locals. Sensor registers are
read-only and mapped above 127.

```
Opcode  Mnemonic       Operation
------  -------        ---------
0x01    MOV  dst src   dst = src
0x02    LDF  dst imm   dst = imm (load float immediate)
0x03    ADD  dst a b   dst = a + b
0x04    SUB  dst a b   dst = a - b
0x05    MUL  dst a b   dst = a * b
0x06    DIV  dst a b   dst = a / b  (0 if b==0)
0x07    MOD  dst a b   dst = a % b
0x08    POW  dst a b   dst = a ^ b
0x09    NEG  dst src   dst = -src
0x0A    SIN  dst src   dst = sin(src)
0x0B    COS  dst src   dst = cos(src)
0x0C    AT2  dst a b   dst = atan2(a, b)
0x0D    SQT  dst src   dst = sqrt(src)
0x0E    ABS  dst src   dst = abs(src)
0x0F    FLR  dst src   dst = floor(src)
0x10    MIN  dst a b   dst = min(a, b)
0x11    MAX  dst a b   dst = max(a, b)
0x12    RND  dst        dst = Math.random()
0x20    CEQ  dst a b   dst = (a == b) ? 1 : 0
0x21    CNE  dst a b   dst = (a != b) ? 1 : 0
0x22    CLT  dst a b   dst = (a <  b) ? 1 : 0
0x23    CLE  dst a b   dst = (a <= b) ? 1 : 0
0x24    CGT  dst a b   dst = (a >  b) ? 1 : 0
0x25    CGE  dst a b   dst = (a >= b) ? 1 : 0
0x26    AND  dst a b   dst = (a && b) ? 1 : 0
0x27    OR   dst a b   dst = (a || b) ? 1 : 0
0x28    NOT  dst src   dst = src ? 0 : 1
0x30    JMP  addr       pc = addr
0x31    JNZ  src addr   if src != 0: pc = addr
0x32    JZ   src addr   if src == 0: pc = addr
0x40    SCN  dst a b   dst = scan(a, b); sets SCAN_ANGLE, SCAN_DIST, SCAN_FRIENDLY
0x41    WLD  dst src   dst = wallDist(src)
0x42    RDS  dst id    dst = sensor[id]   (read me.x, me.hp, etc.)
0x43    WRO  id  src   output[id] = src   (write out.moveX, out.fire, etc.)
0xFF    HLT             end frame (implicit at end of program)
```

Total: 41 opcodes. The interpreter  is a `switch` statement over these
codes, running inside  a `for` loop that  counts executed instructions
and halts at the budget.

### Interpreter skeleton (JavaScript)

```js
function makeInterpreter(bytecode) {
  const BUDGET = 4000;
  const reg = new Float64Array(256);    // 0..63 = mem, 64..127 = temps, 128+ = sensors/output
  const SENSOR_BASE = 128, OUTPUT_BASE = 192;

  return {
    name: 'User',
    think(me, world) {
      // load sensor registers
      reg[SENSOR_BASE +  0] = me.x;
      reg[SENSOR_BASE +  1] = me.z;
      reg[SENSOR_BASE +  2] = me.heading;
      reg[SENSOR_BASE +  3] = me.turret;
      reg[SENSOR_BASE +  4] = me.hp;
      reg[SENSOR_BASE +  5] = me.maxHp;
      reg[SENSOR_BASE +  6] = me.blocked ? 1 : 0;
      reg[SENSOR_BASE +  7] = me.wallHit ? 1 : 0;
      reg[SENSOR_BASE +  8] = me.robotHit ? 1 : 0;
      reg[SENSOR_BASE +  9] = me.hitAngle;
      reg[SENSOR_BASE + 10] = world.arena;
      reg[SENSOR_BASE + 11] = world.time;
      reg[SENSOR_BASE + 12] = world.radarRange;
      // clear outputs
      reg[OUTPUT_BASE + 0] = me.x; reg[OUTPUT_BASE + 1] = me.z; // stay in place by default
      reg[OUTPUT_BASE + 2] = 1.0;  // speed
      reg[OUTPUT_BASE + 3] = NaN;  // aim (no change)
      reg[OUTPUT_BASE + 4] = 0;    // fire

      let pc = 0, budget = BUDGET;
      while (pc < bytecode.length && budget-- > 0) {
        const op = bytecode[pc] & 0xFF, dst = (bytecode[pc] >> 8) & 0xFF,
              a  = (bytecode[pc] >> 16) & 0xFF, b = (bytecode[pc] >> 24) & 0xFF;
        const imm = bytecode[pc + 1];
        pc += 2;
        switch (op) {
          case 0x01: reg[dst] = reg[a]; break;
          case 0x02: reg[dst] = imm;   break;
          case 0x03: reg[dst] = reg[a] + reg[b]; break;
          // … (one line per opcode)
          case 0x40: {
            const hit = world.scan(reg[a], reg[b]);
            reg[dst] = hit ? (hit.friendly ? -hit.dist : hit.dist) : 0;
            reg[SENSOR_BASE + 20] = hit ? (hit.friendly ? -1 : 1) : 0; // SCAN_FRIENDLY
            reg[SENSOR_BASE + 21] = hit ? hit.dist : 0;                 // SCAN_DIST
            break;
          }
          case 0x41: reg[dst] = world.wallDist(reg[a]); break;
          case 0x42: reg[dst] = reg[SENSOR_BASE + (op & 0xFF)]; break;
          case 0x43: reg[OUTPUT_BASE + dst] = reg[a]; break;
          case 0xFF: pc = bytecode.length; break;
        }
      }
      // reg[0..63] is written back to me.mem at end of frame (game does this)
      return {
        moveTo: { x: reg[OUTPUT_BASE], z: reg[OUTPUT_BASE + 1] },
        speed:  reg[OUTPUT_BASE + 2],
        aim:    isNaN(reg[OUTPUT_BASE + 3]) ? null : reg[OUTPUT_BASE + 3],
        fire:   reg[OUTPUT_BASE + 4] !== 0,
      };
    },
  };
}
```

---

## Total Effort Estimate

| Layer | Difficulty | Estimate |
|-------|-----------|---------|
| Bytecode interpreter (in-game, JS) | Low | 1 day |
| Compiler (browser, JS) | Medium | 3–5 days |
| Server storage + injection | Low | 1 day |
| Bytecode validator | Low | 0.5 day |
| Upload UI + playground | Low | 1 day |
| **Total** | | **~7–9 days** |

The  hardest  single part  is  the  compiler's expression  parser  and
back-patching    for    forward    jumps.     Everything    else    is
straightforward. A working prototype (interpreter + rough compiler, no
server) could  be built  in a weekend;  a polished  uploadable version
with good error messages takes another week.

---

## Open Questions

1. **Sharing** — should users be able to see and fork each other's
   RoboScript source, or is bytecode-only acceptable?

2. **Version compatibility** — if the opcode set changes, old bytecode
   needs to be re-compiled or rejected. Storing source alongside
   bytecode solves this cleanly.

3. **Rate limiting** — the execution budget per frame is the main
   lever. 4 000 instructions at ~200fps is 800 000 JS operations per
   second per robot; with 8 robots that's ~6.4M ops/s, comfortably
   within a modern CPU budget.

4. **Debugging** — a "trace mode" that logs `[opcode pc reg dst val]`
   each step would let users debug strategies without needing a full
   step-debugger.
