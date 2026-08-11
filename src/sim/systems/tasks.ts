import { entityExists, query } from 'bitecs';
import {
  CitizenState,
  FACTIONS,
  FACTION_META,
  ItemType,
  NodeKind,
  TaskFailReason,
  TaskKind,
  TaskPhase,
  TaskState,
  type FactionId,
} from '../data/content';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { completeTask, createTask, failTask, isActiveTaskState } from './taskops';
import { executeBuild, runBuildDemand } from './construction';
import {
  executeCraft,
  executeGatherMaterial,
  executeHaul,
  executeSupply,
  runMaterialDemand,
} from './economy';
import {
  adjacentGoal,
  factionStockOf,
  factionStockpiles,
  isNodeInsideFootprint,
  removeStock,
  stockAt,
} from './inventory';

/**
 * Task market (Milestone 1 slice + M2 materials economy).
 *
 * - Demand: hungry citizens without food get a GetFood task; factions below
 *   their food reserve get GatherFood tasks on berry nodes; unfunded
 *   construction sites drive wood/stone gather, planks crafting, and haul
 *   orders (see economy.ts); build demand runs in construction.ts.
 * - Claim: citizens pick the highest-priority eligible task; ties resolve to
 *   the lowest task id; claims happen in ascending citizen id order.
 * - Execution: tasks walk through WalkToTarget -> Work -> WalkToDeliver ->
 *   Deliver phases. The movement system walks citizens toward task goals.
 *
 * All iteration is over ascending entity ids (see sortedQuery), so claims and
 * phase transitions are deterministic.
 */

export function runTaskDemand(world: SimWorld): void {
  const c = world.components;
  const config = world.config;

  // --- Eat demand: one GetFood task per hungry citizen with empty carry ---
  const citizens = sortedQuery(query(world, [c.Citizen]));
  for (const eid of citizens) {
    if (c.TaskId[eid] !== -1) continue;
    if ((c.CarryAmount[eid] ?? 0) > 0) continue;
    if (c.Hunger[eid] < config.eatThreshold) continue;
    const stockpile = nearestFactionStockpile(world, c.Faction[eid] as FactionId, eid);
    if (stockpile === -1) continue; // no food anywhere; alert system reports it
    const [gx, gy] = adjacentGoal(world, stockpile);
    createTask(
      world,
      TaskKind.GetFood,
      c.Faction[eid] as FactionId,
      stockpile,
      gx,
      gy,
      2 + c.Hunger[eid] / 100,
    );
  }

  // --- Gather demand: top up the faction food reserve ---
  for (const faction of FACTIONS) {
    const reserve = FACTION_META[faction].desiredFoodReserve;
    const stock = factionStock(world, faction);
    const active = activeGatherCount(world, faction);
    if (stock >= reserve || active >= config.maxGatherTasksPerFaction) continue;
    const node = pickBerryNode(world, faction);
    if (node === -1) continue;
    const nx = c.Position.x[node] ?? 0;
    const ny = c.Position.y[node] ?? 0;
    const deficit = Math.max(0, reserve - stock);
    const priority = 1 + deficit / Math.max(1, reserve);
    createTask(world, TaskKind.GatherFood, faction, node, nx, ny, priority);
  }

  // --- Material demand (M2): wood/stone gather, planks craft, haul ---
  runMaterialDemand(world);

  // --- Build demand: one task per unreserved, funded construction site ---
  runBuildDemand(world);
}

export function runTaskClaim(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const citizens = sortedQuery(query(world, [c.Citizen]));
  for (const eid of citizens) {
    if (c.TaskId[eid] !== -1) continue;
    const state = c.CitizenState[eid] ?? CitizenState.Idle;
    if (state === CitizenState.Resting || state === CitizenState.Dead) continue;
    // Resume work only once rested enough (resting below this threshold).
    if (c.Energy[eid] < config.resumeWorkAt) continue;
    const task = bestTaskFor(world, eid);
    if (task === -1) continue;
    c.TaskId[eid] = task;
    c.TaskState[task] = TaskState.Reserved;
    c.TaskClaimedBy[task] = eid;
    c.CitizenState[eid] = CitizenState.Moving;
    const kind = c.TaskKind[task] ?? TaskKind.GetFood;
    if (NODE_TASK_KINDS.includes(kind)) {
      const node = c.TaskTarget[task];
      const holder = c.NodeReservedBy[node] ?? -1;
      if (holder === -1 || !entityExists(world, holder)) {
        c.NodeReservedBy[node] = eid;
      }
    } else if (kind === TaskKind.Build) {
      const blueprint = c.TaskTarget[task];
      const holder = c.BlueprintReservedBy[blueprint] ?? -1;
      if (holder === -1 || !entityExists(world, holder)) {
        c.BlueprintReservedBy[blueprint] = eid;
      }
    }
  }
}

