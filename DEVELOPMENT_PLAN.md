# Ashes and Antlers — Tick-Based Galaxy Strategy Development Plan

## 1. Direction

Build **Ashes and Antlers** as a persistent, multiplayer, tick-based browser strategy game in the tradition of classic planet-and-fleet games. The player governs a small interstellar civilization, develops planets, researches technology, builds fleets, scouts coordinate space, colonizes new worlds, forms alliances, and fights scheduled wars.

This is deliberately **not** a real-time colony simulator, a region-atlas game, or a tactical RTS. The central gameplay unit is the planet and fleet; the central rhythm is the global tick.

### Core fantasy

The player is a planetary ruler issuing strategic orders between ticks:

1. Review planet production, construction, research, fleet status, intelligence, and messages.
2. Spend accumulated resources on infrastructure, technology, ships, defenses, and colonization.
3. Split fleets, load cargo, choose a target coordinate, and issue timed movement orders.
4. Coordinate attacks, defense, scans, and reinforcements with an alliance.
5. At the next tick, resources are produced, construction/research/ship orders progress, fleets advance, arrivals resolve, and reports are delivered.

A good session should take minutes, while good planning can create consequences over hours or days. Players must win through intelligence, timing, composition, logistics, diplomacy, and coordinated activity—not click speed.

### Theme translation

Keep the existing factions and setting, but place them in a mythic-industrial science-fiction galaxy.

| Faction | Galactic identity | Strategic profile |
| --- | --- | --- |
| Hearth Confederacy | Fortress-world builders preserving old civic institutions, hearth-reactors, and archive networks | Strong infrastructure, energy stability, defenses, and reliable economy |
| Iron Swarm | Mobile caste fleets that strip, repurpose, and rapidly establish nests on frontier worlds | Fast scouting, raiding, colonization pressure, and flexible fleet doctrine |

Use the familiar gameplay language—planets, sectors, galaxies, fleets, shipyards, scans, colonization, alliance warfare—while expressing it with the game’s existing art, terminology, units, and lore.

## 2. Classic Gameplay Contract

The following rules define the direction and should not be diluted during early development:

- The game runs on a **global, scheduled tick**. All players receive the same resolution cadence.
- Every player starts with a home planet at a coordinate such as `galaxy:sector:system:planet`.
- Planets produce a compact set of resources each tick based on local abundance, buildings, population, research, and upkeep.
- Buildings, research, and ships consume resources and finish after a known number of ticks.
- Fleets exist persistently, remain in space while the player is offline, travel over multiple ticks, and resolve arrivals/actions at tick boundaries.
- Players can own multiple planets, subject to technology and/or settlement limits.
- Scanning reveals limited, timestamped intelligence; exact enemy data is never freely visible.
- Alliances coordinate through shared intel, fleet operations, diplomacy, and score objectives.
- Worlds/rounds have a defined lifecycle and reset/archival plan so early growth does not become permanent dominance.
- The browser UI is command-and-report oriented. It does not need an expensive animated battle map.

### Recommended tick cadence

Start the closed alpha with **one 30-minute global tick**. This is long enough to favor planning and player coordination, but short enough for fleets, construction, and reports to feel alive.

Every tick resolves in a fixed order:

1. Lock commands submitted before the tick cutoff.
2. Produce resources and apply building/ship/defense upkeep.
3. Apply population growth/food effects and storage constraints.
4. Advance construction, research, training, and shipyard queues.
5. Advance fleet travel and resolve arrivals in deterministic order.
6. Resolve scans, colonization, trading/transfers, raids, battles, invasions, and retreats.
7. Apply score/control effects, generate reports, and publish player-visible projections.
8. Open the next command window.

The UI must prominently show current server tick, next-tick countdown, command cutoff, and the player’s orders queued for resolution.

### Player time-respect rules

- Do not require a player to be online at the tick boundary.
- Allow orders to be scheduled/edited until a clearly displayed cutoff.
- Let defenses, patrols, standing orders, production queues, and alliance intel reduce the disadvantage of being offline.
- Limit notifications to meaningful events and allow quiet hours.
- Avoid mechanics based on first-click races at tick time.

