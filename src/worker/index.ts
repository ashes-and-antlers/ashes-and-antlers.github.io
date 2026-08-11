/// <reference lib="webworker" />

import { query } from 'bitecs';
import { PROTOCOL_VERSION, SNAPSHOT_EVERY_TICKS, WORLD_VERSION } from '../shared/constants';
import {
  PLACEMENT_REASONS,
  RESERVE_REASONS,
  type SimSnapshot,
  type WorkerEvent,
  type WorkerRequest,
} from '../shared/protocol';
import { FixedClock } from '../sim/core/clock';
import {
  BuildingKind,
  EntityKind,
  FACTIONS,
  ITEM_TYPES,
  type FactionId,
  type ItemType,
} from '../sim/data/content';
import { sortedQuery, type SimWorld } from '../sim/ecs/world';
import { buildingWorkTicks } from '../sim/ecs/entities';
import { buildInspectDetail } from '../sim/inspect';
import { Simulation } from '../sim/core/sim';

/**
 * Simulation worker.
 *
 * Owns all authoritative state. The main thread sends validated commands and
 * reads snapshots; it never mutates simulation objects. Determinism rules:
 * fixed ticks only, seeded PRNG inside the sim, stable iteration order.
 */

let sim: Simulation | null = null;
let clock = new FixedClock();
let speed = 1;
let lastFrameMs = 0;
let lastPublishedTick = -1;
let lastPublishedOwnerVersion = -1;
let hasPublishedTiles = false;

function post(event: WorkerEvent, transfer?: Transferable[]): void {
  self.postMessage(event, transfer ?? []);
}

/** Pack entities into a render buffer: 7 ints per row [eid, kind, faction, x, y, state, extra]. */
function buildEntityBuffer(): { buffer: ArrayBuffer; count: number } {
  if (!sim) throw new Error('sim not initialized');
  const world = sim.world;
  const c = world.components;
  const rows: number[] = [];
  for (const e of sortedQuery(query(world, [c.Citizen]))) {
    rows.push(
      e,
      EntityKind.Citizen,
      c.Faction[e] ?? 0,
      c.Position.x[e] ?? 0,
      c.Position.y[e] ?? 0,
      c.CitizenState[e] ?? 0,
      c.CarryAmount[e] ?? 0,
    );
  }
  for (const e of sortedQuery(query(world, [c.Building]))) {
    rows.push(
      e,
      c.Kind[e] ?? EntityKind.CommandCenter,
      c.Faction[e] ?? 0,
      c.Position.x[e] ?? 0,
      c.Position.y[e] ?? 0,
      0,
      c.BuildingKind[e] ?? 0,
    );
  }
  for (const e of sortedQuery(query(world, [c.ResourceNode]))) {
    rows.push(
      e,
      c.Kind[e] ?? EntityKind.BerryNode,
      0,
      c.Position.x[e] ?? 0,
      c.Position.y[e] ?? 0,
      0,
      Math.round(c.NodeAmount[e] ?? 0),
    );
  }
  for (const e of sortedQuery(query(world, [c.Blueprint]))) {
    const kind = c.BlueprintKind[e] ?? 0;
    const required = buildingWorkTicks(sim.world.config, kind as unknown as BuildingKind);
    const progress = Math.min(
      100,
      Math.round(((c.BlueprintProgress[e] ?? 0) / Math.max(1, required)) * 100),
    );
    rows.push(
      e,
      EntityKind.Blueprint,
      c.Faction[e] ?? 0,
      c.Position.x[e] ?? 0,
      c.Position.y[e] ?? 0,
      0,
      progress,
    );
  }
  const buffer = new Int32Array(rows);
  return { buffer: buffer.buffer, count: rows.length / 7 };
}

/** Per-faction stockpile policy (factionId -> itemType -> desired reserve). */
function buildPolicy(world: SimWorld): Record<number, Record<number, number>> {
  const policy: Record<number, Record<number, number>> = {};
  for (const faction of FACTIONS) {
    const row: Record<number, number> = {};
    for (const item of ITEM_TYPES) {
      row[item] = world.reservePolicy[faction]?.[item] ?? 0;
    }
    policy[faction] = row;
  }
  return policy;
}

/** Per-faction stored items (factionId -> itemType -> amount), for HUD readouts. */
function buildStocks(world: SimWorld): Record<number, Record<number, number>> {
  const c = world.components;
  const stocks: Record<number, Record<number, number>> = {};
  for (const faction of FACTIONS) {
    const row: Record<number, number> = {};
    for (const item of ITEM_TYPES) {
      row[item] = 0;
    }
    stocks[faction] = row;
  }
  for (const b of world.buildings) {
    if ((c.StockpileCapacity[b] ?? 0) <= 0) continue;
    const kind = c.BuildingKind[b] ?? 0;
    // Work buildings keep their own buffers; the readout shows stockpiles only.
    if (kind !== BuildingKind.CommandCenter && kind !== BuildingKind.Stockpile) continue;
    const faction = c.Faction[b] ?? 0;
    const row = stocks[faction];
    if (row === undefined) continue;
    for (const item of ITEM_TYPES) {
      row[item] += c.Stock[item][b] ?? 0;
    }
  }
  return stocks;
}

