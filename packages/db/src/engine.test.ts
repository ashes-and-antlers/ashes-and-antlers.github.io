import { describe, expect, it } from 'vitest';
import { technologyId, worldIdFromSeed } from '@ashes/contracts';
import { coordinateDistance } from '@ashes/domain';
import { TickEngine } from './engine';
import { InMemoryWorldRepository } from './repository';
import { WorldLock } from './lock';
import { TickScheduler } from './scheduler';

function makeEngine() {
  const repository = new InMemoryWorldRepository();
  const lock = new WorldLock();
  const engine = new TickEngine({ repository, lock });
  return { repository, lock, engine };
}

describe('TickEngine', () => {
  it('creates a world idempotently per seed', async () => {
    const { engine } = makeEngine();
    const a = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const b = await engine.createWorld({ seed: 1337, createdAt: 999_999 });
    expect(a).toBe(b);
    expect(a.worldHash).toBe(b.worldHash);
  });

  it('resolves the next tick and records an immutable resolution', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const resolution = await engine.resolveNextTick(world.id, 1000);
    expect(resolution.tick).toBe(1);
    expect(await repository.getResolution(world.id, 1)).toBe(resolution);
    const updated = await engine.getWorld(world.id);
    expect(updated).toBeDefined();
    expect(updated!.tick).toBe(1);
    expect(updated!.lastResolvedAt).toBe(1000);
    expect(updated!.nextTickAt).toBe(1000 + updated!.tickDurationMs);
  });

  it('produces resources on the home planet as ticks resolve', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await engine.resolveNextTick(world.id, 1000);
    const view = await engine.getWorldView(world.id);
    const home = view.player.homePlanet;
    // Starting package: settlement L1 + starter resources; the first tick
    // produces nothing (no production buildings yet) but pays settlement upkeep.
    expect(home.buildings.settlement).toBe(1);
    expect(home.resources.food).toBeGreaterThanOrEqual(0);
    expect(home.population).toBeGreaterThanOrEqual(500);
    expect(home.rates.net).toBeDefined();
  });

  it('rejects an out-of-order tick', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await expect(engine.resolveTick(world.id, 5, 1000)).rejects.toThrow(/out of order/);
  });

  it('a duplicate tick job cannot run two resolvers for the same world/tick', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });

    // Two concurrent resolvers racing for the same next tick.
    const [r1, r2] = await Promise.all([
      engine.resolveNextTick(world.id, 1000),
      engine.resolveNextTick(world.id, 1000),
    ]);

    // Exactly one resolution was produced and both callers got it.
    expect(r1).toBe(r2);
    expect(await repository.getResolution(world.id, 1)).toBe(r1);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
  });

  it('replays an already-resolved tick without re-executing', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const first = await engine.resolveNextTick(world.id, 1000);
    // Re-resolve the same tick (e.g. a worker restart re-running tick 1).
    const replay = await engine.resolveTick(world.id, 1, 2000);
    expect(replay).toBe(first);
    // resolvedAt from the original run is preserved — no double execution.
    expect(replay.resolvedAt).toBe(1000);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
    expect(await repository.getResolution(world.id, 1)).toBe(first);
  });

  it('submits a StartBuilding command and returns an order receipt', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    const receipt = await engine.submitStartBuilding(world.id, world.players[0].id, {
      idempotencyKey: 'key-engine-build',
      expectedVersion: world.version,
      command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
    });
    expect(receipt.building).toBe('mine');
    expect(receipt.status).toBe('building');
    expect(receipt.position).toBe(0);

    // The world advanced: resources reserved, the order visible in the view.
    const after = await engine.getWorld(world.id);
    expect(after!.version).toBe(world.version + 1);
    const view = await engine.getWorldView(world.id);
    expect(view.pendingOrders).toHaveLength(1);
    expect(view.pendingOrders[0].id).toBe(receipt.id);
  });

  it('M1 acceptance: two accepted build commands cannot overspend the same store', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    const playerId = world.players[0].id;

    // The first build reserves its cost from the authoritative store.
    const a = await engine.submitStartBuilding(world.id, playerId, {
      idempotencyKey: 'key-overspend-a',
      expectedVersion: world.version,
      command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
    });
    expect(a.status).toBe('building');

    // The second command carries the FRESH version (as a client that just
    // refreshed would) but the store is genuinely short: metal 100 − 60 = 40
    // cannot cover a second mine. The reservation guard must reject it.
    const afterFirst = await engine.getWorld(world.id);
    await expect(
      engine.submitStartBuilding(world.id, playerId, {
        idempotencyKey: 'key-overspend-b',
        expectedVersion: afterFirst!.version,
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });

    // Exactly one order and one deduction survived.
    const view = await engine.getWorldView(world.id);
    expect(view.pendingOrders).toHaveLength(1);
    const after = await engine.getWorld(world.id);
    const home = after!.planets.find((p) => p.id === planet.id)!;
    expect(home.resources.metal).toBe(40); // 100 − 60
  });

  it('rejects a stale expected version', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    await expect(
      engine.submitStartBuilding(world.id, world.players[0].id, {
        idempotencyKey: 'key-stale-engine',
        expectedVersion: world.version + 3,
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
  });

  it('replays an idempotency key without a second deduction', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    const playerId = world.players[0].id;
    const envelope = {
      idempotencyKey: 'key-replay-engine',
      expectedVersion: world.version,
      command: { kind: 'StartBuilding' as const, planetId: planet.id, building: 'mine' as const },
    };
    const first = await engine.submitStartBuilding(world.id, playerId, envelope);
    const replay = await engine.submitStartBuilding(world.id, playerId, envelope);
    expect(replay.id).toBe(first.id);
    const view = await engine.getWorldView(world.id);
    expect(view.pendingOrders).toHaveLength(1);
  });

  it('cancels a build order and refunds the reserved cost exactly once', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    const playerId = world.players[0].id;
    const receipt = await engine.submitStartBuilding(world.id, playerId, {
      idempotencyKey: 'key-cancel-engine',
      expectedVersion: world.version,
      command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
    });
    const worldAfterBuild = await engine.getWorld(world.id);
    expect(worldAfterBuild!.planets.find((p) => p.id === planet.id)!.resources.metal).toBe(40);

    const cancelled = await engine.cancelConstruction(world.id, playerId, {
      idempotencyKey: 'key-cancel-engine-2',
      expectedVersion: worldAfterBuild!.version,
      command: { kind: 'CancelConstruction', orderId: receipt.id },
    });
    expect(cancelled.status).toBe('cancelled');

    const after = await engine.getWorld(world.id);
    expect(after!.planets.find((p) => p.id === planet.id)!.resources.metal).toBe(100);
    const view = await engine.getWorldView(world.id);
    expect(view.pendingOrders).toHaveLength(0);
  });

  it('the world lock serializes holders', async () => {
    const { lock } = makeEngine();
    const worldId = worldIdFromSeed(1337);
    const release = await lock.acquire(worldId);
    let secondGotKey = false;
    const second = lock.acquire(worldId).then((rel) => {
      secondGotKey = true;
      return rel;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondGotKey).toBe(false);
    release();
    const releaseSecond = await second;
    expect(secondGotKey).toBe(true);
    releaseSecond();
  });
});

