import type {
  PlanetId,
  PlanetView,
  TickResolution,
  TickResolutionView,
  WorldId,
  WorldView,
} from '@ashes/contracts';
import {
  apiError,
  PROTOCOL_VERSION,
  toTickResolutionView,
  worldIdFromSeed,
  type ApiError,
  type WorldState,
} from '@ashes/contracts';
import { CONTENT_VERSION } from '@ashes/content';
import { generateWorld, planetView, resolveEconomyTick } from '@ashes/domain';
import type { WorldRepository } from './repository';
import { WorldLock } from './lock';

export class WorldNotFoundError extends Error {
  constructor(public readonly worldId: WorldId) {
    super(`world ${worldId} not found`);
    this.name = 'WorldNotFoundError';
  }
}

export type EngineOptions = {
  repository: WorldRepository;
  lock?: WorldLock;
};

/**
 * The authoritative tick engine (DEVELOPMENT_PLAN.md §9): owns world
 * creation, resolution with a per-world lock, and idempotent replay. The API
 * and the worker both drive this engine; neither computes outcomes itself.
 *
 * M1: resolution runs the economy phase and the repository is PostgreSQL. The
 * read-modify-write happens inside `withWorldLocked`, so the idempotency
 * check and the save are atomic and serialized across every process sharing
 * the database.
 */
export class TickEngine {
  private readonly repository: WorldRepository;
  private readonly lock: WorldLock;

  constructor(options: EngineOptions) {
    this.repository = options.repository;
    this.lock = options.lock ?? new WorldLock();
  }

  /**
   * Create (or reload) a world from a seed. Idempotent per seed AND per
   * content version: an existing world created under a different content
   * version is re-created (deterministic seeds make this safe).
   */
  async createWorld(input: {
    seed: number;
    createdAt?: number;
    playerToken?: string;
    tickDurationMs?: number;
  }): Promise<WorldState> {
    const worldId = worldIdFromSeed(input.seed);
    // Idempotent per seed AND per content version, under the world lock so
    // concurrent processes never race a stale-content delete/recreate.
    return this.repository.withWorldLocked(worldId, async (tx) => {
      const existing = await tx.getWorld(worldId);
      if (existing && existing.contentVersion === CONTENT_VERSION) return existing;
      if (existing) {
        // Stale content: the world was generated under a previous version.
        // Drop it and regenerate so versioning never silently diverges.
        await tx.deleteWorld(worldId);
      }
      const world = generateWorld({
        seed: input.seed,
        createdAt: input.createdAt ?? Date.now(),
        ...(input.playerToken === undefined ? {} : { playerToken: input.playerToken }),
        ...(input.tickDurationMs === undefined ? {} : { tickDurationMs: input.tickDurationMs }),
      });
      await tx.saveWorld(world);
      return world;
    });
  }

  async getWorld(worldId: WorldId): Promise<WorldState | undefined> {
    return this.repository.getWorld(worldId);
  }

  /**
   * Resolve the world's next tick. Guarded by the per-world lock (in-process
   * mutex + repository advisory lock) and idempotent: if the tick was already
   * resolved, the stored resolution is returned and nothing is re-executed.
   */
  async resolveNextTick(worldId: WorldId, resolvedAt?: number): Promise<TickResolution> {
    const world = await this.requireWorld(worldId);
    const nextTick = world.tick + 1;
    return this.resolveTick(worldId, nextTick, resolvedAt);
  }

