/**
 * Content version. Every tick resolution, planet projection, and world hash
 * carries this version: changing any value below is a content change that
 * invalidates every world generated under the previous version.
 *
 * content-2: M1 economy — resource stores, building definitions, production,
 * upkeep, storage, and population formulas added.
 */
export const CONTENT_VERSION = 'content-2';

/**
 * Worldgen semantics version. Bumped only when the *meaning* of a seed
 * changes (new worldgen rules, changed dimensions, renamed classes).
 *
 * world-2: planet genesis now initializes economy state (starting resources,
 * population, settlement), so the same seed produces a richer world.
 */
export const WORLD_VERSION = 'world-2';

/**
 * Finite coordinate space and global tick schedule (DEVELOPMENT_PLAN.md §2-3).
 * The 30-minute tick is the closed-alpha cadence; the engine treats
 * tickDurationMs as world config so tests and dev runs can shorten it.
 */
export const WORLD_CONFIG = {
  galaxies: 1,
  sectorsPerGalaxy: 8,
  systemsPerSector: 8,
  planetsPerSystem: 6,
  tickDurationMs: 30 * 60 * 1000,
} as const;

export type WorldConfig = typeof WORLD_CONFIG;

/**
 * M1 economy formulas (DEVELOPMENT_PLAN.md §4). All arithmetic is integer
 * (floor) and deterministic — no randomness. The formula contract is tested
 * in packages/domain (economy.test.ts).
 */
export const ECONOMY = {
  /** Per-resource storage cap. Storehouses raise it per level. */
  storage: {
    basePerResource: 500,
    perStorehouseLevel: 250,
  },
  population: {
    baseCapacity: 500,
    perSettlementLevel: 500,
    /** Food consumed per tick per 1000 population. */
    foodPer1000PopulationPerTick: 2,
    /** Growth as a fraction of current population per tick (when fed). */
    growthFractionPerTick: 0.01,
    maxGrowthPerTick: 25,
    /** Population lost per tick while starving. */
    starvationShrinkPerTick: 25,
  },
  production: {
    /** output = baseOutputPerLevel × level × abundance / 100 (per resource). */
    baseOutputPerLevel: 10,
  },
  /** When energy upkeep cannot be covered, production is halved (brownout). */
  brownoutProductionFactor: 0.5,
} as const;

export type EconomyConfig = typeof ECONOMY;
