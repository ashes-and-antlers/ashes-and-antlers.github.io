import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { PNG } from 'pngjs';
import { z } from 'zod';
import {
  AdminCreateWorldSchema,
  AdminDeleteAccountSchema,
  AdminSetPasswordSchema,
  AdminUpdateAccountSchema,
  apiError,
  CancelConstructionCommandSchema,
  CancelResearchCommandSchema,
  CancelShipOrderCommandSchema,
  ChangePasswordSchema,
  CommandEnvelopeSchema,
  GrantResourcesSchema,
  LoadCargoCommandSchema,
  LoginSchema,
  parseCoordinate,
  QueueShipCommandSchema,
  RecallFleetCommandSchema,
  RegisterSchema,
  RunScanCommandSchema,
  SendFleetCommandSchema,
  SplitFleetCommandSchema,
  StartBuildingCommandSchema,
  StartResearchCommandSchema,
  TransferFleetCommandSchema,
  UnloadCargoCommandSchema,
  UpdateProfileSchema,
  type AccountSessionView,
  type AccountView,
  type AdminAccountDetail,
  type AdminAccountSummary,
  type AdminPlayerSummary,
  type AdminWorldSummary,
  type ApiErrorCode,
  type FleetId,
  type OrderId,
  type PlanetId,
  type PlayerId,
  type SessionResponse,
  type SymbolId,
  type TechnologyId,
  type WorldId,
} from '@ashes/contracts';
import { ART_VERSION, EMBLEMS, FACTIONS, PLANET_ART } from '@ashes/content';
import { renderPlanetArt } from '@ashes/domain';
import {
  hashSessionToken,
  type Account,
  type AccountRepository,
  type DatabaseAdmin,
  type TickEngine,
} from '@ashes/db';

const scrypt = promisify(scryptCb);

/**
 * A resolved player identity: the acting commander and their world. Player
 * routes require one; admin routes require the admin token instead.
 */
export type PlayerIdentity = {
  playerId: PlayerId;
  worldId: WorldId;
  accountId?: string;
  sessionToken: string;
};

export type AuthContext = {
  /** Token required for dev/admin endpoints (world creation, tick trigger). */
  adminToken: string;
  /** Session lifetime for newly issued account sessions. */
  sessionTtlMs?: number;
  /**
   * Resolve a bearer token to a player identity: account tokens from the
   * accounts table, plus the seeded dev player's token. Null means the token
   * is unknown — the route answers 401.
   */
  resolvePlayerIdentity: (token: string) => Promise<PlayerIdentity | null>;
};

export const CreateWorldSchema = z.object({
  seed: z.number().int().nonnegative(),
});

type AppEnv = { Variables: { identity: PlayerIdentity } };

