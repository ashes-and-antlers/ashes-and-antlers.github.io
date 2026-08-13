import {
  RESOURCE_KEYS,
  emptyResourceStore,
  orderId,
  type ConstructionOrder,
  type ConstructionOrderView,
  type PendingOrderView,
  type Planet,
  type PlanetId,
  type PlayerId,
  type ResourceRates,
  type ResourceStore,
  type WorldState,
} from '@ashes/contracts';
import { BUILDING_DEFINITIONS, CONSTRUCTION } from '@ashes/content';
import type { BuildingKind, ShipyardOrder } from '@ashes/contracts';
import type { CancelConstructionCommand, StartBuildingCommand } from '@ashes/contracts';
import { storageCapFor } from './economy';

/**
 * Construction queue system (DEVELOPMENT_PLAN.md §4, M1). Pure and
 * deterministic: given the same world + command, the same order is created
 * with the same cost, ticks, and queue position.
 *
 * Cost policy (chosen rule, applied consistently): **reserve now** — a build
 * command deducts its full cost from the planet store at acceptance, so two
 * accepted commands can never overspend the same local resources. Cancellation
 * refunds `refundFraction` of the reserved cost, clamped to the storage cap
 * like every store addition, and can never refund twice (an order is
 * cancelled exactly once, then ignored by the queue).
 */

export type ConstructionError =
  | { code: 'PLANET_NOT_FOUND'; planetId: PlanetId }
  | { code: 'NOT_OWNER'; planetId: PlanetId }
  | { code: 'UNKNOWN_BUILDING'; building: string }
  | { code: 'MAX_LEVEL_REACHED'; building: BuildingKind; level: number; maxLevel: number }
  | { code: 'QUEUE_FULL'; capacity: number }
  | { code: 'INSUFFICIENT_RESOURCES'; missing: Partial<ResourceRates> }
  | { code: 'STALE_VERSION'; expected: number; actual: number }
  | { code: 'ORDER_NOT_FOUND'; orderId: string }
  | { code: 'CANNOT_CANCEL'; orderId: string; status: ConstructionOrder['status'] };

export type ConstructionResult =
  | { ok: true; world: WorldState; order: ConstructionOrder }
  | { ok: false; error: ConstructionError };

/** Orders still occupying the queue (under construction or waiting). */
export function activeOrders(
  planet: Planet,
): Array<ConstructionOrder & { status: 'building' | 'queued' }> {
  return planet.constructionOrders.filter(isActive);
}

function isActive(
  o: ConstructionOrder,
): o is ConstructionOrder & { status: 'building' | 'queued' } {
  return o.status === 'building' || o.status === 'queued';
}

/** The full cost of one level of a building, as a complete per-resource store. */
export function buildingCost(building: BuildingKind): ResourceStore {
  const def = BUILDING_DEFINITIONS[building];
  const cost = emptyResourceStore();
  for (const r of RESOURCE_KEYS) {
    cost[r] = def.cost[r] ?? 0;
  }
  return cost;
}

/**
 * Accept a StartBuilding command: validate against the current authoritative
 * state, reserve (deduct) the cost, and append the order to the planet's
 * construction queue. Idempotent per idempotency key: replaying the same
 * envelope returns the original order without touching state again.
 */
