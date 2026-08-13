import {
  emptyResourceStore,
  fleetId,
  orderId,
  RESOURCE_KEYS,
  type Fleet,
  type FleetId,
  type FleetOpReceipt,
  type FleetOpReceiptResult,
  type FleetView,
  type PlayerId,
  type ResourceRates,
  type ResourceStore,
  type ShipKind,
  type ShipStacks,
  type WorldState,
} from '@ashes/contracts';
import { SHIP_DEFINITIONS } from '@ashes/content';
import type { SplitFleetCommand, TransferFleetCommand } from '@ashes/contracts';
import { fleetDriveTier } from './travel';

/**
 * Fleet management (DEVELOPMENT_PLAN.md §5, M2): the fleet inventory and the
 * local transfer/split/merge rules. In M2 fleets stay in orbit at a planet —
 * a player splits ships off a fleet into a new detachment, or transfers ships
 * and cargo between fleets at the same location. Every operation is a pure,
 * validated state transition that records an immutable receipt keyed by its
 * idempotency key, so a retried command can never duplicate ships or cargo.
 */

export type FleetError =
  | { code: 'FLEET_NOT_FOUND'; fleetId: string }
  | { code: 'NOT_OWNER'; fleetId: string }
  | { code: 'CANNOT_TRANSFER_TO_SELF' }
  | { code: 'FLEETS_NOT_CO_LOCATED' }
  | { code: 'INSUFFICIENT_SHIPS'; ship: ShipKind; have: number; want: number }
  | { code: 'INVALID_QUANTITY'; ship: ShipKind; quantity: number }
  | { code: 'CARGO_CAPACITY_EXCEEDED'; capacity: number; want: number }
  | { code: 'EMPTY_TRANSFER' }
  | { code: 'STALE_VERSION'; expected: number; actual: number };

export type FleetOpResult =
  { ok: true; world: WorldState; receipt: FleetOpReceipt } | { ok: false; error: FleetError };

/** The planet's local fleet id — the shipyard's delivery dock. */
export function localFleetId(planetId: string): FleetId {
  return fleetId(`fleet:${planetId}`);
}

/** The player-visible fleet inventory, in stable (owner, home, id) order. */
export function fleetViews(world: WorldState, playerId: PlayerId): FleetView[] {
  const nameById = new Map(world.planets.map((p) => [p.id, p.name]));
  return world.fleets
    .filter((f) => f.ownerId === playerId)
    .sort((a, b) => {
      const aHome = a.homePlanetId ?? '';
      const bHome = b.homePlanetId ?? '';
      return aHome.localeCompare(bHome) || a.id.localeCompare(b.id);
    })
    .map((f) => fleetView(f, nameById));
}

export function fleetView(fleet: Fleet, planetNames?: Map<string, string>): FleetView {
  const homeName = fleet.homePlanetId ? planetNames?.get(fleet.homePlanetId) : undefined;
  return {
    id: fleet.id,
    name:
      fleet.homePlanetId === null
        ? `Detachment ${fleet.id.split(':').at(-1)?.slice(0, 8)}`
        : `Local fleet — ${homeName ?? fleet.homePlanetId}`,
    ownerId: fleet.ownerId,
    homePlanetId: fleet.homePlanetId,
    location: fleet.location,
    state: fleet.state,
    ships: fleet.ships,
    cargo: fleet.cargo,
    driveTier: fleetDriveTier(fleet),
    mission: fleet.mission,
    departureTick: fleet.departureTick,
    arrivalTick: fleet.arrivalTick,
    cargoCapacity: fleetCargoCapacity(fleet),
  };
}

/** Total cargo capacity of a fleet (sum over its ships' cargo capacities). */
export function fleetCargoCapacity(fleet: Fleet): number {
  let capacity = 0;
  for (const [kind, count] of Object.entries(fleet.ships) as Array<
    [ShipKind, number | undefined]
  >) {
    capacity += (SHIP_DEFINITIONS[kind]?.cargoCapacity ?? 0) * (count ?? 0);
  }
  return capacity;
}

/**
 * Split a fleet: move the given ships out of the source fleet into a brand
 * new detachment at the same location. The new fleet's homePlanetId is null
 * (it is a detachment, not the planet's local fleet). Idempotent per key.
 */
