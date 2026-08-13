import { describe, expect, it } from 'vitest';
import type { Coordinate, Fleet, PlayerId } from '@ashes/contracts';
import { emptyResourceStore } from '@ashes/contracts';
import { coordinateDistance, fleetDriveTier, travelTicks } from './travel';

const SEED = 1337;

function coord(galaxy: number, sector: number, system: number, planet: number): Coordinate {
  return { galaxy, sector, system, planet };
}

function fleetWith(ships: Record<string, number>): Fleet {
  return {
    id: 'fleet:test' as Fleet['id'],
    ownerId: 'player:1' as PlayerId,
    homePlanetId: null,
    location: coord(1, 1, 1, 1),
    state: 'orbiting',
    ships: ships as Fleet['ships'],
    cargo: emptyResourceStore(),
    troops: 0,
    mission: null,
    departureTick: null,
    arrivalTick: null,
    route: [],
    version: 1,
  };
}

describe('coordinateDistance', () => {
  it('is zero between a coordinate and itself', () => {
    expect(coordinateDistance(SEED, coord(1, 1, 1, 1), coord(1, 1, 1, 1))).toBe(0);
  });

  it('is symmetric', () => {
    const a = coord(1, 1, 1, 1);
    const b = coord(1, 1, 1, 2);
    expect(coordinateDistance(SEED, a, b)).toBeCloseTo(coordinateDistance(SEED, b, a));
  });

  it('grows with the map space: across galaxies is much farther than across a system', () => {
    const inSystem = coordinateDistance(SEED, coord(1, 1, 1, 1), coord(1, 1, 1, 2));
    const acrossGalaxies = coordinateDistance(SEED, coord(1, 1, 1, 1), coord(2, 1, 1, 1));
    expect(inSystem).toBeGreaterThan(0);
    expect(acrossGalaxies).toBeGreaterThan(inSystem * 10);
  });
});

describe('travelTicks', () => {
  it('is ceil(distance / drive speed), at least 1', () => {
    // stellar speed 480 → 500/480 = 1.04 → 2.
    expect(travelTicks({ distance: 500, driveTier: 'stellar', navigationSpeedBonus: 0 })).toBe(2);
    // 100/480 → 0.21 → 1 (minimum).
    expect(travelTicks({ distance: 100, driveTier: 'stellar', navigationSpeedBonus: 0 })).toBe(1);
    // 4800/480 → exactly 10.
    expect(travelTicks({ distance: 4800, driveTier: 'stellar', navigationSpeedBonus: 0 })).toBe(10);
  });

  it('a navigation research visibly shortens travel (the M2 acceptance test)', () => {
    const distance = 1200;
    const without = travelTicks({ distance, driveTier: 'stellar', navigationSpeedBonus: 0 });
    const withBonus = travelTicks({ distance, driveTier: 'stellar', navigationSpeedBonus: 0.5 });
    // 1200/480 = 2.5 → 3; with +50% speed: 1200/720 = 1.67 → 2.
    expect(without).toBe(3);
    expect(withBonus).toBe(2);
    expect(withBonus).toBeLessThan(without);
  });

  it('drive tiers scale: galactic is much faster than planetary', () => {
    const distance = 10_000;
    const planetary = travelTicks({ distance, driveTier: 'planetary', navigationSpeedBonus: 0 });
    const galactic = travelTicks({ distance, driveTier: 'galactic', navigationSpeedBonus: 0 });
    expect(planetary).toBeGreaterThan(galactic * 5);
  });
});

describe('fleetDriveTier', () => {
  it('is planetary for an empty fleet or fighters only', () => {
    expect(fleetDriveTier(fleetWith({}))).toBe('planetary');
    expect(fleetDriveTier(fleetWith({ fighter: 3 }))).toBe('planetary');
  });

  it('is stellar for a scout or freighter fleet', () => {
    expect(fleetDriveTier(fleetWith({ scout: 1 }))).toBe('stellar');
    expect(fleetDriveTier(fleetWith({ freighter: 2, scout: 1 }))).toBe('stellar');
  });

  it('is limited by the slowest ship: a fighter escort drags scouts down to planetary', () => {
    expect(fleetDriveTier(fleetWith({ scout: 2, fighter: 1 }))).toBe('planetary');
  });
});
