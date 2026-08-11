import { DAYS_PER_SEASON, SEASONS_PER_YEAR, TICKS_PER_DAY } from '../../shared/constants';
import type { Calendar } from '../../shared/protocol';

/** Pure tick -> calendar mapping (120-day years, 4 seasons of 30 days). */
export function calendarAt(tick: number): Calendar {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const season =
    Math.floor(((day - 1) % (DAYS_PER_SEASON * SEASONS_PER_YEAR)) / DAYS_PER_SEASON) + 1;
  const year = Math.ceil(day / (DAYS_PER_SEASON * SEASONS_PER_YEAR));
  return { day, season, year };
}