function buildSnapshot(includeTiles: boolean): SimSnapshot {
  if (!sim) {
    throw new Error('sim not initialized');
  }
  const world = sim.world;
  const base = {
    kind: 'snapshot' as const,
    protocolVersion: PROTOCOL_VERSION,
    tick: sim.tick,
    worldVersion: WORLD_VERSION,
    terrainHash: sim.terrainHash(),
    width: world.tiles.width,
    height: world.tiles.height,
    calendar: sim.calendar(),
    signal: sim.signal,
    ownerVersion: world.ownerVersion,
    alerts: world.alertLog.slice(-8),
    stocks: buildStocks(world),
    policy: buildPolicy(world),
  };

  const { buffer, count } = buildEntityBuffer();

  const snapshot: SimSnapshot = {
    ...base,
    tilesChanged: false,
    entityCount: count,
    entities: buffer,
    alerts: base.alerts,
  };

  if (includeTiles || !hasPublishedTiles) {
    // byte = (terrain << 5) | (elevation >> 3): 3 bits terrain, 5 bits elevation.
    const tiles = new Uint8Array(world.tiles.tileCount);
    for (let i = 0; i < world.tiles.tileCount; i++) {
      tiles[i] = ((world.tiles.terrain[i] ?? 0) << 5) | ((world.tiles.elevation[i] ?? 0) >> 3);
    }
    snapshot.tilesChanged = true;
    snapshot.tiles = tiles.buffer;
    hasPublishedTiles = true;
  } else {
    snapshot.tilesChanged = false;
  }

  if (world.ownerVersion !== lastPublishedOwnerVersion) {
    snapshot.ownerTiles = world.owner.slice().buffer;
    lastPublishedOwnerVersion = world.ownerVersion;
  }

  return snapshot;
}

function publish(includeTiles: boolean): void {
  if (!sim) return;
  const snapshot = buildSnapshot(includeTiles);
  lastPublishedTick = sim.tick;
  const transfer: Transferable[] = [];
  if (snapshot.tiles !== undefined) transfer.push(snapshot.tiles);
  if (snapshot.entities !== undefined) transfer.push(snapshot.entities);
  if (snapshot.ownerTiles !== undefined) transfer.push(snapshot.ownerTiles);
  post(snapshot, transfer);
}

function tickLoop(): void {
  if (!sim) return;
  const now = performance.now();
  const elapsedMs = lastFrameMs === 0 ? 0 : now - lastFrameMs;
  lastFrameMs = now;

  const ticks = clock.advance(elapsedMs, speed);
  if (ticks > 0) {
    sim.step(ticks);
  }

  const due = sim.tick % SNAPSHOT_EVERY_TICKS === 0;
  const paused = speed === 0 && sim.tick !== lastPublishedTick;
  if (due || paused) {
    publish(false);
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'init': {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        post({
          kind: 'error',
          message: `protocol mismatch: worker expects ${PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
        });
        return;
      }
      sim = new Simulation({
        seed: msg.seed,
        width: msg.worldSize,
        height: msg.worldSize,
        version: WORLD_VERSION,
      });
      clock = new FixedClock();
      speed = 1;
      lastFrameMs = 0;
      lastPublishedTick = -1;
      lastPublishedOwnerVersion = -1;
      hasPublishedTiles = false;
      post({
        kind: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        seed: msg.seed,
        width: sim.world.tiles.width,
        height: sim.world.tiles.height,
      });
      publish(true);
      break;
    }
    case 'command': {
      const command = msg.command;
      if (command.kind === 'SetSpeed') {
        speed = command.speed;
      } else if (command.kind === 'PlaceBlueprint') {
        if (!sim) break;
        const result = sim.placeBlueprint(
          command.faction as FactionId,
          command.building as BuildingKind,
          command.x,
          command.y,
          command.priority,
        );
        if (!result.ok) {
          post({
            kind: 'commandRejected',
            command: 'PlaceBlueprint',
            reason: PLACEMENT_REASONS[result.reason] ?? result.reason,
          });
        } else if (speed === 0) {
          // Placement changed authoritative state while paused; the normal
          // paused-publish trigger keys off the tick, so force one now.
          publish(false);
        }
      } else if (command.kind === 'SetStockpileReserve') {
        if (!sim) break;
        const result = sim.setStockpileReserve(
          command.faction as FactionId,
          command.item as ItemType,
          command.amount,
        );
        if (!result.ok) {
          const reason =
            result.reason === 'bad-amount'
              ? `reserve must be a whole number from 0 to ${sim.world.config.maxStockpileReserve}`
              : (RESERVE_REASONS[result.reason] ?? result.reason);
          post({ kind: 'commandRejected', command: 'SetStockpileReserve', reason });
        } else if (speed === 0) {
          // The reserve changed authoritative state while paused; the normal
          // paused-publish trigger keys off the tick, so force one now.
          publish(false);
        }
      }
      break;
    }
    case 'inspect': {
      if (!sim) {
        post({ kind: 'inspectResult', tile: msg.tile, detail: null });
        return;
      }
      const tile = msg.tile;
      if (tile < 0 || tile >= sim.world.tiles.tileCount) {
        post({ kind: 'inspectResult', tile, detail: null });
        return;
      }
      post({ kind: 'inspectResult', tile, detail: buildInspectDetail(sim.world, tile) });
      break;
    }
  }
};

setInterval(tickLoop, 50);
