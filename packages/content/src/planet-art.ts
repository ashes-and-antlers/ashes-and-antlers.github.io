/**
 * Planet art (M1, "planets without hand-drawn assets"): data-driven config for
 * the deterministic CPU renderer in `@ashes/domain` (planet-art.ts).
 *
 * ART_VERSION is presentation-only. It deliberately does NOT ride on
 * CONTENT_VERSION: art affects no simulation outcome, so re-tuning a color
 * must not invalidate worlds or resolutions. The API keys its image cache on
 * ART_VERSION so palette changes re-render naturally.
 *
 * Every planet draws from one of the PLANET_CLASSES below, selected
 * deterministically from the planet id. Each class carries its own terrain
 * ramp (deep water → mountain), cloud color/coverage, atmosphere rim, and
 * optional banding (gas giants) — so a desert world, an ice world, and a
 * terrestrial world are unmistakably different at a glance. The deep-space
 * backdrop matches the site's space field (DESIGN.md art-4): near-black with
 * a whisper of cool blue, cool star-white/ice nebula dust.
 */
export const ART_VERSION = 'art-5';

// The class key type lives in @ashes/contracts (contracts must not depend on
// content); content owns the palettes and re-exports the key for consumers.
import type { PlanetClassKey } from '@ashes/contracts';
export type { PlanetClassKey } from '@ashes/contracts';

/**
 * One visual class of planet. `elevation` is the top of each terrain band
 * (lowest first); the renderer blends between adjacent bands with the same
 * elevation → color ramp used by the base design. `banding` is only used by
 * gas giants: latitude-driven horizontal bands with a softer ramp.
 */
export type PlanetClass = {
  key: PlanetClassKey;
  name: string;
  /** Map-dot tint for this class (web uses it; presentation only). */
  mapColor: string;
  /** 0..1 — roughly how often this class appears across all worlds. */
  weight: number;
  terrain: Array<{ elevation: number; color: string }>;
  clouds: {
    color: string;
    /** Fraction of the surface a planet's cloud layer can cover. */
    coverageBase: number;
    /** Extra coverage from food abundance. */
    coverageFromFood: number;
    alpha: number;
  };
  atmosphere: {
    rimColor: string;
    rimStrength: number;
  };
  /** Gas giants: horizontal latitude bands, blended with the terrain ramp. */
  banding?: {
    /** Number of latitude bands across the disc. */
    count: number;
    /** Amplitude of the band color oscillation. */
    amplitude: number;
  };
  /** Value-noise frequency; gas giants run smoother, rocky worlds rougher. */
  noiseFrequency: number;
};

