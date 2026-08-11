import { describe, expect, it } from 'vitest';
import type { TileId } from '../../src/shared/ids';
import { findPath } from '../../src/sim/path/astar';
import { makeSim } from '../helpers';

const SIZE = 48;

function landTiles(sim: ReturnType<typeof makeSim>): TileId[] {
  const tiles: TileId[] = [];
  for (let i = 0; i < sim.world.tiles.tileCount; i++) {
    if ((sim.world.tiles.movementCost[i] ?? 0) < 75) {
      tiles.push(i as TileId);
    }
  }
  return tiles;
}

function passable(sim: ReturnType<typeof makeSim>): (tile: TileId) => boolean {
  return (tile) => (sim.world.tiles.movementCost[tile] ?? 0) < 75;
}

/** findPath takes an isBlocked predicate — invert passability. */
function blockedBy(sim: ReturnType<typeof makeSim>): (tile: TileId) => boolean {
  return (tile) => !passable(sim)(tile);
}

/** BFS over passable tiles from `start`; the connected land component. */
function connectedLand(sim: ReturnType<typeof makeSim>, start: TileId): TileId[] {
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const cx = cur % SIZE;
    const cy = Math.floor(cur / SIZE);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
      const nid = nx + ny * SIZE;
      if (seen.has(nid)) continue;
      if ((sim.world.tiles.movementCost[nid] ?? 0) >= 75) continue;
      seen.add(nid);
      queue.push(nid);
    }
  }
  return [...seen] as TileId[];
}

describe('findPath', () => {
  it('finds a path between two connected land tiles', () => {
    const sim = makeSim({ seed: 8012, width: SIZE, height: SIZE });
    const start = landTiles(sim)[0]!;
    const connected = connectedLand(sim, start);
    const goal = connected[connected.length - 1]!;
    const path = findPath(sim.world.tiles, start, goal, blockedBy(sim));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    expect(path![0]).not.toBe(start);
    expect(path![path!.length - 1]).toBe(goal);
    for (const tile of path!) {
      expect(sim.world.tiles.movementCost[tile] ?? 0).toBeLessThan(75);
    }
  });

  it('returns an empty path when start equals goal', () => {
    const sim = makeSim({ seed: 8012, width: SIZE, height: SIZE });
    const tile = landTiles(sim)[0]!;
    expect(findPath(sim.world.tiles, tile, tile, blockedBy(sim))).toEqual([]);
  });

  it('routes around blocked tiles', () => {
    const sim = makeSim({ seed: 8012, width: SIZE, height: SIZE });
    const start = landTiles(sim)[0]!;
    const connected = connectedLand(sim, start);
    // Wall: block a vertical band across the map, leaving a gap at the bottom.
    const wall = new Set<number>();
    for (let y = 0; y < 40; y++) {
      for (let x = 24; x <= 26; x++) {
        wall.add(x + y * SIZE);
      }
    }
    const blocked = (tile: TileId): boolean => !passable(sim)(tile) || wall.has(tile);
    // Any connected tile beyond the wall (the wall never spans x > 26).
    const goal = connected.find((t) => t % SIZE > 26)!;
    expect(goal).toBeDefined();
    const path = findPath(sim.world.tiles, start, goal, blocked);
    expect(path).not.toBeNull();
    for (const tile of path!) {
      expect(wall.has(tile)).toBe(false);
    }
  });

  it('returns null when the start is completely walled off', () => {
    const sim = makeSim({ seed: 8012, width: SIZE, height: SIZE });
    const start = landTiles(sim)[0]!;
    const connected = connectedLand(sim, start);
    const goal = connected[connected.length - 1]!;
    const sx = start % SIZE;
    const sy = Math.floor(start / SIZE);
    const wall = new Set<number>();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = sx + dx;
      const ny = sy + dy;
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
        wall.add(nx + ny * SIZE);
      }
    }
    const blocked = (tile: TileId): boolean => !passable(sim)(tile) || wall.has(tile);
    expect(findPath(sim.world.tiles, start, goal, blocked)).toBeNull();
  });

  it('is deterministic: same inputs produce the same path', () => {
    const sim = makeSim({ seed: 8012, width: SIZE, height: SIZE });
    const start = landTiles(sim)[0]!;
    const connected = connectedLand(sim, start);
    const goal = connected[connected.length - 1]!;
    const a = findPath(sim.world.tiles, start, goal, blockedBy(sim));
    const b = findPath(sim.world.tiles, start, goal, blockedBy(sim));
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });
});
