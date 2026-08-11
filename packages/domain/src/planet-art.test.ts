import { describe, expect, it } from 'vitest';
import { planetId, type PlanetView } from '@ashes/contracts';
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

describe('renderPlanetArt', () => {
  it('is deterministic: the same planet renders byte-identical pixels', () => {
    const a = renderPlanetArt(makePlanet(), 96);
    const b = renderPlanetArt(makePlanet(), 96);
    expect(a.data).toEqual(b.data);
    expect(a.width).toBe(96);
    expect(a.height).toBe(96);
  });

  it('renders a disc: center opaque, corners transparent', () => {
    const image = renderPlanetArt(makePlanet(), 96);
    const [r, g, b, a] = sampleCenter(image);
    expect(a).toBe(255);
    // Center is on the planet; some non-black surface color (lit terrain).
    expect(r + g + b).toBeGreaterThan(0);
    // Corner pixel (0,0) — outside the disc.
    const corner = image.data.slice(0, 4);
    expect(corner[3]).toBe(0);
  });

  it('covers roughly the disc area, not the whole canvas', () => {
    const image = renderPlanetArt(makePlanet(), 96);
    const total = 96 * 96;
    const opaque = opaquePixels(image);
    // DISC=0.8 → disc area ≈ π·(0.8·48)² ≈ 4633 px of 9216 (~50%).
    expect(opaque).toBeGreaterThan(total * 0.35);
    expect(opaque).toBeLessThan(total * 0.7);
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
