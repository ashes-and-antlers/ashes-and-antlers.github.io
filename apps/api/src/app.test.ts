import { describe, expect, it } from 'vitest';
import { TickEngine, InMemoryWorldRepository, WorldLock } from '@ashes/db';
import { createApi, type AuthConfig } from './app';

const AUTH: AuthConfig = {
  playerToken: 'player-1337-token',
  adminToken: 'dev-admin-token',
};

async function makeApp() {
  const repository = new InMemoryWorldRepository();
  const engine = new TickEngine({ repository, lock: new WorldLock() });
  await engine.createWorld({ seed: 1337, createdAt: 1000, playerToken: AUTH.playerToken });
  const app = createApi(engine, AUTH);
  return { app, engine, repository };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('health and dev world creation', () => {
  it('serves healthz without auth', async () => {
    const { app } = await makeApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('rejects dev world creation without the admin token', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/dev/worlds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 42 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates a world from a seed with the admin token', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/dev/worlds', {
      method: 'POST',
      headers: { ...bearer(AUTH.adminToken), 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 42 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worldId: string;
      player: { homePlanet: { coordinate: Record<string, number> } };
      worldHash: string;
    };
    expect(body.worldId).toBe('world:42');
    expect(body.worldHash).toBeTruthy();
    expect(body.player.homePlanet.coordinate).toMatchObject({
      galaxy: 1,
      sector: expect.any(Number),
      system: expect.any(Number),
      planet: expect.any(Number),
    });
  });
});

describe('overview (player auth required)', () => {
  it('rejects unauthenticated overview with 401', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/overview');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer('wrong-token'),
    });
    expect(res.status).toBe(401);
  });

  it('serves the overview with tick, next tick time, and home planet', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer(AUTH.playerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worldId: string;
      tick: number;
      nextTickAt: number;
      worldHash: string;
      protocolVersion: string;
      player: { name: string; factionId: string; homePlanet: { coordinate: string } };
      planets: unknown[];
    };
    expect(body.worldId).toBe('world:1337');
    expect(body.tick).toBe(0);
    expect(body.nextTickAt).toBeGreaterThan(1000);
    expect(body.worldHash).toBeTruthy();
    expect(body.protocolVersion).toBeTruthy();
    expect(body.player.name).toBeTruthy();
    expect(body.player.factionId).toBe('hearth');
    expect(body.player.homePlanet.coordinate).toBeTruthy();
    expect(body.planets).toHaveLength(1);
  });

  it('returns 404 for an unknown world', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:9999/overview', {
      headers: bearer(AUTH.playerToken),
    });
    expect(res.status).toBe(404);
  });
});

describe('dev tick trigger', () => {
  it('advances the world tick deterministically', async () => {
    const { app } = await makeApp();
    const before = (await (
      await app.request('/api/v1/worlds/world:1337/overview', {
        headers: bearer(AUTH.playerToken),
      })
    ).json()) as { tick: number };

    const res = await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(AUTH.adminToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tick: number; status: string };
    expect(body.tick).toBe(before.tick + 1);
    expect(body.status).toBe('completed');

    const after = (await (
      await app.request('/api/v1/worlds/world:1337/overview', {
        headers: bearer(AUTH.playerToken),
      })
    ).json()) as { tick: number; lastResolution: { planetStateHash: string } | null };
    expect(after.tick).toBe(before.tick + 1);
    expect(after.lastResolution?.planetStateHash).toBeTruthy();
  });
});

describe('commands (M0 rejects all kinds)', () => {
  it('rejects unauthenticated commands with 401', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-12345',
        expectedVersion: 1,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed command envelopes with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(AUTH.playerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'short', expectedVersion: 'NaN', command: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects well-formed but unsupported command kinds with 400', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(AUTH.playerToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-12345678',
        expectedVersion: 1,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', building: 'MetalMine', level: 2 },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_COMMAND_KIND');
  });
});
