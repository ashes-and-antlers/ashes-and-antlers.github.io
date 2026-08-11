# Product

<!-- impeccable:product-schema 1 -->

> **Direction change (2026-08-11):** the game was scrapped and restarted as a
> **server-authoritative, tick-based galaxy strategy** (planet-and-fleet, global
> ticks, alliances, scheduled wars). [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)
> is the authoritative design; the sections below that describe the older
> browser-native 2D colony sim are historical and superseded. The brand
> commitments and the determinism contract carry forward.

## Platform

web

## Users

A single-player strategy player acting as a distant planner-advisor — not a
unit micromanager. They observe a living world through layered reports and
alerts, set civilization-level policies (priorities, blueprints, military
doctrine), and then watch autonomous citizens make bounded local decisions.
The product is aimed at public release once complete; it is a browser-based
simulation game, so the user plays in a desktop browser, at their own pace,
with pause and 1×–8× time control.

## Product Purpose

A browser-native 2D grand colony/RTS in which two autonomous civilizations
inhabit the same procedurally generated world, compete for finite resources,
adapt to pressure, wage logistics-driven war, and ultimately achieve
dominance. Success means the simulation is deep enough to produce emergent,
causal stories (a settlement overextends mining and collapses before winter;
a weak society survives through logistics and strategy) and readable enough
that the player can always answer "what changed, why, and what can I do?"
The player's civilization runs on the same rules as the enemy's.

## Positioning

One deterministic simulation shared by two autonomous civilizations. Same
seed + config + version + ordered player commands = the same result, every
time — reproducible, testable, and free of invisible outcomes. Every visible
outcome has a causal chain in simulation state; the player plans, citizens
decide, and logistics decides wars. This causal-deterministic core is the
mechanism a neighboring game could not truthfully copy.

## Operating Context

- Runs entirely in the browser (no backend); the authoritative simulation
  lives in a Web Worker and the main thread only renders snapshots and sends
  validated commands.
- Fixed-tick clock at 5 ticks/second; time advances only in whole ticks;
  pause discards time and speed (1×, 2×, 4×, 8×) is a pure multiplier.
- Calendar: 120-day years, 4 seasons of 30 days; a day is 300 ticks (60 s at
  1×). World: 160×160 tiles (MVP), rendered at 16/24 px tiles; simulation
  never depends on pixels.
- Seeded worlds: `?seed=12345` in the URL varies the world; the default seed
  keeps e2e deterministic.
- Quality gates are contract: lint, strict typecheck, Prettier, deterministic
  unit + scenario tests, production build, and Playwright e2e run in CI.

## Capabilities and Constraints

### Confirmed capability (current build)

- **Landing page + Milestone 0 tick engine.** The landing page ships as the
  public entry (brand mark cover, the two peoples, the rules of the archive,
  single Enter the world action → `game.html?seed=1337`). Behind it, the
  M0 server-authoritative tick engine is implemented and tested: seeded
  deterministic worldgen over a finite `galaxy:sector:system:planet` space,
  a per-world-locked, idempotent tick resolver, a dev-identity auth
  baseline, strict command-envelope validation (no command kinds yet), and a
  command-overview web page showing the authoritative tick, next-tick
  countdown, world hash, and home planet. Storage is in-memory for M0
  (`docs/ADR-002`); PostgreSQL/Redis arrive in M1.
- The scrapped 2D sim implementation is recoverable from git history
  (committed at `86e838f` and earlier) as a reference only.

### Designed but not yet implemented

- The full roadmap (milestones 0–6) as planned in DEVELOPMENT_PLAN.md §6,
  rebuilt from a fresh start. The 2026-08-11 direction change centers the
  game on strategic competition and war: dominance scoring, victory
  conditions, and the hierarchical enemy AI.
- Two asymmetric factions: Hearth Confederacy (settled builders, strong
  institutions) and Iron Swarm (mobile, caste-based expansionists); asymmetry
  via policies, tech, templates, and starting conditions — not forked
  simulation rules.
- Scored dominance model with decisive, territorial, hegemonic, and sandbox
  victory conditions.
- Environmental feedback loops (forest harvest, soil fertility, fire,
  contamination) and deeper strategic-evaluation systems.

### Technical constraints (contract)

- The Web Worker owns all authoritative simulation state; the main thread
  never mutates sim objects.
- No `Math.random()` in `sim/`; all randomness flows through named seeded
  PRNG streams.
- Fixed ticks only; systems never read wall-clock time.
- Stable iteration order (ascending entity id) in authoritative systems.
- Balance and content are data-driven; tunable numbers never live inline in
  systems.
- `WORLD_VERSION` / `PROTOCOL_VERSION` gate every handshake; hard error on
  mismatch.
- Every new authoritative system needs a deterministic test for its primary
  success path and at least one failure/edge path.

### Explicit v1 non-goals

Multiplayer, mod marketplace, mobile support, procedural 3D, real-time
networking, voice acting, a campaign story, realistic individual psychology
for thousands of citizens, full terrain deformation / fluid simulation /
physically accurate combat, and perfect historical realism — this is a
systems-first fictional world.

### Explicitly undecided

- The final title (see Brand Commitments).
- The shape of the rebuild beyond the roadmap in DEVELOPMENT_PLAN.md.

## Brand Commitments

- The name **"Ashes and Antlers"** (and the plan's alternate "Civilizations
  at War") is a **working title only** — explicitly a placeholder, not a
  binding design constraint. Future naming decisions stay open.
- The **brand mark** is `public/logo.png` (deep forest field, bone/cream
  content, burnt-orange accents). It is the palette's source of truth: the
  landing field, text, and accent are derived from it, and it must never be
  recolored or distorted. The favicon is a square crop of it.
- No other brand, voice, or identity commitments have been made; the product
  has no published marketing presence.

## Evidence on Hand

- `DEVELOPMENT_PLAN.md` — the full design: brief, game shape, simulation
  design, milestones, test and balance strategy.
- `AGENTS.md` — the architecture contract and current repo state.
- `docs/ADR-001-worker-ownership-and-determinism.md` — the worker-ownership
  and determinism contract for the rebuild.
- `tests/e2e/landing.spec.ts` — the surviving Playwright smoke test for the
  landing page.
- Absences future work must not fabricate: no testimonials, no press, no
  published player research, no monetization decisions.

## Product Principles

1. **Simulation first.** Every visible outcome has a causal chain in
   simulation state; no fake event outcomes.
2. **Determinism is contract.** Same seed + config + version + ordered
   commands reproduces the same result; reproducibility is tested, not
   hoped for.
3. **The player plans; citizens decide.** Local intelligence and bounded
   decisions at the individual level, strategic direction at the
   civilization level; the enemy runs under the same rules.
4. **Readable complexity.** Anything that affects autonomous behavior must
   be inspectable through layered UI, overlays, inspectors, and causal
   alerts — never silent.
5. **Depth by composition.** Add interacting rules and constraints rather
   than more isolated resource bars; logistics and supply decide wars.
