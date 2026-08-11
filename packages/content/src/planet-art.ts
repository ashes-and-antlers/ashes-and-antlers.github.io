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
 * elevation (×0.78–1.10) exactly as the design doc specifies.
 */
export const ART_VERSION = 'art-1';

export const PLANET_ART = {
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
