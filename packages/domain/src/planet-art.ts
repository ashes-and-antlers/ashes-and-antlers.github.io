import type { PlanetView } from '@ashes/contracts';
import { PLANET_ART, PLANET_CLASSES, type PlanetClass, type PlanetClassKey } from '@ashes/content';
import { fnv1a, mulberry32 } from './prng';

/**
 * Deterministic planet portrait renderer (M1 "planets without hand-drawn
 * assets"). Ports the *math* of dgreenheck/threejs-procedural-planets (MIT):
 * hash-based fbm value noise sampled on the sphere, an elevation → terrain
 * gamut ramp, a cloud layer, and an atmosphere rim — but as a pure CPU
 * rasterizer, so the same planet always produces byte-identical RGBA pixels.
 *
 * Determinism rules (ADR-001 carried forward):
 *  - No Math.random, no Date, no platform-dependent math. The lattice hash is
 *    pure int32 arithmetic (Math.imul), everything else is IEEE-754, so
 *    output is stable across runs, platforms, and Node versions.
 *  - All variety derives from the planet id (fnv1a-seeded streams) and its
 *    abundance: food drives cloud coverage, metal/mineral drives mountain
 *    prominence. The visible face (orientation) is seeded too.
 *
 * The API encodes the returned RGBA buffer as PNG (pngjs) and serves it with
 * an ART_VERSION-keyed cache.
 */
export type PlanetArtImage = {
  width: number;
  height: number;
  /** RGBA, row-major, top-left origin. */
  data: Uint8Array;
};

export type PlanetArtOptions = {
  /** 2 = 2×2 supersampling (default). 1 = one sample per pixel (faster). */
  supersample?: 1 | 2;
};

/** Fixed light direction in world space (view is +Z). Deterministic on purpose. */
const LIGHT = normalize3(-0.45, -0.62, 0.64);

/**
 * Deterministically pick a planet's visual class from its id, weighted by
 * the class weights so every world is a distinct, stable "kind" of planet.
 * Presentation-only: derives from the id alone (no sim state), so the same
 * id always renders the same class.
 */
export function planetClassId(planetId: string): PlanetClassKey {
  const r = (fnv1a(`${planetId}:class`) % 1000) / 1000;
  const total = PLANET_CLASSES.reduce((acc, c) => acc + c.weight, 0);
  let acc = 0;
  for (const c of PLANET_CLASSES) {
    acc += c.weight / total;
    if (r < acc) return c.key;
  }
  return PLANET_CLASSES[PLANET_CLASSES.length - 1].key;
}

export function planetClass(key: PlanetClassKey): PlanetClass {
  const found = PLANET_CLASSES.find((c) => c.key === key);
  if (!found) throw new Error(`unknown planet class ${key}`);
  return found;
}

/** Fraction of the half-frame the planet disc fills (content-defined). */
const DISC = PLANET_ART.disc.radius;

/** One star on the hash lattice, in pixel space. */
type Star = {
  cx: number;
  cy: number;
  radius: number;
  /** 0..1 star strength. */
  brightness: number;
  /** 0..1 → mostly star-white; small chances of ice or cool-white. */
  tint: number;
};

/** One soft dust-cloud blob behind the planet, in pixel space. */
type Nebula = {
  cx: number;
  cy: number;
  radius: number;
  /** 0..1 peak strength of the tint. */
  strength: number;
  /** Tint color (in-palette; ice is rare per The Ice Seal Rule). */
  tint: [number, number, number];
};