## 3. World and Planet Model

### Coordinates and map hierarchy

The world is a finite coordinate space:

```text
galaxy : sector : system : planet
  1    :   17   :   42   :   3
```

- **Galaxy:** broad strategic space and late-game travel tier.
- **Sector:** local political and alliance neighborhood.
- **System:** a cluster of colonizable planets where short-range fleet operations occur.
- **Planet:** the economic base, invasion target, and local fleet anchor.

The primary map is a searchable coordinate map and system view. Players should be able to navigate directly to a coordinate, bookmark targets, inspect known planets, and view scan confidence/age.

### Planet state

```ts
type Planet = {
  id: PlanetId;
  coordinate: Coordinate;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  name: string;
  population: bigint;
  abundance: {
    metal: number;      // 0..100
    mineral: number;    // 0..100
    food: number;       // 0..100
    energy: number;     // 0..100
  };
  resources: ResourceStore;
  buildings: BuildingLevels;
  researchEffects: TechnologyEffects;
  defenses: DefenseState;
  localFleets: FleetId[];
  planetLimitCost: number;
  lastResolvedTick: Tick;
  version: number;
};
```

### Resources

Use a familiar, compact production economy:

| Resource | Produced by | Used for |
| --- | --- | --- |
| Metal | Mines, abundance, workers | Buildings, hulls, armor, defenses |
| Mineral | Deep extraction, abundance | Advanced buildings, engines, weapons, research |
| Food | Farms/replicators, abundance | Population, soldiers, colonization, some upkeep |
| Energy | Reactors/solar arrays, abundance | Building upkeep, shipyard output, advanced industry |

Optional later resources: fuel, research data, influence, and rare artifacts. Do not add these until the four-resource economy is stable and understandable.

### Planet abundance and specialization

Each planet has fixed abundance ratings for metal, mineral, food, and energy. Building output is multiplied by relevant abundance, creating natural specialization.

This supports the classic colony decision:

- A high-metal planet becomes an industrial shipyard world.
- A fertile planet feeds population growth and colonization.
- An energy-rich planet supports expensive infrastructure and defenses.
- A poor frontier world may still be worth taking for position, fleet staging, or alliance control.

Use predictable formulas and show them in the planet UI. Players must be able to understand why one planet produces more than another.

### Planet ownership and limits

A player begins with one home planet. Colonization requires a dedicated colonizer/outpost vessel and a valid unowned target planet.

- Expansion is limited by a researched **planet command limit**, escalating maintenance, or both.
- Colonies begin vulnerable and need settlement/infrastructure investment.
- Players may abandon a planet only under explicit safety/cooldown rules.
- Invasion should be a later feature; early alpha can support raids and blockades before permanent ownership transfer.

## 4. Economy, Buildings, and Research

### Per-tick economy

At every tick, each owned planet:

1. Produces resources from active production buildings.
2. Applies abundance, technology, and faction modifiers.
3. Pays food and energy upkeep.
4. Applies storage cap behavior.
5. Adds produced resources to the local planetary store.
6. Progresses construction, research, shipyard, and defense queues.

Resources are **planet-local**. A remote colony cannot spend home-world stock automatically. Cargo fleets or alliance transfers must carry resources between planets. This makes freighters, staging, blockades, and route security meaningful.

### Initial buildings

| Building | Purpose | Key tradeoff |
| --- | --- | --- |
| Settlement / Nest | Raises population capacity and planetary administration | Food and energy upkeep |
| Metal Mine / Salvage Pit | Produces metal | Energy upkeep |
| Mineral Extractor / Deep Bore | Produces mineral | Energy and build cost |
| Farm / Biomass Vat | Produces food | Uses valuable building capacity |
| Reactor / Sun Harvester | Produces energy | Expensive but enables industry |
| Storehouse | Raises local resource capacity | Slower direct growth than production |
| Research Lab / Archive | Produces research progress | Diverts resources from fleet growth |
| Shipyard / Brood Forge | Builds ships | High energy and mineral demand |
| Barracks / Muster Hall | Trains troops | Food and upkeep |
| Defense Grid / Burrow Wall | Raises local defense | Static, does not project power |
| Scanner Array / Watch Spire | Improves scan range/quality and warnings | Cost and vulnerability |

