import { addComponent, addEntity, removeEntity } from 'bitecs';
import { BuildingKind, CitizenState, EntityKind, FactionId, NodeKind } from '../data/content';
import type { SimConfig } from '../data/config';
import { TerrainType } from '../world/tiles';
import type { SimWorld } from './world';

/** Max tiles the deterministic spawn-scan will search before giving up. */
const MAX_SPAWN_SCAN = 24;

/** Spawn a faction command center (also serves as the faction stockpile in M1a). */
export function spawnCommandCenter(
  world: SimWorld,
  faction: FactionId,
  x: number,
  y: number,
): number {
  const c = world.components;
  const eid = addEntity(world);
  for (const comp of [c.Position, c.Kind, c.Faction, c.Building]) {
    addComponent(world, eid, comp);
  }
  c.Position.x[eid] = x;
  c.Position.y[eid] = y;
  c.Kind[eid] = EntityKind.CommandCenter;
  c.Faction[eid] = faction;
  c.BuildingKind[eid] = BuildingKind.CommandCenter;
  c.StockpileFood[eid] = world.config.startingFood;
  c.StockpileCapacity[eid] = world.config.stockpileCapacity;
  world.buildings.push(eid);
  return eid;
}

/** Total work ticks required to build `kind` (content-driven; see config). */
export function buildingWorkTicks(config: SimConfig, kind: BuildingKind): number {
  return kind === BuildingKind.Stockpile ? config.stockpileWorkTicks : config.hutWorkTicks;
}

/**
 * Spawn a construction-site blueprint. Position is the footprint's top-left
 * tile; every component field is initialized (eids are recycled, so stale
 * data must never leak through).
 */
export function spawnBlueprint(
  world: SimWorld,
  faction: FactionId,
  kind: BuildingKind,
  x: number,
  y: number,
): number {
  const c = world.components;
  const eid = addEntity(world);
  for (const comp of [c.Position, c.Kind, c.Faction, c.Blueprint]) {
    addComponent(world, eid, comp);
  }
  c.Position.x[eid] = x;
  c.Position.y[eid] = y;
  c.Kind[eid] = EntityKind.Blueprint;
  c.Faction[eid] = faction;
  c.BlueprintKind[eid] = kind;
  c.BlueprintProgress[eid] = 0;
  c.BlueprintReservedBy[eid] = -1;
  c.BlueprintFailTick[eid] = -1;
  return eid;
}

/**
 * Convert a finished blueprint into its building, exactly once. The blueprint
 * entity is destroyed and the new building takes its footprint, so no other
 * task can act on the site afterwards.
 */
export function spawnBuildingFromBlueprint(world: SimWorld, blueprint: number): number {
  const c = world.components;
  const kind = c.BlueprintKind[blueprint] ?? BuildingKind.Stockpile;
  const faction = c.Faction[blueprint] ?? FactionId.None;
  const x = c.Position.x[blueprint] ?? 0;
  const y = c.Position.y[blueprint] ?? 0;

  const eid = addEntity(world);
  for (const comp of [c.Position, c.Kind, c.Faction, c.Building]) {
    addComponent(world, eid, comp);
  }
  c.Position.x[eid] = x;
  c.Position.y[eid] = y;
  c.Kind[eid] = kind === BuildingKind.Stockpile ? EntityKind.Stockpile : EntityKind.Hut;
  c.Faction[eid] = faction;
  c.BuildingKind[eid] = kind;
  c.StockpileFood[eid] = 0;
  c.StockpileCapacity[eid] = kind === BuildingKind.Stockpile ? world.config.stockpileCapacity : 0;
  world.buildings.push(eid);

  removeEntity(world, blueprint);
  return eid;
}

/** Spawn citizens for every faction in a ring around their command center. */
export function spawnCitizens(world: SimWorld): void {
  const c = world.components;
  const config = world.config;
  for (const cc of world.commandCenters) {
    const faction = c.Faction[cc] as FactionId;
    const cx = c.Position.x[cc] ?? 0;
    const cy = c.Position.y[cc] ?? 0;
    const count = config.citizensPerFaction;
    for (let i = 0; i < count; i++) {
      // Deterministic ring placement (golden-angle-like spacing is fine here
      // because it only affects the starting arrangement, not authority).
      const angle = (i / count) * Math.PI * 2;
      const radius = 1 + (i % Math.max(1, config.spawnRadius - 1));
      const ix = Math.round(cx + 1.5 + Math.cos(angle) * radius);
      const iy = Math.round(cy + 1.5 + Math.sin(angle) * radius);
      // Clamp to a walkable tile that is not inside a building footprint
      // (deterministic outward scan; keeps spawns off water and off buildings).
      const [x, y] = nearestWalkableTile(world, ix, iy);
      spawnCitizen(world, faction, x, y, cc);
    }
  }
}

/**
 * Nearest tile to (ix, iy) that is walkable and not inside a building
 * footprint. Deterministic expanding-square scan — no randomness, so world
 * generation stays reproducible. Falls back to the input tile if none is
 * found (should not happen on generated maps).
 */
