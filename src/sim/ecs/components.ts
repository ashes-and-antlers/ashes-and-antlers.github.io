/**
 * bitECS component stores for the simulation (SoA typed arrays indexed by
 * entity id). Designed for ≤ MAX_ENTITIES active entities — the plan's
 * 500-agent target leaves headroom.
 *
 * bitECS 0.4 pattern: components are passed to createWorld({ components }),
 * then accessed as `components.Position.x[eid]`. Tags are plain objects.
 */
import { ItemType } from '../data/content';

export const MAX_ENTITIES = 512;

export interface SimComponents {
  // Every entity
  Position: { x: Float32Array; y: Float32Array };
  Kind: Uint8Array; // EntityKind
  Faction: Uint8Array; // FactionId

  // Tags
  Citizen: Record<string, never>;
  Building: Record<string, never>;
  ResourceNode: Record<string, never>;
  Task: Record<string, never>;
  Blueprint: Record<string, never>;

  // Citizens
  Hunger: Float32Array;
  Energy: Float32Array;
  Morale: Float32Array;
  CarryItem: Uint8Array; // ItemType being carried, 0 = nothing
  CarryAmount: Int32Array;
  CitizenState: Uint8Array;
  TaskId: Int32Array; // current task eid, -1 = none
  HomeId: Int32Array;

  // Buildings
  BuildingKind: Uint8Array;
  /** Per-item stored amounts (keyed by ItemType); building eids. */
  Stock: Record<number, Int32Array>;
  /** Total capacity across all item types. */
  StockpileCapacity: Int32Array;

  // Blueprints (construction sites)
  BlueprintKind: Uint8Array; // BuildingKind being constructed
  BlueprintProgress: Float32Array; // 0..workRequired
  BlueprintReservedBy: Int32Array; // builder eid, -1 = unreserved
  BlueprintFailTick: Int32Array; // last failed build task tick, -1 = none
  /** 1 once the construction cost was consumed from faction stockpiles. */
  BlueprintFunded: Uint8Array;

  // Resource nodes
  NodeKind: Uint8Array;
  NodeAmount: Float32Array;
  NodeMax: Float32Array;
  NodeRegenTick: Int32Array; // tick when regrowth resumes (-1 = no delay)
  NodeReservedBy: Int32Array; // entity that reserved this node, -1 = free

  // Tasks
  TaskKind: Uint8Array;
  TaskState: Uint8Array;
  TaskPhase: Uint8Array;
  TaskFaction: Uint8Array;
  TaskTarget: Int32Array; // node / stockpile / citizen eid
  /** Recipe (Craft) or item (Supply) selector; 0 = none. */
  TaskItem: Uint8Array;
  /** Citizen a task is bound to (Haul), -1 = any citizen may claim. */
  TaskCitizen: Int32Array;
  /** Source building a Supply task fetches from, -1 = none. */
  TaskSource: Int32Array;
  TaskGoalX: Int32Array;
  TaskGoalY: Int32Array;
  TaskPriority: Float32Array;
  TaskClaimedBy: Int32Array; // citizen eid, -1 = unclaimed
  TaskFailReason: Uint8Array;
  TaskProgress: Float32Array;

  // Movement (derived goals set by the task system, consumed by movement)
  GoalX: Int32Array; // -1 = no goal
  GoalY: Int32Array;
  PathIndex: Int32Array;
}

export function createSimComponents(maxEntities: number = MAX_ENTITIES): SimComponents {
  return {
    Position: { x: new Float32Array(maxEntities), y: new Float32Array(maxEntities) },
    Kind: new Uint8Array(maxEntities),
    Faction: new Uint8Array(maxEntities),
    Citizen: {},
    Building: {},
    ResourceNode: {},
    Task: {},
    Blueprint: {},
    Hunger: new Float32Array(maxEntities),
    Energy: new Float32Array(maxEntities),
    Morale: new Float32Array(maxEntities),
    CarryItem: new Uint8Array(maxEntities),
    CarryAmount: new Int32Array(maxEntities),
    CitizenState: new Uint8Array(maxEntities),
    TaskId: new Int32Array(maxEntities).fill(-1),
    HomeId: new Int32Array(maxEntities).fill(-1),
    BuildingKind: new Uint8Array(maxEntities),
    Stock: {
      [ItemType.Food]: new Int32Array(maxEntities),
      [ItemType.Wood]: new Int32Array(maxEntities),
      [ItemType.Stone]: new Int32Array(maxEntities),
      [ItemType.Planks]: new Int32Array(maxEntities),
    },
    StockpileCapacity: new Int32Array(maxEntities),
    BlueprintKind: new Uint8Array(maxEntities),
    BlueprintProgress: new Float32Array(maxEntities),
    BlueprintReservedBy: new Int32Array(maxEntities).fill(-1),
    BlueprintFailTick: new Int32Array(maxEntities).fill(-1),
    BlueprintFunded: new Uint8Array(maxEntities),
    NodeKind: new Uint8Array(maxEntities),
    NodeAmount: new Float32Array(maxEntities),
    NodeMax: new Float32Array(maxEntities),
    NodeRegenTick: new Int32Array(maxEntities).fill(-1),
    NodeReservedBy: new Int32Array(maxEntities).fill(-1),
    TaskKind: new Uint8Array(maxEntities),
    TaskState: new Uint8Array(maxEntities),
    TaskPhase: new Uint8Array(maxEntities),
    TaskFaction: new Uint8Array(maxEntities),
    TaskTarget: new Int32Array(maxEntities).fill(-1),
    TaskItem: new Uint8Array(maxEntities),
    TaskCitizen: new Int32Array(maxEntities).fill(-1),
    TaskSource: new Int32Array(maxEntities).fill(-1),
    TaskGoalX: new Int32Array(maxEntities).fill(-1),
    TaskGoalY: new Int32Array(maxEntities).fill(-1),
    TaskPriority: new Float32Array(maxEntities),
    TaskClaimedBy: new Int32Array(maxEntities).fill(-1),
    TaskFailReason: new Uint8Array(maxEntities),
    TaskProgress: new Float32Array(maxEntities),
    GoalX: new Int32Array(maxEntities).fill(-1),
    GoalY: new Int32Array(maxEntities).fill(-1),
    PathIndex: new Int32Array(maxEntities),
  };
}
