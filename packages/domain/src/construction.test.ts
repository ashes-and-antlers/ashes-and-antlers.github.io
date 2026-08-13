import { describe, expect, it } from 'vitest';
import { orderId, type Planet, type PlayerId, type WorldState } from '@ashes/contracts';
import { BUILDING_DEFINITIONS, CONSTRUCTION } from '@ashes/content';
import { generateWorld, computePlanetStateHash } from './worldgen';
import { resolveEconomyTick } from './economy';
import { resolveTick } from './tick';
import {
  cancelConstruction,
  constructionOrderViews,
  pendingOrderViews,
  resolveConstructionTick,
  submitStartBuilding,
} from './construction';

function makeWorld(seed = 1337) {
  return generateWorld({
    seed,
    config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
  });
}

function homePlanet(world: WorldState): Planet {
  const player = world.players[0];
  const home = world.planets.find((p) => p.id === player.homePlanetId);
  if (!home) throw new Error('home planet missing');
  return home;
}

/** World whose home planet has known abundance and a resource store large
 *  enough to fund builds but below the base storage cap (500), so refunds are
 *  never clamped and totals stay hand-checkable. */
function richWorld(seed = 1337) {
  const world = makeWorld(seed);
  const home = homePlanet(world);
  home.abundance = { metal: 100, mineral: 100, food: 100, energy: 100 };
  home.resources = { metal: 400, mineral: 400, food: 400, energy: 400 };
  return world;
}

const actor = (seed = 1337) => worldPlayerId(seed);

function worldPlayerId(seed: number): PlayerId {
  return `player:${seed}` as PlayerId;
}

function startBuilding(
  world: WorldState,
  building: 'mine' | 'farm' | 'reactor' | 'storehouse' | 'settlement',
  key: string,
) {
  const planet = homePlanet(world);
  return submitStartBuilding(
    world,
    {
      actorId: actor(),
      idempotencyKey: key,
      expectedVersion: world.version,
      command: { kind: 'StartBuilding', planetId: planet.id, building },
    },
    1000,
  );
}

