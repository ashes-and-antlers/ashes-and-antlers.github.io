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
  Sawpit = 9,
}

export enum BuildingKind {
  CommandCenter = 1,
  Stockpile = 2,
  Hut = 3,
  Sawpit = 4,
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
  GatherWood = 4,
  GatherStone = 5,
  Craft = 6,
  Haul = 7,
  Supply = 8,
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
  /** Supply: taking goods from the source building (stationary). */
  Fetch = 4,
}

export enum TaskFailReason {
  None = 0,
  Unreachable = 1,
  Depleted = 2,
  NoFood = 3,
  StockpileFull = 4,
  WorkerDied = 5,
  NoMaterial = 6,
}

/** Tradable goods. Values are part of the snapshot wire format. */
export enum ItemType {
  Food = 1,
  Wood = 2,
  Stone = 3,
  Planks = 4,
}

export const ITEM_TYPES: readonly ItemType[] = [
  ItemType.Food,
  ItemType.Wood,
  ItemType.Stone,
  ItemType.Planks,
];

/** One line of a recipe or construction cost: `amount` of `item`. */
export interface ItemCost {
  item: ItemType;
  amount: number;
}

/** Crafting recipes, keyed by RecipeKind (values part of the wire format). */
export enum RecipeKind {
  Planks = 1,
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
