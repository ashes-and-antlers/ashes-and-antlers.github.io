import { z } from 'zod';
import type { FactionId, OrderId, PlanetId, PlayerId } from './ids';
import type { Coordinate } from './coordinate';
import type { DriveTier } from './shipyard';
import type { ResourceStore } from './planet';

/**
 * Scan missions (DEVELOPMENT_PLAN.md §6, M3): limited, timestamped
 * intelligence. A player runs a scan from an owned planet with a Scanner
 * Array; the target must be within the array's reach (range grows with
 * scanner level and the watch-spire research). Scan tiers reveal only what
 * their definition allows — exact private state is never exposed beyond the
 * kind (the M3 acceptance test). Reports are immutable and carry the tick
 * they were gathered on, so a report is never a guarantee the target has not
 * moved since.
 */
export const SCAN_KINDS = ['basic', 'resource', 'military'] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

export const SCAN_KIND_LABELS: Record<ScanKind, string> = {
  basic: 'Basic',
  resource: 'Resource',
  military: 'Military',
};

/**
 * Run a scan of a target coordinate from an owned planet's Scanner Array.
 * The scan kind gates the detail revealed: basic shows occupancy and class,
 * resource adds approximate resources and capacity, military adds fleet
 * presence and strength.
 */
export type RunScanCommand = {
  kind: 'RunScan';
  sourcePlanetId: PlanetId;
  target: Coordinate;
  scan: ScanKind;
};

export const RunScanCommandSchema = z
  .object({
    kind: z.literal('RunScan'),
    sourcePlanetId: z.string().min(1),
    target: z
      .object({
        galaxy: z.number().int().min(1),
        sector: z.number().int().min(1),
        system: z.number().int().min(1),
        planet: z.number().int().min(1),
      })
      .strict(),
    scan: z.enum(SCAN_KINDS),
  })
  .strict();

/**
 * What a scan actually reveals. Rounded approximations only — population is
 * rounded to the nearest 100 and stored resources to the nearest 50 by the
 * domain, and a basic scan never includes resources or fleet data at all.
 */
export type ScanRevealed = {
  name: string;
  /** Visual class of the world (desert, ice, gas giant…). */
  classId: string;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  /** Rounded to the nearest 100. */
  population: number;
  /** Resource + military scans: approximate stored resources (nearest 50). */
  resources?: ResourceStore;
  /** Resource + military scans: the target's storage cap. */
  storageCap?: number;
  /** Military scans only: fleets at the target coordinate, in brief. */
  fleets?: {
    count: number;
    ships: number;
    hull: number;
    driveTier: DriveTier;
  };
};

/** Immutable per-player scan record (an idempotency-keyed receipt). */
export type ScanReport = {
  id: OrderId;
  idempotencyKey: string;
  actorId: PlayerId;
  sourcePlanetId: PlanetId;
  target: Coordinate;
  kind: ScanKind;
  submittedAt: number;
  submittedTick: number;
  expectedVersion: number;
  revealed: ScanRevealed;
};

/** The scan archive page view: newest reports first, capped. */
export type ScanReportView = ScanReport;

/** A visibility-filtered projection of one scanned world (latest report). */
export type ScannedPlanetView = {
  coordinate: Coordinate;
  name: string;
  classId: string;
  ownerId: PlayerId | null;
  factionId: FactionId | null;
  population: number;
  resources?: ResourceStore;
  storageCap?: number;
  fleets?: ScanRevealed['fleets'];
  /** The kind of the latest report — what is visible now. */
  scanKind: ScanKind;
  /** The tick the latest report was gathered on (age of the intel). */
  scanTick: number;
};

/** Player-scoped intelligence projection (M3): derived from scan reports. */
export type ScanIntelView = {
  /** Latest report per target, in stable coordinate order. */
  planets: ScannedPlanetView[];
  /** Recent reports, newest first. */
  reports: ScanReportView[];
};
