import { entityExists, query } from 'bitecs';
import {
  BuildingKind,
  CitizenState,
  FACTIONS,
  ItemType,
  NodeKind,
  RecipeKind,
  TaskFailReason,
  TaskKind,
  TaskPhase,
  TaskState,
  type FactionId,
  type ItemCost,
} from '../data/content';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { completeTask, createTask, failTask, isActiveTaskState } from './taskops';
import {
  addStock,
  adjacentGoal,
  clearCarry,
  effectiveFactionReserve,
  factionStockOf,
  factionStockpiles,
  factionStockRoom,
  isNodeInsideFootprint,
  nearestStockpileWithRoom,
  removeStock,
  stockAt,
  stockRoom,
} from './inventory';

/**
 * Materials economy (Milestone 2): the construction chain through work
 * buildings.
 *
 * Demand (construction-priority + stockpile-policy driven — nothing is
 * gathered until a blueprint needs it or the player sets a reserve):
 * - GatherWood/GatherStone when unfunded sites need wood/stone (or wood for
 *   crafting planks at a sawpit) and the faction's stockpiles are short.
 * - Supply: haulers move wood from stockpiles into a sawpit's input buffer
 *   and carry crafted planks from its output back to stockpiles (plan §3.4:
 *   a bakery cannot bake with flour on the other side of the map).
 * - Craft: a worker works the planks recipe at a sawpit that holds input
 *   wood; one active craft per sawpit; inputs are consumed only when the
 *   batch completes, producing into the sawpit's output buffer.
 * - Haul: an idle citizen carrying non-food material delivers it to a
 *   stockpile with room (rescues stranded carry after a full-stockpile
 *   failure).
 *
 * Execution: GatherFood/GatherWood/GatherStone share one walk -> work ->
 * walk-to-deliver -> deliver flow; the carried item derives from the node
 * kind. Craft works at the station. Supply is walk-to-source -> fetch ->
 * walk-to-dest -> deliver. Haul deposits the carried item at its target.
 *
 * Read: Blueprint*, Stock*, Node*, Task*, Carry*. Write: Stock*, Node*,
 * Carry*, Task*, stats.
 */

/** Aggregate material need of a faction's unfunded construction sites. */
export function materialNeed(world: SimWorld, faction: FactionId): Record<ItemType, number> {
  const c = world.components;
  const need: Record<ItemType, number> = {
    [ItemType.Food]: 0,
    [ItemType.Wood]: 0,
    [ItemType.Stone]: 0,
    [ItemType.Planks]: 0,
  };
  for (const bp of sortedQuery(query(world, [c.Blueprint]))) {
    if (c.Faction[bp] !== faction) continue;
    if ((c.BlueprintFunded[bp] ?? 0) === 1) continue;
    for (const line of costOfKind(world, c.BlueprintKind[bp] ?? 0)) {
      need[line.item] += line.amount;
    }
  }
  return need;
}

function costOfKind(world: SimWorld, kind: number): ItemCost[] {
  return world.config.constructionCosts[kind as keyof typeof world.config.constructionCosts] ?? [];
}

/** Create the M2 material task orders: gather, supply, craft, haul. */
export function runMaterialDemand(world: SimWorld): void {
  for (const faction of FACTIONS) {
    runGatherDemand(world, faction);
    runSupplyDemand(world, faction);
    runCraftDemand(world, faction);
  }
  runHaulDemand(world);
}

// ---------------------------------------------------------------------------
// Gather demand
// ---------------------------------------------------------------------------

function runGatherDemand(world: SimWorld, faction: FactionId): void {
  const c = world.components;
  const need = materialNeed(world, faction);
  const recipe = world.config.recipes[RecipeKind.Planks];
  // Planks are only crafted when a sawpit exists to do the work (a hut
  // without a workshop simply waits — the inspector shows why). Crafting runs
  // toward the greater of the construction need and the plank reserve.
  const planksTarget = Math.max(
    need[ItemType.Planks],
    effectiveFactionReserve(world, faction, ItemType.Planks),
  );
  const hasSawpit = world.buildings.some(
    (b) => c.Faction[b] === faction && c.BuildingKind[b] === BuildingKind.Sawpit,
  );
  const craftWood =
    recipe !== undefined && hasSawpit
      ? Math.max(0, planksTarget - factionStockOf(world, faction, ItemType.Planks)) *
        (recipe.input[0]?.amount ?? 0)
      : 0;

  // Gather wood/stone toward the greater of the construction need and the
  // faction's stockpile reserve (policy). With both at 0, nothing is gathered.
  const woodTarget = Math.max(
    need[ItemType.Wood] + craftWood,
    effectiveFactionReserve(world, faction, ItemType.Wood),
  );
  const stoneTarget = Math.max(
    need[ItemType.Stone],
    effectiveFactionReserve(world, faction, ItemType.Stone),
  );
  if (factionStockOf(world, faction, ItemType.Wood) < woodTarget) {
    const deficit = woodTarget - factionStockOf(world, faction, ItemType.Wood);
    queueGather(world, faction, NodeKind.Tree, ItemType.Wood, deficit, woodTarget);
  }
  if (factionStockOf(world, faction, ItemType.Stone) < stoneTarget) {
    const deficit = stoneTarget - factionStockOf(world, faction, ItemType.Stone);
    queueGather(world, faction, NodeKind.Stone, ItemType.Stone, deficit, stoneTarget);
  }
}

