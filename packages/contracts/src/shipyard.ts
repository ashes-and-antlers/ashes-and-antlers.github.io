import { z } from 'zod';
import type { OrderId, PlanetId, PlayerId, TechnologyId } from './ids';
import type { ResourceRates, ResourceStore } from './planet';

/**
 * Shipyard queue (DEVELOPMENT_PLAN.md §4-5, M2): a per-planet production queue
 * with a small number of queued future orders. Ships are built at the Shipyard
 * building and, when an order completes at a tick boundary, the ships enter
 * the planet's local fleet exactly once. Costs are reserved at submission
 * (same rule as construction), so two accepted ship orders can never overspend
 * the same local resources; cancellation refunds the exact deducted amount.
 */

export const SHIP_KINDS = ['scout', 'freighter', 'outpost', 'fighter'] as const;
export type ShipKind = (typeof SHIP_KINDS)[number];

/** Travel capability of a ship class (DEVELOPMENT_PLAN.md §5, drive tiers). */
export const DRIVE_TIERS = ['planetary', 'stellar', 'galactic'] as const;
export type DriveTier = (typeof DRIVE_TIERS)[number];

/** Data-driven ship definition (the catalog lives in content). */
export type ShipDefinition = {
  kind: ShipKind;
  name: string;
  /** One-line role, shown on the shipyard catalog. */
  summary: string;
  role: string;
  /** Resource cost per hull. */
  cost: Partial<ResourceRates>;
  /** Ticks until an order of this ship completes. */
  buildTicks: number;
  driveTier: DriveTier;
  /** Resource cargo capacity per hull. */
  cargoCapacity: number;
  hull: number;
  attack: number;
  /** Technology that unlocks this ship kind (null = available at start). */
  requiredTechnology: TechnologyId | null;
};

export const SHIPYARD_ORDER_STATUSES = ['queued', 'building', 'completed', 'cancelled'] as const;
export type ShipyardOrderStatus = (typeof SHIPYARD_ORDER_STATUSES)[number];

/**
 * The immutable receipt of an accepted QueueShip command. One order builds at
 * a time per planet, the rest wait FIFO. When the active order reaches zero
 * ticks the ships enter the planet's local fleet (never the shipyard itself);
 * the order is completed and can never produce ships again.
 */
export type ShipyardOrder = {
  id: OrderId;
  kind: 'ship';
  planetId: PlanetId;
  actorId: PlayerId;
  ship: ShipKind;
  /** Number of hulls in this order (cost = per-hull cost × quantity). */
  quantity: number;
  submittedAt: number;
  submittedTick: number;
  startTick: number | null;
  ticksRemaining: number;
  /** Resources deducted at submission — the exact refund amount on cancel. */
  cost: ResourceStore;
  status: ShipyardOrderStatus;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
  idempotencyKey: string;
  expectedVersion: number;
};

export type ShipyardOrderView = {
  id: OrderId;
  kind: 'ship';
  planetId: PlanetId;
  ship: ShipKind;
  quantity: number;
  status: ShipyardOrderStatus;
  position: number | null;
  ticksRemaining: number | null;
  cost: ResourceStore;
  submittedAt: number;
  submittedTick: number;
  completedAtTick: number | null;
  cancelledAtTick: number | null;
};

export type QueueShipCommand = {
  kind: 'QueueShip';
  planetId: PlanetId;
  ship: ShipKind;
  quantity: number;
};

export type CancelShipOrderCommand = {
  kind: 'CancelShipOrder';
  orderId: OrderId;
};

export const QueueShipCommandSchema = z
  .object({
    kind: z.literal('QueueShip'),
    planetId: z.string().min(1),
    ship: z.enum(SHIP_KINDS),
    quantity: z.number().int().positive().max(100_000),
  })
  .strict();

export const CancelShipOrderCommandSchema = z
  .object({
    kind: z.literal('CancelShipOrder'),
    orderId: z.string().min(1),
  })
  .strict();
