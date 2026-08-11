import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { WORLD_VERSION } from '../../src/shared/constants';
import { seasonReserveMultiplier } from '../../src/sim/core/seasons';
import { Simulation } from '../../src/sim/core/sim';
import { FactionId, ItemType, NodeKind } from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants } from '../helpers';
import { factionStockCapacity, factionStockOf } from '../../src/sim/systems/inventory';

// Seed 1337: both factions' berry patches are reachable, so both survive the
// full year (verified: 0 deaths over 100 days). Seed 8012 is NOT viable for
// long runs — its Hearth berries sit behind water (known worldgen issue, see
// AGENTS.md) — so long seasonal scenarios must use a reachable seed.
const cfg = (seed = 1337) => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

/** Wipe every food source and put everyone hungry with empty carry (M1 pattern). */
function drainFood(sim: Simulation): void {
  const w = sim.world;
  const c = w.components;
  for (const node of w.nodes) {
    c.NodeAmount[node] = 0;
    c.NodeRegenTick[node] = w.tick + 1_000_000;
  }
  for (const cc of w.commandCenters) {
    c.Stock[ItemType.Food][cc] = 0;
  }
  for (const e of sortedQuery(query(w, [c.Citizen]))) {
    c.CarryItem[e] = 0;
    c.CarryAmount[e] = 0;
    c.Hunger[e] = 65;
  }
}

describe('Milestone 2: seasons and weather (M2 iteration 5)', () => {
  it(
    'builds a winter food buffer in autumn: the reserve target scales by the season',
    { timeout: 60_000 },
    () => {
      const sim = new Simulation(cfg());
      sim.step(17_400); // day 58, summer
      const w = sim.world;

      sim.setStockpileReserve(FactionId.Hearth, ItemType.Food, 50);
      // Autumn demand target: base reserve × 1.5, clamped to capacity (100).
      expect(seasonReserveMultiplier(w.config, 18_000)).toBe(1.5);
      expect(factionStockCapacity(w, FactionId.Hearth)).toBeGreaterThanOrEqual(75);
      const target = Math.min(factionStockCapacity(w, FactionId.Hearth), Math.round(50 * 1.5));
      expect(target).toBe(75);

      // From autumn onward the faction keeps gathering past its base reserve.
      sim.step(1_200); // through the autumn start (tick 18,000)
      const stock = factionStockOf(w, FactionId.Hearth, ItemType.Food);
      expect(stock).toBeGreaterThan(50);
      expect(stock).toBeLessThanOrEqual(factionStockCapacity(w, FactionId.Hearth));
      checkInvariants(w);
    },
  );

  it(
    'winter slows food gathering to a fraction of the warm-season rate, and every season transition is announced once',
    { timeout: 120_000 },
    () => {
      const sim = new Simulation(cfg());
      sim.step(26_400); // day 88, autumn
      const w = sim.world;
      const c = w.components;

      // Give the logistics AI room to run flat-out through both windows:
      // unbounded berry supply, huge capacity, and a reserve far beyond the
      // player-facing bound (this test deliberately bypasses the 200 cap to
      // measure raw harvest rates — checkInvariants is skipped accordingly).
      for (const node of w.nodes) {
        if (c.NodeKind[node] === NodeKind.Berries) {
          c.NodeAmount[node] = 10_000;
          c.NodeMax[node] = 10_000;
          c.NodeRegenTick[node] = -1;
        }
      }
      for (const cc of w.commandCenters) {
        c.StockpileCapacity[cc] = 5_000;
      }
      w.reservePolicy[FactionId.Hearth][ItemType.Food] = 5_000;
      w.reservePolicy[FactionId.IronSwarm][ItemType.Food] = 5_000;

      const before = w.stats.foodGathered;
      sim.step(600); // autumn tail (factor 1.1)
      const autumnRate = w.stats.foodGathered - before;
      const mid = w.stats.foodGathered;
      sim.step(600); // winter head (factor 0.4)
      const winterRate = w.stats.foodGathered - mid;

      // Walk/deliver overhead (the gatherer duty cycle) dilutes the pure yield
      // ratio (0.4/1.1 ≈ 0.36) toward ~0.8, so assert strictly-less rather than
      // a tight multiplier — the exact factor values are covered by the unit
      // tests. This still catches a removed seasonal hook (ratio → 1.0).
      expect(autumnRate).toBeGreaterThan(50);
      expect(winterRate).toBeGreaterThan(0);
      expect(winterRate).toBeLessThan(autumnRate);

      // Every season transition is a deterministic weather alert: summer at
      // 9,000, autumn at 18,000, winter at 27,000 — exactly once each, and
      // winter is a warning (severity 1) while the others are informational.
      const weather = w.alertLog.filter((a) => a.code === 'weather.season');
      expect(weather.map((a) => a.tick)).toEqual([9_000, 18_000, 27_000]);
      expect(weather.map((a) => a.severity)).toEqual([0, 0, 1]);
    },
  );

  it(
    'starvation hits sooner in winter: the cold-season hunger multiplier is a real survival pressure',
    { timeout: 120_000 },
    () => {
      const winter = new Simulation(cfg());
      winter.step(27_060); // into winter
      const spring = new Simulation(cfg());
      spring.step(1_060); // spring

      // The run-up itself must be starvation-free (both factions were fed).
      expect(winter.world.stats.deaths).toBe(0);
      expect(spring.world.stats.deaths).toBe(0);

      drainFood(winter);
      drainFood(spring);

      // From hunger 65, starving at 100 needs ~438 ticks in spring (0.08/tick)
      // but only ~337 in winter (0.104/tick). A 400-tick window separates them.
      winter.step(400);
      spring.step(400);

      expect(winter.world.stats.deaths).toBeGreaterThan(0);
      expect(winter.world.alertLog.some((a) => a.code === 'citizen.starved')).toBe(true);
      expect(spring.world.stats.deaths).toBe(0);
      checkInvariants(winter.world);
      checkInvariants(spring.world);
    },
  );

  it(
    'is deterministic across a full seasonal cycle: same seed reproduces identical state',
    { timeout: 120_000 },
    () => {
      const run = (): Simulation => {
        const sim = new Simulation(cfg());
        sim.step(30_000); // 100 days: spring -> summer -> autumn -> into winter
        return sim;
      };
      const a = run();
      const b = run();
      expect(a.stateHash()).toBe(b.stateHash());
      checkInvariants(a.world);
    },
  );
});
