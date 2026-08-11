# Civilizations at War — Development Plan

## 1. Project Brief

Build a single-player, browser-native, 2D grand colony/RTS simulation in which **two autonomous civilizations** inhabit the same procedurally generated world, compete for finite resources, adapt to pressure, wage logistics-driven war, and ultimately achieve dominance.

Working title: **Ashes and Antlers**. Treat this as a placeholder, not a design constraint.

### Player fantasy

The player is a distant planner-advisor, not a unit micromanager. They establish a civilization's laws, priorities, construction blueprints, military doctrine, diplomacy, and strategic directives. Individuals then make local decisions using needs, knowledge, social ties, available work, and the actual state of the world. The opposing civilization runs through the same simulation rules and has comparable information limits.

The game should create stories such as:

- A prosperous river settlement overextends mining operations, starts a border war over iron, then collapses because laborers and haulers are redirected away from food before winter.
- A numerically weak society survives by building watchtowers, ambushing supply lines, and recruiting dissatisfied prisoners.
- A disease in crowded worker housing alters labor availability, food prices, morale, military readiness, migration, and the enemy's choice to invade.
- Deforestation makes charcoal and construction plentiful in the short term, but causes erosion, reduced forage, and a later food crisis.

### Design pillars

1. **Simulation first.** Every visible outcome must have a causal chain in simulation state; avoid fake event outcomes.
2. **Local intelligence, strategic emergence.** Citizens make bounded local decisions; civilizations make lower-frequency strategic choices.
3. **Logistics decides wars.** Armies require food, tools, ammunition, medicine, transport capacity, rest, and command.
4. **Readable complexity.** The player must be able to answer “what changed, why, and what can I do?” through layered UI, event logs, overlays, and inspectors.
5. **Deterministic core.** Given a seed, config, version, and ordered player commands, the simulation reproduces the same result.
6. **Cheap visuals, rich state.** Simple tiles, icons, colored agents, and clear data visualization are preferred to expensive art.
7. **Depth by composition.** Add interacting rules and constraints rather than a large pile of isolated resource bars.

### Explicit non-goals for v1

- Multiplayer, mod marketplace, mobile support, procedural 3D, real-time networking, voice acting, and a campaign story.
- A realistic individual psychology simulation for thousands of citizens.
- Full terrain deformation, fluid simulation, or physically accurate combat.
- Perfect historical realism. This is a systems-first fictional world.

## 2. Recommended Game Shape

### Core loop

1. Observe the world, reports, and alerts.
2. Select a strategic goal or alter policies: expand, stabilize, defend, raid, research, trade, or seize a region.
3. Place blueprints, zones, stockpile rules, road plans, and formation/operation orders.
4. Let the simulation run at pause, 1×, 2×, 4×, and 8× speed.
5. Investigate consequences using causal reports and adjust the plan.
6. Achieve dominance through territorial, economic, cultural, or military victory.

### Time and scale

- World: 160×160 tiles for MVP, expandable to 256×256 after profiling.
- Tile: logical terrain cell; rendering uses 16 or 24 px tiles, but simulation never depends on pixels.
- Fixed simulation tick: 5 ticks/second. Rendering interpolates independently at display refresh rate.
- Strategic evaluation: every 20 ticks (4 seconds).
- Calendar: 120-day years, 4 seasons of 30 days. A day is 300 simulation ticks (60 seconds at 1×).
- Population target: 60–150 citizens per faction at launch; design data structures for 500 total agents.

### Factions

Start with two asymmetric factions sharing the same core engine:

| Faction            | Identity                                  | Strength                                      | Pressure                                                                  |
| ------------------ | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Hearth Confederacy | Settled builders with strong institutions | Construction, agriculture, defensive cohesion | Slow to relocate and vulnerable to disrupted supply                       |
| Iron Swarm         | Mobile, caste-based expansionists         | Fast gathering, raids, distributed command    | Weak recovery from concentrated losses and poor long-term soil management |

Asymmetry should primarily come from policy weights, tech trees, unit templates, and starting conditions—not forked simulation rules. This protects maintainability and lets later factions reuse systems.

### Victory

Use a scored dominance model plus decisive conditions. At each seasonal review, show both factions’ score breakdown but not hidden tactical data.

- **Decisive:** eliminate the other faction’s active command centers and prevent re-establishment for one season.
- **Territorial:** control 65% of valuable regions for two consecutive seasons.
- **Hegemonic:** reach 75% of a weighted dominance score at a seasonal review.
- **Player option:** sandbox mode with no victory trigger.

Dominance score: 30% controlled productive territory, 25% population/economic output, 20% military capacity, 15% knowledge/institutions, 10% stability and legitimacy.

