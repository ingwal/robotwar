# Robot Types

## Key differentiating properties

| Property | What it controls |
|---|---|
| **Speed** | How fast it moves and turns — affects flanking, escape, base-rushing |
| **HP** | Shots to kill — affects how aggressively it can trade fire |
| **Hitbox radius** | How easy it is to hit — a small fast bot is doubly hard to kill |
| **Radar range** | How far it can see — affects scouting, targeting, map awareness |
| **Cannon cooldown** | Rate of fire for direct shots |
| **Cannon damage** | How much HP each direct shot removes |
| **Howitzer** | Whether the type carries one at all |
| **Howitzer cooldown** | How often it can arc-fire |
| **Howitzer blast radius** | Area-of-effect size |

---

## Proposed archetypes

| | Scout | Infantry | Tank | Artillery | Support |
|---|---|---|---|---|---|
| **Speed** | 1.8× | 1.0× | 0.55× | 0.4× | 0.9× |
| **HP** | 2 | 4 | 10 | 3 | 4 |
| **Hitbox** | 0.4 | 0.7 | 1.1 | 0.7 | 0.7 |
| **Radar range** | 1.5× | 1.0× | 0.65× | 1.4× | 1.0× |
| **Cannon** | Yes, fast CD | Yes | Yes, +2 dmg | Light | Light |
| **Cannon CD** | 0.4s | 0.6s | 1.2s | 1.0s | 1.0s |
| **Howitzer** | No | Yes | No | Yes, enhanced | No |
| **Howitzer CD** | — | 5s | — | 3s | — |
| **Howitzer blast** | — | 3.0 | — | 4.5 | — |
| **Special** | — | — | — | — | Repair beam |

---

## Role notes

**Scout** — Sees farther, moves faster, dies quickly. Its job is map awareness and relaying enemy positions to the team via radio, not fighting. Small hitbox (0.4 vs 0.7) means it takes about 30% fewer direct hits at equal exposure.

**Infantry** — The current bot, slightly rebalanced as a general-purpose middle ground. Teams of only Infantry are viable but not optimal.

**Tank** — Trades speed and radar for raw durability. 10 HP means it can walk into a crossfire that would kill two Infantries. No howitzer means it must close range. Slow turning radius punishes it against flanking Scouts.

**Artillery** — Fragile and almost stationary, but its howitzer fires every 3s (vs 5s) with a 4.5-unit blast radius (vs 3.0). One Artillery behind cover can suppress a zone that three Infantries would struggle to hold. Useless at close range.

**Support** — Carries a repair beam that restores 1 HP/s to an adjacent ally (range ~2 units). Not a primary weapon but it changes the tank's effective durability dramatically. Interesting team-composition question: is one Support worth an Infantry slot?

---

## Team composition implications

With even just these five types, team building becomes a real decision: a full Artillery team will obliterate a full Scout team that can't close range, but a mixed Scout+Tank force can rush Artillery before it fires twice. That's the kind of rock-paper-scissors dynamic that makes the type system worthwhile.

---

## Open questions

1. **Does robot type affect visual appearance?** Different mesh/color per type would help orientation but adds art work.
2. **Does the player choose their team composition, or is it per-bot?** Meaning: does each strategy declare its own type, or does the team-builder assign types to slots?
3. **Support's repair beam** — passive aura or an active command the bot has to issue? Active is more interesting strategically but requires new RoboScript API surface.
