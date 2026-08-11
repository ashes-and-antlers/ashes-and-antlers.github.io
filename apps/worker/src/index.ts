import {
  PostgresWorldRepository,
  runMigrations,
  TickEngine,
  TickScheduler,
  WorldLock,
} from '@ashes/db';

/**
 * The tick worker process. It owns the authoritative engine and scheduler
 * loop that resolves due worlds every second. M1: backed by PostgreSQL, so
 * multiple workers coordinate through the same store (per-world advisory
 * locks make concurrent resolvers safe).
 */
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ashes:ashes@localhost:5432/ashes';
const worldSeed = Number(process.env.WORLD_SEED ?? 1337);
const playerToken = process.env.PLAYER_TOKEN ?? 'player-1337-token';
const tickDurationMs = process.env.TICK_DURATION_MS
  ? Number(process.env.TICK_DURATION_MS)
  : undefined;

async function main(): Promise<void> {
  await runMigrations(databaseUrl);
  const repository = new PostgresWorldRepository({ connectionString: databaseUrl });
  const engine = new TickEngine({ repository, lock: new WorldLock() });
  await engine.createWorld({
    seed: worldSeed,
    playerToken,
    createdAt: Date.now(),
    ...(tickDurationMs === undefined ? {} : { tickDurationMs }),
  });

  const scheduler = new TickScheduler(engine, repository, {
    intervalMs: 1_000,
    onResolution: (r) => {
      console.log(
        `[worker] world ${r.worldId} resolved tick ${r.tick} (hash ${r.planetStateHash})`,
      );
    },
  });
  scheduler.start();

  console.log(`[worker] tick worker online; world ${worldSeed} seeded`);
  console.log('[worker] press Ctrl+C to stop');

  function shutdown(): void {
    scheduler.stop();
    void repository.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[worker] failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