## 3. Simulation Design

### 3.1 World model

Generate a deterministic world from `worldSeed` using a seeded PRNG. Store the seed and generator version in every save.

Each tile has immutable-or-slowly-changing terrain and mutable state:

```ts
type Tile = {
  terrain: TerrainType; // deepWater, water, marsh, grass, forest, hill, mountain
  elevation: number; // uint8
  moisture: number; // uint8
  fertility: number; // uint8
  temperatureBand: number; // uint8
  movementCost: number; // uint8
  regionId: number;
  ownerFactionId: number; // 0 = neutral
  controlStrength: number; // 0..255
  resourceNodes: ResourceNode[]; // fixed deposits / renewable patches
  buildingEntityIds: number[]; // runtime spatial index, not authoritative ownership
  fireIntensity: number; // 0..255
  contamination: number; // 0..255
};
```

Generate elevation first, derive water/flow, then moisture, temperature, fertility, biomes, resource deposits, and regions. Use a simple noise implementation initially; do not add external procedural dependencies unless clearly justified.

Resource classes:

- Renewable: berries, game, timber, reeds, clay, fish, pasture, soil fertility.
- Finite: stone, copper, iron, coal/sulfur equivalents.
- Processed: planks, charcoal, bricks, tools, weapons, medicine, rations.
- Abstract: labor-hours, knowledge, legitimacy, command capacity.

Environmental feedback loops for later phases:

- Forest harvest reduces cover and timber, increases runoff/erosion risk.
- Crop intensity reduces fertility unless fallow/compost/irrigation policies compensate.
- Fire spreads according to fuel, weather, and wind.
- Pollution/contamination increases disease risk and reduces water/soil quality.

### 3.2 People and entities

Use individual citizens at MVP, but keep detail deliberately bounded. Do not give every entity an unbounded object graph or a full behavior tree.

Citizen state:

```ts
type Citizen = {
  id: EntityId;
  factionId: FactionId;
  caste: Caste; // worker, builder, hauler, scout, soldier, leader, child
  ageDays: number;
  posTile: TileId;
  homeId: EntityId | null;
  squadId: EntityId | null;
  health: number;
  energy: number;
  hunger: number;
  morale: number;
  skillGather: number;
  skillCraft: number;
  skillFight: number;
  loyalty: number; // affected by safety, food, policies, relationships
  currentTaskId: EntityId | null;
  inventory: SmallInventory;
  knowledgeFlags: number; // compact known facts/tech exposure
  traits: number; // compact bit flags, not arbitrary prose
};
```

MVP needs: food, rest, safety, assigned duty, and morale. Add relationships, families, and personal memories only after population-scale performance is verified. Use aggregate households or small social links rather than a complete social graph.

### 3.3 Task market and autonomy

The task system is the heart of the colony simulation. Buildings, stockpiles, squads, construction sites, and faction-level plans publish tasks. Eligible citizens bid using a deterministic utility calculation; the dispatcher assigns work and handles reservations.

Task examples: harvest, fell tree, mine, haul, deliver, craft, build, repair, patrol, scout, heal, rest, eat, extinguish fire, recruit, siege, retreat.

A task has requirements, a priority, a reservation set, a location, an expiry, and a state machine:

`created → claimable → reserved → inProgress → completed | failed | cancelled`

Utility sketch:

\[
U = P \cdot I \cdot A \cdot S - (T + R + F)
\]

Where `P` is player/faction priority, `I` is strategic impact, `A` is citizen aptitude, `S` is situational urgency, `T` is travel/effort cost, `R` is danger, and `F` is fatigue/need cost. Keep all weights data-driven per faction policy.

Critical rules:

- Reserve target resources and workstations atomically to prevent duplicate hauling/crafting.
- Revalidate every task phase; paths, inventories, buildings, and threats can change.
- Add timeout/retry and a visible failure reason.
- Citizens may interrupt ordinary work for survival needs, immediate danger, or a high-priority emergency.
- Limit task re-evaluation to event triggers and staggered intervals; do not rescore all tasks for all people each tick.

### 3.4 Economy and logistics

All material movement occurs through explicit inventories and hauling. Avoid magic global storage.

Inventory locations: citizen, ground pile, stockpile, building input, building output, wagon/pack animal (later), squad supply cache.

Buildings consume recipe inputs, labor time, and optionally fuel; they emit outputs, waste, heat, noise, and work tasks. A bakery cannot bake with flour sitting on the other side of the map unless a hauler brings it.

Implement stockpile rules: accepted item categories, desired reserve, priority, faction access, and optional squad reserve. The logistics AI should use “pull” requests from consumers, then opportunistic “push” consolidation only if idle capacity exists.

