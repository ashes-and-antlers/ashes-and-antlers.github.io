import {
  BUILDING_KINDS,
  RESOURCE_KEYS,
  type Planet,
  type ResourceKey,
  type ResourceRates,
  type ResourceStore,
  type TickResolution,
  type WorldState,
} from '@ashes/contracts';
import { BUILDING_DEFINITIONS, ECONOMY } from '@ashes/content';
import { computePlanetStateHash } from './worldgen';
import { hashHex } from './prng';

export type TickInput = {
  world: WorldState;
  tick: number;
  /** Epoch ms when the next tick will resolve (the command cutoff). */
  resolvedAt: number;
};

export function emptyRates(): ResourceRates {
  return { metal: 0, mineral: 0, food: 0, energy: 0 };
}

/** Per-resource storage cap from content: base + storehouse bonus. */
export function storageCapFor(planet: Planet): number {
  const storehouseLevel = planet.buildings.storehouse ?? 0;
  return ECONOMY.storage.basePerResource + storehouseLevel * ECONOMY.storage.perStorehouseLevel;
}

/**
 * Nominal per-tick rates for a planet: production and upkeep from its current
 * buildings × abundance, plus the net. Pure and deterministic; brownout (an
 * energy deficit at resolution) only affects the resolved store, not these
 * nominal rates.
 */
export function computePlanetRates(planet: Planet): {
  production: ResourceRates;
  upkeep: ResourceRates;
  net: ResourceRates;
} {
  const production = emptyRates();
  const upkeep = emptyRates();
  for (const kind of BUILDING_KINDS) {
    const level = planet.buildings[kind] ?? 0;
    if (level <= 0) continue;
    const def = BUILDING_DEFINITIONS[kind];
    for (const r of def.produces) {
      production[r] += Math.floor(
        (ECONOMY.production.baseOutputPerLevel * level * planet.abundance[r]) / 100,
      );
    }
    for (const [r, amount] of Object.entries(def.upkeep)) {
      upkeep[r as ResourceKey] += amount * level;
    }
  }
  const net = emptyRates();
  for (const r of RESOURCE_KEYS) {
    net[r] = production[r] - upkeep[r];
  }
  return { production, upkeep, net };
}

/**
 * The M1 resolution phase: the economy. Each owned planet produces resources
 * from its buildings (scaled by abundance), pays energy/food upkeep, applies
 * the storage cap, and grows (or starves) its population. Unowned planets are
 * untouched except for the resolved-tick stamp.
 *
 * Pure and deterministic: given the same world + tick + resolvedAt, the
 * resulting world and resolution are always identical.
 */
export function resolveEconomyTick(input: TickInput): {
  world: WorldState;
  resolution: TickResolution;
} {
  const { world, tick } = input;
  const resolvedAt = input.resolvedAt;

  // Deterministic per (world, tick, content) seed for this resolution.
  const seed = hashHex(`tick:${world.id}:${tick}:${world.contentVersion}:${world.seed}`);
  const planets = world.planets.map((p) =>
    p.ownerId ? resolvePlanetEconomy(p, tick) : { ...p, lastResolvedTick: tick },
  );
  const planetStateHash = computePlanetStateHash(planets);
  const phaseHashes: Record<string, string> = {
    economy: hashHex(`phase:economy:${seed}`),
    planets: planetStateHash,
  };

  const next: WorldState = {
    ...world,
    tick,
    lastResolvedAt: resolvedAt,
    nextTickAt: resolvedAt + world.tickDurationMs,
    planets,
    version: world.version + 1,
  };

  const resolution: TickResolution = {
    worldId: world.id,
    tick,
    contentVersion: world.contentVersion,
    commandCutoffAt: world.nextTickAt,
    resolvedAt,
    seed,
    phaseHashes,
    planetStateHash,
    status: 'completed',
  };

  return { world: next, resolution };
}

function resolvePlanetEconomy(planet: Planet, tick: number): Planet {
  const rates = computePlanetRates(planet);
  const cap = storageCapFor(planet);
  const resources: ResourceStore = { ...planet.resources };
  const produced = rates.production;
  const upkeep = rates.upkeep;

  // Energy brownout: when stored + produced energy cannot cover this tick's
  // energy upkeep, all production is halved (floor). The deficit surfaces in
  // the view as an energy_deficit warning.
  let effective = produced;
  if (resources.energy + produced.energy < upkeep.energy) {
    effective = halveRates(produced);
  }

  // Produce, clamped at the storage cap.
  for (const r of RESOURCE_KEYS) {
    resources[r] = Math.min(cap, resources[r] + effective[r]);
  }

  // Pay energy upkeep (energy can bottom out at 0).
  resources.energy = Math.max(0, resources.energy - upkeep.energy);

  // Food: settlement upkeep + population consumption. A population that
  // cannot be fed shrinks; a fed population grows toward capacity.
  const foodDemand =
    upkeep.food +
    Math.floor(planet.population / 1000) * ECONOMY.population.foodPer1000PopulationPerTick;
  const starving = resources.food < foodDemand;
  resources.food = Math.max(0, resources.food - foodDemand);

  let population = planet.population;
  if (starving) {
    population = Math.max(0, population - ECONOMY.population.starvationShrinkPerTick);
  } else {
    const settlementLevel = planet.buildings.settlement ?? 0;
    const capacity =
      ECONOMY.population.baseCapacity + settlementLevel * ECONOMY.population.perSettlementLevel;
    const growth = Math.min(
      ECONOMY.population.maxGrowthPerTick,
      Math.floor(population * ECONOMY.population.growthFractionPerTick),
    );
    population = Math.min(capacity, population + growth);
  }

  return {
    ...planet,
    resources,
    population,
    lastResolvedTick: tick,
    version: planet.version + 1,
  };
}

function halveRates(rates: ResourceRates): ResourceRates {
  const factor = ECONOMY.brownoutProductionFactor;
  return {
    metal: Math.floor(rates.metal * factor),
    mineral: Math.floor(rates.mineral * factor),
    food: Math.floor(rates.food * factor),
    energy: Math.floor(rates.energy * factor),
  };
}
