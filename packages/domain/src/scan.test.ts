import { describe, expect, it } from 'vitest';
import type { Coordinate, Fleet, Player, PlayerId, WorldState } from '@ashes/contracts';
import { generateWorld } from './worldgen';
import { playerResearchEffects } from './research';
import { scanIntel, scanRange, submitRunScan } from './scan';

function makeWorld(seed = 1337, config?: Partial<Parameters<typeof generateWorld>[0]['config']>) {
  return generateWorld({
    seed,
    config: {
      galaxies: 1,
      sectorsPerGalaxy: 2,
      systemsPerSector: 2,
      planetsPerSystem: 3,
      ...config,
    },
  });
}

function actor(seed = 1337): PlayerId {
  return `player:${seed}` as PlayerId;
}

function player(world: WorldState): Player {
  return world.players.find((p) => p.id === actor())!;
}

function homePlanet(world: WorldState) {
  return world.planets.find((p) => p.ownerId === actor())!;
}

/** Arm the home planet with a Scanner Array at `level` (default 3: all kinds). */
function scanWorld(seed = 1337, level = 3) {
  const world = makeWorld(seed);
  const home = homePlanet(world);
  home.buildings.scanner = level;
  // Give a neighbor target meaningful private state to round.
  const target = world.planets.find((p) => p.id !== home.id && p.ownerId !== actor())!;
  target.population = 1234;
  target.resources = { metal: 777, mineral: 321, food: 888, energy: 222 };
  target.ownerId = 'player:other' as PlayerId;
  target.factionId = 'embers' as WorldState['planets'][number]['factionId'];
  return world;
}

function targetOf(world: WorldState): Coordinate {
  return world.planets.find((p) => p.id !== homePlanet(world).id)!.coordinate;
}

function scanInput(world: WorldState, key: string, scan: 'basic' | 'resource' | 'military') {
  return {
    actorId: actor(),
    idempotencyKey: key,
    expectedVersion: world.version,
    command: {
      kind: 'RunScan' as const,
      sourcePlanetId: homePlanet(world).id,
      target: targetOf(world),
      scan,
    },
  };
}

function run(world: WorldState, input: ReturnType<typeof scanInput>, submittedAt = 1000) {
  return submitRunScan(world, input, submittedAt);
}

describe('submitRunScan', () => {
  it('rejects a scan from a planet without a Scanner Array', () => {
    const world = makeWorld();
    const result = run(world, scanInput(world, 'k1', 'basic'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SCANNER_REQUIRED', planetId: homePlanet(world).id },
    });
  });

  it('gates scan kinds behind the array level', () => {
    const world = scanWorld(1337, 1);
    const basic = run(world, scanInput(world, 'k1', 'basic'));
    expect(basic.ok).toBe(true);
    // Same world state: the resource scan is rejected, the array stays level 1.
    const resource = run(world, scanInput(world, 'k2', 'resource'));
    expect(resource).toMatchObject({
      ok: false,
      error: { code: 'SCAN_LOCKED', scan: 'resource', requiredScannerLevel: 2 },
    });
  });

  it('rejects an unknown scan kind before the level gate', () => {
    const world = scanWorld(1337, 1);
    const input = scanInput(world, 'k1', 'basic');
    input.command = { ...input.command, scan: 'deep' as never };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_SCAN_KIND', scan: 'deep' } });
  });

  it('rejects scanning an owned planet', () => {
    const world = scanWorld();
    const input = scanInput(world, 'k1', 'basic');
    input.command = { ...input.command, target: homePlanet(world).coordinate };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'CANNOT_SCAN_OWN_PLANET' } });
  });

  it('rejects an out-of-range target', () => {
    const world = scanWorld(1337, 1);
    const input = scanInput(world, 'k1', 'basic');
    // A coordinate on the far edge of the world space (~29k units away).
    input.command = { ...input.command, target: { galaxy: 8, sector: 8, system: 8, planet: 6 } };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'OUT_OF_RANGE' } });
    if (!result.ok && result.error.code === 'OUT_OF_RANGE') {
      expect(result.error.distance).toBeGreaterThan(result.error.range);
    }
  });

  it('rejects an invalid (out-of-world) destination', () => {
    const world = scanWorld();
    const input = scanInput(world, 'k1', 'basic');
    input.command = { ...input.command, target: { galaxy: 9, sector: 0, system: 0, planet: 0 } };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_DESTINATION' } });
  });

  it('records an immutable report and bumps the player and world versions', () => {
    const world = scanWorld();
    const before = world.version;
    const result = run(world, scanInput(world, 'k1', 'basic'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.world.version).toBe(before + 1);
    const updated = result.world.players.find((p) => p.id === actor())!;
    expect(updated.version).toBe(player(world).version + 1);
    expect(updated.scanReports).toHaveLength(1);
    expect(updated.scanReports[0]).toMatchObject({
      idempotencyKey: 'k1',
      kind: 'basic',
      target: targetOf(world),
      submittedTick: world.tick,
    });
    expect(result.report.id).toBe(updated.scanReports[0].id);
  });

  it('is idempotent: a retried scan returns the original report without a second deduction', () => {
    const world = scanWorld();
    const first = run(world, scanInput(world, 'k1', 'basic'));
    expect(first.ok).toBe(true);
    const retry = run(
      first.ok ? first.world : world,
      scanInput(first.ok ? first.world : world, 'k1', 'basic'),
      2000,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok || !first.ok) throw new Error('expected ok');
    expect(retry.world).toBe(first.world);
    expect(retry.report).toBe(first.report);
    expect(retry.report.submittedAt).toBe(1000); // original timestamp, not the retry's
  });

  it('rejects a stale world version', () => {
    const world = scanWorld();
    const input = scanInput(world, 'k1', 'basic');
    input.expectedVersion = world.version - 1;
    const result = run(world, input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STALE_VERSION', expected: world.version - 1, actual: world.version },
    });
  });

  it('rejects a scan from a foreign planet', () => {
    const world = scanWorld();
    const foreign = world.planets.find((p) => p.ownerId !== actor() && !p.ownerId)!.id;
    const input = scanInput(world, 'k1', 'basic');
    input.command = { ...input.command, sourcePlanetId: foreign };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_OWNER', planetId: foreign } });
  });
});

