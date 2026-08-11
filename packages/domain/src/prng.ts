/**
 * Deterministic randomness (ADR-001, carried forward): FNV-1a hashing and
 * mulberry32 PRNG use only integer arithmetic, so sequences are identical
 * across platforms. No `Math.random()` anywhere in authoritative logic.
 */

/** FNV-1a 32-bit. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Prng = () => number;

/**
 * Named PRNG stream: each concern (worldgen, home placement, naming, ...)
 * draws from its own stream derived from (seed, stream name), so adding a
 * consumer never perturbs another stream's sequence.
 */
export function createPrng(seed: number, stream: string): Prng {
  return mulberry32(fnv1a(`${seed}:${stream}`));
}

/** Deterministic integer in [0, max). */
export function intBelow(prng: Prng, max: number): number {
  return Math.floor(prng() * max);
}

/** Deterministic integer in [min, max] inclusive. */
export function intInRange(prng: Prng, min: number, max: number): number {
  return min + intBelow(prng, max - min + 1);
}

/** Hex string of an FNV-1a hash — used for content and state hashes. */
export function hashHex(input: string): string {
  return fnv1a(input).toString(16).padStart(8, '0');
}
