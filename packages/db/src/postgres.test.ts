import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_VERSION } from '@ashes/content';
import { worldIdFromSeed } from '@ashes/contracts';
import { generateWorld } from '@ashes/domain';
import { PostgresWorldRepository, runMigrations, TickEngine, WorldLock } from '.';
import type { WorldRepository } from './repository';

/**
 * PostgreSQL integration tests. They run only when a database URL is
 * configured (TEST_DATABASE_URL, or DATABASE_URL as a fallback) — CI sets it
 * via the postgres service; locally run `docker compose up -d` and export
 * TEST_DATABASE_URL=postgres://ashes:ashes@localhost:5432/ashes.
 *
 * Tests use distinct world seeds and clean up after themselves, so they are
 * safe to run against a database that also hosts the dev world.
 */
const connectionString =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://ashes:ashes@localhost:5432/ashes';

const configured = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

const createdSeeds: number[] = [];

async function makeEngine(seed: number): Promise<{
  repository: PostgresWorldRepository;
  engine: TickEngine;
}> {
  const repository = new PostgresWorldRepository({ connectionString });
  const engine = new TickEngine({ repository, lock: new WorldLock() });
  createdSeeds.push(seed);
  return { repository, engine };
}

const describeDb = describe.runIf(configured);

describeDb('PostgresWorldRepository', () => {
  beforeAll(async () => {
    await runMigrations(connectionString);
  });

  afterAll(async () => {
    const repo = new PostgresWorldRepository({ connectionString });
    for (const seed of createdSeeds) {
      await repo.deleteWorld(worldIdFromSeed(seed));
    }
    await repo.close();
  });

  it('persists a world across repository instances (restart simulation)', async () => {
    const { repository: repo1, engine: engine1 } = await makeEngine(424_201);
    // createdAt: now → nextTickAt is 30 min in the future, so a locally
    // running dev scheduler cannot pick up this test world as due.
    const first = await engine1.createWorld({ seed: 424_201, createdAt: Date.now() });
    expect(first.contentVersion).toBe(CONTENT_VERSION);
    await repo1.close();

    // A fresh process/repository reads the same world from Postgres.
    const repo2 = new PostgresWorldRepository({ connectionString });
    const engine2 = new TickEngine({ repository: repo2, lock: new WorldLock() });
    const reloaded = await engine2.getWorld(worldIdFromSeed(424_201));
    expect(reloaded).toBeDefined();
    expect(reloaded!.worldHash).toBe(first.worldHash);
    expect(reloaded!.tick).toBe(0);
    // createWorld is idempotent across restarts.
    const again = await engine2.createWorld({ seed: 424_201, createdAt: 999_999 });
    expect(again.worldHash).toBe(first.worldHash);
    await repo2.close();
  });

  it('persists resolutions across repository instances', async () => {
    const { repository: repo1, engine: engine1 } = await makeEngine(424_202);
    await engine1.createWorld({ seed: 424_202, createdAt: Date.now() });
    const resolution = await engine1.resolveNextTick(worldIdFromSeed(424_202), 1000);
    await repo1.close();

    const repo2 = new PostgresWorldRepository({ connectionString });
    const engine2 = new TickEngine({ repository: repo2, lock: new WorldLock() });
    const replay = await engine2.resolveTick(worldIdFromSeed(424_202), 1, 2000);
    expect(replay.tick).toBe(1);
    expect(replay.planetStateHash).toBe(resolution.planetStateHash);
    // No double execution: the stored resolution is preserved.
    expect(replay.resolvedAt).toBe(1000);
    await repo2.close();
  });

  it('two engines with separate connections cannot double-resolve a tick', async () => {
    // Two repository instances = two independent connection pools. The
    // in-process WorldLock is per-engine, so only the PostgreSQL advisory
    // lock serializes these resolvers.
    const { repository: repoA, engine: engineA } = await makeEngine(424_203);
    const { repository: repoB, engine: engineB } = await makeEngine(424_203);
    await engineA.createWorld({ seed: 424_203, createdAt: Date.now() });

    const [ra, rb] = await Promise.all([
      engineA.resolveNextTick(worldIdFromSeed(424_203), 1000),
      engineB.resolveNextTick(worldIdFromSeed(424_203), 1000),
    ]);

    expect(ra.tick).toBe(1);
    expect(rb.tick).toBe(1);
    expect(ra.planetStateHash).toBe(rb.planetStateHash);
    expect(ra.resolvedAt).toBe(rb.resolvedAt);
    expect(ra.resolvedAt).toBe(1000);
    const world = await engineA.getWorld(worldIdFromSeed(424_203));
    expect(world?.tick).toBe(1);
    await repoA.close();
    await repoB.close();
  });

  it('re-creates a world stored under a stale content version', async () => {
    const { repository, engine } = await makeEngine(424_204);
    const world = await engine.createWorld({ seed: 424_204, createdAt: Date.now() });
    const worldId = worldIdFromSeed(424_204);
    // Simulate an old-version row.
    await repository.saveWorld({ ...world, contentVersion: 'content-1', worldHash: 'stale' });
    const fresh = await engine.createWorld({ seed: 424_204, createdAt: Date.now() });
    expect(fresh.contentVersion).toBe(CONTENT_VERSION);
    expect(fresh.worldHash).not.toBe('stale');
    const reloaded = await repository.getWorld(worldId);
    expect(reloaded?.contentVersion).toBe(CONTENT_VERSION);
  });

  it('listWorldIds and deleteWorld work against the store', async () => {
    const { repository, engine } = await makeEngine(424_205);
    await engine.createWorld({ seed: 424_205, createdAt: Date.now() });
    const ids = await repository.listWorldIds();
    expect(ids).toContain(worldIdFromSeed(424_205));
    await repository.deleteWorld(worldIdFromSeed(424_205));
    const after = await repository.getWorld(worldIdFromSeed(424_205));
    expect(after).toBeUndefined();
  });

  it('withWorldLocked provides a consistent transaction view', async () => {
    const repo: WorldRepository = new PostgresWorldRepository({ connectionString });
    await repo.saveWorld(generateWorld({ seed: 424_206, createdAt: Date.now() }));
    const seen: string[] = [];
    await repo.withWorldLocked(worldIdFromSeed(424_206), async (tx) => {
      const world = await tx.getWorld(worldIdFromSeed(424_206));
      seen.push(world === undefined ? 'none' : 'some');
      await tx.saveResolution({
        worldId: worldIdFromSeed(424_206),
        tick: 1,
        contentVersion: CONTENT_VERSION,
        commandCutoffAt: 0,
        resolvedAt: 1,
        seed: 's',
        phaseHashes: { economy: 'h' },
        planetStateHash: 'p',
        status: 'completed',
      });
    });
    expect(seen).toEqual(['some']);
    await repo.deleteWorld(worldIdFromSeed(424_206));
    await (repo as PostgresWorldRepository).close();
  });
});
