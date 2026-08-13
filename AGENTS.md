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

**Milestone 0 is implemented** (per DEVELOPMENT_PLAN.md §12), the **construction queue** — M1's first real command kind — has landed, and **Milestone 2 (research and shipyards) is complete**:

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
  countdown, world hash, home coordinate (population, storage, net rates,
  warnings), and known planets.
- Construction queue (`StartBuilding` / `CancelConstruction`): costs are
  **reserved (deducted) at submission** under the world lock, so two accepted
  build commands can never overspend the same local store (the M1 acceptance
  test); one order builds at a time per planet, the rest queue FIFO (capacity
  3 from content); orders complete at tick boundaries (economy resolves
  first, so a building completes on tick N and produces from N+1);
  cancellation refunds the reserved cost exactly once, clamped to the storage
  cap, and completed orders can never be cancelled. Every order is an
  immutable receipt keyed by idempotency key — replay returns the original
  receipt without a second deduction. Envelopes gate on the world version
  (`STALE_VERSION`, 409) and the queue enforces max level including pending
  same-kind orders. The planet ledger shows the queue (positions, ticks
  remaining, cancel) plus a building catalog with affordability/max/queue
  states; the overview lists active orders under "Pending next tick" and
  carries a "Recent completions" reports feed (`reports-list`) derived from
  the immutable order history.
- M2 research (`StartResearch` / `CancelResearch`): an account-wide queue (one
  study active, capacity 3 behind it) hosted on whichever owned planet has a
  **Research Lab** (the lab planet funds the study — costs are reserved at
  submission, cancelled orders refund the exact amount). Prerequisites gate
  every study; completed technologies are recorded on the player and their
  additive effects (`extractionBonus`, `storageBonus`, `upkeepReduction`,
  `navigationSpeedBonus`, `scanRangeBonus`, `shipUnlocks`) flow into the
  economy and travel formulas from the next tick (the research.ts domain
  suite covers deduct/queue/FIFO/cancel/prereq/overspend, plus effect
  aggregation and the planet-state-hash movement).
- M2 shipyards (`QueueShip` / `CancelShipOrder`): a per-planet production
  queue fed by the **Shipyard** building. One order builds at a time, FIFO
  (capacity 3); costs are reserved at submission and refunded exactly once on
  cancel. When an order completes at a tick boundary its hulls enter the
  planet's **local fleet** exactly once (idempotent tick replay never
  double-delivers). Ship kinds are data-driven (`SHIP_DEFINITIONS`) and gated
  by research (`requiredTechnology`).
- M2 fleets (`SplitFleet` / `TransferFleet`): every owned home planet spawns
  a local fleet at genesis; fleets stay in orbit (movement is M3). Splitting
  moves ships into a new detached fleet; transfers move ships/cargo between
  co-located fleets, bounded by the target's cargo capacity (sum of its
  ships' capacities). Every op records an immutable receipt keyed by its
  idempotency key. `fleetDriveTier` is the slowest drive aboard (a fighter
  escort drags scouts down to planetary speed), and `travelTicks` =
  ceil(distance / (tier speed × (1 + navigation bonus))) is the M2 travel
  calculation that M3 missions consume.
- M3 fleet movement (`SendFleet` / `RecallFleet` / `LoadCargo` /
  `UnloadCargo`): the mission state machine (transport/scout/colonize/raid)
  now consumes `travelTicks`. A fleet is sent from orbit to any in-world
  coordinate; it stays at its origin while `moving` and snaps to the
  destination on its `arrivalTick` (the movement phase runs after the
  queues, per the DEVELOPMENT_PLAN.md §2 order). Recall turns a moving
  fleet around — the return trip is proportional to outbound progress
  (`p = (tick − departure) / (arrival − departure)`), so an immediate recall
  gets home next tick while a late recall travels most of the way back.
  Arrival resolution is idempotent (a replayed tick never double-docks).
  Cargo ops move resources between an owned planet's store and an orbiting
  fleet's hold: loads are bounded by fleet cargo capacity, unloads clamp at
  the planet's storage cap (the same policy as refunds). Every op records an
  immutable receipt keyed by its idempotency key. The fleets page shows the
  flight state (destination, arrival tick, Recall) and offers a send panel
  with a live, engine-answered route preview (`GET …/fleets/:fleetId/route`)
  so the ETA shown always matches the resolved arrival. The M3 acceptance
  scenario is pinned in the engine suite: a fleet sent before cutoff arrives
  on the calculated tick and cannot be duplicated by retry. Mission _effects_
  (colonization, raids) arrive with M4.
