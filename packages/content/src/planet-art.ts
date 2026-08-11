/**
 * Planet art (M1, "planets without hand-drawn assets"): data-driven config for
 * the deterministic CPU renderer in `@ashes/domain` (planet-art.ts).
 *
 * ART_VERSION is presentation-only. It deliberately does NOT ride on
 * CONTENT_VERSION: art affects no simulation outcome, so re-tuning a color
 * must not invalidate worlds or resolutions. The API keys its image cache on
 * ART_VERSION so palette changes re-render naturally.
 *
 * The terrain gamut is the DESIGN.md "living map" palette (deep water → water →
 * marsh → grass → forest → hill → mountain); the renderer shades each band by
 * elevation (×0.78–1.10) exactly as the design doc specifies. The deep-space
 * backdrop matches the site's space field (DESIGN.md art-4): near-black with
 * a whisper of cool blue, cool star-white/ice nebula dust.
 */
export const ART_VERSION = 'art-4';

export const PLANET_ART = {
  /**
   * Disc geometry: fraction of the half-frame the planet disc fills. < 1
   * leaves room around the limb for the atmosphere rim and the starfield.
   */
  disc: {
    radius: 0.8,
  },
  /** Elevation bands: lowest first. `elevation` is the top of the band. */
  terrain: [
    { elevation: -0.14, color: '#17243a' }, // deep water
    { elevation: -0.02, color: '#2a4d8f' }, // water
    { elevation: 0.06, color: '#4e5f35' }, // marsh
    { elevation: 0.24, color: '#5d8a3c' }, // grass
    { elevation: 0.44, color: '#2e5a2c' }, // forest
    { elevation: 0.66, color: '#8a7a52' }, // hill
    { elevation: 1.0, color: '#9ca2aa' }, // mountain
  ],
  clouds: {
    color: '#d3c7ac', // bone
    /** Fraction of the surface a planet's cloud layer can cover. */
    coverageBase: 0.42,
    /** Added coverage from food abundance: lush planets are cloudier. */
    coverageFromFood: 0.4,
    alpha: 0.85,
  },
  atmosphere: {
    /** Fresnel rim tint at the limb (bone). */
    rimColor: '#d3c7ac',
    rimStrength: 0.32,
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
    /** Base fbm frequency on the unit sphere. */
    baseFrequency: 2.4,
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