export function renderPlanetArt(
  planet: Pick<PlanetView, 'id' | 'abundance'>,
  size: number,
  options: PlanetArtOptions = {},
): PlanetArtImage {
  const cfg = PLANET_ART;
  const sizeClamped = clampInt(size, cfg.render.minSize, cfg.render.maxSize);
  const supersample = options.supersample ?? 2;

  // The planet's visual class: every class has its own terrain ramp, cloud
  // and atmosphere colors, so worlds are unmistakably different.
  const classCfg = planetClass(planetClassId(planet.id));

  // Seeded streams derived from the planet id.
  const orientation = planetOrientation(planet.id);
  const terrainSeed = fnv1a(`${planet.id}:terrain`);
  const cloudSeed = fnv1a(`${planet.id}:clouds`);
  const starSeed = fnv1a(`${planet.id}:stars`);
  const stars = buildStars(sizeClamped, starSeed);
  const nebulae = buildNebulae(sizeClamped, fnv1a(`${planet.id}:nebula`));
  // Hoisted per-render constants for the starfield (avoid per-pixel work).
  const spaceBg = hexRgb(PLANET_ART.starfield.backgroundColor);
  const spaceCells = Math.ceil(sizeClamped / PLANET_ART.starfield.cellSize);

  // Abundance-driven art (0..1 ranges), layered on the class's own values.
  const food = planet.abundance.food / 100;
  const metalMineral = (planet.abundance.metal + planet.abundance.mineral) / 200;
  const mountainAmp = 1 + cfg.noise.mountainBoost * metalMineral;
  const cloudCoverage = classCfg.clouds.coverageBase + classCfg.clouds.coverageFromFood * food;

  const data = new Uint8Array(sizeClamped * sizeClamped * 4);
  const subSamples = supersample === 2 ? 4 : 1;
  const offsets =
    supersample === 2
      ? [
          [-0.25, -0.25],
          [0.25, -0.25],
          [-0.25, 0.25],
          [0.25, 0.25],
        ]
      : [[0, 0]];

  let idx = 0;
  for (let y = 0; y < sizeClamped; y++) {
    for (let x = 0; x < sizeClamped; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [ox, oy] of offsets) {
        const sx = ((x + 0.5 + ox) / sizeClamped) * 2 - 1;
        const sy = ((y + 0.5 + oy) / sizeClamped) * 2 - 1;
        // Map the canvas to the unit-disc projection: DISC < 1 shrinks the
        // planet inside the canvas, leaving room for the atmosphere rim.
        const u = sx / DISC;
        const v = sy / DISC;
        const d2 = u * u + v * v;
        if (d2 > 1) {
          // Deep space: nebula dust + starfield fill the frame behind the
          // planet.
          const [sr, sg, sb] = spaceColor(
            x + 0.5 + ox,
            y + 0.5 + oy,
            spaceCells,
            spaceBg,
            nebulae,
            stars,
          );
          r += sr;
          g += sg;
          b += sb;
          a += 255;
          continue;
        }
        const z = -Math.sqrt(1 - d2);
        const nx = u;
        const ny = v;
        const nz = z;
        // World-space normal (unit): for orthographic +Z view, n = (u, v, z).
        // Sample the noise field at the rotated point so each planet shows a
        // unique face.
        const ry = rotateY(nx, ny, nz, orientation.yaw);
        const px = rotateX(ry[0], ry[1], ry[2], orientation.pitch);
        const e = elevation(px, terrainSeed, mountainAmp, classCfg.noiseFrequency);
        const cloudValue = fbm(
          px[0] * cfg.noise.cloudFrequency,
          px[1] * cfg.noise.cloudFrequency,
          px[2] * cfg.noise.cloudFrequency,
          cloudSeed,
          cfg.noise.cloudOctaves,
        );

        const [cr, cg, cb] = shade(cfg, classCfg, e, cloudValue, cloudCoverage, nx, ny, nz);
        r += cr;
        g += cg;
        b += cb;
        a += 255;
      }
      const n = subSamples;
      data[idx] = r / n;
      data[idx + 1] = g / n;
      data[idx + 2] = b / n;
      data[idx + 3] = a / n;
      idx += 4;
    }
  }

  return { width: sizeClamped, height: sizeClamped, data };
}

