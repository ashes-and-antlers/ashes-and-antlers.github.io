import { addComponent, addEntity, createWorld, type World as BitWorld } from 'bitecs';
import type { TileId } from '../../shared/ids';
import { FactionId, FACTIONS, defaultStockpilePolicy, type SimAlert } from '../data/content';
import type { SimConfig } from '../data/config';
import { createSimComponents, MAX_ENTITIES, type SimComponents } from './components';
import { spawnCitizens, spawnCommandCenter, spawnNodes } from './entities';
import type { TileWorld } from '../world/world';

export interface SimStats {
  foodGathered: number;
  foodEaten: number;
  /** Wood + stone harvested (M2 materials economy). */
  materialsGathered: number;
  /** Crafting batches completed (M2 work buildings). */
  crafted: number;
  deaths: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Blueprints converted into finished buildings (counts each exactly once). */
  buildingsCompleted: number;
}

export interface SimWorldData {
  components: SimComponents;
  tiles: TileWorld;
  config: SimConfig;

  /** tile index -> FactionId (ownership overlay). */
  owner: Uint8Array;
  ownerVersion: number;
  /** Rebuilt each tick: 1 where a building occupies the tile. */
  blockedTiles: Uint8Array;
  /**
   * Per-faction stockpile policy: factionId -> itemType -> desired reserve the
   * logistics AI maintains. Food defaults from FACTION_META; materials start at
   * 0 so nothing is gathered until construction or a player-set reserve needs
   * it (M2 iteration 4). Mutated only by validated SetStockpileReserve commands.
   */
  reservePolicy: Record<number, Record<number, number>>;

  tick: number;
  /** Monotonic alert id generator. */
  alertSeq: number;
  commandCenters: number[];
  /** All finished buildings in spawn order (command centers first). */
  buildings: number[];
  nodes: number[];
  /** Transient A* path cache per entity (derived state, always recomputable). */
  paths: (readonly TileId[] | null)[];
  stats: SimStats;
  alertLog: SimAlert[];
  /** tick of last food-shortage alert per faction (indexed by FactionId). */
  lastFoodAlertTick: Int32Array;
  /** tick of last starvation alert per faction (rate-limited to avoid spam). */
  lastStarvationAlertTick: Int32Array;
}

export type SimWorld = BitWorld<SimWorldData> & SimWorldData;

export interface SpawnConfig {
  seed: number;
  tiles: TileWorld;
  simConfig: SimConfig;
  /** Deterministic spawn positions per faction (tile x,y) chosen by the caller. */
  homes: Record<FactionId, { x: number; y: number }>;
}

/** Create the bitECS world and populate the starting scene (M1 vertical slice). */
export function createSimWorld(spawn: SpawnConfig): SimWorld {
  const { tiles, simConfig, homes } = spawn;
  const world = createWorld({
    components: createSimComponents(),
    tiles,
    config: simConfig,
    owner: new Uint8Array(tiles.tileCount),
    ownerVersion: 0,
    blockedTiles: new Uint8Array(tiles.tileCount),
    reservePolicy: defaultStockpilePolicy(),
    tick: 0,
    alertSeq: 0,
    commandCenters: [],
    buildings: [],
    nodes: [],
    paths: new Array<readonly TileId[] | null>(MAX_ENTITIES).fill(null),
    stats: {
      foodGathered: 0,
      foodEaten: 0,
      materialsGathered: 0,
      crafted: 0,
      deaths: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      buildingsCompleted: 0,
    },
    alertLog: [],
    lastFoodAlertTick: new Int32Array(4),
    lastStarvationAlertTick: new Int32Array(4),
  }) as SimWorld;

  for (const faction of FACTIONS) {
    const home = homes[faction];
    const cc = spawnCommandCenter(world, faction, home.x, home.y);
    world.commandCenters.push(cc);
    world.nodes.push(...spawnNodes(world, home.x, home.y));
  }
  spawnCitizens(world);

  return world;
}

/** Position every faction's command center deterministically (land-anchored). */
export function pickHomeTiles(tiles: TileWorld): Record<FactionId, { x: number; y: number }> {
  const fx = (f: FactionId) => (f === FactionId.Hearth ? 0.25 : 0.75);
  const homes = {} as Record<FactionId, { x: number; y: number }>;
  for (const faction of FACTIONS) {
    const tx = Math.floor(tiles.width * fx(faction));
    const ty = Math.floor(tiles.height * 0.5);
    homes[faction] = findLandBlock(tiles, tx, ty, 20);
  }
  return homes;
}

/** Find a square block of passable land near (tx, ty); deterministic scan. */
function findLandBlock(
  tiles: TileWorld,
  tx: number,
  ty: number,
  maxDist: number,
): { x: number; y: number } {
  const half = Math.floor(maxDist / 2);
  const x0 = Math.max(0, tx - half);
  const y0 = Math.max(0, ty - half);
  const x1 = Math.min(tiles.width - 3, tx + half);
  const y1 = Math.min(tiles.height - 3, ty + half);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (isLandBlock(tiles, x, y)) {
        return { x, y };
      }
    }
  }
  // Fallback: center tile regardless (should never happen on generated maps).
  return { x: Math.min(tiles.width - 3, tx), y: Math.min(tiles.height - 3, ty) };
}

function isLandBlock(tiles: TileWorld, x: number, y: number): boolean {
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const tile = tiles.index(x + dx, y + dy);
      if (tiles.movementCost[tile] === undefined || tiles.movementCost[tile]! >= 75) {
        return false;
      }
    }
  }
  return true;
}

/** Deterministic ascending sort of a query result (bitECS iteration discipline). */
export function sortedQuery(queryResult: Iterable<number>): number[] {
  return [...queryResult].sort((a, b) => a - b);
}

export { addComponent, addEntity };
