import { describe, expect, it } from 'vitest';
import { generateWorld } from './worldgen';
import { resolveEmptyTick } from './tick';

function makeWorld(seed = 1337, createdAt = 1000) {
  return generateWorld({
    seed,
    config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
    createdAt,
  });
}

describe('resolveEmptyTick', () => {
  it('advances the tick and stamps every planet', () => {
    const world = makeWorld();
    const { world: next, resolution } = resolveEmptyTick({
      world,
      tick: 1,
      resolvedAt: world.nextTickAt,
    });
    expect(next.tick).toBe(1);
    expect(next.lastResolvedAt).toBe(world.nextTickAt);
    expect(next.nextTickAt).toBe(world.nextTickAt + world.tickDurationMs);
    expect(next.planets.every((p) => p.lastResolvedTick === 1)).toBe(true);
    expect(resolution.tick).toBe(1);
    expect(resolution.status).toBe('completed');
    expect(resolution.worldId).toBe(world.id);
  });

  it('is deterministic: same world + tick → same resolution and state', () => {
    const world = makeWorld(1337);
    const a = resolveEmptyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const b = resolveEmptyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    expect(a.resolution.seed).toBe(b.resolution.seed);
    expect(a.resolution.planetStateHash).toBe(b.resolution.planetStateHash);
    expect(a.resolution.phaseHashes).toEqual(b.resolution.phaseHashes);
    expect(a.world.worldHash).toBe(b.world.worldHash);
  });

  it('produces the same planet-state hash for the same seed across runs', () => {
    const a = resolveEmptyTick({ world: makeWorld(1337), tick: 1, resolvedAt: 2000 });
    const b = resolveEmptyTick({ world: makeWorld(1337), tick: 1, resolvedAt: 2000 });
    expect(a.resolution.planetStateHash).toBe(b.resolution.planetStateHash);
  });

  it('changes the planet-state hash as ticks advance', () => {
    const world = makeWorld();
    const t1 = resolveEmptyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const t2 = resolveEmptyTick({ world: t1.world, tick: 2, resolvedAt: t1.world.nextTickAt });
    expect(t2.resolution.planetStateHash).not.toBe(t1.resolution.planetStateHash);
  });

  it('records the previous nextTickAt as the command cutoff', () => {
    const world = makeWorld();
    const { resolution } = resolveEmptyTick({ world, tick: 1, resolvedAt: world.nextTickAt + 5 });
    expect(resolution.commandCutoffAt).toBe(world.nextTickAt);
  });
});
