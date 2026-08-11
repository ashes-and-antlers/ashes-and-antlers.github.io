import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { WORLD_VERSION } from '../../src/shared/constants';
import { Simulation } from '../../src/sim/core/sim';
import { FactionId } from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants } from '../helpers';

const cfg = (seed = 8012) => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

const THREE_DAYS_TICKS = 900;

describe('Milestone 1 vertical slice (seed vertical-slice-01 = 8012)', () => {
  it('both factions gather food, haul it home, eat, and survive 3 game days', () => {
    const sim = new Simulation(cfg());
    sim.step(THREE_DAYS_TICKS);

    const c = sim.world.components;
    const citizens = sortedQuery(query(sim.world, [c.Citizen]));
    expect(citizens.length).toBeGreaterThanOrEqual(20);

    for (const faction of [FactionId.Hearth, FactionId.IronSwarm]) {
      const alive = citizens.filter((e) => c.Faction[e] === faction).length;
      expect(alive).toBeGreaterThanOrEqual(10);
    }

    // The economy actually moved: food was gathered, delivered, and eaten.
    expect(sim.world.stats.foodGathered).toBeGreaterThan(0);
    expect(sim.world.stats.foodEaten).toBeGreaterThan(0);
    expect(sim.world.stats.tasksCompleted).toBeGreaterThan(0);
    expect(sim.world.stats.deaths).toBe(0);

    checkInvariants(sim.world);
  });

  it('is deterministic: two runs of 3 days produce identical state', () => {
    const a = new Simulation(cfg());
    const b = new Simulation(cfg());
    a.step(THREE_DAYS_TICKS);
    b.step(THREE_DAYS_TICKS);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('a wiped-out food supply creates a food alert rather than silent idling', () => {
    const sim = new Simulation(cfg());
    sim.step(60);

    const w = sim.world;
    const c = w.components;
    // Remove every food source and make everyone hungry with empty carry.
    for (const node of w.nodes) {
      c.NodeAmount[node] = 0;
      c.NodeRegenTick[node] = w.tick + 1_000_000;
    }
    for (const cc of w.commandCenters) {
      c.StockpileFood[cc] = 0;
    }
    for (const e of sortedQuery(query(w, [c.Citizen]))) {
      c.CarryFood[e] = 0;
      c.Hunger[e] = 65;
    }

    sim.step(700);

    expect(w.alertLog.some((a) => a.code === 'food.shortage')).toBe(true);
    expect(w.stats.deaths).toBeGreaterThan(0);
    checkInvariants(w);
  });
});
