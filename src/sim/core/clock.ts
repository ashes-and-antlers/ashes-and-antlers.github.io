import { MAX_TICKS_PER_FRAME, TICKS_PER_SECOND } from '../../shared/constants';

/**
 * Fixed-step clock accumulator.
 *
 * Converts real elapsed time into a whole number of fixed simulation ticks.
 * Deterministic by construction: the same (elapsedMs, speed, ticksPerSecond)
 * always yields the same number of ticks, and ticks only ever advance here.
 */
export class FixedClock {
  /** Accumulated time expressed in tick-fractions (1.0 = one whole tick). */
  private accumulatorTicks = 0;

  constructor(private readonly ticksPerSecond: number = TICKS_PER_SECOND) {}

  /**
   * Advance by real elapsed ms and return the number of ticks to run.
   * Pause (speed <= 0) discards accumulated time. Catch-up is capped.
   */
  advance(elapsedMs: number, speed: number, maxTicks: number = MAX_TICKS_PER_FRAME): number {
    if (speed <= 0 || elapsedMs <= 0) {
      this.accumulatorTicks = 0;
      return 0;
    }
    this.accumulatorTicks += (elapsedMs / 1000) * speed * this.ticksPerSecond;
    let ticks = Math.floor(this.accumulatorTicks);
    if (ticks > maxTicks) {
      // Leave the backlog in the accumulator so it drains at the cap rate.
      ticks = maxTicks;
      this.accumulatorTicks -= maxTicks;
    } else {
      this.accumulatorTicks -= ticks;
    }
    return ticks;
  }
}
