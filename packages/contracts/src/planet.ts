import type { PlanetId, PlayerId, FactionId } from './ids';
import type { Coordinate } from './coordinate';

export const RESOURCE_KEYS = ['metal', 'mineral', 'food', 'energy'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Fixed per-planet abundance 0..100; building output multiplies against it. */
export type Abundance = Record<ResourceKey, number>;

/**
 * M0 planet: identity, coordinate, ownership, abundance, and the last tick the
 * planet was resolved. Resources, buildings, and population arrive in M1.
 */
export type Planet = {
  id: PlanetId;
  coordinate: Coordinate;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  name: string;
  abundance: Abundance;
  lastResolvedTick: number;
  version: number;
};

export function planetIdFromCoordinate(coord: Coordinate): PlanetId {
  return `planet:${coord.galaxy}:${coord.sector}:${coord.system}:${coord.planet}` as PlanetId;
}

export type PlanetView = {
  id: PlanetId;
  coordinate: Coordinate;
  name: string;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  abundance: Abundance;
  lastResolvedTick: number;
};

export function toPlanetView(planet: Planet): PlanetView {
  return {
    id: planet.id,
    coordinate: planet.coordinate,
    name: planet.name,
    ownerId: planet.ownerId,
    factionId: planet.factionId,
    abundance: planet.abundance,
    lastResolvedTick: planet.lastResolvedTick,
  };
}
