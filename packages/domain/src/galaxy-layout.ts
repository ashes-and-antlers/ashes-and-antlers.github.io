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
 * System scatter (world-6): a sector's systems start as a uniform disc
 * scatter but are then relaxed so every pair is at least
 * `systemMinSeparation` apart — the disc is large enough for 8 systems at
 * that spacing on every seed, so planetary clusters never overlap and each
 * system reads as its own beacon with its own orbits.
 *
 * Sector layout (world-5): sectors sit on logarithmic spiral arms winding
 * out of the galactic core instead of a grid. Sector `s` belongs to arm
 * `(s - 1) % armsPerGalaxy`; its radius from the core grows exponentially
 * with its index on the arm and its angle advances by `sectorAngleStep` per
 * index ON that arm, so consecutive sectors interleave across the arms and
 * the galaxy reads as a spiral. (Advancing by the global sector index
 * instead wrapped the outer arms onto the inner ones and collapsed the
 * spiral into two overlapping lobes — world-5 fixes that.)
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
  // Each arm starts at its own evenly-spaced base angle and advances by
  // sectorAngleStep per sector ON that arm, so the three arms wind outward
  // in interleave without ever wrapping onto a neighbor's inner sectors.
  const baseAngle = (arm / GALAXY_LAYOUT.armsPerGalaxy) * Math.PI * 2;
  const angle = baseAngle + indexOnArm * GALAXY_LAYOUT.sectorAngleStep;
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

const SYSTEM_RELAX_ITERATIONS = 256;
const SYSTEM_LAYOUT_CACHE_MAX = 4096;
const systemLayoutCache = new Map<string, MapPosition[]>();

/**
 * Relaxed positions for every system of one sector (world-6). Systems start
 * as a seeded uniform scatter across the cluster disc, then a deterministic
 * relaxation pushes pairs closer than `systemMinSeparation` apart (half the
 * deficit along the pair axis each pass) while clamping each system back
 * into the disc. The sector's cluster radius easily holds 8 systems at that
 * separation, so the fixed 256-pass budget converges to exact separation on
 * every seed (verified across thousands of seeds in galaxy-layout.test.ts).
 * The whole sector is computed together because separation is a pairwise
 * constraint; results are memoized per (seed, galaxy, sector) since the view
 * build calls `systemPosition` once per system and once per planet.
 */
function sectorSystemPositions(seed: number, galaxy: number, sector: number): MapPosition[] {
  const key = `${seed}:${galaxy}:${sector}`;
  const cached = systemLayoutCache.get(key);
  if (cached) return cached;

  const center = sectorPosition(seed, galaxy, sector);
  const count = WORLD_CONFIG.systemsPerSector;
  const positions: MapPosition[] = [];
  for (let system = 1; system <= count; system++) {
    const rng = layoutStream(seed, `system:${galaxy}:${sector}:${system}`);
    const angle = rng() * Math.PI * 2;
    // sqrt for a uniform scatter across the disc, not a tight center ball.
    const radius = Math.sqrt(rng()) * GALAXY_LAYOUT.systemClusterRadius;
    positions.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  const minSep = GALAXY_LAYOUT.systemMinSeparation;
  for (let iteration = 0; iteration < SYSTEM_RELAX_ITERATIONS; iteration++) {
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const d = Math.hypot(dx, dy);
        if (d < minSep && d > 1e-9) {
          const push = (minSep - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          positions[i].x -= ux * push;
          positions[i].y -= uy * push;
          positions[j].x += ux * push;
          positions[j].y += uy * push;
        }
      }
    }
    for (const p of positions) {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const r = Math.hypot(dx, dy);
      if (r > GALAXY_LAYOUT.systemClusterRadius) {
        p.x = center.x + (dx / r) * GALAXY_LAYOUT.systemClusterRadius;
        p.y = center.y + (dy / r) * GALAXY_LAYOUT.systemClusterRadius;
      }
    }
  }

  if (systemLayoutCache.size >= SYSTEM_LAYOUT_CACHE_MAX) systemLayoutCache.clear();
  systemLayoutCache.set(key, positions);
  return positions;
}

/** The system's star, relaxed to stay clear of its sector's other systems. */
export function systemPosition(
  seed: number,
  galaxy: number,
  sector: number,
  system: number,
): MapPosition {
  return sectorSystemPositions(seed, galaxy, sector)[system - 1];
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
  // orbit within planetOrbitMax. Pad past both so the cell holds everything,
  // with a small content-driven margin so cells stay distinct.
  const pad =
    GALAXY_LAYOUT.systemClusterRadius +
    GALAXY_LAYOUT.planetOrbitMax +
    GALAXY_LAYOUT.sectorBoundsMargin;
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
