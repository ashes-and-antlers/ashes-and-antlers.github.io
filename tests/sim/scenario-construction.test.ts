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
  TaskState,
} from '../../src/sim/data/content';
import { sortedQuery } from '../../src/sim/ecs/world';
import { checkInvariants, findPlacementTile, grantStock } from '../helpers';
import { canPlaceBlueprint } from '../../src/sim/systems/construction';
import { factionStockOf } from '../../src/sim/systems/inventory';
import type { TileWorld } from '../../src/sim/world/world';

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

/** A legal placement tile whose goal ring holds no citizen (deterministic). */
function findIsolatedPlacementTile(sim: Simulation, tiles: TileWorld): { x: number; y: number } {
  const c = sim.world.components;
  const candidates: { x: number; y: number }[] = [];
  const cc = sim.world.commandCenters.find((e) => c.Faction[e] === FactionId.Hearth);
  if (cc === undefined) throw new Error('no hearth cc');
  const bx = Math.floor(c.Position.x[cc] ?? 0);
  const by = Math.floor(c.Position.y[cc] ?? 0);
  const r = sim.world.config.claimRadius;
  const occupiedByCitizen = (x: number, y: number): boolean =>
    sortedQuery(query(sim.world, [c.Citizen])).some(
      (e) => Math.floor(c.Position.x[e] ?? -99) === x && Math.floor(c.Position.y[e] ?? -99) === y,
    );
  for (let y = by - r; y <= by + r; y++) {
    for (let x = bx - r; x <= bx + r; x++) {
      if (canPlaceBlueprint(sim.world, FactionId.Hearth, BuildingKind.Stockpile, x, y) !== null) {
        continue;
      }
      const goalRing: readonly (readonly [number, number])[] = [
        [x - 1, y],
        [x + 3, y],
        [x, y - 1],
        [x, y + 3],
        [x - 1, y + 1],
        [x + 3, y + 1],
      ];
      const clear = goalRing.every(([gx, gy]) => !occupiedByCitizen(gx, gy));
      if (clear && tiles.isInside(x, y)) {
        candidates.push({ x, y });
      }
    }
  }
  const first = candidates[0];
  if (first === undefined) {
    throw new Error('no isolated placement tile');
  }
  return first;
}

