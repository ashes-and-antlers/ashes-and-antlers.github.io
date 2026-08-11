import { Sprite, Texture } from 'pixi.js';
import { TILE_PX } from '../shared/constants';
import { FACTION_META, FactionId } from '../sim/data/content';
import { hexToNumber } from './entitylayer';

/**
 * Ownership overlay: a per-tile tint sprite above the terrain, below entities.
 * Neutral tiles are transparent; owned tiles show the faction color at
 * sprite-level alpha so terrain detail stays readable.
 */
export class OwnershipLayer {
  readonly sprite: Sprite;

  private canvas = document.createElement('canvas');
  private texture: Texture;
  private width = 0;
  private height = 0;
  private ownerData: Uint8Array | null = null;

  constructor() {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.texture = Texture.from(this.canvas);
    this.texture.source.scaleMode = 'nearest';
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(TILE_PX);
    this.sprite.alpha = 0.38;
    this.sprite.visible = false;
  }

  setOwnerTiles(owner: Uint8Array, width: number, height: number): void {
    if (width !== this.width || height !== this.height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.width = width;
      this.height = height;
    }
    this.ownerData = owner;
    this.redraw();
  }

  setVisible(visible: boolean): void {
    this.sprite.visible = visible;
  }

  private redraw(): void {
    if (!this.ownerData) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(this.width, this.height);
    const data = image.data;
    for (let i = 0; i < this.ownerData.length; i++) {
      const faction = this.ownerData[i] ?? FactionId.None;
      const o = i * 4;
      if (faction === FactionId.None) {
        data[o + 3] = 0;
        continue;
      }
      const color = FACTION_META[faction as keyof typeof FACTION_META]?.color ?? '#ffffff';
      const rgb = hexToNumber(color);
      data[o] = (rgb >> 16) & 0xff;
      data[o + 1] = (rgb >> 8) & 0xff;
      data[o + 2] = rgb & 0xff;
      data[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    this.texture.source.update();
  }
}