Economic flows to model:

- Food chain: gather/farm/hunt → storage → preparation → consumption.
- Construction chain: wood/stone/clay → processing → materials → blueprint → maintenance.
- Military chain: ore/timber → forge/workshop → equipment → armory → squad → field resupply.
- Health chain: clean water/food/shelter → disease risk; herbs/medicine → treatment.

### 3.5 Settlements, institutions, and legitimacy

A settlement is a named cluster centered on a command building. It provides a control radius, creates civic work, aggregates stocks/alerts, and can create a secondary base when population and supply thresholds are met.

Institutions turn raw resources into persistent capability:

- Storehouse: stock rules and spoilage mitigation.
- Hall: command capacity, laws, research administration.
- Barracks: training, squad organization, equipment maintenance.
- Shrine/forum: morale, legitimacy, festivals, faction-specific abilities.
- Clinic: treatment and quarantine.
- School/archive: research speed and knowledge retention.

Legitimacy is not a generic happiness bar. It is a composite of food security, safety, perceived fairness of rations/laws, military success, housing, and institution coverage. Low legitimacy causes slower work, defection, banditry/independence events (later), and weaker recruitment.

### 3.6 Knowledge and research

Research must be grounded in production and institutions, not merely an XP counter. Each technology has prerequisites, work requirements, required materials or facilities, and optional discovery triggers.

Research branches:

- Subsistence: irrigation, crop rotation, preservation, animal husbandry.
- Industry: better tools, kilns, metallurgy, machines.
- Military: formations, fortification, siege, medicine, signals.
- Civic: administration, sanitation, education, trade systems.
- Adaptation: cold-weather gear, fire control, disease response.

Use compact data definitions for techs. The first implementation can award research points from assigned scholars and completed experiments; later make observation and reverse-engineering unlock partial knowledge.

### 3.7 Combat and warfare

Combat is an operational simulation, not click-per-unit RTS combat. The player creates squads, assigns doctrine, draws an operation area or target, and sets posture: hold, patrol, escort, raid, defend supply, assault, or retreat.

Squad state: commander, members, formation type, morale, cohesion, equipment, ammunition, food, medicine, current order, route, local intelligence, and supply status.

Combat resolution occurs in discrete encounters. Use simple but meaningful inputs:

- Personnel and experience.
- Weapon/armor quality and ammunition.
- Formation and morale/cohesion.
- Terrain cover/elevation and fortification.
- Fatigue, hunger, weather, and local numerical superiority.
- Command delay and scouting information.

Model casualties as health/injury/death/capture, not only immediate deletion. Route and pursuit should matter. A defeated army that escapes may carry disease, consume scarce medical resources, lower legitimacy, and invite a second invasion.

Supply is mandatory for sustained operations. Field squads consume rations and ammo each day; lower supply reduces movement, recovery, morale, and combat effectiveness. Raiding supply routes must therefore be a viable alternative to frontal battle.

### 3.8 Enemy civilization AI

Use hierarchical AI instead of a monolithic omniscient planner.

- **Strategic director** (every 20 ticks): evaluates needs and chooses a small number of goals.
- **Settlement governor** (every 10 ticks): converts goals into quotas, building plans, stockpile priorities, and squad assignments.
- **Local agent/task logic** (event-driven + staggered): performs work using the shared task market.
- **Military commander** (every 5 ticks during operations): assesses threat, route safety, supply, and retreat thresholds.

Strategic goals: survive winter, secure food, secure strategic resource, expand settlement, research prerequisite, defend border, harass supply, raid, siege, recover, negotiate/trade (later).

The director uses imperfect intelligence. It can observe its own territory fully, use scout reports with age/confidence, and infer enemy strength from sightings—not inspect player inventories or plans.

Goal score example:

\[
G = \text{urgency} \times \text{expectedGain} \times \text{confidence} - \text{risk} - \text{opportunityCost}
\]

Log every strategic decision in a machine-readable explanation record: `goal`, top contributing factors, rejected alternatives, input values, expected end condition, and review tick. Surface this in debug tools and selected player reports.

### 3.9 Events and narrative

Events are simulation consequences, not random punishment. An event director may identify emerging conditions and produce readable alerts, but cannot manufacture missing state.

Examples:

- “West granary exhausted: 83% of delivery tasks failed due to blocked bridge.”
- “Iron Swarm raid is likely: scouts observed two squads moving toward the eastern road.”
- “Fever spreading in Lower Hearth: high crowding and low clean-water coverage.”

Event record schema: timestamp, severity, entities/tiles, causal tags, short text key, detailed explanation key, related actions. Retain a rolling log and exportable debug event stream.

