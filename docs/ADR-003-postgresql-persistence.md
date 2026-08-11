# ADR-003 — PostgreSQL Persistence for the Tick Engine

Status: accepted (M1, 2026-08-11)

## Context

ADR-002 shipped Milestone 0 on an in-memory `WorldRepository` and scheduled
PostgreSQL behind that seam for M1. Milestone 1 begins with the economy
(resources, buildings, production/upkeep) and the user directed that the data
stack move to Postgres **now**, so the economy persists across restarts and
multiple processes can coordinate through one store.

## Decision

**PostgreSQL backs the authoritative world store from M1 onward.**

- **Stack:** Drizzle ORM + `pg` (node-postgres), with `drizzle-kit`-generated
  migrations committed under `packages/db/drizzle` and applied at API/worker
  boot (`runMigrations`) and via `pnpm db:migrate`. This follows the plan's
  "Kysely or Drizzle with explicit transactions" guidance.
- **Schema:** a `worlds` table holding the authoritative `WorldState`
  aggregate as a JSONB `state` column with mirrored scalar columns (tick,
  nextTickAt, contentVersion, ...) for scheduler due-checks and tooling, plus
  an immutable `tick_resolutions` table keyed by `(world_id, tick)` with a
  cascade delete. Resolution rows are never mutated or replaced.
- **Interface:** `WorldRepository` is now fully async. The engine performs its
  read → idempotency-check → resolve → save inside a new
  `withWorldLocked(worldId, fn)` primitive:
  - Postgres: a transaction that first takes `pg_advisory_xact_lock(worldId)`,
    then runs `fn` against a transaction-scoped repository view, then commits.
    This serializes resolvers across **all** processes sharing the database
    (API + worker), satisfying the plan's "one active tick resolver per
    world" requirement.
  - In-memory (tests): passthrough; the engine's in-process `WorldLock`
    already serializes.
- **Concurrency:** the composite primary key on `tick_resolutions` makes a
  duplicate resolution impossible at the storage layer, and the advisory lock
  prevents two resolvers from racing the same tick. Concurrent resolvers for
  the same world/tick all observe the same stored resolution (idempotent
  replay inside the lock scope).
- **World lifecycle:** `createWorld` is idempotent per seed **and** per
  content version. A world stored under a previous `CONTENT_VERSION` is
  deleted and regenerated at the next create (deterministic seeds make this
  safe); versioning never silently diverges.
- **Deviations from the plan:** `population` is a plain `number`, not
  `bigint`, because the aggregate must survive JSON serialization into
  Postgres (and no population value approaches 2^53). Redis/durable job
  scheduling remain future work; the interval scheduler persists across
  restarts via the database now.

## Consequences

- Worlds and tick history survive restarts; the API/worker can run
  concurrently against the same store.
- Local dev requires Postgres: `docker compose up -d` (or any Postgres at
  `DATABASE_URL`). The API fails fast with a clear message if the database is
  unreachable.
- Integration tests run only when `TEST_DATABASE_URL` (or `DATABASE_URL`) is
  set — CI provides a Postgres service; locally, `docker compose up -d`
  suffices. Tests use distinct world seeds and clean up after themselves, so
  they are safe against a database that also hosts the dev world.
- The economy (M1) formulas live in `packages/content` and are exercised by
  deterministic unit tests; Postgres is only storage, never logic.
