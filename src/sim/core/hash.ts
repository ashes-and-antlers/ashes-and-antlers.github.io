import { fnv1aBytes } from '../../shared/utils';
import type { TileWorld } from '../world/world';

/**
 * Deterministic content hash for a world. Same seed + same generator version
 * must always produce the same hash — this is a Milestone 0 acceptance test.
 */
export function computeTerrainHash(world: TileWorld): number {
  const header = new TextEncoder().encode(
    `sim/worldgen/v${world.version}:${world.seed}:${world.width}x${world.height}`,
  );
  const data = new Uint8Array(world.tileCount * 6);
  let o = 0;
  for (let i = 0; i < world.tileCount; i++) {
    data[o++] = world.terrain[i] ?? 0;
    data[o++] = world.elevation[i] ?? 0;
    data[o++] = world.moisture[i] ?? 0;
    data[o++] = world.fertility[i] ?? 0;
    data[o++] = world.temperatureBand[i] ?? 0;
    data[o++] = world.movementCost[i] ?? 0;
  }
  return (fnv1aBytes(header) ^ fnv1aBytes(data)) >>> 0;
}
