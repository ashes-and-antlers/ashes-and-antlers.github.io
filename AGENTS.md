# AGENTS.md — Ashes and Antlers (Civilizations at War)

Guidance for AI coding agents and human contributors working in this repository.
Read this before editing anything. It encodes the project's non-negotiable
architecture and determinism rules, plus practical gotchas learned so far.

**If you only read two documents, read:** this file and
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) (the full design). The plan's §7
(Agent Execution Rules) and §8 (Test and Balance Strategy) are contract, not
suggestion.

---

## 1. Project overview

A single-player, browser-native 2D grand colony/RTS in which **two autonomous
civilizations** share one deterministic simulation — same seed + config +
ordered commands = same result, every time. Working title: _Ashes and Antlers_.

Current state: **Milestone 2 iteration 2 (work buildings) is complete**, on
top of M1a (survival loop), M1b (construction), and M2-1 (the materials
chain). The M0 foundation (seeded deterministic worldgen in a Web Worker,
fixed-tick clock, snapshot protocol, PixiJS renderer, CI) is extended with a
bitECS entity layer: two faction command centers, ownership overlays,
citizens with movement and needs, a deterministic task market (gather → haul
→ eat), stockpiles, resource nodes, inspectors, causal alerts, and
player-placed blueprints → builder construction (stockpile + hut + sawpit,
completed exactly once). The M2 slices add the **materials economy**:
harvestable wood/stone tree nodes, multi-item stockpiles (per-item `Stock`
stores), a **sawpit work building** with real logistics (haulers supply wood
into its buffer and carry planks out — the planks recipe is worked there,
not at the command center), construction sites that consume material costs
from faction stockpiles (refunded on build failure), and a haul task that
rescues stranded carries. Protocol v3.

Design pillars that constrain every change:

1. **Simulation first** — every visible outcome has a causal chain in state.
2. **Deterministic core** — reproducible from seed + command stream.
3. **Cheap visuals, rich state** — simple tiles/markers over expensive art.
4. **Readable complexity** — inspectors, overlays, and alerts for everything.

## 2. Non-negotiable architecture rules

These are enforced in review. Breaking them is a blocking defect.

1. **The Web Worker owns all authoritative simulation state.** The main thread
   (DOM, input, PixiJS) only reads snapshots and sends validated commands. It
   must never import from `sim/` and mutate simulation objects.
2. **No `Math.random()` anywhere in `sim/`.** All randomness flows through
   seeded PRNG streams (`src/sim/core/prng.ts`, mulberry32 + FNV-1a, named
   streams per concern).
