import { serve } from '@hono/node-server';
import { TickEngine, InMemoryWorldRepository, WorldLock, TickScheduler } from '@ashes/db';
import { worldIdFromSeed } from '@ashes/contracts';
import { createApi } from './app';

const port = Number(process.env.PORT ?? 3001);
const worldSeed = Number(process.env.WORLD_SEED ?? 1337);
const playerToken = process.env.PLAYER_TOKEN ?? 'player-1337-token';
const adminToken = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
// Dev/e2e override so ticks can be observed live; the production cadence is
// the 30-minute content default.
const tickDurationMs = process.env.TICK_DURATION_MS
  ? Number(process.env.TICK_DURATION_MS)
  : undefined;

const repository = new InMemoryWorldRepository();
const engine = new TickEngine({ repository, lock: new WorldLock() });
engine.createWorld({
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
const seeded = engine.getWorld(worldId);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] listening on :${info.port}`);
  console.log(`[api] world ${worldSeed} seeded (tickDurationMs=${seeded?.tickDurationMs})`);
});

function shutdown() {
  scheduler.stop();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