## 4. UX and Presentation

### Visual direction

Use clean 2D top-down tiles. Terrain is colored and textured lightly; factions use strong contrasting palettes; citizens are small colored markers/sprites with equipment overlays; buildings use recognizable silhouettes. At normal zoom, show aggregate/semantic symbols rather than every inventory item.

### Screens and controls

- **Main map:** pan, zoom, pause/speed, minimap, alerts, selected entity inspector.
- **Build mode:** blueprint placement, ghost validity, input requirements, priority.
- **Policy panel:** labor weights, ration level, draft level, expansion/defense bias, stockpile minimums.
- **Operations panel:** squads, readiness, supply, doctrine, orders.
- **Reports:** food forecast, production flow, population, casualties, diplomacy, research, dominance.
- **Overlays:** ownership/control, fertility, resources, roads, logistics congestion, pathing, danger, disease, supply reach, scout confidence.
- **Chronicle:** filterable causal event log, searchable by entity and type.

All critical state needs an inspectable explanation. Example: selecting an idle miner should show “Idle: no reachable mining tasks; nearest iron deposit is reserved for construction project 17; priority policy favors food 1.4×.”

### Accessibility

- Keyboard controls for pause, speeds, overlays, build categories, and focus cycling.
- No information conveyed by color alone; use icons/patterns/tooltips.
- Scalable UI and fonts; reduced motion setting; persistent control remapping.
- A “simulation clarity” mode that slows time on high-severity alerts.

## 5. Technical Architecture

### Stack decision

Use **TypeScript + Vite + PixiJS 8 + bitECS + Web Workers + IndexedDB**.

This is the recommended default rather than Rust/WASM for the first implementation: it keeps iteration fast for an AI coding agent, makes browser UI and debugging straightforward, and provides a data-oriented ECS suitable for the simulation. PixiJS supports browser and worker execution contexts, bitECS is a minimal TypedArray-oriented ECS, and IndexedDB is an in-browser persistent store. See research links in Appendix A.

Use Rust/WASM only as a later optimization boundary if profiling proves that a contained hot subsystem—such as pathfinding or world generation—dominates runtime. Do not split the simulation across JS and WASM before there is a measured reason; deterministic serialization, debugability, and agent implementation speed are more valuable early.

### Dependencies

| Concern            | Choice                                           | Notes                                                                          |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Build/dev server   | Vite                                             | Fast TypeScript workflow and worker bundling                                   |
| Language           | TypeScript, strict                               | No implicit `any`; branded IDs where useful                                    |
| Renderer           | PixiJS 8                                         | WebGL/WebGPU-capable 2D rendering and sprite batching                          |
| Simulation storage | bitECS plus typed-array component stores         | Keep hot data contiguous and serializable                                      |
| UI                 | React + Zustand, or lightweight DOM UI           | React is acceptable for panels only; never place per-entity rendering in React |
| Worker transport   | `postMessage` with transferable buffers first    | Add `SharedArrayBuffer` only behind capability checks                          |
| Saves              | IndexedDB via a small versioned repository layer | Auto-save rotating slots and manual export/import                              |
| Tests              | Vitest + Playwright                              | Unit, deterministic scenario, and browser smoke tests                          |
| Formatting/lint    | ESLint + Prettier                                | Enforced in CI                                                                 |

### Repository layout

```text
src/
  app/                 # boot, routes, global shell
  sim/
    core/              # clock, PRNG, command stream, scheduler, serialization
    ecs/               # components, entity lifecycle, queries
    world/             # generation, tiles, regions, spatial indices
    systems/           # pure or near-pure simulation systems
    economy/           # recipes, inventories, tasks, logistics
    ai/                # strategic director, planners, explainability
    combat/            # squads, encounters, supply, operations
    data/              # JSON/TS definitions: items, buildings, techs, factions
    scenarios/         # deterministic test worlds and command scripts
  worker/              # worker entry, message protocol, snapshot publishing
  render/              # Pixi scene, tile chunks, sprite pooling, overlays
  ui/                  # React/DOM panels, selectors, commands
  persistence/         # save schema/migrations/import/export
  debug/               # inspectors, metrics, replay, dev cheats
  shared/              # IDs, protocol types, constants
public/
tests/
  unit/
  sim/
  e2e/
docs/
```

### Simulation boundary

The worker owns all authoritative simulation state. The main thread owns DOM UI, input capture, audio, and rendering state derived from snapshots. The UI sends validated player commands; it never mutates simulation objects directly.

