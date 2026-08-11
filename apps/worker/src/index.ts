import { TickEngine, InMemoryWorldRepository, WorldLock, TickScheduler } from '@ashes/db';

/**
 * The tick worker process. It owns the authoritative engine and scheduler
 * loop that resolves due worlds every second (M0: in-memory, single world).
 * M1 replaces the in-memory repository with PostgreSQL so multiple workers
 * can coordinate through the same store.
 */
const worldSeed = Number(process.env.WORLD_SEED ?? 1337);
const playerToken = process.env.PLAYER_TOKEN ?? 'player-1337-token';
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
    console.log(`[worker] world ${r.worldId} resolved tick ${r.tick} (hash ${r.planetStateHash})`);
  },
});
scheduler.start();

console.log(`[worker] tick worker online; world ${worldSeed} seeded`);
console.log('[worker] press Ctrl+C to stop');

function shutdown() {
  scheduler.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