describe('revealScan — the M3 acceptance: a scan never retrieves private state beyond its kind', () => {
  it('basic reveals only identity, class, ownership, and rounded population', () => {
    const world = scanWorld();
    const result = run(world, scanInput(world, 'k1', 'basic'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const revealed = result.report.revealed;
    expect(revealed.population).toBe(1200); // 1234 → round(100) → 1200
    expect(revealed.name).toBeDefined();
    expect(revealed.classId).toBeDefined();
    expect(revealed.ownerId).toBe('player:other');
    expect(revealed.factionId).toBe('embers');
    expect(revealed.resources).toBeUndefined();
    expect(revealed.storageCap).toBeUndefined();
    expect(revealed.fleets).toBeUndefined();
  });

  it('resource reveals rounded stores and storage capacity — but never fleet data', () => {
    const world = scanWorld(1337, 2);
    const result = run(world, scanInput(world, 'k1', 'resource'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const revealed = result.report.revealed;
    expect(revealed.resources).toEqual({ metal: 800, mineral: 300, food: 900, energy: 200 });
    expect(revealed.storageCap).toBeDefined();
    expect(revealed.fleets).toBeUndefined();
  });

  it('military reveals the fleet picture at the target — but no exact ship mix', () => {
    const world = scanWorld(1337, 3);
    // Park a fleet at the target: 2 scouts + 1 freighter.
    const target = targetOf(world);
    const owner = actor();
    const targetPlanet = world.planets.find((p) => p.coordinate.planet === target.planet)!;
    world.fleets.push({
      id: 'fleet:scan-test' as Fleet['id'],
      ownerId: owner,
      homePlanetId: targetPlanet.id,
      location: target,
      state: 'orbiting',
      ships: { scout: 2, freighter: 1 },
      cargo: { metal: 0, mineral: 0, food: 0, energy: 0 },
      troops: 0,
      mission: null,
      departureTick: null,
      arrivalTick: null,
      route: [],
      version: 1,
    });
    const result = run(world, scanInput(world, 'k1', 'military'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const revealed = result.report.revealed;
    expect(revealed.fleets).toEqual({ count: 1, ships: 3, hull: 4, driveTier: 'planetary' }); // 2 scout (hull 1) + 1 freighter (hull 2)
    expect(revealed.resources).toBeDefined(); // military includes the resource layer too
  });

  it('an empty coordinate reports an uncharted world', () => {
    const world = scanWorld();
    const input = scanInput(world, 'k1', 'basic');
    // A valid in-world coordinate (per the 8×8×8×6 space) with no planet in
    // this small test world — in range (~350 units) but not an owned target.
    input.command = { ...input.command, target: { galaxy: 1, sector: 1, system: 1, planet: 4 } };
    const result = run(world, input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.report.revealed).toMatchObject({
      name: 'Uncharted world',
      ownerId: null,
      population: 0,
    });
  });
});

describe('scanRange and intel', () => {
  it('grows the array reach with level and the scan-range research bonus', () => {
    const world = scanWorld(1337, 1);
    const home = homePlanet(world);
    expect(scanRange(home)).toBe(1500 + 700);
    home.buildings.scanner = 3;
    expect(scanRange(home)).toBe(1500 + 3 * 700);
    const effects = playerResearchEffects(player(world));
    expect(scanRange(home, { ...effects, scanRangeBonus: 0.5 })).toBe(Math.round(3600 * 1.5));
  });

  it('projection shows the latest report per target in coordinate order and a capped archive', () => {
    let world = scanWorld();
    // Two scans of the same target: the second (newer) wins the intel slot.
    const first = run(world, scanInput(world, 'k1', 'basic'));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');
    world = first.world;
    const second = run(world, scanInput(world, 'k2', 'resource'), 2000);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    world = second.world;

    const intel = scanIntel(player(world));
    expect(intel.planets).toHaveLength(1);
    expect(intel.planets[0]).toMatchObject({
      coordinate: targetOf(world),
      scanKind: 'resource',
      population: 1200,
    });
    expect(intel.planets[0].resources).toBeDefined();
    // Archive newest-first with both reports.
    expect(intel.reports.map((r) => r.idempotencyKey)).toEqual(['k2', 'k1']);
  });

  it('requiredScannerLevel reports Infinity for an unknown kind (never passes the gate)', () => {
    const world = scanWorld(1337, 1);
    const home = homePlanet(world);
    const input = scanInput(world, 'k1', 'basic');
    input.command = { ...input.command, scan: 'deep' as never };
    const result = run(world, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_SCAN_KIND' } });
    expect(home.buildings.scanner).toBe(1); // untouched
  });
});
