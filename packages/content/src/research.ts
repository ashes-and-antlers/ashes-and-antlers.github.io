import { technologyId, type ShipKind, type TechnologyId } from '@ashes/contracts';
import type { ResearchBranch, TechnologyDefinition, TechnologyEffects } from '@ashes/contracts';

/** Presentation-only ordering/labels for the research page's branches. */
export const RESEARCH_BRANCH_LABELS: Record<ResearchBranch, string> = {
  infrastructure: 'Infrastructure',
  navigation: 'Navigation',
  military: 'Military',
  colonization: 'Colonization',
  intelligence: 'Intelligence',
};

const noEffects = {
  extractionBonus: 0,
  storageBonus: 0,
  upkeepReduction: 0,
  navigationSpeedBonus: 0,
  scanRangeBonus: 0,
  shipUnlocks: [],
};

function tech(def: Omit<TechnologyDefinition, 'id'> & { id: TechnologyId }): TechnologyDefinition {
  return def;
}

/**
 * M2 research tree (DEVELOPMENT_PLAN.md §4). Research is account-wide and
 * unlocks capability rather than only percentage bonuses: extraction and
 * storage multiply the economy, navigation multiplies fleet speed (the M2
 * acceptance test), and shipyard/colonization technologies unlock ship kinds.
 * Every technology declares a branch, prerequisites, a resource cost paid by
 * the hosting lab planet, research ticks, and additive effects.
 */
export const RESEARCH_TREE: TechnologyDefinition[] = [
  tech({
    id: technologyId('extraction-1'),
    name: 'Deep Extraction',
    summary: 'Heavier borers multiply every extraction yield across your worlds.',
    branch: 'infrastructure',
    tier: 1,
    prerequisites: [],
    cost: { metal: 120, mineral: 60 },
    researchTicks: 3,
    effects: { ...noEffects, extractionBonus: 0.15 },
  }),
  tech({
    id: technologyId('storage-1'),
    name: 'Expanded Storehouses',
    summary: 'Larger holds raise the storage cap on every world.',
    branch: 'infrastructure',
    tier: 2,
    prerequisites: [technologyId('extraction-1')],
    cost: { metal: 100, food: 80 },
    researchTicks: 3,
    effects: { ...noEffects, storageBonus: 0.25 },
  }),
  tech({
    id: technologyId('nav-1'),
    name: 'Planetary Drives',
    summary: 'Efficient in-system drives cut the travel time of every fleet.',
    branch: 'navigation',
    tier: 1,
    prerequisites: [],
    cost: { metal: 100, mineral: 80 },
    researchTicks: 3,
    effects: { ...noEffects, navigationSpeedBonus: 0.5 },
  }),
  tech({
    id: technologyId('nav-2'),
    name: 'Stellar Cartography',
    summary: 'Refined stellar charts shave more time off interstellar routes.',
    branch: 'navigation',
    tier: 2,
    prerequisites: [technologyId('nav-1')],
    cost: { metal: 200, mineral: 150 },
    researchTicks: 5,
    effects: { ...noEffects, navigationSpeedBonus: 0.5 },
  }),
  tech({
    id: technologyId('shipyard-1'),
    name: "Shipwrights' Guild",
    summary: 'Organized yards unlock the fighter for construction.',
    branch: 'military',
    tier: 1,
    prerequisites: [],
    cost: { metal: 200, mineral: 100 },
    researchTicks: 4,
    effects: { ...noEffects, shipUnlocks: ['fighter'] },
  }),
  tech({
    id: technologyId('grid-1'),
    name: 'Grid Hardening',
    summary: 'Ruggedized infrastructure trims the upkeep of every building.',
    branch: 'military',
    tier: 2,
    prerequisites: [technologyId('shipyard-1')],
    cost: { metal: 150, mineral: 100 },
    researchTicks: 4,
    effects: { ...noEffects, upkeepReduction: 0.1 },
  }),
  tech({
    id: technologyId('colony-1'),
    name: 'Colony Charter',
    summary: 'The charter unlocks the outpost ship for founding new worlds.',
    branch: 'colonization',
    tier: 1,
    prerequisites: [],
    cost: { metal: 250, mineral: 150, food: 100 },
    researchTicks: 5,
    effects: { ...noEffects, shipUnlocks: ['outpost'] },
  }),
  tech({
    id: technologyId('scan-1'),
    name: 'Watch Spires',
    summary: 'High lookouts extend the reach of every scan mission.',
    branch: 'intelligence',
    tier: 1,
    prerequisites: [],
    cost: { mineral: 100, energy: 50 },
    researchTicks: 3,
    effects: { ...noEffects, scanRangeBonus: 1 },
  }),
];

export const RESEARCH_BY_ID: Record<TechnologyId, TechnologyDefinition> = Object.fromEntries(
  RESEARCH_TREE.map((t) => [t.id, t]),
) as Record<TechnologyId, TechnologyDefinition>;

/**
 * Account-wide research queue rules (DEVELOPMENT_PLAN.md §4). One study is
 * active at a time; the rest wait in submission order. Costs are reserved at
 * submission from the hosting lab planet's store; cancellation refunds the
 * exact reserved amount, clamped to the storage cap like every store addition.
 */
export const RESEARCH = {
  queueCapacity: 3,
  refundFraction: 1,
} as const;

export type ResearchConfig = typeof RESEARCH;

/**
 * Aggregate the effects of every completed technology (additive). Missing
 * or undefined inputs are treated as an empty archive — defensive against a
 * stored world whose player predates the `technologies` field, so a shape
 * drift can never take tick resolution down with a TypeError.
 */
export function aggregateResearchEffects(
  technologies: TechnologyId[] = [],
  definitions: Record<TechnologyId, TechnologyDefinition> = RESEARCH_BY_ID,
): TechnologyEffects {
  const shipUnlocks: ShipKind[] = [];
  for (const id of technologies) {
    const def = definitions[id];
    if (!def) continue;
    for (const ship of def.effects.shipUnlocks) {
      if (!shipUnlocks.includes(ship)) shipUnlocks.push(ship);
    }
  }
  const effects = {
    extractionBonus: 0,
    storageBonus: 0,
    upkeepReduction: 0,
    navigationSpeedBonus: 0,
    scanRangeBonus: 0,
    shipUnlocks,
  };
  for (const id of technologies) {
    const def = definitions[id];
    if (!def) continue;
    effects.extractionBonus += def.effects.extractionBonus;
    effects.storageBonus += def.effects.storageBonus;
    effects.upkeepReduction += def.effects.upkeepReduction;
    effects.navigationSpeedBonus += def.effects.navigationSpeedBonus;
    effects.scanRangeBonus += def.effects.scanRangeBonus;
  }
  return effects;
}
