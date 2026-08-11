import { TICKS_PER_DAY } from '../../shared/constants';

/**
 * All tunable simulation constants live here (DEVELOPMENT_PLAN §5: content
 * must be data-driven; never hard-code balance in systems). Numbers are
 * deterministic float/int quantities.
 */
export interface SimConfig {
  // Population & spawn
  citizensPerFaction: number;
  /** Ring radius (tiles) around the command center where citizens spawn. */
  spawnRadius: number;
  /** Command center building footprint (square side in tiles). */
  buildingFootprint: number;

  // Needs
  hungerPerTick: number;
  eatThreshold: number;
  eatHungerRelief: number;
  starveAt: number;
  energyWorkDrainPerTick: number;
  energyMoveDrainPerTick: number;
  energyIdleRegenPerTick: number;
  restBelow: number;
  resumeWorkAt: number;
  moraleGainPerTick: number;
  moraleLossPerTick: number;

  // Economy (food)
  carryCapacity: number;
  stockpileCapacity: number;
  startingFood: number;
  berryMaxAmount: number;
  berryRegenPerTick: number;
  /** Ticks a depleted node stays empty before regrowing. */
  berryRegenDelayTicks: number;
  gatherPerTick: number;
  maxGatherTasksPerFaction: number;
  maxGatherersPerNode: number;

  // Construction (Milestone 1b)
  /** Blueprint progress gained per working tick. */
  buildWorkPerTick: number;
  /** Total work ticks to build a stockpile from a blueprint. */
  stockpileWorkTicks: number;
  /** Total work ticks to build a hut from a blueprint. */
  hutWorkTicks: number;
  /** Priority of build tasks on the task market (food demand outranks it). */
  buildTaskPriority: number;
  /** Ticks a failed build task blocks re-demand for the same blueprint. */
  buildRetryCooldownTicks: number;
  /** Max concurrent blueprints per faction (anti-spam guard). */
  maxBlueprintsPerFaction: number;

  // Movement
  speedTilesPerTick: number;
  maxPathNodes: number;

  // Ownership
  claimRadius: number;
  /** Ownership recompute interval in ticks. */
  ownershipEveryTicks: number;

  // Alerts
  foodAlertHungerLevel: number;
  foodAlertCooldownTicks: number;
  alertLogCapacity: number;

  // Worldgen placement
  /** Max berry nodes spawned per faction at startup. */
  nodesPerFaction: number;
  /** Search radius around a command center for node placement. */
  nodeSearchRadius: number;
}

export const SIM_CONFIG: SimConfig = {
  citizensPerFaction: 12,
  spawnRadius: 4,
  buildingFootprint: 3,

  hungerPerTick: 0.08, // ~24/day; starve in ~21 days without food
  eatThreshold: 50,
  eatHungerRelief: 40,
  starveAt: 100,
  energyWorkDrainPerTick: 0.02,
  energyMoveDrainPerTick: 0.012,
  energyIdleRegenPerTick: 0.05,
  restBelow: 25,
  resumeWorkAt: 60,
  moraleGainPerTick: 0.02,
  moraleLossPerTick: 0.05,

  carryCapacity: 8,
  stockpileCapacity: 100,
  startingFood: 20,
  berryMaxAmount: 60,
  berryRegenPerTick: 0.05, // full regrow in 20 minutes of sim time
  berryRegenDelayTicks: 100,
  gatherPerTick: 1,
  maxGatherTasksPerFaction: 4,
  maxGatherersPerNode: 2,

  buildWorkPerTick: 1,
  stockpileWorkTicks: 10,
  hutWorkTicks: 8,
  buildTaskPriority: 1,
  buildRetryCooldownTicks: 60,
  maxBlueprintsPerFaction: 6,

  speedTilesPerTick: 1,
  maxPathNodes: 4096,

  claimRadius: 12,
  ownershipEveryTicks: 5,

  foodAlertHungerLevel: 60,
  foodAlertCooldownTicks: 600,
  alertLogCapacity: 20,

  nodesPerFaction: 5,
  nodeSearchRadius: 24,
};

export const DAYS = { ticksPerDay: TICKS_PER_DAY };
