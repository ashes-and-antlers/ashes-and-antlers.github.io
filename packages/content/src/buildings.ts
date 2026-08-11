import {
  BUILDING_KINDS,
  type BuildingKind,
  type BuildingLevels,
  type ResourceKey,
  type ResourceRates,
} from '@ashes/contracts';

export type BuildingDefinition = {
  kind: BuildingKind;
  name: string;
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
 * M1 initial buildings (DEVELOPMENT_PLAN.md §4). Lab and shipyard definitions
 * ship with costs/upkeep but no output yet: research and ship production land
 * in Milestone 2.
 */
export const BUILDING_DEFINITIONS: Record<BuildingKind, BuildingDefinition> = {
  settlement: {
    kind: 'settlement',
    name: 'Settlement',
    produces: [],
    upkeep: { food: 1, energy: 1 },
    cost: { metal: 100, food: 20 },
    buildTicks: 3,
    maxLevel: 10,
  },
  mine: {
    kind: 'mine',
    name: 'Metal Mine',
    produces: ['metal'],
    upkeep: { energy: 1 },
    cost: { metal: 60 },
    buildTicks: 2,
    maxLevel: 10,
  },
  extractor: {
    kind: 'extractor',
    name: 'Mineral Extractor',
    produces: ['mineral'],
    upkeep: { energy: 2 },
    cost: { metal: 120, mineral: 40 },
    buildTicks: 3,
    maxLevel: 10,
  },
  farm: {
    kind: 'farm',
    name: 'Farm',
    produces: ['food'],
    upkeep: { energy: 1 },
    cost: { metal: 50 },
    buildTicks: 2,
    maxLevel: 10,
  },
  reactor: {
    kind: 'reactor',
    name: 'Reactor',
    produces: ['energy'],
    upkeep: {},
    cost: { metal: 200, mineral: 60 },
    buildTicks: 4,
    maxLevel: 10,
  },
  storehouse: {
    kind: 'storehouse',
    name: 'Storehouse',
    produces: [],
    upkeep: { energy: 1 },
    cost: { metal: 80 },
    buildTicks: 2,
    maxLevel: 10,
  },
  lab: {
    kind: 'lab',
    name: 'Research Lab',
    produces: [],
    upkeep: { energy: 2 },
    cost: { metal: 150, mineral: 100 },
    buildTicks: 4,
    maxLevel: 10,
  },
  shipyard: {
    kind: 'shipyard',
    name: 'Shipyard',
    produces: [],
    upkeep: { energy: 3 },
    cost: { metal: 300, mineral: 150 },
    buildTicks: 5,
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
