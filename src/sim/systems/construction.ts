import { entityExists, query } from 'bitecs';
import {
  BuildingKind,
  CitizenState,
  FACTION_META,
  TaskFailReason,
  TaskKind,
  TaskPhase,
  FactionId,
} from '../data/content';
import { buildingWorkTicks, spawnBlueprint, spawnBuildingFromBlueprint } from '../ecs/entities';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { BUILDING_NAMES } from '../../shared/labels';
import { completeTask, createTask, failTask, isActiveTaskState } from './taskops';
import { pushAlert } from './needs';
import { adjacentGoal, fundBlueprint } from './inventory';

/**
 * Construction (Milestone 1b).
 *
 * - Placement: the player sends a PlaceBlueprint command; `placeBlueprint`
 *   validates deterministically (bounds, walkable land, no overlap, inside
 *   the faction's claim radius, blueprint cap) and spawns a Blueprint entity.
 * - Demand: every unreserved, funded blueprint without an active build task
 *   gets one Build task (one site, one task — the reservation prevents
 *   duplicates). A site is funded once from the faction's stockpiles (M2
 *   economy); unfunded sites wait with no task until materials arrive.
 * - Execution: the builder walks to the site, then works until progress
 *   reaches the building's work requirement; the blueprint is then converted
 *   into the finished building exactly once and the task completes.
 * - Failure: unreachable sites fail with Unreachable, refund their materials
 *   (see taskops), and enter a retry cooldown (BlueprintFailTick) so demand
 *   cannot spin every tick.
 *
 * Read: Blueprint*, Task*, Stock*, Position. Write: Blueprint*, Task*,
 * Stock*, Building list, stats, alert log.
 */

export type PlacementResult = { ok: true } | { ok: false; reason: string };

const BUILDABLE_KINDS: readonly BuildingKind[] = [
  BuildingKind.Stockpile,
  BuildingKind.Hut,
  BuildingKind.Sawpit,
];

/** Deterministic validation of a blueprint placement. Returns null when valid. */
export function canPlaceBlueprint(
  world: SimWorld,
  faction: FactionId,
  kind: BuildingKind,
  x: number,
  y: number,
): string | null {
  const c = world.components;
  const config = world.config;
  if (faction !== FactionId.Hearth && faction !== FactionId.IronSwarm) {
    return 'bad-faction';
  }
  if (!BUILDABLE_KINDS.includes(kind)) {
    return 'bad-kind';
  }
  const f = config.buildingFootprint;
  if (x < 0 || y < 0 || x + f > world.tiles.width || y + f > world.tiles.height) {
    return 'out-of-bounds';
  }
  for (let dy = 0; dy < f; dy++) {
    for (let dx = 0; dx < f; dx++) {
      const tile = world.tiles.index(x + dx, y + dy);
      if ((world.tiles.movementCost[tile] ?? 0) >= 75) {
        return 'terrain';
      }
    }
  }
  // No overlap with any existing building or blueprint footprint.
  const existing = [...world.buildings, ...sortedQuery(query(world, [c.Blueprint]))];
  for (const e of existing) {
    const bx = Math.floor(c.Position.x[e] ?? -100);
    const by = Math.floor(c.Position.y[e] ?? -100);
    if (Math.max(Math.abs(bx - x), Math.abs(by - y)) < f) {
      return 'occupied';
    }
  }
  // Inside the faction's claim radius (measured from the footprint center).
  const cx = x + Math.floor(f / 2);
  const cy = y + Math.floor(f / 2);
  let claimed = false;
  for (const cc of world.commandCenters) {
    if (c.Faction[cc] !== faction) continue;
    const dx = Math.abs((c.Position.x[cc] ?? 0) - cx);
    const dy = Math.abs((c.Position.y[cc] ?? 0) - cy);
    if (Math.max(dx, dy) <= config.claimRadius) {
      claimed = true;
      break;
    }
  }
  if (!claimed) {
    return 'outside-claim';
  }
  const active = sortedQuery(query(world, [c.Blueprint])).filter(
    (bp) => c.Faction[bp] === faction,
  ).length;
  if (active >= config.maxBlueprintsPerFaction) {
    return 'max-blueprints';
  }
  return null;
}

/**
 * Place a blueprint. Deterministic: same call, same world, same result.
 * `priority` (1 low / 2 normal / 3 high) defaults to the configured value;
 * any explicit value outside the configured bounds is rejected so the
 * command stream stays validated (the HUD surfaces `bad-priority`).
 */
export function placeBlueprint(
  world: SimWorld,
  faction: FactionId,
  kind: BuildingKind,
  x: number,
  y: number,
  priority?: number,
): PlacementResult {
  const p = priority ?? world.config.defaultBlueprintPriority;
  if (
    !Number.isInteger(p) ||
    p < world.config.minBlueprintPriority ||
    p > world.config.maxBlueprintPriority
  ) {
    return { ok: false, reason: 'bad-priority' };
  }
  const reason = canPlaceBlueprint(world, faction, kind, x, y);
  if (reason !== null) {
    return { ok: false, reason };
  }
  spawnBlueprint(world, faction, kind, x, y, p);
  return { ok: true };
}

