/** Terrain kinds. The numeric values are part of the snapshot wire format. */
export enum TerrainType {
  DeepWater = 0,
  Water = 1,
  Marsh = 2,
  Grass = 3,
  Forest = 4,
  Hill = 5,
  Mountain = 6,
}

export const TERRAIN_NAMES: Record<TerrainType, string> = {
  [TerrainType.DeepWater]: 'deep water',
  [TerrainType.Water]: 'water',
  [TerrainType.Marsh]: 'marsh',
  [TerrainType.Grass]: 'grass',
  [TerrainType.Forest]: 'forest',
  [TerrainType.Hill]: 'hill',
  [TerrainType.Mountain]: 'mountain',
};

/** Base RGB colors (0-255) for the renderer. */
export const TERRAIN_COLORS: Record<TerrainType, readonly [number, number, number]> = {
  [TerrainType.DeepWater]: [0x17, 0x24, 0x3a],
  [TerrainType.Water]: [0x2a, 0x4d, 0x8f],
  [TerrainType.Marsh]: [0x4e, 0x5f, 0x35],
  [TerrainType.Grass]: [0x5d, 0x8a, 0x3c],
  [TerrainType.Forest]: [0x2e, 0x5a, 0x2c],
  [TerrainType.Hill]: [0x8a, 0x7a, 0x52],
  [TerrainType.Mountain]: [0x9c, 0xa2, 0xaa],
};

/**
 * Movement cost stored as uint8 fixed point: value = cost/4 (deep water = 100).
 * Later milestones use this for pathfinding.
 */
export const TERRAIN_MOVEMENT_COST: Record<TerrainType, number> = {
  [TerrainType.DeepWater]: 100,
  [TerrainType.Water]: 75,
  [TerrainType.Marsh]: 60,
  [TerrainType.Grass]: 25,
  [TerrainType.Forest]: 35,
  [TerrainType.Hill]: 45,
  [TerrainType.Mountain]: 65,
};