function shade(
  cfg: typeof PLANET_ART,
  classCfg: PlanetClass,
  e: number,
  cloudValue: number,
  cloudCoverage: number,
  nx: number,
  ny: number,
  nz: number,
): [number, number, number] {
  let [r, g, b] = terrainColor(classCfg, e);
  // Gas giants: latitude bands (bands follow the view axis, so the band
  // phase is a function of screen latitude — a stable equator line).
  if (classCfg.banding) {
    const { count, amplitude } = classCfg.banding;
    const latitude = Math.asin(clamp(nz, -1, 1));
    const band = Math.sin(latitude * count * Math.PI);
    const bandK = 1 + band * amplitude;
    r *= bandK;
    g *= bandK;
    b *= bandK;
  }
  // Elevation shade (DESIGN.md: ×0.78–1.10).
  const shadeK =
    cfg.lighting.shadeMin + (cfg.lighting.shadeMax - cfg.lighting.shadeMin) * ((e + 1) / 2);
  r *= shadeK;
  g *= shadeK;
  b *= shadeK;

  // Cloud layer: a second noise field blended over the surface where it
  // passes the coverage threshold. Edge-softened so coverage stays organic.
  const edge = 0.1;
  const cloudAlpha =
    smoothstep(1 - cloudCoverage, 1 - cloudCoverage + edge, cloudValue) * classCfg.clouds.alpha;
  if (cloudAlpha > 0) {
    const [cr, cg, cb] = hexRgb(classCfg.clouds.color);
    r = lerp(r, cr, cloudAlpha);
    g = lerp(g, cg, cloudAlpha);
    b = lerp(b, cb, cloudAlpha);
  }

  // Diffuse lighting from the fixed sun.
  const diffuse = Math.max(dot3(nx, ny, nz, LIGHT[0], LIGHT[1], LIGHT[2]), 0);
  const lit = cfg.lighting.ambient + (1 - cfg.lighting.ambient) * diffuse;
  r *= lit;
  g *= lit;
  b *= lit;

  // Atmosphere rim: fresnel glow at the limb (view = +Z).
  const [rr, rg, rb] = fresnelRim(nz, classCfg.atmosphere);
  return [clampByte(r + rr), clampByte(g + rg), clampByte(b + rb)];
}

function terrainColor(classCfg: PlanetClass, e: number): [number, number, number] {
  const bands = classCfg.terrain;
  // Below the first band top → first color; above the last → last color.
  if (e <= bands[0].elevation) return hexRgb(bands[0].color);
  for (let i = 1; i < bands.length; i++) {
    if (e <= bands[i].elevation) {
      const prev = bands[i - 1];
      const cur = bands[i];
      // Blend across the band with a smoothstep of the normalized position.
      const span = cur.elevation - prev.elevation;
      const t = span === 0 ? 1 : smoothstep(0, 1, (e - prev.elevation) / span);
      const [pr, pg, pb] = hexRgb(prev.color);
      const [cr, cg, cb] = hexRgb(cur.color);
      return [lerp(pr, cr, t), lerp(pg, cg, t), lerp(pb, cb, t)];
    }
  }
  return hexRgb(bands[bands.length - 1].color);
}

function fresnelRim(
  nz: number,
  atmosphere: { rimColor: string; rimStrength: number },
): [number, number, number] {
  // nz = cos of angle to view axis; near the limb nz → 0.
  const limb = 1 - Math.max(nz, 0);
  const strength = smoothstep(0.45, 0.98, limb) * atmosphere.rimStrength;
  const falloff = Math.pow(limb, 2.2) * strength;
  const [r, g, b] = hexRgb(atmosphere.rimColor);
  return [r * falloff, g * falloff, b * falloff];
}

// ---------------------------------------------------------------------------
// starfield (deep-space backdrop)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic star set for an image: one hash-lattice cell per
 * `cellSize` pixels, each cell holding a star with probability starChance.
 * Stars are placed on a jittered grid so no two cells collide.
 */
