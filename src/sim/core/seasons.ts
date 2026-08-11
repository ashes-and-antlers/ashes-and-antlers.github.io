import type { SimConfig } from '../data/config';
import { calendarAt } from './calendar';

/**
 * Seasonal modifiers (M2 iteration 5). Seasons are a pure function of the
 * tick — the calendar is fixed (30-day seasons, 120-day years) — so every
 * seasonal value is deterministic and needs no simulation state, no PRNG
 * stream, and no protocol change (the calendar already travels in every
 * snapshot). All tuning lives in SIM_CONFIG; these helpers only index it.
 *
 * Season 1 = Spring, 2 = Summer, 3 = Autumn, 4 = Winter.
 */

/** 0-based season index for a tick (0 = Spring). */
export function seasonIndexAt(tick: number): number {
  return calendarAt(tick).season - 1;
}

/** Food gather yield multiplier for the tick's season. */
export function seasonGatherFactor(config: SimConfig, tick: number): number {
  return config.seasonGatherFactor[seasonIndexAt(tick)];
}

/** Hunger growth multiplier for the tick's season (winter cold). */
export function seasonHungerFactor(config: SimConfig, tick: number): number {
  return config.seasonHungerFactor[seasonIndexAt(tick)];
}

/**
 * Food reserve multiplier the logistics AI targets going into winter: in
 * autumn the effective reserve is scaled up (a 50-reserve stockpiles toward
 * 75), giving the faction a buffer to draw down when winter gather slows.
 */
export function seasonReserveMultiplier(config: SimConfig, tick: number): number {
  return config.seasonReserveMultiplier[seasonIndexAt(tick)];
}

/** Renewable regrowth multiplier for the tick's season (0 in winter). */
export function seasonRegenFactor(config: SimConfig, tick: number): number {
  return config.seasonRegenFactor[seasonIndexAt(tick)];
}
