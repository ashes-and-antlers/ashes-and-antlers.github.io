import { describe, expect, it } from 'vitest';
import type { GalaxyView } from '@ashes/contracts';
import {
  clampWindow,
  fitWindow,
  paintMap,
  pointToScreen,
  scaleWindow,
  screenToPoint,
} from './map-engine';

describe('map viewport engine', () => {
  const bounds = { minX: -100, minY: -50, maxX: 900, maxY: 450 };

  it('fits a world box to the viewport without distorting its aspect ratio', () => {
    const fitted = fitWindow(bounds, 2, 0);
    expect(fitted.maxX - fitted.minX).toBe(1_000);
    expect(fitted.maxY - fitted.minY).toBe(500);
    expect((fitted.maxX - fitted.minX) / (fitted.maxY - fitted.minY)).toBe(2);
  });

  it('zooms around the pointer instead of the canvas center', () => {
    const current = { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 };
    const zoomed = scaleWindow(current, 0.5, { x: 250, y: 750 });
    expect(zoomed.minX).toBe(125);
    expect(zoomed.maxX).toBe(625);
    expect(zoomed.minY).toBe(375);
    expect(zoomed.maxY).toBe(875);

    const point = screenToPoint(250, 250, zoomed, {
      left: 0,
      top: 0,
      width: 500,
      height: 500,
    });
    expect(point).toEqual({ x: 375, y: 625 });
  });

  it('clamps panning to the active level bounds', () => {
    const next = clampWindow({ minX: -200, minY: 100, maxX: 400, maxY: 400 }, bounds);
    expect(next).toEqual({ minX: -100, minY: 100, maxX: 500, maxY: 400 });
  });

  it('preserves a viewport larger than the bounds while keeping it centered', () => {
    const next = clampWindow({ minX: -500, minY: -300, maxX: 1_500, maxY: 700 }, bounds);
    expect(next).toEqual({ minX: -600, minY: -300, maxX: 1_400, maxY: 700 });
  });
});

/**
 * Canvas context double that records stroked arcs so tests can assert what
 * the sector renderer actually paints (rings vs. dots). Unused methods are
 * harmless no-ops.
 */
function fakeContext() {
  const strokeArcs: Array<{ x: number; y: number; radius: number }> = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    lineCap: '',
    lineJoin: '',
    pending: null as { x: number; y: number; radius: number } | null,
    clearRect() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
    fillText() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    beginPath() {
      this.pending = null;
    },
    arc(x: number, y: number, radius: number) {
      this.pending = { x, y, radius };
    },
    arcTo() {},
    closePath() {},
    stroke() {
      if (this.pending) strokeArcs.push(this.pending);
      this.pending = null;
    },
    fill() {
      this.pending = null;
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokeArcs };
}

/** One galaxy, one sector, one system with two planets on distinct orbits. */
function sectorView(): GalaxyView {
  return {
    worldId: 'world:1' as GalaxyView['worldId'],
    seed: 1,
    protocolVersion: 'protocol-1',
    config: { galaxies: 1, sectorsPerGalaxy: 1, systemsPerSector: 1, planetsPerSystem: 2 },
    homePlanetId: 'planet:1:1:1:1' as GalaxyView['homePlanetId'],
    bounds: { minX: -120, minY: -120, maxX: 120, maxY: 120 },
    galaxies: [{ galaxy: 1, position: { x: 0, y: 0 }, discRadius: 200 }],
    sectors: [
      {
        galaxy: 1,
        sector: 1,
        position: { x: 0, y: 0 },
        bounds: { minX: -120, minY: -120, maxX: 120, maxY: 120 },
        planetCount: 2,
      },
    ],
    systems: [{ galaxy: 1, sector: 1, system: 1, position: { x: 0, y: 0 } }],
    planets: [
      {
        id: 'planet:1:1:1:1' as GalaxyView['planets'][number]['id'],
        coordinate: { galaxy: 1, sector: 1, system: 1, planet: 1 },
        position: { x: 0, y: 40 },
        name: 'Alpha',
        factionId: null,
        classId: 'terrestrial',
        known: true,
      },
      {
        id: 'planet:1:1:1:2' as GalaxyView['planets'][number]['id'],
        coordinate: { galaxy: 1, sector: 1, system: 1, planet: 2 },
        position: { x: 30, y: 0 },
        name: 'Beta',
        factionId: null,
        classId: 'ocean',
        known: false,
      },
    ],
  };
}

describe('sector orbit rings', () => {
  it('draws a ring through every planet so worlds sit exactly on their orbits', () => {
    const view = sectorView();
    const win = fitWindow(view.sectors[0].bounds, 1, 0.05);
    const width = 400;
    const height = 400;
    const scale = (win.maxX - win.minX) / width;
    const { ctx, strokeArcs } = fakeContext();

    paintMap(ctx, view, new Map(), { kind: 'sector', galaxy: 1, sector: 1 }, win, width, height);

    for (const planet of view.planets) {
      const star = pointToScreen(view.systems[0].position, win, width, height);
      const expectedRadius =
        Math.hypot(
          planet.position.x - view.systems[0].position.x,
          planet.position.y - view.systems[0].position.y,
        ) / scale;
      const ring = strokeArcs.find(
        (arc) =>
          arc.x === star.x && arc.y === star.y && Math.abs(arc.radius - expectedRadius) < 1e-6,
      );
      expect(ring, `planet ${planet.id} must have a ring at its own orbit radius`).toBeTruthy();
    }
  });
});