```ts
type PlayerCommand =
  | {
      kind: 'PlaceBlueprint';
      tick: number;
      building: BuildingKind;
      tiles: TileId[];
      priority: number;
    }
  | { kind: 'SetPolicy'; tick: number; factionId: FactionId; policy: PolicyPatch }
  | { kind: 'IssueSquadOrder'; tick: number; squadId: EntityId; order: SquadOrder }
  | { kind: 'SetStockpileRule'; tick: number; stockpileId: EntityId; rule: StockpileRule };

type SimSnapshot = {
  tick: number;
  worldVersion: number;
  changedTiles: ArrayBuffer;
  renderEntities: ArrayBuffer;
  summaries: FactionSummary[];
  alerts: Alert[];
};
```

Start with snapshots every 5 simulation ticks. Publish compact render-focused typed arrays and event deltas; never clone the entire ECS world every frame. A snapshot must be read-only to the renderer.

### Determinism rules

- Use a custom seeded PRNG with explicit streams: worldgen, faction A, faction B, combat, events. Never use `Math.random()` in simulation.
- Fixed tick only. No `deltaTime` in authoritative systems.
- Process entities/tasks in stable numeric ID order and resolve ties by explicit stable keys.
- Use integer/fixed-point arithmetic for authoritative quantities where practical, particularly resource quantities, probabilities, and combat calculations. Avoid cross-platform floating point comparisons in decisive branch logic.
- Commands are appended to an ordered command log and applied at tick boundaries.
- Save includes schema version, content version/hash, seed/PRNG states, tick, command log tail, and serialized component arrays.
- Each scenario can calculate a periodic state hash. A replay mismatch is a test failure.

### Performance plan

Budgets for release target on a mid-range desktop browser:

- 500 active citizens/units, 256×256 world, 60 FPS rendering at 1×, 30+ FPS at 4×.
- Simulation worker: < 8 ms/tick at 1× nominal workload; catch-up is capped per animation frame.
- Main thread snapshot/render/UI: < 8 ms average frame.
- No unbounded per-tick allocations in hot systems.

Methods:

- Chunk tile rendering and redraw only dirty chunks.
- Sprite pooling; no create/destroy display object per entity per frame.
- Hierarchical pathfinding: region graph for long distance, local A* for detailed route; cache and invalidate by obstacle/road version.
- Update distant/idle entities at lower frequency when it cannot change outcomes.
- Use spatial grids for nearby enemy, building, fire, and resource queries.
- Measure before optimizing. Maintain a debug metrics panel with system timing, entity count, task count, path requests, worker queue length, and snapshot bytes.

`SharedArrayBuffer` is an optional optimization. It requires a secure, cross-origin-isolated document, so the normal transferable-buffer snapshot protocol must remain fully supported.

### Content-driven definitions

Use validated data files for all tunable content. Avoid hard-coded recipes, units, tech effects, balancing weights, and strings in systems.

```ts
type BuildingDefinition = {
  id: string;
  footprint: [number, number];
  tags: string[];
  buildCost: ItemStack[];
  workers: WorkerSlot[];
  recipes?: RecipeDefinition[];
  storage?: StorageDefinition;
  effects: EffectDefinition[];
  unlocks: string[];
};
```

Add JSON schema validation or Zod validation at startup/test time. Content errors must identify the source definition and field.

## 6. Development Roadmap

### Milestone 0 — Foundation (1–2 agent iterations)

**Goal:** A reproducible project shell that can run and test a blank map.

Deliverables:

- Vite + strict TypeScript project, Pixi canvas, UI shell, worker boot, lint/test/build scripts.
- Seeded PRNG, fixed-step clock, command protocol, and basic snapshot protocol.
- Tile map render with pan/zoom, debug grid, pause and speed controls.
- CI workflow: install, lint, unit tests, production build, Playwright launch smoke test.
- Architecture decision record for worker ownership and determinism.

Acceptance tests:

- `npm run build`, `lint`, and `test` pass from a clean checkout.
- Same seed renders the same terrain hash in two runs.
- Simulation advances only in fixed ticks and obeys pause/speed.

### Milestone 1 — Vertical Slice: Two Tiny Colonies (2–4 iterations)

> **Progress: iterations 1a + 1b complete.** The survival loop (citizens,
> needs, deterministic A*, task market, gather → haul → eat, ownership,
> inspectors, alerts) and **construction** are both shipped and tested:
> player-placed blueprints (stockpile + hut) validate deterministically
> (walkable land, no overlap, claim radius, per-faction cap), the HUD build
> palette places them (protocol v2 `PlaceBlueprint` + `commandRejected`),
> builders reserve a site, construct it, and it completes exactly once with a
> causal `construction.complete` alert; unreachable sites enter a retry
> cooldown instead of spinning demand (see
> `tests/sim/scenario-construction.test.ts` + e2e `construction.spec.ts`).

