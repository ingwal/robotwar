# Advanced Robot War — Feature Roadmap

## Feature analysis

### Requested features

**Different robot types** (Scout, Tank, Artillery, Support)
*Effort: Medium — 1–2 weeks*
Define 4–5 archetypes with different speed, HP, weapon range, radar
range, hitbox size. The `think()` interface already supports this. The
engine needs per-type movement physics and hitboxes. Immediately
changes team composition strategy — arguably the highest-value change
for the least new infrastructure.

**Home base**
*Effort: Medium — 1 week*
Per-team base object on the map. Robots return to repair, respawn (for
non-elimination modes), and resupply ammo. Foundation for CTF and
base-assault modes. Depends on: **larger areas** — in a small arena
the bases are so close together that a bot can howitzer-camp the
entrance from across the map, making repair runs suicidal and the whole
mechanic pointless. A map/tile system is helpful but not required.

**Different end goals** (elimination, CTF, base assault, king of the hill)
*Effort: Medium — 1 week per mode*
Each mode is mostly a game-state machine change with some new objects
(flags, zones). CTF needs flags and carriers; base assault needs the
home base; king of the hill needs a neutral zone. Depends on: home
base (for CTF and base assault).

**Terrain types with movement costs** (field, street, bog, forest)
*Effort: Medium-Hard — 2–3 weeks*
Requires a tile-based map system (the current map is one flat
mesh). Each tile has a movement-cost multiplier. Scouts move fast
everywhere; tanks bog down in marshland. This is load-bearing
infrastructure for 3D terrain and fog of war. The rendering side is
straightforward once the tile system exists.

**Much bigger areas**
*Effort: Medium — 1–2 weeks*
Current arena tops out at 30 units. Going to 200–500 requires spatial
partitioning (a quadtree or uniform grid) for collision detection and
radar queries, and camera controls that work at scale. This is largely
an engine/performance refactor, but it unlocks everything
terrain-related.

*Pathfinding notes:* The navigation system has three layers: (1) `navGrid()` builds
an `n × n` boolean grid with 0.5-unit cells, cached per wall layout — at arena=14
`n=56` (3,136 cells); at arena=200 `n=800` (640,000 cells); at arena=500 `n=2000`
(4M cells). (2) `lineClear(a, b)` walks the straight line in 0.25-unit steps and
is called 1–8 times per robot per tick — this is the dominant per-tick cost and
grows with travel distance. (3) `findPath()` runs A\* on the full grid but its
result is cached per robot for 2 seconds, so it rarely fires during open travel.

The scaling problem is A\*: a single cross-map query at arena=200 searches 640,000
nodes, which is orders of magnitude slower than today. `lineClear` is the real
per-tick concern — solvable by checking against a spatial hash of wall segments
rather than the full grid. For large open arenas A\* is rarely needed anyway
(robots can usually see their goal directly), so the practical fix is: spatial
hash for `lineClear` + a fallback hierarchical or waypoint-graph path planner for
the cases where walls genuinely block the direct route.

*How far the current representation stretches:* The binding constraint is that
`findPath()` freshly allocates `Float32Array(n²)` + `Int32Array(n²)` on every
call (never reused). The navGrid `Uint8Array` is cached, but the A\* work arrays
are not.

| Arena | Grid cells | Per A\* call | 8 robots replanning at once |
|-------|------------|--------------|------------------------------|
| 14 (current default) | 3,136 | 25 KB | 200 KB |
| 30 (current max) | 14,400 | 115 KB | 920 KB |
| 50 | 40,000 | 320 KB | 2.5 MB |
| 80 | 102,400 | 820 KB | 6.5 MB |
| 100 | 160,000 | 1.3 MB | 10 MB |

**Practical ceiling without any code changes: arena ≈ 50–60** (3–4× the current
default). Arena 80 works but causes visible GC stutters on the opening tick and
whenever multiple walls fall at once.

**One change that buys ~3× more headroom:** pre-allocate the two A\* work arrays
once at `startBattle()` and reuse them with a generation counter (no `fill()` on
every call). This eliminates all A\* allocation cost and pushes the ceiling to
around arena ≈ 150, where A\* *exploration time* — not memory — becomes the
bottleneck. That is a genuinely different problem requiring a different algorithm.

