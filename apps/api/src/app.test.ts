import { describe, expect, it } from 'vitest';
import {
  InMemoryAccountRepository,
  InMemoryDatabaseAdmin,
  InMemoryWorldRepository,
  TickEngine,
  WorldLock,
} from '@ashes/db';
import { worldIdFromSeed, type PlayerId } from '@ashes/contracts';
import { coordinateDistance } from '@ashes/domain';
import { createApi, type AuthContext } from './app';

const PLAYER_TOKEN = 'player-1337-token';
const ADMIN_TOKEN = 'dev-admin-token';
const SEED = 1337;

async function makeApp() {
  const repository = new InMemoryWorldRepository();
  const accounts = new InMemoryAccountRepository();
  const databaseAdmin = new InMemoryDatabaseAdmin();
  const engine = new TickEngine({ repository, lock: new WorldLock(), admin: databaseAdmin });
  await engine.createWorld({ seed: SEED, createdAt: 1000, playerToken: PLAYER_TOKEN });
  const worldId = worldIdFromSeed(SEED);
  const auth: AuthContext = {
    adminToken: ADMIN_TOKEN,
    async resolvePlayerIdentity(token) {
      const account = await accounts.getAccountBySessionToken(token, Date.now());
      if (account) {
        return {
          playerId: account.playerId,
          worldId: account.worldId,
          accountId: account.id,
          sessionToken: token,
        };
      }
      if (token === PLAYER_TOKEN) {
        return { playerId: `player:${SEED}` as PlayerId, worldId, sessionToken: token };
      }
      return null;
    },
  };
  const app = createApi(engine, auth, accounts, worldId, databaseAdmin);
  return { app, engine, repository, accounts, databaseAdmin };
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
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
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
      galaxy: expect.any(Number),
      sector: expect.any(Number),
      system: expect.any(Number),
      planet: expect.any(Number),
    });
  });
});