- M3 scans and intelligence (`RunScan`): a player runs a scan from an owned
  planet with a **Scanner Array** (`buildings.scanner`, a content building
  whose reach grows with level and the watch-spire scanRangeBonus research
  line). Scan kinds are gated by the array's level (basic L1, resource L2,
  military L3) and bounded by `scanRange`; targets must be in-world,
  unowned-by-actor, and within reach. Every report is an immutable receipt
  keyed by its idempotency key (replay returns the original report, never a
  second look). **Reveal is strictly kind-bounded and rounded** — the M3
  acceptance test: a basic scan never exposes resources or fleets,
  population rounds to the nearest 100, resource stores to 50, and military
  adds only the fleet picture (count, ship total, hull, slowest drive tier)
  at the target. Intel is timestamped (`submittedTick`), latest-report-per-
  target (stable coordinate order) with a capped newest-first archive in
  `WorldView.intel`; scanned worlds join the galaxy view's `known` set so
  the chart is readable without exposing private state. The scans page
  (`nav-scans`, `scans.html?seed=…`) hosts a source-planet picker, a scan
  form with a live engine-answered reach preview
  (`GET …/scans/preview?source=&to=`), the known-worlds intel list, and the
  report archive.
- **M4 admin dashboard** (`admin.html`, `ADMIN_TOKEN`): the operator console
  manages the game, the database, and the users behind the admin bearer
  token (the same gate as the `/dev/*` routes — the token is never baked
  into the client; the dashboard's gate stores it in `sessionStorage` and
  every admin fetch uses it). **Game:** world list with live ticks and
  aggregate counts, the aggregate peek (players/planets/fleets), the
  operator tick trigger, create/reload-from-seed, and delete (refused with
  409 while accounts live in the world); player dossiers with home-planet
  stores, fleets, research, a **grant-resources** tool (clamped at the
  storage cap, under the world lock) and rename (engine `renamePlayer` +
  account row kept in sync). **Users:** account list with active-session
  counts and last-seen, per-account session management (revoke one or all),
  profile edit, admin password reset (optionally signing every session
  out), and account deletion that optionally removes the commander from the
  world aggregate (`engine.removePlayer` — player, fleets, and ownership in
  one locked transition; the world delete guard and this option keep the
  world consistent). **Database:** read-only introspection — server version,
  database, applied Drizzle migrations, exact per-table row counts and
  sizes (`PostgresDatabaseAdmin`/`InMemoryDatabaseAdmin`), plus the
  immutable resolution history per world. Pure admin transitions live in
  `packages/domain/src/admin.ts` (`grantResourcesToPlanet`,
  `removePlayerFromWorld`) with their own domain suite; the admin surface is
  versioned separately from the player protocol (PROTOCOL_VERSION is
  unchanged).
- Reports: the overview's "Recent completions" feed is derived from the
  immutable order history (completed research, ships, buildings) — newest
  first, capped, never new authoritative state.
- Tests: deterministic world/planet hashes, single-resolver protection,
  idempotent replay, unauthenticated/malformed rejection, construction
  domain suite (deduct/queue/FIFO/cancel/overspend), M2 domain suites
  (research/shipyard/fleet/travel/economy-effects), engine + API command
  tests, browser overview/planet construction boot (Playwright), and the M4
  admin suites (domain transitions, engine admin ops, API routes incl. the
  auth gate, and the e2e operator-console spec).

**Storage is PostgreSQL for M1** (ADR-003): `WorldRepository` is backed by
Drizzle + `pg` (migrations under `packages/db/drizzle`, applied at boot and
via `pnpm db:migrate`). The world is a JSONB aggregate with mirrored scalar
columns; resolutions are immutable rows. Cross-process single-resolver safety
comes from `pg_advisory_xact_lock` inside `withWorldLocked`. Worlds now persist across restarts; `createWorld` re-creates a world whose stored `contentVersion` no longer matches the current content.

**Accounts now use expiring sessions:** account registration/login issue
opaque `sess_…` bearer tokens whose SHA-256 hashes are stored in
`account_sessions`; sessions expire after the configured lifetime
(`SESSION_TTL_MS`, 30 days by default) and can be revoked through logout. Migration `0002_account_sessions` backfills existing
local raw tokens and removes them from `accounts`, while `0003` normalizes
usernames and enforces case-insensitive uniqueness. The account API exposes
`/accounts/me` and `/accounts/logout`; the browser validates persisted sessions
before booting a world view.