export const PLANET_CLASSES: readonly PlanetClass[] = [
  {
    key: 'terrestrial',
    name: 'Terrestrial',
    mapColor: '#5d8a3c',
    weight: 0.22,
    terrain: [
      { elevation: -0.14, color: '#17243a' },
      { elevation: -0.02, color: '#2a4d8f' },
      { elevation: 0.06, color: '#4e5f35' },
      { elevation: 0.24, color: '#5d8a3c' },
      { elevation: 0.44, color: '#2e5a2c' },
      { elevation: 0.66, color: '#8a7a52' },
      { elevation: 1.0, color: '#9ca2aa' },
    ],
    clouds: { color: '#d3c7ac', coverageBase: 0.42, coverageFromFood: 0.4, alpha: 0.85 },
    atmosphere: { rimColor: '#d3c7ac', rimStrength: 0.32 },
    noiseFrequency: 2.4,
  },
  {
    key: 'ocean',
    name: 'Ocean',
    mapColor: '#2a6fb0',
    weight: 0.13,
    terrain: [
      { elevation: -0.16, color: '#0c1a33' },
      { elevation: -0.02, color: '#1c5b9e' },
      { elevation: 0.1, color: '#3fa0c9' },
      { elevation: 0.3, color: '#2b7fae' },
      { elevation: 0.6, color: '#1f4a6e' },
      { elevation: 1.0, color: '#b8cfe0' },
    ],
    clouds: { color: '#e8eef5', coverageBase: 0.55, coverageFromFood: 0.35, alpha: 0.9 },
    atmosphere: { rimColor: '#8fc3e8', rimStrength: 0.4 },
    noiseFrequency: 1.6,
  },
  {
    key: 'desert',
    name: 'Desert',
    mapColor: '#c99a52',
    weight: 0.13,
    terrain: [
      { elevation: -0.1, color: '#2b1f14' },
      { elevation: 0.0, color: '#8a6a3a' },
      { elevation: 0.2, color: '#c99a52' },
      { elevation: 0.5, color: '#d9b36e' },
      { elevation: 0.75, color: '#a67c4a' },
      { elevation: 1.0, color: '#7a5a38' },
    ],
    clouds: { color: '#e8d5ae', coverageBase: 0.08, coverageFromFood: 0.15, alpha: 0.7 },
    atmosphere: { rimColor: '#e0b878', rimStrength: 0.28 },
    noiseFrequency: 2.0,
  },
  {
    key: 'ice',
    name: 'Ice',
    mapColor: '#d8e8f4',
    weight: 0.12,
    terrain: [
      { elevation: -0.12, color: '#1a2c4e' },
      { elevation: -0.02, color: '#4a6c9e' },
      { elevation: 0.1, color: '#a8c4de' },
      { elevation: 0.35, color: '#d8e8f4' },
      { elevation: 0.65, color: '#eef4fa' },
      { elevation: 1.0, color: '#ffffff' },
    ],
    clouds: { color: '#ffffff', coverageBase: 0.5, coverageFromFood: 0.2, alpha: 0.8 },
    atmosphere: { rimColor: '#bcdcf4', rimStrength: 0.45 },
    noiseFrequency: 1.8,
  },
  {
    key: 'volcanic',
    name: 'Volcanic',
    mapColor: '#d1501e',
    weight: 0.1,
    terrain: [
      { elevation: -0.12, color: '#160b0b' },
      { elevation: -0.02, color: '#2e1a16' },
      { elevation: 0.08, color: '#4a2a22' },
      { elevation: 0.3, color: '#6e3a30' },
      { elevation: 0.55, color: '#932e1e' },
      { elevation: 0.8, color: '#d1501e' },
      { elevation: 1.0, color: '#ff9a3c' },
    ],
    clouds: { color: '#8a8a94', coverageBase: 0.35, coverageFromFood: 0.1, alpha: 0.85 },
    atmosphere: { rimColor: '#e07040', rimStrength: 0.5 },
    noiseFrequency: 3.0,
  },
  {
    key: 'toxic',
    name: 'Toxic',
    mapColor: '#8aa042',
    weight: 0.1,
    terrain: [
      { elevation: -0.12, color: '#1a2414' },
      { elevation: -0.02, color: '#3c4a2a' },
      { elevation: 0.1, color: '#5c6e2e' },
      { elevation: 0.35, color: '#8aa042' },
      { elevation: 0.65, color: '#b8a844' },
      { elevation: 1.0, color: '#c86a4a' },
    ],
    clouds: { color: '#c8b050', coverageBase: 0.5, coverageFromFood: 0.1, alpha: 0.9 },
    atmosphere: { rimColor: '#b8c84a', rimStrength: 0.38 },
    noiseFrequency: 2.2,
  },
  {
    key: 'gas',
    name: 'Gas giant',
    mapColor: '#a87a5e',
    weight: 0.12,
    terrain: [
      { elevation: -0.15, color: '#2e3a4e' },
      { elevation: -0.02, color: '#5a4a6e' },
      { elevation: 0.1, color: '#8a6a8e' },
      { elevation: 0.35, color: '#c99a7e' },
      { elevation: 0.6, color: '#a87a5e' },
      { elevation: 1.0, color: '#6e5a4e' },
    ],
    clouds: { color: '#e0d0b0', coverageBase: 0.3, coverageFromFood: 0.0, alpha: 0.35 },
    atmosphere: { rimColor: '#d0b8a0', rimStrength: 0.3 },
    banding: { count: 7, amplitude: 0.12 },
    noiseFrequency: 1.2,
  },
  {
    key: 'barren',
    name: 'Barren',
    mapColor: '#8a8a94',
    weight: 0.08,
    terrain: [
      { elevation: -0.12, color: '#1c1c22' },
      { elevation: -0.02, color: '#3c3c44' },
      { elevation: 0.15, color: '#5c5c64' },
      { elevation: 0.5, color: '#7c7c84' },
      { elevation: 0.8, color: '#9c9ca4' },
      { elevation: 1.0, color: '#b4b4bc' },
    ],
    clouds: { color: '#d0d0d0', coverageBase: 0.02, coverageFromFood: 0.05, alpha: 0.6 },
    atmosphere: { rimColor: '#9c9ca4', rimStrength: 0.18 },
    noiseFrequency: 2.6,
  },
] as const;