export function createApi(
  engine: TickEngine,
  auth: AuthContext,
  accounts: AccountRepository,
  worldId: WorldId,
  databaseAdmin: DatabaseAdmin,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', cors({ origin: '*' }));

  app.get('/healthz', (c) => c.json({ ok: true, service: 'ashes-api' }));

  // -- public: faction catalog + account registration/login ----------------

  app.get('/api/v1/factions', (c) =>
    c.json(
      FACTIONS.map((faction) => ({
        id: faction.id,
        name: faction.name,
        profile: faction.profile,
      })),
      200,
    ),
  );

  /** The emblem bank every commander picks from (public catalog). */
  app.get('/api/v1/emblems', (c) => c.json(EMBLEMS, 200));

  app.post('/api/v1/accounts/register', async (c) => {
    const body = await readJson(c);
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed registration', parsed.error.issues),
        400,
      );
    }
    const username = parsed.data.username.trim().toLowerCase();
    const { password } = parsed.data;
    const name = parsed.data.name?.trim() || username;
    const symbolId = parsed.data.symbolId as SymbolId;

    // The emblem must come from the content bank. The faction needs no check:
    // it is assigned server-side (the least-populated power, for balance).
    const symbol = EMBLEMS.find((s) => s.id === symbolId);
    if (!symbol) {
      return c.json(apiError('VALIDATION_ERROR', `'${symbolId}' is not a known emblem`), 400);
    }

    const existing = await accounts.getAccountByUsername(username);
    if (existing) {
      return c.json(apiError('CONFLICT', `username '${username}' is already taken`), 409);
    }

    const accountId = `acc_${randomBytes(8).toString('hex')}`;
    const playerId = `player:${accountId}` as PlayerId;
    const passwordHash = await hashPassword(password);

    let spawned;
    try {
      spawned = await engine.spawnPlayer(worldId, {
        playerId,
        name,
        // Player state predates account sessions and keeps this field only
        // for legacy world compatibility; authentication uses account_sessions.
        token: '',
      });
    } catch (err) {
      return c.json(engine.toApiError(err), 500);
    }

    const account: Account = {
      id: accountId,
      username,
      passwordHash,
      worldId,
      playerId,
      name,
      factionId: spawned.player.factionId,
      symbolId,
      homePlanetId: spawned.homePlanet.id,
      createdAt: Date.now(),
    };
    await accounts.createAccount(account);
    const sessionToken = await issueSession(accounts, account.id, c, auth.sessionTtlMs);

    return c.json(sessionResponse(account, sessionToken), 201);
  });

  app.post('/api/v1/accounts/login', async (c) => {
    const body = await readJson(c);
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed login', parsed.error.issues), 400);
    }
    const username = parsed.data.username.trim().toLowerCase();
    const account = await accounts.getAccountByUsername(username);
    // One indistinguishable 401: never reveal whether the username or the
    // password was wrong.
    if (!account || !(await verifyPassword(parsed.data.password, account.passwordHash))) {
      return c.json(apiError('UNAUTHENTICATED', 'invalid username or password'), 401);
    }

    // The account can outlive its player: when the world was re-derived from
    // the seed (content bump), spawned players are wiped while account rows
    // survive. Re-spawn the commander on login instead of issuing a session
    // whose every world request 404s and strands the browser on the door.
    let refreshed = account;
    try {
      const spawned = await engine.ensurePlayer(account.worldId, {
        playerId: account.playerId,
        name: account.name,
        factionId: account.factionId,
        token: '',
      });
      if (spawned.reSpawned || spawned.homePlanet.id !== account.homePlanetId) {
        await accounts.updateHomePlanet(account.id, spawned.homePlanet.id);
        refreshed = { ...account, homePlanetId: spawned.homePlanet.id };
      }
    } catch (err) {
      return c.json(engine.toApiError(err), 500);
    }

    const token = await issueSession(accounts, account.id, c, auth.sessionTtlMs);
    return c.json(sessionResponse(refreshed, token), 200);
  });

  app.get('/api/v1/accounts/me', playerOnly(auth), async (c) => {
    const identity = c.get('identity');
    if (identity.accountId === undefined) {
      return c.json(apiError('NOT_FOUND', 'no account for this identity'), 404);
    }
    const account = await accounts.getAccountById(identity.accountId);
    if (!account) {
      return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    }
    return c.json({ account: toAccountView(account) }, 200);
  });

  app.post('/api/v1/accounts/logout', playerOnly(auth), async (c) => {
    await accounts.revokeSession(c.get('identity').sessionToken, Date.now());
    return c.body(null, 204);
  });

  // -- account control panel: profile, security, and sessions ---------------

  /**
   * Update the commander's profile: display name and/or emblem. The name is
   * written to both authoritative stores (the account row and the player
   * inside the world aggregate, under the world lock); the emblem is
   * presentation-only identity and lives on the account alone.
   */
  app.patch('/api/v1/accounts/me', playerOnly(auth), async (c) => {
    const account = await accountOf(c, accounts);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);

    const body = await readJson(c);
    const parsed = UpdateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed profile', parsed.error.issues), 400);
    }
    const name = parsed.data.name?.trim();
    const symbolId = parsed.data.symbolId as SymbolId | undefined;
    if (name !== undefined && name === '') {
      return c.json(apiError('VALIDATION_ERROR', 'name cannot be empty'), 400);
    }
    if (symbolId !== undefined && !EMBLEMS.some((s) => s.id === symbolId)) {
      return c.json(apiError('VALIDATION_ERROR', `'${symbolId}' is not a known emblem`), 400);
    }

    if (name !== undefined && name !== account.name) {
      try {
        await engine.renamePlayer(account.worldId, account.playerId, name);
      } catch (err) {
        return c.json(engine.toApiError(err), 500);
      }
    }
    const updated = await accounts.updateAccountProfile(account.id, {
      ...(name === undefined ? {} : { name }),
      ...(symbolId === undefined ? {} : { symbolId }),
    });
    if (!updated) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    return c.json({ account: toAccountView(updated) }, 200);
  });

  /**
   * Change the account password. The current password must verify (one
   * indistinguishable rejection, like login); the new password is hashed with
   * a fresh salt. With `revokeOthers` every other active session is revoked
   * — the current session (this device) stays signed in.
   */
  app.post('/api/v1/accounts/me/password', playerOnly(auth), async (c) => {
    const account = await accountOf(c, accounts);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);

    const body = await readJson(c);
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed request', parsed.error.issues), 400);
    }
    if (!(await verifyPassword(parsed.data.currentPassword, account.passwordHash))) {
      return c.json(apiError('UNAUTHENTICATED', 'current password is incorrect'), 401);
    }

    await accounts.updatePassword(account.id, await hashPassword(parsed.data.newPassword));
    if (parsed.data.revokeOthers === true) {
      await revokeOtherSessions(accounts, account.id, c.get('identity').sessionToken);
    }
    return c.body(null, 204);
  });

  /** Every session on the account, newest first, with the current one marked. */
  app.get('/api/v1/accounts/me/sessions', playerOnly(auth), async (c) => {
    const account = await accountOf(c, accounts);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const sessions: AccountSessionView[] = await accounts.listSessions(
      account.id,
      hashSessionToken(c.get('identity').sessionToken),
    );
    return c.json({ sessions }, 200);
  });

  /** Revoke one session (own account only); unknown/already-revoked → 404. */
  app.delete('/api/v1/accounts/me/sessions/:sessionId', playerOnly(auth), async (c) => {
    const account = await accountOf(c, accounts);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const sessionId = c.req.param('sessionId');
    const revoked = await accounts.revokeSessionById(account.id, sessionId, Date.now());
    if (!revoked) return c.json(apiError('NOT_FOUND', 'session not found'), 404);
    return c.body(null, 204);
  });

  /** Sign every other device out; this session stays. */
  app.post('/api/v1/accounts/me/sessions/revoke-others', playerOnly(auth), async (c) => {
    const account = await accountOf(c, accounts);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const revoked = await revokeOtherSessions(accounts, account.id, c.get('identity').sessionToken);
    return c.json({ revoked }, 200);
  });

  // -- admin dashboard (M4): game, database, and user management ------------
  // Every route requires the admin bearer token. Game mutations go through
  // the engine under the world lock; account mutations through the account
  // repository; database reads are read-only introspection.

  app.get('/api/v1/admin/status', adminOnly(auth.adminToken), async (c) => {
    const [db, worlds, accountRows] = await Promise.all([
      databaseAdmin.getStatus(),
      engine.listWorlds(),
      accounts.listAccounts(),
    ]);
    return c.json(
      {
        db,
        worldCount: worlds.length,
        accountCount: accountRows.length,
        playerCount: worlds.reduce((sum, w) => sum + w.players.length, 0),
        tickCount: worlds.reduce((sum, w) => sum + w.tick, 0),
      },
      200,
    );
  });

  app.get('/api/v1/admin/worlds', adminOnly(auth.adminToken), async (c) => {
    const worlds = await engine.listWorlds();
    const summaries: AdminWorldSummary[] = [];
    for (const world of worlds) {
      const detail = await engine.getWorldAdminDetail(world.id);
      summaries.push(detail.summary);
    }
    return c.json({ worlds: summaries }, 200);
  });

  app.get('/api/v1/admin/worlds/:worldId', adminOnly(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    try {
      return c.json(await engine.getWorldAdminDetail(worldId), 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 500);
    }
  });

  /** Newest-first immutable resolution history for one world (?limit=). */
  app.get('/api/v1/admin/worlds/:worldId/resolutions', adminOnly(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    const raw = c.req.query('limit');
    const limit = raw === undefined ? 20 : Number(raw);
    const resolutions = await databaseAdmin.listResolutions(
      worldId,
      Number.isFinite(limit) ? limit : 20,
    );
    return c.json({ resolutions }, 200);
  });

  app.post('/api/v1/admin/worlds', adminOnly(auth.adminToken), async (c) => {
    const body = await readJson(c);
    const parsed = AdminCreateWorldSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed request body', parsed.error.issues),
        400,
      );
    }
    const world = await engine.createWorld({ seed: parsed.data.seed });
    const detail = await engine.getWorldAdminDetail(world.id);
    return c.json(detail, 201);
  });

  /** Manually resolve the world's next tick (the operator's tick trigger). */
  app.post('/api/v1/admin/worlds/:worldId/tick', adminOnly(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    try {
      const resolution = await engine.resolveNextTick(worldId);
      return c.json(
        {
          tick: resolution.tick,
          status: resolution.status,
          planetStateHash: resolution.planetStateHash,
          resolvedAt: resolution.resolvedAt,
        },
        200,
      );
    } catch (err) {
      return c.json(engine.toApiError(err), 500);
    }
  });

  /**
   * Delete a world. Refused (409) when registered accounts reference it —
   * deleting their home world would strand every account in it. Worlds with
   * no accounts (the seeded dev world) can be dropped freely; the engine
   * re-derives them from the seed on demand.
   */
  app.delete('/api/v1/admin/worlds/:worldId', adminOnly(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    const world = await engine.getWorld(worldId);
    if (!world) return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    const all = await accounts.listAccounts();
    const referencing = all.filter((a) => a.worldId === worldId);
    if (referencing.length > 0) {
      return c.json(
        apiError(
          'CONFLICT',
          `world ${worldId} cannot be deleted: ${referencing.length} account(s) live here`,
          { accountIds: referencing.map((a) => a.id) },
        ),
        409,
      );
    }
    await engine.deleteWorld(worldId);
    return c.body(null, 204);
  });

  app.get('/api/v1/admin/players', adminOnly(auth.adminToken), async (c) => {
    const all = await accounts.listAccounts();
    const rows = await engine.listPlayers();
    const summaries: AdminPlayerSummary[] = rows.map(({ worldId, player }) => {
      const account = all.find((a) => a.playerId === player.id);
      return {
        playerId: player.id,
        name: player.name,
        factionId: player.factionId,
        worldId,
        homePlanetId: player.homePlanetId,
        // Legacy aggregates may predate the M2/M3 player fields; report 0.
        technologyCount: (player.technologies ?? []).length,
        fleetCount: 0,
        scanReportCount: (player.scanReports ?? []).length,
        ...(account ? { accountId: account.id, username: account.username } : {}),
      };
    });
    // Fleet counts live in the aggregate; enrich each world's players once.
    for (const world of await engine.listWorlds()) {
      const detail = await engine.getWorldAdminDetail(world.id);
      for (const row of detail.players) {
        const summary = summaries.find((s) => s.playerId === row.playerId);
        if (summary) summary.fleetCount = row.fleetCount;
      }
    }
    return c.json({ players: summaries }, 200);
  });

  app.get('/api/v1/admin/players/:playerId', adminOnly(auth.adminToken), async (c) => {
    const playerId = c.req.param('playerId') as PlayerId;
    try {
      const { worldId, detail } = await engine.getPlayerAdminDetail(playerId);
      const account = await accounts.getAccountByPlayerId(playerId);
      if (account) {
        detail.account = {
          id: account.id,
          username: account.username,
          name: account.name,
          symbolId: account.symbolId,
          createdAt: account.createdAt,
        };
      }
      void worldId;
      return c.json(detail, 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 500);
    }
  });

  /** Grant resources to a player's home planet (debug/QA tool). */
  app.post('/api/v1/admin/players/:playerId/grant', adminOnly(auth.adminToken), async (c) => {
    const playerId = c.req.param('playerId') as PlayerId;
    const worldId = await worldOfPlayer(engine, playerId);
    if (!worldId) {
      return c.json(apiError('NOT_FOUND', `player ${playerId} not found in any world`), 404);
    }
    const body = await readJson(c);
    const parsed = GrantResourcesSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed grant', parsed.error.issues), 400);
    }
    // Strip undefined keys: with exactOptionalPropertyTypes, a partial grant
    // may only carry the keys the operator actually set.
    const grant: Partial<Record<'metal' | 'mineral' | 'food' | 'energy', number>> = {};
    for (const key of ['metal', 'mineral', 'food', 'energy'] as const) {
      const value = parsed.data[key];
      if (value !== undefined) grant[key] = value;
    }
    try {
      const result = await engine.grantResources(worldId, playerId, grant);
      return c.json(result, 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 400);
    }
  });

  /** Rename a commander (both the player and its linked account). */
  app.post('/api/v1/admin/players/:playerId/rename', adminOnly(auth.adminToken), async (c) => {
    const playerId = c.req.param('playerId') as PlayerId;
    const worldId = await worldOfPlayer(engine, playerId);
    if (!worldId) {
      return c.json(apiError('NOT_FOUND', `player ${playerId} not found in any world`), 404);
    }
    const body = await readJson(c);
    const parsed = UpdateProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'a name is required', parsed.error.issues), 400);
    }
    if (parsed.data.name === undefined) {
      return c.json(apiError('VALIDATION_ERROR', 'a name is required'), 400);
    }
    const name = parsed.data.name.trim();
    if (name === '') {
      return c.json(apiError('VALIDATION_ERROR', 'name cannot be empty'), 400);
    }
    try {
      await engine.renamePlayer(worldId, playerId, name);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 500);
    }
    const account = await accounts.getAccountByPlayerId(playerId);
    if (account) await accounts.updateAccountProfile(account.id, { name });
    return c.body(null, 204);
  });

  app.get('/api/v1/admin/accounts', adminOnly(auth.adminToken), async (c) => {
    const all = await accounts.listAccounts();
    const now = Date.now();
    const summaries: AdminAccountSummary[] = [];
    for (const account of all) {
      const sessions = await accounts.listSessions(account.id, '');
      const active = sessions.filter((s) => s.revokedAt === null && s.expiresAt > now);
      const lastSeen = sessions.reduce((max, s) => Math.max(max, s.lastSeenAt), account.createdAt);
      summaries.push({
        ...accountSummaryBase(account),
        activeSessionCount: active.length,
        lastSeenAt: sessions.length > 0 ? lastSeen : null,
      });
    }
    return c.json({ accounts: summaries }, 200);
  });

  app.get('/api/v1/admin/accounts/:accountId', adminOnly(auth.adminToken), async (c) => {
    const accountId = c.req.param('accountId');
    const account = await accounts.getAccountById(accountId);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const detail = await adminAccountDetail(accounts, account);
    return c.json(detail, 200);
  });

  /** Admin profile edit: display name and/or emblem (validated against content). */
  app.patch('/api/v1/admin/accounts/:accountId', adminOnly(auth.adminToken), async (c) => {
    const accountId = c.req.param('accountId');
    const account = await accounts.getAccountById(accountId);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const body = await readJson(c);
    const parsed = AdminUpdateAccountSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed profile', parsed.error.issues), 400);
    }
    const name = parsed.data.name?.trim();
    if (name !== undefined && name === '') {
      return c.json(apiError('VALIDATION_ERROR', 'name cannot be empty'), 400);
    }
    if (parsed.data.symbolId !== undefined && !EMBLEMS.some((s) => s.id === parsed.data.symbolId)) {
      return c.json(
        apiError('VALIDATION_ERROR', `'${parsed.data.symbolId}' is not a known emblem`),
        400,
      );
    }
    if (name !== undefined && name !== account.name) {
      try {
        await engine.renamePlayer(account.worldId, account.playerId, name);
      } catch (err) {
        return c.json(engine.toApiError(err), 500);
      }
    }
    const updated = await accounts.updateAccountProfile(account.id, {
      ...(name === undefined ? {} : { name }),
      ...(parsed.data.symbolId === undefined ? {} : { symbolId: parsed.data.symbolId as SymbolId }),
    });
    if (!updated) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const detail = await adminAccountDetail(accounts, updated);
    return c.json(detail, 200);
  });

  /** Admin password reset; optionally signs every session out. */
  app.post('/api/v1/admin/accounts/:accountId/password', adminOnly(auth.adminToken), async (c) => {
    const accountId = c.req.param('accountId');
    const account = await accounts.getAccountById(accountId);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const body = await readJson(c);
    const parsed = AdminSetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed request', parsed.error.issues), 400);
    }
    await accounts.updatePassword(account.id, await hashPassword(parsed.data.newPassword));
    if (parsed.data.revokeSessions === true) {
      await accounts.revokeAllSessions(account.id, Date.now());
    }
    return c.body(null, 204);
  });

  /** Sign every session on an account out (admin). */
  app.post(
    '/api/v1/admin/accounts/:accountId/sessions/revoke-all',
    adminOnly(auth.adminToken),
    async (c) => {
      const accountId = c.req.param('accountId');
      const account = await accounts.getAccountById(accountId);
      if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
      const revoked = await accounts.revokeAllSessions(account.id, Date.now());
      return c.json({ revoked }, 200);
    },
  );

  /** Revoke one session on an account (admin). */
  app.delete(
    '/api/v1/admin/accounts/:accountId/sessions/:sessionId',
    adminOnly(auth.adminToken),
    async (c) => {
      const accountId = c.req.param('accountId');
      const sessionId = c.req.param('sessionId');
      const account = await accounts.getAccountById(accountId);
      if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
      const revoked = await accounts.revokeSessionById(account.id, sessionId, Date.now());
      if (!revoked) return c.json(apiError('NOT_FOUND', 'session not found'), 404);
      return c.body(null, 204);
    },
  );

  /**
   * Delete an account. With `removePlayer` (default true) the commander is
   * also removed from the world aggregate — player, fleets, and ownership —
   * keeping the world consistent. Sessions cascade with the account row.
   */
  app.delete('/api/v1/admin/accounts/:accountId', adminOnly(auth.adminToken), async (c) => {
    const accountId = c.req.param('accountId');
    const account = await accounts.getAccountById(accountId);
    if (!account) return c.json(apiError('NOT_FOUND', 'account not found'), 404);
    const body = await readJson(c);
    const parsed = AdminDeleteAccountSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(apiError('VALIDATION_ERROR', 'malformed request', parsed.error.issues), 400);
    }
    if (parsed.data.removePlayer !== false) {
      try {
        await engine.removePlayer(account.worldId, account.playerId);
      } catch (err) {
        const mapped = engine.toApiError(err);
        if (mapped.error.code !== 'NOT_FOUND') {
          return c.json(mapped, 500);
        }
        // The player is already gone (e.g. the world was re-derived); the
        // account itself can still be deleted.
      }
    }
    await accounts.deleteAccount(account.id);
    return c.body(null, 204);
  });

  // -- dev/admin: world creation + tick trigger ---------------------------

  app.post('/api/v1/dev/worlds', adminOnly(auth.adminToken), async (c) => {
    const body = await readJson(c);
    const parsed = CreateWorldSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed request body', parsed.error.issues),
        400,
      );
    }
    const world = await engine.createWorld({
      seed: parsed.data.seed,
    });
    return c.json(await engine.getWorldView(world.id), 200);
  });

  app.post('/api/v1/dev/worlds/:worldId/tick', adminOnly(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    try {
      const resolution = await engine.resolveNextTick(worldId);
      return c.json(
        {
          tick: resolution.tick,
          seed: resolution.seed,
          planetStateHash: resolution.planetStateHash,
          resolvedAt: resolution.resolvedAt,
          status: resolution.status,
        },
        200,
      );
    } catch (err) {
      return c.json(engine.toApiError(err), 500);
    }
  });

  // -- player-facing: overview, planets, commands -------------------------

  app.get('/api/v1/worlds/:worldId/overview', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    try {
      return c.json(await engine.getWorldView(worldId, c.get('identity').playerId), 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 500);
    }
  });

  app.get('/api/v1/worlds/:worldId/planets', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    const view = await engine.getWorldView(worldId, c.get('identity').playerId);
    return c.json({ planets: view.planets }, 200);
  });

  app.get('/api/v1/worlds/:worldId/galaxy', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    return c.json(await engine.getGalaxyView(worldId, c.get('identity').playerId), 200);
  });

  app.get('/api/v1/worlds/:worldId/planets/:planetId', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    const planetId = c.req.param('planetId') as PlanetId;
    try {
      return c.json(await engine.getPlanetView(worldId, planetId), 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, mapped.error.code === 'NOT_FOUND' ? 404 : 500);
    }
  });

  /**
   * Scan reach preview (M3): a source planet's array range versus the
   * distance to a target, so the scan form's reach indicator always matches
   * the command's resolution. Read-only; answered by the engine.
   */
  app.get('/api/v1/worlds/:worldId/scans/preview', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    const source = c.req.query('source');
    const to = c.req.query('to');
    if (source === undefined || to === undefined) {
      return c.json(
        apiError('VALIDATION_ERROR', 'missing ?source=planetId&to=galaxy:sector:system:planet'),
        400,
      );
    }
    const destination = parseCoordinate(to);
    if (!destination) {
      return c.json(
        apiError('VALIDATION_ERROR', `'${to}' is not a galaxy:sector:system:planet coordinate`),
        400,
      );
    }
    try {
      return c.json(await engine.getScanPreview(worldId, source as PlanetId, destination), 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      if (mapped.error.code === 'NOT_FOUND') return c.json(mapped, 404);
      return c.json(mapped, 400);
    }
  });

  /**
   * Fleet route preview (M3): deterministic travel plan for sending a fleet
   * to a destination — distance, travel ticks, arrival tick. Read-only, so
   * the send form's ETA always matches what the engine will resolve. The
   * destination is a `to` query parameter in `galaxy:sector:system:planet`
   * form; malformed or out-of-world coordinates answer 400.
   */
  app.get('/api/v1/worlds/:worldId/fleets/:fleetId/route', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    const fleetId = c.req.param('fleetId') as FleetId;
    const to = c.req.query('to');
    if (to === undefined) {
      return c.json(apiError('VALIDATION_ERROR', 'missing ?to=galaxy:sector:system:planet'), 400);
    }
    const destination = parseCoordinate(to);
    if (!destination) {
      return c.json(
        apiError('VALIDATION_ERROR', `'${to}' is not a galaxy:sector:system:planet coordinate`),
        400,
      );
    }
    try {
      return c.json(await engine.getFleetRoute(worldId, fleetId, destination), 200);
    } catch (err) {
      const mapped = engine.toApiError(err);
      if (mapped.error.code === 'NOT_FOUND') return c.json(mapped, 404);
      return c.json(mapped, 400);
    }
  });

  /**
   * Pre-rendered planet portrait (PNG). Deterministic per planet id +
   * abundance (renderPlanetArt), cached in memory keyed by ART_VERSION so a
   * palette change re-renders but a page refresh never does. The image is
   * immutable for the lifetime of the art version.
   */
  const planetImageCache = new Map<string, Buffer>();
  const PLANET_IMAGE_CACHE_LIMIT = 256;

  app.get(
    '/api/v1/worlds/:worldId/planets/:planetId/image.png',
    worldPlayerOnly(auth),
    async (c) => {
      const worldId = c.req.param('worldId') as WorldId;
      const planetId = c.req.param('planetId') as PlanetId;
      let view;
      try {
        view = await engine.getPlanetView(worldId, planetId);
      } catch (err) {
        return c.json(engine.toApiError(err), 404);
      }
      const size = parseImageSize(c.req.query('size'));
      const cacheKey = `${worldId}:${view.id}:${ART_VERSION}:${size}`;
      let png = planetImageCache.get(cacheKey);
      if (!png) {
        const image = renderPlanetArt(view, size);
        png = encodePng(image.width, image.height, image.data);
        planetImageCache.set(cacheKey, png);
        if (planetImageCache.size > PLANET_IMAGE_CACHE_LIMIT) {
          const oldest = planetImageCache.keys().next().value as string;
          planetImageCache.delete(oldest);
        }
      }
      return new Response(png, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-art-version': ART_VERSION,
        },
      });
    },
  );

  /**
   * M1 command submission: the envelope is validated strictly (idempotency
   * key, expected version, submitted timestamp, command shape), then the kind
   * is dispatched to the engine, which validates against the authoritative
   * state under the world lock and returns an immutable receipt. Unknown
   * kinds still answer UNSUPPORTED_COMMAND_KIND.
   */
  app.post('/api/v1/worlds/:worldId/commands', worldPlayerOnly(auth), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!(await engine.getWorld(worldId))) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    const body = await readJson(c);
    const envelope = CommandEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed command envelope', envelope.error.issues),
        400,
      );
    }
    const { idempotencyKey, expectedVersion } = envelope.data;
    const command = envelope.data.command;
    const identity = c.get('identity');

    try {
      if (command.kind === 'StartBuilding') {
        const parsed = StartBuildingCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed StartBuilding command', parsed.error.issues),
            400,
          );
        }
        const receipt = await engine.submitStartBuilding(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: { ...parsed.data, planetId: parsed.data.planetId as PlanetId },
        });
        return c.json({ receipt }, 201);
      }
      if (command.kind === 'CancelConstruction') {
        const parsed = CancelConstructionCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError(
              'VALIDATION_ERROR',
              'malformed CancelConstruction command',
              parsed.error.issues,
            ),
            400,
          );
        }
        const receipt = await engine.cancelConstruction(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: { ...parsed.data, orderId: parsed.data.orderId as OrderId },
        });
        return c.json({ receipt }, 200);
      }
      if (command.kind === 'StartResearch') {
        const parsed = StartResearchCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed StartResearch command', parsed.error.issues),
            400,
          );
        }
        const receipt = await engine.submitStartResearch(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            ...parsed.data,
            hostPlanetId: parsed.data.hostPlanetId as PlanetId,
            technologyId: parsed.data.technologyId as TechnologyId,
          },
        });
        return c.json({ receipt }, 201);
      }
      if (command.kind === 'CancelResearch') {
        const parsed = CancelResearchCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed CancelResearch command', parsed.error.issues),
            400,
          );
        }
        const receipt = await engine.cancelResearch(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: { ...parsed.data, orderId: parsed.data.orderId as OrderId },
        });
        return c.json({ receipt }, 200);
      }
      if (command.kind === 'QueueShip') {
        const parsed = QueueShipCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed QueueShip command', parsed.error.issues),
            400,
          );
        }
        const receipt = await engine.submitQueueShip(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            ...parsed.data,
            planetId: parsed.data.planetId as PlanetId,
            ship: parsed.data.ship,
            quantity: parsed.data.quantity,
          },
        });
        return c.json({ receipt }, 201);
      }
      if (command.kind === 'CancelShipOrder') {
        const parsed = CancelShipOrderCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed CancelShipOrder command', parsed.error.issues),
            400,
          );
        }
        const receipt = await engine.cancelShipOrder(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: { ...parsed.data, orderId: parsed.data.orderId as OrderId },
        });
        return c.json({ receipt }, 200);
      }
      if (command.kind === 'TransferFleet') {
        const parsed = TransferFleetCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed TransferFleet command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.transferFleet(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            kind: 'TransferFleet',
            fromFleetId: parsed.data.fromFleetId as FleetId,
            toFleetId: parsed.data.toFleetId as FleetId,
            ships: parsed.data.ships,
            ...(parsed.data.cargo === undefined ? {} : { cargo: parsed.data.cargo }),
          },
        });
        return c.json({ result }, 200);
      }
      if (command.kind === 'SplitFleet') {
        const parsed = SplitFleetCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed SplitFleet command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.splitFleet(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            ...parsed.data,
            fleetId: parsed.data.fleetId as FleetId,
          },
        });
        return c.json({ result }, 201);
      }
      if (command.kind === 'SendFleet') {
        const parsed = SendFleetCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed SendFleet command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.sendFleet(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            kind: 'SendFleet',
            fleetId: parsed.data.fleetId as FleetId,
            destination: parsed.data.destination,
            mission: parsed.data.mission,
          },
        });
        return c.json({ result }, 201);
      }
      if (command.kind === 'RecallFleet') {
        const parsed = RecallFleetCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed RecallFleet command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.recallFleet(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: { kind: 'RecallFleet', fleetId: parsed.data.fleetId as FleetId },
        });
        return c.json({ result }, 200);
      }
      if (command.kind === 'LoadCargo') {
        const parsed = LoadCargoCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed LoadCargo command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.loadCargo(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            kind: 'LoadCargo',
            fleetId: parsed.data.fleetId as FleetId,
            resources: parsed.data.resources,
          },
        });
        return c.json({ result }, 200);
      }
      if (command.kind === 'UnloadCargo') {
        const parsed = UnloadCargoCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed UnloadCargo command', parsed.error.issues),
            400,
          );
        }
        const result = await engine.unloadCargo(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            kind: 'UnloadCargo',
            fleetId: parsed.data.fleetId as FleetId,
            resources: parsed.data.resources,
          },
        });
        return c.json({ result }, 200);
      }
      if (command.kind === 'RunScan') {
        const parsed = RunScanCommandSchema.safeParse(command);
        if (!parsed.success) {
          return c.json(
            apiError('VALIDATION_ERROR', 'malformed RunScan command', parsed.error.issues),
            400,
          );
        }
        const report = await engine.runScan(worldId, identity.playerId, {
          idempotencyKey,
          expectedVersion,
          command: {
            kind: 'RunScan',
            sourcePlanetId: parsed.data.sourcePlanetId as PlanetId,
            target: parsed.data.target,
            scan: parsed.data.scan,
          },
        });
        return c.json({ report }, 201);
      }
    } catch (err) {
      const mapped = engine.toApiError(err);
      return c.json(mapped, commandStatus(mapped.error.code));
    }

    return c.json(
      apiError('UNSUPPORTED_COMMAND_KIND', `command kind '${command.kind}' is not supported yet`),
      400,
    );
  });

  return app;
}

