import type {
  AdminPlayerDetail,
  AdminWorldDetail,
  AdminWorldSummary,
  ApiErrorCode,
  CancelConstructionCommand,
  CancelResearchCommand,
  CancelShipOrderCommand,
  ConstructionOrderView,
  FactionId,
  Fleet,
  FleetId,
  FleetOpReceipt,
  FleetOpReceiptResult,
  Coordinate,
  GalaxyView,
  Planet,
  PlanetId,
  LoadCargoCommand,
  PlanetView,
  Player,
  PlayerId,
  QueueShipCommand,
  RecallFleetCommand,
  ResearchOrderView,
  ResourceRates,
  ResourceStore,
  RunScanCommand,
  ScanReportView,
  SendFleetCommand,
  ShipyardOrderView,
  SplitFleetCommand,
  StartBuildingCommand,
  StartResearchCommand,
  TickResolution,
  TickResolutionView,
  TransferFleetCommand,
  UnloadCargoCommand,
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
import { CONTENT_VERSION, WORLD_CONFIG } from '@ashes/content';
import {
  AdminDomainError,
  cancelConstruction,
  cancelResearch,
  cancelShipOrder,
  coordinateDistance,
  fleetDriveTier,
  fleetOpResultFrom,
  fleetViews,
  galaxyBounds,
  galaxyDiscRadius,
  galaxyOrigin,
  generateWorld,
  grantResourcesToPlanet,
  isCoordinateInWorld,
  leastPopulatedFaction,
  orderViewById,
  pendingOrderViews,
  planetClassId,
  planetLocalFleetViews,
  planetPosition,
  planetView,
  playerResearchEffects,
  removePlayerFromWorld,
  reportViews,
  researchOrderViews,
  resolveTick,
  scanIntel,
  scanRange,
  sectorBounds,
  shipyardOrderViews,
  spawnPlayerIntoWorld,
  splitFleet,
  storageCapFor,
  submitLoadCargo,
  submitQueueShip,
  submitRecallFleet,
  submitRunScan,
  submitSendFleet,
  submitStartBuilding,
  submitStartResearch,
  submitUnloadCargo,
  systemPosition,
  transferFleet,
  travelTicks,
  type ConstructionError,
  type FleetError,
  type MovementError,
  type ResearchError,
  type ScanError,
  type ShipyardError,
} from '@ashes/domain';
import type { DatabaseAdmin } from './admin';
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
  /** Read-only database introspection for the admin surface (optional). */
  admin?: DatabaseAdmin;
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
  private readonly admin: DatabaseAdmin | undefined;

  constructor(options: EngineOptions) {
    this.repository = options.repository;
    this.lock = options.lock ?? new WorldLock();
    this.admin = options.admin;
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

  /** Delete a world and all of its resolutions (admin; cascade at the db). */
  async deleteWorld(worldId: WorldId): Promise<void> {
    await this.repository.deleteWorld(worldId);
  }

  /**
   * Spawn a new commander into a world: assign them the least-populated
   * faction (so the two powers stay balanced by construction), claim the
   * least-populated planet near the existing players, and append the player
   * (deterministic per world state — see domain spawn.ts). Runs under the
   * world lock so concurrent registrations cannot claim the same planet and
   * the faction count is read fresh.
   */
  async spawnPlayer(
    worldId: WorldId,
    input: { playerId: PlayerId; name: string; token: string },
  ): Promise<{ world: WorldState; player: Player; homePlanet: Planet }> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        const result = spawnPlayerIntoWorld(world, {
          ...input,
          factionId: leastPopulatedFaction(world),
        });
        await tx.saveWorld(result.world);
        return result;
      });
    } finally {
      release();
    }
  }

  /**
   * Ensure a commander's player exists in the world, re-spawning it when it
   * was lost (e.g. the world was re-derived from the seed after a content
   * bump, which wipes spawned players while the account row survives). This
   * is what makes login idempotent against regeneration: an account whose
   * player vanished is re-created deterministically with its stored identity
   * (name and faction — never re-assigned) instead of orphaning the session.
   * Runs under the world lock, like every other state mutation.
   */
  async ensurePlayer(
    worldId: WorldId,
    input: { playerId: PlayerId; name: string; factionId: FactionId; token: string },
  ): Promise<{ player: Player; homePlanet: Planet; reSpawned: boolean }> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        const existing = world.players.find((p) => p.id === input.playerId);
        if (existing) {
          const homePlanet = world.planets.find((p) => p.id === existing.homePlanetId);
          if (!homePlanet) throw new PlayerNotFoundError(worldId, input.playerId);
          return { player: existing, homePlanet, reSpawned: false };
        }
        const result = spawnPlayerIntoWorld(world, input);
        await tx.saveWorld(result.world);
        return { ...result, reSpawned: true };
      });
    } finally {
      release();
    }
  }

  /**
   * Rename a commander. The display name lives in two authoritative stores
   * that must agree — the account row (identity) and the player inside the
   * world aggregate (sim state, shown in views) — so this mutates the world
   * under the same per-world lock every other state change uses.
   */
  async renamePlayer(worldId: WorldId, playerId: PlayerId, name: string): Promise<Player> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        const player = world.players.find((p) => p.id === playerId);
        if (!player) throw new PlayerNotFoundError(worldId, playerId);
        const updated: Player = { ...player, name, version: player.version + 1 };
        await tx.saveWorld({
          ...world,
          players: world.players.map((p) => (p.id === playerId ? updated : p)),
          version: world.version + 1,
        });
        return updated;
      });
    } finally {
      release();
    }
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
        const { world: next, resolution } = resolveTick({
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

  /**
   * Accept a StartBuilding command: validates against the current state under
   * the world lock (expected version, ownership, building, max level, queue
   * capacity, affordability), reserves (deducts) the cost, and returns the
   * order receipt. Idempotent per idempotency key. Two commands racing for
   * the same store are serialized by the lock, so the second one sees the
   * post-deduction store — the M1 overspend acceptance.
   */
  async submitStartBuilding(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: StartBuildingCommand },
  ): Promise<ConstructionOrderView> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        const result = submitStartBuilding(world, { ...envelope, actorId }, Date.now());
        if (!result.ok) throw commandRejected(result.error);
        await tx.saveWorld(result.world);
        return this.orderViewFrom(result.world, result.order.id);
      });
    } finally {
      release();
    }
  }

  /**
   * Cancel a queued/in-progress construction order: refunds the reserved cost
   * (clamped at the storage cap) and marks the order cancelled. Idempotent:
   * re-cancelling the same order returns its view without a second refund.
   */
  async cancelConstruction(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: {
      idempotencyKey: string;
      expectedVersion: number;
      command: CancelConstructionCommand;
    },
  ): Promise<ConstructionOrderView> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        const result = cancelConstruction(world, { ...envelope, actorId });
        if (!result.ok) throw commandRejected(result.error);
        await tx.saveWorld(result.world);
        return this.orderViewFrom(result.world, result.order.id);
      });
    } finally {
      release();
    }
  }

  private async orderViewFrom(world: WorldState, orderId: ConstructionOrderView['id']) {
    const view = orderViewById(world, orderId);
    if (!view)
      throw new CommandRejectedError('INTERNAL', `order ${orderId} missing after acceptance`);
    return view;
  }

  /** Accept a StartResearch command under the world lock (M2). */
  async submitStartResearch(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: StartResearchCommand },
  ): Promise<ResearchOrderView> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = submitStartResearch(world, { ...envelope, actorId }, Date.now());
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      const player = result.world.players.find((p) => p.id === actorId);
      if (!player) throw new CommandRejectedError('INTERNAL', 'player missing after research');
      const view = researchOrderViews(player).find((v) => v.id === result.order.id);
      if (!view)
        throw new CommandRejectedError('INTERNAL', `research order ${result.order.id} missing`);
      return view;
    });
  }

  /** Cancel a research order under the world lock (M2). */
  async cancelResearch(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: CancelResearchCommand },
  ): Promise<ResearchOrderView> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = cancelResearch(world, { ...envelope, actorId });
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      const player = result.world.players.find((p) => p.id === actorId);
      if (!player) throw new CommandRejectedError('INTERNAL', 'player missing after research');
      const view = researchOrderViews(player).find((v) => v.id === result.order.id);
      if (!view)
        throw new CommandRejectedError('INTERNAL', `research order ${result.order.id} missing`);
      return view;
    });
  }

  /** Accept a QueueShip command under the world lock (M2). */
  async submitQueueShip(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: QueueShipCommand },
  ): Promise<ShipyardOrderView> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = submitQueueShip(world, { ...envelope, actorId }, Date.now());
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      const planet = result.world.planets.find((p) => p.id === result.order.planetId);
      if (!planet) throw new CommandRejectedError('INTERNAL', 'planet missing after ship order');
      const view = shipyardOrderViews(planet).find((v) => v.id === result.order.id);
      if (!view)
        throw new CommandRejectedError('INTERNAL', `ship order ${result.order.id} missing`);
      return view;
    });
  }

  /** Cancel a ship order under the world lock (M2). */
  async cancelShipOrder(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: CancelShipOrderCommand },
  ): Promise<ShipyardOrderView> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = cancelShipOrder(world, { ...envelope, actorId });
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      const planet = result.world.planets.find((p) => p.id === result.order.planetId);
      if (!planet) throw new CommandRejectedError('INTERNAL', 'planet missing after ship order');
      const view = shipyardOrderViews(planet).find((v) => v.id === result.order.id);
      if (!view)
        throw new CommandRejectedError('INTERNAL', `ship order ${result.order.id} missing`);
      return view;
    });
  }

  /** Split a fleet under the world lock (M2); returns the new fleet's view. */
  async splitFleet(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: SplitFleetCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, splitFleet);
  }

  /** Transfer ships/cargo between co-located fleets under the world lock (M2). */
  async transferFleet(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: TransferFleetCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, transferFleet);
  }

  /** Send a fleet to a destination coordinate under the world lock (M3). */
  async sendFleet(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: SendFleetCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, submitSendFleet);
  }

  /** Turn a moving fleet around under the world lock (M3). */
  async recallFleet(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: RecallFleetCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, submitRecallFleet);
  }

  /** Load planet resources into an orbiting fleet's hold under the lock (M3). */
  async loadCargo(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: LoadCargoCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, submitLoadCargo);
  }

  /** Unload a fleet's cargo into the planet store under the world lock (M3). */
  async unloadCargo(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: UnloadCargoCommand },
  ): Promise<FleetOpReceiptResult> {
    return this.fleetOp(worldId, actorId, envelope, submitUnloadCargo);
  }

  /** Shared fleet-op runner: validate + save under the lock, then rebuild the
   *  result views from the saved state (idempotent replay returns the stored
   *  receipt's result without a second mutation). */
  private async fleetOp<
    C extends
      | SplitFleetCommand
      | TransferFleetCommand
      | SendFleetCommand
      | RecallFleetCommand
      | LoadCargoCommand
      | UnloadCargoCommand,
  >(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: C },
    run: (
      world: WorldState,
      env: { idempotencyKey: string; expectedVersion: number; command: C; actorId: PlayerId },
      at: number,
    ) =>
      | { ok: true; world: WorldState; receipt: FleetOpReceipt }
      | { ok: false; error: FleetError | MovementError },
  ): Promise<FleetOpReceiptResult> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = run(world, { ...envelope, actorId }, Date.now());
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      return fleetOpResultFrom(result.world, result.receipt);
    });
  }

  /**
   * Fleet route preview (M3): the deterministic travel plan for sending a
   * fleet to a destination — distance, travel ticks, and the arrival tick if
   * the order were submitted this instant. Read-only and server-authoritative:
   * the web client never computes routes itself, so the ETA shown on the send
   * form always matches the arrival the engine will resolve.
   */
  async getFleetRoute(
    worldId: WorldId,
    fleetId: FleetId,
    destination: Coordinate,
  ): Promise<{ distance: number; travelTicks: number; arrivalTick: number }> {
    const world = await this.requireWorld(worldId);
    const fleet = world.fleets.find((f) => f.id === fleetId);
    if (!fleet) throw new FleetNotFoundError(worldId, fleetId);
    if (!isCoordinateInWorld(destination)) {
      throw new CommandRejectedError(
        'INVALID_DESTINATION',
        `coordinate ${destination.galaxy}:${destination.sector}:${destination.system}:${destination.planet} is outside the world`,
      );
    }
    const player = world.players.find((p) => p.id === fleet.ownerId);
    const bonus = player ? playerResearchEffects(player).navigationSpeedBonus : 0;
    const distance = coordinateDistance(world.seed, fleet.location, destination);
    const travel = travelTicks({
      distance,
      driveTier: fleetDriveTier(fleet),
      navigationSpeedBonus: bonus,
    });
    return { distance, travelTicks: travel, arrivalTick: world.tick + travel };
  }

  /**
   * Accept a RunScan command under the world lock (M3): validate the source
   * planet's Scanner Array, the kind's level gate, range, and target; reveal
   * the target through the scan kind's lens and return the immutable report.
   * Idempotent per idempotency key — replay returns the original report.
   */
  async runScan(
    worldId: WorldId,
    actorId: PlayerId,
    envelope: { idempotencyKey: string; expectedVersion: number; command: RunScanCommand },
  ): Promise<ScanReportView> {
    return this.withLocked(worldId, async (tx, world) => {
      const result = submitRunScan(world, { ...envelope, actorId }, Date.now());
      if (!result.ok) throw commandRejectedM2(result.error);
      await tx.saveWorld(result.world);
      return result.report;
    });
  }

  /**
   * Scan reach preview (M3): the source planet's array range, the distance to
   * a target, and whether a scan of it would be in range — answered by the
   * engine so the scan form's reach indicator always matches the command's
   * resolution. Read-only.
   */
  async getScanPreview(
    worldId: WorldId,
    sourcePlanetId: PlanetId,
    target: Coordinate,
  ): Promise<{ range: number; distance: number; inRange: boolean }> {
    const world = await this.requireWorld(worldId);
    const source = world.planets.find((p) => p.id === sourcePlanetId);
    if (!source) throw new PlanetNotFoundError(worldId, sourcePlanetId);
    if (!isCoordinateInWorld(target)) {
      throw new CommandRejectedError(
        'INVALID_DESTINATION',
        `coordinate ${target.galaxy}:${target.sector}:${target.system}:${target.planet} is outside the world`,
      );
    }
    const owner = source.ownerId ? world.players.find((p) => p.id === source.ownerId) : undefined;
    const effects = owner ? playerResearchEffects(owner) : undefined;
    const range = scanRange(source, effects);
    const distance = coordinateDistance(world.seed, source.coordinate, target);
    return { range, distance, inRange: distance <= range };
  }

  // -- admin surface (M4): world/player inspection and operator mutations ----

  /** Every world tracked by the repository, for the admin world list. */
  async listWorlds(): Promise<WorldState[]> {
    const ids = await this.repository.listWorldIds();
    const worlds: WorldState[] = [];
    for (const id of ids) {
      const world = await this.repository.getWorld(id);
      if (world) worlds.push(world);
    }
    return worlds;
  }

  /** Every player across every world (for the admin player list). */
  async listPlayers(): Promise<Array<{ worldId: WorldId; player: Player }>> {
    const worlds = await this.listWorlds();
    const players: Array<{ worldId: WorldId; player: Player }> = [];
    for (const world of worlds) {
      for (const player of world.players) players.push({ worldId: world.id, player });
    }
    return players;
  }

  /**
   * The aggregate peek for the admin world detail panel: summary (with the
   * immutable resolution count from the database admin) plus every player,
   * planet, and fleet in stable order. Read-only.
   */
  async getWorldAdminDetail(worldId: WorldId): Promise<AdminWorldDetail> {
    const world = await this.requireWorld(worldId);
    const resolutionCount = await this.admin?.countResolutions(worldId);
    const summary: AdminWorldSummary = {
      id: world.id,
      seed: world.seed,
      tick: world.tick,
      createdAt: world.createdAt,
      nextTickAt: world.nextTickAt,
      lastResolvedAt: world.lastResolvedAt,
      worldVersion: world.worldVersion,
      contentVersion: world.contentVersion,
      tickDurationMs: world.tickDurationMs,
      worldHash: world.worldHash,
      version: world.version,
      playerCount: world.players.length,
      planetCount: world.planets.length,
      fleetCount: world.fleets.length,
      resolutionCount: resolutionCount ?? 0,
    };
    return {
      summary,
      players: world.players.map((p) => ({
        playerId: p.id,
        name: p.name,
        factionId: p.factionId,
        homePlanetId: p.homePlanetId,
        // Legacy aggregates (pre-M2/M3 rows carried by a content bump) may
        // lack the M2/M3 player fields; the admin surface reports 0 instead
        // of crashing, mirroring the scheduler's legacy-row tolerance.
        technologyCount: (p.technologies ?? []).length,
        fleetCount: world.fleets.filter((f) => f.ownerId === p.id).length,
      })),
      planets: world.planets.map((p) => ({
        id: p.id,
        coordinate: p.coordinate,
        name: p.name,
        ownerId: p.ownerId,
        factionId: p.factionId,
        population: p.population,
        buildings: p.buildings,
        resources: p.resources,
      })),
      fleets: world.fleets.map(adminFleetRow),
    };
  }

  /**
   * The operator's player dossier: the player, home planet, owned planets,
   * fleets, and research, all derived from the authoritative aggregate. The
   * account linkage is added by the API layer (the account row lives outside
   * the world).
   */
  async getPlayerAdminDetail(
    playerId: PlayerId,
  ): Promise<{ worldId: WorldId; detail: AdminPlayerDetail }> {
    const worlds = await this.listWorlds();
    for (const world of worlds) {
      const player = world.players.find((p) => p.id === playerId);
      if (!player) continue;
      const homePlanet = world.planets.find((p) => p.id === player.homePlanetId);
      if (!homePlanet) throw new PlayerNotFoundError(world.id, playerId);
      const ownedPlanets = world.planets.filter((p) => p.ownerId === player.id);
      const fleets = world.fleets.filter((f) => f.ownerId === player.id);
      const effects = playerResearchEffects(player);
      const detail: AdminPlayerDetail = {
        player: {
          playerId: player.id,
          name: player.name,
          factionId: player.factionId,
          worldId: world.id,
          homePlanetId: player.homePlanetId,
          technologyCount: (player.technologies ?? []).length,
          fleetCount: fleets.length,
          scanReportCount: (player.scanReports ?? []).length,
        },
        homePlanet: {
          id: homePlanet.id,
          coordinate: homePlanet.coordinate,
          name: homePlanet.name,
          population: homePlanet.population,
          resources: homePlanet.resources,
          buildings: homePlanet.buildings,
          storageCap: storageCapFor(homePlanet, effects),
          localFleets: world.fleets
            .filter((f) => homePlanet.localFleets.includes(f.id))
            .map((f) => ({ id: f.id, ships: f.ships, cargo: f.cargo })),
        },
        ownedPlanets: ownedPlanets.map((p) => ({
          id: p.id,
          coordinate: p.coordinate,
          name: p.name,
          population: p.population,
          resources: p.resources,
          buildings: p.buildings,
        })),
        fleets: fleets.map(adminFleetRow),
        research: {
          completed: player.technologies ?? [],
          activeOrderCount: (player.researchOrders ?? []).filter(
            (o) => o.status === 'researching' || o.status === 'queued',
          ).length,
        },
      };
      return { worldId: world.id, detail };
    }
    throw new CommandRejectedError('NOT_FOUND', `player ${playerId} not found in any world`);
  }

  /**
   * Grant resources to a player's home planet (operator tool): adds to the
   * store clamped at the storage cap, under the same world lock every state
   * mutation uses. Returns the fresh store, cap, and aggregate version.
   */
  async grantResources(
    worldId: WorldId,
    playerId: PlayerId,
    resources: Partial<ResourceRates>,
  ): Promise<{ resources: ResourceStore; storageCap: number; version: number }> {
    return this.withLocked(worldId, async (tx, world) => {
      const next = grantResourcesToPlanet(world, playerId, resources);
      await tx.saveWorld(next);
      const player = next.players.find((p) => p.id === playerId);
      if (!player) throw new PlayerNotFoundError(worldId, playerId);
      const planet = next.planets.find((p) => p.id === player.homePlanetId);
      if (!planet) throw new PlanetNotFoundError(worldId, player.homePlanetId);
      return {
        resources: planet.resources,
        storageCap: storageCapFor(planet, playerResearchEffects(player)),
        version: next.version,
      };
    });
  }

  /**
   * Remove a player from a world (admin account deletion): the player, their
   * fleets, and their planet ownership are dropped from the aggregate under
   * the world lock, keeping the world consistent.
   */
  async removePlayer(worldId: WorldId, playerId: PlayerId): Promise<void> {
    await this.withLocked(worldId, async (tx, world) => {
      const next = removePlayerFromWorld(world, playerId);
      await tx.saveWorld(next);
    });
  }

  /** Single-planet projection for the planet detail page and image endpoint. */
  async getPlanetView(worldId: WorldId, planetId: PlanetId): Promise<PlanetView> {
    const world = await this.requireWorld(worldId);
    const planet = world.planets.find((p) => p.id === planetId);
    if (!planet) throw new PlanetNotFoundError(worldId, planetId);
    const player = world.players.find((p) => p.id === planet.ownerId);
    const effects = player ? playerResearchEffects(player) : undefined;
    return planetView(planet, effects, planetLocalFleetViews(world, planet));
  }

  /**
   * Player-scoped projection for the web client. When no player id is given
   * (dev/admin and legacy callers) the first player of the world is used.
   *
   * A missing player (e.g. a session whose spawned player was wiped by a
   * world regeneration) is a client-recoverable condition, NOT an internal
   * error: it maps to 404/PLAYER_NOT_FOUND so the web client can drop the
   * stale session instead of 500-ing forever.
   */
  async getWorldView(worldId: WorldId, playerId?: PlayerId): Promise<WorldView> {
    const world = await this.requireWorld(worldId);
    const player = this.playerOf(world, playerId);
    if (!player) {
      throw new PlayerNotFoundError(worldId, playerId);
    }
    const homePlanet = world.planets.find((p) => p.id === player.homePlanetId);
    if (!homePlanet) {
      throw new PlayerNotFoundError(worldId, playerId);
    }
    const effects = playerResearchEffects(player);
    const myPlanets: PlanetView[] = world.planets
      .filter((p) => p.ownerId === player.id)
      .map((p) => planetView(p, effects, planetLocalFleetViews(world, p)));
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
        homePlanet: planetView(homePlanet, effects, planetLocalFleetViews(world, homePlanet)),
      },
      planets: myPlanets,
      research: {
        orders: researchOrderViews(player),
        completed: player.technologies,
        effects,
      },
      fleets: fleetViews(world, player.id),
      intel: scanIntel(player),
      reports: reportViews(world, player.id),
      pendingOrders: pendingOrderViews(world, player.id),
      lastResolution: lastResolutionView,
      version: world.version,
    };
  }

  /** Run a world-mutating command under the per-world lock + repository tx. */
  private async withLocked<T>(
    worldId: WorldId,
    run: (tx: WorldRepository, world: WorldState) => Promise<T>,
  ): Promise<T> {
    const release = await this.lock.acquire(worldId);
    try {
      return await this.repository.withWorldLocked(worldId, async (tx) => {
        const world = await this.requireWorldFrom(tx, worldId);
        return run(tx, world);
      });
    } finally {
      release();
    }
  }

  /**
   * Galaxy map projection: every galaxy, system, and planet in map space,
   * in stable coordinate order. `known` marks the player's owned planets so
   * the map can label them and leave the rest anonymous. Positions are
   * derived deterministically from the seed — never stored.
   */
  async getGalaxyView(worldId: WorldId, playerId?: PlayerId): Promise<GalaxyView> {
    const world = await this.requireWorld(worldId);
    const player = this.playerOf(world, playerId);
    if (!player) {
      throw new PlayerNotFoundError(worldId, playerId);
    }
    // Known worlds: everything the player owns plus everything a scan has
    // revealed (M3) — scans make the chart readable, never private state.
    const knownIds = new Set(world.planets.filter((p) => p.ownerId === player.id).map((p) => p.id));
    for (const report of player.scanReports ?? []) {
      const scanned = world.planets.find(
        (p) =>
          p.coordinate.galaxy === report.target.galaxy &&
          p.coordinate.sector === report.target.sector &&
          p.coordinate.system === report.target.system &&
          p.coordinate.planet === report.target.planet,
      );
      if (scanned) knownIds.add(scanned.id);
    }

    const galaxies: GalaxyView['galaxies'] = [];
    for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
      galaxies.push({
        galaxy,
        position: galaxyOrigin(world.seed, galaxy),
        discRadius: galaxyDiscRadius(world.seed, galaxy),
      });
    }

    const sectors: GalaxyView['sectors'] = [];
    for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
      for (let sector = 1; sector <= WORLD_CONFIG.sectorsPerGalaxy; sector++) {
        const bounds = sectorBounds(world.seed, galaxy, sector);
        sectors.push({
          galaxy,
          sector,
          position: {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          },
          bounds,
          planetCount: WORLD_CONFIG.systemsPerSector * WORLD_CONFIG.planetsPerSystem,
        });
      }
    }

    const systems: GalaxyView['systems'] = [];
    for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
      for (let sector = 1; sector <= WORLD_CONFIG.sectorsPerGalaxy; sector++) {
        for (let system = 1; system <= WORLD_CONFIG.systemsPerSector; system++) {
          systems.push({
            galaxy,
            sector,
            system,
            position: systemPosition(world.seed, galaxy, sector, system),
          });
        }
      }
    }

    const planets: GalaxyView['planets'] = world.planets.map((p) => ({
      id: p.id,
      coordinate: p.coordinate,
      position: planetPosition(world.seed, p.coordinate),
      name: p.name,
      factionId: p.factionId,
      classId: planetClassId(p.id),
      known: knownIds.has(p.id),
    }));

    return {
      worldId: world.id,
      seed: world.seed,
      protocolVersion: PROTOCOL_VERSION,
      config: {
        galaxies: WORLD_CONFIG.galaxies,
        sectorsPerGalaxy: WORLD_CONFIG.sectorsPerGalaxy,
        systemsPerSector: WORLD_CONFIG.systemsPerSector,
        planetsPerSystem: WORLD_CONFIG.planetsPerSystem,
      },
      homePlanetId: player.homePlanetId,
      bounds: galaxyBounds(world.seed),
      galaxies,
      sectors,
      systems,
      planets,
    };
  }

  /** Resolve an API failure into a typed error envelope. */
  toApiError(err: unknown): ApiError {
    if (err instanceof WorldNotFoundError) {
      return apiError('NOT_FOUND', `world ${err.worldId} not found`);
    }
    if (err instanceof PlayerNotFoundError) {
      return apiError(
        'NOT_FOUND',
        `player ${err.playerId ?? '?'} not found in world ${err.worldId}`,
        { worldId: err.worldId, playerId: err.playerId },
      );
    }
    if (err instanceof PlanetNotFoundError) {
      return apiError('NOT_FOUND', `planet ${err.planetId} not found in world ${err.worldId}`);
    }
    if (err instanceof FleetNotFoundError) {
      return apiError('NOT_FOUND', `fleet ${err.fleetId} not found in world ${err.worldId}`);
    }
    if (err instanceof TickOutOfOrderError) {
      return apiError(
        'INTERNAL',
        `tick ${err.tick} is out of order for world ${err.worldId} (resolved through ${err.currentTick})`,
      );
    }
    if (err instanceof AdminDomainError) {
      const adminError = err.adminError;
      if (adminError.code === 'INVALID_GRANT') {
        return apiError('VALIDATION_ERROR', adminError.message);
      }
      return apiError('NOT_FOUND', err.message);
    }
    if (err instanceof CommandRejectedError) {
      return apiError(err.code, err.message, err.details);
    }
    return apiError('INTERNAL', err instanceof Error ? err.message : 'unknown error');
  }

  private async requireWorld(worldId: WorldId): Promise<WorldState> {
    const world = await this.repository.getWorld(worldId);
    if (!world) throw new WorldNotFoundError(worldId);
    return world;
  }

  /** Resolve the acting player: by id when given, else the world's first. */
  private playerOf(world: WorldState, playerId?: PlayerId): Player | undefined {
    if (playerId === undefined) return world.players[0];
    return world.players.find((p) => p.id === playerId);
  }

  private async requireWorldFrom(tx: WorldRepository, worldId: WorldId): Promise<WorldState> {
    const world = await tx.getWorld(worldId);
    if (!world) throw new WorldNotFoundError(worldId);
    return world;
  }
}

