import {
  RESOURCE_KEYS,
  emptyTechnologyEffects,
  type Planet,
  type PlanetView,
  type PlanetWarning,
  type PlayerId,
  type ReportView,
  type TechnologyEffects,
  type WorldState,
} from '@ashes/contracts';
import { BUILDING_DEFINITIONS, RESEARCH_BY_ID, SHIP_DEFINITIONS } from '@ashes/content';
import { computePlanetRates, storageCapFor } from './economy';
import { constructionOrderViews } from './construction';
import { shipyardOrderViews } from './shipyard';
import { fleetView } from './fleet';
import { planetClassId } from './planet-art';

/**
 * Player-visible planet projection, derived from authoritative state. Warnings
 * are recomputed from the current store, so the UI always reflects the last
 * resolved tick (DEVELOPMENT_PLAN.md §8 presentation rules). Research effects
 * are the owner's aggregate effects, passed in by the engine (they live on the
 * player, not the planet).
 */
export function planetView(
  planet: Planet,
  effects: TechnologyEffects = emptyTechnologyEffects(),
  localFleets: PlanetView['localFleets'] = [],
): PlanetView {
  const storageCap = storageCapFor(planet, effects);
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
    rates: computePlanetRates(planet, effects),
    warnings,
    construction: constructionOrderViews(planet),
    shipyard: shipyardOrderViews(planet),
    localFleets,
    lastResolvedTick: planet.lastResolvedTick,
  };
}

/** The planet-view's local fleets (views for the planet's orbiting fleets). */
export function planetLocalFleetViews(world: WorldState, planet: Planet) {
  const names = new Map(world.planets.map((p) => [p.id, p.name]));
  return planet.localFleets
    .map((id) => world.fleets.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .map((f) => fleetView(f, names));
}

/** The local fleet view helper for a single planet in a world. */
export function fleetViewsAtPlanet(world: WorldState, planetId: string) {
  const planet = world.planets.find((p) => p.id === planetId);
  if (!planet) return [];
  return planetLocalFleetViews(world, planet);
}

/**
 * Recent completions for a player (DEVELOPMENT_PLAN.md §2 reports, M2),
 * derived from the world's immutable order history: completed research,
 * completed ship orders, and completed buildings. Newest first, capped.
 */
export function reportViews(world: WorldState, playerId: PlayerId, limit = 8): ReportView[] {
  const planetName = new Map(world.planets.map((p) => [p.id, p.name]));
  const reports: ReportView[] = [];

  for (const planet of world.planets) {
    if (planet.ownerId !== playerId) continue;
    for (const order of planet.constructionOrders) {
      if (order.status !== 'completed' || order.completedAtTick === null) continue;
      reports.push({
        id: `building:${order.id}`,
        tick: order.completedAtTick,
        kind: 'building_completed',
        label: `${BUILDING_DEFINITIONS[order.building].name} raised`,
        planetId: planet.id,
        planetName: planet.name,
      });
    }
    for (const order of planet.shipyardOrders) {
      if (order.status !== 'completed' || order.completedAtTick === null) continue;
      reports.push({
        id: `ship:${order.id}`,
        tick: order.completedAtTick,
        kind: 'ships_completed',
        label: `${SHIP_DEFINITIONS[order.ship].name} × ${order.quantity} built`,
        planetId: planet.id,
        planetName: planet.name,
      });
    }
  }

  const player = world.players.find((p) => p.id === playerId);
  if (player) {
    for (const order of player.researchOrders) {
      if (order.status !== 'completed' || order.completedAtTick === null) continue;
      const def = RESEARCH_BY_ID[order.technologyId];
      reports.push({
        id: `research:${order.id}`,
        tick: order.completedAtTick,
        kind: 'research_completed',
        label: def ? `${def.name} researched` : order.technologyId,
        planetId: order.hostPlanetId,
        planetName: planetName.get(order.hostPlanetId) ?? null,
      });
    }
  }

  return reports.sort((a, b) => b.tick - a.tick || a.id.localeCompare(b.id)).slice(0, limit);
}
