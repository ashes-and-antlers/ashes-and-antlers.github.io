import type {
  Coordinate,
  FactionId,
  Fleet,
  Planet,
  Player,
  PlayerId,
  WorldState,
} from '@ashes/contracts';
import { compareCoordinates, emptyResourceStore, planetIdFromCoordinate } from '@ashes/contracts';
import { FACTIONS, STARTING_PACKAGE } from '@ashes/content';
import { localFleetId } from './fleet';

export type SpawnInput = {
  playerId: PlayerId;
  name: string;
  factionId: FactionId;
  token: string;
};

/**
 * Choose where a new commander starts. The intent (product): spawn in the
 * least-populated system and the least-populated area, but never on the
 * complete opposite side of the galaxy from the other players.
 *
 * The algorithm is a deterministic lexicographic pick over the population of
 * claimed planets:
 *
 * 1. Galaxy (the "area"): restrict to galaxies within one hop of the existing
 *    players' frontier — the interval between the nearest and farthest player
 *    galaxy, widened by one on each side — so a new player is always near the
 *    populated region, then take the least-populated galaxy in that band.
 * 2. Sector: within that galaxy, the least-populated sector.
 * 3. System: within that sector, the least-populated system.
 * 4. Planet: the first unowned planet of that system in stable coordinate
 *    order.
 *
 * Every tie breaks to the lowest index and the choice is a pure function of
 * world state — no randomness — so spawn placement is deterministic and
 * testable. The first commander (or the seeded dev player's neighborhood)
 * anchors the frontier; later commanders spread outward one galaxy at a time.
 */
export function pickSpawnCoordinate(world: WorldState): Coordinate {
  const { galaxyCount, sectorCount, systemCount } = countPopulation(world);

  const maxGalaxy = world.planets.reduce((m, p) => Math.max(m, p.coordinate.galaxy), 1);
  const maxSector = world.planets.reduce((m, p) => Math.max(m, p.coordinate.sector), 1);
  const maxSystem = world.planets.reduce((m, p) => Math.max(m, p.coordinate.system), 1);

  const playerGalaxies = new Set<number>();
  for (const player of world.players) {
    const home = world.planets.find((p) => p.id === player.homePlanetId);
    if (home) playerGalaxies.add(home.coordinate.galaxy);
  }

  // The frontier band: galaxies already reachable from the player interval.
  // With no players yet every galaxy is a candidate.
  const candidates: number[] = [];
  if (playerGalaxies.size === 0) {
    for (let g = 1; g <= maxGalaxy; g++) candidates.push(g);
  } else {
    const lo = Math.min(...playerGalaxies);
    const hi = Math.max(...playerGalaxies);
    for (let g = 1; g <= maxGalaxy; g++) {
      const distance = g < lo ? lo - g : g > hi ? g - hi : 0;
      if (distance <= 1) candidates.push(g);
    }
  }
  const galaxy = leastPopulated(candidates, (g) => galaxyCount.get(g) ?? 0);

  const sectors: number[] = [];
  for (let s = 1; s <= maxSector; s++) sectors.push(s);
  const sector = leastPopulated(sectors, (s) => sectorCount.get(`${galaxy}:${s}`) ?? 0);

  const systems: number[] = [];
  for (let sy = 1; sy <= maxSystem; sy++) systems.push(sy);
  const system = leastPopulated(systems, (sy) => systemCount.get(`${galaxy}:${sector}:${sy}`) ?? 0);

  const planet = world.planets
    .filter(
      (p) =>
        p.coordinate.galaxy === galaxy &&
        p.coordinate.sector === sector &&
        p.coordinate.system === system &&
        p.ownerId === null,
    )
    .sort((a, b) => compareCoordinates(a.coordinate, b.coordinate))[0];
  if (!planet) {
    // Unreachable in a consistent world (the system exists and every planet
    // is either unowned or owned); guards against a corrupted aggregate.
    throw new Error(`no unowned planet in galaxy ${galaxy} sector ${sector} system ${system}`);
  }
  return planet.coordinate;
}

