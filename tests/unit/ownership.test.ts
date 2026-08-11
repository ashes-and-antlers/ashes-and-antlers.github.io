import { describe, expect, it } from 'vitest';
import { FactionId } from '../../src/sim/data/content';
import { makeSim } from '../helpers';

describe('ownership system', () => {
  it('claims tiles around each command center', () => {
    const sim = makeSim({ seed: 8012, width: 64, height: 64 });
    const c = sim.world.components;
    const cc = sim.world.commandCenters[0]!;
    const cx = c.Position.x[cc]!;
    const cy = c.Position.y[cc]!;
    const faction = c.Faction[cc] as FactionId;

    sim.step(6); // ownership recomputes every 5 ticks

    const centerTile = sim.world.tiles.index(cx, cy);
    expect(sim.world.owner[centerTile]).toBe(faction);

    // Tiles well outside any radius stay neutral.
    const corner = sim.world.tiles.index(0, 0);
    expect(sim.world.owner[corner]).toBe(FactionId.None);
  });

  it('is deterministic across runs', () => {
    const a = makeSim({ seed: 4242, width: 64, height: 64 });
    const b = makeSim({ seed: 4242, width: 64, height: 64 });
    a.step(10);
    b.step(10);
    expect(a.world.owner).toEqual(b.world.owner);
  });
});
