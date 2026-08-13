import {
  emptyResourceStore,
  orderId,
  RESOURCE_KEYS,
  type Coordinate,
  type Fleet,
  type FleetId,
  type FleetOpReceipt,
  type PlayerId,
  type ResourceRates,
  type ResourceStore,
  type WorldState,
} from '@ashes/contracts';
import { M3_MISSION_KINDS } from '@ashes/contracts';
import { WORLD_CONFIG } from '@ashes/content';
import type {
  LoadCargoCommand,
  RecallFleetCommand,
  SendFleetCommand,
  UnloadCargoCommand,
} from '@ashes/contracts';
import { fleetCargoCapacity } from './fleet';
import { storageCapFor } from './economy';
import { coordinateDistance, fleetDriveTier, travelTicks } from './travel';
import { playerResearchEffects } from './research';

/**
 * Fleet movement (DEVELOPMENT_PLAN.md §5, M3): the mission state machine that
 * consumes the M2 `travelTicks` calculation. A fleet is sent from orbit to a
 * destination coordinate; it stays at its origin while `moving` and snaps to
 * the destination on the arrival tick (resolved at tick boundaries, like
 * every queue). A moving fleet can be recalled before arrival — it turns
 * around and returns to its origin, with the return trip proportional to how
 * far along the outbound route it had travelled. Cargo load/unload moves
 * resources between an owned planet's store and an orbiting fleet's hold.
 *
 * Every operation is a pure, validated state transition that records an
 * immutable receipt keyed by its idempotency key, so a retried command can
 * never duplicate a send, a recall, or a cargo movement.
 */

export type MovementError =
  | { code: 'PLAYER_NOT_FOUND'; playerId: PlayerId }
  | { code: 'PLANET_NOT_FOUND'; planetId: string }
  | { code: 'NOT_OWNER'; fleetId?: string; planetId?: string }
  | { code: 'FLEET_NOT_FOUND'; fleetId: string }
  | { code: 'FLEET_NOT_ORBITING'; fleetId: string }
  | { code: 'EMPTY_FLEET'; fleetId: string }
  | { code: 'FLEET_NOT_MOVING'; fleetId: string }
  | { code: 'ALREADY_RETURNING'; fleetId: string }
  | { code: 'INVALID_DESTINATION'; coordinate: Coordinate }
  | { code: 'SAME_LOCATION'; coordinate: Coordinate }
  | { code: 'MISSION_UNSUPPORTED'; mission: string }
  | { code: 'INVALID_QUANTITY'; resource: string; quantity: number }
  | { code: 'EMPTY_TRANSFER' }
  | { code: 'CARGO_CAPACITY_EXCEEDED'; capacity: number; want: number }
  | { code: 'INSUFFICIENT_RESOURCES'; missing: Partial<ResourceRates> }
  | { code: 'INSUFFICIENT_CARGO'; resource: string; have: number; want: number }
  | { code: 'STALE_VERSION'; expected: number; actual: number };

export type MovementOpResult =
  { ok: true; world: WorldState; receipt: FleetOpReceipt } | { ok: false; error: MovementError };

type OpInput = {
  actorId: PlayerId;
  idempotencyKey: string;
  expectedVersion: number;
};

/** Is this coordinate inside the world's finite `galaxy:sector:system:planet` space? */
export function isCoordinateInWorld(coord: Coordinate): boolean {
  return (
    coord.galaxy >= 1 &&
    coord.galaxy <= WORLD_CONFIG.galaxies &&
    coord.sector >= 1 &&
    coord.sector <= WORLD_CONFIG.sectorsPerGalaxy &&
    coord.system >= 1 &&
    coord.system <= WORLD_CONFIG.systemsPerSector &&
    coord.planet >= 1 &&
    coord.planet <= WORLD_CONFIG.planetsPerSystem
  );
}

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return (
    a.galaxy === b.galaxy && a.sector === b.sector && a.system === b.system && a.planet === b.planet
  );
}

