import type { TickResolution } from '@ashes/contracts';
import type { TickEngine } from './engine';
import type { WorldRepository } from './repository';

export type SchedulerOptions = {
  /** How often to check for due worlds. */
  intervalMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Called after each tick resolves (for observability). */
  onResolution?: (resolution: TickResolution) => void;
};

/**
 * The tick worker loop: repeatedly asks the engine to resolve any world whose
 * nextTickAt has passed. Ownership stays in the engine; this only triggers
 * resolution. M1 replaces the interval with a durable job scheduler.
 */
export class TickScheduler {
  private readonly engine: TickEngine;
  private readonly repository: WorldRepository;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onResolution: ((resolution: TickResolution) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: TickEngine, repository: WorldRepository, options: SchedulerOptions) {
    this.engine = engine;
    this.repository = repository;
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? (() => Date.now());
    this.onResolution = options.onResolution ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkDue();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resolve every world that is currently due. Returns the resolutions. */
  async checkDue(): Promise<TickResolution[]> {
    const now = this.now();
    const resolved: TickResolution[] = [];
    for (const worldId of this.repository.listWorldIds()) {
      const world = this.engine.getWorld(worldId);
      if (!world) continue;
      if (now >= world.nextTickAt) {
        const resolution = await this.engine.resolveNextTick(worldId, now);
        resolved.push(resolution);
        this.onResolution?.(resolution);
      }
    }
    return resolved;
  }
}
