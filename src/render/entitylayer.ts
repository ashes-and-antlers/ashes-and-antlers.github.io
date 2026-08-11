import { Container, Graphics } from 'pixi.js';
import { TILE_PX } from '../shared/constants';
import { CitizenState, EntityKind, FACTION_META } from '../sim/data/content';

const HALF = TILE_PX / 2;

/** Convert a hex color string to a Pixi color number. */
export function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

function factionColor(faction: number): number {
  return hexToNumber(FACTION_META[faction as keyof typeof FACTION_META]?.color ?? '#8b97a3');
}

/**
 * Draws all render entities into a single Graphics. Snapshot-driven, pooled
 * by construction (clear + redraw), so it is trivially deterministic and
 * cheap for the M1 entity counts. Replaced by sprite pooling if profiling
 * ever demands it.
 */
export class EntityLayer {
  readonly container = new Container();
  private readonly g = new Graphics();

  constructor() {
    this.container.addChild(this.g);
  }

  /** rows: Int32Array of 7 per entity: [eid, kind, faction, x, y, state, extra]. */
  update(rows: Int32Array, count: number): void {
    const g = this.g;
    g.clear();
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      const kind = rows[o + 1] ?? 0;
      const faction = rows[o + 2] ?? 0;
      const x = rows[o + 3] ?? 0;
      const y = rows[o + 4] ?? 0;
      const state = rows[o + 5] ?? 0;
      const extra = rows[o + 6] ?? 0;
      switch (kind) {
        case EntityKind.Citizen:
          this.drawCitizen(x * TILE_PX + HALF, y * TILE_PX + HALF, faction, state, extra);
          break;
        case EntityKind.CommandCenter:
          this.drawCommandCenter(x * TILE_PX, y * TILE_PX, faction);
          break;
        case EntityKind.Stockpile:
          this.drawStockpile(x * TILE_PX, y * TILE_PX, faction);
          break;
        case EntityKind.Hut:
          this.drawHut(x * TILE_PX, y * TILE_PX, faction);
          break;
        case EntityKind.Sawpit:
          this.drawSawpit(x * TILE_PX, y * TILE_PX, faction);
          break;
        case EntityKind.Blueprint:
          this.drawBlueprint(x * TILE_PX, y * TILE_PX, faction, extra);
          break;
        case EntityKind.BerryNode:
          this.drawBerries(x * TILE_PX + HALF, y * TILE_PX + HALF);
          break;
        case EntityKind.StoneNode:
          this.drawStone(x * TILE_PX + HALF, y * TILE_PX + HALF);
          break;
        case EntityKind.TreeNode:
          this.drawTree(x * TILE_PX + HALF, y * TILE_PX + HALF);
          break;
      }
    }
  }

  private drawCitizen(px: number, py: number, faction: number, state: number, carry: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const dim = state === CitizenState.Resting;
    const fill = dim ? 0x3a4350 : color;
    g.circle(px, py, 3.2).fill({ color: fill, alpha: 0.95 });
    g.circle(px, py, 3.2).stroke({ width: 1.2, color: 0x162218, alpha: 0.7 });
    if (state === CitizenState.Moving) {
      g.circle(px, py, 5).stroke({ width: 1, color, alpha: 0.6 });
    } else if (state === CitizenState.Eating) {
      g.circle(px, py, 5.4).stroke({ width: 1.2, color: 0xffffff, alpha: 0.85 });
    } else if (state === CitizenState.Working) {
      g.circle(px, py - 6, 1.4).fill({ color: 0xffffff, alpha: 0.9 });
    }
    if (carry > 0) {
      g.circle(px + 4, py + 4, 1.6).fill({ color: 0xc97844, alpha: 0.95 });
    }
  }

  private drawCommandCenter(px: number, py: number, faction: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const size = TILE_PX * 3;
    g.rect(px, py, size, size).fill({ color, alpha: 0.25 });
    g.rect(px, py, size, size).stroke({ width: 2.5, color });
    g.rect(px + 5, py + 5, size - 10, size - 10).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    g.circle(px + size / 2, py + size / 2, 4).fill({ color, alpha: 1 });
  }

  /** A player-built stockpile: bone plate with a faction seal and food store. */
  private drawStockpile(px: number, py: number, faction: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const size = TILE_PX * 3;
    g.rect(px, py, size, size).fill({ color: 0xd3c7ac, alpha: 0.16 });
    g.rect(px, py, size, size).stroke({ width: 1.5, color });
    g.rect(px + 6, py + 6, size - 12, size - 12).stroke({ width: 1, color: 0xd3c7ac, alpha: 0.5 });
    g.circle(px + size / 2, py + size / 2, 2.4).fill({ color, alpha: 1 });
  }

  /** A player-built hut: faction outline with a small roof mark. */
  private drawHut(px: number, py: number, faction: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const size = TILE_PX * 3;
    g.rect(px, py, size, size).fill({ color: 0xd3c7ac, alpha: 0.12 });
    g.rect(px, py, size, size).stroke({ width: 1.5, color });
    g.poly([px + 8, py + 5, px + size - 8, py + 5, px + size / 2, py + 17]).fill({
      color,
      alpha: 0.9,
    });
  }

  /** A player-built sawpit: faction plate with a crossed saw-blade mark. */
  private drawSawpit(px: number, py: number, faction: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const size = TILE_PX * 3;
    g.rect(px, py, size, size).fill({ color: 0xd3c7ac, alpha: 0.14 });
    g.rect(px, py, size, size).stroke({ width: 1.5, color });
    // Crossed saw blade: two diagonals with a notch.
    g.moveTo(px + 6, py + 6).lineTo(px + size - 6, py + size - 6);
    g.moveTo(px + size - 6, py + 6).lineTo(px + 6, py + size - 6);
    g.stroke({ width: 1.6, color, alpha: 0.9 });
    g.circle(px + size / 2, py + size / 2, 1.6).fill({ color, alpha: 1 });
  }

  /** A construction site: dashed ghost outline in faction color + progress strip. */
  private drawBlueprint(px: number, py: number, faction: number, progressPct: number): void {
    const g = this.g;
    const color = factionColor(faction);
    const size = TILE_PX * 3;
    const dash = 5;
    const gap = 3;
    // Dashed border: two horizontal + two vertical runs.
    for (let x = px; x < px + size; x += dash + gap) {
      g.moveTo(x, py).lineTo(Math.min(x + dash, px + size), py);
      g.moveTo(x, py + size).lineTo(Math.min(x + dash, px + size), py + size);
    }
    for (let y = py; y < py + size; y += dash + gap) {
      g.moveTo(px, y).lineTo(px, Math.min(y + dash, py + size));
      g.moveTo(px + size, y).lineTo(px + size, Math.min(y + dash, py + size));
    }
    g.stroke({ width: 1.4, color, alpha: 0.75 });
    g.rect(px + 3, py + size - 5, (size - 6) * (progressPct / 100), 2.5).fill({
      color,
      alpha: 0.9,
    });
  }

  private drawBerries(px: number, py: number): void {
    const g = this.g;
    g.circle(px - 3, py - 2, 1.8).fill({ color: 0xd94f4f });
    g.circle(px + 2, py - 3, 1.6).fill({ color: 0xd94f4f });
    g.circle(px, py + 2, 2).fill({ color: 0xc23b3b });
  }

  private drawStone(px: number, py: number): void {
    const g = this.g;
    g.poly([px, py - 5, px + 5, py, px, py + 5, px - 5, py]).fill({ color: 0x9aa0a8 });
    g.poly([px, py - 5, px + 5, py, px, py + 5, px - 5, py]).stroke({
      width: 1,
      color: 0x5c6268,
    });
  }

  private drawTree(px: number, py: number): void {
    const g = this.g;
    g.circle(px, py, 4).fill({ color: 0x2e6b2c });
    g.circle(px, py, 4).stroke({ width: 1, color: 0x1d451c });
  }
}