/** HTTP status for a rejected command error code. */
function commandStatus(code: ApiErrorCode): 400 | 401 | 404 | 409 | 500 {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'STALE_VERSION':
      return 409;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}

/** The session the client keeps: a bearer token + the public account view. */
function sessionResponse(account: Account, token: string): SessionResponse {
  return { token, account: toAccountView(account) };
}

/** The account behind the current identity (or undefined for the dev player). */
async function accountOf(
  c: Context<AppEnv>,
  accounts: AccountRepository,
): Promise<Account | undefined> {
  const accountId = c.get('identity').accountId;
  if (accountId === undefined) return undefined;
  return accounts.getAccountById(accountId);
}

/**
 * Revoke every active session except the one that issued the request. The
 * current session is identified by its row id (resolved from the token hash),
 * so the raw token never crosses into the repository.
 */
async function revokeOtherSessions(
  accounts: AccountRepository,
  accountId: string,
  currentToken: string,
): Promise<number> {
  const currentHash = hashSessionToken(currentToken);
  const sessions = await accounts.listSessions(accountId, currentHash);
  const current = sessions.find((s) => s.isCurrent);
  return accounts.revokeOtherSessions(accountId, current?.id ?? '', Date.now());
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

async function issueSession(
  accounts: AccountRepository,
  accountId: string,
  c: Context,
  configuredTtlMs: number | undefined,
): Promise<string> {
  const now = Date.now();
  const token = `sess_${randomBytes(32).toString('hex')}`;
  const ttl = configuredTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const userAgent = c.req.header('user-agent');
  const ipAddress = c.req.header('x-forwarded-for');
  await accounts.createSession({
    id: `ses_${randomBytes(12).toString('hex')}`,
    accountId,
    token,
    createdAt: now,
    expiresAt: now + ttl,
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(ipAddress === undefined ? {} : { ipAddress }),
  });
  return token;
}

export function toAccountView(account: Account): AccountView {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    factionId: account.factionId,
    symbolId: account.symbolId,
    worldId: account.worldId,
    playerId: account.playerId,
    homePlanetId: account.homePlanetId,
    createdAt: account.createdAt,
  };
}

