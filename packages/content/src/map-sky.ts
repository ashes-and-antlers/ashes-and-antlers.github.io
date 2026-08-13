import { GALAXY_LAYOUT } from './config';

/**
 * Map sky tuning — presentation only, like `planet-art.ts`. The map page
 * renders a deterministic star field behind the interactive chart: a seeded
 * canvas draws each galaxy as a luminous disc of star clusters with a bright
 * core and cold nebula clouds, so the chart reads as a galaxy instead of a
 * few dots. (The spiral arms show through the star density and nebula
 * placement — the old stroked dust lanes were removed: they read as thin
 * lines, not clusters.)
 *
 * These numbers never touch the simulation: they tune how the sky LOOKS. Do
 * not bump CONTENT_VERSION for changes here (art must not invalidate worlds
 * or resolutions); the sky is re-rendered from the seed on every load.
 */
export const MAP_SKY = {
  /** Star points per galaxy (each a tiny canvas rect). */
  starsPerGalaxy: 1800,
  /** Fraction of stars clustered along the spiral arms. */
  armStarFraction: 0.72,
  /** Perpendicular scatter (world units) around the arm polyline. */
  armJitter: 120,
  /** Tangential scatter along the arm. */
  armJitterAlong: 60,
  /** Field stars scatter across the whole disc; drawn at low alpha. */
  fieldStarFraction: 0.28,
  /** Star sizes in world units (drawn at ≥0.55 px on screen). */
  starSizeMin: 0.55,
  starSizeMax: 1.35,
  /** Rare larger stars that pop as points of light. */
  brightStarChance: 0.03,
  brightStarSize: 2.1,
  /** Small fraction tinted ice (the seal), the rest star-white. */
  iceStarChance: 0.08,
  /** Star alpha range; stars inside the core brighten toward alphaMax. */
  alphaMin: 0.2,
  alphaMax: 0.72,
  /**
   * Screen-scale clamp: stars fade toward the chart view (where they would
   * overplot into a mushy disc) and sharpen as you zoom in.
   */
  starAlphaAtScale: 8,
  starAlphaScaleFloor: 0.35,
  /** Nebula blobs drifting along the arms (very low alpha, cold hues). */
  nebulaCount: 4,
  nebulaRadiusMin: 260,
  nebulaRadiusMax: 520,
  nebulaAlphaMax: 0.07,
  /** Dust lane: the arm polyline stroked twice, wide-and-faint + narrow. */
  dustWidthOuter: 110,
  dustWidthInner: 40,
  dustAlphaOuter: 0.03,
  dustAlphaInner: 0.055,
  /** Core glow + hot inner core, as fractions of the galaxy disc radius. */
  coreGlowRadiusFactor: 0.55,
  coreGlowAlpha: 0.12,
  hotCoreRadiusFactor: 0.18,
  hotCoreAlpha: 0.18,
  /**
   * Diffuse disc glow: the whole galaxy reads as a luminous cluster of
   * stars — a soft disc of light fading from a cool center to the rim —
   * instead of a few thin dust-lane strokes.
   */
  discGlowAlphaCore: 0.09,
  discGlowAlphaMid: 0.04,
  /** Sampling steps per spiral arm polyline. */
  armPathSteps: 12,
  /** Stars beyond this multiple of the disc radius are dropped. */
  starSpillLimit: 1.08,
} as const;

export type MapSkyConfig = typeof MAP_SKY;

/** Core radius constant reused by the sky's core-brightening rule. */
export const MAP_SKY_CORE_RADIUS = GALAXY_LAYOUT.galaxyCoreRadius;
