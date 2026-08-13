import {
  emptyResourceStore,
  orderId,
  RESOURCE_KEYS,
  type Player,
  type PlayerId,
  type ResearchOrder,
  type ResearchOrderView,
  type ResourceRates,
  type ResourceStore,
  type TechnologyId,
  type WorldState,
} from '@ashes/contracts';
import { RESEARCH, RESEARCH_BY_ID, aggregateResearchEffects } from '@ashes/content';
import type { CancelResearchCommand, StartResearchCommand } from '@ashes/contracts';
import { storageCapFor } from './economy';

/**
 * Research queue (DEVELOPMENT_PLAN.md §4, M2). Account-wide: one study at a
 * time, a small number queued behind it. A research order runs on (and is
 * paid from) whichever owned planet has a Research Lab — the lab planet hosts
 * the archive, exactly like a building is raised on a specific world.
 *
 * Cost policy (chosen rule, applied consistently): **reserve now** — the host
 * planet's store is deducted at acceptance, so two accepted research commands
 * can never overspend the same local resources. Cancellation refunds the
 * reserved cost (clamped at the storage cap, like every store addition).
 *
 * Completed technologies are recorded on the player; their effects aggregate
 * into the player's research effects, which the economy and travel
 * calculations consume from the next tick onward.
 */

export type ResearchError =
  | { code: 'PLAYER_NOT_FOUND'; playerId: PlayerId }
  | { code: 'PLANET_NOT_FOUND'; planetId: string }
  | { code: 'NOT_OWNER'; planetId: string }
  | { code: 'HOST_PLANET_REQUIRES_LAB'; planetId: string }
  | { code: 'UNKNOWN_TECHNOLOGY'; technologyId: string }
  | { code: 'PREREQUISITES_NOT_MET'; technologyId: TechnologyId; missing: TechnologyId[] }
  | { code: 'ALREADY_RESEARCHED'; technologyId: TechnologyId }
  | { code: 'QUEUE_FULL'; capacity: number }
  | { code: 'INSUFFICIENT_RESOURCES'; missing: Partial<ResourceRates> }
  | { code: 'STALE_VERSION'; expected: number; actual: number }
  | { code: 'ORDER_NOT_FOUND'; orderId: string }
  | { code: 'CANNOT_CANCEL'; orderId: string; status: ResearchOrder['status'] };

export type ResearchResult =
  { ok: true; world: WorldState; order: ResearchOrder } | { ok: false; error: ResearchError };

/** Orders still occupying the account's research queue. */
export function activeResearchOrders(
  player: Player,
): Array<ResearchOrder & { status: 'researching' | 'queued' }> {
  return player.researchOrders.filter(isActive);
}

function isActive(o: ResearchOrder): o is ResearchOrder & { status: 'researching' | 'queued' } {
  return o.status === 'researching' || o.status === 'queued';
}

/** The full cost of a technology, as a complete per-resource store. */
export function researchCost(technologyId: TechnologyId): ResourceStore {
  const def = RESEARCH_BY_ID[technologyId];
  const cost = emptyResourceStore();
  if (!def) return cost;
  for (const r of RESOURCE_KEYS) {
    cost[r] = def.cost[r] ?? 0;
  }
  return cost;
}

/**
 * Accept a StartResearch command: validate against the current authoritative
 * state, reserve (deduct) the cost from the hosting lab planet's store, and
 * append the order to the player's research queue. Idempotent per idempotency
 * key: replaying the same envelope returns the original order unchanged.
 */
export function submitStartResearch(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: StartResearchCommand;
  },
  submittedAt: number,
): ResearchResult {
  const { hostPlanetId, technologyId } = input.command;
  const player = world.players.find((p) => p.id === input.actorId);
  if (!player) return { ok: false, error: { code: 'PLAYER_NOT_FOUND', playerId: input.actorId } };

  const planet = world.planets.find((p) => p.id === hostPlanetId);
  if (!planet) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId: hostPlanetId } };
  if (planet.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId: hostPlanetId } };
  }
  // The lab planet hosts the archive: a Research Lab is required on the host.
  if ((planet.buildings.lab ?? 0) < 1) {
    return { ok: false, error: { code: 'HOST_PLANET_REQUIRES_LAB', planetId: hostPlanetId } };
  }

  const def = RESEARCH_BY_ID[technologyId];
  if (!def) return { ok: false, error: { code: 'UNKNOWN_TECHNOLOGY', technologyId } };

  // Idempotent replay comes before the version gate (same rule as buildings).
  const existing = player.researchOrders.find((o) => o.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, order: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  // A technology can be researched once. Prerequisites must be completed.
  if (player.technologies.includes(technologyId)) {
    return { ok: false, error: { code: 'ALREADY_RESEARCHED', technologyId } };
  }
  const missing = def.prerequisites.filter((p) => !player.technologies.includes(p));
  if (missing.length > 0) {
    return { ok: false, error: { code: 'PREREQUISITES_NOT_MET', technologyId, missing } };
  }
  if (activeResearchOrders(player).some((o) => o.technologyId === technologyId)) {
    return { ok: false, error: { code: 'ALREADY_RESEARCHED', technologyId } };
  }

  const active = activeResearchOrders(player);
  if (active.length >= RESEARCH.queueCapacity) {
    return { ok: false, error: { code: 'QUEUE_FULL', capacity: RESEARCH.queueCapacity } };
  }

  const cost = researchCost(technologyId);
  const missingRes: Partial<ResourceRates> = {};
  let short = false;
  for (const r of RESOURCE_KEYS) {
    if (planet.resources[r] < cost[r]) {
      missingRes[r] = cost[r] - planet.resources[r];
      short = true;
    }
  }
  if (short) return { ok: false, error: { code: 'INSUFFICIENT_RESOURCES', missing: missingRes } };

  // Reserve now: deduct the full cost from the hosting lab planet.
  const resources: ResourceStore = { ...planet.resources };
  for (const r of RESOURCE_KEYS) {
    resources[r] -= cost[r];
  }

  const order: ResearchOrder = {
    id: orderId(`order:${input.idempotencyKey}`),
    kind: 'research',
    hostPlanetId,
    actorId: input.actorId,
    technologyId,
    submittedAt,
    submittedTick: world.tick,
    startTick: active.length === 0 ? world.tick : null,
    ticksRemaining: def.researchTicks,
    cost,
    status: active.length === 0 ? 'researching' : 'queued',
    completedAtTick: null,
    cancelledAtTick: null,
    idempotencyKey: input.idempotencyKey,
    expectedVersion: input.expectedVersion,
  };

  const next: WorldState = {
    ...world,
    players: world.players.map((p) =>
      p.id === player.id
        ? {
            ...p,
            researchOrders: [...p.researchOrders, order],
            version: p.version + 1,
          }
        : p,
    ),
    planets: world.planets.map((p) =>
      p.id === hostPlanetId ? { ...p, resources, version: p.version + 1 } : p,
    ),
    version: world.version + 1,
  };
  return { ok: true, world: next, order };
}

