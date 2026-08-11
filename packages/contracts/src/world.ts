import type { PlayerId, WorldId, FactionId } from './ids';
import type { Player } from './player';
import type { Planet, PlanetView } from './planet';
import type { TickResolutionView } from './tick';
import type { CommandEnvelope } from './command';

/**
 * Protocol version gates the API contract. A mismatch between client and
 * server is a hard error, never a silent migration (ADR-001, carried forward).
 */
export const PROTOCOL_VERSION = 'protocol-1';

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
  player: {
    id: PlayerId;
    name: string;
    factionId: FactionId;
    homePlanet: PlanetView;
  };
  planets: PlanetView[];
  pendingOrders: CommandEnvelope[];
  lastResolution: TickResolutionView | null;
};