*Waypoint graph approach for large arenas:* Replace the full-grid A\* with a small
pre-computed waypoint graph. At `startBattle()`, place 30–80 waypoints at corridor
junctions, wall gaps, and open areas. Connect each waypoint to its visible
neighbours (those that pass `lineClear`) and store the edge weights. Both the graph
and the edge weights are built once per round from the known wall layout.

Runtime navigation then has two levels:

1. *Long-range plan:* find the nearest waypoint to the robot and to the goal, then
   run A\* over the waypoint graph — ~50 nodes rather than hundreds of thousands of
   grid cells. This yields a short sequence of waypoints to pass through.
2. *Local steering:* head toward the next waypoint using the existing
   `lineClear`-first approach. On the final leg from the last waypoint to the
   actual goal, `lineClear` almost always succeeds because waypoints were placed in
   open positions.

Per-tick cost becomes: `lineClear` for local steering (same as today) + occasional
A\* over ~50 nodes (microseconds). The large `Float32Array`/`Int32Array`
allocations disappear entirely. This scales to arena=500 without any per-tick cost
increase.

*Finding the nearest waypoint:* no lookup table is needed. For ~50 waypoints, a
linear scan using squared distances (no square root) takes under a microsecond in
V8 and uses no memory. A quadtree would only pay off with hundreds of waypoints,
which only arise in very large arenas packed with obstacles.

*Terrain costs in the waypoint graph:* when terrain types exist, edge weights
become traversal cost rather than Euclidean distance — the integral of the terrain
cost multiplier along the edge. A swamp-crossing of length 10 at half speed costs
20, the same as a clear-ground edge of length 20. A\* then finds the least-cost
route rather than the shortest one. The "nearest waypoint" search changes
accordingly: weight by estimated traversal cost rather than straight-line distance,
since a close waypoint behind a bog may be slower to reach than a farther one on
clear ground.

Robot type speed modifiers plug into the same layer: a Scout and a Tank consulting
the same graph get different effective edge costs and may therefore choose different
routes — emergent strategic behaviour from a single data structure.

Paths are not globally optimal for very long trips, but "reach the right part of
the map efficiently" is all robot navigation needs — the local `lineClear` steering
handles the final fine-grained approach exactly as today.

The one non-trivial step is placing waypoints automatically from the wall layout. A
simple approach: seed candidates on a coarse grid, discard those inside or too
close to a wall, then thin them by removing any whose nearest neighbour is within a
minimum spacing. Straightforward to implement from the existing `navGrid` and
`lineClear` primitives.

**3D terrain with elevation**
*Effort: Hard — 3–5 weeks*
A height map (grayscale texture → vertex displacement). The terrain
mesh already exists conceptually; the hard parts are: (a) ballistic
trajectories over elevation changes (the howitzer is already
parabolic, so half the maths exists), (b) line-of-sight blocked by
hills, (c) movement costs on slopes, and (d) camera handling. Depends
on: the tile/terrain system and bigger areas.

**Advanced radio** (byte budget, not hard-coded messages)
*Effort: Low-Medium — 3–5 days*
Replace the current `world.radio.send(object)` API with a fixed byte
budget per frame (e.g. 32 bytes). Bots pack and unpack the bytes
themselves. This is mostly an API redesign; RoboScript needs a few new
instructions (`radioSend`, `radioRecv`). Self-contained — no terrain
or type dependencies.

**Camouflage**
*Effort: Low (given fog of war) — 3–5 days*
A stationary or slow-moving robot has a reduced radar
cross-section. Depends entirely on having fog of war: without it there
is nothing to hide from.

---

### Additional features

**Ammunition and fuel limits**
*Effort: Low-Medium — 3–5 days*
Robots carry finite ammo and fuel. Running out of ammo means they
can't fire; running out of fuel means they stop. Forces bots to decide
when to engage vs. conserve, and when to return to base. Works
immediately with the current engine.

