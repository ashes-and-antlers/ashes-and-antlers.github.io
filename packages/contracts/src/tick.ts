import type { WorldId } from './ids';

export type TickResolutionStatus = 'running' | 'completed' | 'failed';

/**
 * One immutable resolution record per world/tick (DEVELOPMENT_PLAN.md §9).
 * `seed` and `phaseHashes` make every tick replayable and auditable.
 */
export type TickResolution = {
  worldId: WorldId;
  tick: number;
  contentVersion: string;
  /** Commands submitted after this instant are excluded from the tick. */
  commandCutoffAt: number;
  resolvedAt: number;
  seed: string;
  phaseHashes: Record<string, string>;
  planetStateHash: string;
  status: TickResolutionStatus;
};

export type TickResolutionView = {
  tick: number;
  commandCutoffAt: number;
  resolvedAt: number;
  seed: string;
  phaseHashes: Record<string, string>;
  planetStateHash: string;
  status: TickResolutionStatus;
};

export function toTickResolutionView(resolution: TickResolution): TickResolutionView {
  return {
    tick: resolution.tick,
    commandCutoffAt: resolution.commandCutoffAt,
    resolvedAt: resolution.resolvedAt,
    seed: resolution.seed,
    phaseHashes: resolution.phaseHashes,
    planetStateHash: resolution.planetStateHash,
    status: resolution.status,
  };
}
