import { query } from 'bitecs';
import { BuildingKind, ITEM_TYPES, type FactionId, type ItemType } from '../data/content';
import { buildingCost } from '../ecs/entities';
import { sortedQuery, type SimWorld } from '../ecs/world';

/**
 * Inventory & storage logistics (Milestone 2 slice).
 *
 * All material movement goes through explicit building inventories: every
 * stockpile-capable building (command centers plus player-built stockpiles)
 * stores per-item amounts under `components.Stock[item][eid]`, bounded by a
 * shared `StockpileCapacity`. Helpers here are pure and deterministic — they
 * read/write stock and carry only, never spawn entities.
 *
 * Construction funding: a blueprint's material cost is consumed from the
 * faction's stockpiles exactly once when demand funds the site; a failed
 * build task refunds it (see taskops). Consumption and refund both iterate
 * stockpiles in spawn order, so the outcome never depends on iteration
 * order or timestamps.
 *
 * Read: Stock*, StockpileCapacity, Blueprint*, Carry*. Write: Stock*,
 * BlueprintFunded, Carry*.
 */

/**
 * Every stockpile-capable building of a faction, in spawn order. Work
 * buildings (sawpits) keep their own input/output buffers and are excluded:
 * gatherers, eaters, and construction funding only touch real stockpiles.
 */
export function factionStockpiles(world: SimWorld, faction: FactionId): number[] {
  const c = world.components;
  return world.buildings.filter((b) => {
    if (c.Faction[b] !== faction) return false;
    if ((c.StockpileCapacity[b] ?? 0) <= 0) return false;
    const kind = c.BuildingKind[b] ?? BuildingKind.CommandCenter;
    return kind === BuildingKind.CommandCenter || kind === BuildingKind.Stockpile;
  });
}

export function stockAt(world: SimWorld, building: number, item: ItemType): number {
  return world.components.Stock[item][building] ?? 0;
}

/** Total stored units across every item type. */
export function stockUsed(world: SimWorld, building: number): number {
  const c = world.components;
  let used = 0;
  for (const item of ITEM_TYPES) {
    used += c.Stock[item][building] ?? 0;
  }
  return used;
}

export function stockRoom(world: SimWorld, building: number): number {
  return Math.max(
    0,
    (world.components.StockpileCapacity[building] ?? 0) - stockUsed(world, building),
  );
}

/** Add to one building's stock (caller guarantees room; never goes negative). */
export function addStock(world: SimWorld, building: number, item: ItemType, amount: number): void {
  const c = world.components;
  c.Stock[item][building] = (c.Stock[item][building] ?? 0) + amount;
}

export function removeStock(
  world: SimWorld,
  building: number,
  item: ItemType,
  amount: number,
): void {
  const c = world.components;
  c.Stock[item][building] = Math.max(0, (c.Stock[item][building] ?? 0) - amount);
}

export function factionStockOf(world: SimWorld, faction: FactionId, item: ItemType): number {
  let total = 0;
  for (const b of factionStockpiles(world, faction)) {
    total += stockAt(world, b, item);
  }
  return total;
}

export function factionStockUsed(world: SimWorld, faction: FactionId): number {
  let total = 0;
  for (const b of factionStockpiles(world, faction)) {
    total += stockUsed(world, b);
  }
  return total;
}

/** Total free room across the faction's stockpiles. */
export function factionStockRoom(world: SimWorld, faction: FactionId): number {
  let total = 0;
  for (const b of factionStockpiles(world, faction)) {
    total += stockRoom(world, b);
  }
  return total;
}

/**
 * Remove `amount` of `item` from the faction's stockpiles (spawn order).
 * Atomic: returns false without touching stock when the faction cannot cover
 * the full amount.
 */
export function consumeFactionStock(
  world: SimWorld,
  faction: FactionId,
  item: ItemType,
  amount: number,
): boolean {
  if (factionStockOf(world, faction, item) < amount) return false;
  let remaining = amount;
  for (const b of factionStockpiles(world, faction)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, stockAt(world, b, item));
    removeStock(world, b, item, take);
    remaining -= take;
  }
  return true;
}

/**
 * Add `amount` of `item` to the faction's stockpiles (spawn order, first with
 * room). Returns the amount actually stored (0 when everything is full).
 */
export function addFactionStock(
  world: SimWorld,
  faction: FactionId,
  item: ItemType,
  amount: number,
): number {
  let remaining = amount;
  for (const b of factionStockpiles(world, faction)) {
    if (remaining <= 0) break;
    const put = Math.min(remaining, stockRoom(world, b));
    addStock(world, b, item, put);
    remaining -= put;
  }
  return amount - remaining;
}