function buildStars(size: number, seed: number): Map<number, Star> {
  const cfg = PLANET_ART.starfield;
  const stars = new Map<number, Star>();
  const cells = Math.ceil(size / cfg.cellSize);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const hash = latticeHash(cx, cy, 0, seed);
      const bright = hash < cfg.brightStarChance;
      const present = hash < cfg.starChance || bright;
      if (!present) continue;
      const radius = bright ? cfg.brightStarRadius : cfg.starRadius;
      // Jittered center within the cell (with padding so stars don't bleed
      // into the planet disc or canvas edge).
      const pad = radius + 0.5;
      const ox = latticeHash(cx, cy, 1, seed);
      const oy = latticeHash(cx, cy, 2, seed);
      const cxPx = cx * cfg.cellSize + pad + ox * (cfg.cellSize - 2 * pad);
      const cyPx = cy * cfg.cellSize + pad + oy * (cfg.cellSize - 2 * pad);
      const brightness = cfg.starBrightness * (0.6 + 0.4 * latticeHash(cx, cy, 3, seed));
      const tint = latticeHash(cx, cy, 4, seed);
      stars.set(cy * cells + cx, { cx: cxPx, cy: cyPx, radius, brightness, tint });
    }
  }
  return stars;
}

/**
 * Build the deterministic nebula blobs for an image: 0–3 soft dust clouds,
 * each with a seeded center, radius, strength, and tint (in-palette space
 * neutrals; ice is rare per The Ice Seal Rule). Some planets get no nebula
 * at all — the sky varies by planet id.
 */
function buildNebulae(size: number, seed: number): Nebula[] {
  const cfg = PLANET_ART.nebula;
  const rng = mulberry32(seed);
  if (rng() > cfg.presenceChance) return [];
  const count = cfg.blobCount.min + Math.floor(rng() * (cfg.blobCount.max - cfg.blobCount.min + 1));
  const blobs: Nebula[] = [];
  for (let i = 0; i < count; i++) {
    const radius = (cfg.blobRadius.min + rng() * (cfg.blobRadius.max - cfg.blobRadius.min)) * size;
    const strength = cfg.maxStrength * (1 - cfg.strengthJitter + cfg.strengthJitter * rng());
    const ice = rng() < cfg.iceChance;
    const tint = ice
      ? hexRgb(cfg.iceTint)
      : hexRgb(cfg.tints[Math.floor(rng() * cfg.tints.length)]);
    blobs.push({
      cx: rng() * size,
      cy: rng() * size,
      radius,
      strength,
      tint,
    });
  }
  return blobs;
}

/**
 * Color of one deep-space pixel: the space fill, plus any nebula dust
 * covering it, plus any star whose disc covers it. Nebula is blended first
 * (low-frequency, soft), stars on top (crisp points). Checks the 3×3 cell
 * neighborhood for stars so stars at cell borders stay complete.
 * Deterministic — driven entirely by the prebuilt blob/star sets.
 */
function spaceColor(
  px: number,
  py: number,
  cells: number,
  bg: [number, number, number],
  nebulae: Nebula[],
  stars: Map<number, Star>,
): [number, number, number] {
  const cfg = PLANET_ART.starfield;
  const [bgR, bgG, bgB] = bg;
  const cellX = Math.floor(px / cfg.cellSize);
  const cellY = Math.floor(py / cfg.cellSize);

  let r = bgR;
  let g = bgG;
  let b = bgB;

  // Nebula: soft radial falloff toward the tint. Stars later stay crisp.
  for (const neb of nebulae) {
    // AABB early-out before the sqrt: most pixels are far from a blob.
    const dx = px - neb.cx;
    if (dx > neb.radius || dx < -neb.radius) continue;
    const dy = py - neb.cy;
    if (dy > neb.radius || dy < -neb.radius) continue;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > neb.radius) continue;
    const strength = smoothstep(neb.radius, neb.radius * 0.35, dist) * neb.strength;
    r += (neb.tint[0] - bgR) * strength;
    g += (neb.tint[1] - bgG) * strength;
    b += (neb.tint[2] - bgB) * strength;
  }

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = cellX + dx;
      const cy = cellY + dy;
      // Bounds guard: neighbors outside the grid have no stars (an
      // out-of-range index would otherwise alias to a real star in an
      // adjacent row — harmless today, but never rely on the wrap).
      if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) continue;
      const star = stars.get(cy * cells + cx);
      if (!star) continue;
      const dist = Math.sqrt((px - star.cx) ** 2 + (py - star.cy) ** 2);
      if (dist > star.radius) continue;
      const falloff = smoothstep(star.radius, star.radius * 0.25, dist);
      const strength = falloff * star.brightness;
      // Mostly star-white; occasional ice (the seal) or cool-white stars.
      let sr = 219;
      let sg = 229;
      let sb = 244;
      if (star.tint < 0.08) {
        [sr, sg, sb] = hexRgb('#a8c9f0'); // ice
      } else if (star.tint < 0.22) {
        [sr, sg, sb] = [196, 214, 232]; // cool white
      }
      r += (sr - bgR) * strength;
      g += (sg - bgG) * strength;
      b += (sb - bgB) * strength;
    }
  }
  return [clampByte(r), clampByte(g), clampByte(b)];
}

