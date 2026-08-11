import type { PlanetId, PlayerId, FactionId } from './ids';
import type { Coordinate } from './coordinate';

export const RESOURCE_KEYS = ['metal', 'mineral', 'food', 'energy'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

/** Per-resource planet-local store. Values are plain numbers (JSON-safe). */
export type ResourceStore = Record<ResourceKey, number>;

/** Per-resource production/upkeep/net rate, in units per tick. */
export type ResourceRates = Record<ResourceKey, number>;

export const BUILDING_KINDS = [
  'settlement',
  'mine',
  'extractor',
  'farm',
  'reactor',
  'storehouse',
  'lab',
  'shipyard',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

/** Building levels per kind; absent kinds are level 0. */
export type BuildingLevels = Partial<Record<BuildingKind, number>>;

/** Conditions the planet UI must surface (DEVELOPMENT_PLAN.md §10, M1). */
export type PlanetWarning = 'storage_full' | 'food_deficit' | 'energy_deficit';

/** Fixed per-planet abundance 0..100; building output multiplies against it. */
export type Abundance = Record<ResourceKey, number>;

/**
 * Authoritative planet state (M1: economy). Owned by the tick engine; the API
 * and web client only see projections (PlanetView) derived from it.
 *
 * `population` is a plain number, not bigint, so the aggregate survives JSON
 * serialization into Postgres (see docs/ADR-003).
 */
export type Planet = {
  id: PlanetId;
  coordinate: Coordinate;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  name: string;
  abundance: Abundance;
  population: number;
  resources: ResourceStore;
  buildings: BuildingLevels;
  lastResolvedTick: number;
  version: number;
};

export function planetIdFromCoordinate(coord: Coordinate): PlanetId {
  return `planet:${coord.galaxy}:${coord.sector}:${coord.system}:${coord.planet}` as PlanetId;
}

export function emptyResourceStore(): ResourceStore {
  return { metal: 0, mineral: 0, food: 0, energy: 0 };
}

export type PlanetView = {
  id: PlanetId;
  coordinate: Coordinate;
  name: string;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  abundance: Abundance;
  population: number;
  resources: ResourceStore;
  buildings: BuildingLevels;
  /** Per-resource storage cap (content-derived). */
  storageCap: number;
  /** Nominal per-tick rates; brownout (energy deficit) only applies at resolution. */
  rates: { production: ResourceRates; upkeep: ResourceRates; net: ResourceRates };
  warnings: PlanetWarning[];
  lastResolvedTick: number;
};
