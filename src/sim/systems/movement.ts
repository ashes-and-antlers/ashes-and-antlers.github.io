import { query } from 'bitecs';
import type { TileId } from '../../shared/ids';
import { CitizenState, TaskFailReason, TaskPhase } from '../data/content';
import { sortedQuery, type SimWorld } from '../ecs/world';
import { findPath } from '../path/astar';
import { failTask } from './taskops';

/** Footprint-covering entities: every finished building plus every blueprint. */
function footprintEntities(world: SimWorld): number[] {
  const c = world.components;
  return [...world.buildings, ...sortedQuery(query(world, [c.Blueprint]))];
}

/**
 * Movement system. Moves citizens one tile per tick along a cached A* path
 * toward their task's walk goal. Paths are derived state: always recomputed
 * from (position, goal, blocked tiles), never serialized or authoritative.
 *
 * Read: TaskId, TaskKind, TaskPhase, TaskGoalX/Y. Write: Position, Energy,
 * CitizenState, GoalX/Y, PathIndex, world.paths.
 */
export function runMovement(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  const { width } = world.tiles;

  rebuildBlockedTiles(world);

  const citizens = sortedQuery(query(world, [c.Citizen]));
  for (const eid of citizens) {
    const task = c.TaskId[eid] ?? -1;
    let gx = -1;
    let gy = -1;
    if (task !== -1) {
      const phase = c.TaskPhase[task] ?? TaskPhase.WalkToTarget;
      if (phase === TaskPhase.WalkToTarget || phase === TaskPhase.WalkToDeliver) {
        gx = c.TaskGoalX[task] ?? -1;
        gy = c.TaskGoalY[task] ?? -1;
      }
    }

    if (gx === -1 || gy === -1) {
      c.GoalX[eid] = -1;
      c.GoalY[eid] = -1;
      world.paths[eid] = null;
      c.PathIndex[eid] = 0;
      continue;
    }

    if (c.GoalX[eid] !== gx || c.GoalY[eid] !== gy) {
      c.GoalX[eid] = gx;
      c.GoalY[eid] = gy;
      world.paths[eid] = null;
      c.PathIndex[eid] = 0;
    }

    const cx = c.Position.x[eid] ?? 0;
    const cy = c.Position.y[eid] ?? 0;
    if (cx === gx && cy === gy) {
      world.paths[eid] = null;
      continue; // arrived; task execution advances the phase
    }

    let path = world.paths[eid];
    if (path === null) {
      path = findPath(
        world.tiles,
        world.tiles.index(Math.round(cx), Math.round(cy)),
        world.tiles.index(gx, gy),
        (tile) => isBlocked(world, tile),
        config.maxPathNodes,
      );
      world.paths[eid] = path;
      if (path === null) {
        if (task !== -1) {
          failTask(world, task, TaskFailReason.Unreachable);
        }
        continue;
      }
      c.PathIndex[eid] = 0;
    }

    let idx = c.PathIndex[eid] ?? 0;
    const next = path[idx];
    if (next === undefined) {
      world.paths[eid] = null;
      continue;
    }
    const nx = (next as number) % width;
    const ny = Math.floor((next as number) / width);
    if (isBlocked(world, next)) {
      world.paths[eid] = null; // invalidated; recompute next tick
      continue;
    }
    c.Position.x[eid] = nx;
    c.Position.y[eid] = ny;
    c.CitizenState[eid] = CitizenState.Moving;
    c.Energy[eid] -= config.energyMoveDrainPerTick;
    idx++;
    c.PathIndex[eid] = idx;
    if (idx >= path.length) {
      world.paths[eid] = null;
    }
  }
}

/** Mark building and blueprint footprints as blocked so pathfinding routes around them. */
function rebuildBlockedTiles(world: SimWorld): void {
  const c = world.components;
  world.blockedTiles.fill(0);
  const f = world.config.buildingFootprint;
  for (const e of footprintEntities(world)) {
    const bx = Math.floor(c.Position.x[e] ?? 0);
    const by = Math.floor(c.Position.y[e] ?? 0);
    for (let dy = 0; dy < f; dy++) {
      for (let dx = 0; dx < f; dx++) {
        if (world.tiles.isInside(bx + dx, by + dy)) {
          world.blockedTiles[world.tiles.index(bx + dx, by + dy)] = 1;
        }
      }
    }
  }
}

export function isBlocked(world: SimWorld, tile: TileId): boolean {
  const cost = world.tiles.movementCost[tile] ?? 0;
  if (cost >= 75) return true; // water / deep water
  return world.blockedTiles[tile] === 1;
}
