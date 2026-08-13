import {
  emptyResourceStore,
  fleetId,
  orderId,
  planetId,
  RESOURCE_KEYS,
  type Coordinate,
  type Fleet,
  type PlayerId,
  type ResourceRates,
  type ResourceStore,
  type ShipKind,
  type ShipyardOrder,
  type ShipyardOrderView,
  type WorldState,
} from '@ashes/contracts';
import { SHIP_DEFINITIONS, SHIPYARD } from '@ashes/content';
import type { CancelShipOrderCommand, QueueShipCommand } from '@ashes/contracts';
import { storageCapFor } from './economy';

/**
 * Shipyard queue (DEVELOPMENT_PLAN.md §4-5, M2): a per-planet production
 * queue fed by the Shipyard building. Costs are reserved (deducted) at
 * submission from the planet's store; one order builds at a time, the rest
 * queue FIFO. When an order completes at a tick boundary its ships enter the
 * planet's local fleet exactly once — the order flips to `completed` and can
 * never produce again (the M2 acceptance test).
 */

export type ShipyardError =
  | { code: 'PLAYER_NOT_FOUND'; playerId: PlayerId }
  | { code: 'PLANET_NOT_FOUND'; planetId: string }
  | { code: 'NOT_OWNER'; planetId: string }
  | { code: 'UNKNOWN_SHIP'; ship: string }
  | { code: 'SHIP_LOCKED'; ship: ShipKind; requiredTechnology: string }
  | { code: 'SHIPYARD_REQUIRED'; planetId: string }
  | { code: 'INVALID_QUANTITY'; quantity: number }
  | { code: 'QUEUE_FULL'; capacity: number }
  | { code: 'INSUFFICIENT_RESOURCES'; missing: Partial<ResourceRates> }
  | { code: 'STALE_VERSION'; expected: number; actual: number }
  | { code: 'ORDER_NOT_FOUND'; orderId: string }
  | { code: 'CANNOT_CANCEL'; orderId: string; status: ShipyardOrder['status'] };

export type ShipyardResult =
  { ok: true; world: WorldState; order: ShipyardOrder } | { ok: false; error: ShipyardError };

/** Orders still occupying the planet's shipyard queue. */
export function activeShipOrders(planet: {
  shipyardOrders: ShipyardOrder[];
}): Array<ShipyardOrder & { status: 'building' | 'queued' }> {
  return planet.shipyardOrders.filter(isActive);
}

function isActive(o: ShipyardOrder): o is ShipyardOrder & { status: 'building' | 'queued' } {
  return o.status === 'building' || o.status === 'queued';
}

/** Full cost of an order: per-hull cost × quantity, as a complete store. */
export function shipOrderCost(ship: ShipKind, quantity: number): ResourceStore {
  const def = SHIP_DEFINITIONS[ship];
  const cost = emptyResourceStore();
  for (const r of RESOURCE_KEYS) {
    cost[r] = (def.cost[r] ?? 0) * quantity;
  }
  return cost;
}

/**
 * Accept a QueueShip command: validate ownership, shipyard, technology gate,
 * quantity, queue capacity, and affordability; reserve (deduct) the cost; and
 * append the order. Idempotent per idempotency key.
 */