/**
 * Demand: one Build task per unreserved, unbuilt, funded blueprint.
 *
 * Sites are processed in construction priority order (highest first, then
 * lowest blueprint eid) so scarce materials fund high-priority sites before
 * low-priority ones, and the build task carries a priority derived from the
 * blueprint's own (buildTaskPriority ± step per priority level) so scarce
 * builders claim urgent sites first.
 */
export function runBuildDemand(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const blueprints = [...sortedQuery(query(world, [c.Blueprint]))].sort((a, b) => {
    const pa = c.BlueprintPriority[a] ?? config.defaultBlueprintPriority;
    const pb = c.BlueprintPriority[b] ?? config.defaultBlueprintPriority;
    return pb - pa || a - b;
  });
  for (const bp of blueprints) {
    if ((c.BlueprintReservedBy[bp] ?? -1) !== -1) continue;
    if (hasActiveBuildTask(world, bp)) continue;
    const failTick = c.BlueprintFailTick[bp] ?? -1;
    if (failTick !== -1 && world.tick - failTick < config.buildRetryCooldownTicks) continue;
    // Fund the site exactly once from the faction's stockpiles; an unfunded
    // site waits (no task) until its materials arrive (M2 economy).
    if ((c.BlueprintFunded[bp] ?? 0) !== 1 && !fundBlueprint(world, bp)) continue;
    const priority = c.BlueprintPriority[bp] ?? config.defaultBlueprintPriority;
    const taskPriority =
      config.buildTaskPriority +
      (priority - config.defaultBlueprintPriority) * config.buildPriorityStep;
    // adjacentGoal rejects tiles inside any building/blueprint footprint (a
    // site hugging its neighbor must not pick a goal that later becomes
    // unreachable once movement rebuilds the blocked-tile map).
    const [gx, gy] = adjacentGoal(world, bp);
    createTask(world, TaskKind.Build, c.Faction[bp] as FactionId, bp, gx, gy, taskPriority);
  }
}

/**
 * Execution: WalkToTarget -> Work. Each working tick advances the blueprint;
 * at completion the site converts to a building exactly once and the task
 * completes (the blueprint entity is destroyed, so nothing can re-claim it).
 */
export function executeBuild(world: SimWorld, task: number, worker: number): void {
  const c = world.components;
  const config = world.config;
  const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
  const bp = c.TaskTarget[task];

  if (!entityExists(world, bp)) {
    failTask(world, task, TaskFailReason.Depleted);
    return;
  }

  if (phase === TaskPhase.WalkToTarget) {
    if (!atTaskGoal(world, worker, task)) return;
    c.TaskPhase[task] = TaskPhase.Work;
    return;
  }

  if (phase === TaskPhase.Work) {
    c.BlueprintProgress[bp] = (c.BlueprintProgress[bp] ?? 0) + config.buildWorkPerTick;
    c.TaskProgress[task] = (c.TaskProgress[task] ?? 0) + config.buildWorkPerTick;
    c.CitizenState[worker] = CitizenState.Working;
    const required = buildingWorkTicks(config, c.BlueprintKind[bp] ?? BuildingKind.Stockpile);
    if ((c.BlueprintProgress[bp] ?? 0) >= required) {
      convertBlueprint(world, bp);
      completeTask(world, task);
    }
  }
}

/** Convert a finished blueprint into its building; fires an info alert. */
function convertBlueprint(world: SimWorld, blueprint: number): void {
  const c = world.components;
  const faction = c.Faction[blueprint] as FactionId;
  const kind = c.BlueprintKind[blueprint] ?? BuildingKind.Stockpile;
  spawnBuildingFromBlueprint(world, blueprint); // removes the blueprint entity
  world.stats.buildingsCompleted++;
  const kindName = (BUILDING_NAMES[kind] ?? 'building').toLowerCase();
  pushAlert(world, {
    code: 'construction.complete',
    severity: 0,
    factionId: faction,
    text: `${FACTION_META[faction].name} finished a ${kindName}.`,
  });
}

function hasActiveBuildTask(world: SimWorld, blueprint: number): boolean {
  const c = world.components;
  const tasks = sortedQuery(query(world, [c.Task]));
  for (const t of tasks) {
    if (
      c.TaskKind[t] === TaskKind.Build &&
      c.TaskTarget[t] === blueprint &&
      isActiveTaskState(c.TaskState[t] ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

function atTaskGoal(world: SimWorld, worker: number, task: number): boolean {
  const c = world.components;
  return c.Position.x[worker] === c.TaskGoalX[task] && c.Position.y[worker] === c.TaskGoalY[task];
}
