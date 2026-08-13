import { MAP_SKY, PLANET_CLASSES } from '@ashes/content';
import type { GalaxyView, MapPosition } from '@ashes/contracts';
import type { GalaxySky } from './sky';

export type MapLevel =
  | { kind: 'chart' }
  | { kind: 'galaxy'; galaxy: number }
  | { kind: 'sector'; galaxy: number; sector: number };

export type MapWindow = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const PLANET_COLORS = new Map(PLANET_CLASSES.map((planet) => [planet.key, planet.mapColor]));
const STAR_WHITE = '#dbe5f2';
const ICE = '#a8c9f0';
const INK = '#0a0e14';
const GRID = 'rgba(147, 162, 184, 0.11)';
const GRID_MAJOR = 'rgba(168, 201, 240, 0.16)';
const SYSTEM_GOLD = '#e8a13b';

export function makeViewBox(win: MapWindow): string {
  return `${win.minX} ${win.minY} ${win.maxX - win.minX} ${win.maxY - win.minY}`;
}

export function fitWindow(box: MapWindow, aspect: number, padding = 0.08): MapWindow {
  const safeAspect = Math.max(aspect, 0.25);
  let width = Math.max(1, box.maxX - box.minX) * (1 + padding * 2);
  let height = Math.max(1, box.maxY - box.minY) * (1 + padding * 2);
  if (width / height > safeAspect) height = width / safeAspect;
  else width = height * safeAspect;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return {
    minX: cx - width / 2,
    minY: cy - height / 2,
    maxX: cx + width / 2,
    maxY: cy + height / 2,
  };
}

export function pointToScreen(
  point: MapPosition,
  win: MapWindow,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: ((point.x - win.minX) / (win.maxX - win.minX)) * width,
    y: ((point.y - win.minY) / (win.maxY - win.minY)) * height,
  };
}

export function screenToPoint(
  x: number,
  y: number,
  win: MapWindow,
  rect: { left: number; top: number; width: number; height: number },
): MapPosition {
  return {
    x: win.minX + ((x - rect.left) / rect.width) * (win.maxX - win.minX),
    y: win.minY + ((y - rect.top) / rect.height) * (win.maxY - win.minY),
  };
}

export function scaleWindow(win: MapWindow, factor: number, anchor: MapPosition): MapWindow {
  const width = win.maxX - win.minX;
  const height = win.maxY - win.minY;
  const left = (anchor.x - win.minX) / width;
  const top = (anchor.y - win.minY) / height;
  const nextWidth = width * factor;
  const nextHeight = height * factor;
  return {
    minX: anchor.x - nextWidth * left,
    maxX: anchor.x + nextWidth * (1 - left),
    minY: anchor.y - nextHeight * top,
    maxY: anchor.y + nextHeight * (1 - top),
  };
}

export function clampWindow(next: MapWindow, bounds: MapWindow): MapWindow {
  const width = next.maxX - next.minX;
  const height = next.maxY - next.minY;
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  const boundsCenterX = (bounds.minX + bounds.maxX) / 2;
  const boundsCenterY = (bounds.minY + bounds.maxY) / 2;

  // A fitted window can be wider or taller than the active level because the
  // viewport and level rarely share an aspect ratio. Preserve that window
  // instead of snapping it smaller on the first drag or zoom-out.
  const minX =
    width >= boundsWidth
      ? boundsCenterX - width / 2
      : Math.max(bounds.minX, Math.min(next.minX, bounds.maxX - width));
  const minY =
    height >= boundsHeight
      ? boundsCenterY - height / 2
      : Math.max(bounds.minY, Math.min(next.minY, bounds.maxY - height));

  return { minX, minY, maxX: minX + width, maxY: minY + height };
}