/**
 * Player-identity middleware: resolves the bearer token to a player and
 * stores the identity for the route. Unknown or missing tokens answer 401.
 */
function playerOnly(auth: AuthContext): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json(apiError('UNAUTHENTICATED', 'a valid bearer token is required'), 401);
    }
    const token = header.slice('Bearer '.length);
    const identity = await auth.resolvePlayerIdentity(token);
    if (!identity) {
      return c.json(apiError('UNAUTHENTICATED', 'a valid bearer token is required'), 401);
    }
    c.set('identity', { ...identity, sessionToken: token });
    await next();
  };
}

/**
 * Player middleware for world-scoped routes. Authentication alone is not
 * enough: an account token must address its own world, otherwise a stale
 * browser session can turn a missing player into an internal 500.
 */
function worldPlayerOnly(auth: AuthContext): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next) => {
    const response = await playerOnly(auth)(c, async () => undefined);
    if (response) return response;
    const identity = c.get('identity');
    const requestedWorldId = c.req.param('worldId') as WorldId;
    if (identity.worldId !== requestedWorldId) {
      return c.json(apiError('NOT_FOUND', `world ${requestedWorldId} not found`), 404);
    }
    await next();
  };
}

/** Dev/admin middleware: only the exact admin bearer token passes. */
function adminOnly(adminToken: string): MiddlewareHandler {
  return async (c: Context, next) => {
    const header = c.req.header('authorization');
    if (header !== `Bearer ${adminToken}`) {
      return c.json(apiError('UNAUTHENTICATED', 'a valid bearer token is required'), 401);
    }
    await next();
  };
}