**Line of sight / fog of war**
*Effort: Hard — 2–3 weeks*
Robots only know about what their radar can actually reach in a
straight line (or arc). On flat terrain this means occlusion by walls;
on 3D terrain it means ray-casting through the heightmap. This is the
single biggest gameplay-depth change: radar becomes a precious
resource, ambushes are possible, and camouflage finally makes
sense. Depends on: works on flat terrain, dramatically better on 3D
terrain.

**Different weapons per robot type**
*Effort: Medium — 1 week*
Expand beyond cannon + howitzer. Candidates: plasma cannon (high
damage, short range), EMP (disables sensors temporarily, no HP
damage), sniper rifle (extreme range, very narrow beam), smoke/chaff
(blocks radar), repair beam (restores ally HP). Natural companion to
robot types.

**Respawn and attrition mechanics**
*Effort: Low — 2–3 days*
In non-elimination modes, destroyed robots respawn at base after a
delay. Needed to make CTF and king-of-the-hill games last longer than
30 seconds.

**Multiple pre-designed maps**
*Effort: Low (once tile system exists) — days per map*
A map editor or a set of hand-authored maps (desert canyon, city grid,
marsh delta). Once the tile system and heightmap pipeline are in
place, making a new map is mostly asset work.

**Weather and time of day**
*Effort: Medium — 1 week*
Rain reduces speed and visibility; night reduces radar range; snow
slows movement. Mostly a set of multipliers applied per-frame on top
of the terrain system. Adds variety and a layer bots have to respond
to.

**Replay and spectator mode**
*Effort: Medium — 1–2 weeks*
Record the full game state at each frame (all robot positions, shots
fired, radio messages). Let viewers scrub through it after the
battle. Crucial for the competition use case: post-game analysis,
highlight reels, and debugging your bots.

**Server + user accounts + secret bots**
*Effort: Very Hard — 6–10 weeks for a solid first version*
User auth, bot source stored server-side (truly hidden), match
lobbies, match scheduling, result storage. The game loop can still run
client-side (server sends bytecode, client runs simulation, result
reported back). A simple Node/Python API + a small database (SQLite →
Postgres later) is enough for a first version.

**ELO ratings and tournament system**
*Effort: Medium (given server) — 1–2 weeks*
Automated round-robin or bracket scheduling, ELO after each
match. This is the payoff for building the server.

---

## Proposed order

Each step adds value on its own; later steps build on the
infrastructure of earlier ones.

| # | Feature | Why here |
|---|---------|----------|
| 1 | **Robot archetypes** (Scout / Infantry / Tank / Artillery / Support) | Highest value, almost no new infrastructure. Changes everything about team composition immediately. |
| 2 | **Ammunition and fuel limits** | Easy to add now; forces tactical decisions and makes home base meaningful later. |
| 3 | **Respawn at fixed spawn point** | No base building needed — robots reappear at their starting corner after a delay. Makes longer game modes viable immediately. |
| 4 | **King of the hill objective** | Needs no home base, just a neutral zone. Adds replayability with minimal new infrastructure. |
| 5 | **Advanced radio (byte budget)** | Self-contained API change. Competitive bots now have to design a signalling protocol. |
| 6 | **Additional weapons** (EMP, plasma, smoke, repair beam) | Natural companion to archetypes. Each type now has a signature weapon. |
| 7 | **Larger areas + spatial partitioning** | Technical groundwork. Needed before home base and terrain matter at scale. |
| 8 | **Home base + repair + resupply** | Only meaningful once the arena is large enough that the journey home costs real time and exposes the robot to risk. In a small arena bases are trivially howitzer-camped from anywhere on the map. |
| 9 | **CTF and base assault objectives** | Now the home base is a real fortified position worth attacking and defending. |
| 10 | **Tile-based terrain + movement costs** | Maps become tactically interesting. Scouts and tanks now play very differently. |
| 11 | **Multiple pre-designed maps** | Once the tile system exists, maps are cheap to produce. |
| 12 | **Line of sight / fog of war** | Game-changer: ambushes, recon, hiding. Scouts become essential. |
| 13 | **Camouflage** | Trivial given fog of war. New stealth archetype becomes possible. |
| 14 | **Weather and time of day** | Adds variety; builds on tile/terrain multiplier system already in place. |
| 15 | **3D terrain with elevation** | The "big" visual and mechanical upgrade. Everything before this is still fully playable; this makes it cinematic and strategically deep. |
| 16 | **Replay and spectator mode** | Needs a reasonably stable game before it's worth building. Essential for competition. |
| 17 | **Server + user accounts + secret bots** | Enables formal competition. Bots stored server-side; source truly hidden. |
| 18 | **ELO ratings + tournament system** | The payoff for the server investment. |

