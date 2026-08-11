import { query } from 'bitecs';
import { WORLD_VERSION } from '../src/shared/constants';
import { Simulation } from '../src/sim/core/sim';
import {
  BuildingKind,
  ITEM_TYPES,
  TaskKind,
  type FactionId,
  type ItemType,
} from '../src/sim/data/content';
import { sortedQuery, type SimWorld } from '../src/sim/ecs/world';
import { canPlaceBlueprint } from '../src/sim/systems/construction';
import { factionStockpiles, stockRoom } from '../src/sim/systems/inventory';

export interface SimConfigLike {
  seed: number;
  width: number;
  height: number;
}

export function makeSim(config?: Partial<SimConfigLike>): Simulation {
  return new Simulation({
    seed: config?.seed ?? 8012,
    width: config?.width ?? 64,
    height: config?.height ?? 64,
    version: WORLD_VERSION,
  });
}

export function firstCitizen(world: SimWorld): number {
  const eids = sortedQuery(query(world, [world.components.Citizen]));
  const first = eids[0];
  if (first === undefined) {
    throw new Error('no citizens in world');
  }
  return first;
}

export function aliveCitizens(world: SimWorld): number {
  return sortedQuery(query(world, [world.components.Citizen])).length;
}

export function aliveByFaction(world: SimWorld, faction: FactionId): number {
  const c = world.components;
  return sortedQuery(query(world, [c.Citizen])).filter((e) => c.Faction[e] === faction).length;
}

/**
 * First tile (row-major from the faction command center outward) where a
 * blueprint of `kind` may legally be placed. Deterministic for a fixed seed.
 */
export function findPlacementTile(
  world: SimWorld,
  faction: FactionId,
  kind: BuildingKind = BuildingKind.Stockpile,
): { x: number; y: number } {
  const c = world.components;
  const cc = world.commandCenters.find((e) => c.Faction[e] === faction);
  if (cc === undefined) {
    throw new Error(`no command center for faction ${faction}`);
  }
  const bx = Math.floor(c.Position.x[cc] ?? 0);
  const by = Math.floor(c.Position.y[cc] ?? 0);
  const r = world.config.claimRadius;
  for (let y = by - r; y <= by + r; y++) {
    for (let x = bx - r; x <= bx + r; x++) {
      if (canPlaceBlueprint(world, faction, kind, x, y) === null) {
        return { x, y };
      }
    }
  }
  throw new Error(`no valid placement tile near (${bx}, ${by})`);
}

/** Add material straight into a faction's stockpiles (spawn order). */
export function grantStock(
  world: SimWorld,
  faction: FactionId,
  item: ItemType,
  amount: number,
): void {
  const c = world.components;
  const stockpiles = factionStockpiles(world, faction);
  const first = stockpiles[0];
  if (first === undefined) throw new Error(`no stockpile for faction ${faction}`);
  const put = Math.min(amount, stockRoom(world, first));
  c.Stock[item][first] = (c.Stock[item][first] ?? 0) + put;
  if (put < amount) throw new Error('grantStock: no room in the first stockpile');
}

/** Assert simulation invariants; any violation fails the test. */
export function checkInvariants(world: SimWorld): void {
  const c = world.components;
  const claimedByTask = new Map<number, number>();
  for (const e of sortedQuery(query(world, [c.Citizen]))) {
    if ((c.CarryAmount[e] ?? 0) < 0) {
      throw new Error(`citizen ${e} has negative carry`);
    }
    if ((c.CarryAmount[e] ?? 0) === 0 && (c.CarryItem[e] ?? 0) !== 0) {
      throw new Error(`citizen ${e} has a stale carry item with nothing carried`);
    }
    if ((c.CarryAmount[e] ?? 0) > 0 && !ITEM_TYPES.includes(c.CarryItem[e] ?? 0)) {
      throw new Error(`citizen ${e} carries amount with an invalid item type`);
    }
    const task = c.TaskId[e] ?? -1;
    if (task !== -1) {
      if ((c.TaskClaimedBy[task] ?? -1) !== e) {
        throw new Error(`citizen ${e} references task ${task} not claimed by them`);
      }
      if (claimedByTask.has(task)) {
        throw new Error(`task ${task} claimed by multiple citizens`);
      }
      claimedByTask.set(task, e);
    }
  }
  for (const t of sortedQuery(query(world, [c.Task]))) {
    const state = c.TaskState[t] ?? 0;
    const worker = c.TaskClaimedBy[t] ?? -1;
    if ((state === 2 || state === 3) && worker === -1) {
      throw new Error(`active task ${t} has no worker`);
    }
    if ((state === 4 || state === 5 || state === 6) && worker !== -1) {
      throw new Error(`terminal task ${t} still claims a worker`);
    }
    if ((c.TaskKind[t] ?? 0) === TaskKind.Supply && (c.TaskSource[t] ?? -1) === -1) {
      throw new Error(`supply task ${t} has no source building`);
    }
  }
  for (const b of world.buildings) {
    const capacity = c.StockpileCapacity[b] ?? 0;
    let used = 0;
    for (const item of ITEM_TYPES) {
      const amount = c.Stock[item][b] ?? 0;
      if (amount < 0) {
        throw new Error(`building ${b} has negative ${item} stock`);
      }
      used += amount;
    }
    if (used > capacity) {
      throw new Error(`stockpile ${b} over capacity: ${used}/${capacity}`);
    }
  }
  for (const n of world.nodes) {
    const amount = c.NodeAmount[n] ?? 0;
    const max = c.NodeMax[n] ?? 0;
    if (amount < 0 || amount > max) {
      throw new Error(`node ${n} amount out of bounds: ${amount}/${max}`);
    }
  }
  for (const bp of sortedQuery(query(world, [c.Blueprint]))) {
    const progress = c.BlueprintProgress[bp] ?? 0;
    if (progress < 0) {
      throw new Error(`blueprint ${bp} has negative progress`);
    }
    const reserved = c.BlueprintReservedBy[bp] ?? -1;
    if (reserved !== -1) {
      const workerTask = c.TaskId[reserved] ?? -1;
      if (workerTask === -1) {
        throw new Error(`blueprint ${bp} reserved by ${reserved} with no task`);
      }
      if (c.TaskKind[workerTask] !== TaskKind.Build || c.TaskTarget[workerTask] !== bp) {
        throw new Error(`blueprint ${bp} reservation not backed by its build task`);
      }
    }
  }
}