describe('TickEngine M2 (research, shipyards, fleets)', () => {
  /** Home planet with lab + shipyard and a rich store, saved to the repo. */
  async function m2World() {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1, lab: 1, shipyard: 1 };
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    await repository.saveWorld(world);
    return { engine, repository, world, planet };
  }

  it('accepts a StartResearch command and shows it in the world view', async () => {
    const { engine, world, planet } = await m2World();
    const order = await engine.submitStartResearch(world.id, world.players[0].id, {
      idempotencyKey: 'key-res-engine',
      expectedVersion: world.version,
      command: {
        kind: 'StartResearch',
        hostPlanetId: planet.id,
        technologyId: technologyId('extraction-1'),
      },
    });
    expect(order.kind).toBe('research');
    expect(order.status).toBe('researching');
    expect(order.position).toBe(0);
    const view = await engine.getWorldView(world.id);
    expect(view.research.orders).toHaveLength(1);
    expect(view.research.orders[0].id).toBe(order.id);
    expect(view.pendingOrders.some((o) => o.kind === 'research')).toBe(true);
  });

  it('completes research across ticks and reports it', async () => {
    const { engine, world, planet } = await m2World();
    await engine.submitStartResearch(world.id, world.players[0].id, {
      idempotencyKey: 'key-res-tick',
      expectedVersion: world.version,
      command: {
        kind: 'StartResearch',
        hostPlanetId: planet.id,
        technologyId: technologyId('extraction-1'),
      },
    });
    for (let tick = 1; tick <= 3; tick++) await engine.resolveNextTick(world.id, tick * 1000);
    const view = await engine.getWorldView(world.id);
    expect(view.research.completed).toContain('extraction-1');
    expect(view.research.effects.extractionBonus).toBe(0.15);
    expect(view.reports.some((r) => r.kind === 'research_completed')).toBe(true);
  });

  it('reserves research cost from the hosting lab planet (no overspend)', async () => {
    const { engine, world, planet } = await m2World();
    planet.resources = { metal: 130, mineral: 500, food: 500, energy: 500 };
    await engine.submitStartResearch(world.id, world.players[0].id, {
      idempotencyKey: 'key-res-a',
      expectedVersion: world.version,
      command: {
        kind: 'StartResearch',
        hostPlanetId: planet.id,
        technologyId: technologyId('extraction-1'),
      },
    });
    const afterFirst = await engine.getWorld(world.id);
    await expect(
      engine.submitStartResearch(world.id, world.players[0].id, {
        idempotencyKey: 'key-res-b',
        expectedVersion: afterFirst!.version,
        command: {
          kind: 'StartResearch',
          hostPlanetId: planet.id,
          technologyId: technologyId('nav-1'),
        },
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });
  });

  it('builds ships and delivers them to the local fleet across ticks', async () => {
    const { engine, world, planet } = await m2World();
    const order = await engine.submitQueueShip(world.id, world.players[0].id, {
      idempotencyKey: 'key-ship-engine',
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: 'scout', quantity: 2 },
    });
    expect(order.kind).toBe('ship');
    expect(order.status).toBe('building');
    await engine.resolveNextTick(world.id, 1000);
    const view = await engine.getWorldView(world.id);
    const local = view.fleets.find((f) => f.homePlanetId === planet.id);
    expect(local).toBeDefined();
    expect(local!.ships.scout).toBe(2);
    expect(view.reports.some((r) => r.kind === 'ships_completed')).toBe(true);
  });

  it('splits a fleet and returns the new detachment view', async () => {
    const { engine, world, planet } = await m2World();
    await engine.submitQueueShip(world.id, world.players[0].id, {
      idempotencyKey: 'key-ship-split',
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: 'scout', quantity: 3 },
    });
    await engine.resolveNextTick(world.id, 1000);
    const after = await engine.getWorld(world.id);
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;

    const result = await engine.splitFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-split-engine',
      expectedVersion: after!.version,
      command: { kind: 'SplitFleet', fleetId: local.id, ships: { scout: 1 } },
    });
    expect(result.op).toBe('split');
    if (result.op !== 'split') return;
    expect(result.fleet.ships.scout).toBe(1);
    const view = await engine.getWorldView(world.id);
    expect(view.fleets).toHaveLength(2);
  });

  it('transfers ships between co-located fleets', async () => {
    const { engine, world, planet } = await m2World();
    await engine.submitQueueShip(world.id, world.players[0].id, {
      idempotencyKey: 'key-ship-t1',
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: 'scout', quantity: 2 },
    });
    await engine.resolveNextTick(world.id, 1000);
    const after = await engine.getWorld(world.id);
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;

    await engine.splitFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-split-t2',
      expectedVersion: after!.version,
      command: { kind: 'SplitFleet', fleetId: local.id, ships: { scout: 1 } },
    });
    const afterSplit = await engine.getWorld(world.id);
    const detachment = afterSplit!.fleets.find((f) => f.homePlanetId === null)!;

    const result = await engine.transferFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-transfer-t3',
      expectedVersion: afterSplit!.version,
      command: {
        kind: 'TransferFleet',
        fromFleetId: detachment.id,
        toFleetId: local.id,
        ships: { scout: 1 },
      },
    });
    expect(result.op).toBe('transfer');
    const finalView = await engine.getWorldView(world.id);
    const localView = finalView.fleets.find((f) => f.homePlanetId === planet.id)!;
    expect(localView.ships.scout).toBe(2);
    const detachView = finalView.fleets.find((f) => f.id === detachment.id)!;
    expect(detachView.ships.scout).toBeUndefined();
  });
});

