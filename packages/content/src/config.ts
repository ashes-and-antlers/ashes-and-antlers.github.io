/**
 * Content version. Every tick resolution, planet projection, and world hash
 * carries this version: changing any value below is a content change that
 * invalidates every world generated under the previous version.
 *
 * content-6: M3 scans — the Scanner Array building, the SCAN rules (range,
 * kind gating, report rounding), and the player scan-archive state shape
 * land together.
 * content-5: M2 research and shipyards — the research tree (RESEARCH_TREE),
 * ship catalog (SHIP_DEFINITIONS), TRAVEL drive speeds, and account/planet
 * state shapes for research + shipyard queues + fleets land together.
 * content-4: M1 construction — the queue capacity, build-order rules, and
 * cancellation/refund policy land (CONSTRUCTION); every planet now carries
 * a construction queue, so every world's state shape changes.
 * content-3: the galaxy expands to 8 galaxies (3,072 planets) and the planet
 * name bank grows — both change every world's shape and naming.
 * content-2: M1 economy — resource stores, building definitions, production,
 * upkeep, storage, and population formulas added.
 */
export const CONTENT_VERSION = 'content-6';

/**
 * Worldgen semantics version. Bumped only when the *meaning* of a seed
 * changes (new worldgen rules, changed dimensions, renamed classes).
 *
 * world-9: every player is born with an empty scan archive (scanReports),
 * so the player state shape changes for every world.
 * world-8: planets are born with empty construction + shipyard queues, each
 * owned home planet spawns a local fleet, and every player starts with an
 * empty research queue — so the state shape changes for every world.
 * world-7: planets are born with an empty construction queue and the
 * planet-state hash covers it, so build orders change the world hash.
 * world-6: systems inside a sector no longer scatter freely — their
 * seeded disc positions are relaxed to a minimum separation, so planetary
 * clusters never overlap and every sector reads as distinct systems.
 * world-5: the spiral arm geometry is corrected — each arm advances by
 * `sectorAngleStep` per sector ON that arm (not per global sector index),
 * so the arms wind evenly from the core and sector cells never overlap;
 * the spiral is also widened so every cell holds its systems. Every
 * coordinate's map position changes (the coordinate space is unchanged).
 * world-4: sectors now lie along per-galaxy spiral arms instead of a
 * grid, so the map reads as a galaxy — every coordinate's map position
 * changes (the coordinate space itself is unchanged).
 * world-3: the finite space is 8 galaxies × 8 sectors × 8 systems × 6
 * planets (3,072 worlds); planets receive deterministic unique names, and
 * every coordinate maps to a deterministic map position via the galaxy
 * layout (foundation for fleet travel distance).
 * world-2: planet genesis now initializes economy state (starting resources,
 * population, settlement), so the same seed produces a richer world.
 */
export const WORLD_VERSION = 'world-9';

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
 * apart, systems cluster inside their sector (pushed to at least
 * `systemMinSeparation` apart so clusters never overlap), sectors lie along
 * spiral arms winding out of the galactic core, and galaxies are separated
 * by a large gap (the galactic tier). Positions are derived
 * deterministically from (seed, coordinate) — never stored — so fleet
 * travel distance is always computable.
 *
 * Each galaxy is a logarithmic spiral: `armsPerGalaxy` arms winding out of
 * a core radius of `galaxyCoreRadius`. A sector's center sits on arm
 * `(sector - 1) % armsPerGalaxy` at radius `core × step^(sector-1)` and the
 * arm's base angle plus `sectorAngleStep` per sector ON that arm, so
 * consecutive sectors interleave across the arms. The step, angle, and
 * jitter are tuned (world-5) so that every sector cell — its bounds padded
 * by `sectorBoundsMargin` past the system cluster and planet orbits — is
 * axis-aligned disjoint from every neighbor on every seed, while the whole
 * spiral still fits the galaxy grid gap.
 */
