/**
 * Content version. Every tick resolution, planet projection, and world hash
 * carries this version: changing any value below is a content change that
 * invalidates every world generated under the previous version.
 *
 * content-3: the galaxy expands to 8 galaxies (3,072 planets) and the planet
 * name bank grows — both change every world's shape and naming.
 * content-2: M1 economy — resource stores, building definitions, production,
 * upkeep, storage, and population formulas added.
 */
export const CONTENT_VERSION = 'content-3';

/**
 * Worldgen semantics version. Bumped only when the *meaning* of a seed
 * changes (new worldgen rules, changed dimensions, renamed classes).
 *
 * world-3: the finite space is 8 galaxies × 8 sectors × 8 systems × 6
 * planets (3,072 worlds); planets receive deterministic unique names, and
 * every coordinate maps to a deterministic map position via the galaxy
 * layout (foundation for fleet travel distance).
 * world-2: planet genesis now initializes economy state (starting resources,
 * population, settlement), so the same seed produces a richer world.
 */
export const WORLD_VERSION = 'world-3';

/**
 * Finite coordinate space and global tick schedule (DEVELOPMENT_PLAN.md §2-3).
 * The 30-minute tick is the closed-alpha cadence; the engine treats
 * tickDurationMs as world config so tests and dev runs can shorten it.
 */
export const WORLD_CONFIG = {
  galaxies: 8,
  sectorsPerGalaxy: 8,
  systemsPerSector: 8,
  planetsPerSystem: 6,
  tickDurationMs: 30 * 60 * 1000,
} as const;

/**
 * Galaxy map geometry (DEVELOPMENT_PLAN.md §3/§5). Distances are chosen so
 * the drive tiers read naturally: planets within a system sit tens of units
 * apart, systems cluster inside their sector, sectors grid across their
 * galaxy, and galaxies are separated by a large gap (the galactic tier).
 * Positions are derived deterministically from (seed, coordinate) — never
 * stored — so fleet travel distance is always computable.
 */
export const GALAXY_LAYOUT = {
  /** Galaxies lay out on a fixed grid (4 columns keeps the map wide). */
  galaxyGridCols: 4,
  /** Horizontal spacing between galaxy origins. */
  galaxySpacing: 10_000,
  /** Vertical spacing between galaxy rows. */
  galaxyRowSpacing: 9_000,
  /** Max jitter of a galaxy origin from its grid point. */
  galaxyJitter: 350,
  /** Sector grid cell size within a galaxy (sectorsPerGalaxy × cell). */
  sectorCell: 1_000,
  /** Max jitter of a sector center from its cell center. */
  sectorJitter: 140,
  /** Systems scatter within this radius of their sector center. */
  systemClusterRadius: 340,
  /** Planet orbit radii around the system star. */
  planetOrbitMin: 24,
  planetOrbitMax: 52,
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
