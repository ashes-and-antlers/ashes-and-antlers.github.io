import { TRAVEL } from '@ashes/content';
import type { Coordinate, DriveTier, Fleet, ShipStacks } from '@ashes/contracts';
import { planetPosition } from './galaxy-layout';

/**
 * Fleet travel (DEVELOPMENT_PLAN.md §5, M2). Pure and deterministic: travel
 * ticks are a pure function of map distance, the fleet's drive tier, and the
 * player's navigation research bonus — the same inputs every time. The M2
 * acceptance test pins that a completed navigation research changes this
 * calculation (nav-1 adds a fractional speed bonus).
 *
 * Movement itself (send/recall/arrival) lands in M3; this is the calculation
 * those missions will consume, and it is already unit-tested here.
 */

/** Map-unit distance between two coordinates (euclidean, in map space). */
export function coordinateDistance(seed: number, from: Coordinate, to: Coordinate): number {
  const a = planetPosition(seed, from);
  const b = planetPosition(seed, to);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Travel ticks for a route: distance / (drive speed × (1 + navigation bonus)),
 * rounded up, at least 1. Navigation research (nav-1, nav-2) is the only
 * research that affects this formula today, so a completed nav technology
 * visibly shortens travel — the M2 acceptance scenario.
 */
export function travelTicks(input: {
  distance: number;
  driveTier: DriveTier;
  navigationSpeedBonus: number;
}): number {
  const base = TRAVEL.driveTierSpeed[input.driveTier];
  const speed = base * (1 + input.navigationSpeedBonus);
  return Math.max(1, Math.ceil(input.distance / speed));
}

/**
 * The slowest relevant drive in a fleet (the limiting tier): the fleet moves
 * no faster than its slowest ship. A fighter escort drags a scout wing down
 * to planetary speed; an all-stellar fleet runs at stellar speed.
 */
export function fleetDriveTier(fleet: Fleet): DriveTier {
  let slowest: DriveTier | null = null;
  for (const [kind, count] of Object.entries(fleet.ships) as Array<
    [keyof ShipStacks, number | undefined]
  >) {
    if (!count || count <= 0) continue;
    const shipTier = DRIVE_TIER_RANK[kind];
    if (slowest === null || RANK[shipTier] < RANK[slowest]) slowest = shipTier;
  }
  return slowest ?? 'planetary';
}

const DRIVE_TIER_RANK = {
  scout: 'stellar',
  freighter: 'stellar',
  outpost: 'stellar',
  fighter: 'planetary',
} as const;

const RANK: Record<DriveTier, number> = { planetary: 0, stellar: 1, galactic: 2 };