export function boundsForLevel(view: GalaxyView, level: MapLevel): MapWindow {
  if (level.kind === 'chart') return view.bounds;
  const galaxy = view.galaxies.find((item) => item.galaxy === level.galaxy);
  if (level.kind === 'galaxy') {
    if (!galaxy) return view.bounds;
    return {
      minX: galaxy.position.x - galaxy.discRadius,
      minY: galaxy.position.y - galaxy.discRadius,
      maxX: galaxy.position.x + galaxy.discRadius,
      maxY: galaxy.position.y + galaxy.discRadius,
    };
  }
  const sector = view.sectors.find(
    (item) => item.galaxy === level.galaxy && item.sector === level.sector,
  );
  return (
    sector?.bounds ??
    (galaxy ? boundsForLevel(view, { kind: 'galaxy', galaxy: level.galaxy }) : view.bounds)
  );
}

/**
 * Paint the visible map into one canvas. The SVG above it is intentionally
 * only a small, accessible hit layer; all expensive art is batched here.
 */
export function paintMap(
  ctx: CanvasRenderingContext2D,
  view: GalaxyView,
  sky: Map<number, GalaxySky>,
  level: MapLevel,
  win: MapWindow,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, win, width, height);
  drawSky(ctx, sky, level, win, width, height);

  if (level.kind === 'chart') drawChart(ctx, view, level, win, width, height);
  if (level.kind === 'galaxy') drawGalaxy(ctx, view, level.galaxy, win, width, height);
  if (level.kind === 'sector')
    drawSector(ctx, view, level.galaxy, level.sector, win, width, height);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  win: MapWindow,
  width: number,
  height: number,
): void {
  const worldWidth = win.maxX - win.minX;
  const step = worldWidth > 18_000 ? 2_000 : worldWidth > 4_000 ? 500 : 100;
  const startX = Math.floor(win.minX / step) * step;
  const startY = Math.floor(win.minY / step) * step;
  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  for (let x = startX; x <= win.maxX; x += step) {
    const px = ((x - win.minX) / worldWidth) * width;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (let y = startY; y <= win.maxY; y += step) {
    const py = ((y - win.minY) / (win.maxY - win.minY)) * height;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();
  ctx.strokeStyle = GRID_MAJOR;
  ctx.beginPath();
  const major = step * 4;
  for (let x = Math.floor(win.minX / major) * major; x <= win.maxX; x += major) {
    const px = ((x - win.minX) / worldWidth) * width;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (let y = Math.floor(win.minY / major) * major; y <= win.maxY; y += major) {
    const py = ((y - win.minY) / (win.maxY - win.minY)) * height;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();
}

function drawSky(
  ctx: CanvasRenderingContext2D,
  sky: Map<number, GalaxySky>,
  level: MapLevel,
  win: MapWindow,
  width: number,
  height: number,
): void {
  const scale = (win.maxX - win.minX) / width;
  for (const [galaxyId, galaxy] of sky) {
    if (level.kind !== 'chart' && level.galaxy !== galaxyId) continue;
    if (!intersects(galaxy.center, galaxy.discRadius, win)) continue;
    const project = (point: MapPosition) => pointToScreen(point, win, width, height);
    for (const cloud of galaxy.nebula) {
      const center = project(cloud);
      const radius = cloud.r / scale;
      if (radius < 1) continue;
      const color =
        cloud.hue === 0 ? '168, 201, 240' : cloud.hue === 1 ? '74, 62, 120' : '38, 78, 102';
      const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      gradient.addColorStop(0, `rgba(${color}, ${cloud.alpha})`);
      gradient.addColorStop(1, `rgba(${color}, 0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
    }

    // Diffuse disc glow — each galaxy reads as a luminous cluster of stars:
    // a soft disc of light fading toward the rim. The spiral arms show
    // through the star density and nebula clouds instead of stroked lines.
    const discCenter = project(galaxy.center);
    const discRadius = Math.max(galaxy.discRadius / scale, 1);
    const discGlow = ctx.createRadialGradient(
      discCenter.x,
      discCenter.y,
      0,
      discCenter.x,
      discCenter.y,
      discRadius,
    );
    discGlow.addColorStop(0, `rgba(205, 219, 238, ${MAP_SKY.discGlowAlphaCore})`);
    discGlow.addColorStop(0.5, `rgba(168, 201, 240, ${MAP_SKY.discGlowAlphaMid})`);
    discGlow.addColorStop(1, 'rgba(168, 201, 240, 0)');
    ctx.fillStyle = discGlow;
    ctx.fillRect(
      discCenter.x - discRadius,
      discCenter.y - discRadius,
      discRadius * 2,
      discRadius * 2,
    );

    drawStars(ctx, galaxy, win, width, height, scale);
    const center = project(galaxy.center);
    const glowRadius = Math.max((galaxy.discRadius * 0.45) / scale, 2);
    const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, glowRadius);
    glow.addColorStop(0, 'rgba(219, 229, 242, 0.24)');
    glow.addColorStop(0.4, 'rgba(168, 201, 240, 0.08)');
    glow.addColorStop(1, 'rgba(168, 201, 240, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(center.x - glowRadius, center.y - glowRadius, glowRadius * 2, glowRadius * 2);
  }
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  galaxy: GalaxySky,
  win: MapWindow,
  width: number,
  height: number,
  scale: number,
): void {
  const stars = galaxy.stars;
  const stride = scale > 20 ? 2 : 1;
  const alphaScale = Math.min(1, Math.max(0.3, 8 / scale));
  for (let index = 0; index < stars.length; index += 6 * stride) {
    const x = stars[index];
    const y = stars[index + 1];
    if (x < win.minX || x > win.maxX || y < win.minY || y > win.maxY) continue;
    const point = pointToScreen({ x, y }, win, width, height);
    const size = Math.max(0.65, stars[index + 2] / scale);
    const alpha = Math.min(1, stars[index + 3] * alphaScale);
    ctx.fillStyle = stars[index + 4] === 1 ? ICE : STAR_WHITE;
    ctx.globalAlpha = alpha;
    ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  view: GalaxyView,
  _level: Extract<MapLevel, { kind: 'chart' }>,
  win: MapWindow,
  width: number,
  height: number,
): void {
  const scale = (win.maxX - win.minX) / width;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const galaxy of view.galaxies) {
    if (!intersects(galaxy.position, galaxy.discRadius, win)) continue;
    const center = pointToScreen(galaxy.position, win, width, height);
    const radius = galaxy.discRadius / scale;
    ctx.strokeStyle = 'rgba(219, 229, 242, 0.27)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(168, 201, 240, 0.18)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, Math.max(10, radius * 0.16), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ICE;
    ctx.font = `700 ${Math.max(11, Math.min(18, 12 / scale))}px ui-monospace, monospace`;
    ctx.fillText(`GALAXY ${galaxy.galaxy}`, center.x, center.y - radius - 16);
    const sectorDots = view.sectors.filter((sector) => sector.galaxy === galaxy.galaxy);
    for (const sector of sectorDots) {
      const dot = pointToScreen(sector.position, win, width, height);
      ctx.fillStyle = sector.sector === 1 ? ICE : STAR_WHITE;
      ctx.globalAlpha = sector.sector === 1 ? 1 : 0.72;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, sector.sector === 1 ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawGalaxy(
  ctx: CanvasRenderingContext2D,
  view: GalaxyView,
  galaxyId: number,
  win: MapWindow,
  width: number,
  height: number,
): void {
  const scale = (win.maxX - win.minX) / width;
  const galaxy = view.galaxies.find((item) => item.galaxy === galaxyId);
  if (!galaxy) return;
  const center = pointToScreen(galaxy.position, win, width, height);
  ctx.strokeStyle = 'rgba(219, 229, 242, 0.17)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 7]);
  ctx.beginPath();
  ctx.arc(center.x, center.y, galaxy.discRadius / scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const sectors = view.sectors.filter((sector) => sector.galaxy === galaxyId);
  for (const sector of sectors) {
    const position = pointToScreen(sector.position, win, width, height);
    const bounds = projectBounds(sector.bounds, win, width, height);
    ctx.fillStyle =
      sector.sector % 2 === 0 ? 'rgba(205, 219, 238, 0.035)' : 'rgba(168, 201, 240, 0.045)';
    ctx.strokeStyle = 'rgba(205, 219, 238, 0.19)';
    ctx.lineWidth = 1;
    roundedRect(
      ctx,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      Math.min(14, bounds.width * 0.08),
    );
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = sector.sector === 1 ? ICE : 'rgba(219, 229, 242, 0.66)';
    ctx.font = `700 ${Math.max(10, Math.min(14, 11 / scale))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`S${sector.sector}`, position.x, position.y);
  }

  for (const system of view.systems) {
    if (system.galaxy !== galaxyId) continue;
    const point = pointToScreen(system.position, win, width, height);
    ctx.fillStyle = SYSTEM_GOLD;
    ctx.globalAlpha = 0.82;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.4, 3 / scale), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSector(
  ctx: CanvasRenderingContext2D,
  view: GalaxyView,
  galaxyId: number,
  sectorId: number,
  win: MapWindow,
  width: number,
  height: number,
): void {
  const sector = view.sectors.find((item) => item.galaxy === galaxyId && item.sector === sectorId);
  if (!sector) return;
  const scale = (win.maxX - win.minX) / width;
  const bounds = projectBounds(sector.bounds, win, width, height);
  ctx.fillStyle = 'rgba(18, 24, 38, 0.72)';
  ctx.strokeStyle = 'rgba(168, 201, 240, 0.3)';
  ctx.lineWidth = 1;
  roundedRect(
    ctx,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    Math.min(18, bounds.width * 0.05),
  );
  ctx.fill();
  ctx.stroke();

  // This sector's planets, grouped by system, so each system can draw its
  // orbit rings exactly where its worlds ride. The old fixed ring radii
  // (18/30/42) never matched the seeded planet orbits (24–52), so worlds
  // floated between the rings; drawing one ring per planet at its own orbit
  // radius guarantees every world sits on its ring.
  const planetsBySystem = new Map<number, GalaxyView['planets']>();
  for (const planet of view.planets) {
    if (planet.coordinate.galaxy !== galaxyId || planet.coordinate.sector !== sectorId) continue;
    const list = planetsBySystem.get(planet.coordinate.system);
    if (list) list.push(planet);
    else planetsBySystem.set(planet.coordinate.system, [planet]);
  }

  const systems = view.systems.filter(
    (system) => system.galaxy === galaxyId && system.sector === sectorId,
  );
  for (const system of systems) {
    const star = pointToScreen(system.position, win, width, height);
    ctx.strokeStyle = 'rgba(147, 162, 184, 0.18)';
    ctx.lineWidth = 1;
    for (const planet of planetsBySystem.get(system.system) ?? []) {
      const radius =
        Math.hypot(planet.position.x - system.position.x, planet.position.y - system.position.y) /
        scale;
      ctx.beginPath();
      ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = SYSTEM_GOLD;
    ctx.beginPath();
    ctx.arc(star.x, star.y, Math.max(2, 4 / scale), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const planets of planetsBySystem.values()) {
    for (const planet of planets) {
      const point = pointToScreen(planet.position, win, width, height);
      if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) continue;
      const radius = planet.known ? 5 : 3.2;
      ctx.fillStyle = PLANET_COLORS.get(planet.classId) ?? '#93a2b8';
      ctx.globalAlpha = planet.known ? 1 : 0.78;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (planet.known) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ICE;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = STAR_WHITE;
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(planet.name, point.x + 16, point.y);
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = ICE;
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`SECTOR ${galaxyId}:${sectorId}`, bounds.x + 16, bounds.y + 14);
}

function projectBounds(
  box: MapWindow,
  win: MapWindow,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const min = pointToScreen({ x: box.minX, y: box.minY }, win, width, height);
  const max = pointToScreen({ x: box.maxX, y: box.maxY }, win, width, height);
  return { x: min.x, y: min.y, width: max.x - min.x, height: max.y - min.y };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function intersects(center: MapPosition, radius: number, win: MapWindow): boolean {
  return !(
    center.x + radius < win.minX ||
    center.x - radius > win.maxX ||
    center.y + radius < win.minY ||
    center.y - radius > win.maxY
  );
}
