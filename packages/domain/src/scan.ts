import {
  compareCoordinates,
  orderId,
  RESOURCE_KEYS,
  type Coordinate,
  type Fleet,
  type Player,
  type PlayerId,
  type ResourceStore,
  type ScanIntelView,
  type ScanKind,
  type ScanReport,
  type ScanRevealed,
  type ScannedPlanetView,
  type WorldState,
} from '@ashes/contracts';
import { SCAN, SHIP_DEFINITIONS, type ScanConfig } from '@ashes/content';
import type { RunScanCommand } from '@ashes/contracts';
import { coordinateDistance, fleetDriveTier } from './travel';
import { storageCapFor } from './economy';
import { planetClassId } from './planet-art';
import { playerResearchEffects } from './research';
import { isCoordinateInWorld } from './movement';

/**
 * Scan missions (DEVELOPMENT_PLAN.md §6, M3): limited, timestamped
 * intelligence. A player runs a scan from an owned planet with a Scanner
 * Array; the target must be within the array's reach, which grows with the
 * array's level and the watch-spire research line (scanRangeBonus). Scan
 * kinds are gated by the source array's level (basic L1, resource L2,
 * military L3). Every report is an immutable receipt keyed by its idempotency
 * key, rounded so exact private state is never exposed beyond the kind — the
 * M3 acceptance test.
 */

export type ScanError =
  | { code: 'PLAYER_NOT_FOUND'; playerId: PlayerId }
  | { code: 'PLANET_NOT_FOUND'; planetId: string }
  | { code: 'NOT_OWNER'; planetId: string }
  | { code: 'SCANNER_REQUIRED'; planetId: string }
  | { code: 'SCAN_LOCKED'; scan: ScanKind; requiredScannerLevel: number }
  | { code: 'UNKNOWN_SCAN_KIND'; scan: string }
  | { code: 'CANNOT_SCAN_OWN_PLANET'; planetId: string }
  | { code: 'INVALID_DESTINATION'; coordinate: Coordinate }
  | { code: 'OUT_OF_RANGE'; range: number; distance: number }
  | { code: 'STALE_VERSION'; expected: number; actual: number };

export type ScanResult =
  { ok: true; world: WorldState; report: ScanReport } | { ok: false; error: ScanError };

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return (
    a.galaxy === b.galaxy && a.sector === b.sector && a.system === b.system && a.planet === b.planet
  );
}