/** Nearest stockpile with at least `room` free units (spawn-order tie-break). */
export function nearestStockpileWithRoom(
  world: SimWorld,
  faction: FactionId,
  from: number,
  room: number,
): number {
  const c = world.components;
  const fx = c.Position.x[from] ?? 0;
  const fy = c.Position.y[from] ?? 0;
  let best = -1;
  let bestD = Infinity;
  for (const b of factionStockpiles(world, faction)) {
    if (stockRoom(world, b) < room) continue;
    const dx = (c.Position.x[b] ?? 0) - fx;
    const dy = (c.Position.y[b] ?? 0) - fy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Carry
// ---------------------------------------------------------------------------

/** Clear a citizen's carry (item + amount together; never leave a stale item). */
export function clearCarry(world: SimWorld, citizen: number): void {
  const c = world.components;
  c.CarryItem[citizen] = 0;
  c.CarryAmount[citizen] = 0;
}

// ---------------------------------------------------------------------------
// Construction funding
// ---------------------------------------------------------------------------

/**
 * Consume a blueprint's material cost from the faction's stockpiles. Returns
 * false (no side effects) when the faction cannot cover the full cost; the
 * site then waits unfunded until materials arrive.
 */
export function fundBlueprint(world: SimWorld, blueprint: number): boolean {
  const c = world.components;
  const faction = c.Faction[blueprint] as FactionId;
  const kind = c.BlueprintKind[blueprint] ?? 0;
  const cost = buildingCost(world.config, kind);
  for (const line of cost) {
    if (factionStockOf(world, faction, line.item) < line.amount) return false;
  }
  for (const line of cost) {
    consumeFactionStock(world, faction, line.item, line.amount);
  }
  c.BlueprintFunded[blueprint] = 1;
  return true;
}

/** Refund a funded blueprint's materials after a failed build task. */
export function refundBlueprint(world: SimWorld, blueprint: number): void {
  const c = world.components;
  if ((c.BlueprintFunded[blueprint] ?? 0) !== 1) return;
  const faction = c.Faction[blueprint] as FactionId;
  const kind = c.BlueprintKind[blueprint] ?? 0;
  for (const line of buildingCost(world.config, kind)) {
    addFactionStock(world, faction, line.item, line.amount);
  }
  c.BlueprintFunded[blueprint] = 0;
}

/**
 * First walkable tile adjacent to a building footprint (deterministic scan).
 * Walkable means passable terrain AND outside every building/blueprint
 * footprint: a goal inside another site would be unreachable — pathfinding
 * treats footprints as blocked (e.g. a hut blueprint hugging the sawpit's
 * east side must not become its delivery goal).
 */
export function adjacentGoal(world: SimWorld, building: number): [number, number] {
  const c = world.components;
  const bx = Math.floor(c.Position.x[building] ?? 0);
  const by = Math.floor(c.Position.y[building] ?? 0);
  const f = world.config.buildingFootprint;
  const candidates: readonly (readonly [number, number])[] = [
    [bx - 1, by],
    [bx + f, by],
    [bx, by - 1],
    [bx, by + f],
    [bx - 1, by + 1],
    [bx + f, by + 1],
  ];
  for (const [x, y] of candidates) {
    if (!world.tiles.isInside(x, y)) continue;
    const tile = world.tiles.index(x, y);
    if ((world.tiles.movementCost[tile] ?? 0) >= 75) continue; // water
    if (tileInsideFootprint(world, x, y)) continue;
    return [x, y];
  }
  return [bx, by];
}

/** True when a tile sits inside a building or blueprint footprint. */
function tileInsideFootprint(world: SimWorld, x: number, y: number): boolean {
  const c = world.components;
  const f = world.config.buildingFootprint;
  const footprints = [...world.buildings, ...sortedQuery(query(world, [c.Blueprint]))];
  for (const b of footprints) {
    const bx = Math.floor(c.Position.x[b] ?? -100);
    const by = Math.floor(c.Position.y[b] ?? -100);
    if (x >= bx && x < bx + f && y >= by && y < by + f) return true;
  }
  return false;
}

/** True when a resource node's tile sits inside a building/blueprint footprint. */
export function isNodeInsideFootprint(world: SimWorld, node: number): boolean {
  const c = world.components;
  const nx = Math.floor(c.Position.x[node] ?? -1);
  const ny = Math.floor(c.Position.y[node] ?? -1);
  const f = world.config.buildingFootprint;
  const footprints = [...world.buildings, ...sortedQuery(query(world, [c.Blueprint]))];
  for (const b of footprints) {
    const bx = Math.floor(c.Position.x[b] ?? -100);
    const by = Math.floor(c.Position.y[b] ?? -100);
    if (nx >= bx && nx < bx + f && ny >= by && ny < by + f) return true;
  }
  return false;
}
