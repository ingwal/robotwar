// Robot brains. The game calls a strategy's think() every frame for its robot; the strategy
// says where to drive, where to aim and whether to shoot. The game does the actual driving,
// turret turning and reloading, so every strategy plays by the same physical rules.
//
// Like the original ROBOTWAR, a robot can't see the other robots. It has to find them with
// its radar: world.scan(angle, width) sends out a beam and returns { dist, friendly } for
// the nearest robot inside it, or null if nothing is there. Walls block the beam. One scan
// per frame; extra calls in the same frame return null.
//
//   think(me, world, dt) -> { moveTo, speed, aim, fire }
//
//   me       the robot: x, z, heading, turret, speed, hp, maxHp,
//            x, z       own position (GPS — always available)
//            blocked    true when stuck against something for >0.5 s (long-term)
//            wallHit    true when physically touching a wall or arena edge this frame
//            robotHit   true when physically touching another robot this frame
//            hitAngle   direction toward the obstacle when wallHit or robotHit is set;
//                       call world.scan(me.hitAngle, 0.3) to see if it's a robot,
//                       or world.wallDist(me.hitAngle) to see if it's a wall
//            mem        an empty object the strategy can use to remember things between frames
//   world    { arena, walls, time, bulletSpeed, radarRange, scan, wallDist, radio }
//              arena      half-size of the arena; the floor spans -arena..arena on x and z
//              walls      interior walls as boxes { x0, z0, x1, z1 }
//              scan       angle is a world angle; width is the beam's full width in radians
//                         (0.03..0.35, default 0.17, about 10 degrees)
//                         returns { dist, friendly } or null; friendly = same team as you
//              wallDist   returns distance to the nearest wall or arena edge in direction angle;
//                         unlike scan, this can be called any number of times per frame
//              radio      team radio, or null if disabled:
//                           radio.inbox  messages from teammates since last tick: [{ type, ...data }]
//                           radio.send({ type, ...data })  broadcast to all living teammates
//                         message type used by built-in strategies:
//                           { type: 'enemy', x, z }  enemy spotted at world position x, z
//              howitzer   { ready, maxRange, canReach(x,z) } — howitzer weapon info;
//                           canReach returns true if the position is within firing range
//   moveTo   {x, z} to drive to, or null to stand still
//   speed    0..1.3, fraction of normal top speed (default 1)
//   aim      world angle for the turret, or null to leave it where it is
//   fire     true = shoot as soon as the cannon is reloaded and the turret is on target
//   fireHowitzer  { x, z } to lob a howitzer shell at that world position (area damage on landing);
//                 only fires if world.howitzer.ready and target is in range
//
// Angles: 0 = +z, PI/2 = +x. From the default camera, +z is the bottom of the screen and
// -z is the top, so "straight up the screen" is PI.
(function (global) {
  'use strict';

  // ---------- helpers ----------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const angleTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
  const pointAt = (from, angle, d) => ({ x: from.x + Math.sin(angle) * d, z: from.z + Math.cos(angle) * d });

  const insideWall = (p, walls, margin) =>
    walls.some((w) => p.x > w.x0 - margin && p.x < w.x1 + margin && p.z > w.z0 - margin && p.z < w.z1 + margin);

  // A random spot on the floor that isn't in or right next to a wall.
  function randomOpenPoint(world, margin = 1.5) {
    for (;;) {
      const p = {
        x: (Math.random() * 2 - 1) * (world.arena - margin),
        z: (Math.random() * 2 - 1) * (world.arena - margin),
      };
      if (!insideWall(p, world.walls, 1.2)) return p;
    }
  }

  // Normalize an angle to [-PI, PI].
  const normAngle = (a) => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

  // Return the most recent enemy-position tip from the radio inbox, or null.
  function radioEnemyTip(world) {
    if (!world.radio) return null;
    for (let i = world.radio.inbox.length - 1; i >= 0; i--)
      if (world.radio.inbox[i].type === 'enemy') return world.radio.inbox[i];
    return null;
  }

  // Broadcast the seen target's world position if radio is on and enough time has passed.
  // seen must be { angle, dist } as returned by radarTrack.
  function broadcastEnemy(me, world, seen) {
    if (!seen || !world.radio) return;
    if (world.time - (me.mem.lastBroadcast ?? -99) > 1.5) {
      world.radio.send({ type: 'enemy', ...pointAt(me, seen.angle, seen.dist) });
      me.mem.lastBroadcast = world.time;
    }
  }

  // Return { fireHowitzer: tip } if the howitzer is ready and can reach the latest radio tip, else {}.
  function howitzerAtTip(me, world) {
    if (!world.howitzer.ready) return {};
    const tip = radioEnemyTip(world);
    if (!tip) return {};
    if (!world.howitzer.canReach(tip.x, tip.z)) return {};
    return { fireHowitzer: tip };
  }

  // Sweep the radar round and round until it finds an enemy, then switch to a narrow beam
  // and keep it on the target by probing just left and right of it, nudging toward whichever
  // side still sees it. Friendly robots are ignored. Returns { angle, dist } or null.
  function radarTrack(me, world, width = 0.17) {
    const m = me.mem, narrow = 0.05;
    if (m.lockAngle != null) {
      const offset = [0, 0.06, -0.06][(m.probe = (m.probe + 1) % 3)];
      const hit = world.scan(m.lockAngle + offset, narrow);
      if (hit && !hit.friendly) { m.lockAngle += offset / 2; m.lockDist = hit.dist; m.misses = 0; }
      else if (++m.misses >= 4) { m.sweep = m.lockAngle; m.lockAngle = null; }
    } else {
      m.sweep = (m.sweep ?? me.turret) + width * 0.9;
      const hit = world.scan(m.sweep, width);
      if (hit && !hit.friendly) { m.lockAngle = m.sweep; m.lockDist = hit.dist; m.misses = 0; m.probe = 0; }
    }
    return m.lockAngle != null ? { angle: m.lockAngle, dist: m.lockDist } : null;
  }

  // ---------- strategies ----------
  const STRATEGIES = {
    rambo: {
      name: 'Rambo',
      description: 'Charges around at random, a bit faster than the others, sweeping its radar and shooting at whatever it finds.',
      think(me, world) {
        const m = me.mem;
        if (!m.goal || dist(me, m.goal) < 1 || (me.blocked && !m.wasBlocked)) m.goal = randomOpenPoint(world);
        m.wasBlocked = me.blocked;
        const seen = radarTrack(me, world);
        broadcastEnemy(me, world, seen);
        if (!seen) {
          const tip = radioEnemyTip(world);
          if (tip) m.goal = tip; // charge straight toward the reported position
        }
        return { moveTo: m.goal, speed: 1.2, aim: seen ? seen.angle : null, fire: !!seen,
                 ...(!seen ? howitzerAtTip(me, world) : {}) };
      },
    },

    pacer: {
      name: 'Pacer',
      description: 'Patrols back and forth along the bottom wall with its radar pointed straight up, and fires the moment it sees an enemy.',
      think(me, world) {
        const m = me.mem, edge = world.arena - 1.5;
        m.dir ??= me.x < 0 ? 1 : -1;
        if ((m.dir > 0 && me.x > edge - 0.5) || (m.dir < 0 && me.x < -edge + 0.5) || (me.blocked && !m.wasBlocked)) m.dir = -m.dir;
        m.wasBlocked = me.blocked;
        // Swing radar toward a radio tip when idle; fall back to default straight-up sweep.
        const tip = radioEnemyTip(world);
        const scanAngle = tip ? angleTo(me, tip) : Math.PI;
        const hit = world.scan(scanAngle, tip ? 0.17 : 0.2);
        const seen = hit && !hit.friendly;
        if (seen && world.radio && world.time - (m.lastBroadcast ?? -99) > 1.5) {
          world.radio.send({ type: 'enemy', ...pointAt(me, scanAngle, hit.dist) });
          m.lastBroadcast = world.time;
        }
        return { moveTo: { x: m.dir * edge, z: edge }, aim: scanAngle, fire: !!seen,
                 ...(!seen ? howitzerAtTip(me, world) : {}) };
      },
    },

    sniper: {
      name: 'Sniper',
      description: 'Sits still in a corner with a narrow, precise radar beam. Moves to the next corner after two hits.',
      think(me, world) {
        const m = me.mem, c = world.arena - 1.2;
        const corners = [{ x: -c, z: -c }, { x: c, z: -c }, { x: c, z: c }, { x: -c, z: c }];
        if (m.corner === undefined) {
          m.corner = corners.reduce((best, p, i) => (dist(me, p) < dist(me, corners[best]) ? i : best), 0);
        }
        if (m.lastHp !== undefined && me.hp < m.lastHp) m.hitsHere = (m.hitsHere ?? 0) + 1;
        m.lastHp = me.hp;
        if (m.hitsHere >= 2) { m.corner = (m.corner + 1) % 4; m.hitsHere = 0; }
        const seen = radarTrack(me, world, 0.07);
        broadcastEnemy(me, world, seen);
        if (!seen) {
          // Jump the sweep to face a radio-tipped enemy rather than continuing the blind sweep.
          const tip = radioEnemyTip(world);
          if (tip) m.sweep = angleTo(me, tip) - 0.07; // start just before so next step lands on it
        }
        return { moveTo: corners[m.corner], aim: seen ? seen.angle : null, fire: !!seen,
                 ...(!seen ? howitzerAtTip(me, world) : {}) };
      },
    },

    hunter: {
      name: 'Hunter',
      description: 'Searches with its radar, then circles whatever it finds at close range, shooting until it is gone.',
      think(me, world) {
        const m = me.mem;
        const seen = radarTrack(me, world);
        broadcastEnemy(me, world, seen);
        if (seen && !me.blocked) {
          const prey = pointAt(me, seen.angle, seen.dist);
          const around = angleTo(prey, me) + 0.5;
          const candidate = pointAt(prey, around, 4.5);
          const margin = 1.5;
          const inArena = Math.abs(candidate.x) < world.arena - margin && Math.abs(candidate.z) < world.arena - margin;
          m.goal = (inArena && !insideWall(candidate, world.walls, 1.2)) ? candidate : randomOpenPoint(world);
          m.lastSeen = world.time;
        } else if (!m.goal || dist(me, m.goal) < 1 || (me.blocked && !m.wasBlocked) || world.time - (m.lastSeen ?? 0) > 3) {
          // Hunt toward a radio tip if available, otherwise roam.
          const tip = radioEnemyTip(world);
          m.goal = tip ?? randomOpenPoint(world);
          m.lastSeen = world.time;
        }
        m.wasBlocked = me.blocked;
        return { moveTo: m.goal, speed: 1.1, aim: seen ? seen.angle : null, fire: !!seen,
                 ...(!seen ? howitzerAtTip(me, world) : {}) };
      },
    },

    scaredy: {
      name: 'Scaredy',
      description: 'Uses a wide radar beam to spot enemies coming, runs the other way when someone gets close or it gets hit, and shoots back nervously.',
      think(me, world) {
        const m = me.mem;
        const seen = radarTrack(me, world, 0.35);
        const hurt = m.lastHp !== undefined && me.hp < m.lastHp;
        m.lastHp = me.hp;
        broadcastEnemy(me, world, seen);
        // When taking damage, broadcast the estimated attacker position as an enemy tip.
        if (hurt && world.radio && world.time - (m.lastDistress ?? -99) > 2) {
          world.radio.send({ type: 'enemy', ...pointAt(me, me.hitAngle, 6) });
          m.lastDistress = world.time;
        }
        const tip = radioEnemyTip(world);
        const danger = seen ? pointAt(me, seen.angle, seen.dist)
                     : (me.robotHit || me.wallHit) ? pointAt(me, me.hitAngle, 3)
                     : tip ?? null;
        const needsNewGoal = (seen && seen.dist < 9) || hurt || (me.blocked && !m.wasBlocked)
          || me.wallHit || me.robotHit || !m.goal || dist(me, m.goal) < 1
          || (tip && world.time - (m.lastTipFlee ?? -99) > 3);
        if (needsNewGoal) {
          const flee = danger ?? me;
          let best = -1;
          for (let i = 0; i < 12; i++) {
            const p = randomOpenPoint(world);
            if (dist(p, flee) > best) { best = dist(p, flee); m.goal = p; }
          }
          if (tip) m.lastTipFlee = world.time;
        }
        m.wasBlocked = me.blocked;
        const shaky = Math.sin(world.time * 7) * 0.12;
        return { moveTo: m.goal, aim: seen ? seen.angle + shaky : null, fire: !!seen,
                 ...(!seen ? howitzerAtTip(me, world) : {}) };
      },
    },

    // After Richard A. Fowell's NORDEN+, winner of Computer Gaming World's ROBOTWAR tournament.
    norden: {
      name: 'NORDEN+',
      description: 'Tournament champion from the original game. Hides in a corner and scans only the quarter of the arena in front of it, homes in with a fine scan, and leads its shots. Once hit, it moves from corner to corner along the edge and turns back each time it is hit again.',
      think(me, world) {
        const m = me.mem, c = world.arena - 1.2;
        const corners = [{ x: -c, z: -c }, { x: c, z: -c }, { x: c, z: c }, { x: -c, z: c }];
        if (m.corner === undefined) {
          m.corner = corners.reduce((best, p, i) => (dist(me, p) < dist(me, corners[best]) ? i : best), 0);
          m.dir = 1;
        }

        // Sit in the corner until the first hit, then patrol corner to corner; every later hit reverses.
        const hurt = m.lastHp !== undefined && me.hp < m.lastHp;
        m.lastHp = me.hp;
        if (hurt) { if (m.patrol) m.dir = -m.dir; m.patrol = true; m.corner = (m.corner + m.dir + 4) % 4; }
        else if (me.blocked && !m.wasBlocked) { m.dir = -m.dir; m.corner = (m.corner + m.dir + 4) % 4; }
        else if (m.patrol && dist(me, corners[m.corner]) < 1) m.corner = (m.corner + m.dir + 4) % 4;
        m.wasBlocked = me.blocked;

        // Radar: sweep only the 90-degree quadrant facing the middle of the arena. After a contact,
        // probe left and right of it in steps that get finer with range (850 / R in the original).
        const facing = angleTo(me, { x: 0, z: 0 });
        let hit = null;
        if (m.lock) {
          // Probe centre, right, left with a narrow beam and nudge toward whatever answers; each
          // miss widens the probe, and after ten misses in a row go back to sweeping.
          const step = Math.min(0.08, 0.6 / m.lock.dist) * (1 + m.misses / 2);
          const off = [0, step, -step][(m.probe = (m.probe + 1) % 3)];
          hit = world.scan(m.lock.angle + off, 0.03);
          if (hit && !hit.friendly) { m.lock.angle += off / 2; m.lock.dist = hit.dist; m.misses = 0; }
          else { hit = null; if (++m.misses > 10) m.lock = null; }
        } else {
          // When sweeping with no lock, jump the sweep toward a radio-tipped enemy position.
          const tip = radioEnemyTip(world);
          if (tip) {
            const tipOff = normAngle(angleTo(me, tip) - facing) / (Math.PI / 4);
            m.sweep = Math.max(-1, Math.min(1, tipOff)) - 0.16;
          }
          m.sweep = ((m.sweep ?? -1) + 0.16 > 1 ? -1 : (m.sweep ?? -1) + 0.16);
          const a = facing + m.sweep * Math.PI / 4;
          hit = world.scan(a, 0.17);
          if (hit && !hit.friendly) { m.lock = { angle: a, dist: hit.dist }; m.probe = 0; m.misses = 0; m.fixes = []; }
          else hit = null;
        }

        // Lead: fit a straight line through the last 0.8 s of radar fixes to get the target's
        // position and velocity, then aim where it will be when the shell gets there.
        if (hit) {
          m.fixes = (m.fixes ?? []).filter((f) => world.time - f.t < 0.8);
          m.fixes.push({ ...pointAt(me, m.lock.angle, m.lock.dist), t: world.time });
        }
        // Broadcast enemy position while locked.
        if (m.lock && world.radio && world.time - (m.lastBroadcast ?? -99) > 1.5) {
          world.radio.send({ type: 'enemy', ...pointAt(me, m.lock.angle, m.lock.dist) });
          m.lastBroadcast = world.time;
        }
        let aim = null, fire = false;
        const fixes = m.fixes ?? [];
        if (m.lock && fixes.length && world.time - fixes[fixes.length - 1].t < 0.4) {
          const n = fixes.length, mt = fixes.reduce((s, f) => s + f.t, 0) / n;
          const mx = fixes.reduce((s, f) => s + f.x, 0) / n, mz = fixes.reduce((s, f) => s + f.z, 0) / n;
          const stt = fixes.reduce((s, f) => s + (f.t - mt) ** 2, 0);
          let vx = 0, vz = 0;
          if (n >= 5 && fixes[n - 1].t - fixes[0].t > 0.3) {
            vx = fixes.reduce((s, f) => s + (f.t - mt) * (f.x - mx), 0) / stt;
            vz = fixes.reduce((s, f) => s + (f.t - mt) * (f.z - mz), 0) / stt;
            const v = Math.hypot(vx, vz), vmax = 2.4; // no robot drives faster than this
            if (v > vmax) { vx *= vmax / v; vz *= vmax / v; }
          }
          let target = { x: mx, z: mz };
          for (let i = 0; i < 3; i++) {
            const t = world.time - mt + dist(me, target) / world.bulletSpeed;
            target = { x: mx + vx * t, z: mz + vz * t };
          }
          aim = angleTo(me, target);
          fire = true;
        }
        return { moveTo: corners[m.corner], aim, fire,
                 ...(m.lock ? {} : howitzerAtTip(me, world)) };
      },
    },
  };

  global.Strategies = STRATEGIES;
})(window);
