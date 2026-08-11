import { factionId, type FactionId } from '@ashes/contracts';

export type Faction = {
  id: FactionId;
  name: string;
  /** Strategic profile from DEVELOPMENT_PLAN.md §1. */
  profile: string;
};

export const FACTIONS: Faction[] = [
  {
    id: factionId('hearth'),
    name: 'Hearth Confederacy',
    profile:
      'Fortress-world builders preserving old civic institutions, hearth-reactors, and archive networks. Strong infrastructure, energy stability, defenses, and a reliable economy.',
  },
  {
    id: factionId('iron'),
    name: 'Iron Swarm',
    profile:
      'Mobile caste fleets that strip, repurpose, and rapidly establish nests on frontier worlds. Fast scouting, raiding, colonization pressure, and flexible fleet doctrine.',
  },
];

export function factionById(id: FactionId): Faction | undefined {
  return FACTIONS.find((f) => f.id === id);
}
