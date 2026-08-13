import { z } from 'zod';
import type { DriveTier, ShipKind } from './shipyard';
import type { Coordinate } from './coordinate';
import type { FleetId, OrderId, PlanetId, PlayerId } from './ids';
import type { ResourceRates, ResourceStore } from './planet';

/**
 * Fleets (DEVELOPMENT_PLAN.md §5, M2): persistent ship stacks. In M2 fleets
 * stay in orbit — they are inventories that shipyard orders fill and that
 * players split/merge/transfer between — and the movement/travel state
 * machine arrives in M3. The type already carries the full movement contract
 * so travel resolution has a home before it is implemented.
 */
export const FLEET_STATES = ['orbiting', 'moving', 'arrived', 'returning', 'engaged'] as const;
export type FleetState = (typeof FLEET_STATES)[number];

export type FleetMissionKind =
  | 'transport'
  | 'scout'
  | 'colonize'
  | 'raid'
  | 'reinforce'
  | 'patrol'
  | 'defend'
  | 'invade'
  | 'return';

/**
 * The mission kinds a player can issue in M3 (DEVELOPMENT_PLAN.md §5): the
 * movement state machine carries transport/scout/colonize/raid. The mission's
 * *effects* land with their own milestones (colonization and raids are M4;
 * reinforce/patrol/defend/invade come later) — M3 resolves the travel itself.
 */
export const M3_MISSION_KINDS = ['transport', 'scout', 'colonize', 'raid'] as const;
export type M3MissionKind = (typeof M3_MISSION_KINDS)[number];

export type FleetMission = {
  kind: FleetMissionKind;
  destination: Coordinate;
  departureTick: number;
  arrivalTick: number;
};

/** Per-ship-kind stacks, e.g. { scout: 2, freighter: 1 }. */
export type ShipStacks = Partial<Record<ShipKind, number>>;

/**
 * Authoritative fleet state. Owned by the tick engine; the API and web client
 * only see projections (FleetView) derived from it. Ship counts are plain
 * numbers (not bigint) so the aggregate survives JSON serialization into
 * Postgres, exactly like population.
 */
export type Fleet = {
  id: FleetId;
  ownerId: PlayerId;
  /** The planet that spawned the fleet; null for split-off detachments. */
  homePlanetId: PlanetId | null;
  location: Coordinate;
  state: FleetState;
  ships: ShipStacks;
  cargo: ResourceStore;
  troops: number;
  mission: FleetMission | null;
  departureTick: number | null;
  arrivalTick: number | null;
  route: Coordinate[];
  version: number;
};

/**
 * Player-visible fleet projection: the inventory a commander sees. `name` is
 * a derived display name (content-free, stable per fleet).
 */
export type FleetView = {
  id: FleetId;
  name: string;
  ownerId: PlayerId;
  homePlanetId: PlanetId | null;
  location: Coordinate;
  state: FleetState;
  ships: ShipStacks;
  cargo: ResourceStore;
  /** The slowest relevant drive among the fleet's ships (planetary if none). */
  driveTier: DriveTier;
  /** The mission in flight (M3), if the fleet is moving or returning. */
  mission: FleetMission | null;
  departureTick: number | null;
  arrivalTick: number | null;
  /** Total cargo capacity across the fleet's ships (sum of ship capacities). */
  cargoCapacity: number;
};

/**
 * Move ships and/or cargo between two fleets at the same location. The target
 * fleet's cargo capacity (sum of its ships' cargo) bounds how much cargo can
 * be transferred; ships always fit. Covers merging (transfer everything into
 * the other fleet) and redistribution between co-located fleets.
 */
export type TransferFleetCommand = {
  kind: 'TransferFleet';
  fromFleetId: FleetId;
  toFleetId: FleetId;
  ships: ShipStacks;
  cargo?: Partial<ResourceRates>;
};

/**
 * Create a new fleet at the same location, moving the given ships out of the
 * source fleet. The new fleet is a detachment: its homePlanetId is null.
 */
export type SplitFleetCommand = {
  kind: 'SplitFleet';
  fleetId: FleetId;
  ships: ShipStacks;
};

export const TransferFleetCommandSchema = z
  .object({
    kind: z.literal('TransferFleet'),
    fromFleetId: z.string().min(1),
    toFleetId: z.string().min(1),
    ships: z.record(
      z.enum(['scout', 'freighter', 'outpost', 'fighter'] as const),
      z.number().int().nonnegative(),
    ),
    cargo: z
      .record(
        z.enum(['metal', 'mineral', 'food', 'energy'] as const),
        z.number().int().nonnegative(),
      )
      .optional(),
  })
  .strict();