describe('accounts', () => {
  it('lists the faction catalog and the shared emblem bank (public)', async () => {
    const { app } = await makeApp();
    const factionsRes = await app.request('/api/v1/factions');
    expect(factionsRes.status).toBe(200);
    const factions = (await factionsRes.json()) as Array<{ id: string; name: string }>;
    expect(factions.length).toBeGreaterThanOrEqual(2);
    expect(factions[0].name).toBeTruthy();

    const emblemsRes = await app.request('/api/v1/emblems');
    expect(emblemsRes.status).toBe(200);
    const emblems = (await emblemsRes.json()) as Array<{ id: string; path: string }>;
    expect(emblems.length).toBeGreaterThanOrEqual(4);
    for (const emblem of emblems) {
      expect(emblem.path.length).toBeGreaterThan(0);
    }
  });

  it('registers an account, assigns the least-populated faction, spawns it, and returns a session', async () => {
    const { app, engine } = await makeApp();
    const res = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'warden_one',
        password: 'correct horse',
        name: 'Warden One',
        symbolId: 'hearth-crown',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      token: string;
      account: {
        username: string;
        name: string;
        factionId: string;
        symbolId: string;
        playerId: string;
      };
    };
    expect(body.token.startsWith('sess_')).toBe(true);
    expect(body.account.username).toBe('warden_one');
    expect(body.account.name).toBe('Warden One');
    // The seeded dev player is hearth, so the first account goes iron.
    expect(body.account.factionId).toBe('iron');
    expect(body.account.symbolId).toBe('hearth-crown');

    // The account's session opens the overview for ITS player, not the seed.
    const overview = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer(body.token),
    });
    expect(overview.status).toBe(200);
    const view = (await overview.json()) as {
      player: {
        name: string;
        id: string;
        factionId: string;
        homePlanet: { coordinate: { galaxy: number } };
      };
    };
    expect(view.player.name).toBe('Warden One');
    expect(view.player.id).toBe(body.account.playerId);
    expect(view.player.factionId).toBe('iron');

    // Spawn placement: the seeded player's home galaxy anchors the frontier,
    // so the new commander starts within one galaxy of it — never the far side.
    const seeded = await engine.getWorld(worldIdFromSeed(SEED));
    const seededHomeGalaxy = seeded!.planets.find((p) => p.id === seeded!.players[0].homePlanetId)!
      .coordinate.galaxy;
    const accountGalaxy = view.player.homePlanet.coordinate.galaxy;
    expect(Math.abs(accountGalaxy - seededHomeGalaxy)).toBeLessThanOrEqual(1);
  });

  it('rebalances: the second account goes back to the first faction', async () => {
    const { app } = await makeApp();
    const register = (username: string) =>
      app.request('/api/v1/accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct horse', symbolId: 'iron-talon' }),
      });
    const a = (await (await register('bal_a')).json()) as { account: { factionId: string } };
    expect(a.account.factionId).toBe('iron'); // hearth 1, iron 0 → iron
    const b = (await (await register('bal_b')).json()) as { account: { factionId: string } };
    expect(b.account.factionId).toBe('hearth'); // hearth 1, iron 1 → tie → hearth
  });

  it('returns 404 (not 500) for a session whose player was wiped by world regeneration', async () => {
    const { app, engine, repository } = await makeApp();
    const registered = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'wiped_warden',
        password: 'correct horse',
        symbolId: 'hearth-crown',
      }),
    });
    const session = (await registered.json()) as { token: string };

    // A wiped world row regenerates fresh, dropping the spawned account player
    // (the real-world sequence behind a content/version bump or a reset).
    await repository.deleteWorld(worldIdFromSeed(SEED));
    await engine.createWorld({ seed: SEED, createdAt: 2000, playerToken: PLAYER_TOKEN });

    const res = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer(session.token),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('player');
  });

  it('rejects a session from another world without returning an internal error', async () => {
    const { app, engine } = await makeApp();
    await engine.createWorld({ seed: 424242, createdAt: 1000 });
    const registered = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'cross_world_warden',
        password: 'correct horse',
        symbolId: 'hearth-crown',
      }),
    });
    const session = (await registered.json()) as { token: string };

    const res = await app.request('/api/v1/worlds/world:424242/overview', {
      headers: bearer(session.token),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('rejects a duplicate username', async () => {
    const { app } = await makeApp();
    const body = {
      username: 'dup_warden',
      password: 'correct horse',
      symbolId: 'hearth-crown',
    };
    const first = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as { error: { code: string } };
    expect(err.error.code).toBe('CONFLICT');
  });

  it('rejects an unknown emblem', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'wrong_symbol',
        password: 'correct horse',
        symbolId: 'not-an-emblem',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('normalizes usernames and revokes sessions on logout', async () => {
    const { app } = await makeApp();
    const registered = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'CaseSensitive_Warden',
        password: 'correct horse',
        symbolId: 'iron-blade',
      }),
    });
    expect(registered.status).toBe(201);
    const created = (await registered.json()) as {
      token: string;
      account: { username: string };
    };
    expect(created.account.username).toBe('casesensitive_warden');

    const login = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'CASESENSITIVE_WARDEN', password: 'correct horse' }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { token: string };
    expect(session.token).not.toBe(created.token);

    const beforeLogout = await app.request('/api/v1/accounts/me', {
      headers: bearer(session.token),
    });
    expect(beforeLogout.status).toBe(200);

    const logout = await app.request('/api/v1/accounts/logout', {
      method: 'POST',
      headers: bearer(session.token),
    });
    expect(logout.status).toBe(204);

    const afterLogout = await app.request('/api/v1/accounts/me', {
      headers: bearer(session.token),
    });
    expect(afterLogout.status).toBe(401);
  });

  it('logs in with the correct password and rejects a wrong one', async () => {
    const { app } = await makeApp();
    await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'login_warden',
        password: 'correct horse',
        symbolId: 'iron-blade',
      }),
    });
    const ok = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'login_warden', password: 'correct horse' }),
    });
    expect(ok.status).toBe(200);
    const session = (await ok.json()) as { token: string; account: { symbolId: string } };
    expect(session.token.startsWith('sess_')).toBe(true);
    expect(session.account.symbolId).toBe('iron-blade');

    const bad = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'login_warden', password: 'wrong password' }),
    });
    expect(bad.status).toBe(401);
  });

  it('re-spawns a commander whose player was wiped by a world regeneration', async () => {
    const { app, engine, repository } = await makeApp();
    const registered = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'orphan_warden',
        password: 'correct horse',
        symbolId: 'iron-blade',
      }),
    });
    expect(registered.status).toBe(201);
    const created = (await registered.json()) as {
      account: { playerId: string; homePlanetId: string; factionId: string };
    };

    // Simulate the corruption: the world was re-derived from the seed, wiping
    // spawned players while the account row survived.
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    await repository.saveWorld({
      ...world!,
      players: world!.players.filter((p) => p.id !== created.account.playerId),
      version: world!.version + 1,
    });

    // Logging in must re-spawn the commander instead of issuing a dead session.
    const login = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'orphan_warden', password: 'correct horse' }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as { token: string; account: { homePlanetId: string } };
    expect(session.account.homePlanetId).toBeTruthy();

    // The player is back in the world and the overview serves for the token.
    const after = await engine.getWorld(worldIdFromSeed(SEED));
    expect(after!.players.some((p) => p.id === created.account.playerId)).toBe(true);
    const overview = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer(session.token),
    });
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as { player: { name: string } };
    expect(body.player.name).toBe('orphan_warden');
  });

  it('two accounts spawn at distinct planets', async () => {
    const { app, engine } = await makeApp();
    const register = (username: string) =>
      app.request('/api/v1/accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password: 'correct horse',
          symbolId: 'iron-talon',
        }),
      });
    const a = (await (await register('spawn_a')).json()) as { account: { playerId: string } };
    const b = (await (await register('spawn_b')).json()) as { account: { playerId: string } };
    expect(a.account.playerId).not.toBe(b.account.playerId);
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const ownedA = world!.planets.filter((p) => p.ownerId === a.account.playerId);
    const ownedB = world!.planets.filter((p) => p.ownerId === b.account.playerId);
    expect(ownedA).toHaveLength(1);
    expect(ownedB).toHaveLength(1);
    expect(ownedA[0].id).not.toBe(ownedB[0].id);
  });
});

