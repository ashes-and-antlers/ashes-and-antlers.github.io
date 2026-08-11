import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { WORLD_VERSION } from '../../src/shared/constants';
import { Simulation } from '../../src/sim/core/sim';
import {
  BuildingKind,
  FactionId,
  ItemType,
  NodeKind,
  TaskKind,
  TaskState,
} from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants, findPlacementTile, grantStock } from '../helpers';
import { factionStockOf } from '../../src/sim/systems/inventory';

const cfg = (seed = 8012) => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

function blueprints(sim: Simulation): number[] {
  return sortedQuery(query(sim.world, [sim.world.components.Blueprint]));
}

function buildingsOfKind(sim: Simulation, kind: BuildingKind): number[] {
  const c = sim.world.components;
  return sim.world.buildings.filter((b) => c.BuildingKind[b] === kind);
}

describe('Milestone 2: the construction material chain', () => {
  it('harvests wood, stocks it, and funds a player-placed stockpile', { timeout: 30_000 }, () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;

    // Nothing is gathered until a blueprint needs it.
    expect(w.stats.materialsGathered).toBe(0);

    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, site.x, site.y)).toEqual({
      ok: true,
    });

    // The site starts unfunded while the first wood is still in transit.
    sim.step(40);
    const bp = blueprints(sim)[0]!;
    expect(w.components.BlueprintFunded[bp]).toBe(0);

    // The AI gathers 8 wood, delivers it, funds the site, and builds it.
    sim.step(2000);
    expect(w.stats.materialsGathered).toBeGreaterThanOrEqual(8);
    expect(blueprints(sim)).toHaveLength(0);
    expect(buildingsOfKind(sim, BuildingKind.Stockpile)).toHaveLength(1);
    expect(w.stats.buildingsCompleted).toBe(1);
    // The cost was consumed from stock: gathered minus stored is at least the
    // 8 wood the site consumed (over-gatherers may have delivered more after).
    const consumed = w.stats.materialsGathered - factionStockOf(w, FactionId.Hearth, ItemType.Wood);
    expect(consumed).toBeGreaterThanOrEqual(8);
    checkInvariants(w);
  });

  it(
    'builds a hut through the sawpit: wood -> supply -> planks (craft) + stone -> hut',
    { timeout: 30_000 },
    () => {
      const sim = new Simulation(cfg());
      sim.step(60);
      const w = sim.world;
      // De-risk food for the long run: plenty of food so the chain never stalls.
      grantStock(w, FactionId.Hearth, ItemType.Food, 80);

      // The work building comes first: planks can only be crafted at a sawpit.
      const saw = findPlacementTile(w, FactionId.Hearth, BuildingKind.Sawpit);
      expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Sawpit, saw.x, saw.y)).toEqual({
        ok: true,
      });
      const hut = findPlacementTile(w, FactionId.Hearth, BuildingKind.Hut);
      expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Hut, hut.x, hut.y)).toEqual({
        ok: true,
      });

      // 6 wood builds the sawpit; 8 planks need 16 wood through 8 craft batches
      // supplied into the sawpit buffer; the hut also needs 6 stone.
      sim.step(9000);

      expect(blueprints(sim)).toHaveLength(0);
      expect(buildingsOfKind(sim, BuildingKind.Sawpit)).toHaveLength(1);
      expect(buildingsOfKind(sim, BuildingKind.Hut)).toHaveLength(1);
      expect(w.stats.buildingsCompleted).toBe(2);
      expect(w.stats.crafted).toBeGreaterThanOrEqual(8); // 8 plank batches
      expect(w.stats.materialsGathered).toBeGreaterThanOrEqual(6); // stone
      // The crafted planks were consumed by the hut (not left in the buffer).
      expect(factionStockOf(w, FactionId.Hearth, ItemType.Planks)).toBeLessThan(8);
      checkInvariants(w);
    },
  );

  it('a hut without a sawpit waits: no crafting, no plank wood gathered', () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;
    const c = w.components;

    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Hut);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Hut, site.x, site.y)).toEqual({
      ok: true,
    });

    // The hut needs planks, but with no sawpit nothing can produce them — and
    // because crafting is impossible, the AI does not waste labor gathering
    // plank wood. (Stone is still gathered: the hut needs it directly.)
    sim.step(800);
    const bp = blueprints(sim)[0]!;
    expect(c.BlueprintFunded[bp]).toBe(0);
    expect(w.stats.crafted).toBe(0);
    expect(factionStockOf(w, FactionId.Hearth, ItemType.Wood)).toBe(0);
    const craftTasks = sortedQuery(query(w, [c.Task])).filter(
      (t) => c.TaskKind[t] === TaskKind.Craft,
    );
    expect(craftTasks).toHaveLength(0);
    checkInvariants(w);
  });

  it('waits unfunded without materials, then builds once wood arrives', { timeout: 30_000 }, () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;
    const c = w.components;

    // Remove every harvestable node so no material can ever arrive.
    for (const node of w.nodes) {
      c.NodeAmount[node] = 0;
      c.NodeRegenTick[node] = w.tick + 1_000_000;
    }
    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, site.x, site.y)).toEqual({
      ok: true,
    });

    sim.step(120);
    const bp = blueprints(sim)[0]!;
    expect(c.BlueprintFunded[bp]).toBe(0);
    const activeBuilds = sortedQuery(query(w, [c.Task])).filter(
      (t) =>
        c.TaskKind[t] === TaskKind.Build &&
        (c.TaskState[t] === TaskState.Claimable || c.TaskState[t] === TaskState.Reserved),
    );
    expect(activeBuilds).toHaveLength(0);
    expect(c.BlueprintProgress[bp]).toBe(0);

    // A tree appears: demand funds the site and a builder finishes it.
    const tree = w.nodes.find((n) => c.NodeKind[n] === NodeKind.Tree);
    expect(tree).toBeDefined();
    c.NodeAmount[tree!] = 40;
    c.NodeRegenTick[tree!] = -1;

    sim.step(2500);
    expect(blueprints(sim)).toHaveLength(0);
    expect(buildingsOfKind(sim, BuildingKind.Stockpile)).toHaveLength(1);
    checkInvariants(w);
  });

  it(
    'is deterministic: same seed + commands reproduce identical state',
    { timeout: 60_000 },
    () => {
      const run = (): Simulation => {
        const sim = new Simulation(cfg());
        sim.step(60);
        const w = sim.world;
        grantStock(w, FactionId.Hearth, ItemType.Food, 80);
        const saw = findPlacementTile(w, FactionId.Hearth, BuildingKind.Sawpit);
        sim.placeBlueprint(FactionId.Hearth, BuildingKind.Sawpit, saw.x, saw.y);
        const hut = findPlacementTile(w, FactionId.Hearth, BuildingKind.Hut);
        sim.placeBlueprint(FactionId.Hearth, BuildingKind.Hut, hut.x, hut.y);
        sim.step(6000);
        return sim;
      };
      const a = run();
      const b = run();
      expect(a.stateHash()).toBe(b.stateHash());
    },
  );
});