export function submitQueueShip(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: QueueShipCommand;
  },
  submittedAt: number,
): ShipyardResult {
  const { planetId, ship, quantity } = input.command;
  const planet = world.planets.find((p) => p.id === planetId);
  if (!planet) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId } };
  if (planet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId } };
  }

  const def = SHIP_DEFINITIONS[ship];
  if (!def) return { ok: false, error: { code: 'UNKNOWN_SHIP', ship } };
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, error: { code: 'INVALID_QUANTITY', quantity } };
  }

  // A Shipyard building is required to produce ships on this planet.
  if ((planet.buildings.shipyard ?? 0) < 1) {
    return { ok: false, error: { code: 'SHIPYARD_REQUIRED', planetId } };
  }

  const player = world.players.find((p) => p.id === input.actorId);
  if (!player) return { ok: false, error: { code: 'PLAYER_NOT_FOUND', playerId: input.actorId } };
  if (def.requiredTechnology && !player.technologies.includes(def.requiredTechnology)) {
    return {
      ok: false,
      error: {
        code: 'SHIP_LOCKED',
        ship,
        requiredTechnology: def.requiredTechnology,
      },
    };
  }

  const existing = planet.shipyardOrders.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, order: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  const active = activeShipOrders(planet);
  if (active.length >= SHIPYARD.queueCapacity) {
    return { ok: false, error: { code: 'QUEUE_FULL', capacity: SHIPYARD.queueCapacity } };
  }

  const cost = shipOrderCost(ship, quantity);
  const missing: Partial<ResourceRates> = {};
  let short = false;
  for (const r of RESOURCE_KEYS) {
    if (planet.resources[r] < cost[r]) {
      missing[r] = cost[r] - planet.resources[r];
      short = true;
    }
  }
  if (short) return { ok: false, error: { code: 'INSUFFICIENT_RESOURCES', missing } };

  const resources: ResourceStore = { ...planet.resources };
  for (const r of RESOURCE_KEYS) {
    resources[r] -= cost[r];
  }

  const order: ShipyardOrder = {
    id: orderId(`order:${input.idempotencyKey}`),
    kind: 'ship',
    planetId,
    actorId: input.actorId,
    ship,
    quantity,
    submittedAt,
    submittedTick: world.tick,
    startTick: active.length === 0 ? world.tick : null,
    ticksRemaining: def.buildTicks,
    cost,
    status: active.length === 0 ? 'building' : 'queued',
    completedAtTick: null,
    cancelledAtTick: null,
    idempotencyKey: input.idempotencyKey,
    expectedVersion: input.expectedVersion,
  };

  const next: WorldState = {
    ...world,
    planets: world.planets.map((p) =>
      p.id === planetId
        ? {
            ...p,
            resources,
            shipyardOrders: [...p.shipyardOrders, order],
            version: p.version + 1,
          }
        : p,
    ),
    version: world.version + 1,
  };
  return { ok: true, world: next, order };
}

/**
 * Cancel a queued/in-progress ship order: refund the reserved cost (clamped
 * at the storage cap) and mark the order cancelled. Completed orders cannot
 * be cancelled — their ships are already in the local fleet.
 */
export function cancelShipOrder(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: CancelShipOrderCommand;
  },
): ShipyardResult {
  const { orderId: targetId } = input.command;

  const planet = world.planets.find(
    (p) => p.ownerId === input.actorId && p.shipyardOrders.some((o) => o.id === targetId),
  );
  if (!planet) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };

  const order = planet.shipyardOrders.find((o) => o.id === targetId);
  if (!order) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };
  if (order.status === 'completed') {
    return { ok: false, error: { code: 'CANNOT_CANCEL', orderId: targetId, status: order.status } };
  }
  if (order.status === 'cancelled') return { ok: true, world, order };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  const refunded: ResourceStore = { ...planet.resources };
  const cap = storageCapFor(planet);
  for (const r of RESOURCE_KEYS) {
    const amount = Math.floor(order.cost[r] * SHIPYARD.refundFraction);
    refunded[r] = Math.min(cap, refunded[r] + amount);
  }

  const orders = planet.shipyardOrders.map((o) =>
    o.id === targetId ? { ...o, status: 'cancelled' as const, cancelledAtTick: world.tick } : o,
  );
  const cancelled = orders.find((o) => o.id === targetId);
  if (!cancelled) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };

  return {
    ok: true,
    world: {
      ...world,
      planets: world.planets.map((p) =>
        p.id === planet.id
          ? { ...p, resources: refunded, shipyardOrders: orders, version: p.version + 1 }
          : p,
      ),
      version: world.version + 1,
    },
    order: cancelled,
  };
}

/**
 * The shipyard resolution phase: advance every owned planet's queue by one
 * tick. When the active order reaches zero its ships enter the planet's local
 * fleet (the fleet whose homePlanetId is this planet) exactly once. Pure and
 * deterministic — the same world + tick always produce the same fleet state.
 */
