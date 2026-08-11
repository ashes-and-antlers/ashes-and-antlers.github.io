import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/sim/core/clock';

describe('FixedClock', () => {
  it('returns no ticks when paused', () => {
    const clock = new FixedClock(5);
    expect(clock.advance(1000, 0)).toBe(0);
    expect(clock.advance(10_000, 0)).toBe(0);
  });

  it('runs 5 ticks per second at 1x', () => {
    const clock = new FixedClock(5);
    expect(clock.advance(1000, 1)).toBe(5);
  });

  it('accumulates fractional ticks', () => {
    const clock = new FixedClock(5);
    expect(clock.advance(100, 1)).toBe(0);
    expect(clock.advance(100, 1)).toBe(1); // 0.5 + 0.5 accumulated
  });

  it('scales with the speed multiplier', () => {
    const clock = new FixedClock(5);
    expect(clock.advance(1000, 4, 1000)).toBe(20);
    expect(clock.advance(1000, 8, 1000)).toBe(40);
  });

  it('caps catch-up per frame and drains the backlog gradually', () => {
    const clock = new FixedClock(5);
    // 8x for a full second wants 40 ticks; the cap limits a single frame to 30.
    expect(clock.advance(1000, 8, 30)).toBe(30);
    // The 10-tick backlog carries into the next frame: 10 + 5 new = 15.
    expect(clock.advance(1000, 1, 30)).toBe(15);
  });

  it('ignores non-positive elapsed time', () => {
    const clock = new FixedClock(5);
    expect(clock.advance(-5, 1)).toBe(0);
    expect(clock.advance(0, 1)).toBe(0);
  });
});
