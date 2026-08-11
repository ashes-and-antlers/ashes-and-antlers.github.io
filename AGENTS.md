# AGENTS.md — Ashes and Antlers (Tick-Based Galaxy Strategy)

Guidance for AI coding agents and human contributors working in this repository.
Read this before editing anything.

**If you only read two documents, read:** this file and
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) (the full design, which is the
source of truth for what the game will become).

---

## 1. Current state (2026-08-11)

**The game direction changed at the 2026-08-11 reset: the player-facing
browser sim was scrapped and replaced by a server-authoritative, tick-based
galaxy strategy.** This AGENTS.md, `PRODUCT.md`, and `README.md` were updated
to match; `docs/ADR-001` (determinism contract) and `docs/ADR-002` (M0 tick
engine) record the architecture decisions. The old browser-sim code is
recoverable from git history (committed at `86e838f` and earlier) as a
reference only — do not treat it as authoritative.

**Milestone 0 is implemented** (per DEVELOPMENT_PLAN.md §12):

- `pnpm` workspace with `web`, `api`, and `worker` apps plus `contracts`,
  `domain`, `content`, and `db` packages.
- Deterministic worldgen: finite `galaxy:sector:system:planet` space from a
  seed (FNV-1a + mulberry32 named PRNG streams), one seeded player with one
  home planet, `worldHash` + `planetStateHash` content hashes.
- `TickEngine` (packages/db): per-world lock, idempotent replay of resolved
  ticks, immutable `TickResolution` records, `TickScheduler` loop.
- Hono API with an M0 dev-identity bearer-token baseline (every route
  authenticated), overview/planets/commands endpoints, and dev world creation
  - tick trigger. Commands validate the envelope strictly and reject all
    kinds (no command kinds exist yet).
- `game.html?seed=1337` boot: the command overview shows tick, next-tick
  countdown, world hash, home coordinate, and known planets.
- Tests: deterministic world/planet hashes, single-resolver protection,
  idempotent replay, unauthenticated/malformed rejection, and browser
  overview boot (Playwright).

**Storage is in-memory for M0** (ADR-002): `WorldRepository` is the seam
where PostgreSQL lands in M1; there are no SQL migrations yet. Worlds do not
survive a restart.

## 2. Landing page facts

- The brand mark (`apps/web/public/logo.png`) is the cover and carries the
  wordmark; it must never be recolored, tinted, or distorted, and the name is
  never re-typed beside it (DESIGN.md "The Brand Mark Rule").
- The landing page holds **no simulation state at all**; its "Enter the
  world" action links to `game.html?seed=1337`, which boots the M0 overview.
- `data-testid` hooks for e2e: `landing-title`, `enter-link`,
  `overview-tick`, `next-tick-countdown`, `home-coordinate`, `world-hash`,
  `overview-offline`, `retry-button`.
- `prefers-reduced-motion` is honored; keyboard focus is visible.
- Surfaces are solid and opaque per the "Flat Ledger Rule" — no translucency
  or backdrop blur on new surfaces.

## 3. Commands and quality gates

