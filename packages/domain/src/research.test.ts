import { describe, expect, it } from 'vitest';
import type { Planet, PlayerId, WorldState } from '@ashes/contracts';
import { technologyId } from '@ashes/contracts';
import { RESEARCH, RESEARCH_BY_ID } from '@ashes/content';
import { generateWorld, computePlanetStateHash } from './worldgen';
import {
  resolveResearchTick,
  submitStartResearch,
  cancelResearch,
  playerResearchEffects,
} from './research';

function makeWorld(seed = 1337) {
  return generateWorld({
    seed,
    config: { galaxies: 1, sectorsPerGalaxy: 2, systemsPerSector: 2, planetsPerSystem: 3 },
  });
}

function homePlanet(world: WorldState): Planet {
  const player = world.players[0];
  const home = world.planets.find((p) => p.id === player.homePlanetId);
  if (!home) throw new Error('home planet missing');
  return home;
}

function actor(seed = 1337): PlayerId {
  return `player:${seed}` as PlayerId;
}

/** World whose home planet has a Research Lab and a rich store for studies. */
function labWorld(seed = 1337) {
  const world = makeWorld(seed);
  const home = homePlanet(world);
  home.buildings = { settlement: 1, lab: 1 };
  home.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
  return world;
}

function startResearch(world: WorldState, technologyId: string, key: string) {
  const planet = homePlanet(world);
  return submitStartResearch(
    world,
    {
      actorId: actor(),
      idempotencyKey: key,
      expectedVersion: world.version,
      command: {
        kind: 'StartResearch',
        hostPlanetId: planet.id,
        technologyId: technologyId as never,
      },
    },
    1000,
  );
}

