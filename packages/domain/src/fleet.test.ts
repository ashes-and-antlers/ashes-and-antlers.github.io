import { describe, expect, it } from 'vitest';
import type { Fleet, PlayerId, WorldState } from '@ashes/contracts';
import { emptyResourceStore } from '@ashes/contracts';
import { generateWorld } from './worldgen';
import { fleetCargoCapacity, fleetViews, localFleetId, splitFleet, transferFleet } from './fleet';

function makeWorld(seed = 1337) {
  return generateWorld({
    seed,
    config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
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

/** A second fleet docked at the same location as the home planet. */
function addCoLocatedFleet(world: WorldState): WorldState {
  const home = world.planets.find((p) => p.ownerId === actor())!;
  const second: Fleet = {
    id: `fleet:detachment:test` as Fleet['id'],
    ownerId: actor(),
    homePlanetId: null,
    location: home.coordinate,
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
  return { ...world, fleets: [...world.fleets, second] };
}

/** World whose local fleet holds 2 scouts and 1 freighter with cargo. */
function armedWorld(seed = 1337) {
  const world = makeWorld(seed);
  const fleet = localFleet(world);
  fleet.ships = { scout: 2, freighter: 1 };
  fleet.cargo = { metal: 100, mineral: 40, food: 0, energy: 0 };
  return world;
}

describe('fleetViews', () => {
  it('lists the local fleet with a derived display name', () => {
    const world = makeWorld();
    const views = fleetViews(world, actor());
    expect(views).toHaveLength(1);
    const view = views[0];
    expect(view.id).toBe(localFleet(world).id);
    expect(view.homePlanetId).toBe(localFleet(world).homePlanetId);
    expect(view.name).toContain('Local fleet');
    expect(view.state).toBe('orbiting');
    expect(view.driveTier).toBe('planetary'); // empty fleet: no drive
  });
});

describe('fleetCargoCapacity', () => {
  it('sums cargo capacity over the fleet ships', () => {
    const world = armedWorld();
    const fleet = localFleet(world);
    // Freighter 200 + scouts 0.
    expect(fleetCargoCapacity(fleet)).toBe(200);
  });
});

describe('splitFleet', () => {
  it('moves the given ships into a new detachment at the same location', () => {
    const world = armedWorld();
    const result = splitFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'split-1',
        expectedVersion: world.version,
        command: { kind: 'SplitFleet', fleetId: localFleet(world).id, ships: { scout: 1 } },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.world.fleets.find((f) => f.id === localFleetId(homeOf(result.world)))!;
    expect(source.ships.scout).toBe(1);
    expect(source.ships.freighter).toBe(1);
    const detachment = result.world.fleets.find((f) => f.id === result.receipt.newFleetId);
    expect(detachment).toBeTruthy();
    expect(detachment!.homePlanetId).toBeNull();
    expect(detachment!.ships.scout).toBe(1);
    expect(detachment!.location).toEqual(source.location);
    expect(result.world.fleetOps).toHaveLength(1);
  });

  it('rejects when the source lacks the ships', () => {
    const world = armedWorld();
    const result = splitFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'split-poor',
        expectedVersion: world.version,
        command: { kind: 'SplitFleet', fleetId: localFleet(world).id, ships: { fighter: 2 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_SHIPS');
    if (result.error.code !== 'INSUFFICIENT_SHIPS') return;
    expect(result.error.ship).toBe('fighter');
  });

  it('rejects a split that moves nothing', () => {
    const world = armedWorld();
    const result = splitFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'split-empty',
        expectedVersion: world.version,
        command: { kind: 'SplitFleet', fleetId: localFleet(world).id, ships: {} },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_TRANSFER');
  });

  it('rejects a fleet the actor does not own', () => {
    const world = armedWorld();
    const stranger: Fleet = {
      ...localFleet(world),
      id: 'fleet:stranger' as Fleet['id'],
      ownerId: 'player:other' as PlayerId,
    };
    const result = splitFleet(
      { ...world, fleets: [...world.fleets, stranger] },
      {
        actorId: actor(),
        idempotencyKey: 'split-stranger',
        expectedVersion: world.version,
        command: { kind: 'SplitFleet', fleetId: stranger.id, ships: { scout: 1 } },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('is idempotent per key: replay returns the original receipt without moving ships twice', () => {
    const world = armedWorld();
    const input = {
      actorId: actor(),
      idempotencyKey: 'split-replay',
      expectedVersion: world.version,
      command: { kind: 'SplitFleet' as const, fleetId: localFleet(world).id, ships: { scout: 1 } },
      submittedAt: 1000,
    };
    const first = splitFleet(world, input, 1000);
    if (!first.ok) throw new Error('first split failed');
    const replay = splitFleet(first.world, input, 1000);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.receipt.id).toBe(first.receipt.id);
    // Ships are only moved once.
    const detachment = replay.world.fleets.find((f) => f.id === first.receipt.newFleetId)!;
    expect(detachment.ships.scout).toBe(1);
    const source = replay.world.fleets.find((f) => f.id === localFleetId(homeOf(replay.world)))!;
    expect(source.ships.scout).toBe(1);
  });
});

describe('transferFleet', () => {
  it('transfers ships and cargo between co-located fleets, bounded by target capacity', () => {
    const world = addCoLocatedFleet(armedWorld());
    const from = localFleet(world);
    const to = world.fleets.find((f) => f.homePlanetId === null)!;
    to.ships = { freighter: 1 }; // 200 capacity
    to.cargo = { metal: 100, mineral: 0, food: 0, energy: 0 };

    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-1',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: from.id,
          toFleetId: to.id,
          ships: { scout: 2 },
          cargo: { metal: 50, mineral: 40 },
        },
      },
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const afterFrom = result.world.fleets.find((f) => f.id === from.id)!;
    const afterTo = result.world.fleets.find((f) => f.id === to.id)!;
    expect(afterFrom.ships.scout).toBeUndefined();
    expect(afterFrom.cargo).toEqual({ metal: 50, mineral: 0, food: 0, energy: 0 });
    expect(afterTo.ships.scout).toBe(2);
    // 100 held + 50 metal + 40 mineral = 190 ≤ 200 (freighter) + 0 (scouts).
    expect(afterTo.cargo).toEqual({ metal: 150, mineral: 40, food: 0, energy: 0 });
    expect(result.world.fleetOps).toHaveLength(1);
  });

  it('rejects transferring to itself', () => {
    const world = armedWorld();
    const id = localFleet(world).id;
    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-self',
        expectedVersion: world.version,
        command: { kind: 'TransferFleet', fromFleetId: id, toFleetId: id, ships: {} },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANNOT_TRANSFER_TO_SELF');
  });

  it('rejects fleets that are not co-located', () => {
    const world = armedWorld();
    const far: Fleet = {
      ...localFleet(world),
      id: 'fleet:far' as Fleet['id'],
      location: { galaxy: 1, sector: 1, system: 1, planet: 2 },
    };
    const result = transferFleet(
      { ...world, fleets: [...world.fleets, far] },
      {
        actorId: actor(),
        idempotencyKey: 'transfer-far',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: localFleet(world).id,
          toFleetId: far.id,
          ships: { scout: 1 },
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FLEETS_NOT_CO_LOCATED');
  });

  it('rejects cargo that exceeds the target capacity', () => {
    const world = addCoLocatedFleet(armedWorld());
    const from = localFleet(world);
    const to = world.fleets.find((f) => f.homePlanetId === null)!;
    // Detachment has no ships: 0 cargo capacity.
    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-cap',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: from.id,
          toFleetId: to.id,
          ships: {},
          cargo: { metal: 10 },
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CARGO_CAPACITY_EXCEEDED');
  });

  it('rejects cargo that would push the target over its cap even when the incoming amount alone fits', () => {
    const world = addCoLocatedFleet(armedWorld());
    const from = localFleet(world);
    const to = world.fleets.find((f) => f.homePlanetId === null)!;
    to.ships = { freighter: 1 }; // 200 capacity
    to.cargo = { metal: 180, mineral: 0, food: 0, energy: 0 };

    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-cap2',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: from.id,
          toFleetId: to.id,
          ships: {},
          cargo: { metal: 50 },
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CARGO_CAPACITY_EXCEEDED');
    if (result.error.code !== 'CARGO_CAPACITY_EXCEEDED') return;
    // The full resulting load (180 + 50 = 230) is what exceeds the 200 cap.
    expect(result.error.want).toBe(230);
  });

  it('rejects moving cargo the source does not hold', () => {
    const world = addCoLocatedFleet(armedWorld());
    const from = localFleet(world);
    const to = world.fleets.find((f) => f.homePlanetId === null)!;
    to.ships = { freighter: 1 };
    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-cargo',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: from.id,
          toFleetId: to.id,
          ships: {},
          cargo: { metal: 999 },
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CARGO_CAPACITY_EXCEEDED');
  });

  it('rejects an empty transfer', () => {
    const world = addCoLocatedFleet(armedWorld());
    const from = localFleet(world);
    const to = world.fleets.find((f) => f.homePlanetId === null)!;
    const result = transferFleet(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'transfer-empty',
        expectedVersion: world.version,
        command: {
          kind: 'TransferFleet',
          fromFleetId: from.id,
          toFleetId: to.id,
          ships: {},
          cargo: {},
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EMPTY_TRANSFER');
  });
});

function homeOf(world: WorldState): string {
  const player = world.players.find((p) => p.id === actor())!;
  return player.homePlanetId;
}
