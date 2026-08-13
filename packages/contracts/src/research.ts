import { z } from 'zod';
import type { ShipKind } from './shipyard';
import type { OrderId, PlanetId, PlayerId, TechnologyId } from './ids';
import type { ResourceRates, ResourceStore } from './planet';

/**
 * Research (DEVELOPMENT_PLAN.md §4, M2): an account-wide queue — one study at
 * a time, a small number queued behind it. Research runs on (and is paid from)
 * whichever owned planet has a Research Lab; the lab planet hosts the archive.
 * Costs are reserved (deducted) at submission from that planet's store, so
 * two accepted research commands can never overspend the same local resources.
 * A completed technology is added to the player's `technologies` and its
 * effects aggregate into the player's `researchEffects`, which the economy
 * and travel calculations consume.
 */

export const RESEARCH_BRANCH_KEYS = [
  'infrastructure',
  'navigation',
  'military',
  'colonization',
  'intelligence',
] as const;
export type ResearchBranch = (typeof RESEARCH_BRANCH_KEYS)[number];

/**
 * Aggregated effects of every completed technology. Each field is a sum over
 * the researched technology's effects, so `emptyTechnologyEffects()` is the
 * zero state and completion adds into it. All numeric bonuses are additive.
 */
export type TechnologyEffects = {
  /** Fractional bonus to building production (0.2 = +20%). */
  extractionBonus: number;
  /** Fractional bonus to the per-resource storage cap. */
  storageBonus: number;
  /** Fractional upkeep reduction (0.1 = −10%). */
  upkeepReduction: number;
  /** Fractional fleet travel speed bonus (0.5 = +50%). */
  navigationSpeedBonus: number;
  /** Bonus scan range in hops (consumed by scan missions in M3). */
  scanRangeBonus: number;
  /** Ship kinds this research unlocks for shipyards. */
  shipUnlocks: ShipKind[];
};

export function emptyTechnologyEffects(): TechnologyEffects {
  return {
    extractionBonus: 0,
    storageBonus: 0,
    upkeepReduction: 0,
    navigationSpeedBonus: 0,
    scanRangeBonus: 0,
    shipUnlocks: [],
  };
}

/** Data-driven technology definition (the catalog lives in content). */
export type TechnologyDefinition = {
  id: TechnologyId;
  name: string;
  /** One-line purpose, shown on the research page's technology tree. */
  summary: string;
  /** Catalog grouping. */
  branch: ResearchBranch;
  /** Research tier within the branch (presentation only). */
  tier: number;
  /** Every technology that must be completed before this one can start. */
  prerequisites: TechnologyId[];
  /** Resource cost paid by the hosting lab planet at submission. */
  cost: Partial<ResourceRates>;
  /** Ticks the study takes once it is the active research. */
  researchTicks: number;
  effects: TechnologyEffects;
};

export const RESEARCH_ORDER_STATUSES = ['queued', 'researching', 'completed', 'cancelled'] as const;
export type ResearchOrderStatus = (typeof RESEARCH_ORDER_STATUSES)[number];

/**
 * The immutable receipt of an accepted StartResearch command. One study is
 * active at a time; the rest wait in submission order. Created once by its
 * idempotency key and never re-executed; status transitions happen only at
 * tick boundaries (queued → researching → completed) or by cancellation.
 */
export type ResearchOrder = {
  id: OrderId;
  kind: 'research';
  /** The lab planet hosting (and paying for) the study. */
  hostPlanetId: PlanetId;
  actorId: PlayerId;
  technologyId: TechnologyId;
  submittedAt: number;
  submittedTick: number;
  startTick: number | null;
  /** Research ticks remaining (only decremented while `researching`). */
  ticksRemaining: number;
  /** Resources deducted at submission — the exact refund amount on cancel. */
  cost: ResourceStore;
  status: ResearchOrderStatus;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
  idempotencyKey: string;
  expectedVersion: number;
};

export type ResearchOrderView = {
  id: OrderId;
  kind: 'research';
  hostPlanetId: PlanetId;
  technologyId: TechnologyId;
  status: ResearchOrderStatus;
  position: number | null;
  ticksRemaining: number | null;
  cost: ResourceStore;
  submittedAt: number;
  submittedTick: number;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
};

export type StartResearchCommand = {
  kind: 'StartResearch';
  /** The lab planet that hosts and funds the study. */
  hostPlanetId: PlanetId;
  technologyId: TechnologyId;
};

export type CancelResearchCommand = {
  kind: 'CancelResearch';
  orderId: OrderId;
};

export const StartResearchCommandSchema = z
  .object({
    kind: z.literal('StartResearch'),
    hostPlanetId: z.string().min(1),
    technologyId: z.string().min(1),
  })
  .strict();

export const CancelResearchCommandSchema = z
  .object({
    kind: z.literal('CancelResearch'),
    orderId: z.string().min(1),
  })
  .strict();