describe('submitStartResearch', () => {
  it('reserves the cost from the hosting lab planet and queues the study', () => {
    const world = labWorld();
    const planet = homePlanet(world);
    const before = planet.resources;
    const result = startResearch(world, 'extraction-1', 'key-res-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = homePlanet(result.world);
    // extraction-1 costs metal 120 + mineral 60, deducted at submission.
    expect(after.resources.metal).toBe(before.metal - 120);
    expect(after.resources.mineral).toBe(before.mineral - 60);
    expect(after.resources).toEqual({ metal: 380, mineral: 440, food: 500, energy: 500 });

    const order = result.order;
    expect(order.kind).toBe('research');
    expect(order.technologyId).toBe('extraction-1');
    expect(order.status).toBe('researching');
    expect(order.ticksRemaining).toBe(RESEARCH_BY_ID[technologyId('extraction-1')].researchTicks);
    expect(order.startTick).toBe(0);
    expect(result.world.players[0].researchOrders).toHaveLength(1);
  });

  it('requires a Research Lab on the host planet', () => {
    const world = makeWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
    const result = startResearch(world, 'extraction-1', 'key-no-lab');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HOST_PLANET_REQUIRES_LAB');
  });

  it('rejects a command for a planet the actor does not own', () => {
    const world = labWorld();
    const stranger = world.planets.find((p) => p.ownerId === null)!;
    stranger.buildings = { lab: 1 };
    stranger.resources = { metal: 500, mineral: 500, food: 500, energy: 500 };
    const result = submitStartResearch(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'key-stranger',
        expectedVersion: world.version,
        command: {
          kind: 'StartResearch',
          hostPlanetId: stranger.id,
          technologyId: technologyId('extraction-1'),
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_OWNER');
  });

  it('rejects when prerequisites are not met', () => {
    const world = labWorld();
    // storage-1 requires extraction-1.
    const result = startResearch(world, 'storage-1', 'key-prereq');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PREREQUISITES_NOT_MET');
    if (result.error.code !== 'PREREQUISITES_NOT_MET') return;
    expect(result.error.missing).toContain('extraction-1');
  });

  it('rejects an already-researched technology', () => {
    const world = labWorld();
    const player = world.players[0];
    player.technologies = [technologyId('extraction-1')];
    const result = startResearch(world, 'extraction-1', 'key-dup');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ALREADY_RESEARCHED');
  });

  it('rejects when the host planet cannot afford the cost', () => {
    const world = labWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 10, mineral: 500, food: 500, energy: 500 };
    const result = startResearch(world, 'extraction-1', 'key-poor');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_RESOURCES');
    if (result.error.code !== 'INSUFFICIENT_RESOURCES') return;
    expect(result.error.missing).toEqual({ metal: 110 });
  });

  it('rejects a stale expected version', () => {
    const world = labWorld();
    const planet = homePlanet(world);
    const result = submitStartResearch(
      world,
      {
        actorId: actor(),
        idempotencyKey: 'key-stale',
        expectedVersion: world.version + 5,
        command: {
          kind: 'StartResearch',
          hostPlanetId: planet.id,
          technologyId: technologyId('extraction-1'),
        },
      },
      1000,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STALE_VERSION');
  });

  it('is idempotent: the same key replays the original order', () => {
    const world = labWorld();
    const first = startResearch(world, 'extraction-1', 'key-replay');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = startResearch(first.world, 'extraction-1', 'key-replay');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.order.id).toBe(first.order.id);
    expect(homePlanet(replay.world).resources).toEqual(homePlanet(first.world).resources);
  });

  it('fills the account-wide queue to capacity and then rejects', () => {
    let world = labWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    // Complete the extraction tech first so storage-1 becomes startable; queue
    // capacity counts active (researching + queued) orders, so queue 3 techs.
    const first = startResearch(world, 'extraction-1', 'key-q1');
    if (!first.ok) throw new Error('start failed');
    world = first.world;
    const second = startResearch(world, 'nav-1', 'key-q2');
    if (!second.ok) throw new Error('start failed');
    world = second.world;
    const third = startResearch(world, 'scan-1', 'key-q3');
    if (!third.ok) throw new Error('start failed');
    world = third.world;
    const full = startResearch(world, 'shipyard-1', 'key-q4');
    expect(full.ok).toBe(false);
    if (full.ok) return;
    expect(full.error.code).toBe('QUEUE_FULL');
    expect(RESEARCH.queueCapacity).toBe(3);
  });
});

describe('cancelResearch', () => {
  it('refunds the exact reserved cost to the host planet and marks cancelled', () => {
    const original = { ...homePlanet(labWorld()).resources };
    let world = labWorld();
    const started = startResearch(world, 'extraction-1', 'key-cancel');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    expect(homePlanet(world).resources.metal).toBe(380);

    const result = cancelResearch(world, {
      actorId: actor(),
      idempotencyKey: 'key-cancel-order',
      expectedVersion: world.version,
      command: { kind: 'CancelResearch', orderId: started.order.id },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.status).toBe('cancelled');
    expect(homePlanet(result.world).resources).toEqual(original);
  });

  it('can never refund twice (cancel of a cancelled order is a no-op)', () => {
    const original = { ...homePlanet(labWorld()).resources };
    let world = labWorld();
    const started = startResearch(world, 'extraction-1', 'key-cancel2');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    const first = cancelResearch(world, {
      actorId: actor(),
      idempotencyKey: 'key-c2-a',
      expectedVersion: world.version,
      command: { kind: 'CancelResearch', orderId: started.order.id },
    });
    if (!first.ok) throw new Error('first cancel failed');
    const second = cancelResearch(first.world, {
      actorId: actor(),
      idempotencyKey: 'key-c2-b',
      expectedVersion: first.world.version,
      command: { kind: 'CancelResearch', orderId: started.order.id },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(homePlanet(second.world).resources).toEqual(original);
    expect(
      second.world.players[0].researchOrders.filter((o) => o.status === 'cancelled'),
    ).toHaveLength(1);
  });

  it('refuses to cancel a completed order', () => {
    let world = labWorld();
    const started = startResearch(world, 'extraction-1', 'key-done');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    for (let tick = 1; tick <= 3; tick++) world = resolveResearchTick(world, tick);
    const result = cancelResearch(world, {
      actorId: actor(),
      idempotencyKey: 'key-done-cancel',
      expectedVersion: world.version,
      command: { kind: 'CancelResearch', orderId: started.order.id },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CANNOT_CANCEL');
  });
});

describe('resolveResearchTick', () => {
  it('completes a study after its research ticks and adds the technology', () => {
    let world = labWorld();
    const started = startResearch(world, 'extraction-1', 'key-tick');
    if (!started.ok) throw new Error('start failed');
    world = started.world;

    world = resolveResearchTick(world, 1);
    expect(world.players[0].technologies).toEqual([]);
    world = resolveResearchTick(world, 2);
    world = resolveResearchTick(world, 3);
    const player = world.players[0];
    expect(player.technologies).toContain('extraction-1');
    const order = player.researchOrders[0];
    expect(order.status).toBe('completed');
    expect(order.completedAtTick).toBe(3);
  });

  it('runs the queue FIFO: the next study starts after the first completes', () => {
    let world = labWorld();
    const planet = homePlanet(world);
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    const a = startResearch(world, 'extraction-1', 'key-f1');
    if (!a.ok) throw new Error('start failed');
    world = a.world;
    const b = startResearch(world, 'nav-1', 'key-f2');
    if (!b.ok) throw new Error('start failed');
    world = b.world;
    expect(world.players[0].researchOrders[1].status).toBe('queued');

    for (let tick = 1; tick <= 3; tick++) world = resolveResearchTick(world, tick);
    const afterFirst = world.players[0];
    expect(afterFirst.researchOrders[0].status).toBe('completed');
    expect(afterFirst.researchOrders[1].status).toBe('researching');
    expect(afterFirst.researchOrders[1].startTick).toBe(3);
  });

  it('does not double-record a technology when replaying the same tick', () => {
    let world = labWorld();
    const started = startResearch(world, 'extraction-1', 'key-replay-tick');
    if (!started.ok) throw new Error('start failed');
    world = started.world;
    for (let tick = 1; tick <= 3; tick++) world = resolveResearchTick(world, tick);
    // Re-resolving the same completed tick (idempotent replay) must not add
    // the technology twice.
    world = resolveResearchTick(world, 3);
    expect(world.players[0].technologies.filter((t) => t === 'extraction-1')).toHaveLength(1);
  });
});

describe('research effects', () => {
  it('aggregates additive effects from completed technologies', () => {
    const world = labWorld();
    world.players[0].technologies = [
      technologyId('extraction-1'),
      technologyId('nav-1'),
      technologyId('shipyard-1'),
    ];
    const effects = playerResearchEffects(world.players[0]);
    expect(effects.extractionBonus).toBe(0.15);
    expect(effects.navigationSpeedBonus).toBe(0.5);
    expect(effects.shipUnlocks).toContain('fighter');
  });

  it('research state changes the planet-state hash', () => {
    const world = labWorld();
    const before = computePlanetStateHash(world.planets);
    const started = startResearch(world, 'extraction-1', 'key-hash');
    if (!started.ok) throw new Error('start failed');
    // The host planet store changed (cost reserved), so the hash moves.
    expect(computePlanetStateHash(started.world.planets)).not.toBe(before);
  });
});
