import { describe, expect, it } from 'vitest';
import { computeTerrainHash } from '../../src/sim/core/hash';
import { generateWorld } from '../../src/sim/world/generation';
import { TerrainType } from '../../src/sim/world/tiles';
import { TileWorld, type WorldGenConfig } from '../../src/sim/world/world';

const config = (seed: number): WorldGenConfig => ({ seed, width: 160, height: 160, version: 1 });

function terrainCounts(world: TileWorld): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of world.terrain) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

describe('generateWorld', () => {
  it('is deterministic: same seed produces the same hash and tiles', () => {
    const a = generateWorld(config(1337));
    const b = generateWorld(config(1337));
    expect(computeTerrainHash(a)).toBe(computeTerrainHash(b));
    expect(a.terrain).toEqual(b.terrain);
  });

  it('produces different hashes for different seeds', () => {
    const a = generateWorld(config(1));
    const b = generateWorld(config(2));
    expect(computeTerrainHash(a)).not.toBe(computeTerrainHash(b));
  });

  it('produces a varied landscape for the default seed', () => {
    const counts = terrainCounts(generateWorld(config(1337)));
    expect(counts.get(TerrainType.DeepWater) ?? 0).toBeGreaterThan(0);
    expect(counts.get(TerrainType.Water) ?? 0).toBeGreaterThan(0);
    expect(counts.get(TerrainType.Grass) ?? 0).toBeGreaterThan(0);
    expect(counts.get(TerrainType.Forest) ?? 0).toBeGreaterThan(0);
  });

  it('keeps every field within uint8 range', () => {
    const world = generateWorld(config(5));
    const arrays = [
      world.terrain,
      world.elevation,
      world.moisture,
      world.fertility,
      world.temperatureBand,
      world.movementCost,
    ];
    for (const arr of arrays) {
      for (const v of arr) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it('rejects component arrays of the wrong length', () => {
    const fields = {
      terrain: new Uint8Array(10),
      elevation: new Uint8Array(5),
      moisture: new Uint8Array(5),
      fertility: new Uint8Array(5),
      temperatureBand: new Uint8Array(5),
      movementCost: new Uint8Array(5),
    };
    expect(() => new TileWorld(config(1), fields)).toThrow();
  });
});
