# Ashes and Antlers

A single-player, browser-native 2D grand colony/RTS in which **two autonomous
civilizations** inhabit the same procedurally generated world, compete for
finite resources, adapt to pressure, wage logistics-driven war, and ultimately
achieve dominance. Working title only — the full design lives in
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md).

> **Current milestone: 1a — Vertical slice, survival loop.** On top of the M0
> foundation (seeded deterministic worldgen in a Web Worker, fixed-tick clock,
> snapshot protocol, PixiJS tile renderer, lint/typecheck/test/build/CI),
> Milestone 1a adds the bitECS entity layer: two faction command centers with
> ownership overlays, citizens with movement/hunger/energy/morale, a
> deterministic task market (gather → haul → eat), stockpiles, resource nodes,
> inspectors, and causal alerts; Milestone 1b adds player-placed blueprints
> and builder construction (stockpile + hut, completion-exactly-once).

## Quickstart

```bash
npm install
npm run dev            # dev server (Vite)
npm run build          # typecheck + production build to dist/
npm run preview        # serve the production build
```

Open the dev server URL — the landing page presents the game: the brand mark
centered as the cover, the premise, and a single Enter the world action
beneath the mark (it enters the default seed `1337`). You can also jump
straight into the game at `/game.html`; append `?seed=12345` to enter a
specific world (default seed `1337`).

### Controls

| Action            | Input                                    |
| ----------------- | ---------------------------------------- |
| Pan               | drag                                     |
| Zoom              | mouse wheel                              |
| Pause / resume    | `Space` or the ⏸ button                  |
| Speed             | `1` `2` `4` `8` or the buttons           |
| Debug grid        | `G` or the grid button                   |
| Ownership overlay | `O` or the ownership button              |
| Inspect           | click a tile, citizen, building, or node |

## Quality gates

```bash
npm run lint          # ESLint (typescript-eslint, flat config)
npm run typecheck     # tsc strict for src/tests and config files
npm run format:check  # Prettier
npm run test          # Vitest: unit + deterministic simulation tests
npm run build         # typecheck + production build
npm run test:e2e      # Playwright smoke tests (requires `npm run build` first)
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR,
including `npx playwright install --with-deps chromium`.

## Architecture

```
src/
  app/            landing page (landing.ts, landing.css) + game boot (main.ts, style.css)
  shared/         protocol types, constants, branded IDs, hashing, labels
  sim/
    core/         PRNG, fixed-tick clock, calendar, terrain hash, Simulation
    data/         content definitions (kinds, factions) + balance config
    ecs/          bitECS components, world, entity factories
    path/         deterministic A* pathfinding
    systems/      needs, tasks (market), movement, resources, ownership, alerts
    world/        tile definitions, TileWorld (typed-array stores), generation
    inspect.ts    worker-side inspector detail builder
  worker/         simulation worker: owns the sim, publishes snapshots
  render/         PixiJS renderer: tiles, entities, ownership overlay, camera
  ui/             lightweight DOM HUD (speed, readouts, alerts, inspector)
tests/
  unit/           PRNG, clock, worldgen, astar, needs, ownership
  sim/            determinism, calendar, M1 3-day survival scenario
  e2e/            Playwright smoke: boot, hash, pause/speed, toggles, inspector
docs/
  ADR-001-worker-ownership-and-determinism.md
```

Key invariants (see the ADR):

- The worker owns **all** authoritative state; the main thread only reads
  snapshots and sends validated commands.
- No `Math.random()` anywhere in `sim/`; all randomness flows through named
  PRNG streams seeded from the world seed.
- Same seed + same generator version ⇒ same terrain hash (tested).
- The clock only advances in fixed 5/s ticks; pause discards time, speed is a
  pure multiplier, catch-up is capped per frame.
- Entity iteration is always ascending-eid (`sortedQuery`); bitECS frees and
  reuses entity ids, so `MAX_ENTITIES` bounds concurrent entities.
- Citizen spawn tiles are clamped to walkable, non-building tiles by a
  deterministic scan; no `Math.random()` anywhere in `sim/`.

## Milestone acceptance

**Milestone 0 (Foundation)**

- [x] `npm run build`, `lint`, `test` pass from a clean checkout
- [x] Same seed renders the same terrain hash in two runs (unit + e2e)
- [x] Simulation advances only in fixed ticks and obeys pause/speed (unit + e2e)

**Milestone 1a (Survival loop)**

- [x] 3-day `vertical-slice-01`-style scenario: both factions gather → haul →
      eat and survive with no player commands (deterministic, seeded)
- [x] Deterministic A* with movement costs (unit tests incl. wall detours)
- [x] Task market with demand/claim/execute phases and reservation cleanup
- [x] Hunger/energy/morale needs; starvation is rate-limited-alerted, never
      silent (food-shortage alert fires first)
- [x] Ownership overlay toggles; inspectors for citizen/building/node/tile
- [x] Alerts reach the HUD banner; e2e covers toggles + inspector
- [x] Player-placed blueprints (stockpile + hut) with a HUD build palette;
      deterministic placement validation; builders reserve, construct, and
      complete each site exactly once

## Roadmap

Milestone 2 begins economy and settlement: recipes, work buildings,
wood/stone/planks, construction priorities, stockpile rules, seasons — per
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) §6.
