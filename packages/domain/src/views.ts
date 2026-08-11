import { RESOURCE_KEYS, type Planet, type PlanetView, type PlanetWarning } from '@ashes/contracts';
import { computePlanetRates, storageCapFor } from './economy';
import { planetClassId } from './planet-art';

/**
 * Player-visible planet projection, derived from authoritative state. Warnings
 * are recomputed from the current store, so the UI always reflects the last
 * resolved tick (DEVELOPMENT_PLAN.md §8 presentation rules).
 */
export function planetView(planet: Planet): PlanetView {
  const storageCap = storageCapFor(planet);
  const warnings: PlanetWarning[] = [];
  if (RESOURCE_KEYS.some((r) => planet.resources[r] >= storageCap)) {
    warnings.push('storage_full');
  }
  if (planet.resources.food <= 0) warnings.push('food_deficit');
  if (planet.resources.energy <= 0) warnings.push('energy_deficit');

  return {
    id: planet.id,
    coordinate: planet.coordinate,
    name: planet.name,
    ownerId: planet.ownerId,
    factionId: planet.factionId,
    classId: planetClassId(planet.id),
    abundance: planet.abundance,
    population: planet.population,
    resources: planet.resources,
    buildings: planet.buildings,
    storageCap,
    rates: computePlanetRates(planet),
    warnings,
    lastResolvedTick: planet.lastResolvedTick,
  };
}
