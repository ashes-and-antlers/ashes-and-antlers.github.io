import { describe, expect, it } from 'vitest';
import type { Planet, PlayerId, WorldState } from '@ashes/contracts';
import { SHIPYARD } from '@ashes/content';
import { generateWorld } from './worldgen';
import { cancelShipOrder, resolveShipyardTick, submitQueueShip } from './shipyard';
import { localFleetId } from './fleet';

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

function actor(seed = 1337): PlayerId {
  return `player:${seed}` as PlayerId;
}

/** World whose home planet has a Shipyard and a rich store for hulls. */
function yardWorld(seed = 1337) {
  const world = makeWorld(seed);
  const home = homePlanet(world);
  home.buildings = { settlement: 1, shipyard: 1 };
  home.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
  return world;
}

function queueShip(world: WorldState, ship: string, quantity: number, key: string) {
  const planet = homePlanet(world);
  return submitQueueShip(
    world,
    {
      actorId: actor(),
      idempotencyKey: key,
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: ship as never, quantity },
    },
    1000,
  );
}

describe('submitQueueShip', () => {
  it('reserves the cost from the planet store and queues the order', () => {
    const world = yardWorld();
    const planet = homePlanet(world);
    const before = planet.resources;
    const result = queueShip(world, 'scout', 3, 'key-ship-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = homePlanet(result.world);
    // Scout costs metal 40 + mineral 20 per hull × 3.
    expect(after.resources.metal).toBe(before.metal - 120);
    expect(after.resources.mineral).toBe(before.mineral - 60);
    expect(after.resources).toEqual({ metal: 380, mineral: 440, food: 500, energy: 500 });

    const order = result.order;
    expect(order.kind).toBe('ship');
    expect(order.ship).toBe('scout');
    expect(order.quantity).toBe(3);
    expect(order.status).toBe('building');
    expect(order.ticksRemaining).toBe(1);
    expect(result.world.planets.find((p) => p.id === order.planetId)!.shipyardOrders).toHaveLength(
      1,
    );
  });

  it('requires a Shipyard building on the planet', () => {
    const world = makeWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
    const result = queueShip(world, 'scout', 1, 'key-no-yard');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SHIPYARD_REQUIRED');
  });

  it('rejects a command for a planet the actor does not own', () => {
    const world = yardWorld();
    const stranger = world.planets.find((p) => p.ownerId === null)!;
    stranger.buildings = { shipyard: 1 };
    stranger.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
    const result = submitQueueShip(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'key-stranger',
        expectedVersion: world.version,
        command: { kind: 'QueueShip', planetId: stranger.id, ship: 'scout', quantity: 1 },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('rejects a ship locked behind research', () => {
    const world = yardWorld();
    const result = queueShip(world, 'fighter', 1, 'key-locked');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SHIP_LOCKED');
    if (result.error.code !== 'SHIP_LOCKED') return;
    expect(result.error.requiredTechnology).toBe('shipyard-1');
  });

  it('accepts a ship once its technology is researched', () => {
    const world = yardWorld();
    world.players[0].technologies = ['shipyard-1'] as never;
    const result = queueShip(world, 'fighter', 1, 'key-unlocked');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.ship).toBe('fighter');
  });

  it('rejects a non-positive quantity', () => {
    const world = yardWorld();
    const zero = queueShip(world, 'scout', 0, 'key-q0');
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error.code).toBe('INVALID_QUANTITY');
  });

  it('rejects when the planet cannot afford the cost', () => {
    const world = yardWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 10, mineral: 500, food: 500, energy: 500 };
    const result = queueShip(world, 'freighter', 1, 'key-poor');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
    if (result.error.code !== 'INSUFFICIENT_RESOURCES') return;
    expect(result.error.missing).toEqual({ metal: 70 });
  });

  it('is idempotent: the same key replays the original order', () => {
    const world = yardWorld();
    const first = queueShip(world, 'scout', 2, 'key-replay');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = queueShip(first.world, 'scout', 2, 'key-replay');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.order.id).toBe(first.order.id);
    expect(homePlanet(replay.world).resources).toEqual(homePlanet(first.world).resources);
  });

  it('fills the per-planet queue to capacity and then rejects', () => {
    let world = yardWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 5000, mineral: 5000, food: 5000, energy: 5000 };
    for (let i = 1; i <= SHIPYARD.queueCapacity; i++) {
      const r = queueShip(world, 'scout', 1, `key-q${i}`);
      if (!r.ok) throw new Error(`queue slot ${i} failed`);
      world = r.world;
    }
    const full = queueShip(world, 'scout', 1, 'key-q-full');
    expect(full.ok).toBe(false);
    if (full.ok) return;
    expect(full.error.code).toBe('QUEUE_FULL');
    expect(SHIPYARD.queueCapacity).toBe(3);
  });
});

