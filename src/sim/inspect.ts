import { entityExists, query } from 'bitecs';
import { TASK_KIND_NAMES, TASK_PHASE_NAMES, TASK_STATE_NAMES } from '../shared/labels';
import type { InspectDetail } from '../shared/protocol';
import { BuildingKind, FactionId, ITEM_TYPES, NodeKind } from './data/content';
import { buildingCost } from './ecs/entities';
import { sortedQuery, type SimWorld } from './ecs/world';
import { factionStockOf } from './systems/inventory';
import { TERRAIN_NAMES } from './world/tiles';

export { BUILDING_NAMES, NODE_NAMES, CITIZEN_STATE_NAMES } from '../shared/labels';

/** What lives on the given tile (priority: citizen > building > node), or tile info. */
export function buildInspectDetail(world: SimWorld, tileIndex: number): InspectDetail {
  const c = world.components;
  const tileX = tileIndex % world.tiles.width;
  const tileY = Math.floor(tileIndex / world.tiles.width);

  const findAt = (eids: number[]): number =>
    eids.find(
      (e) =>
        entityExists(world, e) &&
        (c.Position.x[e] ?? -1) === tileX &&
        (c.Position.y[e] ?? -1) === tileY,
    ) ?? -1;

  // Buildings/blueprints span a footprint: clicking any tile of the footprint
  // inspects the entity (their Position is the top-left anchor tile).
  const f = world.config.buildingFootprint;
  const findFootprintAt = (eids: number[]): number =>
    eids.find((e) => {
      if (!entityExists(world, e)) return false;
      const bx = Math.floor(c.Position.x[e] ?? -1);
      const by = Math.floor(c.Position.y[e] ?? -1);
      return tileX >= bx && tileX < bx + f && tileY >= by && tileY < by + f;
    }) ?? -1;

  const citizen = findAt(sortedQuery(query(world, [c.Citizen])));
  if (citizen !== -1) {
    const task = c.TaskId[citizen] ?? -1;
    let taskText = 'none';
    if (task !== -1 && entityExists(world, task)) {
      const kind = c.TaskKind[task] ?? 0;
      const phase = c.TaskPhase[task] ?? 0;
      const state = c.TaskState[task] ?? 0;
      taskText = `${TASK_KIND_NAMES[kind] ?? 'task'} · ${TASK_PHASE_NAMES[phase] ?? phase} · ${TASK_STATE_NAMES[state] ?? state}`;
    }
    return {
      kind: 'citizen',
      eid: citizen,
      factionId: c.Faction[citizen] ?? FactionId.None,
      state: c.CitizenState[citizen] ?? 0,
      hunger: Math.round(c.Hunger[citizen] ?? 0),
      energy: Math.round(c.Energy[citizen] ?? 0),
      morale: Math.round(c.Morale[citizen] ?? 0),
      carry: c.CarryAmount[citizen] ?? 0,
      carryItem: c.CarryItem[citizen] ?? 0,
      taskText,
      x: tileX,
      y: tileY,
    };
  }

  const blueprint = findFootprintAt(sortedQuery(query(world, [c.Blueprint])));
  if (blueprint !== -1) {
    const kind = c.BlueprintKind[blueprint] ?? BuildingKind.Stockpile;
    const required =
      kind === BuildingKind.Stockpile ? world.config.stockpileWorkTicks : world.config.hutWorkTicks;
    const progress = Math.min(
      100,
      Math.round(((c.BlueprintProgress[blueprint] ?? 0) / Math.max(1, required)) * 100),
    );
    const funded = (c.BlueprintFunded[blueprint] ?? 0) === 1;
    const faction = c.Faction[blueprint] ?? FactionId.None;
    const cost: Record<number, number> = {};
    const missing: Record<number, number> = {};
    for (const line of buildingCost(world.config, kind)) {
      cost[line.item] = (cost[line.item] ?? 0) + line.amount;
      missing[line.item] =
        (missing[line.item] ?? 0) +
        Math.max(0, line.amount - factionStockOf(world, faction as FactionId, line.item));
    }
    return {
      kind: 'blueprint',
      eid: blueprint,
      factionId: faction,
      buildingKind: kind,
      progress,
      reserved: (c.BlueprintReservedBy[blueprint] ?? -1) !== -1,
      funded,
      cost,
      missing: funded ? {} : missing,
      x: tileX,
      y: tileY,
    };
  }

  const building = findFootprintAt(sortedQuery(query(world, [c.Building])));
  if (building !== -1) {
    const stock: Record<number, number> = {};
    for (const item of ITEM_TYPES) {
      stock[item] = c.Stock[item][building] ?? 0;
    }
    return {
      kind: 'building',
      eid: building,
      factionId: c.Faction[building] ?? FactionId.None,
      buildingKind: c.BuildingKind[building] ?? BuildingKind.CommandCenter,
      stock,
      capacity: c.StockpileCapacity[building] ?? 0,
      x: tileX,
      y: tileY,
    };
  }

  const node = findAt(sortedQuery(query(world, [c.ResourceNode])));
  if (node !== -1) {
    return {
      kind: 'node',
      eid: node,
      nodeKind: c.NodeKind[node] ?? NodeKind.Berries,
      amount: Math.round(c.NodeAmount[node] ?? 0),
      maxAmount: Math.round(c.NodeMax[node] ?? 0),
      x: tileX,
      y: tileY,
    };
  }

  return {
    kind: 'tile',
    terrain: world.tiles.terrain[tileIndex] ?? 0,
    ownerFactionId: world.owner[tileIndex] ?? FactionId.None,
    elevation: world.tiles.elevation[tileIndex] ?? 0,
    moisture: world.tiles.moisture[tileIndex] ?? 0,
  };
}

export function terrainName(terrain: number): string {
  return TERRAIN_NAMES[terrain as keyof typeof TERRAIN_NAMES] ?? 'unknown';
}
