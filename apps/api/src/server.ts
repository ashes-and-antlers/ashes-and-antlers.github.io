import { serve } from '@hono/node-server';
import {
  PostgresWorldRepository,
  runMigrations,
  TickEngine,
  TickScheduler,
  WorldLock,
} from '@ashes/db';
import { worldIdFromSeed } from '@ashes/contracts';
import { createApi } from './app';

const port = Number(process.env.PORT ?? 3001);
// Matches docker-compose.yml; override with DATABASE_URL for other environments.
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ashes:ashes@localhost:5432/ashes';
const worldSeed = Number(process.env.WORLD_SEED ?? 1337);
const playerToken = process.env.PLAYER_TOKEN ?? 'player-1337-token';
const adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
// Dev/e2e override so ticks can be observed live; the production cadence is
// the 30-minute content default.
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
      console.log(`[tick] world ${r.worldId} resolved tick ${r.tick} (hash ${r.planetStateHash})`);
    },
  });
  scheduler.start();

  const app = createApi(engine, { playerToken, adminToken });

  const worldId = worldIdFromSeed(worldSeed);
  const seeded = await engine.getWorld(worldId);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[api] listening on :${info.port}`);
    console.log(`[api] world ${worldSeed} seeded (tickDurationMs=${seeded?.tickDurationMs})`);
  });

  function shutdown(): void {
    scheduler.stop();
    server.close();
    void repository.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[api] failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
