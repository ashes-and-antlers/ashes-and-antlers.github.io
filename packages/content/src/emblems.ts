import { symbolId, type SymbolId } from '@ashes/contracts';

/**
 * Emblems — the standards a commander picks at registration. The power
 * (faction) itself is assigned automatically for balance (domain spawn.ts
 * picks the least-populated faction), so the emblem bank is deliberately
 * faction-agnostic: any commander may carry any standard.
 *
 * Presentation-only identity (like planet art): the emblem lives on the
 * account, never in sim state, so adding an emblem never invalidates a world
 * or resolution.
 *
 * Each emblem is a single SVG path (48×48 viewBox, stroke-drawn) rendered
 * with the current text color; the account page shows them as selectable
 * plates and the game header wears the chosen one next to the brand mark.
 */
export type FactionSymbol = {
  id: SymbolId;
  name: string;
  path: string;
};

/** The full emblem bank, in content order. */
export const EMBLEMS: FactionSymbol[] = [
  {
    id: symbolId('hearth-crown'),
    name: 'Crown',
    path: 'M8 20l8 6 8-10 8 10 8-6v14H8z',
  },
  {
    id: symbolId('hearth-anvil'),
    name: 'Anvil',
    path: 'M10 16h28M12 14l-3 12h30l-3-12M8 34h32M12 38h24',
  },
  {
    id: symbolId('hearth-flame'),
    name: 'Hearthfire',
    path: 'M24 8c5 7 12 10 12 19a12 12 0 1 1-24 0c0-4 2-7 4-10 1 3 3 5 6 6-1-5 0-10 2-15z',
  },
  {
    id: symbolId('hearth-archive'),
    name: 'Archive',
    path: 'M14 36V14M24 36V8M34 36V14M8 36h32M8 40h32',
  },
  {
    id: symbolId('iron-talon'),
    name: 'Talon',
    path: 'M24 8c-4 7-10 13-13 20-1 3 1 6 4 6l9-6 9 6c3 0 5-3 4-6-3-7-9-13-13-20zM24 8v22',
  },
  {
    id: symbolId('iron-swarm'),
    name: 'Swarm',
    path: 'M14 14a4 4 0 1 0 8 0 4 4 0 0 0-8 0zM30 20a4 4 0 1 0 8 0 4 4 0 0 0-8 0zM10 31a4 4 0 1 0 8 0 4 4 0 0 0-8 0zM26 35a4 4 0 1 0 8 0 4 4 0 0 0-8 0z',
  },
  {
    id: symbolId('iron-blade'),
    name: 'Blade',
    path: 'M24 6v14M14 16l20 4M16 22h16M16 22l-3 18M32 22l3 18',
  },
  {
    id: symbolId('iron-nest'),
    name: 'Nest',
    path: 'M8 34l16-18 16 18M14 26l10-12 10 12M20 34l4-6 4 6',
  },
];

export function symbolById(symbolId: SymbolId): FactionSymbol | undefined {
  return EMBLEMS.find((s) => s.id === symbolId);
}
