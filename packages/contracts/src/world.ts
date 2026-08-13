import type { PlayerId, WorldId, FactionId, TechnologyId } from './ids';
import type { Player } from './player';
import type { Planet, PlanetView } from './planet';
import type { TickResolutionView } from './tick';
import type { PendingOrderView } from './construction';
import type { Fleet, FleetOpReceipt, FleetView } from './fleet';
import type { ReportView } from './report';
import type { ResearchOrderView, TechnologyEffects } from './research';
import type { ScanIntelView } from './scan';

/**
 * Protocol version gates the API contract. A mismatch between client and
 * server is a hard error, never a silent migration (ADR-001, carried forward).
 * protocol-2: M2 research/shipyard/fleet views added to the world projection.
 * protocol-3: M3 — FleetView carries the flight state (mission, departure and
 * arrival ticks) and cargo capacity, and the fleet route preview endpoint
 * joins the API.
 * protocol-4: M3 — the scan/intel projection (`intel`) joins the overview.
 */
export const PROTOCOL_VERSION = 'protocol-4';

/**
 * Authoritative world state. Owned exclusively by the tick engine; the API
 * and web client only ever see projections derived from it.
 */
export type WorldState = {
  id: WorldId;
  seed: number;
  /** Current resolved tick. 0 at genesis; the next tick to resolve is tick + 1. */
  tick: number;
  /** Epoch ms when the next tick will resolve. */
  nextTickAt: number;
  createdAt: number;
  lastResolvedAt: number | null;
  worldVersion: string;
  contentVersion: string;
  tickDurationMs: number;
  planets: Planet[];
  players: Player[];
  /** Fleets (M2): every fleet in the world, owned by players. */
  fleets: Fleet[];
  /** Fleet operation receipts (M2 split/transfer; M3 send/recall/load/unload):
   *  immutable idempotency keys for every fleet op. */
  fleetOps: FleetOpReceipt[];
  /** Deterministic content hash over seed, versions, and every planet/player. */
  worldHash: string;
  version: number;
};

/**
 * Player-scoped projection served to the web client. `planets` are the
 * planets visible to the requesting player (M0: the home planet).
 */
export type WorldView = {
  worldId: WorldId;
  seed: number;
  tick: number;
  nextTickAt: number;
  createdAt: number;
  lastResolvedAt: number | null;
  worldVersion: string;
  contentVersion: string;
  protocolVersion: string;
  tickDurationMs: number;
  worldHash: string;
  /** Aggregate version — the optimistic concurrency gate for command envelopes. */
  version: number;
  player: {
    id: PlayerId;
    name: string;
    factionId: FactionId;
    homePlanet: PlanetView;
  };
  planets: PlanetView[];
  /** Account-wide research state (M2): queue, completed techs, effects. */
  research: {
    orders: ResearchOrderView[];
    completed: TechnologyId[];
    effects: TechnologyEffects;
  };
  /** The player's fleet inventory (M2). */
  fleets: FleetView[];
  /** Scan intelligence (M3): scanned worlds and the scan archive, derived
   *  from the player's immutable scan reports — never private state beyond
   *  the scan kind that gathered it. */
  intel: ScanIntelView;
  /** Recent completions (M2), derived from immutable order history. */
  reports: ReportView[];
  /** Active orders awaiting resolution, across the player's planets + archive. */
  pendingOrders: PendingOrderView[];
  lastResolution: TickResolutionView | null;
};