## 2. Landing page facts

- The brand mark (`apps/web/public/logo.png`) is the cover and carries the
  wordmark; it must never be recolored, tinted, or distorted, and the name is
  never re-typed beside it (DESIGN.md "The Brand Mark Rule").
- The landing page holds **no simulation state at all**; its "Enter the
  world" action links to `account.html` — the register/login door. The power
  (faction) is **not a choice**: the engine assigns the least-populated
  faction at spawn so the galaxy stays balanced (domain `spawn.ts`,
  `leastPopulatedFaction`). The commander picks only an emblem from the
  shared bank (content `EMBLEMS`); the API spawns the account into the
  least-populated reachable area of the shared world, and the session token
  (`apps/web/src/game/session.ts`) authenticates every game page. Without a
  session the pages fall back to the seeded dev player token so the M0/e2e
  flows keep working.
- `data-testid` hooks for e2e: `landing-title`, `enter-link`,
  `overview-tick`, `next-tick-countdown`, `home-coordinate`, `world-hash`,
  `overview-offline`, `retry-button`, `planet-image`, `planet-coordinate`,
  `planet-population`. The shared header nav (on every game view — overview,
  map, constructions, research, fleets, glossary, planet, and account) uses
  `nav-overview`, `nav-constructions`, `nav-map`, `nav-research`,
  `nav-fleets`, `nav-glossary`, and `nav-account` (the commander's control
  panel); every view also shows the same live header readout (commander
  name, current tick, next-tick countdown —
  `commander-name`, `overview-tick`, `next-tick-countdown`), fed from the
  overview projection (`useWorldMeta`). A signed-in commander's emblem
  (content `FACTION_SYMBOLS`) rides in the header brand lockup.
  Account page hooks: `account-tab-register`, `account-tab-login`,
  `account-symbol-<id>`, `account-username`, `account-password`,
  `account-confirm`, `account-name`, `account-submit`, `account-error`,
  `account-session-name`, `account-sign-out`, and the signed-in control
  panel: `cp-name`, `cp-emblem-<id>`, `cp-profile-save`,
  `cp-profile-notice`, `cp-account-username`, `cp-faction`, `cp-home-planet`,
  `cp-joined`, `cp-current-password`, `cp-new-password`, `cp-confirm-password`,
  `cp-revoke-others`, `cp-password-submit`, `cp-password-notice`, `cp-sessions`,
  `cp-session-<id>`, `cp-session-revoke-<id>`, `cp-revoke-others-btn`, and
  `cp-devices-notice`. The panel writes profile changes through
  `PATCH /accounts/me` (the rename is authoritative: it also mutates the
  player inside the world aggregate under the world lock) and password
  changes through `POST /accounts/me/password`; session revocation uses
  `GET/DELETE /accounts/me/sessions` and `POST /accounts/me/sessions/revoke-others`. Login is
  self-healing: if the account's player was wiped from the world aggregate (a
  world regeneration after a content bump), the login route re-spawns it
  (`engine.ensurePlayer`) with its stored name/faction and refreshes the
  account's `homePlanetId` instead of issuing a session that 404s forever.
- `prefers-reduced-motion` is honored; keyboard focus is visible.
- Surfaces are solid and opaque per the "Flat Ledger Rule" — no translucency
  or backdrop blur on new surfaces.
- The header nav (on every game view) also carries **Research**
  (`research.html?seed=…`) and **Fleets** (`fleets.html?seed=…`) views. The
  research page (`nav-research`, `research-queue`, `research-<technologyId>`
  buttons, `research-notice`, `research-effects`, `host-planet-select`,
  `tech-row-<id>`) shows the account-wide queue, the completed/effects
  summary, and the tree grouped by branch with a lab-host picker (research
  runs on any owned planet with a Research Lab — the host funds the study).
  The fleets page (`nav-fleets`, `fleet-cards`, `fleet-<id>`, `split-<id>`,
  `transfer-from`/`transfer-to`, `transfer-execute`, `fleet-notice`) shows
  the fleet inventory with split controls and a co-located transfer panel.
  M3 adds the flight readout on each card (`travel-<id>` with `recall-<id>`
  for moving fleets), the send panel (`send-toggle-<id>`, `send-panel-<id>`,
  `send-mission-<id>`, `send-preview-<id>`, `send-<id>`), and cargo ops
  (`cargo-toggle-<id>`, `cargo-panel-<id>`, `load-<id>`, `unload-<id>`).
  M3 also adds the **Scans** view (`scans.html?seed=…`, `nav-scans`): a
  source-planet picker (`scan-source-<id>`), the scan form
  (`scan-kind-<id>`, `scan-target`, `scan-preview`, `scan-submit`,
  `scan-notice`), the known-worlds intel list (`intel-<coordinate>`), and
  the report archive (`scan-archive`).
