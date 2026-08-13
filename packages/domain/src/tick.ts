import type { TickResolution, WorldState } from '@ashes/contracts';
import { hashHex } from './prng';
import { computePlanetStateHash } from './worldgen';
import { resolveEconomyTick, type TickInput } from './economy';
import { resolveConstructionTick } from './construction';
import { resolveResearchTick } from './research';
import { resolveShipyardTick } from './shipyard';
import { resolveMovementTick } from './movement';

/**
 * The full tick resolution (M1 economy + construction; M2 research + shipyard;
 * M3 fleet movement). Phases run in the fixed order defined in
 * DEVELOPMENT_PLAN.md §2: economy first (production, upkeep, storage,
 * population), then the queues (research, construction, shipyard), then fleet
 * travel and arrivals. A building that completes on tick N produces nothing
 * until tick N+1, a technology completed on tick N applies its effects from
 * tick N+1, ships built on tick N enter the local fleet that same tick, and a
 * fleet whose arrival tick is N docks at tick N.
 */
export function resolveTick(input: TickInput): {
  world: WorldState;
  resolution: TickResolution;
} {
  const economy = resolveEconomyTick(input);
  const researched = resolveResearchTick(economy.world, input.tick);
  const constructed = resolveConstructionTick(researched, input.tick);
  const built = resolveShipyardTick(constructed, input.tick);
  const world = resolveMovementTick(built, input.tick);
  const planetStateHash = computePlanetStateHash(world.planets);
  const resolution: TickResolution = {
    ...economy.resolution,
    planetStateHash,
    phaseHashes: {
      ...economy.resolution.phaseHashes,
      research: hashHex(`phase:research:${economy.resolution.seed}`),
      construction: hashHex(`phase:construction:${economy.resolution.seed}`),
      shipyard: hashHex(`phase:shipyard:${economy.resolution.seed}`),
      movement: hashHex(`phase:movement:${economy.resolution.seed}`),
    },
  };
  return { world, resolution };
}