describe('submitStartBuilding', () => {
  it('deducts the full cost at submission and queues an active order', () => {
    const world = richWorld();
    const planet = homePlanet(world);
    const before = planet.resources;
    const result = startBuilding(world, 'mine', 'key-build-mine');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = homePlanet(result.world);
    // Mine costs 60 metal: reserved immediately.
    expect(after.resources.metal).toBe(before.metal - 60);
    expect(after.resources).toEqual({ metal: 340, mineral: 400, food: 400, energy: 400 });

    const order = result.order;
    expect(order.building).toBe('mine');
    expect(order.status).toBe('building'); // empty queue → active immediately
    expect(order.ticksRemaining).toBe(BUILDING_DEFINITIONS.mine.buildTicks);
    expect(order.submittedTick).toBe(0);
    expect(order.startTick).toBe(0);
    expect(order.cost).toEqual({ metal: 60, mineral: 0, food: 0, energy: 0 });
    expect(after.constructionOrders).toHaveLength(1);
  });

  it('rejects when the planet cannot afford the cost and deducts nothing', () => {
    const world = makeWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 10, mineral: 1000, food: 1000, energy: 1000 };
    const result = startBuilding(world, 'mine', 'key-poor');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
    if (result.error.code !== 'INSUFFICIENT_RESOURCES') return;
    expect(result.error.missing).toEqual({ metal: 50 });
    expect(homePlanet(world).resources.metal).toBe(10); // untouched
  });

  it('rejects a command for a planet the actor does not own', () => {
    const world = richWorld();
    const stranger = world.planets.find((p) => p.ownerId === null)!;
    const result = submitStartBuilding(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'key-stranger',
        expectedVersion: world.version,
        command: { kind: 'StartBuilding', planetId: stranger.id, building: 'mine' },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('rejects a stale expected version', () => {
    const world = richWorld();
    const planet = homePlanet(world);
    const result = submitStartBuilding(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'key-stale',
        expectedVersion: world.version + 5,
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STALE_VERSION');
  });

  it('rejects a building already at max level', () => {
    const world = richWorld();
    const planet = homePlanet(world);
    planet.buildings = { settlement: BUILDING_DEFINITIONS.settlement.maxLevel };
    const result = startBuilding(world, 'settlement', 'key-max');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MAX_LEVEL_REACHED');
  });

  it('counts queued orders of the same kind against max level', () => {
    const world = richWorld();
    const planet = homePlanet(world);
    // settlement L9 + one queued upgrade → a second upgrade must be rejected.
    planet.buildings = { settlement: 9 };
    const first = startBuilding(world, 'settlement', 'key-set-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = startBuilding(first.world, 'settlement', 'key-set-2');
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('MAX_LEVEL_REACHED');
  });

  it('fills the queue to capacity and then rejects', () => {
    let world = richWorld();
    for (let i = 0; i < CONSTRUCTION.queueCapacity; i++) {
      const result = startBuilding(world, 'mine', `key-queue-${i}`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      world = result.world;
    }
    const full = startBuilding(world, 'farm', 'key-queue-full');
    expect(full.ok).toBe(false);
    if (full.ok) return;
    expect(full.error.code).toBe('QUEUE_FULL');
  });

  it('is idempotent: the same idempotency key replays the original order', () => {
    const world = richWorld();
    const first = startBuilding(world, 'mine', 'key-replay');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = startBuilding(first.world, 'mine', 'key-replay');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.order.id).toBe(first.order.id);
    // State unchanged: resources were deducted exactly once.
    expect(homePlanet(replay.world).resources).toEqual(homePlanet(first.world).resources);
    expect(homePlanet(replay.world).constructionOrders).toHaveLength(1);
  });
});

describe('resolveConstructionTick (queue advancement)', () => {
  it('completes a building after its build ticks and raises the level', () => {
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-tick');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    const buildTicks = BUILDING_DEFINITIONS.mine.buildTicks;

    for (let tick = 1; tick < buildTicks; tick++) {
      world = resolveConstructionTick(world, tick);
      const order = homePlanet(world).constructionOrders[0];
      expect(order.status).toBe('building');
      expect(order.ticksRemaining).toBe(buildTicks - tick);
      expect(homePlanet(world).buildings.mine).toBeUndefined();
    }
    world = resolveConstructionTick(world, buildTicks);
    const order = homePlanet(world).constructionOrders[0];
    expect(order.status).toBe('completed');
    expect(order.completedAtTick).toBe(buildTicks);
    expect(homePlanet(world).buildings.mine).toBe(1);
  });

  it('a building completed on tick N produces nothing until tick N+1', () => {
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-produce');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    // The mine completes during tick 2's construction phase.
    for (let tick = 1; tick <= 2; tick++) {
      world = resolveTick({ world, tick, resolvedAt: tick * 1000 }).world;
    }
    const afterCompletion = homePlanet(world);
    // Metal produced on tick 2 is from the pre-mine economy (0), and the mine
    // only starts producing on the NEXT resolution (tick 3).
    expect(afterCompletion.buildings.mine).toBe(1);
    expect(afterCompletion.resources.metal).toBe(340); // no production yet

    world = resolveTick({ world, tick: 3, resolvedAt: 3000 }).world;
    const afterNext = homePlanet(world);
    // +10 metal from the new mine L1 on 100 abundance.
    expect(afterNext.resources.metal).toBe(350);
  });

  it('runs the queue FIFO: a second order starts only after the first completes', () => {
    let world = richWorld();
    const first = startBuilding(world, 'mine', 'key-fifo-1');
    if (!first.ok) throw new Error('start failed');
    world = first.world;
    const second = startBuilding(world, 'farm', 'key-fifo-2');
    if (!second.ok) throw new Error('start failed');
    world = second.world;

    expect(homePlanet(world).constructionOrders[1].status).toBe('queued');

    const mineTicks = BUILDING_DEFINITIONS.mine.buildTicks;
    for (let tick = 1; tick <= mineTicks; tick++) {
      world = resolveConstructionTick(world, tick);
    }
    const afterMine = homePlanet(world);
    expect(afterMine.buildings.mine).toBe(1);
    // The farm promoted at the same tick the mine completed; it loses no
    // extra tick beyond its own build time.
    const farmOrder = afterMine.constructionOrders[1];
    expect(farmOrder.status).toBe('building');
    expect(farmOrder.startTick).toBe(mineTicks);

    const farmTicks = BUILDING_DEFINITIONS.farm.buildTicks;
    for (let tick = mineTicks + 1; tick <= mineTicks + farmTicks; tick++) {
      world = resolveConstructionTick(world, tick);
    }
    const afterFarm = homePlanet(world);
    expect(afterFarm.buildings.farm).toBe(1);
    expect(afterFarm.constructionOrders[1].status).toBe('completed');
  });

  it('does not touch unowned planets or planets without orders', () => {
    let world = richWorld();
    const unowned = world.planets.filter((p) => p.ownerId === null).map((p) => p.id);
    world = resolveConstructionTick(world, 1);
    for (const id of unowned) {
      const p = world.planets.find((x) => x.id === id)!;
      expect(p.constructionOrders).toEqual([]);
      expect(p.version).toBe(1);
    }
  });
});

describe('cancelConstruction', () => {
  it('refunds the exact reserved cost and marks the order cancelled', () => {
    const original = { ...homePlanet(richWorld()).resources };
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-cancel');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    // The reservation is visible immediately (metal 400 → 340).
    expect(homePlanet(world).resources.metal).toBe(340);

    const result = cancelConstruction(world, {
      actorId: actor(),
      idempotencyKey: 'key-cancel-order',
      expectedVersion: world.version,
      command: { kind: 'CancelConstruction', orderId: started.order.id },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.status).toBe('cancelled');
    expect(result.order.cancelledAtTick).toBe(0);
    // The deduction and refund round-trip exactly — no resources created.
    expect(homePlanet(result.world).resources).toEqual(original);
    expect(homePlanet(result.world).constructionOrders[0].status).toBe('cancelled');
    expect(homePlanet(result.world).buildings.mine).toBeUndefined();
  });

  it('can never refund twice (cancel of a cancelled order is a no-op)', () => {
    const original = { ...homePlanet(richWorld()).resources };
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-cancel2');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    const first = cancelConstruction(world, {
      actorId: actor(),
      idempotencyKey: 'key-cancel2-a',
      expectedVersion: world.version,
      command: { kind: 'CancelConstruction', orderId: started.order.id },
    });
    if (!first.ok) throw new Error('first cancel failed');

    const second = cancelConstruction(first.world, {
      actorId: actor(),
      idempotencyKey: 'key-cancel2-b',
      expectedVersion: first.world.version,
      command: { kind: 'CancelConstruction', orderId: started.order.id },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Exactly one refund happened: the store equals the original pre-build store.
    const refunded = homePlanet(second.world);
    expect(refunded.resources).toEqual(original);
    expect(refunded.constructionOrders.filter((o) => o.status === 'cancelled')).toHaveLength(1);
  });

  it('refuses to cancel a completed order', () => {
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-done');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    for (let tick = 1; tick <= BUILDING_DEFINITIONS.mine.buildTicks; tick++) {
      world = resolveConstructionTick(world, tick);
    }
    const result = cancelConstruction(world, {
      actorId: actor(),
      idempotencyKey: 'key-done-cancel',
      expectedVersion: world.version,
      command: { kind: 'CancelConstruction', orderId: started.order.id },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANNOT_CANCEL');
  });

  it('an unknown order id answers ORDER_NOT_FOUND (no existence leak)', () => {
    const world = richWorld();
    const result = cancelConstruction(world, {
      actorId: actor(),
      idempotencyKey: 'key-leak',
      expectedVersion: world.version,
      command: { kind: 'CancelConstruction', orderId: orderId('order:not-mine') },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_NOT_FOUND');
  });
});

describe('construction views', () => {
  it('exposes positions, ticks remaining, and history in planet views', () => {
    let world = richWorld();
    const a = startBuilding(world, 'mine', 'key-view-1');
    if (!a.ok) throw new Error('start failed');
    world = a.world;
    const b = startBuilding(world, 'farm', 'key-view-2');
    if (!b.ok) throw new Error('start failed');
    world = b.world;

    const views = constructionOrderViews(homePlanet(world));
    expect(views).toHaveLength(2);
    expect(views[0].status).toBe('building');
    expect(views[0].position).toBe(0);
    expect(views[0].ticksRemaining).toBe(BUILDING_DEFINITIONS.mine.buildTicks);
    expect(views[1].status).toBe('queued');
    expect(views[1].position).toBe(1);
    expect(views[1].ticksRemaining).toBeNull();

    // History orders carry their finished status with the tick.
    for (let tick = 1; tick <= BUILDING_DEFINITIONS.mine.buildTicks; tick++) {
      world = resolveConstructionTick(world, tick);
    }
    const after = constructionOrderViews(homePlanet(world));
    expect(after[0].status).toBe('completed');
    expect(after[0].position).toBeNull();
    expect(after[1].status).toBe('building');
    expect(after[1].position).toBe(0);
  });

  it('flattens active orders into the overview pending list with planet names', () => {
    const world = richWorld();
    const a = startBuilding(world, 'mine', 'key-pending-1');
    if (!a.ok) throw new Error('start failed');
    const pending = pendingOrderViews(a.world, actor());
    expect(pending).toHaveLength(1);
    if (pending[0].kind !== 'building') throw new Error('expected a building order');
    expect(pending[0].building).toBe('mine');
    expect(pending[0].planetName).toBe(homePlanet(a.world).name);
    expect(pending[0].status).toBe('building');
    expect(pending[0].position).toBe(0);
  });
});

describe('construction determinism', () => {
  it('same world + commands → identical state hashes', () => {
    const run = (seed: number) => {
      let world = richWorld(seed);
      const a = startBuilding(world, 'mine', 'key-det-1');
      if (!a.ok) throw new Error('start failed');
      world = a.world;
      const b = startBuilding(world, 'farm', 'key-det-2');
      if (!b.ok) throw new Error('start failed');
      world = b.world;
      for (let tick = 1; tick <= 5; tick++) {
        world = resolveConstructionTick(world, tick);
      }
      return computePlanetStateHash(world.planets);
    };
    expect(run(1337)).toBe(run(1337));
  });

  it('the construction phase changes the planet-state hash', () => {
    const world = richWorld();
    const before = computePlanetStateHash(world.planets);
    const started = startBuilding(world, 'mine', 'key-hash');
    if (!started.ok) throw new Error('start failed');
    expect(computePlanetStateHash(started.world.planets)).not.toBe(before);
  });

  it('the full resolveTick reports a construction phase hash and stable totals', () => {
    let world = richWorld();
    const started = startBuilding(world, 'mine', 'key-full');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    const out = resolveTick({ world, tick: 1, resolvedAt: 1000 });
    expect(out.resolution.phaseHashes.construction).toBeTruthy();
    expect(out.world.tick).toBe(1);
    // Same input → same resolution (idempotent form).
    const again = resolveTick({ world, tick: 1, resolvedAt: 1000 });
    expect(again.resolution.planetStateHash).toBe(out.resolution.planetStateHash);
    expect(again.resolution.phaseHashes).toEqual(out.resolution.phaseHashes);
  });

  it('the economy phase alone leaves construction untouched (composability)', () => {
    const world = richWorld();
    const started = startBuilding(world, 'mine', 'key-econ');
    if (!started.ok) throw new Error('start failed');
    const { world: after } = resolveEconomyTick({
      world: started.world,
      tick: 1,
      resolvedAt: 1000,
    });
    expect(homePlanet(after).constructionOrders[0].status).toBe('building');
    expect(homePlanet(after).buildings.mine).toBeUndefined();
  });
});