export function splitFleet(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: SplitFleetCommand;
  },
  submittedAt: number,
): FleetOpResult {
  const { fleetId: sourceId, ships } = input.command;
  const source = world.fleets.find((f) => f.id === sourceId);
  if (!source) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId: sourceId } };
  if (source.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId: sourceId } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  const toMove: ShipStacks = {};
  for (const [kind, count] of Object.entries(ships) as Array<[ShipKind, number | undefined]>) {
    const want = count ?? 0;
    const have = source.ships[kind] ?? 0;
    if (want < 0 || !Number.isInteger(want)) {
      return { ok: false, error: { code: 'INVALID_QUANTITY', ship: kind, quantity: want } };
    }
    if (want > 0) {
      if (have < want) {
        return { ok: false, error: { code: 'INSUFFICIENT_SHIPS', ship: kind, have, want } };
      }
      toMove[kind] = want;
    }
  }
  if (Object.keys(toMove).length === 0) {
    return { ok: false, error: { code: 'EMPTY_TRANSFER' } };
  }

  const sourceShips = { ...source.ships };
  for (const [kind, count] of Object.entries(toMove) as Array<[ShipKind, number]>) {
    const left = (sourceShips[kind] ?? 0) - count;
    if (left <= 0) delete sourceShips[kind];
    else sourceShips[kind] = left;
  }

  const newFleet: Fleet = {
    id: fleetId(`fleet:${input.idempotencyKey}`),
    ownerId: input.actorId,
    homePlanetId: null,
    location: source.location,
    state: 'orbiting',
    ships: toMove,
    cargo: emptyResourceStore(),
    troops: 0,
    mission: null,
    departureTick: null,
    arrivalTick: null,
    route: [],
    version: 1,
  };

  const receipt: FleetOpReceipt = {
    id: orderId(`fleetop:${input.idempotencyKey}`),
    idempotencyKey: input.idempotencyKey,
    kind: 'split',
    actorId: input.actorId,
    submittedAt,
    submittedTick: world.tick,
    expectedVersion: input.expectedVersion,
    fromFleetId: source.id,
    toFleetId: null,
    newFleetId: newFleet.id,
  };

  return {
    ok: true,
    world: {
      ...world,
      fleets: [
        ...world.fleets.map((f) =>
          f.id === source.id ? { ...f, ships: sourceShips, version: f.version + 1 } : f,
        ),
        newFleet,
      ],
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/**
 * Transfer ships and/or cargo between two fleets at the same location. The
 * target's cargo capacity (sum of its ships' capacities) bounds how much
 * cargo can move. Covers merging (transfer everything into the other fleet)
 * and redistribution between co-located fleets. Idempotent per key.
 */
export function transferFleet(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: TransferFleetCommand;
  },
  submittedAt: number,
): FleetOpResult {
  const { fromFleetId, toFleetId, ships, cargo } = input.command;
  if (fromFleetId === toFleetId) {
    return { ok: false, error: { code: 'CANNOT_TRANSFER_TO_SELF' } };
  }
  const from = world.fleets.find((f) => f.id === fromFleetId);
  if (!from) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId: fromFleetId } };
  if (from.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId: fromFleetId } };
  }
  const to = world.fleets.find((f) => f.id === toFleetId);
  if (!to) return { ok: false, error: { code: 'FLEET_NOT_FOUND', fleetId: toFleetId } };
  if (to.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', fleetId: toFleetId } };
  }
  // Co-location rule: fleets must share a coordinate to transfer.
  const sameLocation =
    from.location.galaxy === to.location.galaxy &&
    from.location.sector === to.location.sector &&
    from.location.system === to.location.system &&
    from.location.planet === to.location.planet;
  if (!sameLocation) {
    return { ok: false, error: { code: 'FLEETS_NOT_CO_LOCATED' } };
  }

  const existing = world.fleetOps.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, receipt: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  const toMoveShips: ShipStacks = {};
  for (const [kind, count] of Object.entries(ships ?? {}) as Array<
    [ShipKind, number | undefined]
  >) {
    const want = count ?? 0;
    const have = from.ships[kind] ?? 0;
    if (want < 0 || !Number.isInteger(want)) {
      return { ok: false, error: { code: 'INVALID_QUANTITY', ship: kind, quantity: want } };
    }
    if (want > 0) {
      if (have < want) {
        return { ok: false, error: { code: 'INSUFFICIENT_SHIPS', ship: kind, have, want } };
      }
      toMoveShips[kind] = want;
    }
  }

  const cargoIn = (cargo ?? {}) as Partial<ResourceRates>;
  const cargoUnits = RESOURCE_KEYS.reduce((sum, r) => sum + (cargoIn[r] ?? 0), 0);

  const fromShips = { ...from.ships };
  for (const [kind, count] of Object.entries(toMoveShips) as Array<[ShipKind, number]>) {
    const left = (fromShips[kind] ?? 0) - count;
    if (left <= 0) delete fromShips[kind];
    else fromShips[kind] = left;
  }
  const toShips = { ...to.ships };
  for (const [kind, count] of Object.entries(toMoveShips) as Array<[ShipKind, number]>) {
    toShips[kind] = (toShips[kind] ?? 0) + count;
  }

  if (Object.keys(toMoveShips).length === 0 && cargoUnits === 0) {
    return { ok: false, error: { code: 'EMPTY_TRANSFER' } };
  }
  // Cargo cannot exceed what the source actually holds.
  for (const r of RESOURCE_KEYS) {
    const want = cargoIn[r] ?? 0;
    if (want > from.cargo[r]) {
      return {
        ok: false,
        error: { code: 'CARGO_CAPACITY_EXCEEDED', capacity: from.cargo[r], want },
      };
    }
  }
  // Cargo transfer is bounded by the target's cargo capacity AFTER the
  // transferred ships dock (they contribute their own capacity) MINUS what
  // the target already holds: the resulting load may never exceed the hold.
  const targetCapacityAfter = fleetCargoCapacity({ ...to, ships: toShips } as Fleet);
  const toCargoUnits = RESOURCE_KEYS.reduce((sum, r) => sum + to.cargo[r], 0);
  const resultingLoad = toCargoUnits + cargoUnits;
  if (resultingLoad > targetCapacityAfter) {
    return {
      ok: false,
      error: {
        code: 'CARGO_CAPACITY_EXCEEDED',
        capacity: targetCapacityAfter,
        want: resultingLoad,
      },
    };
  }

  const fromCargo: ResourceStore = { ...from.cargo };
  const toCargo: ResourceStore = { ...to.cargo };
  for (const r of RESOURCE_KEYS) {
    const amount = cargoIn[r] ?? 0;
    fromCargo[r] -= amount;
    toCargo[r] += amount;
  }

  const receipt: FleetOpReceipt = {
    id: orderId(`fleetop:${input.idempotencyKey}`),
    idempotencyKey: input.idempotencyKey,
    kind: 'transfer',
    actorId: input.actorId,
    submittedAt,
    submittedTick: world.tick,
    expectedVersion: input.expectedVersion,
    fromFleetId: from.id,
    toFleetId: to.id,
    newFleetId: null,
  };

  return {
    ok: true,
    world: {
      ...world,
      fleets: world.fleets.map((f) => {
        if (f.id === from.id)
          return { ...f, ships: fromShips, cargo: fromCargo, version: f.version + 1 };
        if (f.id === to.id) return { ...f, ships: toShips, cargo: toCargo, version: f.version + 1 };
        return f;
      }),
      fleetOps: [...world.fleetOps, receipt],
      version: world.version + 1,
    },
    receipt,
  };
}

