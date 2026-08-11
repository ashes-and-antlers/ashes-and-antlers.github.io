import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { WORLD_VERSION } from '../../src/shared/constants';
import { Simulation } from '../../src/sim/core/sim';
import {
  BuildingKind,
  EntityKind,
  FactionId,
  ItemType,
  TaskKind,
} from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants, findPlacementTile, grantStock } from '../helpers';

const cfg = (seed = 8012) => ({
  seed,
  width: 160,
  height: 160,
  version: WORLD_VERSION,
});

import { NodeKind } from '../../src/sim/data/content';

/**
 * Hermetic setup: tree and stone nodes are drained for ~27 in-game years, so
 * the only wood/stone that exists is what the test grants (material demand can
 * never fund a site on its own). Berry nodes stay alive so food keeps flowing
 * and builders are not starved into endless failed get-food loops.
 */
function drainMaterialNodes(sim: Simulation): void {
  const c = sim.world.components;
  for (const node of sim.world.nodes) {
    if (c.NodeKind[node] !== NodeKind.Tree && c.NodeKind[node] !== NodeKind.Stone) continue;
    c.NodeAmount[node] = 0;
    c.NodeRegenTick[node] = sim.world.tick + 1_000_000;
  }
}

function blueprintByPos(sim: Simulation, x: number, y: number): number {
  const c = sim.world.components;
  return (
    sortedQuery(query(sim.world, [c.Blueprint])).find(
      (bp) => Math.floor(c.Position.x[bp] ?? -1) === x && Math.floor(c.Position.y[bp] ?? -1) === y,
    ) ?? -1
  );
}

function buildingOfKindAt(sim: Simulation, kind: BuildingKind, x: number, y: number): boolean {
  const c = sim.world.components;
  return sim.world.buildings.some(
    (b) =>
      c.BuildingKind[b] === kind &&
      Math.floor(c.Position.x[b] ?? -1) === x &&
      Math.floor(c.Position.y[b] ?? -1) === y,
  );
}

/** Map of blueprint target eid -> build task priority for live Build tasks. */
function buildTaskPriorities(sim: Simulation): Map<number, number> {
  const c = sim.world.components;
  const out = new Map<number, number>();
  for (const t of sortedQuery(query(sim.world, [c.Task]))) {
    if (c.TaskKind[t] !== TaskKind.Build) continue;
    out.set(c.TaskTarget[t] ?? -1, c.TaskPriority[t] ?? 0);
  }
  return out;
}

describe('Milestone 2: construction priorities', () => {
  it('funds and builds a high-priority site before a low-priority one', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    drainMaterialNodes(sim);

    const siteA = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, siteA.x, siteA.y, 3),
    ).toEqual({ ok: true });
    // A second legal tile must sit clear of A's footprint (findPlacementTile
    // returns the next legal site once A occupies the first).
    const siteB = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(
      Math.max(Math.abs(siteA.x - siteB.x), Math.abs(siteA.y - siteB.y)),
    ).toBeGreaterThanOrEqual(w.config.buildingFootprint);
    expect(
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, siteB.x, siteB.y, 1),
    ).toEqual({ ok: true });

    // Only enough wood for ONE stockpile (8): the priority-3 site must claim it.
    grantStock(w, FactionId.Hearth, ItemType.Wood, 8);
    sim.step(300);

    expect(buildingOfKindAt(sim, BuildingKind.Stockpile, siteA.x, siteA.y)).toBe(true);
    // B is still an untouched blueprint: no funding, no progress.
    const bpB = blueprintByPos(sim, siteB.x, siteB.y);
    expect(bpB).not.toBe(-1);
    expect(w.components.BlueprintFunded[bpB]).toBe(0);
    expect(w.components.BlueprintProgress[bpB]).toBe(0);
    expect(w.stats.buildingsCompleted).toBe(1);

    // Give the low-priority site its wood: now it funds and builds.
    grantStock(w, FactionId.Hearth, ItemType.Wood, 8);
    sim.step(300);

    expect(buildingOfKindAt(sim, BuildingKind.Stockpile, siteB.x, siteB.y)).toBe(true);
    expect(w.stats.buildingsCompleted).toBe(2);
    checkInvariants(w);
  });

  it('derives build task priority from blueprint priority', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    drainMaterialNodes(sim);

    const siteA = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, siteA.x, siteA.y, 3);
    const siteB = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, siteB.x, siteB.y, 1);

    // Fund both at once (16 wood); demand creates tasks the same tick.
    grantStock(w, FactionId.Hearth, ItemType.Wood, 16);
    sim.step(2);

    const bpA = blueprintByPos(sim, siteA.x, siteA.y);
    const bpB = blueprintByPos(sim, siteB.x, siteB.y);
    expect(bpA).not.toBe(-1);
    expect(bpB).not.toBe(-1);
    expect(w.components.BlueprintFunded[bpA]).toBe(1);
    expect(w.components.BlueprintFunded[bpB]).toBe(1);

    const priorities = buildTaskPriorities(sim);
    // buildTaskPriority(1) ± buildPriorityStep(1) per level away from normal.
    expect(priorities.get(bpA)).toBe(2);
    expect(priorities.get(bpB)).toBe(0);

    // The blueprint entities themselves carry the priority.
    expect(w.components.BlueprintPriority[bpA]).toBe(3);
    expect(w.components.BlueprintPriority[bpB]).toBe(1);
    checkInvariants(w);
  });

  it('defaults to normal priority when a placement omits it', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, site.x, site.y)).toEqual({
      ok: true,
    });
    const c = w.components;
    const bp = sortedQuery(query(w, [c.Blueprint]))[0]!;
    expect(c.BlueprintPriority[bp]).toBe(w.config.defaultBlueprintPriority);
  });

  it('rejects out-of-range priorities with a deterministic reason', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);

    for (const bad of [0, 4, 1.5, -1]) {
      expect(
        sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, site.x, site.y, bad),
      ).toEqual({ ok: false, reason: 'bad-priority' });
    }
    // Rejection leaves the world untouched: the site is still placable.
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, site.x, site.y, 3)).toEqual(
      { ok: true },
    );
    const c = w.components;
    const bp = sortedQuery(query(w, [c.Blueprint]))[0]!;
    expect(c.BlueprintPriority[bp]).toBe(3);
  });

  it('is deterministic: same seed + priority commands produce identical state', () => {
    const run = (): Simulation => {
      const sim = new Simulation(cfg());
      const w = sim.world;
      drainMaterialNodes(sim);
      const a = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, a.x, a.y, 3);
      const b = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, b.x, b.y, 1);
      grantStock(w, FactionId.Hearth, ItemType.Wood, 8);
      sim.step(300);
      grantStock(w, FactionId.Hearth, ItemType.Wood, 8);
      sim.step(300);
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.stateHash()).toBe(b.stateHash());
    // Sanity: both runs actually built the same two stockpiles.
    expect(a.world.stats.buildingsCompleted).toBe(2);
  });

  it('keeps the building kind mapping intact for priority builds', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    drainMaterialNodes(sim);
    const site = findPlacementTile(w, FactionId.Hearth, BuildingKind.Sawpit);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Sawpit, site.x, site.y, 3)).toEqual({
      ok: true,
    });
    grantStock(w, FactionId.Hearth, ItemType.Wood, 6);
    sim.step(300);
    expect(buildingOfKindAt(sim, BuildingKind.Sawpit, site.x, site.y)).toBe(true);
    const c = w.components;
    const built = w.buildings.find((b) => c.Kind[b] === EntityKind.Sawpit);
    expect(built).not.toBeUndefined();
    checkInvariants(w);
  });
});
