import { describe, expect, it } from 'vitest';
import { GALAXY_LAYOUT, WORLD_CONFIG } from '@ashes/content';
import type { GalaxyBounds, MapPosition } from '@ashes/contracts';
import {
  galaxyBounds,
  galaxyDiscRadius,
  galaxyOrigin,
  planetPosition,
  sectorBounds,
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

  it('lays sectors out along spiral arms, not a grid', () => {
    const seed = 1337;
    const origin = galaxyOrigin(seed, 1);
    const dist = (a: MapPosition, b: MapPosition) => Math.hypot(a.x - b.x, a.y - b.y);
    const radii: number[] = [];
    const angles: number[] = [];
    for (let s = 1; s <= WORLD_CONFIG.sectorsPerGalaxy; s++) {
      const p = sectorPosition(seed, 1, s);
      radii.push(dist(p, origin));
      angles.push(Math.atan2(p.y - origin.y, p.x - origin.x));
    }
    // Later sectors sit farther from the core (the spiral winds outward).
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
    // The arm sweep is neither a grid (no two angles match) nor degenerate.
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBeGreaterThan(2);
    // The innermost sector sits near the core, the outermost near the rim.
    expect(radii[0]).toBeLessThan(GALAXY_LAYOUT.galaxyCoreRadius * 2);
  });

  it('keeps every sector cell disjoint from its neighbors (world-5 spiral)', () => {
    // world-4 wrapped the outer arms onto the inner ones, so cells overlapped
    // by up to half their width and the map was unreadable. Every sector's
    // padded bounds must be axis-aligned disjoint from every other sector of
    // the same galaxy, on any seed.
    const overlaps = (a: GalaxyBounds, b: GalaxyBounds): boolean =>
      a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
    for (const seed of [1337, 42, 7, 2026, 999]) {
      for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
        const cells: GalaxyBounds[] = [];
        for (let s = 1; s <= WORLD_CONFIG.sectorsPerGalaxy; s++) {
          cells.push(sectorBounds(seed, galaxy, s));
        }
        for (let a = 0; a < cells.length; a++) {
          for (let b = a + 1; b < cells.length; b++) {
            expect(overlaps(cells[a], cells[b])).toBe(false);
          }
        }
      }
    }
  });

  it('keeps every system cluster disjoint from its neighbors (world-6)', () => {
    // world-5 scattered systems freely inside the cluster disc, so orbit
    // rings and planetary clusters overlapped exactly like the sector cells
    // used to. Every pair of systems in a sector must sit at least
    // systemMinSeparation apart (float tolerance), on any seed.
    const minSep = GALAXY_LAYOUT.systemMinSeparation;
    for (const seed of [1337, 42, 7, 2026, 999]) {
      for (let galaxy = 1; galaxy <= WORLD_CONFIG.galaxies; galaxy++) {
        for (let sector = 1; sector <= WORLD_CONFIG.sectorsPerGalaxy; sector++) {
          const stars: MapPosition[] = [];
          for (let sy = 1; sy <= WORLD_CONFIG.systemsPerSector; sy++) {
            stars.push(systemPosition(seed, galaxy, sector, sy));
          }
          for (let a = 0; a < stars.length; a++) {
            for (let b = a + 1; b < stars.length; b++) {
              const d = Math.hypot(stars[a].x - stars[b].x, stars[a].y - stars[b].y);
              expect(d).toBeGreaterThanOrEqual(minSep - 1e-3);
            }
          }
        }
      }
    }
  });

  it('sector bounds contain every system and planet of the sector', () => {
    const seed = 1337;
    const bounds = sectorBounds(seed, 1, 1);
    for (let sy = 1; sy <= WORLD_CONFIG.systemsPerSector; sy++) {
      const star = systemPosition(seed, 1, 1, sy);
      expect(star.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(star.x).toBeLessThanOrEqual(bounds.maxX);
      expect(star.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(star.y).toBeLessThanOrEqual(bounds.maxY);
      for (let p = 1; p <= WORLD_CONFIG.planetsPerSystem; p++) {
        const pos = planetPosition(seed, { galaxy: 1, sector: 1, system: sy, planet: p });
        expect(pos.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(pos.x).toBeLessThanOrEqual(bounds.maxX);
        expect(pos.y).toBeGreaterThanOrEqual(bounds.minY);
        expect(pos.y).toBeLessThanOrEqual(bounds.maxY);
      }
    }
  });

  it('galaxy disc radius holds every sector of the galaxy', () => {
    const seed = 1337;
    const origin = galaxyOrigin(seed, 1);
    const radius = galaxyDiscRadius(seed, 1);
    for (let s = 1; s <= WORLD_CONFIG.sectorsPerGalaxy; s++) {
      const b = sectorBounds(seed, 1, s);
      for (const corner of [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.maxY },
      ]) {
        expect(Math.hypot(corner.x - origin.x, corner.y - origin.y)).toBeLessThanOrEqual(radius);
      }
    }
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