- Each planet in the overview table links to its dedicated ledger page
  (`planet.html?seed=…&planet=…`), which is the **dossier**: a
  **procedurally generated portrait** (ADR-004), the world's fixed facts
  (class, coordinate, faction), the economy readout (per-resource tiles
  `resource-stored-<r>` / `resource-net-<r>`, the production & upkeep fold),
  and the warnings strip. A "Manage construction →" link
  (`planet-construction-link`) hands off to the construction desk, keeping
  the ledger a quick read while the work lives on its own surface.
- The **construction desk** (`constructions.html?seed=…&planet=…`,
  `nav-constructions`) owns the **Buildings** and **Shipyard** panels. A
  world picker (`constructions-planets`, `pick-planet-<id>` pills that
  report each world's active order count) selects the world being worked;
  below it sit the raised-buildings list, the construction queue
  (`construction-queue` with `cancel-<orderId>`), the "Raise a building"
  catalog (`building-catalog`, `build-<kind>`), and — where a Shipyard
  stands — the yard queue and ship catalog (`shipyard-queue`,
  `build-ship-<kind>`, `ship-row-<kind>`, `shipyard-notice`; a world without
  a Shipyard shows `shipyard-absent`).

  Construction hooks: `construction-queue`,
  `construction-notice`, `cancel-<orderId>`, `build-<kind>`,
  `building-level-<kind>`, and `pending-orders` on
  the overview. The catalog and the owned-buildings list are grouped by the
  category each building declares in content (hooks
  `catalog-group-<category>` / `catalog-group-toggle-<category>`; the toggle
  collapses the group and reports how many of its buildings are affordable).
  New buildings need only a `category` field in content to slot into the UI.
  Unaffordable catalog rows offer a "How to afford" plan
  (`plan-toggle-<kind>` opens `plan-<kind>`) computed by the pure
  `planBuildOrder` planner in `packages/domain/src/build-plan.ts` — it
  chains the producer buildings that generate the missing resources,
  simulates the store with the engine's exact formulas (including
  energy brownout), and reports a tick estimate. The planner is
  **cancel-aware**: when a deficit resource has no income (the classic
  soft-lock — everything costs metal, only the Metal Mine produces it, and
  the store is below its cost), it refunds pending construction orders
  (full refund, cap-clamped, cheapest first — exactly like the engine's
  cancellation), raises the keystone producer, and rebuilds what it
  cancelled, so a player is never told "wait for income" when no income
  exists. True dead ends report honest numbers (stored, income, refundable,
  producer cost) instead of "raise it elsewhere". The portrait is rendered
  server-side by the API — never in the browser, never a hand-drawn asset.

- The portrait endpoint requires the bearer token, so the web client fetches
  the PNG and shows it via an object URL (`fetchPlanetImage`); an `<img src>`
  cannot attach the Authorization header.

## 3. Commands and quality gates

```bash
pnpm install                 # workspace install (pnpm 9)
./scripts/dev.sh             # clean dev stack: PostgreSQL + migrations + API (:3001) + Vite (:5173)
./scripts/dev.sh --clean     # wipe the local database volume first (fresh world, no accounts)
./scripts/dev.sh --stop      # stop the stack (servers + postgres container)
pnpm db:migrate              # apply pending Drizzle migrations (also runs at API boot)
pnpm dev                     # raw dev command; prefer scripts/dev.sh — see the PORT trap below
pnpm run build               # typecheck + production build → apps/web/dist
pnpm run preview             # serve the built web app

pnpm run typecheck           # tsc strict, every package + root configs
pnpm run lint                # eslint . (flat config)
pnpm run format              # prettier --write .
pnpm run format:check        # prettier --check .
pnpm run test                # vitest run (domain determinism, engine, API)
pnpm run test:e2e            # Playwright (webServer auto-starts API + web)
```