---

## Notes on the server

When you do build it, the split that makes most sense for this
architecture is:

- **Server stores**: user accounts, bot source, compiled bytecode, match history, ratings
- **Server does NOT run**: the game simulation (keep that client-side for now — easier, no latency issues)
- **Match flow**: server schedules a match → sends participant bytecodes to the hosting client → client runs simulation → sends result + replay back to server

This keeps the server very simple (a REST API + file store) while
still achieving true secret bots. A genuine server-side simulation
(for anti-cheat) is a later, much harder problem.

---

## Dedicated game runner — authoritative server + thin clients

A step beyond "server stores bytecodes, client runs the simulation" is
an **authoritative game runner**: the server owns and executes the
simulation; browsers connect as pure rendering clients.

### Why this fits this codebase

The game logic in `robot.js` and the RoboScript interpreter in
`roboscript.js` are already plain JavaScript with no DOM
dependencies. Moving them to Node.js is nearly mechanical. The WebGL
renderer in the browser is already a "view" onto game state — it just
currently constructs that state itself. Splitting them is a clean
architectural seam.

### Communication model

- **Tick rate**: game runner advances at ~20 Hz (enough for faithful
  bot execution and smooth play).
- **State streaming**: after each tick, the runner broadcasts a state
  snapshot to all connected viewers over WebSocket. Each snapshot
  contains, for every object: position, heading, HP, team, type.
  Estimate: ~1–2 KB per snapshot × 20 ticks/s ≈ **30 KB/s per
  viewer** — trivially handled by WebSocket.
- **Render rate**: browser clients render at 60 Hz by interpolating
  between the two most recently received snapshots (dead-reckoning if
  a snapshot is late). Standard technique; no simulation code runs in
  the browser.
- **Bot code**: bytecode executes on the server and is never sent to
  clients. The secret-bot problem is fully solved — clients see only
  positions and headings, not code.

### Server responsibilities

| What | How |
|------|-----|
| Run RoboScript interpreter | Same JS interpreter, now in Node.js |
| Advance game loop | `setInterval` or a high-res timer at 20 Hz |
| Broadcast state | WebSocket server (e.g. `ws` library) |
| Accept bot registrations | HTTP POST of bytecode (or source + compile server-side) |
| Start / stop games | HTTP API or a simple web lobby |
| Record replays | Persist each state snapshot to disk / DB |

### Client responsibilities

| What | How |
|------|-----|
| Render scene | Existing Three.js / WebGL renderer, unchanged |
| Interpolate between ticks | Lerp positions/headings between last two snapshots |
| Show lobby | Browser UI to browse, join, and configure games |
| No simulation | Game state arrives over WebSocket; no `think()` calls |

### Latency hiding

If a snapshot is delayed or lost, the client extrapolates: each robot
continues moving at its last known velocity and heading until the next
snapshot arrives. One missed tick (50 ms at 20 Hz) is imperceptible.

### Bonus: faster-than-realtime bot development

Because no browser is involved, the runner can be clocked at 10× or
50× speed for automated testing. Run a full 3-minute battle in a few
seconds, log the winner, repeat. This is essentially free once the
simulation is server-side.

### Effort estimate

*Hard — 4–6 weeks for a solid first version.*

The split itself (Node.js runner + WebSocket streaming) is ~2 weeks.
The tricky parts are: clean separation of game-state serialisation
from rendering, interpolation logic on the client, and making the
lobby usable. This is step 16 in the roadmap above, or it can be
pursued as a parallel track once the game loop is stable.
