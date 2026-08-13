import {
  BUILDING_KINDS,
  type BuildingKind,
  type BuildingLevels,
  type ResourceKey,
  type ResourceRates,
} from '@ashes/contracts';

/** Presentation-only grouping for the planet ledger's building catalog: new
 *  buildings declare their category in content and slot into the UI without
 *  code changes (no simulation impact — do not bump CONTENT_VERSION for it). */
export type BuildingCategory = 'extraction' | 'infrastructure' | 'advanced';

export type BuildingDefinition = {
  kind: BuildingKind;
  name: string;
  /** One-line purpose, shown on the planet ledger's building catalog. */
  summary: string;
  /** Catalog grouping (presentation-only). */
  category: BuildingCategory;
  /** Resources this building produces each tick at level 1 (scaled by level × abundance). */
  produces: ResourceKey[];
  /** Upkeep per level per tick. */
  upkeep: Partial<ResourceRates>;
  /** Resource cost to build (one level). */
  cost: Partial<ResourceRates>;
  /** Ticks until a new level completes. */
  buildTicks: number;
  maxLevel: number;
};

/**
 * M1/M2 buildings (DEVELOPMENT_PLAN.md §4). The lab hosts the account-wide
 * research queue (M2) and the shipyard builds ships into the local fleet (M2).
 */
export const BUILDING_DEFINITIONS: Record<BuildingKind, BuildingDefinition> = {
  settlement: {
    kind: 'settlement',
    name: 'Settlement',
    summary: 'Houses your population and raises the ceiling on how many people the world can hold.',
    category: 'infrastructure',
    produces: [],
    upkeep: { food: 1, energy: 1 },
    cost: { metal: 100, food: 20 },
    buildTicks: 3,
    maxLevel: 10,
  },
  mine: {
    kind: 'mine',
    name: 'Metal Mine',
    summary: 'Pulls raw metal from the ground — output scales with this world’s metal abundance.',
    category: 'extraction',
    produces: ['metal'],
    upkeep: { energy: 1 },
    cost: { metal: 60 },
    buildTicks: 2,
    maxLevel: 10,
  },
  extractor: {
    kind: 'extractor',
    name: 'Mineral Extractor',
    summary: 'Bores for mineral ore — output scales with this world’s mineral abundance.',
    category: 'extraction',
    produces: ['mineral'],
    upkeep: { energy: 2 },
    cost: { metal: 120, mineral: 40 },
    buildTicks: 3,
    maxLevel: 10,
  },
  farm: {
    kind: 'farm',
    name: 'Farm',
    summary: 'Grows food to feed the population — output scales with this world’s food abundance.',
    category: 'extraction',
    produces: ['food'],
    upkeep: { energy: 1 },
    cost: { metal: 50 },
    buildTicks: 2,
    maxLevel: 10,
  },
  reactor: {
    kind: 'reactor',
    name: 'Reactor',
    summary:
      'Generates energy to power industry — output scales with this world’s energy abundance.',
    category: 'extraction',
    produces: ['energy'],
    upkeep: {},
    cost: { metal: 200, mineral: 60 },
    buildTicks: 4,
    maxLevel: 10,
  },
  storehouse: {
    kind: 'storehouse',
    name: 'Storehouse',
    summary: 'Expands local storage so each resource can be stockpiled higher before it is wasted.',
    category: 'infrastructure',
    produces: [],
    upkeep: { energy: 1 },
    cost: { metal: 80 },
    buildTicks: 2,
    maxLevel: 10,
  },
  lab: {
    kind: 'lab',
    name: 'Research Lab',
    summary:
      "The archive that hosts your research queue — studies are paid from the lab planet's store.",
    category: 'advanced',
    produces: [],
    upkeep: { energy: 2 },
    cost: { metal: 150, mineral: 100 },
    buildTicks: 4,
    maxLevel: 10,
  },
  shipyard: {
    kind: 'shipyard',
    name: 'Shipyard',
    summary: "The dry dock that builds ships into this planet's local fleet.",
    category: 'advanced',
    produces: [],
    upkeep: { energy: 3 },
    cost: { metal: 300, mineral: 150 },
    buildTicks: 5,
    maxLevel: 10,
  },
  scanner: {
    kind: 'scanner',
    name: 'Scanner Array',
    summary:
      'A watch array that runs scan missions — higher levels reach farther and unlock deeper scans.',
    category: 'advanced',
    produces: [],
    upkeep: { energy: 2 },
    cost: { metal: 120, mineral: 80 },
    buildTicks: 3,
    maxLevel: 10,
  },
};

export function totalBuildingLevels(buildings: BuildingLevels): number {
  let total = 0;
  for (const kind of BUILDING_KINDS) {
    total += buildings[kind] ?? 0;
  }
  return total;
}