/**
 * Cancel a queued/in-progress research order: refund the reserved cost to the
 * hosting lab planet (clamped at its current storage cap), mark the order
 * cancelled, and leave it in history — it can never complete or refund again.
 */
export function cancelResearch(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: CancelResearchCommand;
  },
): ResearchResult {
  const { orderId: targetId } = input.command;
  const player = world.players.find((p) => p.id === input.actorId);
  if (!player) return { ok: false, error: { code: 'PLAYER_NOT_FOUND', playerId: input.actorId } };

  const order = player.researchOrders.find((o) => o.id === targetId);
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

  // Refund to the hosting planet (it may not be the home planet anymore, but
  // it is the store that paid).
  const planet = world.planets.find((p) => p.id === order.hostPlanetId);
  if (!planet)
    return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId: order.hostPlanetId } };
  const refunded: ResourceStore = { ...planet.resources };
  const cap = storageCapFor(planet);
  for (const r of RESOURCE_KEYS) {
    const amount = Math.floor(order.cost[r] * RESEARCH.refundFraction);
    refunded[r] = Math.min(cap, refunded[r] + amount);
  }

  const orders = player.researchOrders.map((o) =>
    o.id === targetId ? { ...o, status: 'cancelled' as const, cancelledAtTick: world.tick } : o,
  );
  const cancelled = orders.find((o) => o.id === targetId);
  if (!cancelled) return { ok: false, error: { code: 'ORDER_NOT_FOUND', orderId: targetId } };

  return {
    ok: true,
    world: {
      ...world,
      players: world.players.map((p) =>
        p.id === player.id ? { ...p, researchOrders: orders, version: p.version + 1 } : p,
      ),
      planets: world.planets.map((p) =>
        p.id === planet.id ? { ...p, resources: refunded, version: p.version + 1 } : p,
      ),
      version: world.version + 1,
    },
    order: cancelled,
  };
}

/**
 * The research resolution phase: advance every player's active study by one
 * tick; when one reaches zero it completes (the technology is added to the
 * player's completed set). Queues only advance at tick boundaries, and the
 * economy resolves first, so a technology completed on tick N applies its
 * effects from tick N+1.
 */
export function resolveResearchTick(world: WorldState, tick: number): WorldState {
  const players = world.players.map((player) => {
    const researchOrders = player.researchOrders ?? [];
    if (researchOrders.length === 0) return player;

    let changed = false;
    const orders = researchOrders.map((o) => ({ ...o }));

    const head = orders.find((o) => o.status === 'researching');
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
    if (next && !orders.some((o) => o.status === 'researching')) {
      next.status = 'researching';
      next.startTick = tick;
      changed = true;
    }

    if (!changed) return player;

    // Technologies completed during THIS tick only (earlier completions were
    // already recorded at their own tick).
    const technologies = [...player.technologies];
    for (const o of orders) {
      if (o.status === 'completed' && o.completedAtTick === tick) {
        if (!technologies.includes(o.technologyId)) technologies.push(o.technologyId);
      }
    }

    return { ...player, researchOrders: orders, technologies, version: player.version + 1 };
  });

  return { ...world, players };
}

/** The player-visible research queue: active orders first, then history. */
export function researchOrderViews(player: Player): ResearchOrderView[] {
  const active = activeResearchOrders(player);
  const activeIds = new Set(active.map((o) => o.id));
  return player.researchOrders.map((o) => {
    if (!activeIds.has(o.id)) return researchOrderView(o, null, null);
    const position = active.findIndex((a) => a.id === o.id);
    return researchOrderView(o, position, o.status === 'researching' ? o.ticksRemaining : null);
  });
}

function researchOrderView(
  order: ResearchOrder,
  position: number | null,
  ticksRemaining: number | null,
): ResearchOrderView {
  return {
    id: order.id,
    kind: 'research',
    hostPlanetId: order.hostPlanetId,
    technologyId: order.technologyId,
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

/** The player's aggregate research effects (from completed technologies). */
export function playerResearchEffects(player: Player) {
  return aggregateResearchEffects(player.technologies ?? []);
}
