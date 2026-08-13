import { describe, expect, it } from 'vitest';
import { technologyId, type Planet } from '@ashes/contracts';
import { aggregateResearchEffects } from '@ashes/content';
import { computePlanetStateHash, generateWorld } from './worldgen';
import { computePlanetRates, resolveEconomyTick } from './economy';
import { planetView } from './views';

const FULL = { metal: 100, mineral: 100, food: 100, energy: 100 };

function makeWorld(seed = 1337, createdAt = 1000) {
  const world = generateWorld({
    seed,
    config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
    createdAt,
  });
  return world;
}

function homePlanet(world: ReturnType<typeof makeWorld>): Planet {
  const player = world.players[0];
  const home = world.planets.find((p) => p.id === player.homePlanetId);
  if (!home) throw new Error('home planet missing');
  return home;
}

/** Home planet with fixed abundance/buildings/resources for hand-checkable math. */
function economyWorld(seed = 1337) {
  const world = makeWorld(seed);
  const home = homePlanet(world);
  home.abundance = { ...FULL };
  home.buildings = { settlement: 1, mine: 2, farm: 1, reactor: 1 };
  home.resources = { metal: 0, mineral: 0, food: 100, energy: 0 };
  home.population = 500;
  return world;
}

describe('computePlanetRates (M1 formula contract)', () => {
  it('produces floor(baseOutput × level × abundance/100) and applies upkeep', () => {
    const world = economyWorld();
    const rates = computePlanetRates(homePlanet(world));
    // mine L2 on 100 abundance → 10·2·1 = 20 metal; farm L1 → 10 food; reactor L1 → 10 energy.
    expect(rates.production).toEqual({ metal: 20, mineral: 0, food: 10, energy: 10 });
    // settlement {food 1, energy 1} + mine L2 {energy 2} + farm {energy 1}.
    expect(rates.upkeep).toEqual({ metal: 0, mineral: 0, food: 1, energy: 4 });
    expect(rates.net).toEqual({ metal: 20, mineral: 0, food: 9, energy: 6 });
  });

  it('scales output with abundance (halves at 50)', () => {
    const world = economyWorld();
    const home = homePlanet(world);
    home.abundance = { ...FULL, metal: 50 };
    const rates = computePlanetRates(home);
    expect(rates.production.metal).toBe(10);
  });
});

describe('resolveEconomyTick (M1 acceptance: exact totals over a tick sequence)', () => {
  it('matches hand-computed resource totals across 3 ticks', () => {
    let world = economyWorld();
    for (let tick = 1; tick <= 3; tick++) {
      const out = resolveEconomyTick({ world, tick, resolvedAt: world.nextTickAt });
      world = out.world;
    }
    const home = homePlanet(world);
    // metal 20/tick; food +10 then −1 upkeep; energy +10 then −4 upkeep; pop +5/tick.
    expect(home.resources).toEqual({ metal: 60, mineral: 0, food: 127, energy: 18 });
    expect(home.population).toBe(515);
    expect(home.lastResolvedTick).toBe(3);
    expect(world.tick).toBe(3);
  });

  it('does not touch unowned planets except the resolved-tick stamp', () => {
    let world = economyWorld();
    const out = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    world = out.world;
    const unowned = world.planets.filter((p) => !p.ownerId);
    expect(unowned.length).toBeGreaterThan(0);
    for (const p of unowned) {
      expect(p.resources).toEqual({ metal: 0, mineral: 0, food: 0, energy: 0 });
      expect(p.population).toBe(0);
      expect(p.lastResolvedTick).toBe(1);
    }
  });

  it('clamps storage at the cap and flags storage_full', () => {
    const world = economyWorld();
    const home = homePlanet(world);
    home.resources = { metal: 490, mineral: 0, food: 100, energy: 0 };
    const { world: next } = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const after = homePlanet(next);
    // 490 + 20 would be 510 → clamped to the 500 base cap.
    expect(after.resources.metal).toBe(500);
    expect(planetView(after).warnings).toContain('storage_full');
  });

  it('halves production when energy upkeep cannot be covered (brownout)', () => {
    const world = economyWorld();
    const home = homePlanet(world);
    home.buildings = { settlement: 1, mine: 2 };
    home.resources = { metal: 0, mineral: 0, food: 100, energy: 0 };
    const { world: next } = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const after = homePlanet(next);
    // 20 metal produced would need 3 energy upkeep with 0 stored+produced → halved to 10.
    expect(after.resources.metal).toBe(10);
    expect(after.resources.energy).toBe(0);
    expect(planetView(after).warnings).toContain('energy_deficit');
  });

  it('starves population when food demand cannot be met', () => {
    const world = economyWorld();
    const home = homePlanet(world);
    home.buildings = { settlement: 1 };
    home.resources = { metal: 0, mineral: 0, food: 0, energy: 10 };
    const { world: next } = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const after = homePlanet(next);
    // demand = 1 (settlement) + 0 (500 pop < 1000) → starving: 500 − 25.
    expect(after.population).toBe(475);
    expect(after.resources.food).toBe(0);
    expect(planetView(after).warnings).toContain('food_deficit');
  });
});