export const SplitFleetCommandSchema = z
  .object({
    kind: z.literal('SplitFleet'),
    fleetId: z.string().min(1),
    ships: z
      .record(
        z.enum(['scout', 'freighter', 'outpost', 'fighter'] as const),
        z.number().int().nonnegative(),
      )
      .refine((ships) => Object.values(ships).some((n) => (n ?? 0) > 0), {
        message: 'split must move at least one ship',
      }),
  })
  .strict();

/**
 * Send a fleet to a destination coordinate (M3). The fleet must be orbiting
 * and carry at least one ship; the destination must be a coordinate inside
 * the world's finite space. Travel ticks come from the engine's deterministic
 * route calculation (distance ÷ drive speed × navigation bonus), so the same
 * fleet + destination always arrives on the same tick.
 */
export type SendFleetCommand = {
  kind: 'SendFleet';
  fleetId: FleetId;
  destination: Coordinate;
  mission: M3MissionKind;
};

/**
 * Turn a moving fleet around: it returns to its origin coordinate. The return
 * trip is proportional to how far along the outbound route it had travelled
 * when recalled (a fleet recalled right after departure gets home fast; one
 * recalled just before arrival travels most of the way back).
 */
export type RecallFleetCommand = {
  kind: 'RecallFleet';
  fleetId: FleetId;
};

/**
 * Move resources from the planet's store at the fleet's location into the
 * fleet's cargo hold (bounded by the fleet's cargo capacity). The planet must
 * be owned by the actor — a transport fleet moves your own goods between your
 * worlds.
 */
export type LoadCargoCommand = {
  kind: 'LoadCargo';
  fleetId: FleetId;
  resources: Partial<ResourceRates>;
};

/**
 * Move resources from the fleet's cargo hold back into the planet's store at
 * its location. The store addition is clamped at the planet's storage cap,
 * exactly like every other store addition (refunds, arrivals).
 */
export type UnloadCargoCommand = {
  kind: 'UnloadCargo';
  fleetId: FleetId;
  resources: Partial<ResourceRates>;
};

export const MISSION_SCHEMA = z
  .object({
    galaxy: z.number().int().min(1),
    sector: z.number().int().min(1),
    system: z.number().int().min(1),
    planet: z.number().int().min(1),
  })
  .strict();

export const SendFleetCommandSchema = z
  .object({
    kind: z.literal('SendFleet'),
    fleetId: z.string().min(1),
    destination: MISSION_SCHEMA,
    mission: z.enum(M3_MISSION_KINDS),
  })
  .strict();

export const RecallFleetCommandSchema = z
  .object({
    kind: z.literal('RecallFleet'),
    fleetId: z.string().min(1),
  })
  .strict();

export const LoadCargoCommandSchema = z
  .object({
    kind: z.literal('LoadCargo'),
    fleetId: z.string().min(1),
    resources: z
      .record(
        z.enum(['metal', 'mineral', 'food', 'energy'] as const),
        z.number().int().nonnegative(),
      )
      .refine((r) => Object.values(r).some((n) => (n ?? 0) > 0), {
        message: 'load must move at least one unit',
      }),
  })
  .strict();

export const UnloadCargoCommandSchema = z
  .object({
    kind: z.literal('UnloadCargo'),
    fleetId: z.string().min(1),
    resources: z
      .record(
        z.enum(['metal', 'mineral', 'food', 'energy'] as const),
        z.number().int().nonnegative(),
      )
      .refine((r) => Object.values(r).some((n) => (n ?? 0) > 0), {
        message: 'unload must move at least one unit',
      }),
  })
  .strict();

export type FleetOpReceipt = {
  id: OrderId;
  idempotencyKey: string;
  kind: 'split' | 'transfer' | 'send' | 'recall' | 'load' | 'unload';
  actorId: PlayerId;
  submittedAt: number;
  submittedTick: number;
  expectedVersion: number;
  /** Fleet(s) touched by the op; the engine rebuilds current views on replay. */
  fromFleetId: FleetId;
  toFleetId: FleetId | null;
  newFleetId: FleetId | null;
};

export type FleetOpReceiptResult =
  | { op: 'split'; fleet: FleetView }
  | { op: 'transfer'; from: FleetView; to: FleetView }
  | { op: 'send' | 'recall' | 'load' | 'unload'; fleet: FleetView };