function nearestWalkableTile(world: SimWorld, ix: number, iy: number): [number, number] {
  const tiles = world.tiles;
  const isWalkable = (x: number, y: number): boolean => {
    if (!tiles.isInside(x, y)) return false;
    if ((tiles.movementCost[tiles.index(x, y)] ?? 0) >= 75) return false;
    // Skip any command-center footprint.
    for (const cc of world.commandCenters) {
      const bx = Math.floor(world.components.Position.x[cc] ?? 0);
      const by = Math.floor(world.components.Position.y[cc] ?? 0);
      const f = world.config.buildingFootprint;
      if (x >= bx && x < bx + f && y >= by && y < by + f) return false;
    }
    return true;
  };

  for (let r = 0; r <= MAX_SPAWN_SCAN; r++) {
    const x0 = ix - r;
    const y0 = iy - r;
    const x1 = ix + r;
    const y1 = iy + r;
    // Scan the perimeter of the square ring (top row, bottom row, sides).
    for (let x = x0; x <= x1; x++) {
      if (isWalkable(x, y0)) return [x, y0];
      if (isWalkable(x, y1)) return [x, y1];
    }
    for (let y = y0 + 1; y < y1; y++) {
      if (isWalkable(x0, y)) return [x0, y];
      if (isWalkable(x1, y)) return [x1, y];
    }
  }
  return [ix, iy];
}

export function spawnCitizen(
  world: SimWorld,
  faction: FactionId,
  x: number,
  y: number,
  homeId: number,
): number {
  const c = world.components;
  const eid = addEntity(world);
  for (const comp of [c.Position, c.Kind, c.Faction, c.Citizen]) {
    addComponent(world, eid, comp);
  }
  c.Position.x[eid] = x;
  c.Position.y[eid] = y;
  c.Kind[eid] = EntityKind.Citizen;
  c.Faction[eid] = faction;
  c.Hunger[eid] = 20;
  c.Energy[eid] = 80;
  c.Morale[eid] = 70;
  c.CarryFood[eid] = 0;
  c.CitizenState[eid] = CitizenState.Idle;
  c.TaskId[eid] = -1;
  c.HomeId[eid] = homeId;
  return eid;
}

/** Spawn resource nodes around a command center (deterministic row-major scan). */
export function spawnNodes(world: SimWorld, cx: number, cy: number): number[] {
  const config = world.config;
  const spawned: number[] = [];
  const half = config.nodeSearchRadius;
  const x0 = Math.max(1, Math.floor(cx) - half);
  const y0 = Math.max(1, Math.floor(cy) - half);
  const x1 = Math.min(world.tiles.width - 2, Math.floor(cx) + half + 2);
  const y1 = Math.min(world.tiles.height - 2, Math.floor(cy) + half + 2);

  let berries = 0;
  let stone = 0;
  for (let y = y0; y <= y1 && berries < config.nodesPerFaction; y++) {
    for (let x = x0; x <= x1 && berries < config.nodesPerFaction; x++) {
      const tile = world.tiles.index(x, y);
      const terrain = world.tiles.terrain[tile] ?? TerrainType.Grass;
      // Deterministic selection: moist land only (moisture is seeded noise).
      const moist = world.tiles.moisture[tile] ?? 0;
      if ((terrain === TerrainType.Forest || terrain === TerrainType.Grass) && moist >= 100) {
        const eid = spawnNode(world, NodeKind.Berries, x, y, config.berryMaxAmount);
        spawned.push(eid);
        berries++;
      }
    }
  }
  // A few decorative stone nodes on hills/rock for visual interest (non-functional in M1a).
  for (let y = y0; y <= y1 && stone < 2; y++) {
    for (let x = x0; x <= x1 && stone < 2; x++) {
      const tile = world.tiles.index(x, y);
      const terrain = world.tiles.terrain[tile] ?? TerrainType.Grass;
      if (terrain === TerrainType.Hill || terrain === TerrainType.Mountain) {
        const eid = spawnNode(world, NodeKind.Stone, x, y, 80);
        spawned.push(eid);
        stone++;
      }
    }
  }
  return spawned;
}

export function spawnNode(
  world: SimWorld,
  kind: NodeKind,
  x: number,
  y: number,
  maxAmount: number,
): number {
  const c = world.components;
  const eid = addEntity(world);
  for (const comp of [c.Position, c.Kind, c.ResourceNode]) {
    addComponent(world, eid, comp);
  }
  c.Position.x[eid] = x;
  c.Position.y[eid] = y;
  c.Kind[eid] =
    kind === NodeKind.Berries
      ? EntityKind.BerryNode
      : kind === NodeKind.Stone
        ? EntityKind.StoneNode
        : EntityKind.TreeNode;
  c.Faction[eid] = FactionId.None;
  c.NodeKind[eid] = kind;
  c.NodeAmount[eid] = maxAmount;
  c.NodeMax[eid] = maxAmount;
  c.NodeRegenTick[eid] = -1;
  c.NodeReservedBy[eid] = -1;
  return eid;
}