export const GALAXY_LAYOUT = {
  /** Galaxies lay out on a fixed grid (4 columns keeps the map wide). */
  galaxyGridCols: 4,
  /** Horizontal spacing between galaxy origins. */
  galaxySpacing: 10_000,
  /** Vertical spacing between galaxy rows. */
  galaxyRowSpacing: 9_600,
  /** Max jitter of a galaxy origin from its grid point. */
  galaxyJitter: 350,
  /** Spiral arms per galaxy. */
  armsPerGalaxy: 3,
  /** How many full turns the spiral makes from core to rim. */
  armTurns: 1.7,
  /** Distance from the galactic core to the innermost sector center. */
  galaxyCoreRadius: 600,
  /** Radius multiplier per sector index along the spiral (r_n = core × step^n). */
  galaxyRadiusStep: 1.3,
  /** Angular advance (radians) per sector index on its arm. */
  sectorAngleStep: 1.05,
  /** Max angular jitter of a sector center off its arm (radians). */
  sectorAngleJitter: 0.05,
  /** Max radial jitter of a sector center along its arm. */
  sectorRadiusJitter: 35,
  /** Systems scatter within this radius of their sector center. */
  systemClusterRadius: 280,
  /**
   * Minimum center-to-center distance between systems of the same sector
   * (world-6): two systems closer than this would have overlapping orbit
   * rings and planetary clusters. Twice the widest planet orbit (52) plus
   * breathing room, enforced by the deterministic layout relaxation.
   */
  systemMinSeparation: 120,
  /** Planet orbit radii around the system star. */
  planetOrbitMin: 24,
  planetOrbitMax: 52,
  /** Breathing room around a sector's content, so cells never overlap. */
  sectorBoundsMargin: 30,
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

/**
 * M1 construction queue rules (DEVELOPMENT_PLAN.md §4). Costs are reserved
 * (deducted) at submission; cancellation refunds `refundFraction` of the
 * exact reserved amount, clamped to the storage cap like all store additions.
 * Queues advance only at tick boundaries: one order under construction per
 * planet, the rest waiting in submission order.
 */
export const CONSTRUCTION = {
  /** Active + queued orders a planet may hold at once. */
  queueCapacity: 3,
  /** Fraction of the reserved cost refunded on cancellation (1 = full). */
  refundFraction: 1,
} as const;

export type ConstructionConfig = typeof CONSTRUCTION;

export type EconomyConfig = typeof ECONOMY;

/**
 * Fleet travel (DEVELOPMENT_PLAN.md §5, M2). Each drive tier has a base
 * speed in map units per tick; travel ticks = ceil(distance / speed), with
 * navigation research adding a fractional speed bonus. Tuned so the tiers
 * read naturally against the seeded map distances (galaxy-layout test).
 */
export const TRAVEL = {
  driveTierSpeed: {
    planetary: 120,
    stellar: 480,
    galactic: 1600,
  } as const,
} as const;

export type TravelConfig = typeof TRAVEL;

/**
 * Scan missions (DEVELOPMENT_PLAN.md §6, M3). A scan runs from an owned
 * planet with a Scanner Array; reach = (base + level × perLevel) ×
 * (1 + scanRangeBonus) map units. Scan kinds are gated by the source
 * array's level (basic L1, resource L2, military L3), so leveling the
 * building unlocks better intel — the same "research unlocks capability"
 * direction as the technology tree. Reports round private state to the
 * nearest `population`/`resources` unit so intel is approximate by design.
 */
export const SCAN = {
  baseRange: 1500,
  rangePerScannerLevel: 700,
  /** Reach multiplier from the watch-spire research line (scanRangeBonus). */
  kinds: {
    basic: { requiredScannerLevel: 1 },
    resource: { requiredScannerLevel: 2 },
    military: { requiredScannerLevel: 3 },
  } as const,
  rounding: {
    population: 100,
    resources: 50,
  },
} as const;

export type ScanConfig = typeof SCAN;