describe('TickEngine M3 (fleet movement)', () => {
  /** Home planet with a shipyard and a rich store, saved to the repo. */
  async function m3World() {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1, shipyard: 1 };
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    await repository.saveWorld(world);
    return { engine, repository, world, planet };
  }

  /** Build `quantity` scouts, resolve the delivery tick, return the world + local fleet. */
  async function armedScouts(
    engine: Awaited<ReturnType<typeof makeEngine>>['engine'],
    world: Awaited<ReturnType<typeof m3World>>['world'],
    planet: Awaited<ReturnType<typeof m3World>>['planet'],
    key: string,
    quantity = 2,
  ) {
    await engine.submitQueueShip(world.id, world.players[0].id, {
      idempotencyKey: key,
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: 'scout', quantity },
    });
    await engine.resolveNextTick(world.id, 1000);
    const after = await engine.getWorld(world.id);
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;
    return { after: after!, local };
  }

  it('M3 acceptance: a fleet sent before cutoff arrives on the calculated tick and cannot be duplicated by retry', async () => {
    const { engine, world, planet } = await m3World();
    const { after, local } = await armedScouts(engine, world, planet, 'key-m3-arm');
    const destination = world.planets.find((p) => p.id !== planet.id)!.coordinate;

    // The route preview is exactly what the engine will resolve.
    const route = await engine.getFleetRoute(world.id, local.id, destination);
    expect(route.travelTicks).toBeGreaterThanOrEqual(1);

    const sent = await engine.sendFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-send',
      expectedVersion: after.version,
      command: { kind: 'SendFleet', fleetId: local.id, destination, mission: 'transport' },
    });
    expect(sent.op).toBe('send');
    if (sent.op !== 'send') return;
    expect(sent.fleet.state).toBe('moving');
    expect(sent.fleet.mission?.destination).toEqual(destination);
    expect(sent.fleet.arrivalTick).toBe(after.tick + route.travelTicks);

    // Still in flight one tick before arrival, at its origin.
    for (let t = after.tick + 1; t < sent.fleet.arrivalTick!; t++) {
      await engine.resolveNextTick(world.id, 1000 + t);
    }
    const before = await engine.getWorld(world.id);
    const inFlight = before!.fleets.find((f) => f.id === local.id)!;
    expect(inFlight.state).toBe('moving');
    expect(inFlight.location).toEqual(planet.coordinate);

    // Arrival tick: the fleet docks at the destination, cargo and ships intact.
    await engine.resolveNextTick(world.id, 1000 + sent.fleet.arrivalTick!);
    const view = await engine.getWorldView(world.id);
    const docked = view.fleets.find((f) => f.id === local.id)!;
    expect(docked.state).toBe('orbiting');
    expect(docked.location).toEqual(destination);
    expect(docked.mission).toBeNull();
    expect(docked.arrivalTick).toBeNull();
    expect(docked.ships.scout).toBe(2);

    // Idempotent retry of the arrival tick cannot double-deliver the fleet.
    await engine.resolveTick(world.id, sent.fleet.arrivalTick!, 9999);
    const again = await engine.getWorldView(world.id);
    const stillDocked = again.fleets.find((f) => f.id === local.id)!;
    expect(stillDocked.state).toBe('orbiting');
    expect(stillDocked.ships.scout).toBe(2);
  });

  it('recalls a fleet mid-flight and resolves its return', async () => {
    const { engine, world, planet } = await m3World();
    const { after, local } = await armedScouts(engine, world, planet, 'key-m3-recall-arm');
    const destination = world.planets.find((p) => p.id !== planet.id)!.coordinate;
    const origin = local.location;

    await engine.sendFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-recall-send',
      expectedVersion: after.version,
      command: { kind: 'SendFleet', fleetId: local.id, destination, mission: 'scout' },
    });
    // One tick of progress before recalling.
    await engine.resolveNextTick(world.id, 2000);
    const mid = await engine.getWorld(world.id);
    const moving = mid!.fleets.find((f) => f.id === local.id)!;
    expect(moving.state).toBe('moving');

    const recalled = await engine.recallFleet(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-recall',
      expectedVersion: mid!.version,
      command: { kind: 'RecallFleet', fleetId: local.id },
    });
    expect(recalled.op).toBe('recall');
    if (recalled.op !== 'recall') return;
    expect(recalled.fleet.state).toBe('returning');
    expect(recalled.fleet.mission?.kind).toBe('return');
    expect(recalled.fleet.arrivalTick).toBeGreaterThan(mid!.tick);

    // Resolve the return: the fleet docks back at its origin.
    for (let t = mid!.tick + 1; t <= recalled.fleet.arrivalTick!; t++) {
      await engine.resolveNextTick(world.id, 2000 + t);
    }
    const home = await engine.getWorldView(world.id);
    const docked = home.fleets.find((f) => f.id === local.id)!;
    expect(docked.state).toBe('orbiting');
    expect(docked.location).toEqual(origin);
  });

  it('loads and unloads cargo between the planet store and an orbiting fleet', async () => {
    const { engine, world, planet } = await m3World();
    // A freighter gives the fleet a 200-unit hold; it takes two ticks to build.
    await engine.submitQueueShip(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-cargo-arm',
      expectedVersion: world.version,
      command: { kind: 'QueueShip', planetId: planet.id, ship: 'freighter', quantity: 1 },
    });
    await engine.resolveNextTick(world.id, 1000);
    await engine.resolveNextTick(world.id, 2000);
    const after = await engine.getWorld(world.id);
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;
    expect(local.ships.freighter).toBe(1);

    const loaded = await engine.loadCargo(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-load',
      expectedVersion: after!.version,
      command: { kind: 'LoadCargo', fleetId: local.id, resources: { metal: 100, food: 50 } },
    });
    expect(loaded.op).toBe('load');
    const afterLoad = await engine.getWorldView(world.id);
    const loadedView = afterLoad.fleets.find((f) => f.id === local.id)!;
    expect(loadedView.cargo.metal).toBe(100);
    expect(loadedView.cargo.food).toBe(50);
    const planetAfterLoad = afterLoad.planets.find((p) => p.id === planet.id)!;
    // The economy clamps the store at the base 500 cap, so 500 − 100 loaded.
    expect(planetAfterLoad.resources.metal).toBe(400);

    const unloaded = await engine.unloadCargo(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-unload',
      expectedVersion: afterLoad.version,
      command: { kind: 'UnloadCargo', fleetId: local.id, resources: { metal: 100 } },
    });
    expect(unloaded.op).toBe('unload');
    const finalView = await engine.getWorldView(world.id);
    const unloadedView = finalView.fleets.find((f) => f.id === local.id)!;
    expect(unloadedView.cargo.metal).toBe(0);
    const planetFinal = finalView.planets.find((p) => p.id === planet.id)!;
    expect(planetFinal.resources.metal).toBe(500); // 400 + 100, back at the cap
  });
});

