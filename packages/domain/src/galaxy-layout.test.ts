import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@ashes/content';
import type { MapPosition } from '@ashes/contracts';
import {
  galaxyBounds,
  galaxyOrigin,
  planetPosition,
  sectorPosition,
  systemPosition,
} from './galaxy-layout';

const TOTAL_PLANETS = 8 * 8 * 8 * 6; // live content dimensions

describe('galaxy layout', () => {
  it('is deterministic: same seed → identical positions', () => {
    const coord = { galaxy: 1, sector: 1, system: 1, planet: 1 };
    expect(planetPosition(1337, coord)).toEqual(planetPosition(1337, coord));
    expect(galaxyOrigin(1337, 2)).toEqual(galaxyOrigin(1337, 2));
    expect(systemPosition(1337, 1, 1, 1)).toEqual(systemPosition(1337, 1, 1, 1));
  });

  it('differs across seeds', () => {
    const coord = { galaxy: 1, sector: 1, system: 1, planet: 1 };
    expect(planetPosition(1337, coord)).not.toEqual(planetPosition(42, coord));
  });

  it('keeps every system in its sector distinct', () => {
    const seen = new Set<string>();
    for (let s = 1; s <= WORLD_CONFIG.systemsPerSector; s++) {
      seen.add(JSON.stringify(systemPosition(1337, 1, 1, s)));
    }
    expect(seen.size).toBe(WORLD_CONFIG.systemsPerSector);
  });

  it('orbits planets within the configured radii of their star', () => {
    const star = systemPosition(1337, 1, 1, 1);
    for (let p = 1; p <= WORLD_CONFIG.planetsPerSystem; p++) {
      const pos = planetPosition(1337, { galaxy: 1, sector: 1, system: 1, planet: p });
      const dist = Math.hypot(pos.x - star.x, pos.y - star.y);
      expect(dist).toBeGreaterThanOrEqual(20);
      expect(dist).toBeLessThanOrEqual(60);
    }
  });

  it('drive-tier distances read naturally (mean distances, galaxy 1)', () => {
    const seed = 1337;
    const dist = (a: MapPosition, b: MapPosition) => Math.hypot(a.x - b.x, a.y - b.y);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const sameSystem: number[] = [];
    const crossSystem: number[] = [];
    const crossSector: number[] = [];

    for (let s = 1; s <= WORLD_CONFIG.sectorsPerGalaxy; s++) {
      const stars: MapPosition[] = [];
      for (let sy = 1; sy <= WORLD_CONFIG.systemsPerSector; sy++) {
        const star = systemPosition(seed, 1, s, sy);
        stars.push(star);
        const planets: MapPosition[] = [];
        for (let p = 1; p <= WORLD_CONFIG.planetsPerSystem; p++) {
          planets.push(planetPosition(seed, { galaxy: 1, sector: s, system: sy, planet: p }));
        }
        for (let i = 0; i < planets.length; i++) {
          for (let j = i + 1; j < planets.length; j++) {
            sameSystem.push(dist(planets[i], planets[j]));
          }
        }
      }
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          crossSystem.push(dist(stars[i], stars[j]));
        }
      }
      crossSector.push(dist(sectorPosition(seed, 1, 1), sectorPosition(seed, 1, s)));
    }

    const origins: MapPosition[] = [];
    for (let g = 1; g <= WORLD_CONFIG.galaxies; g++) origins.push(galaxyOrigin(seed, g));
    const crossGalaxy: number[] = [];
    for (let i = 0; i < origins.length; i++) {
      for (let j = i + 1; j < origins.length; j++) {
        crossGalaxy.push(dist(origins[i], origins[j]));
      }
    }

    expect(mean(crossSystem)).toBeGreaterThan(mean(sameSystem) * 1.5);
    expect(mean(crossSector)).toBeGreaterThan(mean(crossSystem));
    expect(mean(crossGalaxy)).toBeGreaterThan(mean(crossSector) * 1.5);
  });

  it('bounds contain every planet of the live world', () => {
    const seed = 1337;
    const bounds = galaxyBounds(seed);
    let count = 0;
    for (let g = 1; g <= WORLD_CONFIG.galaxies; g++) {
      for (let s = 1; s <= WORLD_CONFIG.sectorsPerGalaxy; s++) {
        for (let sy = 1; sy <= WORLD_CONFIG.systemsPerSector; sy++) {
          for (let p = 1; p <= WORLD_CONFIG.planetsPerSystem; p++) {
            count++;
            const pos = planetPosition(seed, { galaxy: g, sector: s, system: sy, planet: p });
            expect(pos.x).toBeGreaterThanOrEqual(bounds.minX);
            expect(pos.x).toBeLessThanOrEqual(bounds.maxX);
            expect(pos.y).toBeGreaterThanOrEqual(bounds.minY);
            expect(pos.y).toBeLessThanOrEqual(bounds.maxY);
          }
        }
      }
    }
    expect(count).toBe(TOTAL_PLANETS);
  });
});
