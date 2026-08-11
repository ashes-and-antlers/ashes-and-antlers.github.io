/**
 * Worker <-> main thread protocol (v6).
 *
 * The worker owns all authoritative simulation state. The main thread sends
 * validated commands and receives read-only snapshots. See docs/ADR-001.
 */

/** Validated player commands (M1: clock + blueprints; M2-4: stockpile policy). */
export type PlayerCommand =
  | { kind: 'SetSpeed'; tick: number; speed: number }
  | {
      kind: 'PlaceBlueprint';
      tick: number;
      faction: number;
      building: number;
      /** Top-left tile of the footprint. */
      x: number;
      y: number;
      /** Construction priority: 1 = low, 2 = normal, 3 = high. */
      priority: number;
    }
  | {
      kind: 'SetStockpileReserve';
      tick: number;
      faction: number;
      item: number;
      /** New desired reserve (0..SIM_CONFIG.maxStockpileReserve). */
      amount: number;
    };

/** Messages the main thread sends to the simulation worker. */
export type WorkerRequest =
  | { kind: 'init'; protocolVersion: number; seed: number; worldSize: number }
  | { kind: 'command'; command: PlayerCommand }
  | { kind: 'inspect'; tile: number };

/** Why a player command was rejected (surfaced in the HUD status line). */
export const PLACEMENT_REASONS: Record<string, string> = {
  'bad-faction': 'cannot build for that faction',
  'bad-kind': 'that building cannot be placed',
  'out-of-bounds': 'outside the world',
  terrain: 'needs walkable land',
  occupied: 'ground already occupied',
  'outside-claim': 'outside your claimed land',
  'max-blueprints': 'too many construction sites',
  'bad-priority': 'priority must be low, normal, or high',
};

/** Why a stockpile-policy command was rejected (surfaced in the HUD status). */
export const RESERVE_REASONS: Record<string, string> = {
  'bad-faction': 'unknown faction',
  'bad-item': 'unknown item',
  'bad-amount': 'reserve must be a whole number within the allowed range',
};

export type Calendar = { day: number; season: number; year: number };

export interface SimAlert {
  id: number;
  tick: number;
  severity: number; // 0 info, 1 warning, 2 critical
  code: string;
  factionId: number;
  text: string;
}

/**
 * Compact render-focused snapshot. The tiles buffer is attached only when the
 * world changes; ownerTiles only when ownership changes; entities every publish.
 */
export type SimSnapshot = {
  kind: 'snapshot';
  protocolVersion: number;
  tick: number;
  worldVersion: number;
  terrainHash: number;
  width: number;
  height: number;
  tilesChanged: boolean;
  /** Uint8Array: byte = (terrain << 5) | (elevation >> 3), row-major. Transferred, not copied. */
  tiles?: ArrayBuffer;
  calendar: Calendar;
  /** Deterministic per-tick value so the UI can prove ticks are advancing. */
  signal: number;
  /** Entity render rows: Int32Array of 7 per entity: [eid, kind, faction, x, y, state, extra]. */
  entityCount: number;
  entities?: ArrayBuffer;
  ownerVersion: number;
  /** Uint8Array per tile: FactionId (0 = neutral). Sent only when ownership changed. */
  ownerTiles?: ArrayBuffer;
  /** Per-faction stored items (factionId -> itemType -> amount), for HUD readouts. */
  stocks: Record<number, Record<number, number>>;
  /** Per-faction stockpile policy (factionId -> itemType -> desired reserve). */
  policy: Record<number, Record<number, number>>;
  alerts: SimAlert[];
};

/** Result of an inspector request (built by the worker from authoritative state). */
export type InspectDetail =
  | {
      kind: 'citizen';
      eid: number;
      factionId: number;
      state: number;
      hunger: number;
      energy: number;
      morale: number;
      carry: number;
      carryItem: number;
      taskText: string;
      x: number;
      y: number;
    }
  | {
      kind: 'building';
      eid: number;
      factionId: number;
      buildingKind: number;
      /** itemType -> stored amount (M2 multi-item stockpiles). */
      stock: Record<number, number>;
      capacity: number;
      x: number;
      y: number;
    }
  | {
      kind: 'blueprint';
      eid: number;
      factionId: number;
      buildingKind: number;
      /** Construction priority: 1 = low, 2 = normal, 3 = high. */
      priority: number;
      /** 0-100 percent of the work required. */
      progress: number;
      reserved: boolean;
      funded: boolean;
      /** itemType -> total cost (empty when nothing is required). */
      cost: Record<number, number>;
      /** itemType -> still missing (empty once funded). */
      missing: Record<number, number>;
      x: number;
      y: number;
    }
  | {
      kind: 'node';
      eid: number;
      nodeKind: number;
      amount: number;
      maxAmount: number;
      x: number;
      y: number;
    }
  | {
      kind: 'tile';
      terrain: number;
      ownerFactionId: number;
      elevation: number;
      moisture: number;
    };

/** Messages the worker posts back to the main thread. */
export type WorkerEvent =
  | { kind: 'ready'; protocolVersion: number; seed: number; width: number; height: number }
  | SimSnapshot
  | { kind: 'inspectResult'; tile: number; detail: InspectDetail | null }
  | {
      kind: 'commandRejected';
      /** Which command was rejected, so the HUD can phrase the message. */
      command: 'PlaceBlueprint' | 'SetStockpileReserve';
      reason: string;
    }
  | { kind: 'error'; message: string };