describe('research effects on the economy (M2)', () => {
  it('extraction research multiplies production (floor)', () => {
    const world = economyWorld();
    world.players[0].technologies = [technologyId('extraction-1')];
    const rates = computePlanetRates(
      homePlanet(world),
      aggregateResearchEffects(world.players[0].technologies),
    );
    // mine L2 on 100 abundance → 20 × 1.15 = 23.
    expect(rates.production.metal).toBe(23);
  });

  it('storage research raises the storage cap', () => {
    const world = economyWorld();
    world.players[0].technologies = [technologyId('storage-1')];
    const home = homePlanet(world);
    home.resources = { metal: 600, mineral: 0, food: 100, energy: 0 };
    const { world: next } = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    // Base cap 500 × 1.25 = 625; 600 + 20 metal fits.
    expect(homePlanet(next).resources.metal).toBe(620);
  });

  it('upkeep reduction research trims building upkeep (floor)', () => {
    const world = economyWorld();
    world.players[0].technologies = [technologyId('grid-1')];
    const rates = computePlanetRates(
      homePlanet(world),
      aggregateResearchEffects(world.players[0].technologies),
    );
    // Upkeep is floored per building: settlement 1→0, mine L2 2→1, farm 1→0 → 1.
    expect(rates.upkeep.energy).toBe(1);
  });

  it("effects only apply to the researching player's planets", () => {
    const world = economyWorld();
    world.players[0].technologies = [technologyId('extraction-1')];
    const home = homePlanet(world);
    // The home planet belongs to the researching player: boosted.
    const owned = computePlanetRates(home, aggregateResearchEffects(world.players[0].technologies));
    expect(owned.production.metal).toBe(23);
  });
});

describe('economy determinism', () => {
  it('same world + tick → identical resolution and state hash', () => {
    const world = economyWorld();
    const a = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    const b = resolveEconomyTick({ world, tick: 1, resolvedAt: world.nextTickAt });
    expect(a.resolution.seed).toBe(b.resolution.seed);
    expect(a.resolution.planetStateHash).toBe(b.resolution.planetStateHash);
    expect(a.resolution.phaseHashes).toEqual(b.resolution.phaseHashes);
    expect(a.world.worldHash).toBe(b.world.worldHash);
  });

  it('planet-state hash changes as the economy advances', () => {
    let world = economyWorld();
    const hashes: string[] = [];
    for (let tick = 1; tick <= 3; tick++) {
      const out = resolveEconomyTick({ world, tick, resolvedAt: world.nextTickAt });
      world = out.world;
      hashes.push(computePlanetStateHash(world.planets));
    }
    expect(new Set(hashes).size).toBe(3);
  });

  it('stores and hash-includes the economy fields', () => {
    const world = economyWorld();
    const home = homePlanet(world);
    const before = computePlanetStateHash(world.planets);
    home.resources = { ...home.resources, metal: home.resources.metal + 1 };
    expect(computePlanetStateHash(world.planets)).not.toBe(before);
  });
});