describe('control panel (profile, security, sessions)', () => {
  async function register(app: Awaited<ReturnType<typeof makeApp>>['app'], username: string) {
    const res = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'correct horse',
        name: 'Warden Original',
        symbolId: 'iron-blade',
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      token: string;
      account: {
        id: string;
        name: string;
        symbolId: string;
        playerId: string;
        worldId: string;
      };
    };
  }

  it('updates the profile: renames the commander in the world and swaps the emblem', async () => {
    const { app, engine } = await makeApp();
    const { token, account } = await register(app, 'panel_profile');

    const patched = await app.request('/api/v1/accounts/me', {
      method: 'PATCH',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Warden Renamed', symbolId: 'hearth-crown' }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      account: { name: string; symbolId: string };
    };
    expect(body.account.name).toBe('Warden Renamed');
    expect(body.account.symbolId).toBe('hearth-crown');

    // The rename is authoritative: the player inside the world aggregate changed.
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const player = world!.players.find((p) => p.id === account.playerId);
    expect(player?.name).toBe('Warden Renamed');
  });

  it('rejects an unknown emblem or an empty name in a profile update', async () => {
    const { app } = await makeApp();
    const { token } = await register(app, 'panel_bad');

    const badEmblem = await app.request('/api/v1/accounts/me', {
      method: 'PATCH',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ symbolId: 'not-an-emblem' }),
    });
    expect(badEmblem.status).toBe(400);

    const emptyName = await app.request('/api/v1/accounts/me', {
      method: 'PATCH',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(emptyName.status).toBe(400);
  });

  it('changes the password: wrong current is rejected, old password stops working', async () => {
    const { app } = await makeApp();
    const { token } = await register(app, 'panel_pw');

    const wrongCurrent = await app.request('/api/v1/accounts/me/password', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong horse', newPassword: 'fresh password' }),
    });
    expect(wrongCurrent.status).toBe(401);

    const changed = await app.request('/api/v1/accounts/me/password', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'fresh password' }),
    });
    expect(changed.status).toBe(204);

    const oldLogin = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'panel_pw', password: 'correct horse' }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'panel_pw', password: 'fresh password' }),
    });
    expect(newLogin.status).toBe(200);
  });

  it('lists sessions, marks the current one, and revokes the others', async () => {
    const { app } = await makeApp();
    const first = await register(app, 'panel_devices');
    const second = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'panel_devices', password: 'correct horse' }),
    });
    expect(second.status).toBe(200);
    const secondToken = ((await second.json()) as { token: string }).token;

    const listed = await app.request('/api/v1/accounts/me/sessions', {
      headers: bearer(secondToken),
    });
    expect(listed.status).toBe(200);
    const { sessions } = (await listed.json()) as {
      sessions: Array<{
        id: string;
        isCurrent: boolean;
        revokedAt: number | null;
      }>;
    };
    expect(sessions).toHaveLength(2);
    const current = sessions.find((s) => s.isCurrent)!;
    const other = sessions.find((s) => !s.isCurrent)!;
    expect(current.id).not.toBe(other.id);

    const revoked = await app.request('/api/v1/accounts/me/sessions/revoke-others', {
      method: 'POST',
      headers: bearer(secondToken),
    });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { revoked: number }).revoked).toBe(1);

    // The first session is dead; the current one still works.
    const firstDead = await app.request('/api/v1/accounts/me', { headers: bearer(first.token) });
    expect(firstDead.status).toBe(401);
    const secondAlive = await app.request('/api/v1/accounts/me', {
      headers: bearer(secondToken),
    });
    expect(secondAlive.status).toBe(200);
  });

  it('revokes a single session by id and 404s on unknown ids', async () => {
    const { app } = await makeApp();
    const first = await register(app, 'panel_revoke_one');
    const second = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'panel_revoke_one', password: 'correct horse' }),
    });
    const secondToken = ((await second.json()) as { token: string }).token;
    const { sessions } = (await (
      await app.request('/api/v1/accounts/me/sessions', { headers: bearer(secondToken) })
    ).json()) as { sessions: Array<{ id: string; isCurrent: boolean }> };
    const other = sessions.find((s) => !s.isCurrent)!;

    const revoked = await app.request(`/api/v1/accounts/me/sessions/${other.id}`, {
      method: 'DELETE',
      headers: bearer(secondToken),
    });
    expect(revoked.status).toBe(204);

    const missing = await app.request('/api/v1/accounts/me/sessions/ses_does_not_exist', {
      method: 'DELETE',
      headers: bearer(secondToken),
    });
    expect(missing.status).toBe(404);

    const firstDead = await app.request('/api/v1/accounts/me', { headers: bearer(first.token) });
    expect(firstDead.status).toBe(401);
  });

  it('password change with revokeOthers signs out every other device', async () => {
    const { app } = await makeApp();
    const first = await register(app, 'panel_pw_revoke');
    const second = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'panel_pw_revoke', password: 'correct horse' }),
    });
    const secondToken = ((await second.json()) as { token: string }).token;

    const changed = await app.request('/api/v1/accounts/me/password', {
      method: 'POST',
      headers: { ...bearer(secondToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'correct horse',
        newPassword: 'fresh password',
        revokeOthers: true,
      }),
    });
    expect(changed.status).toBe(204);

    const firstDead = await app.request('/api/v1/accounts/me', { headers: bearer(first.token) });
    expect(firstDead.status).toBe(401);
    const secondAlive = await app.request('/api/v1/accounts/me', {
      headers: bearer(secondToken),
    });
    expect(secondAlive.status).toBe(200);
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
      headers: bearer(PLAYER_TOKEN),
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
      headers: bearer(PLAYER_TOKEN),
    });
    expect(res.status).toBe(404);
  });
});