export function resolveShipyardTick(world: WorldState, tick: number): WorldState {
  let fleets = world.fleets ?? [];

  const planets = world.planets.map((planet) => {
    if (!planet.ownerId) return planet;
    const shipyardOrders = planet.shipyardOrders ?? [];
    if (shipyardOrders.length === 0) return planet;

    let changed = false;
    const orders = shipyardOrders.map((o) => ({ ...o }));

    const head = orders.find((o) => o.status === 'building');
    if (head) {
      head.ticksRemaining -= 1;
      changed = true;
      if (head.ticksRemaining <= 0) {
        head.ticksRemaining = 0;
        head.status = 'completed';
        head.completedAtTick = tick;
      }
    }

    const next = orders.find((o) => o.status === 'queued');
    if (next && !orders.some((o) => o.status === 'building')) {
      next.status = 'building';
      next.startTick = tick;
      changed = true;
    }

    // Re-resolving an already-completed tick finds no active head and no
    // waiter to promote, so `changed` stays false and delivery is skipped —
    // this is the guard that makes "delivered exactly once" hold under
    // idempotent replay.
    if (!changed) return planet;

    // Deliver completed ships to the planet's local fleet exactly once.
    const completedThisTick = orders.filter(
      (o) => o.status === 'completed' && o.completedAtTick === tick,
    );
    if (completedThisTick.length > 0) {
      fleets = addShipsToLocalFleet(fleets, planet, completedThisTick);
    }

    return { ...planet, shipyardOrders: orders, version: planet.version + 1 };
  });

  return { ...world, planets, fleets };
}

/** Add completed ship orders to the planet's local fleet (creating it if a
 *  corrupted aggregate lost it — the fleet is the shipyard's delivery dock). */
function addShipsToLocalFleet(
  fleets: Fleet[],
  planet: {
    id: string;
    coordinate: Coordinate;
    ownerId: PlayerId | null;
  },
  completed: ShipyardOrder[],
): Fleet[] {
  const localFleetId = fleetId(`fleet:${planet.id}`);
  const existing = fleets.find((f) => f.id === localFleetId);
  const fleet: Fleet = existing ?? {
    id: localFleetId,
    ownerId: planet.ownerId ?? ('' as PlayerId),
    homePlanetId: planetId(planet.id),
    location: planet.coordinate,
    state: 'orbiting',
    ships: {},
    cargo: emptyResourceStore(),
    troops: 0,
    mission: null,
    departureTick: null,
    arrivalTick: null,
    route: [],
    version: 1,
  };
  const ships = { ...fleet.ships };
  for (const order of completed) {
    ships[order.ship] = (ships[order.ship] ?? 0) + order.quantity;
  }
  const updated: Fleet = { ...fleet, ships, version: fleet.version + 1 };
  if (existing) {
    return fleets.map((f) => (f.id === localFleetId ? updated : f));
  }
  return [...fleets, updated];
}

/** Planet-scoped shipyard views: active orders first, then history. */
export function shipyardOrderViews(planet: {
  shipyardOrders: ShipyardOrder[];
}): ShipyardOrderView[] {
  const active = activeShipOrders(planet);
  const activeIds = new Set(active.map((o) => o.id));
  return planet.shipyardOrders.map((o) => {
    if (!activeIds.has(o.id)) return shipyardOrderView(o, null, null);
    const position = active.findIndex((a) => a.id === o.id);
    return shipyardOrderView(o, position, o.status === 'building' ? o.ticksRemaining : null);
  });
}

function shipyardOrderView(
  order: ShipyardOrder,
  position: number | null,
  ticksRemaining: number | null,
): ShipyardOrderView {
  return {
    id: order.id,
    kind: 'ship',
    planetId: order.planetId,
    ship: order.ship,
    quantity: order.quantity,
    status: order.status,
    position,
    ticksRemaining,
    cost: order.cost,
    submittedAt: order.submittedAt,
    submittedTick: order.submittedTick,
    completedAtTick: order.completedAtTick,
    cancelledAtTick: order.cancelledAtTick,
  };
}
