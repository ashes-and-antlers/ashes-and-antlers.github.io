import { worldId, type TickResolution, type WorldId, type WorldState } from '@ashes/contracts';

/**
 * Storage boundary for authoritative world state. M0 ships the in-memory
 * implementation; M1 replaces this with a PostgreSQL-backed repository behind
 * the same interface (see docs/ADR-002).
 */
export interface WorldRepository {
  saveWorld(world: WorldState): void;
  getWorld(worldId: WorldId): WorldState | undefined;
  saveResolution(resolution: TickResolution): void;
  getResolution(worldId: WorldId, tick: number): TickResolution | undefined;
  /** All worlds tracked by this repository, for scheduler due checks. */
  listWorldIds(): WorldId[];
}

export class InMemoryWorldRepository implements WorldRepository {
  private worlds = new Map<string, WorldState>();
  private resolutions = new Map<string, TickResolution>();

  saveWorld(world: WorldState): void {
    this.worlds.set(world.id, world);
  }

  getWorld(worldId: WorldId): WorldState | undefined {
    return this.worlds.get(worldId);
  }

  saveResolution(resolution: TickResolution): void {
    this.resolutions.set(resolutionKey(resolution.worldId, resolution.tick), resolution);
  }

  getResolution(worldId: WorldId, tick: number): TickResolution | undefined {
    return this.resolutions.get(resolutionKey(worldId, tick));
  }

  listWorldIds(): WorldId[] {
    return [...this.worlds.keys()].map(worldId);
  }
}

function resolutionKey(worldId: WorldId, tick: number): string {
  return `${worldId}:${tick}`;
}