// ---------------------------------------------------------------------------
// fbm value noise (deterministic).
// ---------------------------------------------------------------------------

function elevation(p: number[], seed: number, mountainAmp: number, frequency: number): number {
  const { octaves } = PLANET_ART.noise;
  const raw = fbm(p[0] * frequency, p[1] * frequency, p[2] * frequency, seed, octaves);
  // fbm ∈ [0,1]. Map to [-1,1] and stretch by mountain prominence.
  const centered = (raw - 0.5) * 2 * mountainAmp;
  return clamp(centered, -1, 1);
}

function fbm(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Trilinear value noise with smoothstep interpolation. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = latticeHash(ix, iy, iz, seed);
  const c100 = latticeHash(ix + 1, iy, iz, seed);
  const c010 = latticeHash(ix, iy + 1, iz, seed);
  const c110 = latticeHash(ix + 1, iy + 1, iz, seed);
  const c001 = latticeHash(ix, iy, iz + 1, seed);
  const c101 = latticeHash(ix + 1, iy, iz + 1, seed);
  const c011 = latticeHash(ix, iy + 1, iz + 1, seed);
  const c111 = latticeHash(ix + 1, iy + 1, iz + 1, seed);

  const x00 = lerp(c000, c100, ux);
  const x10 = lerp(c010, c110, ux);
  const x01 = lerp(c001, c101, ux);
  const x11 = lerp(c011, c111, ux);
  const y0 = lerp(x00, x10, uy);
  const y1 = lerp(x01, x11, uy);
  return lerp(y0, y1, uz);
}

/**
 * Deterministic integer-lattice hash → [0,1). Int32 arithmetic only
 * (Math.imul), so identical across platforms and Node versions.
 */
function latticeHash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Seeded planet orientation (yaw/pitch) from the planet id. */
function planetOrientation(planetId: string): { yaw: number; pitch: number } {
  const yaw = (fnv1a(`${planetId}:yaw`) % 360) * (Math.PI / 180);
  const pitch = ((fnv1a(`${planetId}:pitch`) % 180) - 90) * (Math.PI / 180);
  return { yaw, pitch };
}

// ---------------------------------------------------------------------------
// math helpers
// ---------------------------------------------------------------------------

function rotateY(x: number, y: number, z: number, angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}

function rotateX(x: number, y: number, z: number, angle: number): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x, y * c - z * s, y * s + z * c];
}

function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / len, y / len, z / len];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

function clampInt(x: number, min: number, max: number): number {
  return clamp(Math.round(x), min, max);
}

function clampByte(x: number): number {
  return clamp(Math.round(x), 0, 255);
}

const HEX_RGB_CACHE = new Map<string, [number, number, number]>();

function hexRgb(hex: string): [number, number, number] {
  const cached = HEX_RGB_CACHE.get(hex);
  if (cached) return cached;
  const value = parseInt(hex.slice(1), 16);
  const rgb: [number, number, number] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  HEX_RGB_CACHE.set(hex, rgb);
  return rgb;
}