export function submitStartBuilding(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: StartBuildingCommand;
  },
  submittedAt: number,
): ConstructionResult {
  const { planetId, building } = input.command;
  const planet = world.planets.find((p) => p.id === planetId);
  if (!planet) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId } };
  if (planet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId } };
  }

  const def = BUILDING_DEFINITIONS[building];
  if (!def) return { ok: false, error: { code: 'UNKNOWN_BUILDING', building } };

  // Idempotent replay comes before the version gate: re-submitting an already
  // accepted envelope returns its original receipt even though the world has
  // since advanced, and never deducts twice.
  const existing = planet.constructionOrders.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, order: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  // Max level: current level + orders already queued for this kind cannot
  // exceed the cap, so a queue can never complete an order past maxLevel.
  const level = planet.buildings[building] ?? 0;
  const pendingSameKind = activeOrders(planet).filter((o) => o.building === building).length;
  if (level + pendingSameKind >= def.maxLevel) {
    return {
      ok: false,
      error: { code: 'MAX_LEVEL_REACHED', building, level, maxLevel: def.maxLevel },
    };
  }

  const active = activeOrders(planet);
  if (active.length >= CONSTRUCTION.queueCapacity) {
    return { ok: false, error: { code: 'QUEUE_FULL', capacity: CONSTRUCTION.queueCapacity } };
  }

  const cost = buildingCost(building);
  const missing: Partial<ResourceRates> = {};
  let short = false;
  for (const r of RESOURCE_KEYS) {
    if (planet.resources[r] < cost[r]) {
      missing[r] = cost[r] - planet.resources[r];
      short = true;
    }
  }
  if (short) return { ok: false, error: { code: 'INSUFFICIENT_RESOURCES', missing } };

  // Reserve now: deduct the full cost before the order exists.
  const resources: ResourceStore = { ...planet.resources };
  for (const r of RESOURCE_KEYS) {
    resources[r] -= cost[r];
  }

  const order: ConstructionOrder = {
    id: orderId(`order:${input.idempotencyKey}`),
    kind: 'building',
    planetId,
    actorId: input.actorId,
    building,
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
            constructionOrders: [...p.constructionOrders, order],
            version: p.version + 1,
          }
        : p,
    ),
    version: world.version + 1,
  };
  return { ok: true, world: next, order };
}

/**
 * Cancel a queued or in-progress order: refund the reserved cost (clamped at
 * the current storage cap), mark the order cancelled, and leave it in the
 * record as immutable history — it can never complete or refund again.
 * Completed orders cannot be cancelled.
 */
export function cancelConstruction(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: CancelConstructionCommand;
  },
): ConstructionResult {
  const { orderId: targetId } = input.command;

  // Only the owner's planets are searched: an order on another player's
  // planet is indistinguishable from a missing one (no existence leak).
  const planet = world.planets.find(
    (p) => p.ownerId === input.actorId && p.constructionOrders.some((o) => o.id === targetId),
  );
  if (!planet) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };

  const order = planet.constructionOrders.find((o) => o.id === targetId);
  if (!order) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };
  if (order.status === 'completed') {
    return { ok: false, error: { code: 'CANNOT_CANCEL', orderId: targetId, status: order.status } };
  }
  // Idempotent replay before the version gate: cancelling an already-cancelled
  // order returns it unchanged, even with a stale envelope.
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
    const amount = Math.floor(order.cost[r] * CONSTRUCTION.refundFraction);
    refunded[r] = Math.min(cap, refunded[r] + amount);
  }

  const orders = planet.constructionOrders.map((o) =>
    o.id === targetId ? { ...o, status: 'cancelled' as const, cancelledAtTick: world.tick } : o,
  );

  const next: WorldState = {
    ...world,
    planets: world.planets.map((p) =>
      p.id === planet.id
        ? { ...p, resources: refunded, constructionOrders: orders, version: p.version + 1 }
        : p,
    ),
    version: world.version + 1,
  };
  const cancelled = orders.find((o) => o.id === targetId);
  if (!cancelled) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };
  return { ok: true, world: next, order: cancelled };
}

/**
 * The construction resolution phase: advance every owned planet's queue by
 * exactly one tick. The order under construction loses one tick; when it
 * reaches zero it completes (the building level rises) and the next queued
 * order starts. Queues only advance at tick boundaries, so a building that
 * completes on tick N produces nothing until tick N+1 (economy resolves
 * first). Pure and deterministic.
 */
export function resolveConstructionTick(world: WorldState, tick: number): WorldState {
  const planets = world.planets.map((planet) => {
    if (!planet.ownerId) return planet;
    const constructionOrders = planet.constructionOrders ?? [];
    if (constructionOrders.length === 0) return planet;

    let changed = false;
    const orders = constructionOrders.map((o) => ({ ...o }));

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

    // Promote the next waiter once nothing is under construction anymore.
    const next = orders.find((o) => o.status === 'queued');
    if (next && !orders.some((o) => o.status === 'building')) {
      next.status = 'building';
      next.startTick = tick;
      changed = true;
    }

    if (!changed) return planet;

    // Apply the levels completed during THIS tick only (earlier completions
    // already raised their level at their own tick).
    const buildings = { ...planet.buildings };
    for (const o of orders) {
      if (o.status === 'completed' && o.completedAtTick === tick) {
        buildings[o.building] = (buildings[o.building] ?? 0) + 1;
      }
    }

    return { ...planet, constructionOrders: orders, buildings, version: planet.version + 1 };
  });

  return { ...world, planets };
}

