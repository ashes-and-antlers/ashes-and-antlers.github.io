import type {
  BuildingKind,
  Coordinate,
  Player,
  Planet,
  WorldId,
  WorldState,
} from '@ashes/contracts';
import { emptyResourceStore, planetIdFromCoordinate } from '@ashes/contracts';
import {
  CONTENT_VERSION,
  PLANET_NAME_PARTS,
  STARTING_PACKAGE,
  WORLD_CONFIG,
  WORLD_VERSION,
} from '@ashes/content';
import { createPrng, intBelow, intInRange, hashHex } from './prng';
import { compareCoordinates } from '@ashes/contracts';

export type WorldgenInput = {
  seed: number;
  /** Optional overrides for tests and dev runs; defaults to live content. */
  config?: {
    galaxies?: number;
    sectorsPerGalaxy?: number;
    systemsPerSector?: number;
    planetsPerSystem?: number;
  };
  tickDurationMs?: number;
  createdAt?: number;
  playerToken?: string;
};

/**
 * Generate the complete finite world from a seed, deterministically.
 *
 * Iteration order is strict row-major (galaxy → sector → system → planet) and
 * every random draw comes from a named PRNG stream derived from the seed, so
 * the same seed always produces the same world, and the same
 * seed + content + commands produces the same planet-state hash.
 */
export function generateWorld(input: WorldgenInput): WorldState {
  const seed = input.seed;
  const galaxies = input.config?.galaxies ?? WORLD_CONFIG.galaxies;
  const sectorsPerGalaxy = input.config?.sectorsPerGalaxy ?? WORLD_CONFIG.sectorsPerGalaxy;
  const systemsPerSector = input.config?.systemsPerSector ?? WORLD_CONFIG.systemsPerSector;
  const planetsPerSystem = input.config?.planetsPerSystem ?? WORLD_CONFIG.planetsPerSystem;
  const tickDurationMs = input.tickDurationMs ?? WORLD_CONFIG.tickDurationMs;
  const createdAt = input.createdAt ?? 0;

  const rngPlanetName = createPrng(seed, 'worldgen:planet-name');
  const rngAbundance = createPrng(seed, 'worldgen:abundance');
  const rngHome = createPrng(seed, 'worldgen:home');

  const planets: Planet[] = [];
  for (let galaxy = 1; galaxy <= galaxies; galaxy++) {
    for (let sector = 1; sector <= sectorsPerGalaxy; sector++) {
      for (let system = 1; system <= systemsPerSector; system++) {
        for (let planetIndex = 1; planetIndex <= planetsPerSystem; planetIndex++) {
          const coordinate: Coordinate = { galaxy, sector, system, planet: planetIndex };
          planets.push({
            id: planetIdFromCoordinate(coordinate),
            coordinate,
            ownerId: null,
            factionId: null,
            name: randomPlanetName(rngPlanetName),
            abundance: {
              metal: intInRange(rngAbundance, 20, 100),
              mineral: intInRange(rngAbundance, 20, 100),
              food: intInRange(rngAbundance, 20, 100),
              energy: intInRange(rngAbundance, 20, 100),
            },
            population: 0,
            resources: emptyResourceStore(),
            buildings: {},
            lastResolvedTick: 0,
            version: 1,
          });
        }
      }
    }
  }
  planets.sort((a, b) => compareCoordinates(a.coordinate, b.coordinate));

  // Seeded home planet: a deterministic pick from the stable planet list.
  // M1 genesis: the home planet carries the starting economy (settlement,
  // population, resource seed) so the first tick is already productive.
  const homePlanet = planets[intBelow(rngHome, planets.length)];
  homePlanet.ownerId = playerId(seed);
  homePlanet.factionId = STARTING_PACKAGE.factionId;
  homePlanet.population = STARTING_PACKAGE.startingPopulation;
  homePlanet.resources = { ...STARTING_PACKAGE.startingResources };
  homePlanet.buildings = { ...STARTING_PACKAGE.startingBuildings };

  const player: Player = {
    id: playerId(seed),
    name: STARTING_PACKAGE.playerName,
    factionId: STARTING_PACKAGE.factionId,
    homePlanetId: homePlanet.id,
    token: input.playerToken ?? `player-${seed}-token`,
    version: 1,
  };

  const worldId = worldIdFromSeed(seed);
  const world: WorldState = {
    id: worldId,
    seed,
    tick: 0,
    nextTickAt: createdAt + tickDurationMs,
    createdAt,
    lastResolvedAt: null,
    worldVersion: WORLD_VERSION,
    contentVersion: CONTENT_VERSION,
    tickDurationMs,
    planets,
    players: [player],
    worldHash: computeWorldHash(seed, planets, [player], tickDurationMs),
    version: 1,
  };
  return world;
}

function playerId(seed: number) {
  return `player:${seed}` as Player['id'];
}

export function worldIdFromSeed(seed: number): WorldId {
  return `world:${seed}` as WorldId;
}

function randomPlanetName(rng: () => number): string {
  const { prefixes, suffixes } = PLANET_NAME_PARTS;
  const prefix = prefixes[intBelow(rng, prefixes.length)];
  const suffix = suffixes[intBelow(rng, suffixes.length)];
  return `${prefix} ${suffix}`;
}

/**
 * Deterministic content hash over the seed, world version, and every planet
 * and player in stable order. Same seed → same hash (an M0 acceptance test).
 */
export function computeWorldHash(
  seed: number,
  planets: Planet[],
  players: Player[],
  tickDurationMs?: number,
): string {
  const sortedPlanets = [...planets].sort((a, b) => compareCoordinates(a.coordinate, b.coordinate));
  const canonical = [
    `worldgen:${WORLD_VERSION}`,
    `content:${CONTENT_VERSION}`,
    `seed:${seed}`,
    `tick:${tickDurationMs ?? WORLD_CONFIG.tickDurationMs}`,
    ...sortedPlanets.map(canonicalPlanet),
    ...players.map(canonicalPlayer),
  ].join('|');
  return hashHex(canonical);
}

/**
 * Deterministic planet-state hash: the hash of every planet's full state in
 * stable order. Same seed + same resolutions → same hash; any divergence in
 * authoritative state surfaces as a hash difference.
 */
export function computePlanetStateHash(planets: Planet[]): string {
  const sorted = [...planets].sort((a, b) => compareCoordinates(a.coordinate, b.coordinate));
  return hashHex(sorted.map(canonicalPlanet).join('|'));
}

function canonicalPlanet(p: Planet): string {
  const c = p.coordinate;
  const buildingCanon = (Object.keys(p.buildings) as BuildingKind[])
    .sort()
    .map((k) => `${k}@${p.buildings[k]}`)
    .join(',');
  return [
    c.galaxy,
    c.sector,
    c.system,
    c.planet,
    p.name,
    p.ownerId ?? '-',
    p.factionId ?? '-',
    p.abundance.metal,
    p.abundance.mineral,
    p.abundance.food,
    p.abundance.energy,
    p.population,
    p.resources.metal,
    p.resources.mineral,
    p.resources.food,
    p.resources.energy,
    buildingCanon === '' ? '-' : buildingCanon,
    p.lastResolvedTick,
    p.version,
  ].join(':');
}

function canonicalPlayer(p: Player): string {
  return [p.id, p.name, p.factionId, p.homePlanetId].join(':');
}
