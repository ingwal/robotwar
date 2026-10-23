// RoboScript example strategies compiled and registered at load time.
// Source files (*.rs) alongside this file serve as the human-readable reference.
// Each call to RoboScript.register() adds the strategy to the game's dropdown.

(function () {
  'use strict';

  function reg(key, name, desc, src) {
    const { bytecode, error } = RoboScriptCompiler.compile(src);
    if (error) { console.error(`RoboScript compile error (${name}):`, error); return; }
    RoboScript.register(key, name, desc, bytecode);
  }

  // ---- Hunter RS ----
  // Sweep radar → lock on → orbit prey while firing → roam when idle.

  reg('hunter_rs', 'Hunter RS',
    'Sweeps radar, orbits prey at close range while firing, roams when idle.',
  `
-- mem[0]  radar sweep angle
-- mem[1]  movement goal x
-- mem[2]  movement goal z
-- mem[3]  world.time of last enemy sighting

mem[0] = mem[0] + 0.12

d = scan(mem[0], 0.09)

if d > 0 then
  out.aim  = mem[0]
  out.fire = 1
  mem[3]   = world.time

  px = me.x + sin(mem[0]) * d
  pz = me.z + cos(mem[0]) * d

  orbit  = atan2(me.x - px, me.z - pz) + 0.5
  tx     = px + sin(orbit) * 4.5
  tz     = pz + cos(orbit) * 4.5
  edge   = world.arena - 2.0
  mem[1] = min(edge, max(-edge, tx))
  mem[2] = min(edge, max(-edge, tz))
else
  out.fire = 0

  dx    = me.x - mem[1]
  dz    = me.z - mem[2]
  near  = dx * dx + dz * dz < 1.5
  stale = world.time - mem[3] > 3.0

  if near or stale or me.wallHit or me.blocked then
    ang    = rand() * 6.2832
    r      = world.arena * 0.7
    edge   = world.arena - 2.0
    mem[1] = min(edge, max(-edge, me.x + sin(ang) * r))
    mem[2] = min(edge, max(-edge, me.z + cos(ang) * r))
    mem[3] = world.time
  end
end

out.moveX = mem[1]
out.moveZ  = mem[2]
out.speed  = 1.1
`);

  // ---- Bombardier RS ----
  // Orbits at medium range, fires bullets on sight, and lobs a howitzer
  // shell at the last known position every time the weapon reloads.

  reg('bombardier_rs', 'Bombardier RS',
    'Orbits at medium range, fires bullets when in line of sight, and howitzers the last known enemy position every time it reloads.',
  `
-- mem[0]  radar sweep angle
-- mem[1]  last enemy x
-- mem[2]  last enemy z
-- mem[3]  time of last sighting
-- mem[4]  movement goal x
-- mem[5]  movement goal z
-- mem[6]  ever-seen flag (guards howitzer against firing at origin)
-- mem[7]  orbit side (+1/-1)

if mem[7] == 0 then
  mem[7] = 1
end

mem[0] = mem[0] + 0.09
d = scan(mem[0], 0.09)

if d > 0 then
  ex = me.x + sin(mem[0]) * d
  ez = me.z + cos(mem[0]) * d
  mem[1] = ex
  mem[2] = ez
  mem[3] = world.time
  mem[6] = 1

  out.aim  = mem[0]
  out.fire = 1

  -- Orbit at medium range — good for howitzer arcs
  rx   = me.x - ex
  rz   = me.z - ez
  rd   = sqrt(rx * rx + rz * rz)
  R    = max(10.0, min(22.0, rd))
  orb  = atan2(rx, rz) + mem[7] * 0.5
  edge = world.arena - 2.5
  mem[4] = min(edge, max(-edge, ex + sin(orb) * R))
  mem[5] = min(edge, max(-edge, ez + cos(orb) * R))
else
  out.fire = 0

  dx    = me.x - mem[4]
  dz    = me.z - mem[5]
  near  = dx * dx + dz * dz < 2.0
  stale = world.time - mem[3] > 3.0

  if near or stale or me.wallHit or me.blocked then
    ang    = rand() * 6.2832
    r      = world.arena * 0.65
    edge   = world.arena - 2.5
    mem[4] = min(edge, max(-edge, me.x + sin(ang) * r))
    mem[5] = min(edge, max(-edge, me.z + cos(ang) * r))
    mem[3] = world.time
  end
end

-- Howitzer: fire at last known enemy when reloaded and in range.
-- mem[6] prevents firing at (0,0) before the first sighting.
if world.howitzer.ready and mem[6] == 1 and world.time - mem[3] < 5 then
  hdx = mem[1] - me.x
  hdz = mem[2] - me.z
  hd  = sqrt(hdx * hdx + hdz * hdz)
  if hd >= 3 and hd <= world.howitzer.maxRange then
    out.howitzerX = mem[1]
    out.howitzerZ = mem[2]
  end
end

out.moveX = mem[4]
out.moveZ  = mem[5]
out.speed  = 1.1
`);

  // ---- Team Hunter RS ----
  // Like Hunter RS but broadcasts every enemy fix via radio and uses
  // incoming tips to steer toward enemies a teammate spotted.

  reg('team_hunter_rs', 'Team Hunter RS',
    'Like Hunter RS but shares enemy sightings with teammates via radio and uses their tips to find targets faster.',
  `
-- mem[0]  radar sweep angle
-- mem[1]  last known enemy x (own fix or radio tip)
-- mem[2]  last known enemy z
-- mem[3]  time of last own sighting
-- mem[4]  movement goal x
-- mem[5]  movement goal z

mem[0] = mem[0] + 0.12
d = scan(mem[0], 0.09)

if d > 0 then
  ex = me.x + sin(mem[0]) * d
  ez = me.z + cos(mem[0]) * d
  mem[1] = ex
  mem[2] = ez
  mem[3] = world.time

  out.aim  = mem[0]
  out.fire = 1

  -- Share sighting with teammates
  out.radioX = ex
  out.radioZ = ez

  -- Orbit prey at close range
  orbit = atan2(me.x - ex, me.z - ez) + 0.5
  edge  = world.arena - 2.0
  mem[4] = min(edge, max(-edge, ex + sin(orbit) * 4.5))
  mem[5] = min(edge, max(-edge, ez + cos(orbit) * 4.5))
else
  out.fire = 0

  -- Update target from radio tip when our own fix is stale
  if radio.tipX != 0 and world.time - mem[3] > 1.5 then
    mem[1] = radio.tipX
    mem[2] = radio.tipZ
  end

  dx    = me.x - mem[4]
  dz    = me.z - mem[5]
  near  = dx * dx + dz * dz < 1.5
  stale = world.time - mem[3] > 3.0

  if near or stale or me.wallHit or me.blocked then
    -- Chase last known position if still fresh, else roam
    if world.time - mem[3] < 5 then
      mem[4] = mem[1]
      mem[5] = mem[2]
    else
      ang    = rand() * 6.2832
      r      = world.arena * 0.7
      edge   = world.arena - 2.0
      mem[4] = min(edge, max(-edge, me.x + sin(ang) * r))
      mem[5] = min(edge, max(-edge, me.z + cos(ang) * r))
    end
    mem[3] = world.time
  end
end

out.moveX = mem[4]
out.moveZ  = mem[5]
out.speed  = 1.1
`);

})();
