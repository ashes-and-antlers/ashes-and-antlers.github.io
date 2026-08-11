import { describe, expect, it } from 'vitest';
import { WORLD_VERSION } from '../../src/shared/constants';
import { calendarAt } from '../../src/sim/core/calendar';
import { Simulation } from '../../src/sim/core/sim';
import type { WorldGenConfig } from '../../src/sim/world/world';

const config = (seed: number): WorldGenConfig => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

describe('Simulation', () => {
  it('is deterministic across instances with the same seed', () => {
    const a = new Simulation(config(1337));
    const b = new Simulation(config(1337));
    a.step(100);
    b.step(100);
    expect(a.terrainHash()).toBe(b.terrainHash());
    expect(a.signal).toBe(b.signal);
    expect(a.tick).toBe(100);
  });

  it('advances exactly the requested number of ticks', () => {
    const sim = new Simulation(config(1));
    sim.step(3);
    expect(sim.tick).toBe(3);
    sim.step(7);
    expect(sim.tick).toBe(10);
  });

  it('differs across seeds', () => {
    const a = new Simulation(config(1));
    const b = new Simulation(config(2));
    expect(a.terrainHash()).not.toBe(b.terrainHash());
  });

  it('calendar() matches the pure calendar function after stepping', () => {
    const sim = new Simulation(config(1));
    sim.step(310);
    expect(sim.calendar()).toEqual(calendarAt(310));
  });
});

describe('calendarAt', () => {
  it('computes the calendar from ticks', () => {
    expect(calendarAt(0)).toEqual({ day: 1, season: 1, year: 1 });
    expect(calendarAt(299)).toEqual({ day: 1, season: 1, year: 1 });
    expect(calendarAt(300)).toEqual({ day: 2, season: 1, year: 1 });
    expect(calendarAt(35999)).toEqual({ day: 120, season: 4, year: 1 });
    expect(calendarAt(36000)).toEqual({ day: 121, season: 1, year: 2 });
  });
});