describe('planet detail and image (player auth required)', () => {
  it('rejects unauthenticated planet detail and image with 401', async () => {
    const { app } = await makeApp();
    const detail = await app.request('/api/v1/worlds/world:1337/planets/planet:1:2:3:4');
    expect(detail.status).toBe(401);
    const image = await app.request('/api/v1/worlds/world:1337/planets/planet:1:2:3:4/image.png');
    expect(image.status).toBe(401);
  });

  it('serves a planet detail view for a real planet', async () => {
    const { app } = await makeApp();
    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { player: { homePlanet: { id: string; name: string } } };
    const res = await app.request(
      `/api/v1/worlds/world:1337/planets/${overview.player.homePlanet.id}`,
      {
        headers: bearer(PLAYER_TOKEN),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      abundance: Record<string, number>;
    };
    expect(body.id).toBe(overview.player.homePlanet.id);
    expect(body.name).toBeTruthy();
    expect(body.abundance.metal).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 for an unknown planet', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:1337/planets/planet:9:9:9:9', {
      headers: bearer(PLAYER_TOKEN),
    });
    expect(res.status).toBe(404);
  });

  it('serves a deterministic PNG image with PNG magic bytes', async () => {
    const { app } = await makeApp();
    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { player: { homePlanet: { id: string } } };
    const url = `/api/v1/worlds/world:1337/planets/${overview.player.homePlanet.id}/image.png?size=64`;
    const a = await app.request(url, { headers: bearer(PLAYER_TOKEN) });
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await a.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(a.headers.get('x-art-version')).toBeTruthy();

    const b = await app.request(url, { headers: bearer(PLAYER_TOKEN) });
    expect(Buffer.from(await b.arrayBuffer())).toEqual(bytes);
  });

  it('returns 404 for a planet image in an unknown world', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/worlds/world:9999/planets/planet:1:1:1:1/image.png', {
      headers: bearer(PLAYER_TOKEN),
    });
    expect(res.status).toBe(404);
  });
});

describe('dev tick trigger', () => {
  it('advances the world tick deterministically', async () => {
    const { app } = await makeApp();
    const before = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { tick: number };

    const res = await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tick: number; status: string };
    expect(body.tick).toBe(before.tick + 1);
    expect(body.status).toBe('completed');

    const after = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { tick: number; lastResolution: { planetStateHash: string } | null };
    expect(after.tick).toBe(before.tick + 1);
    expect(after.lastResolution?.planetStateHash).toBeTruthy();
  });
});