Keep buildings level-based and data-driven. Each level has resource cost, build ticks, upkeep, prerequisite, and clearly displayed next-level output.

### Construction and production queues

Each planet has separate, constrained queues:

- One construction queue.
- One research queue.
- One shipyard/production queue.
- One troop/defense queue where useful.

Queue rules:

- Starting an order reserves or deducts its costs immediately; choose one rule and use it consistently.
- Orders show exact remaining ticks, prerequisites, and upkeep impact.
- Cancellation has explicit refund rules and cannot be used to duplicate resources.
- Queue completion resolves only during the global tick.
- Players can queue a small number of future orders, but prerequisites/costs are revalidated at execution.

### Research

Research should unlock capability rather than only percentage bonuses.

Initial branches:

- **Infrastructure:** better extraction, storage, energy efficiency, population capacity.
- **Navigation:** planetary, stellar, and galactic drive tiers; fleet speed; navigation reliability.
- **Military:** hulls, weapons, armor, shields, targeting, defense systems.
- **Colonization:** outposts, colony survival, planet command limit, transport efficiency.
- **Intelligence:** scans, counter-intelligence, sensor range, report quality.

Research is account-wide, while buildings and resources are local to each planet. Every researched technology has an explicit scope: player-wide, fleet-wide, planet-local, or unlocked construction.

## 5. Fleets, Ships, and Movement

### Fleet model

Each planet begins with a local shipyard/defense fleet and a limited number of mobile fleets. Fleet slots may increase through technology and planet limit progression.

```ts
type Fleet = {
  id: FleetId;
  ownerId: PlayerId;
  homePlanetId: PlanetId | null;
  location: Coordinate;
  state: 'orbiting' | 'moving' | 'arrived' | 'returning' | 'engaged';
  ships: Partial<Record<ShipType, bigint>>;
  cargo: ResourceStore;
  troops: bigint;
  mission: FleetMission | null;
  departureTick: Tick | null;
  arrivalTick: Tick | null;
  route: Coordinate[];
  version: number;
};
```

Player actions:

- Create/split/merge fleets when co-located.
- Transfer ships, troops, and cargo between co-located fleets.
- Load/unload goods with cargo-capable ships.
- Send fleets to a coordinate.
- Set mission: transport, scout, colonize, raid, reinforce, patrol, defend, invade, return.
- Recall eligible fleets before arrival under defined rules.

### Drive tiers and travel

Travel time is measured in ticks and determined by coordinate distance, fleet drive capability, ship composition, technology, and optional route modifiers.

Use three readable drive tiers:

| Drive tier | Reach |
| --- | --- |
| Planetary | Planets in the same system |
| Stellar | Systems/sectors within a galaxy |
| Galactic | Cross-galaxy movement |

The slowest relevant drive in a fleet determines its reach/speed. The send-order confirmation must display route, ETA in ticks, next arrival tick, mission, fuel/supply assumptions if used, and known target intelligence.

### Initial ship roles

| Ship class | Role |
| --- | --- |
| Scout / Seeker | Fast scan and intelligence mission |
| Freighter / Hauler | Carries local resources between planets |
| Outpost Ship / Seed Barge | Colonizes valid unowned worlds |
| Fighter / Skirmisher | Cheap early offensive and defensive combat |
| Corvette / Raider | Fast raiding and cargo interception |
| Cruiser / Line Vessel | Mid-game durable combat core |
| Carrier / Brood Ark | Projects fighters/advanced units later |
| Assault Transport | Carries troops for invasion; delay until PvP foundations are stable |

Start alpha with scout, freighter, outpost ship, fighter, and one durable combat class. Avoid a large unit roster until fleet composition and combat reports prove legible.

## 6. Intelligence, Combat, and Diplomacy

### Scans and intelligence

