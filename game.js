// Robot War game simulation engine.
// No DOM or renderer dependencies — runs in Node.js and browser alike.
//
// Usage:
//   const game = GameEngine.create(config, strategies);
//   game.startBattle();
//   const events = game.tick(dt);   // returns event array each frame
//   // events: boom, crumble, impact, radio-pulse, robot-exploded, missile-hit, round-over
//
// Public state (read-only):
//   game.phase, game.battleTime, game.arena, game.walls, game.robots,
//   game.bullets, game.mines, game.battleEntrants, game.teamEliminatedAt, game.teamsMode
(function (global) {
  'use strict';

  // ---- Module-level constants ----
  const MAX_HP            = 6;
  const MAX_SPEED         = 1.8;
  const BULLET_SPEED      = 16;
  const DEATH_TIME        = 0.7;
  const ROBOT_RADIUS      = 0.7;
  const MINE_BLAST        = 2.2;
  const MINE_TRIGGER      = 0.8;
  const HOWITZER_SPEED    = 20;
  const HOWITZER_GRAVITY  = 10;
  const HOWITZER_BLAST    = 3.0;
  const HOWITZER_COOLDOWN = 5;
  const BLOCK_SIZE        = 1;
  const NAV_CELL          = 0.5;
  const NAV_CLEAR         = ROBOT_RADIUS + 0.25;
  const STREET            = 3.2;

  // ---- Static data (exported for renderer / UI) ----
  const TEAMS = [
    { name: 'Coral',  color: [1.0,  0.45, 0.40] },
    { name: 'Teal',   color: [0.25, 0.75, 0.72] },
    { name: 'Sunny',  color: [1.0,  0.75, 0.25] },
    { name: 'Violet', color: [0.60, 0.50, 0.95] },
    { name: 'Lime',   color: [0.50, 0.92, 0.22] },
    { name: 'Azure',  color: [0.22, 0.52, 1.0]  },
    { name: 'Rose',   color: [1.0,  0.35, 0.68] },
    { name: 'Amber',  color: [1.0,  0.58, 0.08] },
  ];

  const WALL_LAYOUTS = {
    open: [],
    cross: [
      [-0.5,   -0.25,  -0.443,  0.25 ],
      [ 0.443, -0.25,   0.5,    0.25 ],
      [-0.25,  -0.5,    0.25,  -0.443],
      [-0.25,   0.443,  0.25,   0.5  ],
      [-0.071, -0.071,  0.071,  0.071],
    ],
    fourRooms: [
      [-1.0,  -0.036, -0.15,  0.036],
      [ 0.15, -0.036,  1.0,   0.036],
      [-0.036,  0.15,  0.036, 1.0  ],
      [-0.036, -1.0,   0.036,-0.15 ],
    ],
    pillars: [
      [-0.6,  -0.6,  -0.5,  -0.5 ],
      [ 0.5,  -0.6,   0.6,  -0.5 ],
      [-0.6,   0.5,  -0.5,   0.6 ],
      [ 0.5,   0.5,   0.6,   0.6 ],
      [-0.071,-0.071,  0.071, 0.071],
      [ 0.3,  -0.15,  0.4,   0.15 ],
    ],
    maze: [
      [-0.7,  -0.036,  0.1,   0.036],
      [ 0.3,  -0.036,  0.7,   0.036],
      [-0.1,  -0.7,    0.036,-0.15 ],
      [-0.036,  0.2,   0.1,   0.7  ],
      [ 0.4,   0.3,    0.5,   0.7  ],
      [-0.5,  -0.65,  -0.4,  -0.3  ],
    ],
  };

  const BUILDING_KINDS = [
    { tex: 'facade-brick.jpg',        tile: 5.4,  color: [0.43, 0.41, 0.41], minH: 1.6, maxH: 2.8 },
    { tex: 'facade-concrete.jpg',     tile: 5.4,  color: [0.35, 0.36, 0.37], minH: 2.2, maxH: 4.2 },
    { tex: 'facade-white-office.jpg', tile: 7.2,  color: [0.46, 0.5,  0.5 ], minH: 1.8, maxH: 3.6 },
    { tex: 'facade-glass.jpg',        tile: 9,    color: [0.27, 0.3,  0.33], minH: 3.2, maxH: 5.5 },
    { tex: 'facade-dark-office.jpg',  tile: 28.8, color: [0.37, 0.33, 0.31], minH: 2.6, maxH: 4.6 },
  ];

  // ---- Map building ----
  function buildWalls(layoutKey, arena, wallHp = 2) {
    const blocks = [];
    const addBox = (x0, z0, x1, z1, extra) => {
      const nx = Math.max(1, Math.round((x1 - x0) / BLOCK_SIZE));
      const nz = Math.max(1, Math.round((z1 - z0) / BLOCK_SIZE));
      if (extra?.building) Object.assign(extra.building, { x0, z0, x1, z1, blocks: nx * nz });
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++)
          blocks.push({
            x0: x0 + ((x1 - x0) * i) / nx, x1: x0 + ((x1 - x0) * (i + 1)) / nx,
            z0: z0 + ((z1 - z0) * j) / nz, z1: z0 + ((z1 - z0) * (j + 1)) / nz,
            hp: wallHp || Infinity, maxHp: wallHp, seed: Math.random() * 10, ...extra,
          });
    };
    if (layoutKey === 'downtown') buildDowntown(arena, addBox);
    else for (const [fx0, fz0, fx1, fz1] of WALL_LAYOUTS[layoutKey] ?? []) addBox(fx0 * arena, fz0 * arena, fx1 * arena, fz1 * arena);
    return blocks;
  }

  function buildDowntown(arena, addBox) {
    let seed = 1013904223 + arena * 7919;
    const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const range = (a, b) => a + rand() * (b - a);

    const cutAxis = () => {
      const lo = -arena + STREET, inner = 2 * (arena - STREET);
      const n = Math.max(1, Math.round((inner + 3.4) / (6.5 + 3.4)));
      const streets = Array.from({ length: n - 1 }, () => (rand() < 0.2 ? range(4.4, 5.2) : range(2.6, 3.8)));
      const weights = Array.from({ length: n }, () => range(0.4, 2));
      const room = inner - streets.reduce((a, b) => a + b, 0), wsum = weights.reduce((a, b) => a + b, 0);
      const spans = [];
      let a = lo;
      for (let i = 0; i < n; i++) {
        const w = (room * weights[i]) / wsum;
        spans.push([a, a + w]);
        a += w + (streets[i] ?? 0);
      }
      return spans;
    };
    const xs = cutAxis(), zs = cutAxis();

    const merged = new Set(), blocks = [];
    for (let i = 0; i < xs.length; i++)
      for (let j = 0; j < zs.length; j++) {
        if (merged.has(i + ',' + j)) continue;
        let [x0, x1] = xs[i], [z0, z1] = zs[j];
        if (rand() < 0.25) {
          const right = i + 1 < xs.length && !merged.has(i + 1 + ',' + j);
          const down  = j + 1 < zs.length && !merged.has(i + ',' + (j + 1));
          if (right && (!down || rand() < 0.5)) { x1 = xs[i + 1][1]; merged.add(i + 1 + ',' + j); }
          else if (down) { z1 = zs[j + 1][1]; merged.add(i + ',' + (j + 1)); }
        }
        blocks.push([x0, z0, x1, z1]);
      }

    const lots = [];
    const split = (x0, z0, x1, z1, depth) => {
      const w = x1 - x0, d = z1 - z0, long = Math.max(w, d);
      if (long < 4.6 || (depth > 0 && rand() < 0.3) || depth > 3) { lots.push([x0, z0, x1, z1]); return; }
      const t = range(Math.max(0.3, 2.2 / long), Math.min(0.7, 1 - 2.2 / long));
      if (w >= d) { const m = x0 + w * t; split(x0, z0, m, z1, depth + 1); split(m, z0, x1, z1, depth + 1); }
      else        { const m = z0 + d * t; split(x0, z0, x1, m, depth + 1); split(x0, m, x1, z1, depth + 1); }
    };
    for (const b of blocks) {
      if (rand() < 0.07) continue;
      split(...b, 0);
    }

    for (let [x0, z0, x1, z1] of lots) {
      if (rand() < 0.08) continue;
      const back = (len) => (len > 3 && rand() < 0.25 ? range(0.3, 0.7) : 0);
      const bx = x1 - x0, bz = z1 - z0;
      x0 += back(bx); x1 -= back(bx); z0 += back(bz); z1 -= back(bz);
      const k = Math.floor(rand() * BUILDING_KINDS.length), kind = BUILDING_KINDS[k];
      const h = kind.minH + rand() * (kind.maxH - kind.minH);
      const shade = 0.9 + rand() * 0.2;
      addBox(x0, z0, x1, z1, {
        h, color: kind.color.map((v) => Math.min(1, v * shade)),
        facade: { layer: k, tile: kind.tile, tint: Math.min(1.1, 1.05 * shade) },
        building: {},
      });
    }
  }

  // ---- Game factory ----
  function create(cfg, strategies) {
    const radioEnabled  = cfg.radioEnabled ?? true;
    const roundMinutes  = cfg.roundMinutes ?? 3;
    const STRATEGY_KEYS = Object.keys(strategies);

    let ARENA        = cfg.arenaSize ?? 14;
    let RADAR_RANGE  = ARENA * 2 * Math.SQRT2;
    let WALLS        = buildWalls(cfg.layout ?? 'cross', ARENA, cfg.wallHp ?? 2);
    let wallsVersion = 0, nav = null;

    let robots   = [];
    let bullets  = [];
    let mines    = [];
    const teamRadio = new Map();
    let battleTime = 0, battleEntrants = [], teamEliminatedAt = {};
    let _phase  = 'setup';
    let _events = [];

    // ---- Utilities ----
    const clamp      = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const angDiff    = (from, to)  => Math.atan2(Math.sin(to - from), Math.cos(to - from));
    const turnToward = (cur, target, step) => cur + Math.max(-step, Math.min(step, angDiff(cur, target)));

    // ---- Navigation ----
    function navGrid() {
      if (nav && nav.version === wallsVersion && nav.arena === ARENA) return nav;
      const n = Math.ceil((2 * ARENA) / NAV_CELL), free = new Uint8Array(n * n), lim = ARENA - 0.8;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const x = -ARENA + (i + 0.5) * NAV_CELL, z = -ARENA + (j + 0.5) * NAV_CELL;
          free[j * n + i] = Math.abs(x) <= lim && Math.abs(z) <= lim ? 1 : 0;
        }
      const cellIdx = (v) => Math.floor((v + ARENA) / NAV_CELL);
      for (const w of WALLS)
        for (let j = Math.max(0, cellIdx(w.z0 - NAV_CLEAR)); j <= Math.min(n - 1, cellIdx(w.z1 + NAV_CLEAR)); j++)
          for (let i = Math.max(0, cellIdx(w.x0 - NAV_CLEAR)); i <= Math.min(n - 1, cellIdx(w.x1 + NAV_CLEAR)); i++) {
            const x = -ARENA + (i + 0.5) * NAV_CELL, z = -ARENA + (j + 0.5) * NAV_CELL;
            if (Math.hypot(x - clamp(x, w.x0, w.x1), z - clamp(z, w.z0, w.z1)) < NAV_CLEAR) free[j * n + i] = 0;
          }
      return (nav = { n, free, version: wallsVersion, arena: ARENA });
    }

    const navCell  = (g, p) => [clamp(Math.floor((p.x + ARENA) / NAV_CELL), 0, g.n - 1), clamp(Math.floor((p.z + ARENA) / NAV_CELL), 0, g.n - 1)];
    const navPoint = (i, j) => ({ x: -ARENA + (i + 0.5) * NAV_CELL, z: -ARENA + (j + 0.5) * NAV_CELL });
    const navFree  = (g, p) => { const [i, j] = navCell(g, p); return g.free[j * g.n + i] === 1; };

    function nearestFreePoint(p) {
      const g = navGrid(), [ci, cj] = navCell(g, p);
      if (g.free[cj * g.n + ci]) return { x: p.x, z: p.z };
      for (let rad = 1; rad < g.n; rad++) {
        let best = null, bestD = Infinity;
        for (let j = cj - rad; j <= cj + rad; j++)
          for (let i = ci - rad; i <= ci + rad; i++) {
            if (i < 0 || j < 0 || i >= g.n || j >= g.n || Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== rad) continue;
            if (!g.free[j * g.n + i]) continue;
            const q = navPoint(i, j), d = Math.hypot(q.x - p.x, q.z - p.z);
            if (d < bestD) { bestD = d; best = q; }
          }
        if (best) return best;
      }
      return { x: p.x, z: p.z };
    }

    function lineClear(a, b) {
      const g = navGrid(), d = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.ceil(d / (NAV_CELL / 2));
      for (let k = 1; k < steps; k++) {
        const t = k / steps, along = t * d;
        if (along < 0.75 || d - along < 0.75) continue;
        if (!navFree(g, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
      }
      return true;
    }

    function findPath(from, to) {
      const g = navGrid(), n = g.n;
      const s = nearestFreePoint(from), t = nearestFreePoint(to);
      const [si, sj] = navCell(g, s), [ti, tj] = navCell(g, t);
      const start = sj * n + si, goal = tj * n + ti;
      const h = (k) => { const dx = Math.abs((k % n) - ti), dz = Math.abs(((k / n) | 0) - tj); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
      const cost = new Float32Array(n * n).fill(Infinity), came = new Int32Array(n * n).fill(-1);
      const heap = [[h(start), start]];
      const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop  = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      cost[start] = 0;
      let best = start;
      while (heap.length) {
        const [, k] = pop();
        if (k === goal) { best = k; break; }
        if (h(k) < h(best)) best = k;
        const i = k % n, j = (k / n) | 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ni = i + di, nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= n || nj >= n || !g.free[nj * n + ni]) continue;
            if (di && dj && (!g.free[j * n + ni] || !g.free[nj * n + i])) continue;
            const nk = nj * n + ni, c = cost[k] + (di && dj ? 1.414 : 1);
            if (c < cost[nk]) { cost[nk] = c; came[nk] = k; push([c + h(nk), nk]); }
          }
      }
      const path = [];
      for (let k = best; k !== start && k !== -1; k = came[k]) path.push(navPoint(k % n, (k / n) | 0));
      return path.reverse();
    }

    function steer(r, goal) {
      if (!goal || lineClear(r, goal)) { r.nav = null; return goal; }
      let nv = r.nav;
      if (!nv || nv.version !== wallsVersion || Math.hypot(nv.gx - goal.x, nv.gz - goal.z) > 1 ||
          battleTime - nv.t > 2 || (r.blocked && battleTime - nv.t > 0.5)) {
        nv = r.nav = { gx: goal.x, gz: goal.z, version: wallsVersion, t: battleTime, path: findPath(r, goal) };
      }
      const p = nv.path;
      while (p.length > 1 && Math.hypot(p[0].x - r.x, p[0].z - r.z) < 0.6) p.shift();
      if (!p.length) return goal;
      for (let i = Math.min(p.length - 1, 24); i > 0; i--) if (lineClear(r, p[i])) return p[i];
      return p[0];
    }

    // ---- Mines ----
    function placeMines(count, damage) {
      const placed = [], lim = ARENA - 1.5;
      for (let tries = 0; placed.length < count && tries < count * 200; tries++) {
        const p = { x: (Math.random() * 2 - 1) * lim, z: (Math.random() * 2 - 1) * lim };
        if (WALLS.some((w) => p.x > w.x0 - 1 && p.x < w.x1 + 1 && p.z > w.z0 - 1 && p.z < w.z1 + 1)) continue;
        if (robots.some((r) => Math.hypot(r.x - p.x, r.z - p.z) < 3.5)) continue;
        if (placed.some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 1.8)) continue;
        placed.push({ ...p, damage: damage || Infinity, seed: Math.random() * 10 });
      }
      return placed;
    }

    function damageBlock(block, hits = 1) {
      if (block.hp === Infinity || (block.hp -= hits) > 0) return;
      WALLS.splice(WALLS.indexOf(block), 1);
      wallsVersion++;
      _events.push({ type: 'crumble', x0: block.x0, z0: block.z0, x1: block.x1, z1: block.z1,
        h: block.h, color: block.color, maxHp: block.maxHp, seed: block.seed });
    }

    function detonate(mine) {
      mines.splice(mines.indexOf(mine), 1);
      _events.push({ type: 'boom', x: mine.x, z: mine.z, color: [0.3, 0.32, 0.28], seed: mine.seed });
      for (const r of robots) {
        if (r.dying !== null || Math.hypot(r.x - mine.x, r.z - mine.z) > MINE_BLAST) continue;
        r.hit = 1;
        r.hp = Math.max(0, r.hp - mine.damage);
        if (r.hp === 0) { r.dying = 0; sendDeathNotice(r); }
      }
      for (const w of WALLS.slice()) {
        const cx = clamp(mine.x, w.x0, w.x1), cz = clamp(mine.z, w.z0, w.z1);
        if (Math.hypot(cx - mine.x, cz - mine.z) < MINE_BLAST) damageBlock(w, mine.damage);
      }
    }

    // ---- Radar ----
    function rayBox(ox, oz, dx, dz, w) {
      let t0 = 0, t1 = Infinity;
      for (const [o, d, lo, hi] of [[ox, dx, w.x0, w.x1], [oz, dz, w.z0, w.z1]]) {
        if (Math.abs(d) < 1e-9) {
          if (o < lo || o > hi) return Infinity;
        } else {
          let a = (lo - o) / d, b = (hi - o) / d;
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a);
          t1 = Math.min(t1, b);
          if (t0 > t1) return Infinity;
        }
      }
      return t0;
    }

    function rayLength(x, z, angle, max) {
      const dx = Math.sin(angle), dz = Math.cos(angle);
      let t = max;
      if (dx > 1e-9) t = Math.min(t, (ARENA - x) / dx);
      if (dx < -1e-9) t = Math.min(t, (-ARENA - x) / dx);
      if (dz > 1e-9) t = Math.min(t, (ARENA - z) / dz);
      if (dz < -1e-9) t = Math.min(t, (-ARENA - z) / dz);
      for (const w of WALLS) t = Math.min(t, rayBox(x, z, dx, dz, w));
      return t;
    }

    function scan(r, angle, width) {
      width = clamp(typeof width === 'number' ? width : 0.17, 0.03, 0.35);
      let found = null;
      for (const o of robots) {
        if (o === r || o.dying !== null) continue;
        const d = Math.hypot(o.x - r.x, o.z - r.z), dir = Math.atan2(o.x - r.x, o.z - r.z);
        if (d > RADAR_RANGE) continue;
        if (Math.abs(angDiff(angle, dir)) > width / 2 + Math.asin(Math.min(1, ROBOT_RADIUS / d))) continue;
        if (rayLength(r.x, r.z, dir, d) < d) continue;
        if (!found || d < found.dist) found = { dist: d, friendly: o.teamId === r.teamId };
      }
      r.scan = { angle, width, found: !!found, range: found ? found.dist : rayLength(r.x, r.z, angle, RADAR_RANGE), age: 0 };
      return found;
    }

    // ---- Radio ----
    function deliverRadio() {
      for (const r of robots) {
        const msgs = teamRadio.get(r.teamId) ?? [];
        r.radioInbox = msgs.filter((m) => m._from !== r.robotIndex);
      }
      teamRadio.clear();
    }

    function sendDeathNotice(r) {
      const teamStillAlive = robots.some((x) => x !== r && x.teamId === r.teamId && x.dying === null);
      if (!teamStillAlive) teamEliminatedAt[r.teamId] = battleTime;
      if (!radioEnabled) return;
      const allTeamIds = new Set(robots.map((x) => x.teamId));
      for (const teamId of allTeamIds) {
        if (!teamRadio.has(teamId)) teamRadio.set(teamId, []);
        teamRadio.get(teamId).push({ type: 'death', teamId: r.teamId, x: r.x, z: r.z, _from: -1 });
      }
    }

    // ---- Combat ----
    function fire(r) {
      const side = r.nextSide;
      r.nextSide ^= 1;
      r.recoil[side] = 1;
      r.cooldown = 2 + Math.random() * 1.5;
      const lx = side ? 0.6 : -0.6, lz = 0.6, c = Math.cos(r.turret), s = Math.sin(r.turret);
      const bx = r.x + c * lx + s * lz, bz = r.z - s * lx + c * lz;
      const aimDist = r.scan ? r.scan.range : RADAR_RANGE;
      const ax = r.x + s * aimDist, az = r.z + c * aimDist;
      const ddx = ax - bx, ddz = az - bz, dd = Math.hypot(ddx, ddz);
      bullets.push({
        x: bx, y: 1.4, z: bz, x0: bx, z0: bz,
        vx: (ddx / dd) * BULLET_SPEED, vz: (ddz / dd) * BULLET_SPEED,
        owner: r, color: r.color, life: RADAR_RANGE / BULLET_SPEED,
      });
    }

    function fireHowitzer(r, tx, tz) {
      const dx = tx - r.x, dz = tz - r.z, range = Math.hypot(dx, dz);
      if (range < 1) return;
      const sinVal = range * HOWITZER_GRAVITY / (HOWITZER_SPEED * HOWITZER_SPEED);
      if (sinVal > 1) return;
      const theta = Math.PI / 2 - Math.asin(sinVal) / 2;
      const vh = HOWITZER_SPEED * Math.cos(theta), vy0 = HOWITZER_SPEED * Math.sin(theta);
      const tFlight = (vy0 + Math.sqrt(vy0 * vy0 + 2 * HOWITZER_GRAVITY * 1.2)) / HOWITZER_GRAVITY;
      bullets.push({
        x: r.x, z: r.z, y: 1.2, x0: r.x, z0: r.z,
        vx: (dx / range) * vh, vz: (dz / range) * vh, vy: vy0, gravity: HOWITZER_GRAVITY,
        owner: r, color: r.color, howitzer: true,
        life: tFlight + 0.5, lifeMax: tFlight,
      });
      r.howCooldown = HOWITZER_COOLDOWN;
    }

    function landHowitzer(b) {
      if (Math.abs(b.x) > ARENA || Math.abs(b.z) > ARENA) return;
      _events.push({ type: 'boom', x: b.x, z: b.z, color: b.color, seed: Math.random() * 10, scale: 2.0 });
      for (const r of robots) {
        if (r.dying !== null || r.teamId === b.owner.teamId) continue;
        if (Math.hypot(r.x - b.x, r.z - b.z) < HOWITZER_BLAST) {
          r.hit = 1;
          _events.push({ type: 'missile-hit' });
          r.hp -= 1;
          if (r.hp <= 0) { r.hp = 0; r.dying = 0; sendDeathNotice(r); }
        }
      }
      for (const w of WALLS.slice()) {
        const cx = clamp(b.x, w.x0, w.x1), cz = clamp(b.z, w.z0, w.z1);
        if (Math.hypot(cx - b.x, cz - b.z) < HOWITZER_BLAST) damageBlock(w);
      }
    }

    function drive(r, goal, speedFactor, dt) {
      const before = r.heading;
      let targetSpeed = 0;
      if (goal) {
        const lim = ARENA - 0.8;
        const gx = clamp(goal.x, -lim, lim), gz = clamp(goal.z, -lim, lim);
        const d = Math.hypot(gx - r.x, gz - r.z);
        if (d > 0.3) {
          const want = Math.atan2(gx - r.x, gz - r.z);
          r.heading = turnToward(r.heading, want, 2.4 * dt);
          const off = angDiff(r.heading, want);
          if (Math.abs(off) < 0.8) targetSpeed = MAX_SPEED * clamp(speedFactor, 0, 1.3) * Math.cos(off) * Math.min(1, d / 1.5);
        }
      }
      r.turnRate = angDiff(before, r.heading) / dt;
      r.speed += (targetSpeed - r.speed) * Math.min(1, dt * 4);
      r.x += Math.sin(r.heading) * r.speed * dt;
      r.z += Math.cos(r.heading) * r.speed * dt;
      r.wheel += r.speed * dt;
    }

    function pushOutOfWall(r, w) {
      const cx = clamp(r.x, w.x0, w.x1), cz = clamp(r.z, w.z0, w.z1);
      const dx = r.x - cx, dz = r.z - cz, d = Math.hypot(dx, dz);
      if (d >= ROBOT_RADIUS) return;
      r.wallHit = true;
      if (!r.robotHit) r.hitAngle = d > 1e-6 ? Math.atan2(cx - r.x, cz - r.z) : r.heading;
      if (d > 1e-6) {
        r.x = cx + (dx / d) * ROBOT_RADIUS;
        r.z = cz + (dz / d) * ROBOT_RADIUS;
      } else {
        const exits = [[w.x0 - ROBOT_RADIUS - r.x, 0], [w.x1 + ROBOT_RADIUS - r.x, 0], [0, w.z0 - ROBOT_RADIUS - r.z], [0, w.z1 + ROBOT_RADIUS - r.z]];
        const [ex, ez] = exits.reduce((a, b) => (Math.hypot(...b) < Math.hypot(...a) ? b : a));
        r.x += ex; r.z += ez;
      }
    }

    // ---- Think ----
    function think(r) {
      let scanned = false;
      const radio = radioEnabled ? {
        inbox: r.radioInbox ?? [],
        send(msg) {
          if (!teamRadio.has(r.teamId)) teamRadio.set(r.teamId, []);
          teamRadio.get(r.teamId).push({ ...msg, _from: r.robotIndex });
          if (battleTime - (r._lastPulse ?? -1) > 0.4) {
            _events.push({ type: 'radio-pulse', x: r.x, z: r.z, color: r.color });
            r._lastPulse = battleTime;
          }
        },
      } : null;
      const world = {
        arena: ARENA, walls: WALLS, bulletSpeed: BULLET_SPEED, radarRange: RADAR_RANGE, time: battleTime,
        scan:     (angle, width) => (scanned ? null : ((scanned = true), scan(r, angle, width))),
        wallDist: (angle) => rayLength(r.x, r.z, angle, RADAR_RANGE),
        radio,
        howitzer: {
          ready: r.howCooldown <= 0,
          maxRange: HOWITZER_SPEED ** 2 / HOWITZER_GRAVITY,
          canReach: (tx, tz) => {
            const d = Math.hypot(tx - r.x, tz - r.z);
            return d >= 1 && d * HOWITZER_GRAVITY <= HOWITZER_SPEED ** 2;
          },
        },
      };
      try {
        return strategies[r.strategy].think(r, world) || {};
      } catch (err) {
        if (!r.brainError) console.error(`${r.name} (${r.strategy}) crashed:`, (r.brainError = err));
        return {};
      }
    }

    function livingTeamCount() {
      return new Set(robots.map((r) => r.teamId)).size;
    }

    // ---- Robot initialization ----
    (function init() {
      const shotsToKill = cfg.shotsToKill ?? MAX_HP;
      if (cfg.teamsMode) {
        const flat = [];
        for (let t = 0; t < cfg.teamCount; t++) {
          const team = TEAMS[t % TEAMS.length];
          const strats = cfg.teamStrategies[t] || [];
          for (let ri = 0; ri < cfg.robotsPerTeam; ri++)
            flat.push({ team, teamId: t, strategy: strats[ri] || STRATEGY_KEYS[ri % STRATEGY_KEYS.length], robotIndex: ri });
        }
        robots = flat.map(({ team, teamId, strategy, robotIndex }, i) => {
          const a = (i / flat.length) * Math.PI * 2 + Math.PI / 4;
          return {
            name: `${team.name} ${robotIndex + 1}`, color: team.color, teamId, robotIndex,
            label: robotIndex + 1, strategy, mem: {},
            x: Math.sin(a) * ARENA * 0.65, z: Math.cos(a) * ARENA * 0.65,
            heading: a + Math.PI, turret: a + Math.PI,
            seed: i * 1.3, speed: 0, wheel: 0, turnRate: 0, recoil: [0, 0], hit: 0,
            hp: shotsToKill, maxHp: shotsToKill, dying: null,
            cooldown: 1.5 + Math.random() * 1.5, nextSide: 0, howCooldown: 0, scan: null,
            stuckTime: 0, blocked: false, wallHit: false, robotHit: false, hitAngle: 0,
          };
        });
      } else {
        const count = cfg.robotCount ?? 4;
        const strats = cfg.strategies ?? [];
        robots = Array.from({ length: count }, (_, i) => {
          const team = TEAMS[i % TEAMS.length];
          const a = (i / count) * Math.PI * 2 + Math.PI / 4;
          return {
            name: team.name, color: team.color, teamId: i, robotIndex: i, label: null,
            strategy: strats[i] || STRATEGY_KEYS[i % STRATEGY_KEYS.length], mem: {},
            x: Math.sin(a) * ARENA * 0.65, z: Math.cos(a) * ARENA * 0.65,
            heading: a + Math.PI, turret: a + Math.PI,
            seed: i * 1.3, speed: 0, wheel: 0, turnRate: 0, recoil: [0, 0], hit: 0,
            hp: shotsToKill, maxHp: shotsToKill, dying: null,
            cooldown: 1.5 + Math.random() * 1.5, nextSide: 0, howCooldown: 0, scan: null,
            stuckTime: 0, blocked: false, wallHit: false, robotHit: false, hitAngle: 0,
          };
        });
      }
      for (const r of robots) r.radioInbox = [];
      for (const r of robots) Object.assign(r, nearestFreePoint(r));
      mines = placeMines(cfg.mineCount ?? 0, cfg.mineDamage ?? 2);

      const seenTeams = new Set();
      for (const r of robots) {
        if (!seenTeams.has(r.teamId)) {
          seenTeams.add(r.teamId);
          const displayName = cfg.teamsMode ? TEAMS[r.teamId % TEAMS.length].name : r.name;
          battleEntrants.push({ teamId: r.teamId, name: displayName, color: r.color,
            strategy: r.strategy, startCount: robots.filter((x) => x.teamId === r.teamId).length });
        }
      }
    })();

    // ---- Main simulation tick ----
    function tick(dt) {
      if (_phase !== 'battle') return [];
      _events = [];

      battleTime += dt;
      deliverRadio();

      for (const r of robots) {
        r.recoil = r.recoil.map((v) => Math.max(0, v - dt * 3));
        r.hit = Math.max(0, r.hit - dt * 4);
        r.cooldown -= dt;
        r.howCooldown = Math.max(0, (r.howCooldown ?? 0) - dt);
        if (r.scan) r.scan.age += dt;
        r.lastX = r.x; r.lastZ = r.z;
        if (r.dying !== null) {
          r.dying += dt / DEATH_TIME;
          r.speed *= Math.max(0, 1 - dt * 6);
          r.turnRate = 0;
          continue;
        }
        const cmd = think(r);
        drive(r, steer(r, cmd.moveTo), cmd.speed ?? 1, dt);
        if (typeof cmd.aim === 'number') {
          r.turret = turnToward(r.turret, cmd.aim, 3 * dt);
          if (cmd.fire && r.cooldown <= 0 && Math.abs(angDiff(r.turret, cmd.aim)) < 0.08) fire(r);
        }
        if (cmd.fireHowitzer && r.howCooldown <= 0)
          fireHowitzer(r, cmd.fireHowitzer.x, cmd.fireHowitzer.z);
      }

      for (let i = robots.length - 1; i >= 0; i--) {
        const r = robots[i];
        if (r.dying !== null && r.dying >= 1) {
          _events.push({ type: 'robot-exploded', x: r.x, z: r.z, color: r.color, seed: r.seed });
          robots.splice(i, 1);
        }
      }

      for (const r of robots) { r.wallHit = false; r.robotHit = false; }

      for (let i = 0; i < robots.length; i++)
        for (let j = i + 1; j < robots.length; j++) {
          const a = robots[i], b = robots[j];
          const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
          if (d < 1.4 && d > 0) {
            const ang = Math.atan2(dx, dz);
            a.robotHit = true; a.hitAngle = ang;
            b.robotHit = true; b.hitAngle = ang + Math.PI;
            const p = (1.4 - d) / 2 / d;
            a.x -= dx * p; a.z -= dz * p; b.x += dx * p; b.z += dz * p;
          }
        }

      const lim = ARENA - 0.8;
      for (const r of robots) {
        for (const w of WALLS) pushOutOfWall(r, w);
        r.x = clamp(r.x, -lim, lim);
        r.z = clamp(r.z, -lim, lim);
        const moved = Math.hypot(r.x - r.lastX, r.z - r.lastZ), wanted = Math.abs(r.speed) * dt;
        r.stuckTime = wanted > 0.005 && moved < wanted * 0.3 ? r.stuckTime + dt : 0;
        r.blocked = r.stuckTime > 0.5;
      }

      for (const r of robots) {
        if (r.dying !== null) continue;
        const mine = mines.find((m) => Math.hypot(m.x - r.x, m.z - r.z) < MINE_TRIGGER);
        if (mine) detonate(mine);
      }

      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx * dt; b.z += b.vz * dt; b.life -= dt;
        let dead = b.life <= 0;
        if (b.howitzer) {
          b.y += b.vy * dt;
          b.vy -= HOWITZER_GRAVITY * dt;
          if (!dead && b.y <= 0 && b.vy < 0) { landHowitzer(b); dead = true; }
        } else {
          const block = WALLS.find((w) => b.x > w.x0 && b.x < w.x1 && b.z > w.z0 && b.z < w.z1);
          if (Math.abs(b.x) > ARENA || Math.abs(b.z) > ARENA || block) {
            _events.push({ type: 'impact', x: b.x, y: b.y, z: b.z });
            dead = true;
          }
          if (block) damageBlock(block);
          for (const r of robots) {
            if (r === b.owner || dead || r.dying !== null || r.teamId === b.owner.teamId) continue;
            if (Math.hypot(r.x - b.x, r.z - b.z) < 0.7) {
              r.hit = 1;
              _events.push({ type: 'missile-hit' });
              r.hp -= 1;
              if (r.hp <= 0) { r.hp = 0; r.dying = 0; sendDeathNotice(r); }
              r.x += b.vx * 0.02; r.z += b.vz * 0.02;
              dead = true;
            }
          }
        }
        if (dead) bullets.splice(i, 1);
      }

      if (livingTeamCount() <= 1) {
        _phase = 'over';
        _events.push({ type: 'round-over', winner: robots[0]?.teamId ?? null, prefix: '' });
      } else if (battleTime >= roundMinutes * 60) {
        _phase = 'over';
        const teamHp = {};
        for (const r of robots.filter((r) => r.dying === null))
          teamHp[r.teamId] = (teamHp[r.teamId] ?? 0) + r.hp;
        const sorted = Object.entries(teamHp).sort((a, b) => b[1] - a[1]);
        const winner = sorted.length > 0 && (sorted.length === 1 || sorted[0][1] > sorted[1][1])
          ? Number(sorted[0][0]) : null;
        _events.push({ type: 'round-over', winner, prefix: "Time's up! " });
      }

      return _events;
    }

    return {
      tick,
      startBattle()           { _phase = 'battle'; },
      get phase()             { return _phase; },
      get battleTime()        { return battleTime; },
      get arena()             { return ARENA; },
      get walls()             { return WALLS; },
      get robots()            { return robots; },
      get bullets()           { return bullets; },
      get mines()             { return mines; },
      get battleEntrants()    { return battleEntrants; },
      get teamEliminatedAt()  { return teamEliminatedAt; },
      get teamsMode()         { return cfg.teamsMode ?? false; },
    };
  }

  const GameEngine = { create, TEAMS, BUILDING_KINDS, WALL_LAYOUTS };
  global.GameEngine = GameEngine;

}(typeof globalThis !== 'undefined' ? globalThis : window));