describe('cancelShipOrder', () => {
  it('refunds the exact reserved cost and marks cancelled', () => {
    const original = { ...homePlanet(yardWorld()).resources };
    let world = yardWorld();
    const started = queueShip(world, 'freighter', 1, 'key-cancel');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    expect(homePlanet(world).resources.metal).toBe(420);

    const result = cancelShipOrder(world, {
      actorId: actor(),
      idempotencyKey: 'key-cancel-order',
      expectedVersion: world.version,
      command: { kind: 'CancelShipOrder', orderId: started.order.id },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.status).toBe('cancelled');
    expect(homePlanet(result.world).resources).toEqual(original);
  });

  it('can never refund twice (cancel of a cancelled order is a no-op)', () => {
    const original = { ...homePlanet(yardWorld()).resources };
    let world = yardWorld();
    const started = queueShip(world, 'freighter', 1, 'key-cancel2');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    const first = cancelShipOrder(world, {
      actorId: actor(),
      idempotencyKey: 'key-c2-a',
      expectedVersion: world.version,
      command: { kind: 'CancelShipOrder', orderId: started.order.id },
    });
    if (!first.ok) throw new Error('first cancel failed');
    const second = cancelShipOrder(first.world, {
      actorId: actor(),
      idempotencyKey: 'key-c2-b',
      expectedVersion: first.world.version,
      command: { kind: 'CancelShipOrder', orderId: started.order.id },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(homePlanet(second.world).resources).toEqual(original);
  });

  it('refuses to cancel a completed order', () => {
    let world = yardWorld();
    const started = queueShip(world, 'scout', 1, 'key-done');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    world = resolveShipyardTick(world, 1);
    const result = cancelShipOrder(world, {
      actorId: actor(),
      idempotencyKey: 'key-done-cancel',
      expectedVersion: world.version,
      command: { kind: 'CancelShipOrder', orderId: started.order.id },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANNOT_CANCEL');
  });
});

describe('resolveShipyardTick', () => {
  it('completes an order and delivers its ships to the local fleet exactly once', () => {
    let world = yardWorld();
    const started = queueShip(world, 'scout', 2, 'key-tick');
    if (!started.ok) throw new Error('start failed');
    world = started.world;

    world = resolveShipyardTick(world, 1);
    const planet = homePlanet(world);
    const order = planet.shipyardOrders[0];
    expect(order.status).toBe('completed');
    expect(order.completedAtTick).toBe(1);

    const local = world.fleets.find((f) => f.id === localFleetId(planet.id));
    expect(local).toBeTruthy();
    expect(local!.ships.scout).toBe(2);
  });

  it('never double-delivers when the same tick is re-resolved (idempotent replay)', () => {
    let world = yardWorld();
    const started = queueShip(world, 'scout', 2, 'key-replay-tick');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    world = resolveShipyardTick(world, 1);
    const afterOne = world.fleets.find((f) => f.id === localFleetId(homePlanet(world).id))!;
    world = resolveShipyardTick(world, 1);
    const afterReplay = world.fleets.find((f) => f.id === localFleetId(homePlanet(world).id))!;
    expect(afterReplay.ships.scout).toBe(afterOne.ships.scout);
    expect(afterReplay.ships.scout).toBe(2);
  });

  it('runs the queue FIFO: the next order starts after the first completes', () => {
    let world = yardWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 5000, mineral: 5000, food: 5000, energy: 5000 };
    const a = queueShip(world, 'scout', 1, 'key-f1');
    if (!a.ok) throw new Error('start failed');
    world = a.world;
    const b = queueShip(world, 'freighter', 1, 'key-f2');
    if (!b.ok) throw new Error('start failed');
    world = b.world;
    expect(world.planets.find((p) => p.id === a.order.planetId)!.shipyardOrders[1].status).toBe(
      'queued',
    );

    world = resolveShipyardTick(world, 1);
    const orders = homePlanet(world).shipyardOrders;
    expect(orders[0].status).toBe('completed');
    expect(orders[1].status).toBe('building');
    expect(orders[1].startTick).toBe(1);
  });

  it('delivers exactly the completed quantity across multiple orders', () => {
    let world = yardWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 5000, mineral: 5000, food: 5000, energy: 5000 };
    const scout = queueShip(world, 'scout', 3, 'key-m1');
    if (!scout.ok) throw new Error('start failed');
    world = scout.world;
    const freighter = queueShip(world, 'freighter', 2, 'key-m2');
    if (!freighter.ok) throw new Error('start failed');
    world = freighter.world;
    // Scout builds in 1 tick; the freighter starts after it (tick 1) and
    // takes 2 more ticks of its own, so it lands on tick 3.
    world = resolveShipyardTick(world, 1);
    world = resolveShipyardTick(world, 2);
    const mid = world.fleets.find((f) => f.id === localFleetId(planet.id))!;
    expect(mid.ships.scout).toBe(3);
    expect(mid.ships.freighter).toBeUndefined();
    world = resolveShipyardTick(world, 3);
    const local = world.fleets.find((f) => f.id === localFleetId(planet.id))!;
    expect(local.ships.scout).toBe(3);
    expect(local.ships.freighter).toBe(2);
  });
});
