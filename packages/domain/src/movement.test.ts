import { describe, expect, it } from 'vitest';
import type { Coordinate, Fleet, PlayerId, WorldState } from '@ashes/contracts';
import { emptyResourceStore } from '@ashes/contracts';
import { generateWorld } from './worldgen';
import { localFleetId } from './fleet';
import {
  isCoordinateInWorld,
  resolveMovementTick,
  submitLoadCargo,
  submitRecallFleet,
  submitSendFleet,
  submitUnloadCargo,
} from './movement';
import { coordinateDistance, travelTicks } from './travel';

function makeWorld(seed = 1337, config?: Partial<Parameters<typeof generateWorld>[0]['config']>) {
  return generateWorld({
    seed,
    config: {
      galaxies: 1,
      sectorsPerGalaxy: 2,
      systemsPerSector: 2,
      planetsPerSystem: 3,
      ...config,
    },
  });
}

function actor(seed = 1337): PlayerId {
  return `player:${seed}` as PlayerId;
}

function localFleet(world: WorldState): Fleet {
  const planet = world.planets.find((p) => p.ownerId === actor())!;
  const fleet = world.fleets.find((f) => f.id === localFleetId(planet.id));
  if (!fleet) throw new Error('local fleet missing');
  return fleet;
}

/** World whose home fleet holds 2 scouts + 1 freighter with a 200-unit hold. */
function armedWorld(seed = 1337) {
  const world = makeWorld(seed);
  const fleet = localFleet(world);
  fleet.ships = { scout: 2, freighter: 1 };
  fleet.cargo = { metal: 50, mineral: 0, food: 0, energy: 0 };
  const planet = world.planets.find((p) => p.id === fleet.homePlanetId)!;
  // Below the base storage cap (500) so cargo ops never hit the clamp.
  planet.resources = { metal: 400, mineral: 300, food: 200, energy: 100 };
  return world;
}

/** A valid in-world destination away from the home planet. */
function destination(world: WorldState): Coordinate {
  const home = world.planets.find((p) => p.ownerId === actor())!.coordinate;
  return { ...home, planet: home.planet === 1 ? 2 : 1 };
}

function sendInput(world: WorldState, key: string, mission = 'transport' as const) {
  return {
    actorId: actor(),
    idempotencyKey: key,
    expectedVersion: world.version,
    command: {
      kind: 'SendFleet' as const,
      fleetId: localFleet(world).id,
      destination: destination(world),
      mission,
    },
  };
}

describe('isCoordinateInWorld', () => {
  it('accepts coordinates inside the finite space and rejects outside it', () => {
    // The content-defined space: 8 galaxies × 8 sectors × 8 systems × 6 planets.
    expect(isCoordinateInWorld({ galaxy: 1, sector: 1, system: 1, planet: 1 })).toBe(true);
    expect(isCoordinateInWorld({ galaxy: 8, sector: 8, system: 8, planet: 6 })).toBe(true);
    expect(isCoordinateInWorld({ galaxy: 9, sector: 1, system: 1, planet: 1 })).toBe(false);
    expect(isCoordinateInWorld({ galaxy: 0, sector: 1, system: 1, planet: 1 })).toBe(false);
    expect(isCoordinateInWorld({ galaxy: 1, sector: 1, system: 1, planet: 7 })).toBe(false);
  });
});