Information must be imperfect, actionable, and time-stamped.

Scan tiers:

- **Basic scan:** coordinate occupancy, owner/faction identity if detectable, broad planet class.
- **Resource scan:** approximate resources and economic capacity.
- **Military scan:** approximate defenses, fleet range, and threat assessment.
- **Deep scan:** improved detail but expensive, slower, and counterable later.

Reports show when intelligence was gathered and its confidence. A scan report is never a guarantee that an enemy has not moved since it was generated.

### Combat resolution

Combat resolves only at tick boundaries when hostile fleets meet in orbit, when a fleet attacks a defended planet, or when a mission has a valid target.

Resolution inputs:

- Ship counts, class statistics, hull/weapon/armor/shield technologies.
- Fleet mission, stance, morale/readiness if included.
- Planetary defenses and defending fleets.
- Scan/targeting quality and battle doctrine.
- A deterministic seeded random stream recorded in the combat report.

Resolution phases for MVP:

1. Detection and eligible engagement.
2. Defensive systems fire.
3. Fleet combat using target priorities.
4. Mission resolution: raid cargo, reinforce, colonize, or retreat.
5. Losses, debris/salvage, cargo changes, and reports.

Combat reports must list participating fleets, arrivals, major modifiers, target priorities, losses, surviving ships, cargo outcome, and battle seed/content version for support tooling. Do not hide the core reason for an outcome behind flavor text.

### Raids, invasion, and blockades

Introduce conflict in layers:

1. **Reconnaissance and fleet defense.**
2. **Raids:** steal a bounded amount of exposed local resources; defenders get counterplay through fleets, defenses, storage, scans, and timing.
3. **Blockade/siege:** temporary economic pressure and route denial; only after raids are stable.
4. **Invasion:** troop transport, occupation, and ownership change; last, with robust anti-harassment rules.

The home planet must have strong early protection. New players need predictable defenses and meaningful recovery paths, not permanent destruction from a single missed tick.

### Alliances and diplomacy

Alliances are a primary game system, not merely chat groups.

MVP alliance features:

- Name, tag, roster, leader/officer/member roles, invite/apply flow.
- Alliance message board and operation notes.
- Shared scan reports and coordinate bookmarks when explicitly enabled.
- Diplomatic stance: allied, neutral, hostile, nap/ceasefire.
- Alliance score/contribution ledger.
- Member cap sized for the intended world population; do not allow unlimited blobs.

Later features:

- Shared defense alerts, reinforcement permissions, alliance projects, formal treaties, resource contracts, and sector objectives.

Moderation and security are required before public testing: block/mute/report, message rate limits, alliance-role audit records, staff tools, and clear account/abuse policies.

## 7. Round Structure and Scoring

### World lifecycle

Run the game in discrete worlds/rounds with a published start, competitive middle, conclusion, archive, and reset process.

Suggested closed-alpha lifecycle:

- **Opening (1–2 weeks):** protected growth, colonization race, limited aggression.
- **Expansion (2–4 weeks):** increased planet limits, alliance formation, stronger scouting and raids.
- **War (2–4 weeks):** full fleet conflict, sector objectives, mature diplomacy.
- **Finale (1–2 weeks):** high-value world objectives and published end condition.
- **Archive/reset:** preserve rankings, reports, and achievements; start the next world with balance changes clearly documented.

Exact timing must be established through playtests, not assumed.

### Score model

Rank both players and alliances with transparent, multi-source scoring:

- Planetary development and population.
- Research and technology.
- Fleet value and defensive value.
- Colonized planets and controlled objective locations.
- Alliance contribution and objective score.
- Optional combat/raid contribution with anti-farming limits.

Avoid a pure fleet-value ranking: it rewards hoarding and obscures economic, intelligence, and defensive play.

## 8. UI and Presentation

### Primary navigation

```text
Overview | Planets | Buildings | Research | Shipyard | Fleets |
Galaxy | Scans | Messages | Alliance | Reports | Rankings
```

### Required screens