**Use `./scripts/dev.sh`, not bare `pnpm dev`:** shells launched by the Freebuff
app export `PORT=<harness port>`; the API inherits it, dies with `EADDRINUSE`,
and Vite is left answering every `/api` poll with a proxy 500. The script
unsets `PORT`, pins the canonical ports, clears stale servers, starts
PostgreSQL, and waits for it before booting.

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
- **The e2e API runs on :3101, not :3001.** Playwright's API webServer is
  deliberately isolated from the dev port so a running `pnpm dev` API can
  never be reused (it would have the wrong env — 30-minute tick instead of
  `TICK_DURATION_MS=2000` — and time out the boot test) or killed by e2e
  teardown. If an e2e run misbehaves locally, check `ss -tlnp | grep :3101`
  for strays from an interrupted run. CI is unaffected (fresh runner).
- **`exactOptionalPropertyTypes`:** never pass `undefined` explicitly to an
  optional property; spread conditionally (`...(x === undefined ? {} : { x })`).
- **`import type` is mandatory** for type-only imports (`verbatimModuleSyntax`).
- **Content vs. code:** tuning a number goes in `packages/content`, never inline.
- **Planet art is presentation-only.** The renderer
  (`packages/domain/src/planet-art.ts`) derives everything from the planet id
  and abundance — never seed it from wall clock, `Math.random`, or renderer
  state, or the byte-identical determinism test breaks. Palette/cloud/
  lighting tuning lives in `packages/content/src/planet-art.ts`; bump
  `ART_VERSION` there to re-render cached images, **never** `CONTENT_VERSION`
  (art must not invalidate sim worlds or resolutions).
- **PostgreSQL must be running for dev and e2e:** the API and worker boot
  requires a reachable `DATABASE_URL` (default
  `postgres://ashes:ashes@localhost:5432/ashes`, matches `docker-compose.yml`)
  and apply migrations on boot. `pnpm db:up` starts it. The API fails fast
  with a clear message otherwise.
- **Postgres integration tests are opt-in:** `packages/db/src/postgres.test.ts`
  runs only when `TEST_DATABASE_URL` (or `DATABASE_URL`) is set — CI always
  sets it via the postgres service; locally export it after `pnpm db:up`.
  Tests use distinct seeds and clean up, so they are safe beside the dev
  world.
- **Worlds persist now:** the seeded world survives restarts; `createWorld`
  re-creates a world whose stored `contentVersion` is stale. A world stored
  under old content is never silently mixed with new content.
- **Hot-reload can corrupt the dev world mid-refactor:** `tsx watch` restarts
  the API on every file save, so a session that saves a content/version bump
  before the matching state-shape change boots mixed code and writes a world
  whose JSONB state no longer matches its content version. `createWorld`
  then treats it as current and every projection 500s (`Cannot read
properties of undefined`). Recover by deleting the world row
  (`DELETE FROM worlds WHERE id = 'world:<seed>';`), then restarting the API
  so the seed re-derives it. Deployments are unaffected (all packages move
  atomically); this is dev-tooling collateral only.
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

Milestones 0–6 are defined in `DEVELOPMENT_PLAN.md` §10. Milestones 1 and 2
are complete: the economy core (resources, buildings, production/upkeep,
storage, population), PostgreSQL persistence, the construction queue
(StartBuilding/CancelConstruction, receipts, pending state, tick completion,
cancellation refunds), research (StartResearch/CancelResearch, the account-
wide queue, the technology tree), shipyards (QueueShip/CancelShipOrder, the
ship catalog), and fleets (SplitFleet/TransferFleet, the fleet inventory,
the travel calculation) have all landed. **Milestone 3 is complete**: fleet
movement (the transport/scout/colonize/raid mission state machine consuming
`travelTicks`, SendFleet/RecallFleet/LoadCargo/UnloadCargo, arrival tick
resolution, and the fleets-page send/recall/cargo UI) plus scans and
intelligence (RunScan, the Scanner Array, kind-bounded rounded reveals,
time-stamped reports, `WorldView.intel`, and the scans page). The **admin
dashboard** has landed as the operator surface (game/database/user management
behind `ADMIN_TOKEN`). The next slice is **Milestone 4**: mission _effects_ —
colonization and raids that consume fleets and produce outcomes from the
missions M3 already carries. Do not
start a slice without explicit direction.
