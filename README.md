# Ashes and Antlers

A server-authoritative, tick-based galaxy strategy game (working title only).
The player governs a small interstellar civilization: developing planets,
researching technology, building fleets, and fighting scheduled wars on a
global tick rhythm. The full design lives in
[`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) — read it before touching
anything; it is the source of truth.

> **Current state (2026-08-11): Milestone 1.** The landing page ships, and
> the rebuilt game is in: a deterministic server-side tick engine with the
> **economy core** (M1 slice 1) — resources, buildings, production/upkeep,
> storage, and population — persisted in **PostgreSQL** (`docs/ADR-003`;
> Redis remains future work). `game.html?seed=1337` boots the command
> overview: the authoritative tick, live countdown, world hash, home planet
> with population/storage/net rates, and warning chips.
>
> **Deployed site note:** the GitHub Pages build is static and hosts no
> backend, so the deployed overview shows the **Archive offline** card and
> stops polling once the engine is unreachable. During development the engine
> runs locally (`pnpm dev`); a hosted API lands in M1 behind the
> `WorldRepository` seam.

## Workspace

```
apps/
  web/        Vite + React client: landing page + game.html command overview
  api/        Hono API: dev identity auth, overview/planets/commands,
              dev world creation + tick trigger (owns the M0 engine)
  worker/     Standalone tick worker: engine + scheduler loop
packages/
  contracts/  Zod schemas, branded IDs, protocol/world types, PROTOCOL_VERSION
  content/    Data-driven content: world config, factions, starting package,
              CONTENT_VERSION / WORLD_VERSION
  domain/     Pure deterministic core: seeded PRNG, worldgen, hashes, tick resolution
  db/         Storage boundary: WorldRepository (PostgreSQL via Drizzle for M1,
              in-memory for tests), WorldLock, TickEngine, TickScheduler
docs/         ADR-001 (determinism contract, superseded framing) + ADR-002 (M0 engine)
```

## Quickstart

```bash
pnpm install            # workspace install (pnpm 9; corepack ships with Node 22)
pnpm db:up              # start PostgreSQL (docker compose; see DATABASE_URL)
pnpm db:migrate         # apply pending Drizzle migrations (also runs at boot)
pnpm dev                # API on :3001 + web dev server on :5173
pnpm dev:worker         # optional: standalone tick worker process
```

The API requires PostgreSQL (`DATABASE_URL`, defaulting to
`postgres://ashes:ashes@localhost:5432/ashes` per `docker-compose.yml`). It
applies migrations at boot, seeds the world, and resolves ticks on schedule.

Open the web dev server: the landing page is at `/`, and
`/game.html?seed=1337` is the command overview. The dev server proxies `/api`
to the API.

## Quality gates

```bash
pnpm run lint           # ESLint (flat config, all packages)
pnpm run typecheck      # tsc strict for every package + root configs
pnpm run format:check   # Prettier
pnpm run test           # Vitest: economy formulas, determinism, engine lock + replay,
                        # API; Postgres integration tests when TEST_DATABASE_URL is set
pnpm run build          # typecheck + production build (web → apps/web/dist)
pnpm run test:e2e       # Playwright: landing + command overview boot (auto-starts API + web)
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR,
including `pnpm exec playwright install --with-deps chromium`.

## M1 acceptance coverage

- **Deterministic world hash** — same seed + content → identical `worldHash`
  and identical `planetStateHash` after a test tick (`packages/domain` tests).
- **Single-resolver protection** — a duplicate tick job for the same
  world/tick runs one resolver body; concurrent calls return the stored
  resolution (`packages/db` engine tests).
- **Seed correctness** — worldgen produces the finite `galaxy:sector:system:
planet` space, one seeded player, one owned home planet
  (`packages/domain` tests; no SQL migrations in M0 — see ADR-002).
- **Unauthenticated/malformed rejection** — every API route requires a bearer
  token; malformed command envelopes → 400, unknown kinds → 400
  (`apps/api` tests).
- **Overview boot** — the command overview renders tick, countdown, world
  hash, home coordinate, and shows the tick advancing live (`tests/e2e`).
- **Economy formula contract** — a known planet over a tick sequence matches
  hand-computed abundance/building/upkeep totals exactly; storage clamping,
  energy brownout, and food starvation are each tested
  (`packages/domain`).
- **Postgres persistence + cross-process single-resolver** — worlds and
  resolutions survive repository restarts; two engines on separate
  connections cannot double-resolve a tick (advisory lock)
  (`packages/db`, needs `TEST_DATABASE_URL`).

## Roadmap

Milestones 0–6 are defined in [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)
§10. Next up within Milestone 1: the construction queue (StartBuilding
command, receipts, pending state, tick completion, cancellation).
