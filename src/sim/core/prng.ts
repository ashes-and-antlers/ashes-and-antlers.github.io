import { fnv1a } from '../../shared/utils';

/**
 * Deterministic, streamable PRNG for the simulation.
 *
 * Contract (see DEVELOPMENT_PLAN §5 and docs/ADR-001):
 * - Never use Math.random() inside the simulation.
 * - Separate named streams per concern so adding a consumer never changes
 *   another consumer's sequence.
 * - mulberry32 + FNV-1a use only integer arithmetic (Math.imul / bitwise),
 *   making them deterministic across platforms and engines.
 */

export type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Prng {
  next: Rng;
  stream: (name: string) => Rng;
}

export function createPrng(seed: number): Prng {
  const base = mulberry32(seed);
  return {
    next: base,
    stream: (name) => mulberry32(fnv1a(`${seed}:${name}`)),
  };
}

/** Uniform integer in [0, maxExclusive). */
export function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randomInt(rng, items.length)] ?? items[0]!;
}
