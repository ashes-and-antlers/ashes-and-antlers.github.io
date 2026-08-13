import {
  technologyId,
  type ResourceRates,
  type ShipDefinition,
  type ShipKind,
} from '@ashes/contracts';

/**
 * M2 ship catalog (DEVELOPMENT_PLAN.md §5): the initial scout/freighter/
 * outpost/fighter set. Ships are data-driven: each kind has a per-hull cost,
 * build time, drive tier, cargo capacity, and combat hull/attack, plus an
 * optional technology gate (a ship locked behind research shows its gate on
 * the shipyard catalog). A planet needs a Shipyard building to build ships.
 */
export const SHIP_DEFINITIONS: Record<ShipKind, ShipDefinition> = {
  scout: {
    kind: 'scout',
    name: 'Scout',
    summary: 'A fast, cheap hull for scouting missions and early screening.',
    role: 'Fast scan and intelligence mission',
    cost: { metal: 40, mineral: 20 },
    buildTicks: 1,
    driveTier: 'stellar',
    cargoCapacity: 0,
    hull: 1,
    attack: 0,
    requiredTechnology: null,
  },
  freighter: {
    kind: 'freighter',
    name: 'Freighter',
    summary: 'A sturdy hauler that carries local resources between worlds.',
    role: 'Carries local resources between planets',
    cost: { metal: 80, mineral: 40, food: 20 },
    buildTicks: 2,
    driveTier: 'stellar',
    cargoCapacity: 200,
    hull: 2,
    attack: 0,
    requiredTechnology: null,
  },
  outpost: {
    kind: 'outpost',
    name: 'Outpost Ship',
    summary: 'The seed barge that colonizes valid unowned worlds.',
    role: 'Colonizes valid unowned worlds',
    cost: { metal: 200, mineral: 120, food: 60 },
    buildTicks: 3,
    driveTier: 'stellar',
    cargoCapacity: 50,
    hull: 2,
    attack: 0,
    requiredTechnology: technologyId('colony-1'),
  },
  fighter: {
    kind: 'fighter',
    name: 'Fighter',
    summary: 'A cheap early combat hull for defense and raids.',
    role: 'Cheap early offensive and defensive combat',
    cost: { metal: 60 },
    buildTicks: 1,
    driveTier: 'planetary',
    cargoCapacity: 0,
    hull: 2,
    attack: 1,
    requiredTechnology: technologyId('shipyard-1'),
  },
};

export const SHIP_ORDER: ShipKind[] = ['scout', 'freighter', 'outpost', 'fighter'];

/**
 * Shipyard queue rules (DEVELOPMENT_PLAN.md §4-5). One order builds at a time
 * per planet; the rest wait FIFO. Costs are reserved at submission; refunds
 * use the same policy as construction (full, clamped at the storage cap).
 */
export const SHIPYARD = {
  queueCapacity: 3,
  refundFraction: 1,
} as const;

export type ShipyardConfig = typeof SHIPYARD;

/** Resource cost of one hull of a ship kind. */
export function shipCost(kind: ShipKind): Partial<ResourceRates> {
  return SHIP_DEFINITIONS[kind].cost;
}
