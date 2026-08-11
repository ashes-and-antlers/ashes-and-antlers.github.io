# ADR-002: Server-authoritative tick engine (M0) with in-memory storage

**Status:** Accepted (Milestone 0)

**Date:** 2026-08-11

**Supersedes:** ADR-001's browser-ownership framing for the rebuilt direction.
The current DEVELOPMENT_PLAN.md (rewritten at the 2026-08-11 reset) is a
server-authoritative, tick-based galaxy strategy; the browser no longer owns
the simulation. ADR-001's _determinism contract_ (seeded PRNG streams, stable
iteration order, content versioning, hash-based acceptance tests) carries
forward unchanged.

## Context

The rebuilt game (DEVELOPMENT_PLAN.md §9) is a server-authoritative tick
engine: the browser is a typed command client and read-model viewer and never
calculates authoritative outcomes. The plan calls for PostgreSQL + Redis from
Milestone 0. However, at M0 the team chose to **defer real infrastructure**
and prove the engine, protocol, and acceptance tests on an in-memory stack
first, keeping the storage boundary explicit so Postgres/Redis slot in
without rewriting the engine.

## Decision

### 1. The tick engine owns all authoritative state

- `packages/domain` contains pure, deterministic functions: seeded PRNG
  (FNV-1a + mulberry32, named streams), worldgen, world/planet-state hashes,
  and the M0 empty tick resolution. No I/O, no wall clock in sim logic.
- `packages/db` contains the `TickEngine`, a `WorldRepository` interface with
  an `InMemoryWorldRepository`, a per-world `WorldLock`, and the
  `TickScheduler`.
- The API (`apps/api`) and worker (`apps/worker`) both drive the engine; they
  never compute outcomes themselves.

### 2. Determinism is the same contract as before

- `WORLD_VERSION` (worldgen semantics) and `CONTENT_VERSION` (balance
  content) are part of every world; `PROTOCOL_VERSION` gates every API
  payload. Mismatch is a hard error, never a silent migration.
- `worldHash` is a deterministic content hash over seed + versions + every
  planet/player in stable coordinate order. Same seed → same hash (tested).
- `planetStateHash` is computed per resolution; same seed + same ticks →
  same hash (tested).
- `resolveEmptyTick` is pure: the same world + tick + resolvedAt produces the
  same resolution and next world state.

### 3. Single-resolver protection and idempotent replay

- `TickEngine.resolveTick` checks for an existing resolution **before** the
  out-of-order check (replay of an already-resolved tick returns the stored
  resolution) and **again under the lock** (a duplicate tick job racing the
  same world/tick returns the stored resolution; exactly one resolver body
  runs).
- `WorldLock` is a per-world mutex: a second concurrent holder queues until
  release. M1 replaces it with a database advisory lock / lease on the same
  interface.
- `TickScheduler` resolves every due world on an interval; the engine remains
  the single source of truth.

### 4. In-memory storage for M0 (deferred infrastructure)

- `WorldRepository` is the seam where PostgreSQL lands in M1. The in-memory
  implementation keeps the same semantics: save/get world, save/get
  resolution, list world ids.
- There are **no SQL migrations in M0**; the "migration/seed correctness"
  acceptance is covered by deterministic worldgen tests and the API's
  seed-derived world creation (`world:1337` from seed `1337`).
- Redis is deferred with it; the scheduler's interval is the M0 stand-in for
  a durable job scheduler.

## Consequences

- **Good:** the full M0 slice (workspace, worldgen, tick record, auth
  baseline, command validation, overview UI, acceptance tests) runs with zero
  external services; CI stays light; the engine is fully unit-testable.
- **Costs:** no durability across restarts (worlds live only in the API/worker
  process); dev/e2e use a shortened tick duration via `TICK_DURATION_MS`.
- **Risks:** a naive "duplicate tick job" retry after the lock is released is
  already safe (idempotent replay). M1 must move world state and resolutions
  to PostgreSQL with advisory-lock resolution before any multi-process
  deployment.

## Alternatives considered

- **Postgres + Redis now:** adds real infra and migrations before the
  determinism contract is proven; rejected to keep M0's acceptance tests
  environment-free.
- **Pure in-memory engine with no storage seam:** faster to write, but would
  require an engine rewrite for M1; rejected — the repository interface is
  cheap and is the migration boundary.
