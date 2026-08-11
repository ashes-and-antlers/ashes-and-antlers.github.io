import { addComponent, addEntity, entityExists, removeEntity } from 'bitecs';
import {
  CitizenState,
  TaskKind,
  TaskPhase,
  TaskState,
  TaskFailReason,
  type FactionId,
} from '../data/content';
import type { SimWorld } from '../ecs/world';

/** Create a task entity with every component field initialized (eids recycle). */
export function createTask(
  world: SimWorld,
  kind: TaskKind,
  faction: FactionId,
  target: number,
  goalX: number,
  goalY: number,
  priority: number,
): number {
  const c = world.components;
  const eid = addEntity(world);
  for (const comp of [
    c.Task,
    c.TaskKind,
    c.TaskState,
    c.TaskPhase,
    c.TaskFaction,
    c.TaskPriority,
  ]) {
    addComponent(world, eid, comp);
  }
  c.TaskKind[eid] = kind;
  c.TaskState[eid] = TaskState.Claimable;
  c.TaskPhase[eid] = TaskPhase.WalkToTarget;
  c.TaskFaction[eid] = faction;
  c.TaskTarget[eid] = target;
  c.TaskGoalX[eid] = goalX;
  c.TaskGoalY[eid] = goalY;
  c.TaskPriority[eid] = priority;
  c.TaskClaimedBy[eid] = -1;
  c.TaskFailReason[eid] = TaskFailReason.None;
  c.TaskProgress[eid] = 0;
  return eid;
}

export function isActiveTaskState(state: number): boolean {
  return (
    state === TaskState.Created ||
    state === TaskState.Claimable ||
    state === TaskState.Reserved ||
    state === TaskState.InProgress
  );
}

/** Release a task's reservations and the worker's back-reference. */
export function clearReservation(world: SimWorld, task: number): void {
  const c = world.components;
  const worker = c.TaskClaimedBy[task];
  if (c.TaskKind[task] === TaskKind.GatherFood) {
    const node = c.TaskTarget[task];
    if (node !== -1 && c.NodeReservedBy[node] === worker) {
      c.NodeReservedBy[node] = -1;
    }
  } else if (c.TaskKind[task] === TaskKind.Build) {
    const blueprint = c.TaskTarget[task];
    if (blueprint !== -1 && c.BlueprintReservedBy[blueprint] === worker) {
      c.BlueprintReservedBy[blueprint] = -1;
    }
  }
  if (worker !== -1 && entityExists(world, worker)) {
    c.TaskId[worker] = -1;
  }
}

export function completeTask(world: SimWorld, task: number): void {
  const c = world.components;
  c.TaskState[task] = TaskState.Completed;
  world.stats.tasksCompleted++;
  const worker = c.TaskClaimedBy[task];
  if (worker !== -1 && entityExists(world, worker)) {
    c.CitizenState[worker] = CitizenState.Idle;
  }
  clearReservation(world, task);
  removeEntity(world, task);
}

export function failTask(world: SimWorld, task: number, reason: TaskFailReason): void {
  const c = world.components;
  c.TaskState[task] = TaskState.Failed;
  c.TaskFailReason[task] = reason;
  world.stats.tasksFailed++;
  const worker = c.TaskClaimedBy[task];
  if (worker !== -1 && entityExists(world, worker)) {
    c.CitizenState[worker] = CitizenState.Idle;
  }
  // Remember the failure on the blueprint so demand enters its retry cooldown
  // instead of recreating the task every tick (unreachable-site guard).
  if (c.TaskKind[task] === TaskKind.Build) {
    const blueprint = c.TaskTarget[task];
    if (blueprint !== -1) {
      c.BlueprintFailTick[blueprint] = world.tick;
    }
  }
  clearReservation(world, task);
  removeEntity(world, task);
}