describe('TickEngine M3 (scans and intelligence)', () => {
  /** Home planet with a Scanner Array and a rich store, saved to the repo. */
  async function scanWorld(scannerLevel = 3) {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const planet = world.planets.find((p) => p.id === world.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1, scanner: scannerLevel };
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    // Give a foreign target meaningful private state to round. The nearest
    // non-home planet is ~8 map units away — always in scan range.
    const target = world.planets
      .filter((p) => p.id !== planet.id)
      .map((p) => ({ p, d: coordinateDistance(world.seed, planet.coordinate, p.coordinate) }))
      .sort((a, b) => a.d - b.d)[0]!.p;
    target.ownerId = 'player:other' as never;
    target.factionId = 'embers' as never;
    target.population = 1234;
    target.resources = { metal: 777, mineral: 321, food: 888, energy: 222 };
    await repository.saveWorld(world);
    return { engine, repository, world, planet, target };
  }

  it('runs a scan, records an immutable report, and shows it in the world view intel', async () => {
    const { engine, world, planet, target } = await scanWorld();
    const report = await engine.runScan(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-scan-1',
      expectedVersion: world.version,
      command: {
        kind: 'RunScan',
        sourcePlanetId: planet.id,
        target: target.coordinate,
        scan: 'basic',
      },
    });
    expect(report).toMatchObject({
      idempotencyKey: 'key-m3-scan-1',
      kind: 'basic',
      target: target.coordinate,
    });

    const view = await engine.getWorldView(world.id);
    expect(view.intel.planets).toHaveLength(1);
    expect(view.intel.planets[0]).toMatchObject({
      coordinate: target.coordinate,
      ownerId: 'player:other',
      scanKind: 'basic',
      population: 1200, // 1234 rounded to the nearest 100
    });
    expect(view.intel.planets[0].resources).toBeUndefined(); // basic never reveals stores
    expect(view.intel.reports[0].idempotencyKey).toBe('key-m3-scan-1');

    // The scanned world is now part of the galaxy view's known set.
    const galaxy = await engine.getGalaxyView(world.id);
    const knownPlanet = galaxy.planets.find((p) => p.id === target.id)!;
    expect(knownPlanet.known).toBe(true);
    const unknownPlanet = galaxy.planets.find((p) => p.id !== target.id && p.id !== planet.id)!;
    expect(unknownPlanet.known).toBe(false);
  });

  it('M3 acceptance: a scan never retrieves private state beyond its kind', async () => {
    const { engine, world, planet, target } = await scanWorld();
    await engine.runScan(world.id, world.players[0].id, {
      idempotencyKey: 'key-m3-scan-res',
      expectedVersion: world.version,
      command: {
        kind: 'RunScan',
        sourcePlanetId: planet.id,
        target: target.coordinate,
        scan: 'resource',
      },
    });
    const view = await engine.getWorldView(world.id);
    const intel = view.intel.planets[0];
    expect(intel.resources).toEqual({ metal: 800, mineral: 300, food: 900, energy: 200 });
    expect(intel.storageCap).toBeDefined();
    expect(intel.fleets).toBeUndefined();
    // The private store is never echoed exactly.
    expect(intel.resources?.metal).not.toBe(777);
  });

  it('rejects a scan from a planet without a Scanner Array', async () => {
    const { engine, world, target } = await scanWorld(0);
    await expect(
      engine.runScan(world.id, world.players[0].id, {
        idempotencyKey: 'key-m3-scan-noarr',
        expectedVersion: world.version,
        command: {
          kind: 'RunScan',
          sourcePlanetId: world.players[0].homePlanetId,
          target: target.coordinate,
          scan: 'basic',
        },
      }),
    ).rejects.toMatchObject({ code: 'SCANNER_REQUIRED' });
  });

  it('gates scan kinds behind the array level and rejects an out-of-range target', async () => {
    const { engine, world, planet, target } = await scanWorld(1);
    await expect(
      engine.runScan(world.id, world.players[0].id, {
        idempotencyKey: 'key-m3-scan-locked',
        expectedVersion: world.version,
        command: {
          kind: 'RunScan',
          sourcePlanetId: planet.id,
          target: target.coordinate,
          scan: 'military',
        },
      }),
    ).rejects.toMatchObject({ code: 'SCAN_LOCKED', details: { requiredScannerLevel: 3 } });
    await expect(
      engine.runScan(world.id, world.players[0].id, {
        idempotencyKey: 'key-m3-scan-far',
        expectedVersion: world.version,
        command: {
          kind: 'RunScan',
          sourcePlanetId: planet.id,
          target: { galaxy: 8, sector: 8, system: 8, planet: 6 },
          scan: 'basic',
        },
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  });

  it('previews scan reach and distance before committing', async () => {
    const { engine, world, planet, target } = await scanWorld();
    const preview = await engine.getScanPreview(world.id, planet.id, target.coordinate);
    expect(preview.distance).toBeGreaterThan(0);
    expect(preview.range).toBe(1500 + 3 * 700);
    expect(preview.inRange).toBe(true);
    const far = await engine.getScanPreview(world.id, planet.id, {
      galaxy: 8,
      sector: 8,
      system: 8,
      planet: 6,
    });
    expect(far.inRange).toBe(false);
  });

  it('replays an idempotency key without scanning twice', async () => {
    const { engine, world, planet, target } = await scanWorld();
    const envelope = {
      idempotencyKey: 'key-m3-scan-replay',
      expectedVersion: world.version,
      command: {
        kind: 'RunScan',
        sourcePlanetId: planet.id,
        target: target.coordinate,
        scan: 'basic',
      } as const,
    };
    const first = await engine.runScan(world.id, world.players[0].id, envelope);
    const second = await engine.runScan(world.id, world.players[0].id, envelope);
    expect(second.id).toBe(first.id);
    const view = await engine.getWorldView(world.id);
    expect(view.intel.reports).toHaveLength(1);
  });
});

describe('TickEngine M4 (admin surface)', () => {
  it('lists worlds and players across the repository', async () => {
    const { engine } = makeEngine();
    await engine.createWorld({ seed: 1337, createdAt: 0 });
    await engine.createWorld({ seed: 42, createdAt: 0 });
    const worlds = await engine.listWorlds();
    expect(worlds.map((w) => w.seed).sort((a, b) => a - b)).toEqual([42, 1337]);
    const players = await engine.listPlayers();
    expect(players).toHaveLength(2);
    expect(new Set(players.map((p) => p.worldId))).toEqual(new Set(worlds.map((w) => w.id)));
    expect(players[0]!.player.id).toContain('player:');
  });

  it('builds the world admin detail from the aggregate', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await engine.resolveNextTick(world.id, 1000);
    const detail = await engine.getWorldAdminDetail(world.id);
    expect(detail.summary.id).toBe(world.id);
    expect(detail.summary.tick).toBe(1);
    expect(detail.summary.playerCount).toBe(1);
    expect(detail.summary.planetCount).toBe(world.planets.length);
    expect(detail.summary.fleetCount).toBeGreaterThanOrEqual(1);
    expect(detail.players).toHaveLength(1);
    expect(detail.players[0]!.name).toBe(world.players[0]!.name);
    expect(detail.fleets.length).toBe(detail.summary.fleetCount);
  });

  it('grants resources to a home planet clamped at the storage cap', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const player = world.players[0]!;
    const result = await engine.grantResources(world.id, player.id, { metal: 50, food: 20 });
    const view = await engine.getWorldView(world.id);
    const home = view.player.homePlanet;
    expect(home.resources.metal).toBeGreaterThanOrEqual(50);
    expect(result.storageCap).toBe(home.storageCap);
    // Clamp: a huge grant lands exactly on the cap, never above.
    const huge = await engine.grantResources(world.id, player.id, { energy: 1_000_000 });
    expect(huge.resources.energy).toBe(huge.storageCap);
  });

  it('rejects a grant for an unknown player', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await expect(
      engine.grantResources(world.id, 'player:nope' as never, { metal: 10 }),
    ).rejects.toThrow(/not found/);
  });

  it('returns a player dossier with home planet, fleets, and research', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const player = world.players[0]!;
    const { worldId, detail } = await engine.getPlayerAdminDetail(player.id);
    expect(worldId).toBe(world.id);
    expect(detail.player.playerId).toBe(player.id);
    expect(detail.homePlanet.id).toBe(player.homePlanetId);
    expect(detail.homePlanet.storageCap).toBeGreaterThan(0);
    expect(detail.fleets.length).toBeGreaterThanOrEqual(1);
    expect(detail.research.completed).toEqual([]);
  });

  it('rejects a dossier for a player in no world', async () => {
    const { engine } = makeEngine();
    await engine.createWorld({ seed: 1337, createdAt: 0 });
    await expect(engine.getPlayerAdminDetail('player:nope' as never)).rejects.toThrow(
      /not found in any world/,
    );
  });

  it('removes a player, their fleets, and their ownership in one step', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const player = world.players[0]!;
    await engine.removePlayer(world.id, player.id);
    const after = await repository.getWorld(world.id);
    expect(after!.players.find((p) => p.id === player.id)).toBeUndefined();
    expect(after!.fleets.filter((f) => f.ownerId === player.id)).toHaveLength(0);
    const home = after!.planets.find((p) => p.id === player.homePlanetId)!;
    expect(home.ownerId).toBeNull();
    expect(home.localFleets).toHaveLength(0);
  });

  it('removing a missing player rejects with not-found', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await expect(engine.removePlayer(world.id, 'player:nope' as never)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('TickScheduler', () => {
  it('resolves worlds that are due and skips those that are not', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const notDue = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => 999,
    });
    expect(await notDue.checkDue()).toHaveLength(0);
    const due = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => world.nextTickAt + 1,
    });
    const resolutions = await due.checkDue();
    expect(resolutions).toHaveLength(1);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
  });

  it('skips a world stored under a stale content version instead of ticking it', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    // A dev leftover from a previous content era: the scheduler must never
    // run M2 systems over its old-shape state (the crash that killed the API).
    const stale = { ...world, contentVersion: 'content-4' as const };
    await repository.saveWorld(stale);

    const scheduler = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => stale.nextTickAt + 1,
    });
    const resolutions = await scheduler.checkDue();
    expect(resolutions).toHaveLength(0);
    // Untouched: still content-4, still on its original tick.
    const after = await repository.getWorld(world.id);
    expect(after!.contentVersion).toBe('content-4');
    expect(after!.tick).toBe(0);
  });

  it('resolves a due world whose stored state is missing M2 fields without crashing', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    // Simulate a hot-reload shape drift: current content version, but the
    // stored JSONB predates M2's shipyardOrders/researchOrders/fleets fields.
    const drifted = {
      ...world,
      planets: world.planets.map((p) => stripM2PlanetFields(p)),
      players: world.players.map((pl) => stripM2PlayerFields(pl)),
      fleets: undefined,
    } as never;
    await repository.saveWorld(drifted);

    const scheduler = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => world.nextTickAt + 1,
    });
    const resolutions = await scheduler.checkDue();
    expect(resolutions).toHaveLength(1);
    expect((await repository.getWorld(world.id))?.tick).toBe(1);
  });
});

// M2 regression helper: rebuild a planet/player record WITHOUT the M2 fields
// (shipyardOrders, localFleets / researchOrders, technologies) to simulate a
// stored world written by hot-reloaded pre-M2 code.
function stripM2PlanetFields(p: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'shipyardOrders' || k === 'localFleets') continue;
    rest[k] = v;
  }
  return rest;
}

function stripM2PlayerFields(p: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'researchOrders' || k === 'technologies') continue;
    rest[k] = v;
  }
  return rest;
}
