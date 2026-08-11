import type { TileId } from '../../shared/ids';
import type { TileWorld } from '../world/world';

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Deterministic A* over the tile grid.
 *
 * - 4-neighbourhood; cost = movementCost/25 so slow terrain is penalized.
 * - Water (and deep water) are impassable (cost >= 75).
 * - The open set is a binary min-heap with a total order
 *   (f, g, tileId) so ties resolve identically every run.
 * - Returns the path from start (exclusive) to goal (inclusive), or null if
 *   the goal is unreachable within maxNodes expansions.
 */
export function findPath(
  tiles: TileWorld,
  start: TileId,
  goal: TileId,
  isBlocked: (tile: TileId) => boolean,
  maxNodes = 4096,
): TileId[] | null {
  if (start === goal) {
    return [];
  }
  if (isBlocked(goal)) {
    return null;
  }

  const { width, height } = tiles;
  const closed = new Uint8Array(tiles.tileCount);
  const gScore = new Float64Array(tiles.tileCount).fill(Infinity);
  const cameFrom = new Int32Array(tiles.tileCount).fill(-1);
  const heap = new MinHeap();

  gScore[start] = 0;
  heap.push({ tile: start, f: heuristic(start, goal, width), g: 0 });

  let expanded = 0;
  while (heap.size > 0 && expanded < maxNodes) {
    const current = heap.pop().tile;
    if (closed[current] === 1) {
      continue;
    }
    if (current === goal) {
      return reconstruct(cameFrom, start, goal);
    }
    closed[current] = 1;
    expanded++;

    const cx = current % width;
    const cy = Math.floor(current / width);
    const gCurrent = gScore[current] ?? Infinity;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }
      const nid = tiles.index(nx, ny) as number;
      if (closed[nid] === 1 || isBlocked(nid as TileId)) {
        continue;
      }
      const moveCost = (tiles.movementCost[nid] ?? 25) / 25;
      const tentative = gCurrent + moveCost;
      if (tentative < (gScore[nid] ?? Infinity)) {
        gScore[nid] = tentative;
        cameFrom[nid] = current;
        heap.push({ tile: nid, f: tentative + heuristic(nid, goal, width), g: tentative });
      }
    }
  }
  return null;
}

function heuristic(tile: number, goal: number, width: number): number {
  const tx = tile % width;
  const ty = Math.floor(tile / width);
  const gx = goal % width;
  const gy = Math.floor(goal / width);
  return Math.abs(tx - gx) + Math.abs(ty - gy); // Manhattan, admissible for 4-neighbour
}

function reconstruct(cameFrom: Int32Array, start: TileId, goal: TileId): TileId[] {
  const path: TileId[] = [];
  let cur: number = goal;
  while (cur !== -1 && cur !== start) {
    path.push(cur as TileId);
    cur = cameFrom[cur] ?? -1;
  }
  path.reverse();
  return path;
}

interface HeapNode {
  tile: number;
  f: number;
  g: number;
}

/** Binary min-heap with deterministic tie-break: (f, g, tileId). */
class MinHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(node, items[parent]!)) {
        items[i] = items[parent]!;
        i = parent;
      } else {
        break;
      }
    }
    items[i] = node;
  }

  pop(): HeapNode {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      let i = 0;
      let child = 1;
      while (child < items.length) {
        const right = child + 1;
        if (right < items.length && less(items[right]!, items[child]!)) {
          child = right;
        }
        if (less(items[child]!, last)) {
          items[i] = items[child]!;
          i = child;
          child = i * 2 + 1;
        } else {
          break;
        }
      }
      items[i] = last;
    }
    return top;
  }
}

function less(a: HeapNode, b: HeapNode): boolean {
  if (a.f !== b.f) {
    return a.f < b.f;
  }
  if (a.g !== b.g) {
    return a.g < b.g;
  }
  return a.tile < b.tile;
}