**Goal:** Prove the core fantasy with no more than 12 citizens per faction.

Deliverables (1a + 1b ✅ shipped):

- [x] Generated terrain, water, forest, stone, and berries.
- [x] Citizens with movement, hunger, energy, inventories, and a simple task queue.
- [x] Gather → haul → eat loop with stockpiles.
- [x] Two faction command centers, ownership/control overlay, basic AI gather behavior.
- [x] Build a stockpile and hut from player blueprints.
- [x] Inspectors for citizen, tile, inventory, and task state (blueprints
      included: kind, progress %, reservation).

Acceptance scenario:

- Start seed `vertical-slice-01`, run 3 game days. Both factions gather food, carry it to stockpiles, eat, and survive without player commands.
- Player places one stockpile and hut; builders reserve materials, construct them, and complete tasks exactly once.
- Killing/removing a food patch eventually creates a food alert rather than silent idling.

### Milestone 2 — Economy and Settlement (3–5 iterations)

> **Progress: iteration 2 (work buildings) complete.** Iteration 1 built the
> construction material chain: wood and stone are harvestable (tree/stone
> nodes spawn per faction); stockpiles store all items
> (food/wood/stone/planks) under a shared capacity; construction sites
> consume their material cost from faction stockpiles exactly once (unfunded
> sites wait for materials; failed builds refund them), and a haul task
> rescues stranded material carries. **Iteration 2 replaces the
> command-center crafting placeholder with a real work building — the
> sawpit:** haulers run a `Supply` task to keep its wood buffer topped up
> and to carry crafted planks back to stockpiles; a worker crafts one planks
> batch at a time (2 wood → 1 plank, consumed atomically from the sawpit's
> own buffer); a hut without a sawpit waits instead of stalling gatherers.
> `adjacentGoal` now rejects tiles inside any building/blueprint footprint,
> so a neighboring site can never become a work building's delivery goal.
> Protocol v3 adds snapshot `stocks` and richer inspector details (item
> carries, building stock, blueprint cost/funding). Scenario suite:
> `tests/sim/scenario-economy.test.ts` (+ e2e `construction.spec.ts`),
> deterministic under the same seed + command stream.
>
> **Progress: iterations 3–5 complete.** Iteration 3 added construction
> priorities (blueprints carry a 1–3 priority that drives funding/build
> order); iteration 4 added the stockpile policy (desired reserve per item,
> set by `SetStockpileReserve`, clamped to capacity at demand time);
> iteration 5 added **seasons and weather** — food gather yield, hunger
> growth, and berry regrowth scale by season (winter: 0.4× gather, 1.3×
> hunger, no regrowth), the logistics AI builds an autumn winter buffer
> (food reserve target × 1.5 going into winter), and each season transition
> fires exactly one causal `weather.season` alert. All seasonal values are
> a pure function of the tick (`src/sim/core/seasons.ts`), so there is no
> new simulation state, PRNG stream, or protocol change; the HUD shows the
> season name + weather descriptor and the map is subtly tinted per season.
> Scenario suite: `tests/sim/scenario-seasons.test.ts` (autumn buffer,
> winter slowdown, winter starvation timing, weather alerts, 100-day
> determinism) + `tests/unit/seasons.test.ts`.

**Goal:** A functioning settlement that has production chains and meaningful labor tradeoffs.

Deliverables:

- Recipes, work buildings, wood/stone/planks, construction priorities, spoilage.
- Farm or renewable food production, seasons, basic weather modifiers.
- Settlement, housing, morale/legitimacy, simple research and 8–12 technologies.
- Policy panel for labor, rations, and stockpile reserves.
- Food forecast and production/consumption report.
- First economic crisis alerts with causal explanations.

Acceptance scenario:

- Given low winter food, AI changes priorities and constructs/operates a food-producing chain when inputs and space exist.
- A player can trace a “low food” alert to source inventories, failed/blocked tasks, and affected policies.

### Milestone 3 — Strategic Competition (3–5 iterations)

**Goal:** The two factions expand into competition and the opponent makes understandable strategic choices.

Deliverables:

- Regions, control, scouting, fog of war/intelligence confidence.
- Strategic resource deposits, outposts, roads, expansion plans.
- Hierarchical AI director with 5+ goals and decision explanations.
- Diplomacy placeholder: neutral, tense, hostile; no formal trade required yet.
- Dominance score, seasonal review, timeline reports.

Acceptance scenario:

- On a map with a central iron region, both factions assess it; at least one creates an expansion/defense plan based on resource shortfall and known threat rather than always attacking.
- Enemy AI cannot see player stockpiles outside its intelligence coverage; test by altering hidden player stock and checking director inputs.

### Milestone 4 — War and Logistics (4–6 iterations)

**Goal:** Make war consequential, legible, and not reducible to population count.

Deliverables:

- Squad formation, recruitment, equipment, patrol/defend/raid/assault/retreat orders.
- Combat encounter resolution, casualties, capture/retreat, morale/cohesion.
- Supply consumption, supply caches/routes, raidable hauling, fortifications.
- Operations panel, battle report, military and danger overlays.
- At least two faction-specific military doctrines.

Acceptance scenario:

- A poorly supplied stronger squad loses combat effectiveness over time and can be beaten or forced back by a smaller fortified squad.
- Cutting a supply route causes a visible, causally linked deterioration in the distant army’s readiness.

### Milestone 5 — Emergence and Resilience (ongoing)

**Goal:** Add feedback loops and make repeated games diverge meaningfully.

Deliverables:

- Disease, sanitation, fire, environmental depletion/regrowth, migration/defection (one system at a time).
- Better AI adaptation: recovery plans, counter-raids, opportunistic alliances/trade if diplomacy exists.
- At least 3 scenario maps and 3 faction/starting-condition variations.
- Replay viewer, save migration, autosaves, import/export, performance profiling.
- Balance telemetry from automated simulation batches.

Acceptance scenario:

- Run 100 seeded headless simulations per scenario. No crashes, no invalid state assertions, no permanent global task deadlock, and neither faction exceeds an agreed win-rate threshold without a scenario-specific advantage.

### Milestone 6 — Beta Quality

**Goal:** A playable, debuggable, reasonably balanced game loop.

Deliverables:

- Tutorial/objectives for the first 10 minutes.
- Keyboard/accessibility pass, settings, performance presets.
- Comprehensive alert/report clarity pass.
- Content expansion only after profiling and test coverage targets are met.
- Release checklist, known limitations, hosted browser build.

## 7. Agent Execution Rules

### Work method

The AI agent should work in small, vertically integrated changes. For every task: inspect relevant existing code, state the implementation plan, modify the smallest coherent surface, run targeted tests plus project checks, then report changed files, behavior, tests, and risks.

Do not begin broad feature work by generating dozens of empty abstractions. Prefer a thin end-to-end slice with real tests, then generalize only when a second use case demonstrates the need.

### Mandatory engineering standards

- TypeScript strict mode; no `any`, non-null assertion abuse, or global mutable simulation state.
- Authoritative state only in `sim`; renderer/UI have derived state only.
- Every new system declares read/write components and scheduling order.
- Every state transition is idempotent or guarded against duplicate application.
- Every entity reference is validated; destroyed entities cannot be reused silently.
- Define invariants and assert them in development builds: non-negative inventories, valid task owner, capacity limits, no duplicate reservation, valid faction IDs.
- Add unit tests for pure rules and deterministic scenario tests for interactions.
- Never change a balancing constant without placing it in content/config and documenting the intended effect.
- Do not introduce a dependency without documenting purpose, bundle impact, license, and alternative considered.
- Keep commits narrow and conventional: `feat(sim):`, `fix(logistics):`, `test(ai):`, `refactor(render):`, `docs:`.

### Definition of done

A feature is done only when it:

1. Is accessible in the running browser build.
2. Has a deterministic test or reproducible scenario covering its primary success path.
3. Handles at least one failure/edge path visibly.
4. Is inspectable through debug UI/logs if it affects autonomous behavior.
5. Does not regress lint, typecheck, unit tests, scenario tests, or browser smoke test.
6. Includes documentation updates for public data schemas or architectural changes.

### Suggested issue decomposition

Create and complete issues in this order:

1. Project scaffold and quality gates.
2. Seeded PRNG + deterministic fixed tick.
3. Worker command/snapshot protocol.
4. Tile world generation + Pixi chunk renderer.
5. ECS entity lifecycle + component serialization.
6. Citizen movement + deterministic path request interface.
7. Items/inventory + reservation API. **(M2: multi-item `Stock`, material
   gather, work buildings (sawpit supply/craft), haul — done)**
8. Task lifecycle + task inspector.
9. Gathering/hauling/eating scenario.
10. Blueprint/construction scenario.
11. Settlement and stockpile policy.
12. Economy/research/season slice.
13. Strategic AI and explainability.
14. Squads/supply/combat.
15. Persistence/replay/profiling.

## 8. Test and Balance Strategy

### Test pyramid

