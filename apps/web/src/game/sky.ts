import { MAP_SKY, MAP_SKY_CORE_RADIUS } from '@ashes/content';
import type { GalaxyView, MapPosition } from '@ashes/contracts';

/**
 * The map's sky — presentation-only background paint (The Deep Field Rule).
 *
 * A seeded canvas layer sits behind the interactive SVG chart. Each galaxy
 * is drawn as a spiral of star clusters: three arms wind out of a bright
 * core, star density follows the arms (which the sectors trace), soft dust
 * lanes and cold nebula blobs give the void depth, and the whole field is
 * culled to the visible window and redrawn at most once per animation frame,
 * so pan/zoom never pays per-event DOM or paint costs.
 *
 * Determinism: stars are generated from (seed, galaxy) with a local FNV-1a +
 * mulberry32 pair — no `Math.random()`, no wall clock. The sky is re-derived
 * from the world seed on every load, so the map is reproducible; it never
 * feeds the simulation.
 */

/** Star buffer stride: x, y, size, alpha, tint(0|1), bright(0|1). */
const STAR_STRIDE = 6;

/** Cold palette — the seal (ice) and the archive's star-white. */
const STAR_WHITE_RGB = '219, 229, 242';
const ICE_RGB = '168, 201, 240';
const CORE_GLOW_RGB = '205, 219, 238';
/** Cold nebula hues (from the shared starfield palette). */
const NEBULA_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [168, 201, 240], // ice
  [74, 62, 120], // indigo
  [38, 78, 102], // deep teal
];
/** Star alpha quantized to these buckets so draws need no per-star state. */
const STAR_ALPHA_BUCKETS = [0.16, 0.3, 0.45, 0.6, 0.75, 0.95];

export type SkyLevel =
  { kind: 'chart' } | { kind: 'galaxy'; galaxy: number } | { kind: 'sector'; galaxy: number };

export type GalaxySky = {
  center: MapPosition;
  discRadius: number;
  /** Stride-6 star buffer (world units; alpha 0..1). */
  stars: Float32Array;
  nebula: Array<{ x: number; y: number; r: number; alpha: number; hue: number }>;
  /** One sampled spiral polyline per arm (world units, x,y pairs). */
  arms: Float32Array[];
};

/* ------------------------------------------------------------------ *
 * Deterministic PRNG (presentation mirror of domain's FNV-1a/mulberry32 —
 * kept local so the web client never imports sim internals).
 * ------------------------------------------------------------------ */

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate a normal deviate via Box–Muller on a [0,1) stream. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/**
 * Catmull-Rom through `points` (clamped at the ends), sampled to a dense
 * polyline. The spiral arms and their dust lanes are drawn from this.
 */
function catmullRom(points: MapPosition[], samplesPerSegment: number): Float32Array {
  const out: number[] = [];
  const p = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      );
    }
  }
  const last = points[points.length - 1];
  out.push(last.x, last.y);
  return Float32Array.from(out);
}