- **Overview:** next tick, resource summary, queued orders, fleet ETA, urgent alerts, reports, and shortcuts.
- **Planets:** sortable list with coordinate, abundance, population, resources, activity, fleet status, and warning indicators.
- **Planet detail:** local resources/rates, buildings, storage, queues, defenses, stationed fleets, and transfers.
- **Research:** current queue, tree, prerequisites, cost, ticks remaining, and account-wide effects.
- **Shipyard:** ship definitions, build queue, local capacity, resource cost, and fleet assignment.
- **Fleets:** every fleet, location, mission, cargo, ships, next action, ETA, and transfer/split/send controls.
- **Galaxy:** coordinate navigation, known planets, bookmarks, scan intelligence/age, and alliance markers.
- **Reports:** immutable tick, scan, combat, production, and diplomacy reports with filters.
- **Alliance:** roster, permissions, messages, shared intel, operations, diplomacy, and contribution.
- **Rankings:** player, alliance, faction, and objective standings with clear score breakdowns.

### Presentation rules

- Use a dark, restrained command-console style with faction-specific accents.
- Favor tables, icons, coordinate lists, timers, and readable reports over animation.
- Make every order reviewable before submission and visible in a “pending next tick” list afterward.
- Never convey crucial status through color alone.
- Provide keyboard access, responsive layout, scalable UI, reduced motion, high contrast, and timezone-safe timestamps.

## 9. Technical Architecture

### Architecture decision

Use a **server-authoritative tick engine**. The browser is a typed command client and read-model viewer. It never calculates authoritative production, combat, queue completion, fleet arrival, visibility, or score.

Recommended stack:

| Concern | Choice |
| --- | --- |
| Monorepo | pnpm workspaces |
| Client | TypeScript, React, Vite |
| API | TypeScript, Fastify or Hono |
| Tick worker | TypeScript worker service using a durable job scheduler |
| Database | PostgreSQL |
| Cache/queue | Redis plus a durable queue/outbox approach |
| Shared contracts | Zod schemas and branded TypeScript IDs |
| Data access | Kysely or Drizzle with explicit transactions |
| Realtime | WebSocket or SSE for post-tick/report notifications |
| Tests | Vitest, PostgreSQL integration tests, Playwright, load tests |
| Observability | Structured logs, metrics, traces, error reporting |

### Tick execution

The tick worker must produce one immutable resolution record per world/tick.

```ts
type TickResolution = {
  worldId: WorldId;
  tick: number;
  contentVersion: string;
  commandCutoffAt: Date;
  resolvedAt: Date;
  seed: string;
  phaseHashes: Record<string, string>;
  status: 'running' | 'completed' | 'failed';
};
```

Requirements:

- One active tick resolver per world, enforced through database/advisory lock or equivalent lease.
- Commands submitted before cutoff are ordered deterministically by accepted timestamp, stable command ID, and defined phase.
- The resolver runs inside deliberate transaction boundaries; large worlds may batch by phase but preserve deterministic ordering and atomic report/receipt behavior.
- A failed tick is retryable without duplicate resources, movement, combat, or reports.
- Post-tick projections/realtime events are derived from committed state through an outbox.
- Admin tools can inspect input commands, phase hashes, outcomes, and errors for any world tick.

### Core command model

```ts
type GameCommand =
  | { kind: 'StartBuilding'; planetId: PlanetId; building: BuildingKind }
  | { kind: 'StartResearch'; technologyId: TechnologyId }
  | { kind: 'QueueShip'; planetId: PlanetId; ship: ShipKind; quantity: bigint }
  | { kind: 'TransferFleet'; fromFleetId: FleetId; toFleetId: FleetId; ships: ShipStacks }
  | { kind: 'LoadCargo'; fleetId: FleetId; resources: ResourceStore }
  | { kind: 'SendFleet'; fleetId: FleetId; destination: Coordinate; mission: FleetMission }
  | { kind: 'SetFleetStance'; fleetId: FleetId; stance: FleetStance }
  | { kind: 'RunScan'; sourcePlanetId: PlanetId; target: Coordinate; scan: ScanKind }
  | { kind: 'CreateAlliance'; name: string; tag: string }
  | { kind: 'SetDiplomacy'; targetId: PlayerOrAllianceId; stance: DiplomacyStance };

type CommandEnvelope = {
  idempotencyKey: string;
  expectedVersion: number;
  submittedAt: string;
  command: GameCommand;
};
```