/** The view of one order anywhere in the world, or undefined. */
export function orderViewById(
  world: WorldState,
  orderId: ConstructionOrderView['id'],
): ConstructionOrderView | undefined {
  for (const planet of world.planets) {
    const view = constructionOrderViews(planet).find((v) => v.id === orderId);
    if (view) return view;
  }
  return undefined;
}

/** Planet-scoped construction views: active orders first, then history. */
export function constructionOrderViews(planet: Planet): ConstructionOrderView[] {
  const active = activeOrders(planet);
  const activeIds = new Set(active.map((o) => o.id));
  return planet.constructionOrders.map((o) => {
    if (!activeIds.has(o.id)) return constructionOrderView(o, null, null);
    const position = active.findIndex((a) => a.id === o.id);
    return constructionOrderView(o, position, o.status === 'building' ? o.ticksRemaining : null);
  });
}

/**
 * Orders awaiting resolution across a player's planets and account-wide
 * research queue, in stable planet (coordinate) order then queue position —
 * the "Pending next tick" list (M1 buildings; M2 research + ships).
 */
export function pendingOrderViews(world: WorldState, playerId: PlayerId): PendingOrderView[] {
  const nameById = new Map(world.planets.map((p) => [p.id, p.name]));
  const views: PendingOrderView[] = [];
  for (const planet of world.planets) {
    if (planet.ownerId !== playerId) continue;
    activeOrders(planet).forEach((o, position) => {
      views.push({
        id: o.id,
        kind: 'building',
        planetId: o.planetId,
        planetName: nameById.get(o.planetId) ?? o.planetId,
        building: o.building,
        status: o.status,
        position,
        ticksRemaining: o.status === 'building' ? o.ticksRemaining : null,
        cost: o.cost,
        submittedAt: o.submittedAt,
        submittedTick: o.submittedTick,
      });
    });
    activeShipOrdersForView(planet).forEach((o, position) => {
      views.push({
        id: o.id,
        kind: 'ship',
        planetId: o.planetId,
        planetName: nameById.get(o.planetId) ?? o.planetId,
        ship: o.ship,
        quantity: o.quantity,
        status: o.status,
        position,
        ticksRemaining: o.status === 'building' ? o.ticksRemaining : null,
        cost: o.cost,
        submittedAt: o.submittedAt,
        submittedTick: o.submittedTick,
      });
    });
  }
  const player = world.players.find((p) => p.id === playerId);
  if (player) {
    const active = player.researchOrders.filter(
      (o): o is typeof o & { status: 'researching' | 'queued' } =>
        o.status === 'researching' || o.status === 'queued',
    );
    active.forEach((o, position) => {
      views.push({
        id: o.id,
        kind: 'research',
        hostPlanetId: o.hostPlanetId,
        hostPlanetName: nameById.get(o.hostPlanetId) ?? o.hostPlanetId,
        technologyId: o.technologyId,
        status: o.status,
        position,
        ticksRemaining: o.status === 'researching' ? o.ticksRemaining : null,
        cost: o.cost,
        submittedAt: o.submittedAt,
        submittedTick: o.submittedTick,
      });
    });
  }
  return views;
}

/** Ship orders still occupying the planet's shipyard queue (view helper). */
function activeShipOrdersForView(planet: {
  shipyardOrders: ShipyardOrder[];
}): Array<ShipyardOrder & { status: 'building' | 'queued' }> {
  return planet.shipyardOrders.filter(
    (o): o is ShipyardOrder & { status: 'building' | 'queued' } =>
      o.status === 'building' || o.status === 'queued',
  );
}

function constructionOrderView(
  order: ConstructionOrder,
  position: number | null,
  ticksRemaining: number | null,
): ConstructionOrderView {
  return {
    id: order.id,
    kind: 'building',
    planetId: order.planetId,
    building: order.building,
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
