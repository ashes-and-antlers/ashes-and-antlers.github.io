/**
 * Simulation content enums. Values are part of the snapshot wire format —
 * never renumber existing entries.
 */

import type { SimAlert } from '../../shared/protocol';

export type { SimAlert };

export enum FactionId {
  None = 0,
  Hearth = 1,
  IronSwarm = 2,
}

export const FACTIONS: readonly FactionId[] = [FactionId.Hearth, FactionId.IronSwarm];

export enum EntityKind {
  Citizen = 1,
  CommandCenter = 2,
  Stockpile = 3,
  BerryNode = 4,
  StoneNode = 5,
  TreeNode = 6,
  Blueprint = 7,
  Hut = 8,
}

export enum BuildingKind {
  CommandCenter = 1,
  Stockpile = 2,
  Hut = 3,
}

export enum NodeKind {
  Berries = 1,
  Stone = 2,
  Tree = 3,
}

export enum CitizenState {
  Idle = 0,
  Moving = 1,
  Working = 2,
  Eating = 3,
  Resting = 4,
  Dead = 5,
}

export enum TaskKind {
  GetFood = 1,
  GatherFood = 2,
  Build = 3,
}

export enum TaskState {
  Created = 0,
  Claimable = 1,
  Reserved = 2,
  InProgress = 3,
  Completed = 4,
  Failed = 5,
  Cancelled = 6,
}

export enum TaskPhase {
  WalkToTarget = 0,
  Work = 1,
  WalkToDeliver = 2,
  Deliver = 3,
}

export enum TaskFailReason {
  None = 0,
  Unreachable = 1,
  Depleted = 2,
  NoFood = 3,
  StockpileFull = 4,
  WorkerDied = 5,
}

export enum ItemType {
  Food = 1,
}

export interface FactionMeta {
  id: FactionId;
  name: string;
  /** Renderer accent color (hex). */
  color: string;
  /** Food reserve the faction tries to maintain in its stockpile. */
  desiredFoodReserve: number;
}

export const FACTION_META: Record<FactionId, FactionMeta> = {
  [FactionId.None]: {
    id: FactionId.None,
    name: 'Neutral',
    color: '#8b97a3',
    desiredFoodReserve: 0,
  },
  [FactionId.Hearth]: {
    id: FactionId.Hearth,
    name: 'Hearth Confederacy',
    color: '#e8a13b',
    desiredFoodReserve: 50,
  },
  [FactionId.IronSwarm]: {
    id: FactionId.IronSwarm,
    name: 'Iron Swarm',
    color: '#4fc3c9',
    desiredFoodReserve: 30,
  },
};
