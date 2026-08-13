import { z } from 'zod';
import { BUILDING_KINDS, type BuildingKind, type ResourceStore } from './planet';
import type { OrderId, PlanetId, PlayerId, TechnologyId } from './ids';
import type { ShipKind } from './shipyard';

/**
 * Construction queue (DEVELOPMENT_PLAN.md §4, M1): one queue per planet with
 * a small number of queued future orders. Costs are deducted at submission
 * (reserve-now) so two accepted build commands can never overspend the same
 * local resources; cancellation refunds the exact deducted amount.
 *
 * An order is the immutable receipt of an accepted command: it is created
 * once by its idempotency key and never re-executed. Status transitions
 * (`queued` → `building` → `completed`, or → `cancelled`) are the only
 * mutation, and only ever at tick boundaries or by explicit cancellation.
 */
export const CONSTRUCTION_ORDER_STATUSES = [
  'queued',
  'building',
  'completed',
  'cancelled',
] as const;
export type ConstructionOrderStatus = (typeof CONSTRUCTION_ORDER_STATUSES)[number];

export type ConstructionOrder = {
  id: OrderId;
  kind: 'building';
  planetId: PlanetId;
  actorId: PlayerId;
  building: BuildingKind;
  /** Server-accepted submission time (epoch ms); client timestamps are untrusted. */
  submittedAt: number;
  /** World tick at submission — the order resolves no earlier than this. */
  submittedTick: number;
  /** Tick the order entered construction; null while it waits in the queue. */
  startTick: number | null;
  /** Construction ticks remaining (only decremented while `building`). */
  ticksRemaining: number;
  /** Resources deducted at submission — the exact refund amount on cancel. */
  cost: ResourceStore;
  status: ConstructionOrderStatus;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
  /** Receipt fields from the accepted envelope (idempotent replay). */
  idempotencyKey: string;
  expectedVersion: number;
};

/**
 * Player-visible construction order. `position` is the order's place in the
 * active queue (0 = under construction now); `ticksRemaining` is only set for
 * the order under construction. Completed/cancelled orders keep their
 * historical status with the tick they finished.
 */
export type ConstructionOrderView = {
  id: OrderId;
  kind: 'building';
  planetId: PlanetId;
  building: BuildingKind;
  status: ConstructionOrderStatus;
  position: number | null;
  ticksRemaining: number | null;
  cost: ResourceStore;
  submittedAt: number;
  submittedTick: number;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
};

/**
 * An order awaiting resolution, as listed on the command overview ("Pending
 * next tick"). Flattened across a player's planets (construction and ships)
 * and the account-wide research queue, in stable order.
 */
export type PendingOrderView =
  | {
      id: OrderId;
      kind: 'building';
      planetId: PlanetId;
      planetName: string;
      building: BuildingKind;
      status: 'building' | 'queued';
      position: number;
      ticksRemaining: number | null;
      cost: ResourceStore;
      submittedAt: number;
      submittedTick: number;
    }
  | {
      id: OrderId;
      kind: 'research';
      hostPlanetId: PlanetId;
      hostPlanetName: string;
      technologyId: TechnologyId;
      status: 'researching' | 'queued';
      position: number;
      ticksRemaining: number | null;
      cost: ResourceStore;
      submittedAt: number;
      submittedTick: number;
    }
  | {
      id: OrderId;
      kind: 'ship';
      planetId: PlanetId;
      planetName: string;
      ship: ShipKind;
      quantity: number;
      status: 'building' | 'queued';
      position: number;
      ticksRemaining: number | null;
      cost: ResourceStore;
      submittedAt: number;
      submittedTick: number;
    };

export type StartBuildingCommand = {
  kind: 'StartBuilding';
  planetId: PlanetId;
  building: BuildingKind;
};

export type CancelConstructionCommand = {
  kind: 'CancelConstruction';
  orderId: OrderId;
};

export const StartBuildingCommandSchema = z
  .object({
    kind: z.literal('StartBuilding'),
    planetId: z.string().min(1),
    building: z.enum(BUILDING_KINDS),
  })
  .strict();

export const CancelConstructionCommandSchema = z
  .object({
    kind: z.literal('CancelConstruction'),
    orderId: z.string().min(1),
  })
  .strict();