describe('admin dashboard', () => {
  /** Register a commander and return the session + account. */
  async function register(
    app: Awaited<ReturnType<typeof makeApp>>['app'],
    username: string,
    symbolId = 'hearth-crown',
  ): Promise<{ token: string; account: { id: string; playerId: string; username: string } }> {
    const res = await app.request('/api/v1/accounts/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct horse', symbolId }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      token: string;
      account: { id: string; playerId: string; username: string };
    };
  }

  it('gates every admin route behind the admin token', async () => {
    const { app } = await makeApp();
    for (const path of [
      '/api/v1/admin/status',
      '/api/v1/admin/worlds',
      '/api/v1/admin/players',
      '/api/v1/admin/accounts',
    ]) {
      const noToken = await app.request(path);
      expect(noToken.status).toBe(401);
      const wrongToken = await app.request(path, { headers: bearer('nope') });
      expect(wrongToken.status).toBe(401);
      const ok = await app.request(path, { headers: bearer(ADMIN_TOKEN) });
      expect(ok.status).toBe(200);
    }
  });

  it('reports status: database, worlds, players, accounts', async () => {
    const { app } = await makeApp();
    await register(app, 'dash_one');
    const res = await app.request('/api/v1/admin/status', { headers: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      db: { driver: string; tables: Array<{ name: string; rows: number }> };
      worldCount: number;
      accountCount: number;
      playerCount: number;
    };
    expect(body.db.driver).toBe('memory');
    expect(body.db.tables.some((t) => t.name === 'worlds')).toBe(true);
    expect(body.worldCount).toBe(1);
    expect(body.accountCount).toBe(1);
    expect(body.playerCount).toBe(2); // seeded dev player + registered commander
  });

  it('lists worlds with aggregate counts', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/worlds', { headers: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worlds: Array<{ id: string; seed: number; playerCount: number }>;
    };
    expect(body.worlds).toHaveLength(1);
    expect(body.worlds[0]!.id).toBe('world:1337');
    expect(body.worlds[0]!.seed).toBe(1337);
    expect(body.worlds[0]!.playerCount).toBe(1);
  });

  it('shows world detail with players, planets, and fleets', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/worlds/world:1337', {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { tick: number; playerCount: number };
      players: Array<{ playerId: string }>;
      planets: unknown[];
      fleets: unknown[];
    };
    expect(body.summary.playerCount).toBe(1);
    expect(body.players).toHaveLength(1);
    expect(body.planets.length).toBeGreaterThan(0);
    expect(body.fleets.length).toBeGreaterThan(0);
  });

  it('creates a world from a seed and resolves its tick', async () => {
    const { app } = await makeApp();
    const created = await app.request('/api/v1/admin/worlds', {
      method: 'POST',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 9_001 }),
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as { summary: { id: string; tick: number } };
    expect(detail.summary.id).toBe('world:9001');
    expect(detail.summary.tick).toBe(0);

    const ticked = await app.request('/api/v1/admin/worlds/world:9001/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(ticked.status).toBe(200);
    const resolution = (await ticked.json()) as { tick: number; status: string };
    expect(resolution.tick).toBe(1);
  });

  it('refuses to delete a world that accounts live in', async () => {
    const { app } = await makeApp();
    await register(app, 'world_guard');
    const res = await app.request('/api/v1/admin/worlds/world:1337', {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONFLICT');
  });

  it('deletes a world with no accounts', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/worlds/world:1337', {
      method: 'DELETE',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(204);
    const gone = await app.request('/api/v1/admin/worlds/world:1337', {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(gone.status).toBe(404);
  });

  it('lists players with the dev commander present', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/players', { headers: bearer(ADMIN_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      players: Array<{ playerId: string; name: string; worldId: string; fleetCount: number }>;
    };
    expect(body.players).toHaveLength(1);
    expect(body.players[0]!.worldId).toBe('world:1337');
    expect(body.players[0]!.fleetCount).toBeGreaterThan(0);
  });

  it('shows a player dossier and grants resources', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/players/player:1337', {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const dossier = (await res.json()) as {
      player: { playerId: string; name: string };
      homePlanet: { storageCap: number; resources: Record<string, number> };
      fleets: unknown[];
    };
    expect(dossier.player.name).toBeTruthy();
    expect(dossier.homePlanet.storageCap).toBeGreaterThan(0);
    const beforeMetal = dossier.homePlanet.resources.metal;

    const grant = await app.request('/api/v1/admin/players/player:1337/grant', {
      method: 'POST',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ metal: 100 }),
    });
    expect(grant.status).toBe(200);
    const granted = (await grant.json()) as { resources: Record<string, number> };
    expect(granted.resources.metal).toBe(beforeMetal + 100);
  });

  it('rejects an empty grant', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/v1/admin/players/player:1337/grant', {
      method: 'POST',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('lists accounts with session counts and opens a dossier', async () => {
    const { app } = await makeApp();
    const { account } = await register(app, 'dash_two');
    const listRes = await app.request('/api/v1/admin/accounts', { headers: bearer(ADMIN_TOKEN) });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      accounts: Array<{ id: string; username: string; activeSessionCount: number }>;
    };
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]!.username).toBe('dash_two');
    expect(list.accounts[0]!.activeSessionCount).toBe(1);

    const detailRes = await app.request(`/api/v1/admin/accounts/${account.id}`, {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { sessions: unknown[] };
    expect(detail.sessions).toHaveLength(1);
  });

  it('edits an account profile as admin', async () => {
    const { app } = await makeApp();
    const { account } = await register(app, 'dash_three');
    const res = await app.request(`/api/v1/admin/accounts/${account.id}`, {
      method: 'PATCH',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Commander' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { name: string } };
    expect(body.account.name).toBe('Renamed Commander');
  });

  it('resets a password as admin; the new password logs in', async () => {
    const { app } = await makeApp();
    const { account } = await register(app, 'dash_four');
    const res = await app.request(`/api/v1/admin/accounts/${account.id}/password`, {
      method: 'POST',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'fresh secret 99' }),
    });
    expect(res.status).toBe(204);

    const login = await app.request('/api/v1/accounts/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dash_four', password: 'fresh secret 99' }),
    });
    expect(login.status).toBe(200);
  });

  it('revokes every session on an account as admin', async () => {
    const { app } = await makeApp();
    const { token, account } = await register(app, 'dash_five');
    const res = await app.request(`/api/v1/admin/accounts/${account.id}/sessions/revoke-all`, {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: number };
    expect(body.revoked).toBe(1);

    const overview = await app.request('/api/v1/worlds/world:1337/overview', {
      headers: bearer(token),
    });
    expect(overview.status).toBe(401);
  });

  it('deletes an account and removes its commander from the world', async () => {
    const { app, engine } = await makeApp();
    const { account } = await register(app, 'dash_six');
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    expect(world!.players.some((p) => p.id === account.playerId)).toBe(true);

    const res = await app.request(`/api/v1/admin/accounts/${account.id}`, {
      method: 'DELETE',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ removePlayer: true }),
    });
    expect(res.status).toBe(204);

    const after = await engine.getWorld(worldIdFromSeed(SEED));
    expect(after!.players.some((p) => p.id === account.playerId)).toBe(false);
    const gone = await app.request(`/api/v1/admin/accounts/${account.id}`, {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(gone.status).toBe(404);
  });

  it('deleting an account with removePlayer=false keeps the commander', async () => {
    const { app, engine } = await makeApp();
    const { account } = await register(app, 'dash_seven');
    const res = await app.request(`/api/v1/admin/accounts/${account.id}`, {
      method: 'DELETE',
      headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ removePlayer: false }),
    });
    expect(res.status).toBe(204);
    const after = await engine.getWorld(worldIdFromSeed(SEED));
    expect(after!.players.some((p) => p.id === account.playerId)).toBe(true);
  });
});