  async resolveTick(worldId: WorldId, tick: number, resolvedAt?: number): Promise<TickResolution> {
    const world = await this.requireWorld(worldId);
    // Idempotent replay: an already-resolved tick returns its stored
    // resolution, even if it is no longer the "next" tick (e.g. a worker
    // restart re-running tick 1 after tick 2 was resolved).
    const existing = await this.repository.getResolution(worldId, tick);
    if (existing) return existing;
    if (tick !== world.tick + 1) {
      throw new TickOutOfOrderError(worldId, tick, world.tick);
    }

    const release = await this.lock.acquire(worldId);
    try {
      // Re-check under the lock, inside the repository transaction: a
      // concurrent resolver (this process or another) may have completed this
      // tick while we were waiting. Idempotent replay.
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const again = await tx.getResolution(worldId, tick);
        if (again) return again;
        const now = await this.requireWorldFrom(tx, worldId);
        const { world: next, resolution } = resolveEconomyTick({
          world: now,
          tick,
          resolvedAt: resolvedAt ?? Date.now(),
        });
        await tx.saveWorld(next);
        await tx.saveResolution(resolution);
        return resolution;
      });
    } finally {
      release();
    }
  }

  /** Single-planet projection for the planet detail page and image endpoint. */
  async getPlanetView(worldId: WorldId, planetId: PlanetId): Promise<PlanetView> {
    const world = await this.requireWorld(worldId);
    const planet = world.planets.find((p) => p.id === planetId);
    if (!planet) throw new PlanetNotFoundError(worldId, planetId);
    return planetView(planet);
  }

  /** Player-scoped projection for the web client. */
  async getWorldView(worldId: WorldId): Promise<WorldView> {
    const world = await this.requireWorld(worldId);
    const player = world.players[0];
    if (!player) {
      throw new WorldNotFoundError(worldId);
    }
    const homePlanet = world.planets.find((p) => p.id === player.homePlanetId);
    if (!homePlanet) {
      throw new WorldNotFoundError(worldId);
    }
    const myPlanets: PlanetView[] = world.planets
      .filter((p) => p.ownerId === player.id)
      .map(planetView);
    const lastResolution = await this.repository.getResolution(worldId, world.tick);
    const lastResolutionView: TickResolutionView | null = lastResolution
      ? toTickResolutionView(lastResolution)
      : null;

    return {
      worldId: world.id,
      seed: world.seed,
      tick: world.tick,
      nextTickAt: world.nextTickAt,
      createdAt: world.createdAt,
      lastResolvedAt: world.lastResolvedAt,
      worldVersion: world.worldVersion,
      contentVersion: world.contentVersion,
      protocolVersion: PROTOCOL_VERSION,
      tickDurationMs: world.tickDurationMs,
      worldHash: world.worldHash,
      player: {
        id: player.id,
        name: player.name,
        factionId: player.factionId,
        homePlanet: planetView(homePlanet),
      },
      planets: myPlanets,
      pendingOrders: [],
      lastResolution: lastResolutionView,
    };
  }

  /** Resolve an API failure into a typed error envelope. */
  toApiError(err: unknown): ApiError {
    if (err instanceof WorldNotFoundError) {
      return apiError('NOT_FOUND', `world ${err.worldId} not found`);
    }
    if (err instanceof PlanetNotFoundError) {
      return apiError('NOT_FOUND', `planet ${err.planetId} not found in world ${err.worldId}`);
    }
    if (err instanceof TickOutOfOrderError) {
      return apiError(
        'INTERNAL',
        `tick ${err.tick} is out of order for world ${err.worldId} (resolved through ${err.currentTick})`,
      );
    }
    return apiError('INTERNAL', err instanceof Error ? err.message : 'unknown error');
  }

  private async requireWorld(worldId: WorldId): Promise<WorldState> {
    const world = await this.repository.getWorld(worldId);
    if (!world) throw new WorldNotFoundError(worldId);
    return world;
  }

  private async requireWorldFrom(tx: WorldRepository, worldId: WorldId): Promise<WorldState> {
    const world = await tx.getWorld(worldId);
    if (!world) throw new WorldNotFoundError(worldId);
    return world;
  }
}

export class PlanetNotFoundError extends Error {
  constructor(
    public readonly worldId: WorldId,
    public readonly planetId: PlanetId,
  ) {
    super(`planet ${planetId} not found in world ${worldId}`);
    this.name = 'PlanetNotFoundError';
  }
}

export class TickOutOfOrderError extends Error {
  constructor(
    public readonly worldId: WorldId,
    public readonly tick: number,
    public readonly currentTick: number,
  ) {
    super(`tick ${tick} out of order for world ${worldId}; expected ${currentTick + 1}`);
    this.name = 'TickOutOfOrderError';
  }
}
