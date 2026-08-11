import { GALAXY_LAYOUT, WORLD_CONFIG } from '@ashes/content';
import type { Coordinate, GalaxyBounds, MapPosition } from '@ashes/contracts';
import { createPrng, fnv1a } from './prng';

/**
 * Deterministic galaxy map geometry (DEVELOPMENT_PLAN.md §3/§5). Every
 * position is a pure function of (seed, coordinate): no state, no iteration
 * order, no stored tables. The same seed always yields the same map, and any
 * future fleet travel distance can be computed from these positions alone.
 *
 * Each level draws from its own per-coordinate PRNG stream, so a change to
 * one level's scatter never perturbs another's. Distances are tuned so the
 * drive tiers read naturally (see GALAXY_LAYOUT in packages/content).
 */

function layoutStream(seed: number, key: string): () => number {
  return createPrng(fnv1a(`${seed}:layout:${key}`), 'layout:geometry');
}

/** Top-left corner of galaxy `g` on the galaxy grid, with light jitter. */
export function galaxyOrigin(seed: number, galaxy: number): MapPosition {
  const g = galaxy - 1;
  const col = g % GALAXY_LAYOUT.galaxyGridCols;
  const row = Math.floor(g / GALAXY_LAYOUT.galaxyGridCols);
  const rng = layoutStream(seed, `galaxy:${galaxy}`);
  const jitter = (r: () => number) => (r() - 0.5) * 2 * GALAXY_LAYOUT.galaxyJitter;
  return {
    x: col * GALAXY_LAYOUT.galaxySpacing + jitter(rng),
    y: row * GALAXY_LAYOUT.galaxyRowSpacing + jitter(rng),
  };
}

/** Jittered center of a sector's cell within its galaxy. */
export function sectorPosition(seed: number, galaxy: number, sector: number): MapPosition {
  const origin = galaxyOrigin(seed, galaxy);
  const index = sector - 1;
  const col = index % WORLD_CONFIG.sectorsPerGalaxy;
  const row = Math.floor(index / WORLD_CONFIG.sectorsPerGalaxy);
  const rng = layoutStream(seed, `sector:${galaxy}:${sector}`);
  const jitter = (r: () => number) => (r() - 0.5) * 2 * GALAXY_LAYOUT.sectorJitter;
  return {
    x: origin.x + col * GALAXY_LAYOUT.sectorCell + GALAXY_LAYOUT.sectorCell / 2 + jitter(rng),
    y: origin.y + row * GALAXY_LAYOUT.sectorCell + GALAXY_LAYOUT.sectorCell / 2 + jitter(rng),
  };
}

/** The system's star, scattered within its sector's cluster radius. */
export function systemPosition(
  seed: number,
  galaxy: number,
  sector: number,
  system: number,
): MapPosition {
  const center = sectorPosition(seed, galaxy, sector);
  const rng = layoutStream(seed, `system:${galaxy}:${sector}:${system}`);
  const angle = rng() * Math.PI * 2;
  // sqrt for a uniform scatter across the disc, not a tight center ball.
  const radius = Math.sqrt(rng()) * GALAXY_LAYOUT.systemClusterRadius;
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  };
}

/** A planet on its system's orbit: seeded angle + radius, fanned by index. */
export function planetPosition(seed: number, coordinate: Coordinate): MapPosition {
  const star = systemPosition(seed, coordinate.galaxy, coordinate.sector, coordinate.system);
  const rng = layoutStream(
    seed,
    `planet:${coordinate.galaxy}:${coordinate.sector}:${coordinate.system}:${coordinate.planet}`,
  );
  // The index term spreads planets around the ring so two planets of the
  // same system never sit on top of each other.
  const angle = (rng() + coordinate.planet / (WORLD_CONFIG.planetsPerSystem + 1)) * Math.PI * 2;
  const radius =
    GALAXY_LAYOUT.planetOrbitMin +
    rng() * (GALAXY_LAYOUT.planetOrbitMax - GALAXY_LAYOUT.planetOrbitMin);
  return {
    x: star.x + Math.cos(angle) * radius,
    y: star.y + Math.sin(angle) * radius,
  };
}

/** Axis-aligned bounds over every planet + galaxy position, padded slightly. */
export function galaxyBounds(seed: number): GalaxyBounds {
  const pad = 400;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = ({ x, y }: MapPosition) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
    include(galaxyOrigin(seed, galaxy));
    for (let sector = 1; sector <= WORLD_CONFIG.sectorsPerGalaxy; sector++) {
      for (let system = 1; system <= WORLD_CONFIG.systemsPerSector; system++) {
        for (let planet = 1; planet <= WORLD_CONFIG.planetsPerSystem; planet++) {
          include(planetPosition(seed, { galaxy, sector, system, planet }));
        }
      }
    }
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
