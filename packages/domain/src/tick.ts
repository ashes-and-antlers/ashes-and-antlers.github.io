import type { TickResolution, WorldState } from '@ashes/contracts';
import { computePlanetStateHash } from './worldgen';
import { hashHex } from './prng';

export type TickInput = {
  world: WorldState;
  tick: number;
  /** Epoch ms when the next tick will resolve (the command cutoff). */
  resolvedAt: number;
};

/**
 * The M0 resolution phase: the "empty" phase. It advances the world tick,
 * records an immutable resolution with a deterministic seed and phase hashes,
 * and stamps every planet with the resolved tick. No resources, construction,
 * or fleets resolve yet (those arrive in M1+ phases).
 *
 * Pure and deterministic: given the same world + tick + resolvedAt, the
 * resulting world and resolution are always identical.
 */
export function resolveEmptyTick(input: TickInput): {
  world: WorldState;
  resolution: TickResolution;
} {
  const { world, tick } = input;
  const resolvedAt = input.resolvedAt;

  // Deterministic per (world, tick, content) seed for this resolution.
  const seed = hashHex(`tick:${world.id}:${tick}:${world.contentVersion}:${world.seed}`);
  const planets = world.planets.map((p) => ({ ...p, lastResolvedTick: tick }));
  const planetStateHash = computePlanetStateHash(planets);
  const phaseHashes: Record<string, string> = {
    empty: hashHex(`phase:empty:${seed}`),
    planets: planetStateHash,
  };

  const next: WorldState = {
    ...world,
    tick,
    lastResolvedAt: resolvedAt,
    nextTickAt: resolvedAt + world.tickDurationMs,
    planets,
    version: world.version + 1,
  };

  const resolution: TickResolution = {
    worldId: world.id,
    tick,
    contentVersion: world.contentVersion,
    commandCutoffAt: world.nextTickAt,
    resolvedAt,
    seed,
    phaseHashes,
    planetStateHash,
    status: 'completed',
  };

  return { world: next, resolution };
}
