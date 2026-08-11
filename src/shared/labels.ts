import {
  BuildingKind,
  CitizenState,
  ItemType,
  NodeKind,
  TaskKind,
  TaskPhase,
  TaskState,
} from '../sim/data/content';

/** Pure label maps shared by the worker-side inspector and the HUD. */

export const CITIZEN_STATE_NAMES: Record<number, string> = {
  [CitizenState.Idle]: 'idle',
  [CitizenState.Moving]: 'moving',
  [CitizenState.Working]: 'working',
  [CitizenState.Eating]: 'eating',
  [CitizenState.Resting]: 'resting',
  [CitizenState.Dead]: 'dead',
};

export const BUILDING_NAMES: Record<number, string> = {
  [BuildingKind.CommandCenter]: 'Command center',
  [BuildingKind.Stockpile]: 'Stockpile',
  [BuildingKind.Hut]: 'Hut',
  [BuildingKind.Sawpit]: 'Sawpit',
};

export const NODE_NAMES: Record<number, string> = {
  [NodeKind.Berries]: 'Berries',
  [NodeKind.Stone]: 'Stone',
  [NodeKind.Tree]: 'Tree',
};

export const ITEM_NAMES: Record<number, string> = {
  [ItemType.Food]: 'food',
  [ItemType.Wood]: 'wood',
  [ItemType.Stone]: 'stone',
  [ItemType.Planks]: 'planks',
};

export const TASK_KIND_NAMES: Record<number, string> = {
  [TaskKind.GetFood]: 'get food',
  [TaskKind.GatherFood]: 'gather food',
  [TaskKind.Build]: 'build',
  [TaskKind.GatherWood]: 'gather wood',
  [TaskKind.GatherStone]: 'gather stone',
  [TaskKind.Craft]: 'craft',
  [TaskKind.Haul]: 'haul',
  [TaskKind.Supply]: 'supply',
};

export const TASK_STATE_NAMES: Record<number, string> = {
  [TaskState.Created]: 'created',
  [TaskState.Claimable]: 'claimable',
  [TaskState.Reserved]: 'reserved',
  [TaskState.InProgress]: 'in progress',
  [TaskState.Completed]: 'completed',
  [TaskState.Failed]: 'failed',
  [TaskState.Cancelled]: 'cancelled',
};

export const TASK_PHASE_NAMES: Record<number, string> = {
  [TaskPhase.WalkToTarget]: 'walk to target',
  [TaskPhase.Work]: 'working',
  [TaskPhase.WalkToDeliver]: 'walk to deliver',
  [TaskPhase.Deliver]: 'delivering',
  [TaskPhase.Fetch]: 'fetching',
};

export const TASK_FAIL_NAMES: Record<number, string> = {
  0: 'none',
  1: 'unreachable',
  2: 'depleted',
  3: 'no food',
  4: 'stockpile full',
  5: 'worker died',
  6: 'no material',
};

/** Construction priority labels (1 low / 2 normal / 3 high). */
export const PRIORITY_NAMES: Record<number, string> = {
  1: 'low',
  2: 'normal',
  3: 'high',
};
