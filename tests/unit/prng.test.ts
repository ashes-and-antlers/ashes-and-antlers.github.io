import { describe, expect, it } from 'vitest';
import { createPrng } from '../../src/sim/core/prng';

describe('createPrng', () => {
  it('is deterministic for the same seed', () => {
    const a = createPrng(42).next;
    const b = createPrng(42).next;
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = createPrng(1).next;
    const b = createPrng(2).next;
    expect(a()).not.toBe(b());
  });

  it('emits values in [0, 1)', () => {
    const rng = createPrng(7).next;
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('isolates named streams and repeats them for the same seed', () => {
    const prng = createPrng(99);
    const a1 = prng.stream('a');
    const b1 = prng.stream('b');
    const aFirst = a1();
    const bFirst = b1();
    expect(aFirst).not.toBe(bFirst);

    const prng2 = createPrng(99);
    expect(prng2.stream('a')()).toBe(aFirst);
    expect(prng2.stream('b')()).toBe(bFirst);
  });
});