function countPopulation(world: WorldState): {
  galaxyCount: Map<number, number>;
  sectorCount: Map<string, number>;
  systemCount: Map<string, number>;
} {
  const galaxyCount = new Map<number, number>();
  const sectorCount = new Map<string, number>();
  const systemCount = new Map<string, number>();
  for (const p of world.planets) {
    if (p.ownerId === null) continue;
    const { galaxy, sector, system } = p.coordinate;
    galaxyCount.set(galaxy, (galaxyCount.get(galaxy) ?? 0) + 1);
    sectorCount.set(`${galaxy}:${sector}`, (sectorCount.get(`${galaxy}:${sector}`) ?? 0) + 1);
    systemCount.set(
      `${galaxy}:${sector}:${system}`,
      (systemCount.get(`${galaxy}:${sector}:${system}`) ?? 0) + 1,
    );
  }
  return { galaxyCount, sectorCount, systemCount };
}

/**
 * The smallest element by population. Ties break to the lowest index: items
 * arrive in ascending order and Array.sort is stable, so an equal-population
 * comparison leaves the original (lowest) index first.
 */
function leastPopulated<T>(items: T[], population: (item: T) => number): T {
  return [...items].sort((a, b) => population(a) - population(b))[0];
}

/**
 * The power a new commander is assigned: the faction with the fewest
 * players in the world, ties broken to content order (hearth before iron).
 * This keeps the two powers balanced by construction — every registration
 * strengthens the smaller side, so no matter how many players join, the
 * galaxy never tips to one faction. Pure function of world state.
 */
export function leastPopulatedFaction(world: WorldState): FactionId {
  const counts = new Map<FactionId, number>();
  for (const player of world.players) {
    if (player.factionId === undefined) continue;
    counts.set(player.factionId, (counts.get(player.factionId) ?? 0) + 1);
  }
  return FACTIONS.reduce((best, faction) => {
    const a = counts.get(faction.id) ?? 0;
    const b = counts.get(best) ?? 0;
    return a < b ? faction.id : best;
  }, FACTIONS[0].id);
}

/**
 * Claim a planet for a brand-new commander and append them to the world.
 * Pure and deterministic given the world state: the spawn coordinate is
 * derived (never stored), so re-spawning the same player into the same world
 * yields the same home planet. The planet receives the starting economy
 * (settlement, population, resource seed), exactly like genesis.
 */
export function spawnPlayerIntoWorld(
  world: WorldState,
  input: SpawnInput,
): { world: WorldState; player: Player; homePlanet: Planet } {
  const coordinate = pickSpawnCoordinate(world);
  const homePlanetId = planetIdFromCoordinate(coordinate);
  const planets = world.planets.map((p) => {
    if (compareCoordinates(p.coordinate, coordinate) !== 0) return p;
    return {
      ...p,
      ownerId: input.playerId,
      factionId: input.factionId,
      population: STARTING_PACKAGE.startingPopulation,
      resources: { ...STARTING_PACKAGE.startingResources },
      buildings: { ...STARTING_PACKAGE.startingBuildings },
      version: p.version + 1,
    };
  });

  const player: Player = {
    id: input.playerId,
    name: input.name,
    factionId: input.factionId,
    homePlanetId,
    token: input.token,
    researchOrders: [],
    technologies: [],
    scanReports: [],
    version: 1,
  };

  // M2: the new colony is born with its own local fleet (shipyard dock).
  const localFleet: Fleet = {
    id: localFleetId(homePlanetId),
    ownerId: input.playerId,
    homePlanetId,
    location: coordinate,
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

  const homePlanet = planets.find((p) => p.id === homePlanetId);
  if (!homePlanet) throw new Error(`spawned planet ${homePlanetId} missing from world`);
  homePlanet.localFleets = [localFleet.id];

  return {
    world: {
      ...world,
      planets,
      players: [...world.players, player],
      fleets: [...world.fleets, localFleet],
      version: world.version + 1,
    },
    player,
    homePlanet,
  };
}
