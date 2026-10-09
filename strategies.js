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
//            blocked    true when stuck against something for >0.5 s (long-term)
//            wallHit    true when physically touching a wall or arena edge this frame
//            robotHit   true when physically touching another robot this frame
//            hitAngle   direction toward the obstacle when wallHit or robotHit is set;
//                       call world.scan(me.hitAngle, 0.3) to see if it's a robot,
//                       or world.wallDist(me.hitAngle) to see if it's a wall
//            mem        an empty object the strategy can use to remember things between frames
//   world    { arena, walls, time, bulletSpeed, radarRange, scan(angle, width), wallDist(angle) }
//              arena      half-size of the arena; the floor spans -arena..arena on x and z
//              walls      interior walls as boxes { x0, z0, x1, z1 }
//              scan       angle is a world angle; width is the beam's full width in radians
//                         (0.03..0.35, default 0.17, about 10 degrees)
//                         returns { dist, friendly } or null; friendly = same team as you
//              wallDist   returns distance to the nearest wall or arena edge in direction angle;
//                         unlike scan, this can be called any number of times per frame
//   moveTo   {x, z} to drive to, or null to stand still
//   speed    0..1.3, fraction of normal top speed (default 1)
//   aim      world angle for the turret, or null to leave it where it is
//   fire     true = shoot as soon as the cannon is reloaded and the turret is on target
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
        return { moveTo: m.goal, speed: 1.2, aim: seen ? seen.angle : null, fire: !!seen };
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
        const up = Math.PI;
        const hit = world.scan(up, 0.2);
        const seen = hit && !hit.friendly;
        return { moveTo: { x: m.dir * edge, z: edge }, aim: up, fire: !!seen };
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
        return { moveTo: corners[m.corner], aim: seen ? seen.angle : null, fire: !!seen };
      },
    },

    hunter: {
      name: 'Hunter',
      description: 'Searches with its radar, then circles whatever it finds at close range, shooting until it is gone.',
      think(me, world) {
        const m = me.mem;
        const seen = radarTrack(me, world);
        if (seen && !me.blocked) {
          const prey = pointAt(me, seen.angle, seen.dist);
          const around = angleTo(prey, me) + 0.5;
          const candidate = pointAt(prey, around, 4.5);
          const margin = 1.5;
          const inArena = Math.abs(candidate.x) < world.arena - margin && Math.abs(candidate.z) < world.arena - margin;
          m.goal = (inArena && !insideWall(candidate, world.walls, 1.2)) ? candidate : randomOpenPoint(world);
          m.lastSeen = world.time;
        } else if (!m.goal || dist(me, m.goal) < 1 || (me.blocked && !m.wasBlocked) || world.time - (m.lastSeen ?? 0) > 3) {
          m.goal = randomOpenPoint(world);
          m.lastSeen = world.time;
        }
        m.wasBlocked = me.blocked;
        return { moveTo: m.goal, speed: 1.1, aim: seen ? seen.angle : null, fire: !!seen };
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
        if ((seen && seen.dist < 9) || hurt || (me.blocked && !m.wasBlocked) || me.wallHit || me.robotHit || !m.goal || dist(me, m.goal) < 1) {
          const danger = seen ? pointAt(me, seen.angle, seen.dist)
                       : (me.robotHit || me.wallHit) ? pointAt(me, me.hitAngle, 3) : me;
          let best = -1;
          for (let i = 0; i < 12; i++) {
            const p = randomOpenPoint(world);
            if (dist(p, danger) > best) { best = dist(p, danger); m.goal = p; }
          }
        }
        m.wasBlocked = me.blocked;
        const shaky = Math.sin(world.time * 7) * 0.12;
        return { moveTo: m.goal, aim: seen ? seen.angle + shaky : null, fire: !!seen };
      },
    },
  };

  global.Strategies = STRATEGIES;
})(window);