export class PlayerNotFoundError extends Error {
  constructor(
    public readonly worldId: WorldId,
    public readonly playerId?: PlayerId,
  ) {
    super(`player ${playerId ?? '?'} not found in world ${worldId}`);
    this.name = 'PlayerNotFoundError';
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

export class FleetNotFoundError extends Error {
  constructor(
    public readonly worldId: WorldId,
    public readonly fleetId: FleetId,
  ) {
    super(`fleet ${fleetId} not found in world ${worldId}`);
    this.name = 'FleetNotFoundError';
  }
}

/**
 * A command that passed envelope validation but failed domain validation
 * (ownership, affordability, queue rules, version). Carries the API error
 * code so `toApiError` can return a typed envelope to the client.
 */
export class CommandRejectedError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

function commandRejectedM2(
  error: ResearchError | ShipyardError | FleetError | MovementError | ScanError,
): CommandRejectedError {
  switch (error.code) {
    case 'PLAYER_NOT_FOUND':
      return new CommandRejectedError('NOT_FOUND', `player ${error.playerId} not found`);
    case 'PLANET_NOT_FOUND':
      return new CommandRejectedError('NOT_FOUND', `planet ${error.planetId} not found`);
    case 'NOT_OWNER': {
      const planetId = 'planetId' in error ? error.planetId : undefined;
      const fleetId = 'fleetId' in error ? error.fleetId : undefined;
      const target = planetId ?? fleetId ?? '?',
        subject = planetId !== undefined ? 'planet' : 'fleet';
      return new CommandRejectedError('NOT_OWNER', `you do not own ${subject} ${target}`);
    }
    case 'HOST_PLANET_REQUIRES_LAB':
      return new CommandRejectedError(
        'HOST_PLANET_REQUIRES_LAB',
        `planet ${error.planetId} has no Research Lab — research runs on a lab`,
      );
    case 'UNKNOWN_TECHNOLOGY':
      return new CommandRejectedError(
        'UNKNOWN_TECHNOLOGY',
        `'${error.technologyId}' is not a known technology`,
      );
    case 'PREREQUISITES_NOT_MET':
      return new CommandRejectedError(
        'PREREQUISITES_NOT_MET',
        `prerequisites not met for ${error.technologyId}: ${error.missing.join(', ')}`,
        { technologyId: error.technologyId, missing: error.missing },
      );
    case 'ALREADY_RESEARCHED':
      return new CommandRejectedError(
        'ALREADY_RESEARCHED',
        `technology ${error.technologyId} is already researched or queued`,
      );
    case 'UNKNOWN_SHIP':
      return new CommandRejectedError('UNKNOWN_SHIP', `'${error.ship}' is not a known ship`);
    case 'SHIP_LOCKED':
      return new CommandRejectedError(
        'SHIP_LOCKED',
        `'${error.ship}' requires research ${error.requiredTechnology}`,
        { ship: error.ship, requiredTechnology: error.requiredTechnology },
      );
    case 'SHIPYARD_REQUIRED':
      return new CommandRejectedError(
        'SHIPYARD_REQUIRED',
        `planet ${error.planetId} needs a Shipyard to build ships`,
      );
    case 'INVALID_QUANTITY':
      return new CommandRejectedError('INVALID_QUANTITY', `invalid quantity ${error.quantity}`);
    case 'QUEUE_FULL':
      return new CommandRejectedError(
        'QUEUE_FULL',
        `the queue is full (${error.capacity} orders)`,
        { capacity: error.capacity },
      );
    case 'INSUFFICIENT_RESOURCES':
      return new CommandRejectedError('INSUFFICIENT_RESOURCES', 'insufficient resources', {
        missing: error.missing,
      });
    case 'STALE_VERSION':
      return new CommandRejectedError(
        'STALE_VERSION',
        `world changed since the envelope was prepared (expected version ${error.expected}, current ${error.actual})`,
        { expected: error.expected, actual: error.actual },
      );
    case 'ORDER_NOT_FOUND':
      return new CommandRejectedError('ORDER_NOT_FOUND', `order ${error.orderId} not found`);
    case 'CANNOT_CANCEL':
      return new CommandRejectedError(
        'CANNOT_CANCEL',
        `order ${error.orderId} cannot be cancelled (${error.status})`,
      );
    case 'FLEET_NOT_FOUND':
      return new CommandRejectedError('FLEET_NOT_FOUND', `fleet ${error.fleetId} not found`);
    case 'CANNOT_TRANSFER_TO_SELF':
      return new CommandRejectedError(
        'CANNOT_TRANSFER_TO_SELF',
        'a fleet cannot transfer to itself',
      );
    case 'FLEETS_NOT_CO_LOCATED':
      return new CommandRejectedError(
        'FLEETS_NOT_CO_LOCATED',
        'fleets must be at the same location to transfer',
      );
    case 'INSUFFICIENT_SHIPS':
      return new CommandRejectedError(
        'INSUFFICIENT_SHIPS',
        `not enough ${error.ship} (have ${error.have}, want ${error.want})`,
      );
    case 'CARGO_CAPACITY_EXCEEDED':
      return new CommandRejectedError(
        'CARGO_CAPACITY_EXCEEDED',
        `cargo would exceed the fleet's capacity (${error.want} > ${error.capacity})`,
        { capacity: error.capacity, want: error.want },
      );
    case 'EMPTY_TRANSFER':
      return new CommandRejectedError('EMPTY_TRANSFER', 'nothing to transfer');
    case 'FLEET_NOT_ORBITING':
      return new CommandRejectedError(
        'FLEET_NOT_ORBITING',
        `fleet ${error.fleetId} is not in orbit — it cannot do that now`,
      );
    case 'EMPTY_FLEET':
      return new CommandRejectedError(
        'EMPTY_FLEET',
        `fleet ${error.fleetId} carries no ships and cannot travel`,
      );
    case 'FLEET_NOT_MOVING':
      return new CommandRejectedError(
        'FLEET_NOT_MOVING',
        `fleet ${error.fleetId} is not in flight`,
      );
    case 'ALREADY_RETURNING':
      return new CommandRejectedError(
        'ALREADY_RETURNING',
        `fleet ${error.fleetId} is already returning home`,
      );
    case 'INVALID_DESTINATION':
      return new CommandRejectedError(
        'INVALID_DESTINATION',
        `coordinate ${error.coordinate.galaxy}:${error.coordinate.sector}:${error.coordinate.system}:${error.coordinate.planet} is outside the world`,
      );
    case 'SAME_LOCATION':
      return new CommandRejectedError(
        'SAME_LOCATION',
        `fleet is already at ${error.coordinate.galaxy}:${error.coordinate.sector}:${error.coordinate.system}:${error.coordinate.planet}`,
      );
    case 'MISSION_UNSUPPORTED':
      return new CommandRejectedError(
        'MISSION_UNSUPPORTED',
        `mission '${error.mission}' is not available yet`,
      );
    case 'INSUFFICIENT_CARGO':
      return new CommandRejectedError(
        'INSUFFICIENT_CARGO',
        `fleet does not hold enough ${error.resource} (have ${error.have}, want ${error.want})`,
        { resource: error.resource, have: error.have, want: error.want },
      );
    case 'SCANNER_REQUIRED':
      return new CommandRejectedError(
        'SCANNER_REQUIRED',
        `planet ${error.planetId} needs a Scanner Array to run scans`,
      );
    case 'SCAN_LOCKED':
      return new CommandRejectedError(
        'SCAN_LOCKED',
        `a ${error.scan} scan needs a Scanner Array at level ${error.requiredScannerLevel}`,
        { scan: error.scan, requiredScannerLevel: error.requiredScannerLevel },
      );
    case 'UNKNOWN_SCAN_KIND':
      return new CommandRejectedError(
        'UNKNOWN_SCAN_KIND',
        `'${error.scan}' is not a known scan kind`,
      );
    case 'CANNOT_SCAN_OWN_PLANET':
      return new CommandRejectedError(
        'CANNOT_SCAN_OWN_PLANET',
        `planet ${error.planetId} is yours — you already know it`,
      );
    case 'OUT_OF_RANGE':
      return new CommandRejectedError(
        'OUT_OF_RANGE',
        `target is out of scan range (${Math.round(error.distance)} map units away, reach ${Math.round(error.range)})`,
        { range: error.range, distance: error.distance },
      );
  }
}

function adminFleetRow(fleet: Fleet): AdminPlayerDetail['fleets'][number] {
  return {
    id: fleet.id,
    ownerId: fleet.ownerId,
    location: fleet.location,
    ships: fleet.ships,
    cargo: fleet.cargo,
    state: fleet.state,
    mission: fleet.mission,
    departureTick: fleet.departureTick,
    arrivalTick: fleet.arrivalTick,
  };
}

function commandRejected(error: ConstructionError): CommandRejectedError {
  switch (error.code) {
    case 'PLANET_NOT_FOUND':
      return new CommandRejectedError('NOT_FOUND', `planet ${error.planetId} not found`);
    case 'NOT_OWNER':
      return new CommandRejectedError('NOT_OWNER', `you do not own planet ${error.planetId}`);
    case 'UNKNOWN_BUILDING':
      return new CommandRejectedError(
        'UNKNOWN_BUILDING',
        `'${error.building}' is not a known building`,
      );
    case 'MAX_LEVEL_REACHED':
      return new CommandRejectedError(
        'MAX_LEVEL_REACHED',
        `${error.building} is at level ${error.level} (max ${error.maxLevel})`,
        { building: error.building, level: error.level, maxLevel: error.maxLevel },
      );
    case 'QUEUE_FULL':
      return new CommandRejectedError(
        'QUEUE_FULL',
        `the construction queue is full (${error.capacity} orders)`,
        { capacity: error.capacity },
      );
    case 'INSUFFICIENT_RESOURCES':
      return new CommandRejectedError(
        'INSUFFICIENT_RESOURCES',
        'insufficient resources on this planet',
        {
          missing: error.missing,
        },
      );
    case 'STALE_VERSION':
      return new CommandRejectedError(
        'STALE_VERSION',
        `world changed since the envelope was prepared (expected version ${error.expected}, current ${error.actual})`,
        { expected: error.expected, actual: error.actual },
      );
    case 'ORDER_NOT_FOUND':
      return new CommandRejectedError('ORDER_NOT_FOUND', `order ${error.orderId} not found`);
    case 'CANNOT_CANCEL':
      return new CommandRejectedError(
        'CANNOT_CANCEL',
        `order ${error.orderId} cannot be cancelled (${error.status})`,
      );
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
