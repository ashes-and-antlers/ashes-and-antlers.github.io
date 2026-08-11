import { entityExists, query } from 'bitecs';
import {
  BuildingKind,
  CitizenState,
  FACTIONS,
  FACTION_META,
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

/**
 * Task market (Milestone 1 slice).
 *
 * - Demand: hungry citizens without food get a GetFood task; factions below
 *   their food reserve get GatherFood tasks on berry nodes.
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
    if ((c.CarryFood[eid] ?? 0) > 0) continue;
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

  // --- Build demand: one task per unreserved construction site ---
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
    if (c.TaskKind[task] === TaskKind.GatherFood) {
      const node = c.TaskTarget[task];
      const holder = c.NodeReservedBy[node] ?? -1;
      if (holder === -1 || !entityExists(world, holder)) {
        c.NodeReservedBy[node] = eid;
      }
    } else if (c.TaskKind[task] === TaskKind.Build) {
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
    } else if (kind === TaskKind.GatherFood) {
      executeGatherFood(world, task, worker);
    } else if (kind === TaskKind.Build) {
      executeBuild(world, task, worker);
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
    const room = config.carryCapacity - c.CarryFood[worker];
    const take = Math.min(room, c.StockpileFood[stockpile] ?? 0);
    if (take <= 0) {
      failTask(world, task, TaskFailReason.NoFood);
      return;
    }
    c.CarryFood[worker] += take;
    c.StockpileFood[stockpile] -= take;
    completeTask(world, task);
  }
}

function executeGatherFood(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  const node = c.TaskTarget[task];

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
    c.CarryFood[worker]++;
    c.NodeAmount[node]--;
    c.TaskProgress[task]++;
    world.stats.foodGathered++;
    if ((c.NodeAmount[node] ?? 0) <= 0) {
      c.NodeRegenTick[node] = world.tick + config.berryRegenDelayTicks;
    }
    if (c.CarryFood[worker] >= config.carryCapacity || (c.NodeAmount[node] ?? 0) <= 0) {
      const stockpile = nearestFactionStockpile(world, c.Faction[worker] as FactionId, worker);
      if (stockpile === -1) {
        failTask(world, task, TaskFailReason.NoFood);
        return;
      }
      const [gx, gy] = adjacentGoal(world, stockpile);
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
    const stockpile = nearestFactionStockpile(world, c.Faction[worker] as FactionId, worker);
    if (stockpile === -1) {
      failTask(world, task, TaskFailReason.NoFood);
      return;
    }
    const room = (c.StockpileCapacity[stockpile] ?? 0) - (c.StockpileFood[stockpile] ?? 0);
    const amount = Math.min(c.CarryFood[worker], Math.max(0, room));
    c.StockpileFood[stockpile] += amount;
    c.CarryFood[worker] -= amount;
    if (c.CarryFood[worker] <= 0) {
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

/**
 * Every food-capable building of a faction (command centers plus any player-
 * built stockpiles), in deterministic spawn order.
 */
export function factionStockpiles(world: SimWorld, faction: FactionId): number[] {
  const c = world.components;
  return world.buildings.filter((b) => {
    if (c.Faction[b] !== faction) return false;
    const kind = c.BuildingKind[b] ?? BuildingKind.CommandCenter;
    return kind === BuildingKind.CommandCenter || kind === BuildingKind.Stockpile;
  });
}

export function factionStock(world: SimWorld, faction: FactionId): number {
  const c = world.components;
  let total = 0;
  for (const b of factionStockpiles(world, faction)) {
    total += c.StockpileFood[b] ?? 0;
  }
  return total;
}

export function nearestFactionStockpile(world: SimWorld, faction: FactionId, from: number): number {
  const c = world.components;
  const fx = c.Position.x[from] ?? 0;
  const fy = c.Position.y[from] ?? 0;
  let best = -1;
  let bestD = Infinity;
  for (const b of factionStockpiles(world, faction)) {
    if ((c.StockpileFood[b] ?? 0) <= 0) continue;
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

function bestTaskFor(world: SimWorld, citizen: number): number {
  const c = world.components;
  const config = world.config;
  const faction = c.Faction[citizen] as FactionId;
  const hungry = c.Hunger[citizen] >= config.eatThreshold && (c.CarryFood[citizen] ?? 0) <= 0;
  const carryRoom = (c.CarryFood[citizen] ?? 0) < config.carryCapacity;
  let best = -1;
  let bestPriority = -Infinity;
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const t of tasks) {
    const state = c.TaskState[t] ?? TaskState.Created;
    if (state !== TaskState.Claimable && state !== TaskState.Created) continue;
    if (c.TaskFaction[t] !== faction) continue;
    const kind = c.TaskKind[t] ?? TaskKind.GetFood;
    if (kind === TaskKind.GetFood && !hungry) continue;
    if (kind === TaskKind.GatherFood && (!carryRoom || hungry)) continue;
    if (kind === TaskKind.Build && hungry) continue; // food outranks construction
    const p = c.TaskPriority[t] ?? 0;
    if (p > bestPriority) {
      bestPriority = p;
      best = t;
    }
  }
  return best;
}

/** First walkable tile adjacent to a building footprint (deterministic scan). */
export function adjacentGoal(world: SimWorld, building: number): [number, number] {
  const c = world.components;
  const bx = Math.floor(c.Position.x[building] ?? 0);
  const by = Math.floor(c.Position.y[building] ?? 0);
  const f = world.config.buildingFootprint;
  const candidates: readonly (readonly [number, number])[] = [
    [bx - 1, by],
    [bx + f, by],
    [bx, by - 1],
    [bx, by + f],
    [bx - 1, by + 1],
    [bx + f, by + 1],
  ];
  for (const [x, y] of candidates) {
    if (!world.tiles.isInside(x, y)) continue;
    const tile = world.tiles.index(x, y);
    if ((world.tiles.movementCost[tile] ?? 0) < 75) {
      return [x, y];
    }
  }
  return [bx, by];
}