```bash
pnpm install                 # workspace install (pnpm 9)
pnpm dev                     # API (:3001) + web dev server (:5173, /api proxied)
pnpm dev:worker              # standalone tick worker
pnpm run build               # typecheck + production build → apps/web/dist
pnpm run preview             # serve the built web app

pnpm run typecheck           # tsc strict, every package + root configs
pnpm run lint                # eslint . (flat config)
pnpm run format              # prettier --write .
pnpm run format:check        # prettier --check .
pnpm run test                # vitest run (domain determinism, engine, API)
pnpm run test:e2e            # Playwright (webServer auto-starts API + web)
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → format:check → test →
build → `pnpm exec playwright install --with-deps chromium` → e2e on every
push/PR. Anything that passes locally must pass that pipeline.

## 4. Engineering constraints (the rebuild contract)

From `DEVELOPMENT_PLAN.md` §9 and `docs/ADR-002`:

1. **The tick engine owns all authoritative simulation state.** The API and
   web client only read projections (`WorldView`) and submit validated
   commands; they never import sim internals and mutate state.
2. **No `Math.random()` anywhere in `domain/` or the engine.** All randomness
   flows through seeded PRNG streams (mulberry32 + FNV-1a, named streams per
   concern) in `packages/domain/src/prng.ts`.
3. **Fixed global ticks.** Worlds carry `tickDurationMs` (30 min in content;
   dev/e2e override via `TICK_DURATION_MS`). Systems never read wall-clock
   time into sim logic; `resolvedAt` is record metadata, not a sim input.
4. **Stable iteration order.** Worldgen and hashing iterate coordinates in
   strict ascending order; ties break on explicit stable keys.
5. **Content is data-driven.** Balance and world parameters live in
   `packages/content`; never hard-code tunable numbers in systems.
6. **Version everything.** `WORLD_VERSION` (worldgen), `CONTENT_VERSION`
   (content), and `PROTOCOL_VERSION` (API) gate every handshake; mismatch is
   a hard error. Versions are part of every world and resolution.
7. **Idempotency + locking.** Every tick resolution is idempotent (replay
   returns the stored record) and single-resolver protected (per-world lock,
   double-check under the lock). Every accepted command will carry an
   idempotency key, expected version, actor, and timestamp.
8. **Renderer/UI state is derived.** The web client never stores
   authoritative sim data; it rebuilds its view from each `WorldView`.

## 5. Common pitfalls (learned the hard way)

- **Cold-boot e2e flake:** the overview test starts the API webServer first
  and polls for tick advancement; don't assert a specific tick value — assert
  it is a number and eventually changes.
- **Orphaned local API breaks e2e:** a leftover API process on :3001 (from a
  previous `pnpm dev` or an interrupted `test:e2e`) gets silently reused by
  Playwright (`reuseExistingServer`), but with the **stale env** — e.g. the
  30-minute default tick instead of the e2e `TICK_DURATION_MS=2000`, so the
  boot test times out on tick advance. Before local e2e runs, check
  `ss -tlnp | grep :3001` and kill strays. CI is unaffected (fresh runner).
- **`exactOptionalPropertyTypes`:** never pass `undefined` explicitly to an
  optional property; spread conditionally (`...(x === undefined ? {} : { x })`).
- **`import type` is mandatory** for type-only imports (`verbatimModuleSyntax`).
- **Content vs. code:** tuning a number goes in `packages/content`, never inline.
- **M0 has no persistence:** restarting the API loses worlds; the overview
  depends on the seeded world (`WORLD_SEED`, default 1337) being created at
  boot.
- **The deployed Pages build is static:** with no hosted backend, the
  overview shows the offline card after 3 failed polls and **stops polling**
  (no request spam); the retry button re-attempts. Do not treat the offline
  card on the live site as a client bug — the engine is a local process in
  M0 (see README "Deployed site note").

## 6. Working agreement for agents

- Work in **small, vertically integrated changes**: inspect existing code →
  state the plan → modify the smallest coherent surface → run targeted tests
  plus full gates → report changed files, behavior, tests, risks.
- Never begin broad work by generating dozens of empty abstractions; prefer a
  thin end-to-end slice with real tests, then generalize on second use.
- Keep commits narrow and conventional: `feat(tick):`, `fix(logistics):`,
  `test(world):`, `refactor(render):`, `docs:`.

**Definition of done** (all six): accessible in the running browser build;
has a deterministic test or reproducible scenario for its primary success
path; handles at least one failure/edge path visibly; is inspectable through
debug UI/logs if it affects autonomous behavior; does not regress lint,
typecheck, unit, scenario, or browser smoke tests; documentation updated for
public data schemas or architectural changes.

## 7. Next steps

Milestones 0–6 are defined in `DEVELOPMENT_PLAN.md` §10. Milestone 1
(economy and buildings) is next: metal/mineral/food/energy, buildings,
storage, upkeep, one construction queue, and the first real command kinds —
with PostgreSQL landing behind the `WorldRepository` seam (ADR-002). Do not
start a milestone without explicit direction on its first slice.
