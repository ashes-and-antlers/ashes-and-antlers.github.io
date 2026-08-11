import { query } from 'bitecs';
import type { Calendar } from '../../shared/protocol';
import { fnv1aBytes } from '../../shared/utils';
import { SIM_CONFIG } from '../data/config';
import { ITEM_TYPES, type BuildingKind, type FactionId } from '../data/content';
import { createSimWorld, pickHomeTiles, sortedQuery, type SimWorld } from '../ecs/world';
import { generateWorld } from '../world/generation';
import type { TileWorld, WorldGenConfig } from '../world/world';
import { calendarAt } from './calendar';
import { computeTerrainHash } from './hash';
import { runSystems } from '../systems/run';
import {
  placeBlueprint as placeBlueprintInWorld,
  type PlacementResult,
} from '../systems/construction';

/**
 * Milestone 1 simulation: owns the tile world and the bitECS entity world,
 * and runs the deterministic system schedule on every fixed tick.
 */
export class Simulation {
  readonly tiles: TileWorld;
  readonly world: SimWorld;

  private readonly terrainHash_: number;
  private tick_ = 0;
  private signal_ = 0;

  constructor(config: WorldGenConfig) {
    this.tiles = generateWorld(config);
    this.terrainHash_ = computeTerrainHash(this.tiles);
    const homes = pickHomeTiles(this.tiles);
    this.world = createSimWorld({
      seed: config.seed,
      tiles: this.tiles,
      simConfig: SIM_CONFIG,
      homes,
    });
  }

  /** Run exactly `count` fixed ticks. Never call with a non-integer. */
  step(count: number): void {
    for (let i = 0; i < count; i++) {
      this.tick_++;
      this.world.tick = this.tick_;
      runSystems(this.world);
      this.signal_ = (Math.imul(this.signal_, 31) + 7) >>> 0;
    }
  }

  /**
   * Validate and place a player blueprint (top-left anchor tile). Deterministic:
   * the same ordered command stream reproduces the same world. Returns the
   * reason string when the placement is rejected.
   */
  placeBlueprint(
    faction: FactionId,
    building: BuildingKind,
    x: number,
    y: number,
    priority?: number,
  ): PlacementResult {
    return placeBlueprintInWorld(this.world, faction, building, x, y, priority);
  }

  get tick(): number {
    return this.tick_;
  }

  get signal(): number {
    return this.signal_;
  }

  terrainHash(): number {
    return this.terrainHash_;
  }

  calendar(): Calendar {
    return calendarAt(this.tick_);
  }

  /**
   * Deterministic content hash over all authoritative entity state.
   * Equal for two runs with the same seed and command stream.
   */
  stateHash(): number {
    const w = this.world;
    const c = w.components;
    const bytes: number[] = [];
    const push = (n: number): void => {
      bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    };

    push(this.tick_);
    push(w.stats.foodGathered);
    push(w.stats.foodEaten);
    push(w.stats.materialsGathered);
    push(w.stats.crafted);
    push(w.stats.deaths);
    push(w.stats.tasksCompleted);
    push(w.stats.tasksFailed);
    push(w.stats.buildingsCompleted);

    const quant = (f: number): number => Math.round((f ?? 0) * 100);
    for (const e of sortedQuery(query(w, [c.Citizen]))) {
      push(e);
      push(c.Position.x[e] ?? 0);
      push(c.Position.y[e] ?? 0);
      push(quant(c.Hunger[e]));
      push(quant(c.Energy[e]));
      push(quant(c.Morale[e]));
      push(c.CarryItem[e] ?? 0);
      push(c.CarryAmount[e] ?? 0);
      push(c.TaskId[e] ?? -1);
      push(c.CitizenState[e] ?? 0);
    }
    for (const e of sortedQuery(query(w, [c.Building]))) {
      push(e);
      push(c.Position.x[e] ?? 0);
      push(c.Position.y[e] ?? 0);
      push(c.Faction[e] ?? 0);
      for (const item of ITEM_TYPES) {
        push(c.Stock[item][e] ?? 0);
      }
    }
    for (const e of sortedQuery(query(w, [c.ResourceNode]))) {
      push(e);
      push(c.Position.x[e] ?? 0);
      push(c.Position.y[e] ?? 0);
      push(c.NodeKind[e] ?? 0);
      push(quant(c.NodeAmount[e]));
    }
    for (const e of sortedQuery(query(w, [c.Blueprint]))) {
      push(e);
      push(c.Position.x[e] ?? 0);
      push(c.Position.y[e] ?? 0);
      push(c.Faction[e] ?? 0);
      push(c.BlueprintKind[e] ?? 0);
      push(c.BlueprintPriority[e] ?? 0);
      push(quant(c.BlueprintProgress[e]));
      push(c.BlueprintReservedBy[e] ?? -1);
      push(c.BlueprintFunded[e] ?? 0);
    }
    for (const e of sortedQuery(query(w, [c.Task]))) {
      push(e);
      push(c.TaskKind[e] ?? 0);
      push(c.TaskState[e] ?? 0);
      push(c.TaskPhase[e] ?? 0);
      push(c.TaskTarget[e] ?? -1);
      push(c.TaskItem[e] ?? 0);
      push(c.TaskSource[e] ?? -1);
      push(c.TaskClaimedBy[e] ?? -1);
      push(quant(c.TaskPriority[e]));
    }
    for (let i = 0; i < w.owner.length; i++) {
      bytes.push(w.owner[i] ?? 0);
    }
    return fnv1aBytes(Uint8Array.from(bytes));
  }
}
