import { describe, expect, it } from 'vitest';
import { SIM_CONFIG } from '../../src/sim/data/config';
import {
  seasonGatherFactor,
  seasonHungerFactor,
  seasonIndexAt,
  seasonRegenFactor,
  seasonReserveMultiplier,
} from '../../src/sim/core/seasons';

describe('seasons (deterministic tick-derived factors)', () => {
  it('maps tick boundaries to season indexes (30-day seasons, spring first)', () => {
    expect(seasonIndexAt(0)).toBe(0); // day 1, spring
    expect(seasonIndexAt(8999)).toBe(0); // day 30, spring
    expect(seasonIndexAt(9000)).toBe(1); // day 31, summer
    expect(seasonIndexAt(17999)).toBe(1); // day 60, summer
    expect(seasonIndexAt(18000)).toBe(2); // day 61, autumn
    expect(seasonIndexAt(26999)).toBe(2); // day 90, autumn
    expect(seasonIndexAt(27000)).toBe(3); // day 91, winter
    expect(seasonIndexAt(35999)).toBe(3); // day 120, winter
    expect(seasonIndexAt(36000)).toBe(0); // day 121, year 2 spring again
  });

  it('applies the SIM_CONFIG seasonal factors per season', () => {
    const cfg = SIM_CONFIG;
    expect(seasonGatherFactor(cfg, 0)).toBe(cfg.seasonGatherFactor[0]); // spring 1.0
    expect(seasonGatherFactor(cfg, 9000)).toBe(cfg.seasonGatherFactor[1]); // summer 1.2
    expect(seasonGatherFactor(cfg, 18000)).toBe(cfg.seasonGatherFactor[2]); // autumn 1.1
    expect(seasonGatherFactor(cfg, 27000)).toBe(cfg.seasonGatherFactor[3]); // winter 0.4

    expect(seasonHungerFactor(cfg, 0)).toBe(1); // mild seasons, baseline hunger
    expect(seasonHungerFactor(cfg, 27000)).toBe(cfg.seasonHungerFactor[3]); // winter 1.3

    expect(seasonReserveMultiplier(cfg, 18000)).toBe(cfg.seasonReserveMultiplier[2]); // autumn 1.5
    expect(seasonReserveMultiplier(cfg, 27000)).toBe(1); // winter returns to the base reserve

    expect(seasonRegenFactor(cfg, 0)).toBe(1);
    expect(seasonRegenFactor(cfg, 27000)).toBe(0); // winter: plants lie dormant
  });
});