/** The planet at a coordinate (every coordinate in the finite space has one). */
function planetAt(world: WorldState, coord: Coordinate) {
  return world.planets.find(
    (p) =>
      p.coordinate.galaxy === coord.galaxy &&
      p.coordinate.sector === coord.sector &&
      p.coordinate.system === coord.system &&
      p.coordinate.planet === coord.planet,
  );
}

function fleetOf(world: WorldState, fleetId: FleetId): Fleet | undefined {
  return world.fleets.find((f) => f.id === fleetId);
}

/** Navigation effects of the acting player (drives travel speed). */
function navigationBonus(world: WorldState, playerId: PlayerId): number {
  const player = world.players.find((p) => p.id === playerId);
  if (!player) return 0;
  return playerResearchEffects(player).navigationSpeedBonus;
}

/**
 * Accept a SendFleet command: validate ownership, orbit state, a non-empty
 * hull, a real in-world destination, and a supported mission kind; compute
 * the deterministic route (distance ÷ drive speed × navigation bonus) and
 * put the fleet in flight. Idempotent per idempotency key.
 */
export function submitSendFleet(
  world: WorldState,
  input: OpInput & { command: SendFleetCommand },
  submittedAt: number,
): MovementOpResult {
  const { fleetId, destination, mission } = input.command;
  const fleet = fleetOf(world, fleetId);
  if (!fleet) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId } };
  if (fleet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  if (fleet.state !== 'orbiting') {
    return { ok: false, error: { code: 'FLEET_NOT_ORBITING', fleetId } };
  }
  if (Object.values(fleet.ships).every((n) => (n ?? 0) === 0)) {
    return { ok: false, error: { code: 'EMPTY_FLEET', fleetId } };
  }
  if (!isCoordinateInWorld(destination)) {
    return { ok: false, error: { code: 'INVALID_DESTINATION', coordinate: destination } };
  }
  if (sameCoordinate(destination, fleet.location)) {
    return { ok: false, error: { code: 'SAME_LOCATION', coordinate: destination } };
  }
  if (!(M3_MISSION_KINDS as readonly string[]).includes(mission)) {
    return { ok: false, error: { code: 'MISSION_UNSUPPORTED', mission } };
  }

  const distance = coordinateDistance(world.seed, fleet.location, destination);
  const travel = travelTicks({
    distance,
    driveTier: fleetDriveTier(fleet),
    navigationSpeedBonus: navigationBonus(world, input.actorId),
  });
  const arrivalTick = world.tick + travel;

  const moving: Fleet = {
    ...fleet,
    state: 'moving',
    mission: { kind: mission, destination, departureTick: world.tick, arrivalTick },
    departureTick: world.tick,
    arrivalTick,
    route: [destination],
    version: fleet.version + 1,
  };
  const receipt = movementReceipt(input, 'send', submittedAt, world.tick, fleetId);

  return {
    ok: true,
    world: {
      ...world,
      fleets: world.fleets.map((f) => (f.id === fleetId ? moving : f)),
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/**
 * Accept a RecallFleet command: turn a moving fleet around before arrival.
 * The return trip is proportional to outbound progress — the fleet is
 * `p = (tick − departure) / (arrival − departure)` of the way there, so it
 * travels `p × distance` back at the same drive speed. A fleet recalled
 * right after leaving gets home in one tick; one recalled just before
 * arrival travels most of the way home. Idempotent per key.
 */
export function submitRecallFleet(
  world: WorldState,
  input: OpInput & { command: RecallFleetCommand },
  submittedAt: number,
): MovementOpResult {
  const { fleetId } = input.command;
  const fleet = fleetOf(world, fleetId);
  if (!fleet) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId } };
  if (fleet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  if (fleet.state === 'returning') {
    return { ok: false, error: { code: 'ALREADY_RETURNING', fleetId } };
  }
  if (fleet.state !== 'moving' || fleet.mission === null || fleet.departureTick === null) {
    return { ok: false, error: { code: 'FLEET_NOT_MOVING', fleetId } };
  }

  const mission = fleet.mission;
  const outbound = coordinateDistance(world.seed, fleet.location, mission.destination);
  const span = mission.arrivalTick - mission.departureTick;
  const progress =
    span <= 0 ? 1 : Math.min(1, Math.max(0, (world.tick - mission.departureTick) / span));
  const returnDistance = outbound * progress;
  const returnTicks = travelTicks({
    distance: returnDistance,
    driveTier: fleetDriveTier(fleet),
    navigationSpeedBonus: navigationBonus(world, input.actorId),
  });
  const arrivalTick = world.tick + returnTicks;
  // The fleet's location is still its origin while in flight — that is home.
  const origin = fleet.location;
  const returning: Fleet = {
    ...fleet,
    state: 'returning',
    mission: { kind: 'return', destination: origin, departureTick: world.tick, arrivalTick },
    departureTick: world.tick,
    arrivalTick,
    route: [origin],
    version: fleet.version + 1,
  };
  const receipt = movementReceipt(input, 'recall', submittedAt, world.tick, fleetId);

  return {
    ok: true,
    world: {
      ...world,
      fleets: world.fleets.map((f) => (f.id === fleetId ? returning : f)),
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/**
 * Accept a LoadCargo command: move resources from the store of the owned
 * planet at the fleet's location into the fleet's cargo hold. The load is
 * bounded by the fleet's cargo capacity (sum of its ships' capacities) minus
 * what it already holds, and by what the planet actually has.
 */
export function submitLoadCargo(
  world: WorldState,
  input: OpInput & { command: LoadCargoCommand },
  submittedAt: number,
): MovementOpResult {
  const { fleetId, resources } = input.command;
  const fleet = fleetOf(world, fleetId);
  if (!fleet) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId } };
  if (fleet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  if (fleet.state !== 'orbiting') {
    return { ok: false, error: { code: 'FLEET_NOT_ORBITING', fleetId } };
  }
  const planet = planetAt(world, fleet.location);
  if (!planet) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId: '' } };
  if (planet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId: planet.id } };
  }

  const want = normalizeResources(resources);
  if (!want.ok) return want;

  const held = RESOURCE_KEYS.reduce((sum, r) => sum + fleet.cargo[r], 0);
  const load = RESOURCE_KEYS.reduce((sum, r) => sum + want.value[r], 0);
  const capacity = fleetCargoCapacity(fleet);
  if (held + load > capacity) {
    return {
      ok: false,
      error: { code: 'CARGO_CAPACITY_EXCEEDED', capacity, want: held + load },
    };
  }
  const missing: Partial<ResourceRates> = {};
  let short = false;
  for (const r of RESOURCE_KEYS) {
    if (planet.resources[r] < want.value[r]) {
      missing[r] = want.value[r] - planet.resources[r];
      short = true;
    }
  }
  if (short) return { ok: false, error: { code: 'INSUFFICIENT_RESOURCES', missing } };

  const planetResources: ResourceStore = { ...planet.resources };
  const fleetCargo: ResourceStore = { ...fleet.cargo };
  for (const r of RESOURCE_KEYS) {
    planetResources[r] -= want.value[r];
    fleetCargo[r] += want.value[r];
  }
  const receipt = movementReceipt(input, 'load', submittedAt, world.tick, fleetId);

  return {
    ok: true,
    world: {
      ...world,
      planets: world.planets.map((p) =>
        p.id === planet.id ? { ...p, resources: planetResources, version: p.version + 1 } : p,
      ),
      fleets: world.fleets.map((f) =>
        f.id === fleetId ? { ...f, cargo: fleetCargo, version: f.version + 1 } : f,
      ),
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/**
 * Accept an UnloadCargo command: move resources from the fleet's cargo hold
 * back into the store of the owned planet at its location. The store addition
 * is clamped at the planet's storage cap — the same policy as every other
 * store addition (refunds, arrivals) — so an unloading fleet can never push a
 * planet past its cap.
 */
export function submitUnloadCargo(
  world: WorldState,
  input: OpInput & { command: UnloadCargoCommand },
  submittedAt: number,
): MovementOpResult {
  const { fleetId, resources } = input.command;
  const fleet = fleetOf(world, fleetId);
  if (!fleet) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId } };
  if (fleet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  if (fleet.state !== 'orbiting') {
    return { ok: false, error: { code: 'FLEET_NOT_ORBITING', fleetId } };
  }
  const planet = planetAt(world, fleet.location);
  if (!planet) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId: '' } };
  if (planet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId: planet.id } };
  }

  const want = normalizeResources(resources);
  if (!want.ok) return want;

  for (const r of RESOURCE_KEYS) {
    if (fleet.cargo[r] < want.value[r]) {
      return {
        ok: false,
        error: {
          code: 'INSUFFICIENT_CARGO',
          resource: r,
          have: fleet.cargo[r],
          want: want.value[r],
        },
      };
    }
  }

  const fleetCargo: ResourceStore = { ...fleet.cargo };
  const planetResources: ResourceStore = { ...planet.resources };
  const cap = storageCapFor(planet);
  for (const r of RESOURCE_KEYS) {
    fleetCargo[r] -= want.value[r];
    planetResources[r] = Math.min(cap, planetResources[r] + want.value[r]);
  }
  const receipt = movementReceipt(input, 'unload', submittedAt, world.tick, fleetId);

  return {
    ok: true,
    world: {
      ...world,
      planets: world.planets.map((p) =>
        p.id === planet.id ? { ...p, resources: planetResources, version: p.version + 1 } : p,
      ),
      fleets: world.fleets.map((f) =>
        f.id === fleetId ? { ...f, cargo: fleetCargo, version: f.version + 1 } : f,
      ),
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/** Normalize a partial resource request into a full store; validates amounts. */
function normalizeResources(
  resources: Partial<ResourceRates>,
): { ok: true; value: ResourceStore } | { ok: false; error: MovementError } {
  const value = emptyResourceStore();
  let any = false;
  for (const r of RESOURCE_KEYS) {
    const amount = resources[r] ?? 0;
    if (amount < 0 || !Number.isInteger(amount)) {
      return { ok: false, error: { code: 'INVALID_QUANTITY', resource: r, quantity: amount } };
    }
    value[r] = amount;
    if (amount > 0) any = true;
  }
  if (!any) return { ok: false, error: { code: 'EMPTY_TRANSFER' } };
  return { ok: true, value };
}

function movementReceipt(
  input: OpInput,
  kind: 'send' | 'recall' | 'load' | 'unload',
  submittedAt: number,
  submittedTick: number,
  fleetId: FleetId,
): FleetOpReceipt {
  return {
    id: orderId(`fleetop:${input.idempotencyKey}`),
    idempotencyKey: input.idempotencyKey,
    kind,
    actorId: input.actorId,
    submittedAt,
    submittedTick,
    expectedVersion: input.expectedVersion,
    fromFleetId: fleetId,
    toFleetId: null,
    newFleetId: null,
  };
}

/**
 * The movement resolution phase: every fleet whose arrival tick is THIS tick
 * snaps to its mission destination and returns to orbit. Runs after the
 * queues (economy → research → construction → shipyard → movement), so a
 * fleet sent on tick N and arriving on tick N+2 is in flight during N+1 and
 * docks at N+2. Re-resolving an already-resolved tick finds no fleet with a
 * matching arrival tick — arrivals resolve exactly once.
 */
export function resolveMovementTick(world: WorldState, tick: number): WorldState {
  const arrivals = world.fleets
    .filter((f) => (f.state === 'moving' || f.state === 'returning') && f.arrivalTick === tick)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (arrivals.length === 0) return world;

  const arrivingIds = new Set(arrivals.map((f) => f.id));
  const fleets = world.fleets.map((f) => {
    if (!arrivingIds.has(f.id)) return f;
    const mission = f.mission;
    return {
      ...f,
      location: mission ? mission.destination : f.location,
      state: 'orbiting' as const,
      mission: null,
      departureTick: null,
      arrivalTick: null,
      route: [],
      version: f.version + 1,
    };
  });

  return { ...world, fleets };
}
