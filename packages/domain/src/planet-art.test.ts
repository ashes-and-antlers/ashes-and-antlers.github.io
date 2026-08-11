import { describe, expect, it } from 'vitest';
import { planetId, type PlanetView } from '@ashes/contracts';
import { PLANET_ART } from '@ashes/content';
import { renderPlanetArt } from './planet-art';

function makePlanet(
  overrides: Partial<PlanetView['abundance']> = {},
): Pick<PlanetView, 'id' | 'abundance'> {
  return {
    id: planetId('planet:1:2:3:4'),
    abundance: {
      metal: 60,
      mineral: 40,
      food: 55,
      energy: 70,
      ...overrides,
    },
  };
}

function sampleCenter(image: {
  data: Uint8Array;
  width: number;
}): [number, number, number, number] {
  const cx = Math.floor(image.width / 2);
  const i = (cx * image.width + cx) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

function opaquePixels(image: { data: Uint8Array; width: number }): number {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] > 0) count += 1;
  }
  return count;
}

/** Pixels that are not the starfield background (planet disc + stars). */
function nonSpacePixels(image: { data: Uint8Array; width: number }): number {
  const [bgR, bgG, bgB] = hexToRgb(PLANET_ART.starfield.backgroundColor);
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const dr = Math.abs(image.data[i] - bgR);
    const dg = Math.abs(image.data[i + 1] - bgG);
    const db = Math.abs(image.data[i + 2] - bgB);
    if (dr + dg + db > 6) count += 1;
  }
  return count;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

