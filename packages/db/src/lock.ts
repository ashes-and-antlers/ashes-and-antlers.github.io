import type { WorldId } from '@ashes/contracts';

/**
 * Per-world mutex. Only one holder may hold the lock for a world at a time;
 * further acquires queue until the current holder releases. Combined with the
 * engine's idempotency check inside the critical section, this guarantees a
 * duplicate tick job can never run two resolvers for the same world/tick.
 *
 * M1 swaps this for a database advisory lock / lease on the same interface.
 */
export class WorldLock {
  private tails = new Map<string, Promise<void>>();

  async acquire(worldId: WorldId): Promise<() => void> {
    const prev = this.tails.get(worldId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(worldId, tail);
    // Wait for the previous holder to release, then hand over the key.
    await prev;
    return release;
  }
}
