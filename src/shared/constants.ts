/**
 * Shared, cross-thread constants. Never change a value that affects
 * simulation output without bumping WORLD_VERSION or PROTOCOL_VERSION.
 */

/** Authoritative simulation tick rate: 5 fixed ticks per real second at 1x speed. */
export const TICKS_PER_SECOND = 5;

/** Pixels per tile in the renderer's backing tile image. Simulation never depends on pixels. */
export const TILE_PX = 16;

/** Default square world size for Milestone 0. */
export const DEFAULT_WORLD_SIZE = 160;

/** Publish a snapshot to the main thread every N ticks. */
export const SNAPSHOT_EVERY_TICKS = 5;

/** Cap on catch-up ticks per frame so a suspended tab cannot spiral. */
export const MAX_TICKS_PER_FRAME = 30;

/** Calendar: 120-day years, 4 seasons of 30 days, a day is 300 ticks (60s at 1x). */
export const TICKS_PER_DAY = 300;
export const DAYS_PER_SEASON = 30;
export const SEASONS_PER_YEAR = 4;

/** Bump when world generation output or semantics change. Part of the determinism contract. */
export const WORLD_VERSION = 2;

/** Bump when the worker<->main message protocol changes. */
export const PROTOCOL_VERSION = 6;

/** Speed multipliers offered by the HUD (0 = pause). */
export const SPEED_OPTIONS = [1, 2, 4, 8] as const;
export type SpeedOption = (typeof SPEED_OPTIONS)[number];
