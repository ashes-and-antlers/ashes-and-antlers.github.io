import type { FactionId } from '@ashes/contracts';

/**
 * Seeded starting package (M1): one player, one faction, one home planet
 * with a starter settlement, population, and resource seed. Planet-name
 * banks are used by worldgen to name worlds deterministically.
 */
export const STARTING_PACKAGE = {
  factionId: 'hearth' as FactionId,
  playerName: 'First Warden of the Hearth',
  startingPopulation: 500,
  startingResources: { metal: 100, mineral: 50, food: 200, energy: 50 } as const,
  startingBuildings: { settlement: 1 } as const,
} as const;

/**
 * Deterministic planet-name parts (worldgen draws from these via its PRNG).
 * The bank yields 26 × 22 = 572 base names; worldgen guarantees uniqueness
 * across all 3,072 planets by appending deterministic Roman suffixes to
 * duplicates (stable coordinate order), so every planet has a distinct name.
 */
export const PLANET_NAME_PARTS = {
  prefixes: [
    'Ember',
    'Ash',
    'Hearth',
    'Stone',
    'Iron',
    'Thorn',
    'Frost',
    'Dune',
    'Bone',
    'Vale',
    'Cinder',
    'Root',
    'Hollow',
    'Rift',
    'Star',
    'Grey',
    'Aether',
    'Void',
    'Nova',
    'Halo',
    'Drift',
    'Quarry',
    'Forge',
    'Bloom',
    'Fallow',
    'Signal',
  ] as const,
  suffixes: [
    'reach',
    'hold',
    'fall',
    'veil',
    'mere',
    'gate',
    'spire',
    'grave',
    'mark',
    'field',
    'nest',
    'den',
    'rift',
    'ward',
    'forge',
    'span',
    'rise',
    'shore',
    'ring',
    'vault',
    'fen',
    'heath',
  ] as const,
};
