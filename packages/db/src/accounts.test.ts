import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FactionId, PlanetId, PlayerId, SymbolId, WorldId } from '@ashes/contracts';
import { runMigrations } from './migrate';
import { PostgresAccountRepository, hashSessionToken, type Account } from './accounts';

const connectionString =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://ashes:ashes@localhost:5432/ashes';
const configured = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const describeDb = describe.runIf(configured);
const accountIds: string[] = [];

function testAccount(id: string): Account {
  return {
    id,
    username: `${id}_warden`,
    passwordHash: 'salt:hash',
    worldId: 'world:1337' as WorldId,
    playerId: `player:${id}` as PlayerId,
    name: 'Test Warden',
    factionId: 'hearth' as FactionId,
    symbolId: 'hearth-crown' as SymbolId,
    homePlanetId: 'planet:1:1:1:1' as PlanetId,
    createdAt: 1_000,
  };
}

describeDb('PostgresAccountRepository', () => {
  beforeAll(async () => {
    await runMigrations(connectionString);
  });

  afterAll(async () => {
    const pool = new Pool({ connectionString });
    await pool.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
    await pool.end();
  });

  it('stores only a session hash and enforces expiry/revocation', async () => {
    const id = `integration_${Date.now()}`;
    accountIds.push(id);
    const account = testAccount(id);
    const repository = new PostgresAccountRepository({ connectionString });
    await repository.createAccount(account);

    const token = `sess_integration_${id}`;
    await repository.createSession({
      id: `session_${id}`,
      accountId: id,
      token,
      createdAt: 1_000,
      expiresAt: 2_000,
    });

    expect(await repository.getAccountBySessionToken(token, 1_999)).toMatchObject({ id });
    expect(await repository.getAccountBySessionToken(token, 2_000)).toBeUndefined();

    await repository.revokeSession(token, 1_500);
    expect(await repository.getAccountBySessionToken(token, 1_600)).toBeUndefined();
    await repository.close();

    const pool = new Pool({ connectionString });
    const raw = await pool.query('SELECT token FROM accounts WHERE id = $1', [id]);
    const hashed = await pool.query(
      'SELECT token_hash FROM account_sessions WHERE account_id = $1',
      [id],
    );
    expect(raw.rows[0].token).toBeNull();
    expect(hashed.rows[0].token_hash).not.toBe(token);
    await pool.end();
  });

  it('updates profile/password and manages session list, revocation, and revoke-others', async () => {
    const id = `integration_panel_${Date.now()}`;
    accountIds.push(id);
    const repository = new PostgresAccountRepository({ connectionString });
    await repository.createAccount(testAccount(id));

    // Profile update persists to the account row.
    const updated = await repository.updateAccountProfile(id, {
      name: 'Renamed Warden',
      symbolId: 'iron-talon' as SymbolId,
    });
    expect(updated?.name).toBe('Renamed Warden');
    expect(updated?.symbolId).toBe('iron-talon');
    expect((await repository.getAccountById(id))?.name).toBe('Renamed Warden');

    // Password update replaces the hash.
    await repository.updatePassword(id, 'fresh-salt:hash');
    expect((await repository.getAccountById(id))?.passwordHash).toBe('fresh-salt:hash');

    // Two sessions: listing marks the current one and revoke-others kills the rest.
    await repository.createSession({
      id: `session_a_${id}`,
      accountId: id,
      token: `sess_a_${id}`,
      createdAt: 1_000,
      expiresAt: 9_000,
    });
    await repository.createSession({
      id: `session_b_${id}`,
      accountId: id,
      token: `sess_b_${id}`,
      createdAt: 2_000,
      expiresAt: 9_000,
    });
    const tokenB = `sess_b_${id}`;
    const currentHash = hashSessionToken(tokenB);

    const sessions = await repository.listSessions(id, currentHash);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === `session_b_${id}`)?.isCurrent).toBe(true);
    expect(sessions.find((s) => s.id === `session_a_${id}`)?.isCurrent).toBe(false);

    // Revoke one by id; unknown ids report false.
    expect(await repository.revokeSessionById(id, `session_a_${id}`, 5_000)).toBe(true);
    expect(await repository.revokeSessionById(id, 'session_missing', 5_000)).toBe(false);
    const afterOne = await repository.listSessions(id, currentHash);
    expect(afterOne.find((s) => s.id === `session_a_${id}`)?.revokedAt).toBe(5_000);

    // Revoke-others leaves only the current session active.
    const revoked = await repository.revokeOtherSessions(id, `session_b_${id}`, 6_000);
    expect(revoked).toBe(0); // session_a was already revoked
    await repository.revokeSession(tokenB, 7_000);
    const final = await repository.listSessions(id, currentHash);
    expect(final.every((s) => s.revokedAt !== null)).toBe(true);
    await repository.close();
  });
});