/**
 * Base planet art (shared by all classes): disc geometry, lighting, noise
 * octaves, starfield and nebula backdrop, render sizes.
 */
export const PLANET_ART = {
  /**
   * Disc geometry: fraction of the half-frame the planet disc fills. < 1
   * leaves room around the limb for the atmosphere rim and the starfield.
   */
  disc: {
    radius: 0.8,
  },
  /**
   * Deep-space backdrop painted behind the planet disc (art-4). Matches the
   * site's space field (DESIGN.md "The Deep Archive"): near-black with a
   * whisper of cool blue, so the portraits sit inside the same void as the UI.
   */
  starfield: {
    /** Space color — deep space, a whisper of cool blue (matches --bg). */
    backgroundColor: '#0a0e14',
    /** Stars are drawn on a hash lattice: roughly one per cell. */
    cellSize: 14,
    /** Probability a cell contains a star. */
    starChance: 0.55,
    /** Star size in pixels (1 = single pixel). */
    starRadius: 1.1,
    /** Rare brighter stars. */
    brightStarChance: 0.06,
    /** Bright-star size in pixels. */
    brightStarRadius: 1.9,
    /** Base star brightness multiplier (restrained: star-white, not white-hot). */
    starBrightness: 0.75,
  },
  /**
   * Nebula / dust-cloud backdrop (art-4): a seeded set of soft-tinted blobs
   * so each planet's sky varies beyond star positions. Subtle and in-palette
   * (space neutrals — deep indigo, slate, cool grey — with ice rare, per The
   * Ice Seal Rule).
   */
  nebula: {
    /** Probability a planet carries any nebula at all. */
    presenceChance: 0.65,
    /** Number of dust blobs when present. */
    blobCount: { min: 1, max: 3 },
    /** Blob radius as a fraction of the canvas size. */
    blobRadius: { min: 0.22, max: 0.45 },
    /** Peak tint strength — kept low so stars and the planet stay dominant. */
    maxStrength: 0.38,
    /** Per-blob strength jitter (0..1 of maxStrength). */
    strengthJitter: 0.5,
    /** Probability the blob takes the ice tint (The Ice Seal Rule). */
    iceChance: 0.12,
    /** Palette tints, in-palette and restrained (space-neutrals gamut). */
    tints: ['#2c3d5c', '#4a5a7a', '#7c8ca8'],
    iceTint: '#a8c9f0',
  },
  lighting: {
    ambient: 0.45,
    /** Elevation shade factor (DESIGN.md: ×0.78–1.10). */
    shadeMin: 0.78,
    shadeMax: 1.1,
  },
  noise: {
    /** Base fbm octaves (frequency is per-class). */
    octaves: 5,
    /** Mountain prominence gain from (metal+mineral)/200. */
    mountainBoost: 0.55,
    cloudFrequency: 3.2,
    cloudOctaves: 4,
  },
  render: {
    /** Default image size in pixels (square). */
    defaultSize: 512,
    minSize: 64,
    maxSize: 1024,
  },
} as const;

export type PlanetArtConfig = typeof PLANET_ART;
