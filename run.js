#!/usr/bin/env node
// Headless Robot War battle runner.
//
// Usage:
//   node run.js bot1 bot2 bot3 bot4            # free-for-all
//   node run.js rambo pacer vs sniper hunter   # teams (split on 'vs')
//   node run.js -n 100 rambo vs pacer          # 100 battles
//   node run.js mybot.rs vs sniper -n 50       # .rs file as a bot
//
// Options:
//   -n, --count N    Number of battles (default 1)
//   --arena N        Arena half-size (default 14)
//   --shots N        HP / shots to kill (default 6)
//   --layout NAME    Wall layout: open|cross|fourRooms|pillars|maze|downtown (default cross)
//   --minutes N      Time limit in minutes (default 3)
//   --mines N        Number of land mines (default 0)
//   --no-radio       Disable team radio
//   -v, --verbose    Print each battle result even when running many battles
'use strict';

const fs   = require('fs');
const path = require('path');

// ---- Load game modules ----
// The scripts use IIFEs that export to `window`. Point window at global so
// they land on the same namespace as Node builtins, without vm sandbox overhead.
const dir = path.dirname(fs.realpathSync(process.argv[1]));
global.window    = global;
global.globalThis = global;
for (const f of ['roboscript.js', 'roboscript-compiler.js', 'strategies.js', 'game.js']) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(code);
}

/* global GameEngine, RoboScriptCompiler, RoboScript, Strategies */

const USAGE = `\
Usage: node run.js [options] bot1 bot2 ...
       node run.js [options] bot1 bot2 vs bot3 bot4   (teams, split on 'vs')

Bots: strategy name (${Object.keys(Strategies).join(', ')})
      or a .rs file path for a RoboScript bot

Options:
  -n, --count N    Number of battles (default 1)
  --arena N        Arena half-size (default 14)
  --shots N        HP / shots to kill (default 6)
  --layout NAME    open|cross|fourRooms|pillars|maze|downtown (default cross)
  --minutes N      Time limit in minutes (default 3)
  --mines N        Number of land mines (default 0)
  --no-radio       Disable team radio
  --dt N           Simulation timestep in seconds (default 0.05; larger = faster)
  -v, --verbose    Print each battle result when running many battles
  -h, --help       Show this help`;

// ---- Parse arguments ----
let count = 1, arenaSize = 14, layout = 'cross', shotsToKill = 6;
let wallHp = 2, mineCount = 0, mineDamage = 2, roundMinutes = 3;
let radioEnabled = true, dt = 0.05, verbose = false;
const rawBots = []; // strategy names or .rs paths, with 'vs' separators intact

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '-n' || a === '--count')   count        = +argv[++i];
  else if (a === '--arena')                 arenaSize    = +argv[++i];
  else if (a === '--shots')                 shotsToKill  = +argv[++i];
  else if (a === '--layout')                layout       =  argv[++i];
  else if (a === '--minutes')               roundMinutes = +argv[++i];
  else if (a === '--mines')                 mineCount    = +argv[++i];
  else if (a === '--no-radio')              radioEnabled = false;
  else if (a === '--dt')                    dt           = +argv[++i];
  else if (a === '-v' || a === '--verbose') verbose      = true;
  else if (a === '-h' || a === '--help')    { console.log(USAGE); process.exit(0); }
  else if (!a.startsWith('-'))              rawBots.push(a);
  else { console.error(`Unknown option: ${a}\n\n${USAGE}`); process.exit(1); }
}

if (rawBots.length === 0) { console.error(USAGE); process.exit(1); }

// ---- Compile any .rs files and register them ----
const resolvedBots = rawBots.map((b) => {
  if (b === 'vs') return 'vs';
  if (b.endsWith('.rs')) {
    const src = fs.readFileSync(b, 'utf8');
    const name = path.basename(b, '.rs');
    const { bytecode, error } = RoboScriptCompiler.compile(src);
    if (error) { console.error(`Compile error in ${b}: ${error}`); process.exit(1); }
    const key = 'rs_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    RoboScript.register(key, name, '', bytecode);
    return key;
  }
  if (!(b in Strategies)) {
    console.error(`Unknown strategy: "${b}"\nAvailable: ${Object.keys(Strategies).filter(k => !k.startsWith('rs_')).join(', ')}`);
    process.exit(1);
  }
  return b;
});

// ---- Split on 'vs' to determine teams ----
const teams = [[]];
for (const b of resolvedBots) {
  if (b === 'vs') teams.push([]);
  else teams[teams.length - 1].push(b);
}
const teamsMode = teams.length > 1;

// ---- Build config ----
let cfg;
if (teamsMode) {
  const robotsPerTeam = Math.max(...teams.map((t) => t.length));
  cfg = {
    arenaSize, layout, shotsToKill, wallHp, mineCount, mineDamage, roundMinutes,
    teamsMode: true, radioEnabled,
    teamCount: teams.length, robotsPerTeam,
    teamStrategies: teams,
  };
} else {
  const bots = teams[0];
  cfg = {
    arenaSize, layout, shotsToKill, wallHp, mineCount, mineDamage, roundMinutes,
    teamsMode: false, radioEnabled,
    robotCount: bots.length, strategies: bots,
  };
}

// ---- Run battles ----
const wins = {}; // entrant name → win count
let draws = 0;
const t0 = Date.now();

for (let b = 0; b < count; b++) {
  const game = GameEngine.create(cfg, Strategies);
  game.startBattle();

  let winner = null, prefix = '', tSim = 0;
  outer: while (true) {
    for (const e of game.tick(dt)) {
      if (e.type === 'round-over') { winner = e.winner; prefix = e.prefix; break outer; }
    }
    tSim += dt;
    if (tSim > roundMinutes * 60 + 10) break; // safety valve
  }

  const entry = winner != null ? game.battleEntrants.find((e) => e.teamId === winner) : null;
  if (entry) wins[entry.name] = (wins[entry.name] ?? 0) + 1;
  else draws++;

  if (verbose || count === 1) {
    const timeStr = (tSim).toFixed(1) + 's';
    if (entry) {
      const strat = !teamsMode ? ` (${entry.strategy})` : '';
      console.log(`Battle ${b + 1}: ${prefix}${entry.name}${strat} wins in ${timeStr}`);
    } else {
      console.log(`Battle ${b + 1}: ${prefix}Draw after ${timeStr}`);
    }
  }
}

// ---- Print summary for multi-battle runs ----
if (count > 1) {
  const elapsed = (Date.now() - t0) / 1000;
  const desc = teamsMode
    ? teams.map((t) => t.join('+') ).join(' vs ')
    : teams[0].join(' vs ');
  const settings = `arena ${arenaSize}, ${layout}, ${shotsToKill}hp, ${roundMinutes}min`;
  console.log(`\n${count} battles — ${desc}  (${settings})`);

  const sorted = Object.entries(wins).sort((a, b) => b[1] - a[1]);
  for (const [name, w] of sorted) {
    const pct = (w / count * 100).toFixed(0).padStart(3);
    console.log(`  ${name.padEnd(18)} ${String(w).padStart(4)} wins  (${pct}%)`);
  }
  if (draws) console.log(`  ${'Draws'.padEnd(18)} ${String(draws).padStart(4)}`);
  console.log(`\n  Elapsed: ${elapsed.toFixed(2)}s  (avg ${(elapsed / count * 1000).toFixed(1)}ms/battle)`);
}
