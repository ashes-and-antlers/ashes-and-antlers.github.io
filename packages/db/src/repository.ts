import { worldId, type TickResolution, type WorldId, type WorldState } from '@ashes/contracts';

/**
 * Storage boundary for authoritative world state (ADR-002, ADR-003). M0
 * shipped the in-memory implementation; M1 replaces it with the
 * PostgreSQL-backed repository behind the same interface.
 *
 * All operations are async: the database is the source of truth. The engine
 * performs its read-modify-write resolution inside `withWorldLocked`, which
 * serializes per world (advisory lock in Postgres) and provides a
 * transaction-scoped view (`tx`) so reads, the idempotency check, and the
 * save happen atomically.
 */
export interface WorldRepository {
  saveWorld(world: WorldState): Promise<void>;
  getWorld(worldId: WorldId): Promise<WorldState | undefined>;
  saveResolution(resolution: TickResolution): Promise<void>;
  getResolution(worldId: WorldId, tick: number): Promise<TickResolution | undefined>;
  /** All worlds tracked by this repository, for scheduler due checks. */
  listWorldIds(): Promise<WorldId[]>;
  deleteWorld(worldId: WorldId): Promise<void>;
  /**
   * Run `fn` with exclusive per-world ownership and a transaction-scoped view
   * of the repository. For the in-memory implementation this is a passthrough
   * (the engine's in-process WorldLock already serializes); for Postgres it
   * is a transaction holding `pg_advisory_xact_lock`.
   */
  withWorldLocked<T>(worldId: WorldId, fn: (tx: WorldRepository) => Promise<T>): Promise<T>;
}

export class InMemoryWorldRepository implements WorldRepository {
  private worlds = new Map<string, WorldState>();
  private resolutions = new Map<string, TickResolution>();

  async saveWorld(world: WorldState): Promise<void> {
    this.worlds.set(world.id, world);
  }

  async getWorld(worldId: WorldId): Promise<WorldState | undefined> {
    return this.worlds.get(worldId);
  }

  async saveResolution(resolution: TickResolution): Promise<void> {
    this.resolutions.set(resolutionKey(resolution.worldId, resolution.tick), resolution);
  }

  async getResolution(worldId: WorldId, tick: number): Promise<TickResolution | undefined> {
    return this.resolutions.get(resolutionKey(worldId, tick));
  }

  async listWorldIds(): Promise<WorldId[]> {
    return [...this.worlds.keys()].map(worldId);
  }

  async deleteWorld(worldId: WorldId): Promise<void> {
    this.worlds.delete(worldId);
    for (const key of [...this.resolutions.keys()]) {
      if (key.startsWith(`${worldId}:`)) this.resolutions.delete(key);
    }
  }

  async withWorldLocked<T>(_worldId: WorldId, fn: (tx: WorldRepository) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function resolutionKey(worldId: WorldId, tick: number): string {
  return `${worldId}:${tick}`;
}
