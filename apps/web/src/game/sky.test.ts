import { describe, expect, it } from 'vitest';
import { MAP_SKY } from '@ashes/content';
import { planetId, worldIdFromSeed, type GalaxyView } from '@ashes/contracts';
import { buildSky } from './sky';

/**
 * Minimal but realistic world fixture: two galaxies, eight sectors each,
 * spiraling outward from the core. The sky only reads galaxies, sectors,
 * seed, and discRadius — the rest of the projection is not exercised.
 */
function makeView(seed: number): GalaxyView {
  const galaxies = [1, 2].map((g) => ({
    galaxy: g,
    position: { x: g * 10_000, y: g * 9_000 },
    discRadius: 2_400,
  }));
  const sectors = [1, 2].flatMap((g) =>
    [1, 2, 3, 4, 5, 6, 7, 8].map((s) => {
      const angle = s * 0.95;
      const r = 600 * 1.17 ** (s - 1);
      return {
        galaxy: g,
        sector: s,
        position: {
          x: galaxies[g - 1].position.x + Math.cos(angle) * r,
          y: galaxies[g - 1].position.y + Math.sin(angle) * r,
        },
        bounds: {
          minX: 0,
          minY: 0,
          maxX: 0,
          maxY: 0,
        },
        planetCount: 48,
      };
    }),
  );
  return {
    worldId: worldIdFromSeed(seed),
    seed,
    protocolVersion: 'test',
    config: { galaxies: 2, sectorsPerGalaxy: 8, systemsPerSector: 8, planetsPerSystem: 6 },
    homePlanetId: planetId('planet:1:1:1:1'),
    bounds: { minX: -3_000, minY: -3_000, maxX: 23_000, maxY: 21_000 },
    galaxies,
    sectors,
    systems: [],
    planets: [],
  };
}

describe('map sky generation', () => {
  it('is deterministic: the same seed paints the same sky', () => {
    const a = buildSky(makeView(1337));
    const b = buildSky(makeView(1337));
    expect(a.size).toBe(2);
    for (const [galaxy, skyA] of a) {
      const skyB = b.get(galaxy);
      expect(skyB).toBeDefined();
      expect(skyA.stars).toEqual(skyB!.stars);
      expect(skyA.nebula).toEqual(skyB!.nebula);
      expect(skyA.arms.map((x) => Array.from(x))).toEqual(skyB!.arms.map((x) => Array.from(x)));
    }
  });

  it('varies with the seed: a different seed paints a different sky', () => {
    const a = buildSky(makeView(1337));
    const b = buildSky(makeView(4242));
    let anyDifference = false;
    for (const [galaxy, skyA] of a) {
      const skyB = b.get(galaxy);
      expect(skyB).toBeDefined();
      if (skyA.stars.length !== skyB!.stars.length) {
        anyDifference = true;
        break;
      }
      for (let i = 0; i < skyA.stars.length; i++) {
        if (skyA.stars[i] !== skyB!.stars[i]) {
          anyDifference = true;
          break;
        }
      }
    }
    expect(anyDifference).toBe(true);
  });

  it('keeps every star inside its galaxy disc', () => {
    const sky = buildSky(makeView(1337));
    for (const [, g] of sky) {
      expect(g.stars.length % 6).toBe(0);
      expect(g.stars.length / 6).toBeGreaterThan(0);
      for (let i = 0; i < g.stars.length; i += 6) {
        const d = Math.hypot(g.stars[i] - g.center.x, g.stars[i + 1] - g.center.y);
        expect(d).toBeLessThanOrEqual(g.discRadius * MAP_SKY.starSpillLimit);
      }
      // Arms exist and wind through the galaxy (each has many points).
      expect(g.arms.length).toBeGreaterThan(0);
      for (const arm of g.arms) {
        expect(arm.length).toBeGreaterThan(10);
      }
      expect(g.nebula.length).toBe(MAP_SKY.nebulaCount);
    }
  });
});