function parseImageSize(raw: string | undefined): number {
  if (raw === undefined) return PLANET_ART.render.defaultSize;
  const n = Number(raw);
  if (!Number.isInteger(n)) return PLANET_ART.render.defaultSize;
  return Math.min(Math.max(n, PLANET_ART.render.minSize), PLANET_ART.render.maxSize);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  return PNG.sync.write(png);
}

/** The world a player lives in, or undefined when the player is gone. */
async function worldOfPlayer(engine: TickEngine, playerId: PlayerId): Promise<WorldId | undefined> {
  const rows = await engine.listPlayers();
  return rows.find((r) => r.player.id === playerId)?.worldId;
}

/** Account fields shared by the list and detail views. */
function accountSummaryBase(
  account: Account,
): Omit<AdminAccountSummary, 'activeSessionCount' | 'lastSeenAt'> {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    factionId: account.factionId,
    symbolId: account.symbolId,
    worldId: account.worldId,
    playerId: account.playerId,
    homePlanetId: account.homePlanetId,
    createdAt: account.createdAt,
  };
}

/** The account dossier: summary + every session (newest first). */
async function adminAccountDetail(
  accounts: AccountRepository,
  account: Account,
): Promise<AdminAccountDetail> {
  const now = Date.now();
  const sessions = await accounts.listSessions(account.id, '');
  const active = sessions.filter((s) => s.revokedAt === null && s.expiresAt > now);
  const lastSeen = sessions.reduce((max, s) => Math.max(max, s.lastSeenAt), account.createdAt);
  return {
    account: {
      ...accountSummaryBase(account),
      activeSessionCount: active.length,
      lastSeenAt: sessions.length > 0 ? lastSeen : null,
    },
    sessions,
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** scrypt password hash, stored as `salt:hash` (both hex). */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