describe('commands', () => {
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
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
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
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-12345678',
        expectedVersion: 1,
        submittedAt: new Date().toISOString(),
        command: { kind: 'TeleportFleet', fleetId: 'fleet:1' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_COMMAND_KIND');
  });

  it('accepts a StartBuilding command with a receipt and lists it as pending', async () => {
    const { app, engine } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-build-1',
        expectedVersion: world!.version,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      receipt: { id: string; building: string; status: string };
    };
    expect(body.receipt.building).toBe('mine');
    expect(body.receipt.status).toBe('building');

    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { pendingOrders: Array<{ id: string; building: string }> };
    expect(overview.pendingOrders).toHaveLength(1);
    expect(overview.pendingOrders[0].id).toBe(body.receipt.id);
  });

  it('rejects a StartBuilding the planet cannot afford with 400', async () => {
    const { app, engine, repository } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    // Drain the store below any build cost.
    planet.resources = { metal: 10, mineral: 10, food: 10, energy: 10 };
    await repository.saveWorld(world!);

    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-poor-1',
        expectedVersion: world!.version,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_RESOURCES');
  });

  it('rejects building on a planet the player does not own with 400 NOT_OWNER', async () => {
    const { app, engine } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const stranger = world!.planets.find((p) => p.ownerId === null)!;
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-stranger-1',
        expectedVersion: world!.version,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', planetId: stranger.id, building: 'mine' },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_OWNER');
  });

  it('rejects a stale expected version with 409', async () => {
    const { app, engine } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-stale-1',
        expectedVersion: world!.version + 5,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STALE_VERSION');
  });

  /** Home planet upgraded with a lab + shipyard and a rich store. */
  async function m2Planet(
    engine: Awaited<ReturnType<typeof makeApp>>['engine'],
    repository: Awaited<ReturnType<typeof makeApp>>['repository'],
  ) {
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1, lab: 1, shipyard: 1 };
    planet.resources = { metal: 2000, mineral: 2000, food: 2000, energy: 2000 };
    await repository.saveWorld(world!);
    return { world: world!, planet };
  }

  function commandBody(worldVersion: number, key: string, command: unknown) {
    return {
      idempotencyKey: key,
      expectedVersion: worldVersion,
      submittedAt: new Date().toISOString(),
      command,
    };
  }

  it('accepts a StartResearch command and lists it in the overview research queue', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-research-1', {
          kind: 'StartResearch',
          hostPlanetId: planet.id,
          technologyId: 'extraction-1',
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      receipt: { id: string; kind: string; status: string; technologyId: string };
    };
    expect(body.receipt.kind).toBe('research');
    expect(body.receipt.status).toBe('researching');
    expect(body.receipt.technologyId).toBe('extraction-1');

    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { research: { orders: Array<{ id: string }> } };
    expect(overview.research.orders).toHaveLength(1);
    expect(overview.research.orders[0].id).toBe(body.receipt.id);
  });

  it('rejects a StartResearch without a lab on the host planet', async () => {
    const { app, engine } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world!.version, 'key-api-research-nolab', {
          kind: 'StartResearch',
          hostPlanetId: planet.id,
          technologyId: 'extraction-1',
        }),
      ),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HOST_PLANET_REQUIRES_LAB');
  });

  it('accepts a QueueShip command and the ship lands in the local fleet next tick', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-ship-1', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'scout',
          quantity: 2,
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { receipt: { kind: string; status: string; ship: string } };
    expect(body.receipt.kind).toBe('ship');
    expect(body.receipt.status).toBe('building');
    expect(body.receipt.ship).toBe('scout');

    // Advance a tick via the dev trigger; the scout should now be in the fleet.
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { fleets: Array<{ homePlanetId: string; ships: Record<string, number> }> };
    const local = overview.fleets.find((f) => f.homePlanetId === planet.id);
    expect(local).toBeDefined();
    expect(local!.ships.scout).toBe(2);
  });

  it('rejects a ship locked behind research with SHIP_LOCKED', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-ship-locked', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'fighter',
          quantity: 1,
        }),
      ),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SHIP_LOCKED');
  });

  it('splits a fleet and reports the detachment in the overview', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    // Queue and build 3 scouts first.
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-split-0', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'scout',
          quantity: 3,
        }),
      ),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const afterBuild = await engine.getWorld(worldIdFromSeed(SEED));
    const local = afterBuild!.fleets.find((f) => f.homePlanetId === planet.id)!;

    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(afterBuild!.version, 'key-api-split-1', {
          kind: 'SplitFleet',
          fleetId: local.id,
          ships: { scout: 1 },
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      result: { op: string; fleet: { id: string; ships: Record<string, number> } };
    };
    expect(body.result.op).toBe('split');
    expect(body.result.fleet.ships.scout).toBe(1);

    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { fleets: unknown[] };
    expect(overview.fleets).toHaveLength(2);
  });

  it('sends a fleet to a coordinate and reports the flight in the overview', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-m3-arm', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'scout',
          quantity: 2,
        }),
      ),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const afterBuild = await engine.getWorld(worldIdFromSeed(SEED));
    const local = afterBuild!.fleets.find((f) => f.homePlanetId === planet.id)!;
    const destination = world.planets.find((p) => p.id !== planet.id)!.coordinate;

    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(afterBuild!.version, 'key-api-m3-send', {
          kind: 'SendFleet',
          fleetId: local.id,
          destination,
          mission: 'transport',
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      result: {
        op: string;
        fleet: { state: string; arrivalTick: number; mission: { kind: string } };
      };
    };
    expect(body.result.op).toBe('send');
    expect(body.result.fleet.state).toBe('moving');
    expect(body.result.fleet.mission.kind).toBe('transport');
    expect(body.result.fleet.arrivalTick).toBeGreaterThan(afterBuild!.tick);

    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as {
      fleets: Array<{ state: string; mission: { destination: Record<string, number> } | null }>;
    };
    const flight = overview.fleets.find((f) => f.state === 'moving');
    expect(flight).toBeDefined();
    expect(flight!.mission?.destination).toMatchObject(destination);
  });

  it('recalls a moving fleet over the API', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-m3-recall-arm', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'scout',
          quantity: 2,
        }),
      ),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const afterBuild = await engine.getWorld(worldIdFromSeed(SEED));
    const local = afterBuild!.fleets.find((f) => f.homePlanetId === planet.id)!;
    const destination = world.planets.find((p) => p.id !== planet.id)!.coordinate;
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(afterBuild!.version, 'key-api-m3-recall-send', {
          kind: 'SendFleet',
          fleetId: local.id,
          destination,
          mission: 'scout',
        }),
      ),
    });
    const inFlight = await engine.getWorld(worldIdFromSeed(SEED));

    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(inFlight!.version, 'key-api-m3-recall', {
          kind: 'RecallFleet',
          fleetId: local.id,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { op: string; fleet: { state: string; mission: { kind: string } } };
    };
    expect(body.result.op).toBe('recall');
    expect(body.result.fleet.state).toBe('returning');
    expect(body.result.fleet.mission.kind).toBe('return');
  });

  it('loads and unloads cargo over the API', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    // Build a freighter (2 ticks) for its 200-unit hold.
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-m3-cargo-arm', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'freighter',
          quantity: 1,
        }),
      ),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const after = await engine.getWorld(worldIdFromSeed(SEED));
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;

    const loaded = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(after!.version, 'key-api-m3-load', {
          kind: 'LoadCargo',
          fleetId: local.id,
          resources: { metal: 150 },
        }),
      ),
    });
    expect(loaded.status).toBe(200);
    const loadedBody = (await loaded.json()) as {
      result: { op: string; fleet: { cargo: Record<string, number> } };
    };
    expect(loadedBody.result.op).toBe('load');
    expect(loadedBody.result.fleet.cargo.metal).toBe(150);

    const unloaded = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody((await engine.getWorld(worldIdFromSeed(SEED)))!.version, 'key-api-m3-unload', {
          kind: 'UnloadCargo',
          fleetId: local.id,
          resources: { metal: 150 },
        }),
      ),
    });
    expect(unloaded.status).toBe(200);
    const unloadedBody = (await unloaded.json()) as {
      result: { op: string; fleet: { cargo: Record<string, number> } };
    };
    expect(unloadedBody.result.op).toBe('unload');
    expect(unloadedBody.result.fleet.cargo.metal).toBe(0);
  });

  it('previews a fleet route before sending (deterministic ETA)', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-m3-route-arm', {
          kind: 'QueueShip',
          planetId: planet.id,
          ship: 'scout',
          quantity: 1,
        }),
      ),
    });
    await app.request('/api/v1/dev/worlds/world:1337/tick', {
      method: 'POST',
      headers: bearer(ADMIN_TOKEN),
    });
    const after = await engine.getWorld(worldIdFromSeed(SEED));
    const local = after!.fleets.find((f) => f.homePlanetId === planet.id)!;
    const destination = world.planets.find((p) => p.id !== planet.id)!.coordinate;
    const to = `${destination.galaxy}:${destination.sector}:${destination.system}:${destination.planet}`;

    const res = await app.request(
      `/api/v1/worlds/world:1337/fleets/${encodeURIComponent(local.id)}/route?to=${to}`,
      { headers: bearer(PLAYER_TOKEN) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      distance: number;
      travelTicks: number;
      arrivalTick: number;
    };
    expect(body.travelTicks).toBeGreaterThanOrEqual(1);
    expect(body.arrivalTick).toBe(after!.tick + body.travelTicks);
  });

  it('rejects sending an idle empty fleet and malformed movement commands', async () => {
    const { app, engine, repository } = await makeApp();
    const { world, planet } = await m2Planet(engine, repository);
    // The home local fleet has no ships yet.
    const world0 = await engine.getWorld(worldIdFromSeed(SEED));
    const local = world0!.fleets.find((f) => f.homePlanetId === planet.id)!;

    const empty = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world0!.version, 'key-api-m3-empty', {
          kind: 'SendFleet',
          fleetId: local.id,
          destination: { galaxy: 1, sector: 1, system: 1, planet: 2 },
          mission: 'transport',
        }),
      ),
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as { error: { code: string } };
    expect(emptyBody.error.code).toBe('EMPTY_FLEET');

    const malformed = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world.version, 'key-api-m3-malformed', {
          kind: 'SendFleet',
          fleetId: local.id,
          destination: { galaxy: 0, sector: 1, system: 1, planet: 2 },
          mission: 'teleport',
        }),
      ),
    });
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as { error: { code: string } };
    expect(malformedBody.error.code).toBe('VALIDATION_ERROR');

    const routeBad = await app.request(
      `/api/v1/worlds/world:1337/fleets/${encodeURIComponent(local.id)}/route?to=not-a-coordinate`,
      { headers: bearer(PLAYER_TOKEN) },
    );
    expect(routeBad.status).toBe(400);
  });

  it('runs a scan over the API and shows the intel in the overview', async () => {
    const { app, engine, repository } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    // Arm the home planet with a Scanner Array and find the nearest target.
    planet.buildings = { settlement: 1, scanner: 3 };
    const target = world!.planets
      .filter((p) => p.id !== planet.id)
      .map((p) => ({ p, d: coordinateDistance(world!.seed, planet.coordinate, p.coordinate) }))
      .sort((a, b) => a.d - b.d)[0]!.p;
    await repository.saveWorld(world!);

    const res = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world!.version, 'key-api-scan-1', {
          kind: 'RunScan',
          sourcePlanetId: planet.id,
          target: target.coordinate,
          scan: 'basic',
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      report: { idempotencyKey: string; kind: string; revealed: { population: number } };
    };
    expect(body.report.idempotencyKey).toBe('key-api-scan-1');
    expect(body.report.kind).toBe('basic');

    const overview = (await (
      await app.request('/api/v1/worlds/world:1337/overview', { headers: bearer(PLAYER_TOKEN) })
    ).json()) as { intel: { planets: Array<{ coordinate: Record<string, number> }> } };
    expect(overview.intel.planets).toHaveLength(1);
    expect(overview.intel.planets[0].coordinate).toMatchObject(target.coordinate);
  });

  it('rejects a scan without a Scanner Array and an out-of-range scan', async () => {
    const { app, engine, repository } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1 }; // no scanner
    await repository.saveWorld(world!);

    const noArray = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world!.version, 'key-api-scan-noarr', {
          kind: 'RunScan',
          sourcePlanetId: planet.id,
          target: { galaxy: 1, sector: 1, system: 1, planet: 1 },
          scan: 'basic',
        }),
      ),
    });
    expect(noArray.status).toBe(400);
    const noArrayBody = (await noArray.json()) as { error: { code: string } };
    expect(noArrayBody.error.code).toBe('SCANNER_REQUIRED');

    // With an array present, a far target is rejected for range instead.
    planet.buildings = { settlement: 1, scanner: 1 };
    await repository.saveWorld(world!);
    const far = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify(
        commandBody(world!.version, 'key-api-scan-far', {
          kind: 'RunScan',
          sourcePlanetId: planet.id,
          target: { galaxy: 8, sector: 8, system: 8, planet: 6 },
          scan: 'basic',
        }),
      ),
    });
    expect(far.status).toBe(400);
    const farBody = (await far.json()) as { error: { code: string } };
    expect(farBody.error.code).toBe('OUT_OF_RANGE');
  });

  it('previews scan reach before committing', async () => {
    const { app, engine, repository } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    planet.buildings = { settlement: 1, scanner: 3 };
    const nearest = world!.planets
      .filter((p) => p.id !== planet.id)
      .map((p) => ({ p, d: coordinateDistance(world!.seed, planet.coordinate, p.coordinate) }))
      .sort((a, b) => a.d - b.d)[0]!.p;
    await repository.saveWorld(world!);
    const to = `${nearest.coordinate.galaxy}:${nearest.coordinate.sector}:${nearest.coordinate.system}:${nearest.coordinate.planet}`;

    const res = await app.request(
      `/api/v1/worlds/world:1337/scans/preview?source=${encodeURIComponent(planet.id)}&to=${to}`,
      { headers: bearer(PLAYER_TOKEN) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { range: number; distance: number; inRange: boolean };
    expect(body.range).toBe(3600); // base 1500 + 3 × 700
    expect(body.distance).toBeGreaterThan(0);
    expect(body.inRange).toBe(true);

    const bad = await app.request(
      `/api/v1/worlds/world:1337/scans/preview?source=${encodeURIComponent(planet.id)}&to=not-a-coordinate`,
      { headers: bearer(PLAYER_TOKEN) },
    );
    expect(bad.status).toBe(400);
  });

  it('cancels a build order and refunds the reserved resources', async () => {
    const { app, engine } = await makeApp();
    const world = await engine.getWorld(worldIdFromSeed(SEED));
    const planet = world!.planets.find((p) => p.id === world!.players[0].homePlanetId)!;
    const submitted = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-cancel-1',
        expectedVersion: world!.version,
        submittedAt: new Date().toISOString(),
        command: { kind: 'StartBuilding', planetId: planet.id, building: 'mine' },
      }),
    });
    const receipt = ((await submitted.json()) as { receipt: { id: string } }).receipt;
    const afterBuild = await engine.getWorld(worldIdFromSeed(SEED));

    const cancelled = await app.request('/api/v1/worlds/world:1337/commands', {
      method: 'POST',
      headers: { ...bearer(PLAYER_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'key-api-cancel-2',
        expectedVersion: afterBuild!.version,
        submittedAt: new Date().toISOString(),
        command: { kind: 'CancelConstruction', orderId: receipt.id },
      }),
    });
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as { receipt: { status: string } };
    expect(body.receipt.status).toBe('cancelled');

    const final = await engine.getWorld(worldIdFromSeed(SEED));
    const home = final!.planets.find((p) => p.id === planet.id)!;
    expect(home.resources.metal).toBe(100); // fully refunded
  });
});
