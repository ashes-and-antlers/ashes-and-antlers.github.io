import { describe, expect, it } from 'vitest';
import { CitizenState, ItemType, type FactionId } from '../../src/sim/data/content';
import { firstCitizen, makeSim } from '../helpers';

describe('needs system', () => {
  it('a hungry citizen eats from their carry', () => {
    const sim = makeSim();
    const c = sim.world.components;
    const citizen = firstCitizen(sim.world);
    c.Hunger[citizen] = 80;
    c.CarryItem[citizen] = ItemType.Food;
    c.CarryAmount[citizen] = 3;
    c.Energy[citizen] = 90;
    c.TaskId[citizen] = -1;

    sim.step(1);

    expect(c.CarryAmount[citizen]).toBe(2);
    expect(c.Hunger[citizen]).toBeLessThan(80);
    expect(sim.world.stats.foodEaten).toBe(1);
  });

  it('a citizen with no food starves at hunger 100', () => {
    const sim = makeSim();
    const c = sim.world.components;
    const citizen = firstCitizen(sim.world);
    const faction = c.Faction[citizen] as FactionId;
    // Remove all food so no GetFood task can save them.
    for (const cc of sim.world.commandCenters) {
      if (c.Faction[cc] === faction) {
        c.Stock[ItemType.Food][cc] = 0;
      }
    }
    for (const node of sim.world.nodes) {
      c.NodeAmount[node] = 0;
      c.NodeRegenTick[node] = 1_000_000;
    }
    c.Hunger[citizen] = 99.9;
    c.CarryItem[citizen] = 0;
    c.CarryAmount[citizen] = 0;
    c.Energy[citizen] = 90;
    c.TaskId[citizen] = -1;

    sim.step(20);

    expect(sim.world.stats.deaths).toBeGreaterThanOrEqual(1);
  });

  it('exhausted citizens rest and recover energy before resuming work', () => {
    const sim = makeSim();
    const c = sim.world.components;
    const citizen = firstCitizen(sim.world);
    c.Energy[citizen] = 10;
    c.Hunger[citizen] = 5;
    c.TaskId[citizen] = -1;

    sim.step(1);
    expect(c.CitizenState[citizen]).toBe(CitizenState.Resting);

    // Rests until resumeWorkAt (60), which takes 1000 ticks at 0.05/tick.
    sim.step(1000);
    expect(c.Energy[citizen]).toBeGreaterThan(50);
    expect(c.Energy[citizen]).toBeLessThanOrEqual(70);
  });
});
