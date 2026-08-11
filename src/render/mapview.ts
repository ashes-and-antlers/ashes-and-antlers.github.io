import { Container, Graphics, Sprite, Texture, type Application } from 'pixi.js';
import { TILE_PX } from '../shared/constants';
import { TerrainType, TERRAIN_COLORS } from '../sim/world/tiles';
import { EntityLayer } from './entitylayer';
import { OwnershipLayer } from './ownershiplayer';

export interface DecodedTile {
  terrain: TerrainType;
  elevation: number;
}

/** Decode a snapshot tile byte: 3 bits terrain, 5 bits elevation. */
export function decodeTileByte(byte: number): DecodedTile {
  return { terrain: (byte >> 5) as TerrainType, elevation: (byte & 0x1f) << 3 };
}

/** Rasterize the packed tile array into an offscreen canvas (one pixel per tile). */
export function renderTileImage(
  packed: Uint8Array,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('MapView: 2d canvas context unavailable');
  }
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let i = 0; i < packed.length; i++) {
    const { terrain, elevation } = decodeTileByte(packed[i] ?? 0);
    const color = TERRAIN_COLORS[terrain] ?? TERRAIN_COLORS[TerrainType.Grass];
    const shade = 0.78 + (elevation / 255) * 0.32;
    const o = i * 4;
    data[o] = Math.min(255, Math.round(color[0] * shade));
    data[o + 1] = Math.min(255, Math.round(color[1] * shade));
    data[o + 2] = Math.min(255, Math.round(color[2] * shade));
    data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Renders the world as a single pixelated terrain sprite, an ownership
 * overlay, an entity layer, and an optional debug grid. Pan/zoom is handled
 * by CameraController.
 */
export class MapView {
  readonly container = new Container();

  private readonly terrainLayer = new Container();
  private readonly ownershipLayer = new OwnershipLayer();
  private readonly entityLayer = new EntityLayer();
  private readonly grid: Graphics = new Graphics();

  private terrainSprite: Sprite | null = null;
  private gridEnabled = false;
  private worldWidth = 0;
  private worldHeight = 0;

  constructor() {
    this.terrainLayer.addChild(this.grid);
    this.container.addChild(this.terrainLayer);
    this.container.addChild(this.ownershipLayer.sprite);
    this.container.addChild(this.entityLayer.container);
  }

  get naturalWidth(): number {
    return this.worldWidth * TILE_PX;
  }

  get naturalHeight(): number {
    return this.worldHeight * TILE_PX;
  }

  setTiles(packed: Uint8Array, width: number, height: number): void {
    this.worldWidth = width;
    this.worldHeight = height;

    if (this.terrainSprite) {
      this.terrainSprite.destroy({ texture: true });
      this.terrainSprite = null;
    }
    const canvas = renderTileImage(packed, width, height);
    const texture = Texture.from(canvas);
    texture.source.scaleMode = 'nearest';
    const sprite = new Sprite(texture);
    sprite.scale.set(TILE_PX);
    this.terrainSprite = sprite;
    this.terrainLayer.addChildAt(sprite, 0);
  }

  setOwnerTiles(owner: Uint8Array, width: number, height: number): void {
    this.ownershipLayer.setOwnerTiles(owner, width, height);
  }

  setOwnerVisible(visible: boolean): void {
    this.ownershipLayer.setVisible(visible);
  }

  setEntities(rows: Int32Array, count: number): void {
    this.entityLayer.update(rows, count);
  }

  /** Toggle the debug grid; returns the new state. `zoom` keeps line widths consistent. */
  toggleGrid(zoom: number): boolean {
    this.gridEnabled = !this.gridEnabled;
    this.grid.visible = this.gridEnabled;
    this.updateGrid(zoom);
    return this.gridEnabled;
  }

  /** Rebuild the grid with line widths that stay ~1px at the given zoom. */
  updateGrid(zoom: number): void {
    if (!this.gridEnabled || this.worldWidth === 0) {
      return;
    }
    const w = this.naturalWidth;
    const h = this.naturalHeight;
    const width = 1 / zoom;
    const g = this.grid;
    g.clear();
    g.moveTo(0, 0)
      .lineTo(w, 0)
      .lineTo(w, h)
      .lineTo(0, h)
      .lineTo(0, 0)
      .stroke({ width, color: 0xffffff, alpha: 0.25 });
    for (let x = 1; x < this.worldWidth; x++) {
      g.moveTo(x * TILE_PX, 0).lineTo(x * TILE_PX, h);
    }
    g.stroke({ width, color: 0xffffff, alpha: 0.08 });
    for (let y = 1; y < this.worldHeight; y++) {
      g.moveTo(0, y * TILE_PX).lineTo(w, y * TILE_PX);
    }
    g.stroke({ width, color: 0xffffff, alpha: 0.08 });
  }
}

/**
 * Pointer-driven camera: drag to pan, wheel to zoom around the cursor.
 * A click (press + release without dragging) fires onTileClick with the
 * tile index under the cursor.
 */
export class CameraController {
  private zoom = 1;
  private readonly minZoom = 0.15;
  private readonly maxZoom = 12;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private moved = 0;
  private worldWidth = 0;
  private worldHeight = 0;

  constructor(
    private readonly app: Application,
    private readonly target: Container,
    private readonly onZoomChange: (zoom: number) => void,
    private readonly onTileClick: (tile: number) => void,
  ) {
    const canvas = app.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.moved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.downX = e.clientX;
      this.downY = e.clientY;
      canvas.classList.add('is-dragging');
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.target.x += dx;
      this.target.y += dy;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const stopDrag = (e: PointerEvent) => {
      this.dragging = false;
      canvas.classList.remove('is-dragging');
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      if (this.moved < 6) {
        const tile = this.screenToTile(this.downX, this.downY);
        if (tile !== null) {
          this.onTileClick(tile);
        }
      }
    };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0015, -e.deltaY));
      },
      { passive: false },
    );
  }

  get currentZoom(): number {
    return this.zoom;
  }

  /** Map a screen point (CSS px relative to the canvas) to a tile index, if inside. */
  screenToTile(screenX: number, screenY: number): number | null {
    const wx = (screenX - this.target.x) / this.zoom;
    const wy = (screenY - this.target.y) / this.zoom;
    const tx = Math.floor(wx / TILE_PX);
    const ty = Math.floor(wy / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= this.worldWidth || ty >= this.worldHeight) {
      return null;
    }
    return tx + ty * this.worldWidth;
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    if (next === this.zoom) return;
    const worldX = (screenX - this.target.x) / this.zoom;
    const worldY = (screenY - this.target.y) / this.zoom;
    this.zoom = next;
    this.target.scale.set(this.zoom);
    this.target.x = screenX - worldX * this.zoom;
    this.target.y = screenY - worldY * this.zoom;
    this.onZoomChange(this.zoom);
  }

  /** Frame the whole map inside the viewport. */
  fitView(naturalWidth: number, naturalHeight: number, margin = 0.9): void {
    const view = this.app.canvas.getBoundingClientRect();
    const scale = Math.min(
      (view.width * margin) / naturalWidth,
      (view.height * margin) / naturalHeight,
    );
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, scale));
    this.target.scale.set(this.zoom);
    this.target.x = (view.width - naturalWidth * this.zoom) / 2;
    this.target.y = (view.height - naturalHeight * this.zoom) / 2;
    this.worldWidth = Math.round(naturalWidth / TILE_PX);
    this.worldHeight = Math.round(naturalHeight / TILE_PX);
    this.onZoomChange(this.zoom);
  }
}
