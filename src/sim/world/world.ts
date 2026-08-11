import { tileIdOf, type TileId } from '../../shared/ids';

export interface WorldGenConfig {
  seed: number;
  width: number;
  height: number;
  /** Generator version; part of the determinism contract. */
  version: number;
}

export interface WorldFields {
  terrain: Uint8Array;
  elevation: Uint8Array;
  moisture: Uint8Array;
  fertility: Uint8Array;
  temperatureBand: Uint8Array;
  movementCost: Uint8Array;
}

/**
 * Columnar tile storage using typed arrays — the same shape later ECS
 * component stores will use. All fields are uint8.
 */
export class TileWorld {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly tileCount: number;

  readonly terrain: Uint8Array;
  readonly elevation: Uint8Array;
  readonly moisture: Uint8Array;
  readonly fertility: Uint8Array;
  readonly temperatureBand: Uint8Array;
  readonly movementCost: Uint8Array;

  constructor(config: WorldGenConfig, fields: WorldFields) {
    this.seed = config.seed;
    this.width = config.width;
    this.height = config.height;
    this.version = config.version;
    this.tileCount = config.width * config.height;

    const arrays = [
      fields.terrain,
      fields.elevation,
      fields.moisture,
      fields.fertility,
      fields.temperatureBand,
      fields.movementCost,
    ];
    for (const arr of arrays) {
      if (arr.length !== this.tileCount) {
        throw new Error(
          `TileWorld: component array length ${arr.length} != tileCount ${this.tileCount}`,
        );
      }
    }

    this.terrain = fields.terrain;
    this.elevation = fields.elevation;
    this.moisture = fields.moisture;
    this.fertility = fields.fertility;
    this.temperatureBand = fields.temperatureBand;
    this.movementCost = fields.movementCost;
  }

  /** Row-major tile index -> branded TileId. */
  index(x: number, y: number): TileId {
    return tileIdOf(x + y * this.width);
  }

  isInside(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }
}
