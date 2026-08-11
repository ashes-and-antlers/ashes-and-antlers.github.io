# ADR-001: Simulation ownership and determinism contract

**Status:** Accepted (Milestone 0), amended (Milestone 1a)

**Date:** 2026-08-10

## Context

"Civilizations at War" (working title _Ashes and Antlers_) is a browser-native
2D grand colony/RTS in which two autonomous civilizations share one
deterministic simulation. The game must be reproducible from a seed, debuggable,
and able to sustain 500 agents on a mid-range desktop browser.

The core tensions are:

- The simulation must be **deterministic** (same seed + config + ordered
  commands = same result) so scenario tests, replays, and balance batches are
  meaningful.
- The main thread must stay responsive for UI, input, and rendering while the
  simulation does heavy work.
- All "why did this happen?" questions must be answerable from simulation
  state — no fake event outcomes, no hidden randomness.

## Decision

### 1. A dedicated Web Worker owns all authoritative simulation state

- The worker (`src/worker/index.ts`) owns the `Simulation` and nothing on the
  main thread may mutate simulation objects.
- The main thread owns the DOM UI, input capture, and PixiJS rendering; it
  consumes **read-only snapshots** published by the worker via `postMessage`
  with transferable buffers.
- Player intent flows the other way as **validated commands** appended to an
  ordered command stream (`WorkerRequest`/`PlayerCommand` in
  `src/shared/protocol.ts`).
- Renderer/UI state is always derived; the worker remains the single source of
  truth. This mirrors the plan's "Simulation boundary" section.

### 2. Determinism rules (enforced from Milestone 0)

- **Fixed tick only.** `FixedClock` (5 ticks/second at 1x) converts real
  elapsed time into whole ticks; no `deltaTime`-driven systems ever exist in
  the authoritative path.
- **Seeded PRNG with named streams.** `createPrng` (mulberry32 + FNV-1a) uses
  only integer arithmetic, so sequences are identical across platforms.
  Each concern (worldgen, later: faction A/B, combat, events) draws from its
  own stream so adding a consumer never perturbs another's sequence.
- **Stable iteration order.** World generation iterates tiles in strict
  row-major order; future systems must process entities/tasks in stable
  numeric ID order and break ties with explicit stable keys.
- **Content versioning.** `WORLD_VERSION` (worldgen semantics) and
  `PROTOCOL_VERSION` (message protocol) are part of every snapshot; a
  mismatch is a hard error, not a silent migration.
- **Terrain hash.** `computeTerrainHash` produces a content hash over the
  seed, generator version, dimensions, and every tile field. Same seed must
  always produce the same hash — a Milestone 0 acceptance test and the seed of
  future replay/golden tests.

### 3. Snapshot protocol v1

- Snapshots are published every `SNAPSHOT_EVERY_TICKS` (5) ticks, or on the
  first frame after a state change while paused.
- The tile buffer (`byte = terrain << 5 | elevation >> 3`) is transferred only
  when the world actually changes; routine snapshots carry only tick,
  calendar, hash, and a deterministic per-tick signal.
- Snapshots are immutable to consumers.

### 4. Entity storage and iteration (Milestone 1a)

Milestone 1a introduces citizens, buildings, resource nodes, and tasks via
**bitECS 0.4**. The integration extends, rather than replaces, the determinism
contract:

- **SoA typed-array stores.** Components are declared as typed arrays indexed
  by entity id (`createWorld({ components })`); entity data is contiguous,
  transferable-friendly, and never an object graph. Capacity is `MAX_ENTITIES`
  (512) covering the plan's 500-agent target.
- **Eid recycling is safe.** bitECS reuses freed entity ids (verified
  empirically), so the capacity bound applies to _concurrent_ entities, not
  cumulative churn from task create/complete cycles.
- **Stable iteration everywhere.** Every system iterates `sortedQuery`
  (ascending eid) and resolves ties by explicit stable keys (lowest task id,
  nearest stockpile by squared distance with deterministic scan order).
  Claims happen in ascending citizen-id order, so the task market is
  reproducible.
- **Pathfinding is derived state.** A* runs inside the worker, is never
  serialized, and is recomputed from (position, goal, blocked tiles); ties
  break on lower f-score then lower g-score then lower tile id.
- **Spawn determinism.** Worldgen and entity placement (homes, citizens,
  nodes) use only seeded noise and fixed scan orders; citizen spawn tiles are
  clamped to walkable, non-building tiles via a deterministic
  expanding-square scan (no `Math.random()` anywhere in `sim/`).
- **Snapshot extension.** Snapshots add a packed `Int32Array` entity buffer
  (`[eid, kind, faction, x, y, state, extra]` rows), an ownership overlay
  buffer (`world.owner.slice()` — always a copy, never a detach), and the
  alert tail. Tiles remain transferred only on world change.

## Consequences

- **Good:** The main thread stays cheap; workers + transferables keep the
  render path allocation-light; determinism is testable from the first commit;
  the worker boundary gives us a natural place to add bitECS component stores
  (Milestone 1) without touching the protocol.
- **Costs:** `postMessage` latency for large buffers — mitigated by delta-ish
  publishing (tiles only on world change). Debugging across threads is harder;
  we compensate with `debug/` tooling in later milestones.
- **Risks:** Timing-dependent tick accumulation (fixed by the clock's cap and
  pause semantics); browser tab throttling (capped catch-up keeps the sim from
  spiraling); SharedArrayBuffer is deliberately **not** required — the
  transferable protocol remains fully supported.

## Alternatives considered

- **Rust/WASM core now:** deferred per the plan — iteration speed and
  debugability matter more early; profiling will decide later whether any
  contained subsystem (pathfinding, worldgen) crosses the boundary.
- **Simulation on the main thread:** simpler initially, but risks jank,
  accidental mutation, and makes the snapshot discipline impossible to enforce.
- **SharedArrayBuffer + shared state:** fastest, but requires
  cross-origin-isolated documents and complicates debugging; only revisit
  behind capability checks.