describe('submitSendFleet', () => {
  it('puts an armed fleet in flight with the deterministic travel calculation', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const to = destination(world);
    const distance = coordinateDistance(world.seed, fleet.location, to);
    const expected = travelTicks({ distance, driveTier: 'stellar', navigationSpeedBonus: 0 });

    const result = submitSendFleet(world, sendInput(world, 'send-1'), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const moving = result.world.fleets.find((f) => f.id === fleet.id)!;
    expect(moving.state).toBe('moving');
    expect(moving.mission).toEqual({
      kind: 'transport',
      destination: to,
      departureTick: world.tick,
      arrivalTick: world.tick + expected,
    });
    expect(moving.arrivalTick).toBe(world.tick + expected);
    expect(moving.departureTick).toBe(world.tick);
    expect(moving.route).toEqual([to]);
    // The fleet stays at its origin while in flight.
    expect(moving.location).toEqual(fleet.location);
    expect(result.world.fleetOps).toHaveLength(1);
  });

  it('rejects a fleet the actor does not own', () => {
    const world = armedWorld();
    const stranger: Fleet = {
      ...localFleet(world),
      id: 'fleet:stranger' as Fleet['id'],
      ownerId: 'player:other' as PlayerId,
    };
    const result = submitSendFleet(
      { ...world, fleets: [...world.fleets, stranger] },
      {
        actorId: actor(),
        idempotencyKey: 'send-stranger',
        expectedVersion: world.version,
        command: {
          kind: 'SendFleet',
          fleetId: stranger.id,
          destination: destination(world),
          mission: 'transport',
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('rejects a fleet already in flight', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'send-twice-a'), 1000);
    if (!sent.ok) throw new Error('first send failed');
    const result = submitSendFleet(sent.world, sendInput(sent.world, 'send-twice-b'), 1000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLEET_NOT_ORBITING');
  });

  it('rejects an empty fleet', () => {
    const world = makeWorld(); // local fleet has no ships
    const result = submitSendFleet(world, sendInput(world, 'send-empty'), 1000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_FLEET');
  });

  it('rejects a destination outside the world', () => {
    const world = armedWorld();
    const result = submitSendFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'send-outside',
        expectedVersion: world.version,
        command: {
          kind: 'SendFleet',
          fleetId: localFleet(world).id,
          destination: { galaxy: 9, sector: 1, system: 1, planet: 1 },
          mission: 'transport',
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_DESTINATION');
  });

  it('rejects sending to the fleet current location', () => {
    const world = armedWorld();
    const here = localFleet(world).location;
    const result = submitSendFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'send-here',
        expectedVersion: world.version,
        command: {
          kind: 'SendFleet',
          fleetId: localFleet(world).id,
          destination: here,
          mission: 'transport',
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SAME_LOCATION');
  });

  it('rejects a mission kind outside the M3 set', () => {
    const world = armedWorld();
    const result = submitSendFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'send-mission',
        expectedVersion: world.version,
        command: {
          kind: 'SendFleet',
          fleetId: localFleet(world).id,
          destination: destination(world),
          mission: 'invade' as never,
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MISSION_UNSUPPORTED');
  });

  it('rejects a stale expected version', () => {
    const world = armedWorld();
    const result = submitSendFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'send-stale',
        expectedVersion: world.version - 1,
        command: {
          kind: 'SendFleet',
          fleetId: localFleet(world).id,
          destination: destination(world),
          mission: 'transport',
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STALE_VERSION');
  });

  it('is idempotent per key: replay returns the stored receipt without a second send', () => {
    const world = armedWorld();
    const input = sendInput(world, 'send-replay');
    const first = submitSendFleet(world, input, 1000);
    if (!first.ok) throw new Error('first send failed');
    const replay = submitSendFleet(first.world, input, 1000);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.receipt.id).toBe(first.receipt.id);
    const moving = replay.world.fleets.find((f) => f.id === localFleet(world).id)!;
    expect(moving.state).toBe('moving');
    expect(moving.arrivalTick).toBe(
      first.world.fleets.find((f) => f.id === localFleet(world).id)!.arrivalTick,
    );
  });
});

describe('resolveMovementTick (arrival)', () => {
  it('docks a fleet at its destination on the calculated tick', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'arrive-1'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const fleetId = localFleet(world).id;
    const arrivalTick = sent.world.fleets.find((f) => f.id === fleetId)!.arrivalTick!;
    const to = destination(world);

    // Before the arrival tick the fleet is still in flight at its origin.
    const midFlight = resolveMovementTick(sent.world, arrivalTick - 1);
    const stillMoving = midFlight.fleets.find((f) => f.id === fleetId)!;
    expect(stillMoving.state).toBe('moving');
    expect(stillMoving.location).toEqual(
      world.planets.find((p) => p.ownerId === actor())!.coordinate,
    );

    // On the arrival tick it snaps to the destination and returns to orbit.
    const arrived = resolveMovementTick(sent.world, arrivalTick);
    const docked = arrived.fleets.find((f) => f.id === fleetId)!;
    expect(docked.state).toBe('orbiting');
    expect(docked.location).toEqual(to);
    expect(docked.mission).toBeNull();
    expect(docked.departureTick).toBeNull();
    expect(docked.arrivalTick).toBeNull();
    // Cargo and ships travel with the fleet.
    expect(docked.ships.scout).toBe(2);
    expect(docked.cargo.metal).toBe(50);
  });

  it('is idempotent: re-resolving the arrival tick never moves the fleet again', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'arrive-2'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const fleetId = localFleet(world).id;
    const arrivalTick = sent.world.fleets.find((f) => f.id === fleetId)!.arrivalTick!;

    const arrived = resolveMovementTick(sent.world, arrivalTick);
    const replay = resolveMovementTick(arrived, arrivalTick);
    // The re-resolved world is byte-identical to the arrived one (no change).
    expect(replay).toBe(arrived);
    const docked = replay.fleets.find((f) => f.id === fleetId)!;
    expect(docked.state).toBe('orbiting');
    expect(docked.location).toEqual(destination(world));
  });

  it('resolves a returning fleet back at its origin', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'arrive-3'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const fleetId = localFleet(world).id;
    const moving = sent.world.fleets.find((f) => f.id === fleetId)!;
    const origin = moving.location;

    const recalled = submitRecallFleet(
      sent.world,
      {
        actorId: actor(),
        idempotencyKey: 'arrive-3-recall',
        expectedVersion: sent.world.version,
        command: { kind: 'RecallFleet', fleetId },
      },
      2000,
    );
    if (!recalled.ok) throw new Error('recall failed');
    const returning = recalled.world.fleets.find((f) => f.id === fleetId)!;
    const returnArrival = returning.arrivalTick!;

    const home = resolveMovementTick(recalled.world, returnArrival);
    const docked = home.fleets.find((f) => f.id === fleetId)!;
    expect(docked.state).toBe('orbiting');
    expect(docked.location).toEqual(origin);
    expect(docked.mission).toBeNull();
  });
});

describe('submitRecallFleet', () => {
  it('turns a moving fleet around; an immediate recall gets home next tick', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'recall-1'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const fleetId = localFleet(world).id;
    // Recall at the same tick as departure: progress p = 0, so the fleet is
    // still at the origin and returns in the minimum one tick.
    const result = submitRecallFleet(
      sent.world,
      {
        actorId: actor(),
        idempotencyKey: 'recall-1b',
        expectedVersion: sent.world.version,
        command: { kind: 'RecallFleet', fleetId },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const returning = result.world.fleets.find((f) => f.id === fleetId)!;
    expect(returning.state).toBe('returning');
    expect(returning.mission?.kind).toBe('return');
    expect(returning.mission?.destination).toEqual(returning.location); // home
    expect(returning.arrivalTick).toBe(sent.world.tick + 1);
  });

  it('a mid-flight recall returns faster than the full outbound trip', () => {
    // A long outbound route (cross-galaxy) makes the progress rule visible.
    const world = armedWorld(1337);
    const fleet = localFleet(world);
    const to = { galaxy: 2, sector: 1, system: 1, planet: 1 };
    const outboundTicks = travelTicks({
      distance: coordinateDistance(world.seed, fleet.location, to),
      driveTier: 'stellar',
      navigationSpeedBonus: 0,
    });
    expect(outboundTicks).toBeGreaterThan(2);

    const sent = submitSendFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'recall-far-a',
        expectedVersion: world.version,
        command: { kind: 'SendFleet', fleetId: fleet.id, destination: to, mission: 'scout' },
      },
      1000,
    );
    if (!sent.ok) throw new Error('send failed');
    // One tick of progress: p = 1/outboundTicks — most of the route remains
    // ahead, so the return trip is much shorter than the full outbound trip.
    const mid = resolveMovementTick(sent.world, sent.world.tick + 1);
    const recalled = submitRecallFleet(
      mid,
      {
        actorId: actor(),
        idempotencyKey: 'recall-far-b',
        expectedVersion: mid.version,
        command: { kind: 'RecallFleet', fleetId: fleet.id },
      },
      2000,
    );
    if (!recalled.ok) throw new Error('recall failed');
    const returning = recalled.world.fleets.find((f) => f.id === fleet.id)!;
    const returnTicks = returning.arrivalTick! - mid.tick;
    expect(returnTicks).toBeLessThan(outboundTicks);
  });

  it('rejects recalling an orbiting fleet', () => {
    const world = armedWorld();
    const result = submitRecallFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'recall-idle',
        expectedVersion: world.version,
        command: { kind: 'RecallFleet', fleetId: localFleet(world).id },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLEET_NOT_MOVING');
  });

  it('rejects recalling a fleet already returning', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'recall-2'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const recalled = submitRecallFleet(
      sent.world,
      {
        actorId: actor(),
        idempotencyKey: 'recall-2b',
        expectedVersion: sent.world.version,
        command: { kind: 'RecallFleet', fleetId: localFleet(world).id },
      },
      1000,
    );
    if (!recalled.ok) throw new Error('first recall failed');
    const again = submitRecallFleet(
      recalled.world,
      {
        actorId: actor(),
        idempotencyKey: 'recall-2c',
        expectedVersion: recalled.world.version,
        command: { kind: 'RecallFleet', fleetId: localFleet(world).id },
      },
      1000,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('ALREADY_RETURNING');
  });

  it('is idempotent per key', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'recall-3'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const input = {
      actorId: actor(),
      idempotencyKey: 'recall-3b',
      expectedVersion: sent.world.version,
      command: { kind: 'RecallFleet' as const, fleetId: localFleet(world).id },
    };
    const first = submitRecallFleet(sent.world, input, 1000);
    if (!first.ok) throw new Error('first recall failed');
    const replay = submitRecallFleet(first.world, input, 1000);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.receipt.id).toBe(first.receipt.id);
  });
});

describe('submitLoadCargo', () => {
  it('moves resources from the owned planet store into the fleet hold', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const planet = world.planets.find((p) => p.id === fleet.homePlanetId)!;
    const result = submitLoadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'load-1',
        expectedVersion: world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: { metal: 100, food: 50 } },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = result.world.fleets.find((f) => f.id === fleet.id)!;
    expect(loaded.cargo).toEqual({ metal: 150, mineral: 0, food: 50, energy: 0 });
    const afterPlanet = result.world.planets.find((p) => p.id === planet.id)!;
    expect(afterPlanet.resources).toEqual({ metal: 300, mineral: 300, food: 150, energy: 100 });
  });

  it('rejects a load that exceeds the fleet cargo capacity', () => {
    const world = armedWorld(); // freighter 200 + scouts 0 = 200 capacity
    const fleet = localFleet(world);
    const result = submitLoadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'load-cap',
        expectedVersion: world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: { metal: 300 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CARGO_CAPACITY_EXCEEDED');
    if (result.error.code !== 'CARGO_CAPACITY_EXCEEDED') return;
    // 50 already held + 300 = 350 > 200.
    expect(result.error.want).toBe(350);
    expect(result.error.capacity).toBe(200);
  });

  it('rejects loading more than the planet holds', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    // Empty the hold and double the freighters so capacity (400) is not the
    // binding constraint — the planet store (300 mineral) is.
    fleet.cargo = emptyResourceStore();
    fleet.ships = { freighter: 2 };
    const result = submitLoadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'load-poor',
        expectedVersion: world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: { mineral: 350 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
  });

  it('rejects loading at a planet the actor does not own', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const foreign = world.planets.find((p) => p.ownerId !== actor())!;
    const moved: Fleet = { ...fleet, location: foreign.coordinate };
    const result = submitLoadCargo(
      { ...world, fleets: world.fleets.map((f) => (f.id === fleet.id ? moved : f)) },
      {
        actorId: actor(),
        idempotencyKey: 'load-foreign',
        expectedVersion: world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: { metal: 10 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('rejects loading while the fleet is in flight', () => {
    const world = armedWorld();
    const sent = submitSendFleet(world, sendInput(world, 'load-flight'), 1000);
    if (!sent.ok) throw new Error('send failed');
    const fleet = sent.world.fleets.find((f) => f.id === localFleet(world).id)!;
    const result = submitLoadCargo(
      sent.world,
      {
        actorId: actor(),
        idempotencyKey: 'load-flight-b',
        expectedVersion: sent.world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: { metal: 10 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLEET_NOT_ORBITING');
  });
});

describe('submitUnloadCargo', () => {
  it('moves cargo back into the planet store', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const planet = world.planets.find((p) => p.id === fleet.homePlanetId)!;
    const result = submitUnloadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'unload-1',
        expectedVersion: world.version,
        command: { kind: 'UnloadCargo', fleetId: fleet.id, resources: { metal: 50 } },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unloaded = result.world.fleets.find((f) => f.id === fleet.id)!;
    expect(unloaded.cargo.metal).toBe(0);
    const afterPlanet = result.world.planets.find((p) => p.id === planet.id)!;
    expect(afterPlanet.resources.metal).toBe(450); // 400 stored + 50 unloaded
  });

  it('clamps the store addition at the planet storage cap', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const planet = world.planets.find((p) => p.id === fleet.homePlanetId)!;
    // A planet at its storage cap (500): the unloaded metal beyond the cap
    // vanishes (the same clamp policy as refunds — the store never exceeds
    // the cap). The fleet holds 50 metal and unloads all of it.
    planet.resources = { metal: 500, mineral: 0, food: 0, energy: 0 };
    const result = submitUnloadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'unload-cap',
        expectedVersion: world.version,
        command: { kind: 'UnloadCargo', fleetId: fleet.id, resources: { metal: 50 } },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const afterPlanet = result.world.planets.find((p) => p.id === planet.id)!;
    expect(afterPlanet.resources.metal).toBe(500); // capped, not 550
    const unloaded = result.world.fleets.find((f) => f.id === fleet.id)!;
    expect(unloaded.cargo.metal).toBe(0);
  });

  it('rejects unloading cargo the fleet does not hold', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const result = submitUnloadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'unload-poor',
        expectedVersion: world.version,
        command: { kind: 'UnloadCargo', fleetId: fleet.id, resources: { food: 10 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_CARGO');
  });

  it('rejects an empty load/unload and negative amounts', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    const empty = submitLoadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'cargo-empty',
        expectedVersion: world.version,
        command: { kind: 'LoadCargo', fleetId: fleet.id, resources: {} },
      },
      1000,
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe('EMPTY_TRANSFER');

    const negative = submitUnloadCargo(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'cargo-negative',
        expectedVersion: world.version,
        command: { kind: 'UnloadCargo', fleetId: fleet.id, resources: { metal: -5 } },
      },
      1000,
    );
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.error.code).toBe('INVALID_QUANTITY');
  });
});
