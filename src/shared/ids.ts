/** Branded integer id for a tile (row-major index into the world grid). */
export type TileId = number & { readonly __tileId: unique symbol };

export function tileIdOf(index: number): TileId {
  return index as TileId;
}