Command submission validates current ownership, resources, prerequisites, available fleet state, target coordinates, permissions, cutoff, rate limits, and expected version. Accepted commands become visible as pending orders and receive an immutable receipt.

### Data-driven content

Version and validate all balance content:

- Factions, starting packages, and modifiers.
- Planet/building levels and production/upkeep formulas.
- Research tree and unlocks.
- Ship statistics, cargo, drive tier, costs, build ticks, and targeting priorities.
- Combat phases and constants.
- Scan levels, report visibility, protection rules, and score formulas.

Store the content version on every tick resolution, report, construction order, research order, and combat outcome. Changes between rounds are preferable to silently changing a live competitive world.

### Security and anti-abuse

- Authenticate every request and authorize every planet, fleet, alliance, and report access server-side.
- Treat client payloads and timestamps as untrusted.
- Use idempotency keys, optimistic version checks, database constraints, and transactions for all state changes.
- Rate-limit commands, scans, messages, login attempts, and read endpoints.
- Enforce one account/starting empire per player/world under a clear account policy; instrument suspicious shared-IP/device/economy patterns rather than relying only on automated bans.
- Do not expose hidden fleet, resource, queue, or scan data in API payloads, realtime events, page HTML, or client bundles.
- Audit alliance role changes, diplomacy changes, combat-affecting commands, account recovery, and staff actions.
- Build backups, restore drills, moderation tools, and incident runbooks before public alpha.

## 10. Development Roadmap

### Milestone 0 — Tick Engine Foundation

**Goal:** Prove a deterministic world tick and server-authoritative player/planet model.

Deliverables:

- Workspace with web client, API, tick worker, shared domain/contracts/content/db packages.
- PostgreSQL/Redis local stack, migrations, seeded world generator, and deterministic coordinate map.
- Test identity/auth baseline and one seeded player with one home planet.
- World tick schedule, world-level lock, tick resolution record, and admin/dev tick trigger.
- Empty overview and planets screens showing authoritative world tick and planet projection.
- CI: lint, typecheck, unit, database integration, and Playwright smoke tests.

Acceptance tests:

- The same seed/content/commands produces the same resulting planet-state hash for a test tick.
- A duplicate tick job cannot run two resolvers for the same world/tick.
- Unauthenticated or malformed commands are rejected safely.

### Milestone 1 — Economy and Buildings

**Goal:** Make one planet produce resources and develop through global ticks.

Deliverables:

- Metal, mineral, food, energy, local storage, abundance, population, and upkeep.
- Settlement, mines, farm, reactor, storehouse, lab, and shipyard building definitions.
- One construction queue with command receipts, pending state, tick completion, cancellation policy, and reports.
- Planet list/detail and transparent resource-rate explanation.
- Storage full, food deficit, and energy deficit warnings.

Acceptance scenario:

- Given a known planet and tick sequence, resource totals exactly match tested abundance/building/upkeep formulas.
- Two accepted build commands cannot overspend the same local resources.

### Milestone 2 — Research and Shipyards

**Goal:** Let players turn an economy into a technological and military base.

Deliverables:

- Account-wide research queue with navigation, extraction, shipyard, and scan technologies.
- Shipyard queue and initial scout/freighter/outpost/fighter ship set.
- Fleet inventory and local fleet transfer/split/merge rules.
- Reports for completed research and ships.

Acceptance scenario:

- A completed navigation research changes an explicitly tested fleet-reach/travel calculation.
- Ships enter the correct local fleet exactly once at resolution.

### Milestone 3 — Fleets, Coordinates, and Scans

**Goal:** Make the galaxy feel persistent through timed fleet movement and imperfect information.

Deliverables:

