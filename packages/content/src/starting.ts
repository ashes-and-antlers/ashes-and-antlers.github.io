import type { FactionId } from '@ashes/contracts';

/**
 * Seeded starting package (M0): one player, one faction, one home planet.
 * Planet-name banks are used by worldgen to name worlds deterministically.
 */
export const STARTING_PACKAGE = {
  factionId: 'hearth' as FactionId,
  playerName: 'First Warden of the Hearth',
} as const;

/** Deterministic planet-name parts (worldgen draws from these via its PRNG). */
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
  ] as const,
};