function queueGather(
  world: SimWorld,
  faction: FactionId,
  nodeKind: NodeKind,
  item: ItemType,
  deficit: number,
  need: number,
): void {
  const c = world.components;
  const config = world.config;
  if (factionStockRoom(world, faction) <= 0) return; // nowhere to put it yet
  let queued = 0;
  while (queued < config.maxMaterialGatherTasksPerFaction) {
    if (
      activeGatherCount(world, faction, item) + queued >=
      config.maxMaterialGatherTasksPerFaction
    ) {
      break;
    }
    const node = pickMaterialNode(world, faction, nodeKind);
    if (node === -1) break;
    const nx = c.Position.x[node] ?? 0;
    const ny = c.Position.y[node] ?? 0;
    const priority = 1.2 + Math.min(1, deficit / Math.max(1, need));
    const task = createTask(
      world,
      item === ItemType.Wood ? TaskKind.GatherWood : TaskKind.GatherStone,
      faction,
      node,
      nx,
      ny,
      priority,
    );
    c.TaskCitizen[task] = -1;
    queued++;
  }
}

function pickMaterialNode(world: SimWorld, faction: FactionId, kind: NodeKind): number {
  const c = world.components;
  const config = world.config;
  const cc = world.commandCenters.find((e) => c.Faction[e] === faction);
  if (cc === undefined) return -1;

  const nodeLoad = new Map<number, number>();
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const t of tasks) {
    if (
      (c.TaskKind[t] === TaskKind.GatherWood || c.TaskKind[t] === TaskKind.GatherStone) &&
      isActiveTaskState(c.TaskState[t] ?? TaskState.Created)
    ) {
      const target = c.TaskTarget[t];
      nodeLoad.set(target, (nodeLoad.get(target) ?? 0) + 1);
    }
  }

  let best = -1;
  let bestD = Infinity;
  for (const node of world.nodes) {
    if (c.NodeKind[node] !== kind) continue;
    if ((c.NodeAmount[node] ?? 0) <= 0) continue;
    if ((nodeLoad.get(node) ?? 0) >= config.maxGatherersPerNode) continue;
    const holder = c.NodeReservedBy[node] ?? -1;
    if (holder !== -1 && entityExists(world, holder)) continue;
    if (isNodeInsideFootprint(world, node)) continue;
    const dx = (c.Position.x[node] ?? 0) - (c.Position.x[cc] ?? 0);
    const dy = (c.Position.y[node] ?? 0) - (c.Position.y[cc] ?? 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

function activeGatherCount(world: SimWorld, faction: FactionId, item: ItemType): number {
  const c = world.components;
  const kind = item === ItemType.Wood ? TaskKind.GatherWood : TaskKind.GatherStone;
  const tasks = sortedQuery(query(world, [c.Task]));
  let count = 0;
  for (const t of tasks) {
    if (
      c.TaskFaction[t] === faction &&
      c.TaskKind[t] === kind &&
      isActiveTaskState(c.TaskState[t] ?? TaskState.Created)
    ) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Supply demand (work building logistics)
// ---------------------------------------------------------------------------

/** Finished sawpits of a faction, in build order. */
function sawpitsOf(world: SimWorld, faction: FactionId): number[] {
  const c = world.components;
  return world.buildings.filter(
    (b) => c.Faction[b] === faction && c.BuildingKind[b] === BuildingKind.Sawpit,
  );
}

function runSupplyDemand(world: SimWorld, faction: FactionId): void {
  const config = world.config;
  const need = materialNeed(world, faction);
  const planksTarget = Math.max(
    need[ItemType.Planks],
    effectiveFactionReserve(world, faction, ItemType.Planks),
  );
  const planksShort = Math.max(0, planksTarget - factionStockOf(world, faction, ItemType.Planks));
  if (planksShort <= 0) return;
  const recipe = config.recipes[RecipeKind.Planks];
  if (recipe === undefined) return;

  for (const sawpit of sawpitsOf(world, faction)) {
    if (activeSupplyCount(world, sawpit) > 0) continue;
    // Output first: crafted planks must reach a stockpile before funding.
    if (stockAt(world, sawpit, ItemType.Planks) > 0) {
      const dest = nearestStockpileWithRoom(world, faction, sawpit, 1);
      if (dest !== -1) {
        queueSupply(world, faction, sawpit, dest, ItemType.Planks, 1.7);
        continue;
      }
    }
    // Input: keep the sawpit's wood buffer topped up from the stockpiles.
    if (
      stockAt(world, sawpit, ItemType.Wood) < config.sawpitWoodBuffer &&
      stockRoom(world, sawpit) >= config.carryCapacity
    ) {
      const src = nearestStockpileWithItem(world, faction, sawpit, ItemType.Wood);
      if (src !== -1) {
        queueSupply(world, faction, src, sawpit, ItemType.Wood, 1.5);
      }
    }
  }
}

function queueSupply(
  world: SimWorld,
  faction: FactionId,
  source: number,
  dest: number,
  item: ItemType,
  priority: number,
): void {
  const c = world.components;
  const [gx, gy] = adjacentGoal(world, source);
  const task = createTask(world, TaskKind.Supply, faction, dest, gx, gy, priority);
  c.TaskItem[task] = item;
  c.TaskSource[task] = source;
}

/** Active Supply tasks that fetch from or deliver to this building. */
function activeSupplyCount(world: SimWorld, sawpit: number): number {
  const c = world.components;
  const tasks = sortedQuery(query(world, [c.Task]));
  let count = 0;
  for (const t of tasks) {
    if (c.TaskKind[t] !== TaskKind.Supply) continue;
    if (!isActiveTaskState(c.TaskState[t] ?? TaskState.Created)) continue;
    if (c.TaskSource[t] === sawpit || c.TaskTarget[t] === sawpit) count++;
  }
  return count;
}

/** Nearest stockpile holding at least one unit of `item` (spawn-order tie-break). */
function nearestStockpileWithItem(
  world: SimWorld,
  faction: FactionId,
  from: number,
  item: ItemType,
): number {
  const c = world.components;
  const fx = c.Position.x[from] ?? 0;
  const fy = c.Position.y[from] ?? 0;
  let best = -1;
  let bestD = Infinity;
  for (const sp of factionStockpiles(world, faction)) {
    if (stockAt(world, sp, item) <= 0) continue;
    const dx = (c.Position.x[sp] ?? 0) - fx;
    const dy = (c.Position.y[sp] ?? 0) - fy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = sp;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Craft demand
// ---------------------------------------------------------------------------

function runCraftDemand(world: SimWorld, faction: FactionId): void {
  const c = world.components;
  const config = world.config;
  const need = materialNeed(world, faction);
  const planksTarget = Math.max(
    need[ItemType.Planks],
    effectiveFactionReserve(world, faction, ItemType.Planks),
  );
  if (planksTarget <= 0) return;
  if (factionStockOf(world, faction, ItemType.Planks) >= planksTarget) return;
  const recipe = config.recipes[RecipeKind.Planks];
  if (recipe === undefined) return;

  for (const sawpit of sawpitsOf(world, faction)) {
    if (activeCraftAt(world, sawpit) > 0) continue;
    // The sawpit needs input wood and output room to start a batch.
    if (
      stockAt(world, sawpit, recipe.input[0]?.item ?? ItemType.Wood) <
      (recipe.input[0]?.amount ?? 0)
    ) {
      continue; // haulers are still bringing wood
    }
    if (stockRoom(world, sawpit) < recipe.output.amount) continue;
    const [gx, gy] = adjacentGoal(world, sawpit);
    const task = createTask(world, TaskKind.Craft, faction, sawpit, gx, gy, 1.8);
    c.TaskItem[task] = RecipeKind.Planks;
    break; // one batch at a time per sawpit
  }
}

function activeCraftAt(world: SimWorld, sawpit: number): number {
  const c = world.components;
  const tasks = sortedQuery(query(world, [c.Task]));
  let count = 0;
  for (const t of tasks) {
    if (
      c.TaskKind[t] === TaskKind.Craft &&
      c.TaskTarget[t] === sawpit &&
      isActiveTaskState(c.TaskState[t] ?? TaskState.Created)
    ) {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Haul demand
// ---------------------------------------------------------------------------

function runHaulDemand(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const citizens = sortedQuery(query(world, [c.Citizen]));
  for (const eid of citizens) {
    if (c.TaskId[eid] !== -1) continue;
    const amount = c.CarryAmount[eid] ?? 0;
    if (amount <= 0) continue;
    if (c.CarryItem[eid] === ItemType.Food) continue; // food is eaten from carry
    const faction = c.Faction[eid] as FactionId;
    const sp = nearestStockpileWithRoom(world, faction, eid, 1);
    if (sp === -1) continue;
    const [gx, gy] = adjacentGoal(world, sp);
    const hungry = (c.Hunger[eid] ?? 0) >= config.eatThreshold;
    const task = createTask(world, TaskKind.Haul, faction, sp, gx, gy, hungry ? 3 : 1.5);
    c.TaskCitizen[task] = eid;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function itemForNode(nodeKind: number): ItemType {
  if (nodeKind === NodeKind.Tree) return ItemType.Wood;
  if (nodeKind === NodeKind.Stone) return ItemType.Stone;
  return ItemType.Food;
}

/** Shared gather flow for food, wood, and stone. */
export function executeGatherMaterial(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  const node = c.TaskTarget[task];
  const item = itemForNode(c.NodeKind[node] ?? NodeKind.Berries);

  if (phase === TaskPhase.WalkToTarget) {
    if (!atGoal(world, worker, task)) return;
    if (!entityExists(world, node)) {
      failTask(world, task, TaskFailReason.Depleted);
      return;
    }
    c.TaskPhase[task] = TaskPhase.Work;
    return;
  }

  if (phase === TaskPhase.Work) {
    if (!entityExists(world, node) || (c.NodeAmount[node] ?? 0) <= 0) {
      failTask(world, task, TaskFailReason.Depleted);
      return;
    }
    c.CarryAmount[worker] = (c.CarryAmount[worker] ?? 0) + 1;
    c.CarryItem[worker] = item;
    c.NodeAmount[node] = (c.NodeAmount[node] ?? 0) - 1;
    c.TaskProgress[task] = (c.TaskProgress[task] ?? 0) + 1;
    if (item === ItemType.Food) {
      world.stats.foodGathered++;
    } else {
      world.stats.materialsGathered++;
    }
    if ((c.NodeAmount[node] ?? 0) <= 0) {
      c.NodeRegenTick[node] = world.tick + config.berryRegenDelayTicks;
    }
    if ((c.CarryAmount[worker] ?? 0) >= config.carryCapacity || (c.NodeAmount[node] ?? 0) <= 0) {
      const sp = nearestStockpileWithRoom(world, c.Faction[worker] as FactionId, worker, 1);
      if (sp === -1) {
        failTask(world, task, TaskFailReason.StockpileFull);
        return;
      }
      const [gx, gy] = adjacentGoal(world, sp);
      setTaskGoal(world, task, gx, gy);
      c.TaskPhase[task] = TaskPhase.WalkToDeliver;
    }
    return;
  }

  if (phase === TaskPhase.WalkToDeliver) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Deliver;
    return;
  }

  if (phase === TaskPhase.Deliver) {
    const sp = nearestStockpileWithRoom(world, c.Faction[worker] as FactionId, worker, 1);
    if (sp === -1) {
      failTask(world, task, TaskFailReason.StockpileFull);
      return;
    }
    const room = stockRoom(world, sp);
    const amount = Math.min(c.CarryAmount[worker] ?? 0, Math.max(0, room));
    addStock(world, sp, item, amount);
    c.CarryAmount[worker] = (c.CarryAmount[worker] ?? 0) - amount;
    if ((c.CarryAmount[worker] ?? 0) <= 0) {
      clearCarry(world, worker);
      completeTask(world, task);
    } else {
      failTask(world, task, TaskFailReason.StockpileFull);
    }
  }
}

/** Craft one recipe batch at the sawpit (input from its buffer, output into it). */
export function executeCraft(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  const sawpit = c.TaskTarget[task];
  const recipe = config.recipes[c.TaskItem[task] as RecipeKind];

  if (phase === TaskPhase.WalkToTarget) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Work;
    return;
  }

  if (phase === TaskPhase.Work) {
    c.TaskProgress[task] = (c.TaskProgress[task] ?? 0) + config.craftWorkPerTick;
    c.CitizenState[worker] = CitizenState.Working;
    if ((c.TaskProgress[task] ?? 0) < (recipe?.workTicks ?? 0)) return;
    if (recipe === undefined) {
      failTask(world, task, TaskFailReason.NoMaterial);
      return;
    }
    // Atomic completion against the sawpit's own buffer: verify input and
    // output room, then consume wood and produce planks into the buffer.
    for (const line of recipe.input) {
      if (stockAt(world, sawpit, line.item) < line.amount) {
        failTask(world, task, TaskFailReason.NoMaterial);
        return;
      }
    }
    if (stockRoom(world, sawpit) < recipe.output.amount) {
      failTask(world, task, TaskFailReason.StockpileFull);
      return;
    }
    for (const line of recipe.input) {
      removeStock(world, sawpit, line.item, line.amount);
    }
    addStock(world, sawpit, recipe.output.item, recipe.output.amount);
    world.stats.crafted++;
    completeTask(world, task);
  }
}

/** Move `item` from the task's source building to its destination building. */
export function executeSupply(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  const source = c.TaskSource[task];
  const dest = c.TaskTarget[task];
  const item = c.TaskItem[task] as ItemType;

  if (phase === TaskPhase.WalkToTarget) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Fetch;
    return;
  }

  if (phase === TaskPhase.Fetch) {
    // Never mix a new item onto a mismatched carry (e.g. food from an earlier
    // get-food task): that corrupts CarryItem/CarryAmount. The worker only
    // claims supply tasks with an empty carry, but guard anyway — a carry of
    // a different item means the earlier task was interrupted.
    const carrying = c.CarryAmount[worker] ?? 0;
    const carryItem = c.CarryItem[worker] ?? ItemType.Food;
    if (carrying > 0 && carryItem !== item) {
      failTask(world, task, TaskFailReason.NoMaterial);
      return;
    }
    const room = config.carryCapacity - carrying;
    const take = Math.min(room, stockAt(world, source, item));
    if (take <= 0) {
      failTask(world, task, TaskFailReason.NoMaterial);
      return;
    }
    c.CarryAmount[worker] = (c.CarryAmount[worker] ?? 0) + take;
    c.CarryItem[worker] = item;
    removeStock(world, source, item, take);
    const [gx, gy] = adjacentGoal(world, dest);
    setTaskGoal(world, task, gx, gy);
    c.TaskPhase[task] = TaskPhase.WalkToDeliver;
    return;
  }

  if (phase === TaskPhase.WalkToDeliver) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Deliver;
    return;
  }

  if (phase === TaskPhase.Deliver) {
    const room = stockRoom(world, dest);
    const put = Math.min(c.CarryAmount[worker] ?? 0, Math.max(0, room));
    addStock(world, dest, item, put);
    c.CarryAmount[worker] = (c.CarryAmount[worker] ?? 0) - put;
    if ((c.CarryAmount[worker] ?? 0) <= 0) {
      clearCarry(world, worker);
      completeTask(world, task);
    } else {
      // Destination filled mid-trip; the carry is rescued by a Haul task.
      failTask(world, task, TaskFailReason.StockpileFull);
    }
  }
}

/** Deposit a stranded non-food carry at the task's stockpile. */
export function executeHaul(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;

  if (phase === TaskPhase.WalkToTarget) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Deliver;
    return;
  }

  if (phase === TaskPhase.Deliver) {
    const item = c.CarryItem[worker] ?? 0;
    const amount = c.CarryAmount[worker] ?? 0;
    if (amount <= 0) {
      completeTask(world, task);
      return;
    }
    const sp = c.TaskTarget[task];
    const room = stockRoom(world, sp);
    if (room <= 0) {
      failTask(world, task, TaskFailReason.StockpileFull);
      return;
    }
    const put = Math.min(amount, room);
    addStock(world, sp, item, put);
    c.CarryAmount[worker] = amount - put;
    if ((c.CarryAmount[worker] ?? 0) <= 0) {
      clearCarry(world, worker);
      completeTask(world, task);
    } else {
      failTask(world, task, TaskFailReason.StockpileFull);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setTaskGoal(world: SimWorld, task: number, x: number, y: number): void {
  world.components.TaskGoalX[task] = x;
  world.components.TaskGoalY[task] = y;
}

function atGoal(world: SimWorld, worker: number, task: number): boolean {
  const c = world.components;
  return c.Position.x[worker] === c.TaskGoalX[task] && c.Position.y[worker] === c.TaskGoalY[task];
}