describe('renderPlanetArt', () => {
  it('is deterministic: the same planet renders byte-identical pixels', () => {
    const a = renderPlanetArt(makePlanet(), 96);
    const b = renderPlanetArt(makePlanet(), 96);
    expect(a.data).toEqual(b.data);
    expect(a.width).toBe(96);
    expect(a.height).toBe(96);
  });

  it('renders the planet disc over an opaque starfield', () => {
    const image = renderPlanetArt(makePlanet(), 96);
    // Whole frame is opaque now (space + disc).
    expect(opaquePixels(image)).toBe(96 * 96);
    // Center is on the planet: some surface color, not space.
    const [r, g, b] = sampleCenter(image);
    const [bgR, bgG, bgB] = hexToRgb(PLANET_ART.starfield.backgroundColor);
    expect(Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB)).toBeGreaterThan(6);
    // Corner is deep space (background color, ± a possible faint star).
    const corner = image.data.slice(0, 4);
    expect(corner[3]).toBe(255);
  });

  it('covers roughly the disc area, not the whole canvas', () => {
    const image = renderPlanetArt(makePlanet(), 96);
    const total = 96 * 96;
    const nonSpace = nonSpacePixels(image);
    // DISC=0.8 → disc area ≈ π·(0.8·48)² ≈ 4633 px of 9216 (~50%), plus a
    // small share of star pixels. Well under the full canvas either way.
    expect(nonSpace).toBeGreaterThan(total * 0.35);
    expect(nonSpace).toBeLessThan(total * 0.7);
  });

  it('places stars in the space region (bright pixels off the disc)', () => {
    const image = renderPlanetArt(makePlanet(), 96);
    const [bgR, bgG, bgB] = hexToRgb(PLANET_ART.starfield.backgroundColor);
    const radius = PLANET_ART.disc.radius;
    let starPixels = 0;
    for (let y = 0; y < image.width; y++) {
      for (let x = 0; x < image.width; x++) {
        // Only space pixels can be stars — the disc carries bright terrain.
        const sx = ((x + 0.5) / image.width) * 2 - 1;
        const sy = ((y + 0.5) / image.width) * 2 - 1;
        if ((sx / radius) ** 2 + (sy / radius) ** 2 <= 1) continue;
        const i = (y * image.width + x) * 4;
        // A star is markedly brighter than the background in some channel.
        if (
          image.data[i] > bgR + 60 ||
          image.data[i + 1] > bgG + 60 ||
          image.data[i + 2] > bgB + 60
        ) {
          starPixels += 1;
        }
      }
    }
    expect(starPixels).toBeGreaterThan(0);
  });

  it('renders a soft nebula tint for some planet ids (dust clouds off the disc)', () => {
    const [bgR, bgG, bgB] = hexToRgb(PLANET_ART.starfield.backgroundColor);
    // Planet ids are coordinates; sweep a handful so the test does not depend
    // on one planet's seeded nebula draw (some planets have none).
    let nebulaPlanets = 0;
    for (let n = 1; n <= 8; n++) {
      const image = renderPlanetArt({ ...makePlanet(), id: planetId(`planet:1:1:1:${n}`) }, 96, {
        supersample: 1,
      });
      let softTint = 0;
      for (let y = 0; y < image.width; y++) {
        for (let x = 0; x < image.width; x++) {
          // Skip the disc itself: ocean pixels (#17243a) also fall in the
          // soft-tint band, so only count pixels in the space region.
          const sx = ((x + 0.5) / image.width) * 2 - 1;
          const sy = ((y + 0.5) / image.width) * 2 - 1;
          const radius = PLANET_ART.disc.radius; // same disc as the renderer
          if ((sx / radius) ** 2 + (sy / radius) ** 2 <= 1) continue;
          const i = (y * image.width + x) * 4;
          const dr = image.data[i] - bgR;
          const dg = image.data[i + 1] - bgG;
          const db = image.data[i + 2] - bgB;
          // Soft tint: noticeably shifted but below star brightness — a dust
          // cloud, not a star point.
          if (
            Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 12 &&
            Math.abs(dr) + Math.abs(dg) + Math.abs(db) < 100
          ) {
            softTint += 1;
          }
        }
      }
      // A nebula covers a large soft area (hundreds of px at 96px); stars
      // alone only add a handful of pixels in this band.
      if (softTint > 400) nebulaPlanets += 1;
    }
    // presenceChance is 0.65, so with 8 planets at least one should carry a
    // nebula. (Deterministic per id — this asserts the feature exists.)
    expect(nebulaPlanets).toBeGreaterThan(0);
  });

  it('varies with abundance: metal/mineral (mountains) change the pixels', () => {
    const barren = renderPlanetArt(makePlanet({ metal: 20, mineral: 20 }), 96);
    const craggy = renderPlanetArt(makePlanet({ metal: 100, mineral: 100 }), 96);
    expect(barren.data).not.toEqual(craggy.data);
  });

  it('varies with abundance: food (clouds) change the pixels', () => {
    const arid = renderPlanetArt(makePlanet({ food: 20 }), 96);
    const lush = renderPlanetArt(makePlanet({ food: 100 }), 96);
    expect(arid.data).not.toEqual(lush.data);
  });

  it('varies across planet ids (orientation + noise seeds)', () => {
    const a = renderPlanetArt({ ...makePlanet(), id: planetId('planet:1:1:1:1') }, 96);
    const b = renderPlanetArt({ ...makePlanet(), id: planetId('planet:9:9:9:9') }, 96);
    expect(a.data).not.toEqual(b.data);
  });

  it('clamps the size into the content-defined bounds', () => {
    const tiny = renderPlanetArt(makePlanet(), 8, { supersample: 1 });
    expect(tiny.width).toBe(64);
    const huge = renderPlanetArt(makePlanet(), 99999, { supersample: 1 });
    expect(huge.width).toBe(1024);
  });

  it('supports 1× sampling (supersample: 1)', () => {
    const image = renderPlanetArt(makePlanet(), 96, { supersample: 1 });
    expect(image.width).toBe(96);
    const [r, g, b, a] = sampleCenter(image);
    expect(a).toBe(255);
    expect(r + g + b).toBeGreaterThan(0);
  });
});