export function runTaskExecution(world: SimWorld): void {
  const c = world.components;
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const task of tasks) {
    const state = c.TaskState[task] ?? TaskState.Created;
    if (state !== TaskState.Reserved && state !== TaskState.InProgress) continue;
    const worker = c.TaskClaimedBy[task] ?? -1;
    if (worker === -1 || !entityExists(world, worker)) {
      failTask(world, task, TaskFailReason.WorkerDied);
      continue;
    }
    c.TaskState[task] = TaskState.InProgress;
    const kind = c.TaskKind[task] ?? TaskKind.GetFood;
    if (kind === TaskKind.GetFood) {
      executeGetFood(world, task, worker);
    } else if (NODE_TASK_KINDS.includes(kind)) {
      executeGatherMaterial(world, task, worker);
    } else if (kind === TaskKind.Build) {
      executeBuild(world, task, worker);
    } else if (kind === TaskKind.Craft) {
      executeCraft(world, task, worker);
    } else if (kind === TaskKind.Haul) {
      executeHaul(world, task, worker);
    } else if (kind === TaskKind.Supply) {
      executeSupply(world, task, worker);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function executeGetFood(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  if (phase === TaskPhase.WalkToTarget) {
    if (!atGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Work;
    return;
  }
  if (phase === TaskPhase.Work) {
    const stockpile = c.TaskTarget[task];
    if (stockpile === -1 || !entityExists(world, stockpile)) {
      failTask(world, task, TaskFailReason.NoFood);
      return;
    }
    const room = config.carryCapacity - (c.CarryAmount[worker] ?? 0);
    const take = Math.min(room, stockAt(world, stockpile, ItemType.Food));
    if (take <= 0) {
      failTask(world, task, TaskFailReason.NoFood);
      return;
    }
    c.CarryAmount[worker] = (c.CarryAmount[worker] ?? 0) + take;
    c.CarryItem[worker] = ItemType.Food;
    removeStock(world, stockpile, ItemType.Food, take);
    completeTask(world, task);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atGoal(world: SimWorld, worker: number, task: number): boolean {
  const c = world.components;
  return c.Position.x[worker] === c.TaskGoalX[task] && c.Position.y[worker] === c.TaskGoalY[task];
}

/** Total food stored across a faction's stockpiles. */
export function factionStock(world: SimWorld, faction: FactionId): number {
  return factionStockOf(world, faction, ItemType.Food);
}

/** Nearest stockpile of the faction that still holds food (eater targeting). */
function nearestFactionStockpile(world: SimWorld, faction: FactionId, from: number): number {
  const c = world.components;
  const fx = c.Position.x[from] ?? 0;
  const fy = c.Position.y[from] ?? 0;
  let best = -1;
  let bestD = Infinity;
  for (const b of factionStockpiles(world, faction)) {
    if (stockAt(world, b, ItemType.Food) <= 0) continue;
    const dx = (c.Position.x[b] ?? 0) - fx;
    const dy = (c.Position.y[b] ?? 0) - fy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function activeGatherCount(world: SimWorld, faction: FactionId): number {
  const c = world.components;
  const tasks = sortedQuery(query(world, [c.Task]));
  let count = 0;
  for (const t of tasks) {
    if (
      c.TaskFaction[t] === faction &&
      c.TaskKind[t] === TaskKind.GatherFood &&
      isActiveTaskState(c.TaskState[t] ?? TaskState.Created)
    ) {
      count++;
    }
  }
  return count;
}

function pickBerryNode(world: SimWorld, faction: FactionId): number {
  const c = world.components;
  const config = world.config;
  const cc = world.commandCenters.find((e) => c.Faction[e] === faction);
  if (cc === undefined) return -1;

  // Active gatherers per node (load) from the current task list.
  const nodeLoad = new Map<number, number>();
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const t of tasks) {
    if (
      c.TaskKind[t] === TaskKind.GatherFood &&
      isActiveTaskState(c.TaskState[t] ?? TaskState.Created)
    ) {
      const target = c.TaskTarget[t];
      nodeLoad.set(target, (nodeLoad.get(target) ?? 0) + 1);
    }
  }

  let best = -1;
  let bestD = Infinity;
  for (const node of world.nodes) {
    if (c.NodeKind[node] !== NodeKind.Berries) continue;
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

const NODE_TASK_KINDS: readonly TaskKind[] = [
  TaskKind.GatherFood,
  TaskKind.GatherWood,
  TaskKind.GatherStone,
];

function bestTaskFor(world: SimWorld, citizen: number): number {
  const c = world.components;
  const config = world.config;
  const faction = c.Faction[citizen] as FactionId;
  const carry = c.CarryAmount[citizen] ?? 0;
  const hungry = c.Hunger[citizen] >= config.eatThreshold && carry <= 0;
  const carryRoom = carry < config.carryCapacity;
  let best = -1;
  let bestPriority = -Infinity;
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const t of tasks) {
    const state = c.TaskState[t] ?? TaskState.Created;
    if (state !== TaskState.Claimable && state !== TaskState.Created) continue;
    if (c.TaskFaction[t] !== faction) continue;
    const kind = c.TaskKind[t] ?? TaskKind.GetFood;
    if (kind === TaskKind.GetFood && !hungry) continue;
    if (NODE_TASK_KINDS.includes(kind) && (!carryRoom || hungry)) continue;
    if (kind === TaskKind.Build && hungry) continue; // food outranks construction
    if (kind === TaskKind.Craft && hungry) continue;
    // Supply hauls one item type; a worker with any carry (e.g. food from a
    // get-food task) would corrupt the carry, so it requires an empty carry.
    if (kind === TaskKind.Supply && (carry > 0 || hungry)) continue;
    if (kind === TaskKind.Haul && c.TaskCitizen[t] !== citizen) continue;
    const p = c.TaskPriority[t] ?? 0;
    if (p > bestPriority) {
      bestPriority = p;
      best = t;
    }
  }
  return best;
}
