import type {
  PlanetView,
  TickResolution,
  TickResolutionView,
  WorldId,
  WorldView,
} from '@ashes/contracts';
import {
  apiError,
  PROTOCOL_VERSION,
  toPlanetView,
  toTickResolutionView,
  worldIdFromSeed,
  type ApiError,
  type WorldState,
} from '@ashes/contracts';
import { generateWorld, resolveEmptyTick } from '@ashes/domain';
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
 */
export class TickEngine {
  private readonly repository: WorldRepository;
  private readonly lock: WorldLock;

  constructor(options: EngineOptions) {
    this.repository = options.repository;
    this.lock = options.lock ?? new WorldLock();
  }

  /**
   * Create (or reload) a world from a seed. World creation is idempotent per
   * seed: the same seed returns the same world state.
   */
  createWorld(input: {
    seed: number;
    createdAt?: number;
    playerToken?: string;
    tickDurationMs?: number;
  }): WorldState {
    const worldId = worldIdFromSeed(input.seed);
    const existing = this.repository.getWorld(worldId);
    if (existing) return existing;
    const world = generateWorld({
      seed: input.seed,
      createdAt: input.createdAt ?? Date.now(),
      ...(input.playerToken === undefined ? {} : { playerToken: input.playerToken }),
      ...(input.tickDurationMs === undefined ? {} : { tickDurationMs: input.tickDurationMs }),
    });
    this.repository.saveWorld(world);
    return world;
  }

  getWorld(worldId: WorldId): WorldState | undefined {
    return this.repository.getWorld(worldId);
  }

  /**
   * Resolve the world's next tick. Guarded by the per-world lock and
   * idempotent: if the tick was already resolved, the stored resolution is
   * returned and nothing is re-executed.
   */
  async resolveNextTick(worldId: WorldId, resolvedAt?: number): Promise<TickResolution> {
    const world = this.requireWorld(worldId);
    const nextTick = world.tick + 1;
    return this.resolveTick(worldId, nextTick, resolvedAt);
  }

  async resolveTick(worldId: WorldId, tick: number, resolvedAt?: number): Promise<TickResolution> {
    const world = this.requireWorld(worldId);
    // Idempotent replay: an already-resolved tick returns its stored
    // resolution, even if it is no longer the "next" tick (e.g. a worker
    // restart re-running tick 1 after tick 2 was resolved).
    const existing = this.repository.getResolution(worldId, tick);
    if (existing) return existing;
    if (tick !== world.tick + 1) {
      throw new TickOutOfOrderError(worldId, tick, world.tick);
    }

    const release = await this.lock.acquire(worldId);
    try {
      // Re-check under the lock: a concurrent resolver may have completed
      // this tick while we were waiting. Idempotent replay.
      const again = this.repository.getResolution(worldId, tick);
      if (again) return again;
      const now = this.requireWorld(worldId);
      const { world: next, resolution } = resolveEmptyTick({
        world: now,
        tick,
        resolvedAt: resolvedAt ?? Date.now(),
      });
      this.repository.saveWorld(next);
      this.repository.saveResolution(resolution);
      return resolution;
    } finally {
      release();
    }
  }

  /** Player-scoped projection for the web client. */
  getWorldView(worldId: WorldId): WorldView {
    const world = this.requireWorld(worldId);
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
      .map(toPlanetView);
    const lastResolution = this.repository.getResolution(worldId, world.tick);
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
        homePlanet: toPlanetView(homePlanet),
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
    if (err instanceof TickOutOfOrderError) {
      return apiError(
        'INTERNAL',
        `tick ${err.tick} is out of order for world ${err.worldId} (resolved through ${err.currentTick})`,
      );
    }
    return apiError('INTERNAL', err instanceof Error ? err.message : 'unknown error');
  }

  private requireWorld(worldId: WorldId): WorldState {
    const world = this.repository.getWorld(worldId);
    if (!world) throw new WorldNotFoundError(worldId);
    return world;
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