3. **Fixed ticks only.** `FixedClock` runs 5 ticks/second at 1×. `Simulation.step`
   takes an integer tick count; systems never read wall-clock time or
   `deltaTime`. (`performance.now()` lives only in the worker's tick loop.)
4. **Stable iteration order.** Authoritative systems iterate entities with
   `sortedQuery` (ascending entity id) and break ties with explicit stable
   keys. Never iterate a raw bitECS query in authoritative logic.
5. **Content is data-driven.** Balance lives in `src/sim/data/config.ts`
   (`SIM_CONFIG`); entity/building/faction definitions in
   `src/sim/data/content.ts`. Never hard-code tunable numbers in systems.
6. **Version everything.** `WORLD_VERSION` (worldgen semantics) and
   `PROTOCOL_VERSION` (worker protocol) gate every handshake; mismatch is a
   hard error. Bump `WORLD_VERSION` when worldgen output changes.
7. **Renderer/UI state is derived.** Never store authoritative sim data on the
   main thread; rebuild render layers from each snapshot.

See `docs/ADR-001-worker-ownership-and-determinism.md` for the full contract.

## 3. Tech stack

| Concern            | Choice                               | Notes                                                                                                                                                                  |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language           | TypeScript 5.7, **strict**           | `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `noUnusedLocals/Parameters`; `noUncheckedIndexedAccess` deliberately off (dense typed arrays) |
| Build/dev server   | Vite 6                               | `target: es2022`, sourcemaps on                                                                                                                                        |
| Renderer           | PixiJS 8 (`pixi.js` ^8.6)            | WebGL; v8 API (`Graphics` chained `.fill()/.stroke()`, `Texture.from`)                                                                                                 |
| Simulation storage | bitECS 0.4                           | SoA typed-array component stores (`createWorld({ components })`)                                                                                                       |
| Worker transport   | `postMessage` + transferable buffers | No SharedArrayBuffer                                                                                                                                                   |
| UI                 | Lightweight DOM (no React)           | `data-testid` hooks for e2e                                                                                                                                            |
| Tests              | Vitest 3 + Playwright 1.49           | Unit/sim tests in Node env; e2e in Chromium                                                                                                                            |
| Lint/format        | ESLint 9 (flat) + Prettier 3.4       | Enforced in CI                                                                                                                                                         |

## 4. Repo map

Two HTML entry points (Vite multi-page): `index.html` (landing page — centered
brand mark, premise, single enter action) and `game.html` (the simulation). The
game page is marked `noindex`; the landing page is the public entry.

```
src/
  app/            landing page (landing.ts, landing.css) + game boot (main.ts, style.css)
  shared/         protocol types, constants (TICKS_PER_DAY, SNAPSHOT_EVERY_TICKS,
                  PROTOCOL_VERSION, WORLD_VERSION, TILE_PX), branded IDs (TileId),
                  labels, FNV-1a/utils
  sim/
    core/         prng (seeded streams), clock (fixed-tick), calendar (pure fn),
                  hash (terrain hash), Simulation (owns world + step())
    data/         content.ts (enums/kinds/factions) + config.ts (SIM_CONFIG balance)
    ecs/          components.ts (SoA stores, MAX_ENTITIES=512), world.ts
                  (createSimWorld, sortedQuery, stats, alertLog), entities.ts
                  (factories: citizens, command centers, nodes)
    path/         astar.ts (deterministic A*, movement costs, tie-breaks)
    systems/      needs, resources, tasks (demand/claim/execution), taskops,
                  movement, ownership, alerts, run.ts (the fixed schedule)
    world/        tiles.ts, world.ts (TileWorld typed-array stores), generation.ts
    inspect.ts    worker-side inspector detail builder (tile/entity rows)
  worker/         index.ts — owns Simulation, tick loop, snapshot publishing,
                  init/command/inspect request handling
  render/         pixi.ts, mapview.ts (tiles + ownership + entities + grid),
                  entitylayer.ts (single-Graphics clear+redraw), ownershiplayer.ts
  ui/             hud.ts — DOM HUD: speed, readouts, alerts, inspector, toggles
tests/
  unit/           prng, clock, worldgen, astar, needs, ownership
  sim/            sim.test.ts (determinism/calendar), scenario-m1.test.ts (3-day
                  survival scenario), helpers.ts
  e2e/            boot.spec.ts (Playwright smoke: boot, hash, pause/speed,
                  toggles, inspector)
docs/             ADR-001 (worker ownership + determinism contract)
```

Notable root files: `DEVELOPMENT_PLAN.md` (design + roadmap), `AGENTS.md`,
`vite.config.ts` (also holds the Vitest config), `playwright.config.ts`,
`eslint.config.js`, `tsconfig.json` + `tsconfig.node.json` (config-file
projects), `.prettierignore` (excludes `.freebuff/` and build artifacts).

> `.freebuff/` contains Freebuff tooling internals (a local DB). Never edit,
> format, or commit it.

## 5. Commands and quality gates

```bash
npm install                 # install dependencies
npm run dev                 # Vite dev server
npm run build               # typecheck + production build → dist/
npm run preview             # serve dist/ at http://localhost:4173

npm run typecheck           # tsc -p tsconfig.json && tsc -p tsconfig.node.json
npm run lint                # eslint .
npm run format              # prettier --write .
npm run format:check        # prettier --check .
npm run test                # vitest run (unit + sim tests)
npm run test:unit           # vitest run tests/unit tests/sim (faster)
npm run test:e2e            # Playwright (requires a build; webServer auto-starts preview)
```

**CI (`.github/workflows/ci.yml`) runs all of these in order on every push/PR:**
`npm ci` → lint → typecheck → format:check → `npm run test` → build →
`npx playwright install --with-deps chromium` → `npm run test:e2e`. **Anything
that passes locally must pass this pipeline.** The standard pre-ship loop for
any change is:

```bash
npm run lint && npm run typecheck && npm run format:check && npm run test
npm run build && npm run test:e2e
```

### Quality gate details

- **Typecheck:** strict, `verbatimModuleSyntax` → type-only imports must use
  `import type { … }` (also an ESLint error via `consistent-type-imports`).
- **Lint:** flat config, `typescript-eslint` recommended + `no-unused-vars`
  with `^_` ignore patterns (prefix throwaway params/vars with `_`).
- **e2e:** cold-boot timing has been flaky before — every spec must call the
  `workerReady(page)` helper (waits for `status` = "worker ready", 15 s)
  before interacting with the HUD. CI has `retries: 2`. Playwright's
  `webServer` reuses a running preview locally, so kill `fuser -k 4173/tcp`
  to force a true cold-boot check.

## 6. Simulation architecture

### 6.1 The worker boundary (`src/worker/index.ts`)

- The worker constructs the `Simulation`, runs a 50 ms `setInterval` tick
  loop, converts elapsed time to whole ticks via `FixedClock`, and calls
  `sim.step(ticks)`.
- It publishes snapshots every `SNAPSHOT_EVERY_TICKS` (5) ticks, or once after
  a state change while paused. **Tiles transfer only on world change** (first
  publish); routine snapshots carry tick, calendar, terrain hash, signal,
  alerts, and the entity buffer.
- **Entity buffer:** fresh `Int32Array` of 7 ints per row —
  `[eid, kind, faction, x, y, state, extra]` (citizens first — `extra` is the
  carried amount — then buildings, then nodes, then blueprints, whose
  `extra` is build progress %) — transferred each publish. Snapshots also
  carry per-faction `stocks` (itemType → amount) for the HUD readouts.
- **Ownership buffer:** `world.owner.slice().buffer` sent only when
  `ownerVersion` changes. The `slice()` copy is deliberate — **transferring
  the live buffer would detach it in the worker and corrupt future writes.**
- Commands (`SetSpeed`) and `inspect` requests arrive via `onmessage`; the
  worker never receives sim-mutating state from the main thread.

### 6.2 The ECS (`src/sim/ecs/`)

- bitECS 0.4 style: `createWorld({ components: createSimComponents(), … })`
  where components are SoA typed arrays indexed by entity id
  (`components.Position.x[eid]`). Tags (`Citizen`, `Task`, …) are empty objects
  used only for queries.
- `MAX_ENTITIES = 512` bounds **concurrent** entities. bitECS **recycles freed
  entity ids** (verified empirically), so task create/complete churn does not
  grow the eid space — but recycled eids can carry stale component data.
  **Always initialize every field your component reads** (factories do this).
- Writing a typed array past its length **silently drops the write** (no
  error). Guard entity creation with `MAX_ENTITIES`.
- The world object also carries plain fields: `tiles`, `config`, `owner`,
  `blockedTiles`, `tick`, `stats`, `alertLog` (capped at
  `alertLogCapacity: 20` inside `pushAlert`), `commandCenters`, `nodes`,
  `paths` (per-eid derived A* cache), and alert rate-limit arrays.

### 6.3 The system schedule (`src/sim/systems/run.ts`)

Fixed order every tick — **do not reorder without updating tests and the ADR:**

1. `runNeeds` — hunger/energy/morale, eating, starvation (+ alerts)
2. `runResources` — renewable node regrowth
3. `runTaskDemand` — create work orders from needs and stock levels
4. `runTaskClaim` — assign orders to citizens (ascending id order)
5. `runTaskExecution` — advance task phases (arrival, harvest, deposit)
6. `runMovement` — walk citizens along cached A* paths
7. `runOwnership` — recompute faction control every `ownershipEveryTicks`
8. `runAlerts` — food-shortage detection etc.

Task lifecycle: `Created → Claimable → Reserved → InProgress → Completed |
Failed | Cancelled`, with reservation cleanup in `taskops.ts`
(`NodeReservedBy`, `TaskClaimedBy`, citizen `TaskId`) on every completion and
failure — duplicate claims and leaked reservations are defects.

### 6.4 Determinism specifics

- **PRNG streams:** `rng.stream('worldgen.elevation')` etc. — adding a consumer
  to one stream never perturbs another's sequence.
- **Pathfinding:** A* in `src/sim/path/astar.ts` is _derived state_ — never
  serialized or authoritative; recomputed from (position, goal, blocked
  tiles). Ties break on lower f-score → lower g-score → lower tile id.
- **Spawns:** homes, citizens, and nodes use seeded noise + fixed scan orders.
  Citizen spawn tiles are clamped to walkable non-building tiles via a
  deterministic expanding-square scan.
- **`stateHash()`** (`Simulation.stateHash`) produces a deterministic content
  hash over entity state — scenario tests assert it to prove reproducibility.
- **Calendar:** pure function `calendarAt(tick)`; 120-day years, 4 seasons of
  30 days, day = 300 ticks.

## 7. Rendering and UI (derived state only)

- `src/render/mapview.ts` composes: terrain texture (canvas →
  `Texture.from`, nearest-neighbor scaling), ownership overlay (rebuilt when
  `ownerVersion` changes, toggleable), entity layer, debug grid.
- `EntityLayer` is a **single `Graphics` cleared and redrawn** each snapshot —
  no per-entity sprites, so entity death/recycled eids cannot leak or stale.
- Camera: drag-pan, cursor-centered wheel zoom (PixiJS 8 event/pointer APIs).
- HUD (`src/ui/hud.ts`): pause/1×/2×/4×/8× buttons, seed/tick/day/season/year/
  terrain-hash readouts, per-faction stock readouts (wood/stone/planks/food),
  alerts banner, ownership/grid toggles, inspector panel. Keyboard: `Space`
  pause, `1/2/4/8` speed, `G` grid, `O` ownership.
- All interactive elements carry `data-testid` hooks consumed by e2e tests
  (`hash`, `seed`, `status`, `tick`, `speed-0…8`, `grid-toggle`,
  `ownership-toggle`, `inspector`, `inspector-title`, `inspector-content`).
  Preserve them when refactoring.

## 8. Testing strategy

- **Unit tests** (`tests/unit/`): pure rules — PRNG determinism, clock
  fixed-tick semantics, worldgen hash stability, A* (incl. wall detours),
  needs, ownership. All seeded; no timers.
- **Sim tests** (`tests/sim/`): `Simulation` determinism, calendar math, and
  the M1 scenario (`scenario-m1.test.ts`) — a 3-day survival run asserting
  both factions gather → haul → eat, survive without commands, the food
  shortage alert fires, and `stateHash` matches across two identical runs.
- **Helpers** (`tests/helpers.ts`): `makeSim`, `landTiles`, `connectedLand`,
  `passable`, etc. Reuse them; don't reinvent fixture logic.
- **e2e** (`tests/e2e/`): browser smoke — landing (logo title, centered mark,
  enter-CTA), boot/render, hash stability across reloads, pause/speed,
  grid + ownership toggles, inspector. Game-page tests start with
  `workerReady(page)` (boots `/game.html?seed=1337`).

Rule: **every new authoritative system needs a deterministic test covering its
primary success path and at least one failure/edge path** (plan §7 Definition
of Done).

## 9. Common pitfalls (learned the hard way)

- **Cold-boot e2e flake:** tests that click HUD controls right after `goto`
  race worker boot. Always use `workerReady(page)` first.
- **Transferable detach:** never `postMessage(transfer: [buffer])` a buffer
  the worker still needs. Copy with `.slice()` first (the `ownerTiles`
  pattern).
- **Silent typed-array clamping:** out-of-bounds writes don't throw — they're
  dropped. Guard with `MAX_ENTITIES`; init every component field on spawn
  (eids are recycled).
- **Raw query iteration is order-unsafe:** use `sortedQuery` in any system
  whose output affects state.
- **System order is contract:** adding a system means inserting it in
  `run.ts` deliberately and re-verifying determinism tests.
- **`import type` is mandatory** for type-only imports (`verbatimModuleSyntax`).
- **No `Math.random()` in `sim/`** — grep before committing.
- **Content vs. code:** tuning a number goes in `SIM_CONFIG` (and the test
  expectations if it changes behavior), never inline in a system.
- **`??` on typed arrays is defensive only:** prefer explicit bounds checks
  over masking real index bugs with `?? 0` in new code.
- **Repo is not yet `git init`-ed.** CI expects a git repo eventually; until
  then, keep changes reviewable in place.
- **Stray screenshot PNGs** at the repo root are transient verification
  artifacts — don't treat them as part of the product.

## 10. Working agreement for agents

From DEVELOPMENT_PLAN §7 (contract):

- Work in **small, vertically integrated changes**: inspect existing code →
  state the plan → modify the smallest coherent surface → run targeted tests
  plus full gates → report changed files, behavior, tests, risks.
- **Never begin broad work by generating dozens of empty abstractions.** Prefer
  a thin end-to-end slice with real tests; generalize only when a second use
  case demands it.
- Every new system declares its **read/write components and scheduling
  position** in its doc comment.
- Every entity reference is validated; destroyed entities cannot be reused
  silently.
- Never change a balancing constant without placing it in content/config and
  documenting the intended effect.
- Keep commits narrow and conventional: `feat(sim):`, `fix(logistics):`,
  `test(ai):`, `refactor(render):`, `docs:`.

**Definition of done** (all six):

1. Accessible in the running browser build.
2. Has a deterministic test or reproducible scenario covering its primary
   success path.
3. Handles at least one failure/edge path visibly.
4. Inspectable through debug UI/logs if it affects autonomous behavior.
5. Does not regress lint, typecheck, unit, scenario, or browser smoke tests.
6. Documentation updated for public data schemas or architectural changes
   (this file, README, ADR, DEVELOPMENT_PLAN progress notes as appropriate).

## 11. Milestone status and next steps

- **Done:** M0 foundation; M1a survival loop (citizens, needs, A*, task
  market, gather→haul→eat, ownership, inspectors, alerts); **M1b
  construction** — player-placed blueprints (stockpile + hut via the HUD
  build palette), deterministic placement validation (walkable land, no
  overlap, claim radius, per-faction cap), build-task reservation/cooldown,
  and completion-exactly-once with a causal `construction.complete` alert
  (`tests/sim/scenario-construction.test.ts` + e2e). Protocol v2 adds the
  `PlaceBlueprint` command and `commandRejected` events.
- **M2 iteration 1 (materials economy):** harvestable wood/stone nodes spawn
  on forest/hill terrain; stockpiles store all four items (`Stock` map,
  shared capacity); construction sites are funded once from faction
  stockpiles (unfunded sites wait, materials are refunded on build failure);
  a haul task rescues stranded material carries. Protocol v3 adds snapshot
  `stocks` + richer inspect details (`tests/sim/scenario-economy.test.ts` +
  e2e).
- **M2 iteration 2 (work buildings):** the sawpit replaces the command-center
  crafting placeholder — haulers run a `Supply` task to keep its wood buffer
  topped up and to carry crafted planks back to stockpiles; a worker crafts
  one planks batch at a time (2 wood → 1 plank, consumed atomically from the
  sawpit's own buffer); a hut without a sawpit waits instead of stalling
  gathering. `adjacentGoal` now skips tiles inside any building/blueprint
  footprint (a site hugging the sawpit can no longer block its delivery
  tile). `tests/sim/scenario-economy.test.ts` covers the full chain
  wood → supply → planks → hut + e2e.
- **M2 iteration 3 (construction priorities):** blueprints carry a priority
  (1 low / 2 normal / 3 high, default 2) set from the HUD build palette and
  carried in the `PlaceBlueprint` command (protocol v5). Out-of-range
  priorities are rejected deterministically (`bad-priority`). Demand funds
  and builds sites in priority order (highest first, eid tie-break) and the
  build task priority is derived from the blueprint's (`buildTaskPriority ±
buildPriorityStep` per level), so scarce materials and scarce builders
  serve urgent sites first. The blueprint inspector shows the priority.
  (Known scope cut: material gather demand still pulls toward the aggregate
  cost of all unfunded sites; funding order — not gather demand — is what
  favors high-priority sites.) `tests/sim/scenario-priority.test.ts`
  covers funding/completion order,
  task-priority derivation, the default, rejection, and determinism + e2e.
- **Next:** M2 continued — stockpile rules/policy, spoilage, seasons; then
  M3 strategic competition, M4 war and logistics, M5 emergence, M6 beta
  quality (per the plan's roadmap).