- Coordinate navigation and map/search/bookmarks.
- Fleet send, recall, arrival, cargo load/unload, and route/ETA calculation in ticks.
- Basic/resource/military scan missions and time-stamped intelligence reports.
- Visibility-filtered planet/fleet projections and alert rules.

Acceptance scenario:

- A fleet sent before cutoff arrives on the calculated tick and cannot be duplicated by retry.
- A player can scan a target but cannot retrieve private state beyond the scan definition.

### Milestone 4 — Colonization, Defense, and Raids

**Goal:** Establish expansion and controlled PvP stakes.

Deliverables:

- Colonization/outpost mission, planet command limits, new-colony initialization, and planet management.
- Static defenses, stationed fleets, defensive scan/warning rules, and new-player protection.
- Raid mission, bounded loot, combat phase, losses, salvage, and comprehensive reports.
- Rankings for economic, research, fleet, and planet progress.

Acceptance scenario:

- Colonization creates exactly one valid planet owner/settlement after the arrival tick.
- A raid respects defenses, cargo capacity, protection rules, and idempotent combat resolution.

### Milestone 5 — Alliances and Competitive Worlds

**Goal:** Make coordination and round goals the heart of the multiplayer game.

Deliverables:

- Alliances, permissions, alliance message board, shared intel toggle, diplomacy, and audit trail.
- Alliance/player scoreboards and sector/world objectives.
- World lifecycle configuration: opening protection, conflict unlocks, finale, archive, and reset.
- Moderation/admin tools, operational dashboards, backup/restore testing, and closed-alpha load tests.

Acceptance scenario:

- An alliance operation can coordinate member scans/fleet ETAs without revealing data to non-members.
- Scores recompute from persisted state and match visible rankings.

### Milestone 6 — Alpha Operations and Depth

**Goal:** Run a secure, observable, replayable closed alpha before adding deep conquest systems.

Deliverables:

- Onboarding from home planet to first building, research, ship, scan, and report.
- Notification preferences/quiet hours, accessibility pass, mobile-responsive support, support tooling, and account deletion/export workflow.
- Tick monitoring, queue lag alerts, load testing, anti-abuse review, balance telemetry, and public alpha rules.
- Only after measured stability: blockade, invasion, troop combat, advanced ship classes, alliance objectives, and trade/contracts.

## 11. Engineering Standards

- The tick engine, not the client, owns all game outcomes.
- Every calculation that changes state is pure/testable where possible and gets a stable deterministic order.
- Every accepted action has an idempotency key, command receipt, actor, timestamp, expected version, and target scope.
- Every tick has a content version, seed, phase order, result summary, and replay/debug trail.
- Every queue, fleet, combat result, report, and alliance permission change has an auditable history.
- Do not add real-time tactical combat, per-citizen simulation, freeform market trading, or permanent conquest until the preceding milestone’s telemetry and abuse controls are accepted.
- Add unit tests for formulae and integration tests for transactions/concurrency; use fixed-seed tick scenarios for multi-system behavior.
- Keep balance values out of service code and document every live-world content migration.
- Maintain narrow conventional commits: `feat(tick):`, `feat(fleet):`, `fix(combat):`, `test(world):`, `docs:`.

## 12. First Agent Prompt

> Implement Milestone 0 only. Inspect the repository and summarize which parts of the existing browser prototype can be retained for a command-dashboard UI, but do not preserve its client-owned simulation model. Create or extend a strict TypeScript workspace with `web`, `api`, and `worker` applications plus shared `contracts`, `domain`, `content`, and `db` packages. Add PostgreSQL and Redis local development services, migrations, deterministic generation of a finite `galaxy:sector:system:planet` world from a seed, and a seeded test player who owns one home planet. Implement a server-authoritative global tick record with a per-world lock and an idempotent empty resolution phase; show current tick, next tick time, and the player’s home planet coordinate in the web overview. Add tests proving deterministic world hash, single-resolver protection, migration/seed correctness, unauthenticated API rejection, and browser overview boot. Do not add resources, buildings, research, fleets, combat, alliances, or realtime updates yet. Run all checks and report changed files, migrations, commands run, and remaining follow-ups.
