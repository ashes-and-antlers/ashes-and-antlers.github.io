/**
 * Content version. Every tick resolution, planet projection, and world hash
 * carries this version: changing any value below is a content change that
 * invalidates every world generated under the previous version.
 */
export const CONTENT_VERSION = 'content-1';

/**
 * Worldgen semantics version. Bumped only when the *meaning* of a seed
 * changes (new worldgen rules, changed dimensions, renamed classes).
 */
export const WORLD_VERSION = 'world-1';

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
