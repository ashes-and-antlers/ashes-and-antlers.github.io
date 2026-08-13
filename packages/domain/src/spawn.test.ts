import { describe, expect, it } from 'vitest';
import type { Player, Planet, WorldId, WorldState } from '@ashes/contracts';
import { emptyResourceStore, planetIdFromCoordinate } from '@ashes/contracts';
import { leastPopulatedFaction, pickSpawnCoordinate, spawnPlayerIntoWorld } from './spawn';

/**
 * A small world with a known layout: `galaxies` galaxies × 1 sector × 1
 * system × 3 planets, with the seeded player placed by hand so spawn picks
 * are fully predictable.
 */
function makeWorld(options: { galaxies: number; seedPlayerGalaxy?: number }): WorldState {
  const { galaxies, seedPlayerGalaxy = 1 } = options;
  const planets: Planet[] = [];
  for (let galaxy = 1; galaxy <= galaxies; galaxy++) {
    for (let planet = 1; planet <= 3; planet++) {
      const coordinate = { galaxy, sector: 1, system: 1, planet };
      planets.push({
        id: planetIdFromCoordinate(coordinate),
        coordinate,
        ownerId: null,
        factionId: null,
        name: `Planet ${galaxy}:${planet}`,
        abundance: { metal: 50, mineral: 50, food: 50, energy: 50 },
        population: 0,
        resources: emptyResourceStore(),
        buildings: {},
        constructionOrders: [],
        shipyardOrders: [],
        localFleets: [],
        lastResolvedTick: 0,
        version: 1,
      });
    }
  }
  const homeCoordinate = { galaxy: seedPlayerGalaxy, sector: 1, system: 1, planet: 1 };
  const home = planets.find(
    (p) =>
      p.coordinate.galaxy === homeCoordinate.galaxy &&
      p.coordinate.planet === homeCoordinate.planet,
  )!;
  home.ownerId = 'player:seed' as never;
  home.factionId = 'hearth' as never;
  const seedPlayer: Player = {
    id: 'player:seed' as never,
    name: 'Seeded Warden',
    factionId: 'hearth' as never,
    homePlanetId: home.id,
    token: 'seed-token',
    researchOrders: [],
    technologies: [],
    scanReports: [],
    version: 1,
  };
  return {
    id: 'world:test' as WorldId,
    seed: 1,
    tick: 0,
    nextTickAt: 0,
    createdAt: 0,
    lastResolvedAt: null,
    worldVersion: 'test',
    contentVersion: 'test',
    tickDurationMs: 1000,
    planets,
    players: [seedPlayer],
    fleets: [],
    fleetOps: [],
    worldHash: 'test',
    version: 1,
  };
}

function spawnOne(world: WorldState, n: number) {
  const result = spawnPlayerIntoWorld(world, {
    playerId: `player:acc-${n}` as never,
    name: `Commander ${n}`,
    factionId: 'iron' as never,
    token: `token-${n}`,
  });
  return result;
}

describe('leastPopulatedFaction', () => {
  it('assigns the faction with the fewest players, ties to content order', () => {
    // Seeded player is hearth: hearth 1, iron 0 → the first account goes iron.
    const world = makeWorld({ galaxies: 2, seedPlayerGalaxy: 1 });
    expect(leastPopulatedFaction(world)).toBe('iron');
  });

  it('rebalances toward the smaller side as players join', () => {
    const world = makeWorld({ galaxies: 2, seedPlayerGalaxy: 1 });
    const a = spawnPlayerIntoWorld(world, {
      playerId: 'player:a' as never,
      name: 'A',
      factionId: 'iron' as never,
      token: 't-a',
    });
    expect(leastPopulatedFaction(a.world)).toBe('hearth'); // 1 hearth, 1 iron → tie → hearth

    const b = spawnPlayerIntoWorld(a.world, {
      playerId: 'player:b' as never,
      name: 'B',
      factionId: 'iron' as never,
      token: 't-b',
    });
    // hearth 1, iron 2 → back to hearth.
    expect(leastPopulatedFaction(b.world)).toBe('hearth');
  });
});

describe('pickSpawnCoordinate', () => {
  it('stays within one galaxy of the existing players (never the far side)', () => {
    // Seeded player in galaxy 1 of a 4-galaxy world: the candidate band is
    // {1, 2}; galaxies 3 and 4 are unreachable on purpose.
    const world = makeWorld({ galaxies: 4, seedPlayerGalaxy: 1 });
    const coordinate = pickSpawnCoordinate(world);
    expect(coordinate.galaxy).toBeLessThanOrEqual(2);
  });

  it('picks the least-populated area first', () => {
    const world = makeWorld({ galaxies: 4, seedPlayerGalaxy: 1 });
    // Galaxy 1 holds the seeded planet, so galaxy 2 (empty) wins the band.
    const coordinate = pickSpawnCoordinate(world);
    expect(coordinate.galaxy).toBe(2);
  });

  it('always lands on an unowned planet', () => {
    const world = makeWorld({ galaxies: 2, seedPlayerGalaxy: 1 });
    const claimed = new Set<string>([world.planets[0].id]);
    for (let i = 1; i <= 5; i++) {
      const result = spawnOne(world, i);
      world.planets = result.world.planets;
      world.players = result.world.players;
      expect(claimed.has(result.homePlanet.id)).toBe(false);
      claimed.add(result.homePlanet.id);
    }
    expect(claimed.size).toBe(6);
  });

  it('is deterministic for the same world state', () => {
    const world = makeWorld({ galaxies: 3, seedPlayerGalaxy: 2 });
    expect(pickSpawnCoordinate(world)).toEqual(pickSpawnCoordinate(world));
  });

  it('spawns fill the frontier outward one galaxy at a time', () => {
    const world = makeWorld({ galaxies: 4, seedPlayerGalaxy: 1 });
    const galaxyOrder: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const result = spawnOne(world, i);
      galaxyOrder.push(result.homePlanet.coordinate.galaxy);
      world.planets = result.world.planets;
      world.players = result.world.players;
    }
    // Seeded at galaxy 1. Each new commander lands in the least-populated
    // galaxy within one hop of the frontier, so the populated band widens one
    // galaxy at a time: 2, then 3, then 4 — never skipping ahead.
    expect(galaxyOrder).toEqual([2, 3, 4]);
    expect(world.planets.filter((p) => p.ownerId === null).length).toBe(
      4 * 3 - 4 /* seeded + 3 spawns */,
    );
  });

  it('a spawned commander receives the starting economy', () => {
    const world = makeWorld({ galaxies: 2, seedPlayerGalaxy: 1 });
    const { homePlanet } = spawnOne(world, 1);
    expect(homePlanet.ownerId).toBe('player:acc-1');
    expect(homePlanet.factionId).toBe('iron');
    expect(homePlanet.buildings.settlement).toBe(1);
    expect(homePlanet.population).toBeGreaterThan(0);
  });
});
