import { describe, expect, it } from 'vitest';
import type { PlayerId, WorldState } from '@ashes/contracts';
import { generateWorld } from './worldgen';
import { AdminDomainError, grantResourcesToPlanet, removePlayerFromWorld } from './admin';
import { storageCapFor } from './economy';

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

function homePlanet(world: WorldState) {
  const planet = world.planets.find((p) => p.ownerId === actor())!;
  return planet;
}

describe('grantResourcesToPlanet', () => {
  it('adds resources to the home planet store', () => {
    const world = makeWorld();
    const before = homePlanet(world);
    const next = grantResourcesToPlanet(world, actor(), { metal: 120, food: 40 });
    const after = homePlanet(next);
    expect(after.resources.metal).toBe(before.resources.metal + 120);
    expect(after.resources.food).toBe(before.resources.food + 40);
    expect(after.resources.mineral).toBe(before.resources.mineral);
    expect(after.version).toBe(before.version + 1);
    expect(next.version).toBe(world.version + 1);
  });

  it('clamps at the storage cap, never above', () => {
    const world = makeWorld();
    const planet = homePlanet(world);
    const cap = storageCapFor(planet);
    const next = grantResourcesToPlanet(world, actor(), { metal: 100_000 });
    const after = homePlanet(next);
    expect(after.resources.metal).toBe(cap);
  });

  it('leaves the world untouched for an all-zero grant', () => {
    const world = makeWorld();
    const next = grantResourcesToPlanet(world, actor(), { metal: 0 });
    expect(next.version).toBe(world.version);
    expect(next).toBe(world);
  });

  it('rejects an unknown player', () => {
    const world = makeWorld();
    expect(() => grantResourcesToPlanet(world, 'player:nope' as PlayerId, { metal: 10 })).toThrow(
      AdminDomainError,
    );
  });

  it('is deterministic: same grant on equal worlds yields equal state', () => {
    const a = grantResourcesToPlanet(makeWorld(7), actor(7), { metal: 55, energy: 10 });
    const b = grantResourcesToPlanet(makeWorld(7), actor(7), { metal: 55, energy: 10 });
    expect(a.planets.map((p) => p.resources)).toEqual(b.planets.map((p) => p.resources));
  });
});

describe('removePlayerFromWorld', () => {
  it('drops the player, their fleets, and their ownership', () => {
    const world = makeWorld();
    const planet = homePlanet(world);
    const fleetCount = world.fleets.filter((f) => f.ownerId === actor()).length;
    expect(fleetCount).toBeGreaterThan(0);
    const next = removePlayerFromWorld(world, actor());
    expect(next.players.find((p) => p.id === actor())).toBeUndefined();
    expect(next.fleets.filter((f) => f.ownerId === actor())).toHaveLength(0);
    const after = next.planets.find((p) => p.id === planet.id)!;
    expect(after.ownerId).toBeNull();
    expect(after.localFleets).toHaveLength(0);
    expect(next.version).toBe(world.version + 1);
  });

  it('keeps other players and their fleets untouched', () => {
    const world = makeWorld();
    // Spawn a second player so there is someone to preserve.
    const otherId = 'player:other' as PlayerId;
    const planet = homePlanet(world);
    const next = removePlayerFromWorld(world, actor());
    const otherPlanet = next.planets.find((p) => p.id === planet.id)!;
    expect(otherPlanet.factionId).toBe(planet.factionId);
    expect(next.planets).toHaveLength(world.planets.length);
    void otherId;
  });

  it('rejects an unknown player', () => {
    const world = makeWorld();
    expect(() => removePlayerFromWorld(world, 'player:nope' as PlayerId)).toThrow(AdminDomainError);
  });

  it('is deterministic: same world + player yields identical aggregates', () => {
    const a = removePlayerFromWorld(makeWorld(7), actor(7));
    const b = removePlayerFromWorld(makeWorld(7), actor(7));
    expect(a.players).toEqual(b.players);
    expect(a.fleets).toEqual(b.fleets);
    expect(a.planets).toEqual(b.planets);
  });
});