describe('Milestone 1b: blueprints and construction', () => {
  it('builds a player-placed stockpile and hut exactly once', () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;
    const c = w.components;

    const stock = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, stock.x, stock.y)).toEqual({
      ok: true,
    });
    const hut = findPlacementTile(w, FactionId.Hearth, BuildingKind.Hut);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Hut, hut.x, hut.y)).toEqual({
      ok: true,
    });

    // Two construction sites exist.
    expect(blueprints(sim)).toHaveLength(2);

    // M2: construction consumes materials — grant the costs so the sites fund.
    grantStock(w, FactionId.Hearth, ItemType.Wood, 8); // stockpile
    grantStock(w, FactionId.Hearth, ItemType.Planks, 8); // hut
    grantStock(w, FactionId.Hearth, ItemType.Stone, 6); // hut

    // Run until both are finished (walk + 10 ticks of work each; wide margin).
    sim.step(600);

    expect(blueprints(sim)).toHaveLength(0);
    const stockpiles = buildingsOfKind(sim, BuildingKind.Stockpile);
    const huts = buildingsOfKind(sim, BuildingKind.Hut);
    expect(stockpiles).toHaveLength(1);
    expect(huts).toHaveLength(1);

    const sp = stockpiles[0]!;
    expect(c.Faction[sp]).toBe(FactionId.Hearth);
    expect(c.Kind[sp]).toBe(EntityKind.Stockpile);
    expect(Math.floor(c.Position.x[sp] ?? 0)).toBe(stock.x);
    expect(Math.floor(c.Position.y[sp] ?? 0)).toBe(stock.y);
    // A stockpile stores food like the command center does.
    expect(c.StockpileCapacity[sp]).toBe(w.config.stockpileCapacity);

    const ht = huts[0]!;
    expect(c.Faction[ht]).toBe(FactionId.Hearth);
    expect(c.Kind[ht]).toBe(EntityKind.Hut);

    // Exactly two completions, and the causal alert fired.
    expect(w.stats.buildingsCompleted).toBe(2);
    expect(w.alertLog.some((a) => a.code === 'construction.complete')).toBe(true);

    checkInvariants(w);
  });

  it('is deterministic: same seed + commands produce identical state', () => {
    const run = (): Simulation => {
      const sim = new Simulation(cfg());
      sim.step(60);
      const w = sim.world;
      const stock = findPlacementTile(w, FactionId.Hearth, BuildingKind.Stockpile);
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, stock.x, stock.y);
      const hut = findPlacementTile(w, FactionId.Hearth, BuildingKind.Hut);
      sim.placeBlueprint(FactionId.Hearth, BuildingKind.Hut, hut.x, hut.y);
      grantStock(w, FactionId.Hearth, ItemType.Wood, 8);
      grantStock(w, FactionId.Hearth, ItemType.Planks, 8);
      grantStock(w, FactionId.Hearth, ItemType.Stone, 6);
      sim.step(600);
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('rejects invalid placements with a deterministic reason', () => {
    const sim = new Simulation(cfg());
    sim.step(60);
    const w = sim.world;
    const c = w.components;

    // Building kind must be a player-placed building.
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.CommandCenter, 10, 10).ok).toBe(false);

    // Inside a command-center footprint: occupied.
    const cc = w.commandCenters[0]!;
    const bx = Math.floor(c.Position.x[cc] ?? 0);
    const by = Math.floor(c.Position.y[cc] ?? 0);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, bx, by)).toEqual({
      ok: false,
      reason: 'occupied',
    });

    // Far from the faction's claim radius: outside-claim.
    const far = sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, 4, 4);
    expect(far.ok).toBe(false);
    if (!far.ok) expect(['outside-claim', 'out-of-bounds', 'terrain']).toContain(far.reason);

    // On water: terrain.
    let waterTile: number | null = null;
    for (let t = 0; t < w.tiles.tileCount; t++) {
      if ((w.tiles.movementCost[t] ?? 0) >= 75) {
        waterTile = t;
        break;
      }
    }
    expect(waterTile).not.toBeNull();
    const wx = waterTile! % w.tiles.width;
    const wy = Math.floor(waterTile! / w.tiles.width);
    const water = sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, wx, wy);
    expect(water.ok).toBe(false);
    if (!water.ok) expect(['terrain', 'out-of-bounds']).toContain(water.reason);

    // Blueprint cap per faction: every site that was legal before the cap must
    // be rejected with max-blueprints once the cap is reached.
    const iron = w.commandCenters.find((e) => c.Faction[e] === FactionId.IronSwarm)!;
    const ibx = Math.floor(c.Position.x[iron] ?? 0);
    const iby = Math.floor(c.Position.y[iron] ?? 0);
    // Collect legal sites with no mutual footprint overlap (a placement must
    // not invalidate the next one).
    const sites: { x: number; y: number }[] = [];
    for (let y = iby - w.config.claimRadius; y <= iby + w.config.claimRadius; y++) {
      for (let x = ibx - w.config.claimRadius; x <= ibx + w.config.claimRadius; x++) {
        if (canPlaceBlueprint(w, FactionId.IronSwarm, BuildingKind.Hut, x, y) !== null) continue;
        const f = w.config.buildingFootprint;
        const overlaps = sites.some((s) => Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) < f);
        if (!overlaps) {
          sites.push({ x, y });
        }
      }
    }
    expect(sites.length).toBeGreaterThan(w.config.maxBlueprintsPerFaction);
    for (let i = 0; i < w.config.maxBlueprintsPerFaction; i++) {
      const t = sites[i]!;
      expect(sim.placeBlueprint(FactionId.IronSwarm, BuildingKind.Hut, t.x, t.y).ok).toBe(true);
    }
    // sites[max] passed every check before the cap; now only the cap rejects it.
    const capped = sites[w.config.maxBlueprintsPerFaction]!;
    expect(sim.placeBlueprint(FactionId.IronSwarm, BuildingKind.Hut, capped.x, capped.y)).toEqual({
      ok: false,
      reason: 'max-blueprints',
    });
  });

  it('an unreachable site fails once and demand respects the retry cooldown', () => {
    const sim = new Simulation(cfg());
    const w = sim.world;
    const c = w.components;

    // Hermetic setup: remove every food source so the only task on the market
    // is the build task (no gather noise to confound the failure count).
    for (const node of w.nodes) {
      c.NodeAmount[node] = 0;
      c.NodeRegenTick[node] = w.tick + 1_000_000;
    }

    // A site whose goal ring has no citizen on it (deterministic for this seed).
    const t = findIsolatedPlacementTile(sim, w.tiles);
    expect(sim.placeBlueprint(FactionId.Hearth, BuildingKind.Stockpile, t.x, t.y).ok).toBe(true);
    const bp = blueprints(sim)[0]!;

    // Grant the wood so demand funds the site before the ring is blocked.
    grantStock(w, FactionId.Hearth, ItemType.Wood, 8);

    // Block every walkable tile adjacent to the footprint: unreachable.
    const f = w.config.buildingFootprint;
    const ring: readonly (readonly [number, number])[] = [
      [t.x - 1, t.y],
      [t.x + f, t.y],
      [t.x, t.y - 1],
      [t.x, t.y + f],
      [t.x - 1, t.y + 1],
      [t.x + f, t.y + 1],
    ];
    for (const [x, y] of ring) {
      w.tiles.movementCost[w.tiles.index(x, y)] = 100;
    }

    sim.step(40);

    // The task failed exactly once and the blueprint recorded the failure…
    expect(w.stats.tasksFailed).toBe(1);
    expect(c.BlueprintFailTick[bp]).toBeGreaterThanOrEqual(0);
    // …the consumed materials were refunded (M2: no lost resources).
    expect(c.BlueprintFunded[bp]).toBe(0);
    expect(factionStockOf(w, FactionId.Hearth, ItemType.Wood)).toBe(8);
    // …demand is in cooldown, so no active build task, no progress, site intact.
    const active = sortedQuery(query(w, [c.Task])).filter(
      (task) =>
        c.TaskKind[task] === TaskKind.Build &&
        (c.TaskState[task] === TaskState.Claimable || c.TaskState[task] === TaskState.Reserved),
    );
    expect(active).toHaveLength(0);
    expect(c.BlueprintProgress[bp]).toBe(0);

    // Once the cooldown elapses, demand tries again (and fails again).
    sim.step(100);
    expect(w.stats.tasksFailed).toBeGreaterThanOrEqual(2);
    expect(c.BlueprintProgress[bp]).toBe(0);
    checkInvariants(w);
  });
});