/** Rebuild a fleet op receipt's result views from current state (replay). */
export function fleetOpResultFrom(
  world: WorldState,
  receipt: FleetOpReceipt,
): FleetOpReceiptResult {
  const planetNames = new Map(world.planets.map((p) => [p.id, p.name]));
  if (receipt.kind === 'split') {
    const fleet = world.fleets.find((f) => f.id === receipt.newFleetId);
    return {
      op: 'split',
      fleet: fleet ? fleetView(fleet, planetNames) : emptyFleetView(receipt.newFleetId!),
    };
  }
  if (receipt.kind === 'transfer') {
    const from = world.fleets.find((f) => f.id === receipt.fromFleetId);
    const to = world.fleets.find((f) => f.id === receipt.toFleetId);
    return {
      op: 'transfer',
      from: from ? fleetView(from, planetNames) : emptyFleetView(receipt.fromFleetId),
      to: to ? fleetView(to, planetNames) : emptyFleetView(receipt.toFleetId ?? ''),
    };
  }
  // Movement ops (M3): send/recall/load/unload — the result is the fleet view.
  const fleet = world.fleets.find((f) => f.id === receipt.fromFleetId);
  return {
    op: receipt.kind as 'send' | 'recall' | 'load' | 'unload',
    fleet: fleet ? fleetView(fleet, planetNames) : emptyFleetView(receipt.fromFleetId),
  };
}

function emptyFleetView(id: FleetId | string): FleetView {
  return {
    id: id as FleetId,
    name: 'Fleet',
    ownerId: '' as PlayerId,
    homePlanetId: null,
    location: { galaxy: 0, sector: 0, system: 0, planet: 0 },
    state: 'orbiting',
    ships: {},
    cargo: emptyResourceStore(),
    driveTier: 'planetary',
    mission: null,
    departureTick: null,
    arrivalTick: null,
    cargoCapacity: 0,
  };
}
