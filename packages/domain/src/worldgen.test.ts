import { describe, expect, it } from 'vitest';
import { computePlanetStateHash, computeWorldHash, generateWorld } from './worldgen';

describe('generateWorld', () => {
  const make = (seed: number, createdAt = 0) =>
    generateWorld({
      seed,
      config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
      createdAt,
    });

  it('produces every planet of the finite coordinate space', () => {
    const world = make(1337);
    expect(world.planets).toHaveLength(1 * 2 * 2 * 3);
    expect(world.players).toHaveLength(1);
    const homePlanetId = world.players[0].homePlanetId;
    for (const p of world.planets) {
      expect(p.id).toBe(
        `planet:${p.coordinate.galaxy}:${p.coordinate.sector}:${p.coordinate.system}:${p.coordinate.planet}`,
      );
      // Only the seeded player's home planet is owned at genesis.
      expect(p.ownerId).toBe(p.id === homePlanetId ? world.players[0].id : null);
      expect(p.abundance.metal).toBeGreaterThanOrEqual(0);
      expect(p.abundance.metal).toBeLessThanOrEqual(100);
    }
  });

  it('gives the seeded player exactly one owned home planet', () => {
    const world = make(1337);
    const player = world.players[0];
    expect(player).toBeDefined();
    const owned = world.planets.filter((p) => p.ownerId === player!.id);
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe(player!.homePlanetId);
    expect(owned[0].factionId).toBe(player!.factionId);
  });

  it('is deterministic: same seed → same world hash and same planet state hash', () => {
    const a = make(1337);
    const b = make(1337);
    expect(a.worldHash).toBe(b.worldHash);
    expect(computePlanetStateHash(a.planets)).toBe(computePlanetStateHash(b.planets));
    expect(a.planets.map((p) => p.name)).toEqual(b.planets.map((p) => p.name));
  });

  it('differs across seeds', () => {
    const a = make(1337);
    const b = make(42);
    expect(a.worldHash).not.toBe(b.worldHash);
  });

  it('ignores wall-clock createdAt but includes content config in the world hash', () => {
    const a = make(1337, 0);
    const b = make(1337, 1_000_000);
    expect(a.worldHash).toBe(b.worldHash);
    const c = generateWorld({
      seed: 1337,
      config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
      tickDurationMs: 42,
    });
    expect(c.worldHash).not.toBe(a.worldHash);
  });

  it('iterates planets in stable coordinate order', () => {
    const world = make(1337);
    const coords = world.planets.map(
      (p) =>
        `${p.coordinate.galaxy}:${p.coordinate.sector}:${p.coordinate.system}:${p.coordinate.planet}`,
    );
    const sorted = [...coords].sort((x, y) => {
      const [xg, xs, xsy, xp] = x.split(':').map(Number);
      const [yg, ys, ysy, yp] = y.split(':').map(Number);
      return xg - yg || xs - ys || xsy - ysy || xp - yp;
    });
    expect(coords).toEqual(sorted);
  });
});

describe('computeWorldHash', () => {
  it('changes when ownership changes', () => {
    const world = generateWorld({
      seed: 7,
      config: { galaxies: 1, sectorsPerGalaxy: 1, systemsPerSector: 1, planetsPerSystem: 2 },
    });
    const before = world.worldHash;
    world.planets[1].ownerId = 'player:99' as never;
    const after = computeWorldHash(world.seed, world.planets, world.players, world.tickDurationMs);
    expect(after).not.toBe(before);
  });
});
