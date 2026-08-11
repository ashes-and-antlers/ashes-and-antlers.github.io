import { clamp01 } from '../../shared/utils';
import { createPrng, type Rng } from '../core/prng';
import { TerrainType, TERRAIN_MOVEMENT_COST } from './tiles';
import { TileWorld, type WorldGenConfig } from './world';

/**
 * Deterministic world generation.
 *
 * All randomness comes from the seeded PRNG's named streams, tiles are
 * iterated in strict row-major order, and no floating-point comparison is
 * used in decisive branching (thresholds are compared against the same
 * computed values, so results are reproducible). See docs/ADR-001.
 */

// Terrain derivation thresholds.
const DEEP_WATER_LEVEL = 0.32;
const WATER_LEVEL = 0.4;
const MARSH_LEVEL = 0.44;
const MARSH_MOISTURE = 0.55;
const MOUNTAIN_LEVEL = 0.78;
const HILL_LEVEL = 0.66;
const FOREST_MOISTURE = 0.6;
const FOREST_MAX_ELEVATION = 0.58;

export function generateWorld(config: WorldGenConfig): TileWorld {
  const rng = createPrng(config.seed);
  const elevationNoise = makeValueNoise(rng.stream('worldgen.elevation'), 10);
  const moistureNoise = makeValueNoise(rng.stream('worldgen.moisture'), 8);

  const { width, height } = config;
  const tileCount = width * height;

  const terrain = new Uint8Array(tileCount);
  const elevation = new Uint8Array(tileCount);
  const moisture = new Uint8Array(tileCount);
  const fertility = new Uint8Array(tileCount);
  const temperatureBand = new Uint8Array(tileCount);
  const movementCost = new Uint8Array(tileCount);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = x + y * width;
      const nx = width === 1 ? 0 : x / (width - 1);
      const ny = height === 1 ? 0 : y / (height - 1);

      const elev = fbm(elevationNoise, nx, ny, 3);
      // Higher ground tends to be drier; keep it subtle.
      const moist = clamp01(fbm(moistureNoise, nx, ny, 3) * 0.8 + (1 - elev) * 0.2);

      let t: TerrainType;
      if (elev < DEEP_WATER_LEVEL) {
        t = TerrainType.DeepWater;
      } else if (elev < WATER_LEVEL) {
        t = TerrainType.Water;
      } else if (elev < MARSH_LEVEL && moist > MARSH_MOISTURE) {
        t = TerrainType.Marsh;
      } else if (elev > MOUNTAIN_LEVEL) {
        t = TerrainType.Mountain;
      } else if (elev > HILL_LEVEL) {
        t = TerrainType.Hill;
      } else if (moist > FOREST_MOISTURE && elev < FOREST_MAX_ELEVATION) {
        t = TerrainType.Forest;
      } else {
        t = TerrainType.Grass;
      }

      const isLand = t >= TerrainType.Marsh;
      const base = t === TerrainType.Grass ? 0.4 : t === TerrainType.Forest ? 0.3 : 0.15;
      const fert = isLand ? clamp01(moist * 0.6 + base) : 0;

      terrain[i] = t;
      elevation[i] = Math.round(elev * 255);
      moisture[i] = Math.round(moist * 255);
      fertility[i] = Math.round(fert * 255);
      temperatureBand[i] = Math.min(3, Math.floor(elev * 4));
      movementCost[i] = TERRAIN_MOVEMENT_COST[t];
    }
  }

  return new TileWorld(config, {
    terrain,
    elevation,
    moisture,
    fertility,
    temperatureBand,
    movementCost,
  });
}

/** Smooth value noise over a (lattice+1)^2 grid of seeded random values. */
function makeValueNoise(rng: Rng, lattice: number): (nx: number, ny: number) => number {
  const stride = lattice + 1;
  const grid = new Float64Array(stride * stride);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = rng();
  }
  return (nx, ny) => {
    const gx = Math.min(nx * lattice, lattice - 1e-9);
    const gy = Math.min(ny * lattice, lattice - 1e-9);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = grid[y0 * stride + x0] ?? 0;
    const v10 = grid[y0 * stride + x0 + 1] ?? 0;
    const v01 = grid[(y0 + 1) * stride + x0] ?? 0;
    const v11 = grid[(y0 + 1) * stride + x0 + 1] ?? 0;
    return lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
  };
}

function fbm(
  noise: (nx: number, ny: number) => number,
  nx: number,
  ny: number,
  octaves: number,
): number {
  let value = 0;
  let amplitude = 0.55;
  let frequency = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    value += amplitude * noise(nx * frequency, ny * frequency);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
