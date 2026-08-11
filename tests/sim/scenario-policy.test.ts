import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { WORLD_VERSION } from '../../src/shared/constants';
import { Simulation } from '../../src/sim/core/sim';
import {
  BuildingKind,
  FactionId,
  FACTION_META,
  ItemType,
  TaskKind,
} from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants, findPlacementTile, grantStock } from '../helpers';
import {
  effectiveFactionReserve,
  factionReserve,
  factionStockCapacity,
  factionStockOf,
} from '../../src/sim/systems/inventory';

const cfg = (seed = 8012) => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

describe('Milestone 2: stockpile policy (desired reserves)', () => {
  it('defaults reserves from faction identity: food from FACTION_META, materials 0', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;

    expect(factionReserve(w, FactionId.Hearth, ItemType.Food)).toBe(
      FACTION_META[FactionId.Hearth].desiredFoodReserve,
    );
    expect(factionReserve(w, FactionId.IronSwarm, ItemType.Food)).toBe(
      FACTION_META[FactionId.IronSwarm].desiredFoodReserve,
    );
    for (const item of [ItemType.Wood, ItemType.Stone, ItemType.Planks]) {
      expect(factionReserve(w, FactionId.Hearth, item)).toBe(0);
      expect(factionReserve(w, FactionId.IronSwarm, item)).toBe(0);
    }

    // With zero material reserves and no blueprints, nothing is gathered.
    sim.step(60);
    expect(w.stats.materialsGathered).toBe(0);
    checkInvariants(w);
  });

  it(
    'gathers wood to maintain a player-set reserve, with no construction',
    { timeout: 30_000 },
    () => {
      const sim = new Simulation(cfg());
      sim.step(60);
      const w = sim.world;
      // Room to spare in the command center stockpile (starting food 20 + 20).
      grantStock(w, FactionId.Hearth, ItemType.Food, 20);

      expect(sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, 24)).toEqual({ ok: true });
      expect(factionReserve(w, FactionId.Hearth, ItemType.Wood)).toBe(24);

      // Demand raises gather orders for wood even with no construction sites
      // (the first trip cannot finish inside 2 ticks, so tasks must be live).
      sim.step(2);
      const c = w.components;
      const woodGather = sortedQuery(query(w, [c.Task])).filter(
        (t) => c.TaskKind[t] === TaskKind.GatherWood && (c.TaskState[t] ?? 0) < 4,
      );
      expect(woodGather.length).toBeGreaterThan(0);

      // Gathering continues until the reserve is met (3 carry-loads of 8).
      sim.step(2000);
      expect(w.stats.materialsGathered).toBeGreaterThanOrEqual(24);
      expect(factionStockOf(w, FactionId.Hearth, ItemType.Wood)).toBeGreaterThanOrEqual(24);
      checkInvariants(w);
    },
  );

  it('crafts planks toward a player-set reserve once a sawpit exists', { timeout: 30_000 }, () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;
    grantStock(w, FactionId.Hearth, ItemType.Food, 40);
    grantStock(w, FactionId.Hearth, ItemType.Wood, 40);

    const saw = findPlacementTile(w, FactionId.Hearth, BuildingKind.Sawpit);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Sawpit, saw.x, saw.y)).toEqual({
      ok: true,
    });
    expect(sim.setStockpileReserve(FactionId.Hearth, ItemType.Planks, 10)).toEqual({ ok: true });

    // The sawpit builds (6 wood), haulers supply its buffer, and crafting runs
    // until the stockpile holds the 10-plank reserve (2 wood per plank).
    sim.step(6000);

    expect(w.stats.crafted).toBeGreaterThanOrEqual(9);
    expect(factionStockOf(w, FactionId.Hearth, ItemType.Planks)).toBeGreaterThanOrEqual(9);
    checkInvariants(w);
  });

  it('clamps the effective reserve to stockpile capacity (unreachable targets)', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;

    // A 200-reserve is unreachable: the command center holds only 100.
    expect(
      sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, w.config.maxStockpileReserve),
    ).toEqual({ ok: true });
    // The policy keeps what the player set; demand sees the reachable target.
    expect(factionReserve(w, FactionId.Hearth, ItemType.Wood)).toBe(w.config.maxStockpileReserve);
    expect(effectiveFactionReserve(w, FactionId.Hearth, ItemType.Wood)).toBe(
      factionStockCapacity(w, FactionId.Hearth),
    );

    // Gathering tops up toward capacity — no gather → full → fail churn.
    sim.step(2000);
    expect(factionStockOf(w, FactionId.Hearth, ItemType.Wood)).toBeLessThanOrEqual(
      factionStockCapacity(w, FactionId.Hearth),
    );
    checkInvariants(w);
  });

  it('rejects invalid reserve commands deterministically, leaving policy untouched', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    const before = w.reservePolicy[FactionId.Hearth][ItemType.Wood];

    expect(sim.setStockpileReserve(99 as FactionId, ItemType.Wood, 10)).toEqual({
      ok: false,
      reason: 'bad-faction',
    });
    expect(sim.setStockpileReserve(FactionId.Hearth, 99 as ItemType, 10)).toEqual({
      ok: false,
      reason: 'bad-item',
    });
    expect(sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, -1)).toEqual({
      ok: false,
      reason: 'bad-amount',
    });
    expect(sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, 2.5)).toEqual({
      ok: false,
      reason: 'bad-amount',
    });
    expect(
      sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, w.config.maxStockpileReserve + 1),
    ).toEqual({ ok: false, reason: 'bad-amount' });

    // No side effects: the policy is untouched by every rejection.
    expect(w.reservePolicy[FactionId.Hearth][ItemType.Wood]).toBe(before);
    checkInvariants(w);
  });

  it(
    'is deterministic: same seed + reserve commands reproduce identical state',
    { timeout: 60_000 },
    () => {
      const run = (): Simulation => {
        const sim = new Simulation(cfg());
        sim.step(60);
        const w = sim.world;
        grantStock(w, FactionId.Hearth, ItemType.Food, 40);
        sim.setStockpileReserve(FactionId.Hearth, ItemType.Wood, 16);
        sim.setStockpileReserve(FactionId.IronSwarm, ItemType.Stone, 12);
        sim.step(3000);
        return sim;
      };
      const a = run();
      const b = run();
      expect(a.stateHash()).toBe(b.stateHash());
    },
  );
});
