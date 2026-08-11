import { describe, expect, it } from 'vitest';
import { worldIdFromSeed } from '@ashes/contracts';
import { TickEngine } from './engine';
import { InMemoryWorldRepository } from './repository';
import { WorldLock } from './lock';
import { TickScheduler } from './scheduler';

function makeEngine() {
  const repository = new InMemoryWorldRepository();
  const lock = new WorldLock();
  const engine = new TickEngine({ repository, lock });
  return { repository, lock, engine };
}

describe('TickEngine', () => {
  it('creates a world idempotently per seed', async () => {
    const { engine } = makeEngine();
    const a = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const b = await engine.createWorld({ seed: 1337, createdAt: 999_999 });
    expect(a).toBe(b);
    expect(a.worldHash).toBe(b.worldHash);
  });

  it('resolves the next tick and records an immutable resolution', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const resolution = await engine.resolveNextTick(world.id, 1000);
    expect(resolution.tick).toBe(1);
    expect(await repository.getResolution(world.id, 1)).toBe(resolution);
    const updated = await engine.getWorld(world.id);
    expect(updated).toBeDefined();
    expect(updated!.tick).toBe(1);
    expect(updated!.lastResolvedAt).toBe(1000);
    expect(updated!.nextTickAt).toBe(1000 + updated!.tickDurationMs);
  });

  it('produces resources on the home planet as ticks resolve', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await engine.resolveNextTick(world.id, 1000);
    const view = await engine.getWorldView(world.id);
    const home = view.player.homePlanet;
    // Starting package: settlement L1 + starter resources; the first tick
    // produces nothing (no production buildings yet) but pays settlement upkeep.
    expect(home.buildings.settlement).toBe(1);
    expect(home.resources.food).toBeGreaterThanOrEqual(0);
    expect(home.population).toBeGreaterThanOrEqual(500);
    expect(home.rates.net).toBeDefined();
  });

  it('rejects an out-of-order tick', async () => {
    const { engine } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    await expect(engine.resolveTick(world.id, 5, 1000)).rejects.toThrow(/out of order/);
  });

  it('a duplicate tick job cannot run two resolvers for the same world/tick', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });

    // Two concurrent resolvers racing for the same next tick.
    const [r1, r2] = await Promise.all([
      engine.resolveNextTick(world.id, 1000),
      engine.resolveNextTick(world.id, 1000),
    ]);

    // Exactly one resolution was produced and both callers got it.
    expect(r1).toBe(r2);
    expect(await repository.getResolution(world.id, 1)).toBe(r1);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
  });

  it('replays an already-resolved tick without re-executing', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const first = await engine.resolveNextTick(world.id, 1000);
    // Re-resolve the same tick (e.g. a worker restart re-running tick 1).
    const replay = await engine.resolveTick(world.id, 1, 2000);
    expect(replay).toBe(first);
    // resolvedAt from the original run is preserved — no double execution.
    expect(replay.resolvedAt).toBe(1000);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
    expect(await repository.getResolution(world.id, 1)).toBe(first);
  });

  it('the world lock serializes holders', async () => {
    const { lock } = makeEngine();
    const worldId = worldIdFromSeed(1337);
    const release = await lock.acquire(worldId);
    let secondGotKey = false;
    const second = lock.acquire(worldId).then((rel) => {
      secondGotKey = true;
      return rel;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondGotKey).toBe(false);
    release();
    const releaseSecond = await second;
    expect(secondGotKey).toBe(true);
    releaseSecond();
  });
});

describe('TickScheduler', () => {
  it('resolves worlds that are due and skips those that are not', async () => {
    const { engine, repository } = makeEngine();
    const world = await engine.createWorld({ seed: 1337, createdAt: 0 });
    const notDue = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => 999,
    });
    expect(await notDue.checkDue()).toHaveLength(0);
    const due = new TickScheduler(engine, repository, {
      intervalMs: 100,
      now: () => world.nextTickAt + 1,
    });
    const resolutions = await due.checkDue();
    expect(resolutions).toHaveLength(1);
    expect((await engine.getWorld(world.id))?.tick).toBe(1);
  });
});