- **Unit tests:** PRNG, fixed-point math, recipe transforms, inventory reservation, utility scoring, path cost, combat math, serialization.
- **Simulation scenario tests:** fixed seed + initial state + command script + expected assertions at ticks.
- **Property tests:** inventories never go negative; conservation holds except explicit consumption/production; tasks have at most one active claimant; state hash is stable.
- **Browser tests:** boot, render, pan/zoom, pause, place blueprint, inspect alert, save/load.
- **Soak tests:** headless 20-year simulations with periodic invariant checks and memory metrics.

### Scenario fixture format

```ts
export const foodCrisisScenario: Scenario = {
  seed: 8012,
  ticks: 3600,
  setup: setupFoodCrisis,
  commands: [{ tick: 50, kind: 'SetPolicy' /* ... */ }],
  assertions: [
    atTick(600, expectFactionFoodAbove(0, 10)),
    atTick(1000, expectEvent('food.shortage')),
    atEnd(expectNoInvariantFailures()),
  ],
};
```

### Balance workflow

Balance through machine-readable parameters and batch outcomes, never one-off code changes. For each build, record wins by faction, survival time, population, food deficit days, battle outcomes, and dominant strategies across fixed seed sets.

Start with equal faction baseline scenarios. Add asymmetry only after core systems are stable. A strategy is suspect if it wins across most seeds with little situational dependence; add a counterplay cost or remove the universal advantage.

## 9. Risks and Mitigations

| Risk                                                | Mitigation                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Scope grows into an unfinished Dwarf Fortress clone | Protect milestone gates; MVP proves only gather, build, survive, compete, and limited war                |
| Simulation becomes opaque                           | Build inspector, causal events, overlays, and AI explanation records alongside each system               |
| Browser performance collapses                       | Worker authority, typed arrays, snapshot deltas, profiling budget, entity cap, staged detail             |
| Agent writes fragile abstractions                   | Enforce vertical slices, scenario tests, content validation, narrow commits, and code review checkpoints |
| AI has omniscience or cheats                        | Explicit intelligence records, tests that hide player state, scouting confidence/age                     |
| Logistics creates deadlocks                         | Reservation timeouts, task revalidation, recovery scans, invariant checks, visible blocked reasons       |
| Determinism breaks across refactors                 | PRNG rules, fixed ticks, stable order, replay hashes, scenario golden tests                              |
| Content becomes impossible to tune                  | Data-driven definitions, central balance config, batch telemetry                                         |

## 10. Appendix A — Research Notes

### Useful design references

- **Dwarf Fortress lesson:** rich narratives emerge when physical resources, labor, environment, social state, and crisis systems share causal state. Adopt the interconnection, but impose stronger player explanations and stricter scope.
- **Ant colony lesson:** local rules plus pheromone-like priorities can produce resilient group behavior. Translate this to task demand, reservation, supply pressure, and local danger rather than literal pheromones.
- **Command & Conquer lesson:** territory, production capacity, scouting, positional defense, and clear faction silhouettes make competition legible. Retain macro strategy but replace click-heavy unit control with doctrine and operations.
- **RimWorld lesson:** readable incident consequences and individual needs make colony failure comprehensible. Avoid an arbitrary storyteller; alerts should arise from simulation state.
- **OpenRA lesson:** clear data-driven factions and deterministic simulation are useful reference principles for strategy systems; do not copy its unit-level control model.

### Technology research links

- PixiJS environment adapters and worker/OffscreenCanvas support: https://pixijs.com/8.x/guides/concepts/environments
- bitECS, a minimal data-oriented ECS using JavaScript TypedArrays: https://github.com/NateTheGreatt/bitECS
- MDN IndexedDB guide for persistent browser storage: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
- MDN SharedArrayBuffer requirements and shared-memory behavior: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- Yuka game AI library (steering/navigation): https://github.com/Mugen87/yuka

Do **not** introduce Yuka into the MVP automatically. Its steering/navigation concepts can inform design, but a tile/grid strategy game needs deterministic grid pathfinding and task-aware routing first.

## 11. First Agent Prompt

> Implement Milestone 0 only. First inspect the repository and summarize existing architecture. Then write a short implementation plan. Build a strict TypeScript Vite browser project with a PixiJS map canvas, a simulation Web Worker that owns a fixed-tick seeded simulation clock, and a main-thread UI with pause/1×/2×/4× controls. Implement deterministic terrain generation from a seed, publish a compact tile snapshot from worker to renderer, and display the terrain hash in debug UI. Add Vitest tests proving same seed produces same hash and a Playwright smoke test proving the app boots. Keep rendering and simulation separate. Do not add ECS, citizens, combat, React, or persistence yet. Run all checks and report changed files, commands run, and remaining follow-ups.
