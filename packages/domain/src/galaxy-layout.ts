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
 *
 * Sector layout (world-4): sectors sit on logarithmic spiral arms winding
 * out of the galactic core instead of a grid. Sector `s` belongs to arm
 * `(s - 1) % armsPerGalaxy`; its radius from the core grows exponentially
 * with its index on the arm and its angle advances by `sectorAngleStep` per
 * index, so consecutive sectors interleave across the arms and the galaxy
 * reads as a spiral.
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

/**
 * Deterministic orientation of galaxy `g`'s spiral: the whole arm pattern is
 * rotated by a per-galaxy seed angle, so no two galaxies look alike.
 */
function spiralRotation(seed: number, galaxy: number): number {
  const rng = layoutStream(seed, `spiral:${galaxy}`);
  return rng() * Math.PI * 2;
}

/**
 * Which spiral arm a sector belongs to, and its sequence index along that
 * arm. Consecutive sectors cycle through the arms (1,2,3,1,2,3…), so each
 * arm carries every `armsPerGalaxy`-th sector and they interleave.
 */
function sectorArm(sector: number): { arm: number; indexOnArm: number } {
  const arm = (sector - 1) % GALAXY_LAYOUT.armsPerGalaxy;
  const indexOnArm = Math.floor((sector - 1) / GALAXY_LAYOUT.armsPerGalaxy);
  return { arm, indexOnArm };
}

/** Center of a sector's cell, placed along its spiral arm within its galaxy. */
export function sectorPosition(seed: number, galaxy: number, sector: number): MapPosition {
  const origin = galaxyOrigin(seed, galaxy);
  const rotation = spiralRotation(seed, galaxy);
  const { arm, indexOnArm } = sectorArm(sector);
  // The full spiral sweeps armTurns revolutions; each sector index advances
  // the angle by sectorAngleStep, so the innermost sectors sit near the core
  // and later ones wind outward.
  const baseAngle = (arm / GALAXY_LAYOUT.armsPerGalaxy) * Math.PI * 2;
  const angle =
    baseAngle + (indexOnArm * GALAXY_LAYOUT.armsPerGalaxy + arm) * GALAXY_LAYOUT.sectorAngleStep;
  const radius = GALAXY_LAYOUT.galaxyCoreRadius * GALAXY_LAYOUT.galaxyRadiusStep ** (sector - 1);

  const rng = layoutStream(seed, `sector:${galaxy}:${sector}`);
  const radialJitter = (rng() - 0.5) * 2 * GALAXY_LAYOUT.sectorRadiusJitter;
  const angleJitter = (rng() - 0.5) * 2 * GALAXY_LAYOUT.sectorAngleJitter;
  const finalAngle = rotation + angle + angleJitter;
  const finalRadius = Math.max(radius + radialJitter, 100);

  return {
    x: origin.x + Math.cos(finalAngle) * finalRadius,
    y: origin.y + Math.sin(finalAngle) * finalRadius,
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

/** Axis-aligned bounds of one sector's cell, padded to hold its planets. */
export function sectorBounds(seed: number, galaxy: number, sector: number): GalaxyBounds {
  // Systems scatter within systemClusterRadius of the sector center; planets
  // orbit within planetOrbitMax. Pad past both so the cell holds everything.
  const pad = GALAXY_LAYOUT.systemClusterRadius + GALAXY_LAYOUT.planetOrbitMax + 60;
  const center = sectorPosition(seed, galaxy, sector);
  return {
    minX: center.x - pad,
    minY: center.y - pad,
    maxX: center.x + pad,
    maxY: center.y + pad,
  };
}

/**
 * Radius of galaxy `g`'s disc: the furthest sector cell corner from the
 * galactic core, so the chart can draw a disc that holds every sector.
 */
export function galaxyDiscRadius(seed: number, galaxy: number): number {
  const origin = galaxyOrigin(seed, galaxy);
  let max = 0;
  for (let sector = 1; sector <= WORLD_CONFIG.sectorsPerGalaxy; sector++) {
    const b = sectorBounds(seed, galaxy, sector);
    for (const corner of [
      { x: b.minX, y: b.minY },
      { x: b.minX, y: b.maxY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
    ]) {
      const d = Math.hypot(corner.x - origin.x, corner.y - origin.y);
      if (d > max) max = d;
    }
  }
  return max;
}

/** Axis-aligned bounds over every galaxy + planet position, padded slightly. */
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