function round(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** The planet at a coordinate (every coordinate in the finite space has one). */
function planetAt(world: WorldState, coord: Coordinate) {
  return world.planets.find((p) => sameCoordinate(p.coordinate, coord));
}

/**
 * The scan reach of a planet's Scanner Array: (base + level × perLevel) ×
 * (1 + scanRangeBonus) map units. Research effects come from the planet's
 * owner (aggregate of completed technologies); with no owner the base range
 * applies.
 */
export function scanRange(
  planet: { buildings: { scanner?: number } },
  effects: { scanRangeBonus?: number } = { scanRangeBonus: 0 },
): number {
  const scanner = planet.buildings.scanner ?? 0;
  const base = SCAN.baseRange + scanner * SCAN.rangePerScannerLevel;
  return Math.round(base * (1 + (effects.scanRangeBonus ?? 0)));
}

/** The scanner level required to run a scan kind (content-gated). */
export function requiredScannerLevel(scan: ScanKind, config: ScanConfig = SCAN): number {
  const def = config.kinds[scan];
  return def?.requiredScannerLevel ?? Number.POSITIVE_INFINITY;
}

/**
 * Accept a RunScan command: validate ownership, a Scanner Array on the source
 * planet, the kind's level gate, an in-world target that the actor does not
 * own, and range; reveal the target through the scan kind's lens and append
 * the immutable report to the player's archive. Idempotent per idempotency
 * key — a retried scan returns the original report without a second look.
 */
export function submitRunScan(
  world: WorldState,
  input: {
    actorId: PlayerId;
    idempotencyKey: string;
    expectedVersion: number;
    command: RunScanCommand;
  },
  submittedAt: number,
): ScanResult {
  const { sourcePlanetId, target, scan } = input.command;
  const player = world.players.find((p) => p.id === input.actorId);
  if (!player) return { ok: false, error: { code: 'PLAYER_NOT_FOUND', playerId: input.actorId } };

  const source = world.planets.find((p) => p.id === sourcePlanetId);
  if (!source) return { ok: false, error: { code: 'PLANET_NOT_FOUND', planetId: sourcePlanetId } };
  if (source.ownerId !== input.actorId) {
    return { ok: false, error: { code: 'NOT_OWNER', planetId: sourcePlanetId } };
  }

  // Idempotent replay comes before the version gate (same rule as buildings).
  const existing = player.scanReports.find((r) => r.idempotencyKey === input.idempotencyKey);
  if (existing) return { ok: true, world, report: existing };

  if (input.expectedVersion !== world.version) {
    return {
      ok: false,
      error: { code: 'STALE_VERSION', expected: input.expectedVersion, actual: world.version },
    };
  }

  if (!(scan in SCAN.kinds)) {
    return { ok: false, error: { code: 'UNKNOWN_SCAN_KIND', scan } };
  }
  const scanner = source.buildings.scanner ?? 0;
  if (scanner < 1) {
    return { ok: false, error: { code: 'SCANNER_REQUIRED', planetId: sourcePlanetId } };
  }
  const required = requiredScannerLevel(scan);
  if (scanner < required) {
    return {
      ok: false,
      error: { code: 'SCAN_LOCKED', scan, requiredScannerLevel: required },
    };
  }
  if (!isCoordinateInWorld(target)) {
    return { ok: false, error: { code: 'INVALID_DESTINATION', coordinate: target } };
  }
  const targetPlanet = planetAt(world, target);
  if (targetPlanet && targetPlanet.ownerId === input.actorId) {
    return { ok: false, error: { code: 'CANNOT_SCAN_OWN_PLANET', planetId: targetPlanet.id } };
  }

  const effects = playerResearchEffects(player);
  const range = scanRange(source, effects);
  const distance = coordinateDistance(world.seed, source.coordinate, target);
  if (distance > range) {
    return { ok: false, error: { code: 'OUT_OF_RANGE', range, distance } };
  }

  const fleetsAt = world.fleets.filter((f) => sameCoordinate(f.location, target));
  const revealed = revealScan(targetPlanet, fleetsAt, scan);

  const report: ScanReport = {
    id: orderId(`scan:${input.idempotencyKey}`),
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    sourcePlanetId,
    target,
    kind: scan,
    submittedAt,
    submittedTick: world.tick,
    expectedVersion: input.expectedVersion,
    revealed,
  };

  return {
    ok: true,
    world: {
      ...world,
      players: world.players.map((p) =>
        p.id === player.id
          ? {
              ...p,
              scanReports: [...(p.scanReports ?? []), report],
              version: p.version + 1,
            }
          : p,
      ),
      version: world.version + 1,
    },
    report,
  };
}

/**
 * Build the revealed intelligence for a scan of a planet. Rounded to the
 * scan's approximation rules and strictly bounded by the kind: a basic scan
 * never reveals resources or fleet data; resource adds approximate stores and
 * capacity; military adds the fleets at the target in brief. `target` may be
 * undefined only for a corrupted aggregate — an unoccupied coordinate is
 * reported as an empty, unclaimed world.
 */
export function revealScan(
  target: WorldState['planets'][number] | undefined,
  fleetsAt: Fleet[],
  scan: ScanKind,
): ScanRevealed {
  const base: ScanRevealed = {
    name: target?.name ?? 'Uncharted world',
    classId: target ? planetClassId(target.id) : 'barren',
    ownerId: target?.ownerId ?? null,
    factionId: target?.factionId ?? null,
    population: target ? round(target.population, SCAN.rounding.population) : 0,
  };
  if (scan === 'basic') return base;

  if (target) {
    const resources: ResourceStore = { metal: 0, mineral: 0, food: 0, energy: 0 };
    for (const r of RESOURCE_KEYS) {
      resources[r] = round(target.resources[r], SCAN.rounding.resources);
    }
    base.resources = resources;
    base.storageCap = storageCapFor(target);
  }
  if (scan === 'resource') return base;

  // Military: the fleet picture at the target coordinate, in brief.
  let ships = 0;
  let hull = 0;
  let slowest: ReturnType<typeof fleetDriveTier> = 'planetary';
  for (const fleet of fleetsAt) {
    for (const [kind, count] of Object.entries(fleet.ships) as Array<
      [keyof typeof SHIP_DEFINITIONS, number | undefined]
    >) {
      const n = count ?? 0;
      ships += n;
      hull += (SHIP_DEFINITIONS[kind]?.hull ?? 0) * n;
    }
    const tier = fleetDriveTier(fleet);
    if (DRIVE_RANK[tier] < DRIVE_RANK[slowest]) slowest = tier;
  }
  base.fleets = { count: fleetsAt.length, ships, hull, driveTier: slowest };
  return base;
}

const DRIVE_RANK = { planetary: 0, stellar: 1, galactic: 2 } as const;

/**
 * The player-visible intelligence projection (M3): the latest report per
 * target (stable coordinate order) plus the recent archive. Every field comes
 * from stored scan reports — the player never sees a target's private state
 * that no scan of the required kind has revealed.
 */
export function scanIntel(player: Player, limit = 8): ScanIntelView {
  const reports = player.scanReports ?? [];

  // Latest report per target: keep the last (highest submittedTick, then id).
  const latest = new Map<string, ScanReport>();
  for (const report of [...reports].sort(
    (a, b) => a.submittedTick - b.submittedTick || a.id.localeCompare(b.id),
  )) {
    latest.set(coordKey(report.target), report);
  }

  const planets: ScannedPlanetView[] = [...latest.values()]
    .sort((a, b) => compareCoordinates(a.target, b.target))
    .map((report) => ({
      coordinate: report.target,
      name: report.revealed.name,
      classId: report.revealed.classId,
      ownerId: report.revealed.ownerId,
      factionId: report.revealed.factionId,
      population: report.revealed.population,
      ...(report.revealed.resources === undefined ? {} : { resources: report.revealed.resources }),
      ...(report.revealed.storageCap === undefined
        ? {}
        : { storageCap: report.revealed.storageCap }),
      ...(report.revealed.fleets === undefined ? {} : { fleets: report.revealed.fleets }),
      scanKind: report.kind,
      scanTick: report.submittedTick,
    }));

  const archive = [...reports]
    .sort((a, b) => b.submittedTick - a.submittedTick || b.id.localeCompare(a.id))
    .slice(0, limit);

  return { planets, reports: archive };
}

function coordKey(coord: Coordinate): string {
  return `${coord.galaxy}:${coord.sector}:${coord.system}:${coord.planet}`;
}