/** Cumulative polyline lengths, one entry per vertex (first is 0). */
function cumulativeLengths(path: Float32Array): number[] {
  const cum = [0];
  for (let i = 2; i < path.length; i += 2) {
    const dx = path[i] - path[i - 2];
    const dy = path[i + 1] - path[i - 1];
    cum.push(cum[cum.length - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

/** Point + unit direction at arc-length fraction `t` of a polyline. */
function pointAlong(
  path: Float32Array,
  cum: number[],
  t: number,
): { x: number; y: number; dx: number; dy: number } {
  const total = cum[cum.length - 1];
  const target = t * total;
  let seg = 0;
  while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
  const segLen = cum[seg + 1] - cum[seg];
  const f = segLen === 0 ? 0 : (target - cum[seg]) / segLen;
  const x0 = path[seg * 2];
  const y0 = path[seg * 2 + 1];
  const x1 = path[seg * 2 + 2];
  const y1 = path[seg * 2 + 3];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  return { x: x0 + dx * f, y: y0 + dy * f, dx: dx / len, dy: dy / len };
}

/**
 * Smooth an arm's control points (moving-average, endpoints kept) so the
 * dust lane follows the spiral trend instead of wriggling through every
 * sector's seeded jitter. Two passes halve the per-sector kink each time.
 */
function smoothArmPoints(points: MapPosition[]): MapPosition[] {
  if (points.length < 3) return points;
  let pts = points;
  for (let pass = 0; pass < 2; pass++) {
    const out: MapPosition[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      out.push({
        x: (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4,
        y: (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4,
      });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/**
 * Build one galaxy's spiral arms from its sector positions. Sectors belong
 * to arm `(sector - 1) % 3` in index order (see galaxy-layout), so each arm
 * is the Catmull-Rom through its sectors' centers, extended from near the
 * core to the disc rim and smoothed so the lane does not zigzag through the
 * per-sector jitter.
 */
function buildArms(
  center: MapPosition,
  discRadius: number,
  sectorPositions: MapPosition[],
): Float32Array[] {
  const armCount = 3;
  const arms: Float32Array[] = [];
  for (let arm = 0; arm < armCount; arm++) {
    const pts: MapPosition[] = [];
    for (let s = arm; s < sectorPositions.length; s += armCount) {
      pts.push(sectorPositions[s]);
    }
    if (pts.length === 0) continue;
    const inner = pts[0];
    const outer = pts[pts.length - 1];
    const towardCore = (p: MapPosition, r: number): MapPosition => {
      const dx = center.x - p.x;
      const dy = center.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: center.x + (dx / len) * r, y: center.y + (dy / len) * r };
    };
    const rim = (p: MapPosition, r: number): MapPosition => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: center.x + (dx / len) * r, y: center.y + (dy / len) * r };
    };
    const innerR = MAP_SKY_CORE_RADIUS * 0.55;
    const outerR = Math.max(
      discRadius * 0.97,
      Math.hypot(outer.x - center.x, outer.y - center.y) * 1.25,
    );
    arms.push(
      catmullRom(
        smoothArmPoints([towardCore(inner, innerR), ...pts, rim(outer, outerR)]),
        MAP_SKY.armPathSteps,
      ),
    );
  }
  return arms;
}

function generateGalaxySky(
  seed: number,
  galaxy: number,
  center: MapPosition,
  discRadius: number,
  sectorPositions: MapPosition[],
): GalaxySky {
  const rng = mulberry32(fnv1a(`${seed}:sky:${galaxy}`));
  const arms = buildArms(center, discRadius, sectorPositions);
  const armCums = arms.map(cumulativeLengths);

  const stars = new Float32Array(MAP_SKY.starsPerGalaxy * STAR_STRIDE);
  let idx = 0;
  const armCount = Math.round(MAP_SKY.starsPerGalaxy * MAP_SKY.armStarFraction);
  for (let i = 0; i < MAP_SKY.starsPerGalaxy; i++) {
    let x: number;
    let y: number;
    if (i < armCount) {
      const arm = Math.floor(rng() * arms.length);
      const { x: px, y: py, dx, dy } = pointAlong(arms[arm], armCums[arm], rng());
      // Perpendicular + tangential jitter turns the polyline into a band.
      const nx = -dy;
      const ny = dx;
      const j1 = gaussian(rng) * MAP_SKY.armJitter;
      const j2 = gaussian(rng) * MAP_SKY.armJitterAlong;
      x = px + nx * j1 + dx * j2;
      y = py + ny * j1 + dy * j2;
    } else {
      const r = Math.sqrt(rng()) * discRadius * 1.02;
      const th = rng() * Math.PI * 2;
      x = center.x + Math.cos(th) * r;
      y = center.y + Math.sin(th) * r;
    }
    const d = Math.hypot(x - center.x, y - center.y);
    if (d > discRadius * MAP_SKY.starSpillLimit) continue;
    const inCore = d < MAP_SKY_CORE_RADIUS * 1.8;
    const bright = rng() < MAP_SKY.brightStarChance;
    const size = bright
      ? MAP_SKY.brightStarSize
      : MAP_SKY.starSizeMin + rng() * (MAP_SKY.starSizeMax - MAP_SKY.starSizeMin);
    let alpha = MAP_SKY.alphaMin + rng() * (MAP_SKY.alphaMax - MAP_SKY.alphaMin);
    if (inCore) alpha = Math.min(1, alpha * 1.5);
    if (bright) alpha = Math.max(alpha, 0.85);
    const tint = rng() < MAP_SKY.iceStarChance ? 1 : 0;
    stars[idx] = x;
    stars[idx + 1] = y;
    stars[idx + 2] = size;
    stars[idx + 3] = alpha;
    stars[idx + 4] = tint;
    stars[idx + 5] = bright ? 1 : 0;
    idx += STAR_STRIDE;
  }

  const nebula: GalaxySky['nebula'] = [];
  for (let i = 0; i < MAP_SKY.nebulaCount; i++) {
    const arm = Math.floor(rng() * arms.length);
    const { x: bx, y: by } = pointAlong(arms[arm], armCums[arm], 0.2 + rng() * 0.6);
    nebula.push({
      x: bx + gaussian(rng) * 190,
      y: by + gaussian(rng) * 190,
      r: MAP_SKY.nebulaRadiusMin + rng() * (MAP_SKY.nebulaRadiusMax - MAP_SKY.nebulaRadiusMin),
      alpha: 0.02 + rng() * (MAP_SKY.nebulaAlphaMax - 0.02),
      hue: Math.floor(rng() * NEBULA_RGB.length),
    });
  }

  return { center, discRadius, stars: stars.slice(0, idx), nebula, arms };
}

/** Build the full sky for a world: one seeded star field per galaxy. */
export function buildSky(view: GalaxyView): Map<number, GalaxySky> {
  const sky = new Map<number, GalaxySky>();
  for (const g of view.galaxies) {
    const sectors = view.sectors
      .filter((s) => s.galaxy === g.galaxy)
      .map((s) => ({ galaxy: s.galaxy, sector: s.sector, position: s.position }))
      .sort((a, b) => a.sector - b.sector)
      .map((s) => s.position);
    sky.set(g.galaxy, generateGalaxySky(view.seed, g.galaxy, g.position, g.discRadius, sectors));
  }
  return sky;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Draw the sky for the current window. `w`/`h` are CSS pixels. */
export function renderSky(
  ctx: CanvasRenderingContext2D,
  sky: Map<number, GalaxySky>,
  level: SkyLevel,
  win: { minX: number; minY: number; maxX: number; maxY: number },
  w: number,
  h: number,
): void {
  const scale = (win.maxX - win.minX) / w;
  const toPx = (v: number, min: number, size: number) => ((v - min) / size) * w;

  for (const [galaxy, s] of sky) {
    if (level.kind !== 'chart' && level.galaxy !== galaxy) continue;
    // Disc-level cull: skip galaxies entirely outside the window.
    if (
      s.center.x + s.discRadius < win.minX ||
      s.center.x - s.discRadius > win.maxX ||
      s.center.y + s.discRadius < win.minY ||
      s.center.y - s.discRadius > win.maxY
    ) {
      continue;
    }
    drawGalaxy(ctx, s, win, toPx, w, h, scale);
  }
  ctx.globalAlpha = 1;
}

function drawGalaxy(
  ctx: CanvasRenderingContext2D,
  s: GalaxySky,
  win: { minX: number; minY: number; maxX: number; maxY: number },
  toPx: (v: number, min: number, size: number) => number,
  w: number,
  h: number,
  scale: number,
): void {
  const x = (v: number) => toPx(v, win.minX, win.maxX - win.minX);
  const y = (v: number) => toPx(v, win.minY, win.maxY - win.minY);

  // Nebula blobs — cold dust clouds drifting along the arms.
  for (const n of s.nebula) {
    const px = x(n.x);
    const py = y(n.y);
    const pr = n.r / scale;
    if (px + pr < 0 || px - pr > w || py + pr < 0 || py - pr > h) continue;
    const [r, g, b] = NEBULA_RGB[n.hue];
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${n.alpha})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  }

  // Dust lanes — each spiral arm stroked wide-and-faint then narrow.
  if (s.arms.length > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${ICE_RGB}, 1)`;
    const passes: Array<[number, number]> = [
      [MAP_SKY.dustWidthOuter, MAP_SKY.dustAlphaOuter],
      [MAP_SKY.dustWidthInner, MAP_SKY.dustAlphaInner],
    ];
    for (const [width, alpha] of passes) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width / scale;
      for (const arm of s.arms) {
        ctx.beginPath();
        for (let i = 0; i < arm.length; i += 2) {
          const px = x(arm[i]);
          const py = y(arm[i + 1]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }

  // Core glow + hot inner core.
  const cxp = x(s.center.x);
  const cyp = y(s.center.y);
  const glowR = Math.max((s.discRadius * MAP_SKY.coreGlowRadiusFactor) / scale, 1);
  const glow = ctx.createRadialGradient(cxp, cyp, 0, cxp, cyp, glowR);
  glow.addColorStop(0, `rgba(${CORE_GLOW_RGB}, ${MAP_SKY.coreGlowAlpha})`);
  glow.addColorStop(0.55, `rgba(${CORE_GLOW_RGB}, ${MAP_SKY.coreGlowAlpha * 0.35})`);
  glow.addColorStop(1, `rgba(${CORE_GLOW_RGB}, 0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = glow;
  ctx.fillRect(cxp - glowR, cyp - glowR, glowR * 2, glowR * 2);
  const hotR = Math.max((s.discRadius * MAP_SKY.hotCoreRadiusFactor) / scale, 1);
  const hot = ctx.createRadialGradient(cxp, cyp, 0, cxp, cyp, hotR);
  hot.addColorStop(0, `rgba(${STAR_WHITE_RGB}, ${MAP_SKY.hotCoreAlpha})`);
  hot.addColorStop(1, `rgba(${STAR_WHITE_RGB}, 0)`);
  ctx.fillStyle = hot;
  ctx.fillRect(cxp - hotR, cyp - hotR, hotR * 2, hotR * 2);

  drawStars(ctx, s.stars, win, toPx, w, h, scale);
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  stars: Float32Array,
  win: { minX: number; minY: number; maxX: number; maxY: number },
  toPx: (v: number, min: number, size: number) => number,
  w: number,
  h: number,
  scale: number,
): void {
  // Stars fade toward the chart view (dense overplotting) and sharpen in.
  const alphaScale = Math.min(
    1,
    Math.max(MAP_SKY.starAlphaScaleFloor, MAP_SKY.starAlphaAtScale / scale),
  );
  const whiteBuckets: number[][] = Array.from({ length: STAR_ALPHA_BUCKETS.length }, () => []);
  const iceBuckets: number[][] = Array.from({ length: STAR_ALPHA_BUCKETS.length }, () => []);
  const halos: number[] = [];

  for (let i = 0; i < stars.length; i += STAR_STRIDE) {
    const sx = stars[i];
    const sy = stars[i + 1];
    if (sx < win.minX - 2 || sx > win.maxX + 2 || sy < win.minY - 2 || sy > win.maxY + 2) continue;
    const px = toPx(sx, win.minX, win.maxX - win.minX);
    const py = toPx(sy, win.minY, win.maxY - win.minY);
    if (px < -2 || px > w + 2 || py < -2 || py > h + 2) continue;
    const size = Math.max(0.55, stars[i + 2] / scale);
    const alpha = stars[i + 3] * alphaScale;
    const bucket = Math.min(
      STAR_ALPHA_BUCKETS.length - 1,
      Math.floor(alpha * STAR_ALPHA_BUCKETS.length),
    );
    const target = stars[i + 4] === 1 ? iceBuckets : whiteBuckets;
    target[bucket].push(px - size / 2, py - size / 2, size);
    if (stars[i + 5] === 1) halos.push(px, py, size * 3.2);
  }

  // Halos first, behind the points (soft bloom for the rare bright stars).
  if (halos.length > 0) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = `rgba(${STAR_WHITE_RGB}, 1)`;
    for (let i = 0; i < halos.length; i += 3) {
      const s = halos[i + 2];
      ctx.fillRect(halos[i] - s / 2, halos[i + 1] - s / 2, s, s);
    }
  }

  const paint = (buckets: number[][], fill: string) => {
    ctx.fillStyle = fill;
    for (let b = 0; b < STAR_ALPHA_BUCKETS.length; b++) {
      const arr = buckets[b];
      if (arr.length === 0) continue;
      ctx.globalAlpha = STAR_ALPHA_BUCKETS[b];
      for (let i = 0; i < arr.length; i += 3) {
        ctx.fillRect(arr[i], arr[i + 1], arr[i + 2], arr[i + 2]);
      }
    }
  };
  paint(whiteBuckets, `rgb(${STAR_WHITE_RGB})`);
  paint(iceBuckets, `rgb(${ICE_RGB})`);
}
