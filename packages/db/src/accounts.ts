import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { FactionId, PlanetId, PlayerId, SymbolId, WorldId } from '@ashes/contracts';
import {
  accountSessionsTable,
  accountsTable,
  type AccountRow,
  type AccountSessionRow,
} from './schema';

/**
 * Full account record. Password hashes and session credentials are storage
 * concerns and never cross the API wire.
 */
export type Account = {
  id: string;
  username: string;
  passwordHash: string;
  worldId: WorldId;
  playerId: PlayerId;
  name: string;
  factionId: FactionId;
  symbolId: SymbolId;
  homePlanetId: PlanetId;
  createdAt: number;
};

export type CreateAccountSession = {
  id: string;
  accountId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  userAgent?: string;
  ipAddress?: string;
};

/** One session as the control panel shows it (token hashes never leave db). */
export type AccountSessionSummary = {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrent: boolean;
};

export interface AccountRepository {
  createAccount(account: Account): Promise<void>;
  /** Every account, oldest first (admin surface). */
  listAccounts(): Promise<Account[]>;
  getAccountById(id: string): Promise<Account | undefined>;
  getAccountByUsername(username: string): Promise<Account | undefined>;
  getAccountBySessionToken(token: string, now: number): Promise<Account | undefined>;
  getAccountByPlayerId(playerId: PlayerId): Promise<Account | undefined>;
  createSession(session: CreateAccountSession): Promise<void>;
  revokeSession(token: string, revokedAt: number): Promise<void>;
  /** Update display fields; returns the refreshed account or undefined. */
  updateAccountProfile(
    accountId: string,
    changes: { name?: string; symbolId?: string },
  ): Promise<Account | undefined>;
  updatePassword(accountId: string, passwordHash: string): Promise<void>;
  /** Refresh the account's home planet after the player was re-spawned. */
  updateHomePlanet(accountId: string, homePlanetId: PlanetId): Promise<void>;
  /** Every session on the account, newest first, with the current one marked. */
  listSessions(accountId: string, currentTokenHash: string): Promise<AccountSessionSummary[]>;
  /** Revoke one owned session; false when it does not exist or is already revoked. */
  revokeSessionById(accountId: string, sessionId: string, revokedAt: number): Promise<boolean>;
  /** Revoke every session except the current one; returns how many were revoked. */
  revokeOtherSessions(accountId: string, keepSessionId: string, revokedAt: number): Promise<number>;
  /** Revoke every session on the account (admin); returns how many were revoked. */
  revokeAllSessions(accountId: string, revokedAt: number): Promise<number>;
  /** Delete the account row (admin); sessions cascade. */
  deleteAccount(accountId: string): Promise<void>;
}

/** PostgreSQL-backed accounts and hashed bearer sessions. */
export class PostgresAccountRepository implements AccountRepository {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;

  constructor(options: { connectionString: string; poolSize?: number }) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 5,
    });
    this.db = drizzle(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createAccount(account: Account): Promise<void> {
    await this.db.insert(accountsTable).values(accountRow(account));
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.db.select().from(accountsTable).orderBy(accountsTable.createdAt);
    return rows.map(accountFromRow);
  }

  async getAccountById(id: string): Promise<Account | undefined> {
    const rows = await this.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, id))
      .limit(1);
    return rows[0] ? accountFromRow(rows[0]) : undefined;
  }

  async getAccountByUsername(username: string): Promise<Account | undefined> {
    const rows = await this.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.username, username))
      .limit(1);
    return rows[0] ? accountFromRow(rows[0]) : undefined;
  }

  async getAccountBySessionToken(token: string, now: number): Promise<Account | undefined> {
    const tokenHash = hashSessionToken(token);
    const rows = await this.db
      .select({ account: accountsTable })
      .from(accountSessionsTable)
      .innerJoin(accountsTable, eq(accountSessionsTable.accountId, accountsTable.id))
      .where(
        and(
          eq(accountSessionsTable.tokenHash, tokenHash),
          isNull(accountSessionsTable.revokedAt),
          gt(accountSessionsTable.expiresAt, now),
        ),
      )
      .limit(1);
    const account = rows[0]?.account;
    if (!account) return undefined;
    await this.db
      .update(accountSessionsTable)
      .set({ lastSeenAt: now })
      .where(eq(accountSessionsTable.tokenHash, tokenHash));
    return accountFromRow(account);
  }

  async getAccountByPlayerId(playerId: PlayerId): Promise<Account | undefined> {
    const rows = await this.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.playerId, playerId))
      .limit(1);
    return rows[0] ? accountFromRow(rows[0]) : undefined;
  }

  async createSession(session: CreateAccountSession): Promise<void> {
    await this.db.insert(accountSessionsTable).values(sessionRow(session));
  }

  async revokeSession(token: string, revokedAt: number): Promise<void> {
    await this.db
      .update(accountSessionsTable)
      .set({ revokedAt })
      .where(
        and(
          eq(accountSessionsTable.tokenHash, hashSessionToken(token)),
          isNull(accountSessionsTable.revokedAt),
        ),
      );
  }

  async updateAccountProfile(
    accountId: string,
    changes: { name?: string; symbolId?: string },
  ): Promise<Account | undefined> {
    const patch: Partial<AccountRow> = {};
    if (changes.name !== undefined) patch.name = changes.name;
    if (changes.symbolId !== undefined) patch.symbolId = changes.symbolId;
    if (Object.keys(patch).length > 0) {
      await this.db.update(accountsTable).set(patch).where(eq(accountsTable.id, accountId));
    }
    return this.getAccountById(accountId);
  }
  async updatePassword(accountId: string, passwordHash: string): Promise<void> {
    await this.db
      .update(accountsTable)
      .set({ passwordHash })
      .where(eq(accountsTable.id, accountId));
  }

  async updateHomePlanet(accountId: string, homePlanetId: PlanetId): Promise<void> {
    await this.db
      .update(accountsTable)
      .set({ homePlanetId })
      .where(eq(accountsTable.id, accountId));
  }

  async listSessions(
    accountId: string,
    currentTokenHash: string,
  ): Promise<AccountSessionSummary[]> {
    const rows = await this.db
      .select()
      .from(accountSessionsTable)
      .where(eq(accountSessionsTable.accountId, accountId))
      .orderBy(desc(accountSessionsTable.createdAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
      userAgent: row.userAgent ?? null,
      ipAddress: row.ipAddress ?? null,
      isCurrent: row.tokenHash === currentTokenHash,
    }));
  }

  async revokeSessionById(
    accountId: string,
    sessionId: string,
    revokedAt: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(accountSessionsTable)
      .set({ revokedAt })
      .where(
        and(
          eq(accountSessionsTable.id, sessionId),
          eq(accountSessionsTable.accountId, accountId),
          isNull(accountSessionsTable.revokedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeOtherSessions(
    accountId: string,
    keepSessionId: string,
    revokedAt: number,
  ): Promise<number> {
    const result = await this.db
      .update(accountSessionsTable)
      .set({ revokedAt })
      .where(
        and(
          eq(accountSessionsTable.accountId, accountId),
          ne(accountSessionsTable.id, keepSessionId),
          isNull(accountSessionsTable.revokedAt),
        ),
      );
    return result.rowCount ?? 0;
  }

  async revokeAllSessions(accountId: string, revokedAt: number): Promise<number> {
    const result = await this.db
      .update(accountSessionsTable)
      .set({ revokedAt })
      .where(
        and(eq(accountSessionsTable.accountId, accountId), isNull(accountSessionsTable.revokedAt)),
      );
    return result.rowCount ?? 0;
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.db.delete(accountsTable).where(eq(accountsTable.id, accountId));
  }
}

/** In-memory account/session store for API unit tests. */
export class InMemoryAccountRepository implements AccountRepository {
  private accounts = new Map<string, Account>();
  private sessions = new Map<string, AccountSessionRow>();

  async createAccount(account: Account): Promise<void> {
    if ([...this.accounts.values()].some((a) => a.username === account.username)) {
      throw new Error('account username already exists');
    }
    this.accounts.set(account.id, account);
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAccountById(id: string): Promise<Account | undefined> {
    return this.accounts.get(id);
  }

  async getAccountByUsername(username: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find((a) => a.username === username);
  }

  async getAccountBySessionToken(token: string, now: number): Promise<Account | undefined> {
    const session = this.sessions.get(hashSessionToken(token));
    if (!session || session.revokedAt !== null || session.expiresAt <= now) return undefined;
    session.lastSeenAt = now;
    return this.accounts.get(session.accountId);
  }

  async getAccountByPlayerId(playerId: PlayerId): Promise<Account | undefined> {
    return [...this.accounts.values()].find((a) => a.playerId === playerId);
  }

  async createSession(session: CreateAccountSession): Promise<void> {
    const row = sessionRow(session);
    this.sessions.set(row.tokenHash, row);
  }

  async revokeSession(token: string, revokedAt: number): Promise<void> {
    const row = this.sessions.get(hashSessionToken(token));
    if (row && row.revokedAt === null) row.revokedAt = revokedAt;
  }

  async updateAccountProfile(
    accountId: string,
    changes: { name?: string; symbolId?: string },
  ): Promise<Account | undefined> {
    const account = this.accounts.get(accountId);
    if (!account) return undefined;
    const next: Account = {
      ...account,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.symbolId === undefined
        ? {}
        : { symbolId: changes.symbolId as Account['symbolId'] }),
    };
    this.accounts.set(accountId, next);
    return next;
  }

  async updatePassword(accountId: string, passwordHash: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.accounts.set(accountId, { ...account, passwordHash });
  }

  async updateHomePlanet(accountId: string, homePlanetId: PlanetId): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.accounts.set(accountId, { ...account, homePlanetId });
  }

  async listSessions(
    accountId: string,
    currentTokenHash: string,
  ): Promise<AccountSessionSummary[]> {
    return [...this.sessions.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        revokedAt: row.revokedAt ?? null,
        userAgent: row.userAgent ?? null,
        ipAddress: row.ipAddress ?? null,
        isCurrent: row.tokenHash === currentTokenHash,
      }));
  }

  async revokeSessionById(
    accountId: string,
    sessionId: string,
    revokedAt: number,
  ): Promise<boolean> {
    const row = [...this.sessions.values()].find(
      (s) => s.id === sessionId && s.accountId === accountId && s.revokedAt === null,
    );
    if (!row) return false;
    row.revokedAt = revokedAt;
    return true;
  }

  async revokeOtherSessions(
    accountId: string,
    keepSessionId: string,
    revokedAt: number,
  ): Promise<number> {
    let count = 0;
    for (const row of this.sessions.values()) {
      if (row.accountId === accountId && row.id !== keepSessionId && row.revokedAt === null) {
        row.revokedAt = revokedAt;
        count++;
      }
    }
    return count;
  }

  async revokeAllSessions(accountId: string, revokedAt: number): Promise<number> {
    let count = 0;
    for (const row of this.sessions.values()) {
      if (row.accountId === accountId && row.revokedAt === null) {
        row.revokedAt = revokedAt;
        count++;
      }
    }
    return count;
  }

  async deleteAccount(accountId: string): Promise<void> {
    this.accounts.delete(accountId);
    for (const [hash, row] of [...this.sessions.entries()]) {
      if (row.accountId === accountId) this.sessions.delete(hash);
    }
  }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function accountRow(account: Account): AccountRow {
  return {
    id: account.id,
    username: account.username,
    passwordHash: account.passwordHash,
    token: null,
    worldId: account.worldId,
    playerId: account.playerId,
    name: account.name,
    factionId: account.factionId,
    symbolId: account.symbolId,
    homePlanetId: account.homePlanetId,
    createdAt: account.createdAt,
  };
}

function sessionRow(session: CreateAccountSession): AccountSessionRow {
  return {
    id: session.id,
    accountId: session.accountId,
    tokenHash: hashSessionToken(session.token),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: null,
    lastSeenAt: session.createdAt,
    ...(session.userAgent === undefined ? {} : { userAgent: session.userAgent }),
    ...(session.ipAddress === undefined ? {} : { ipAddress: session.ipAddress }),
  };
}

function accountFromRow(row: typeof accountsTable.$inferSelect): Account {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    worldId: row.worldId as WorldId,
    playerId: row.playerId as PlayerId,
    name: row.name,
    factionId: row.factionId as FactionId,
    symbolId: row.symbolId as SymbolId,
    homePlanetId: row.homePlanetId as PlanetId,
    createdAt: row.createdAt,
  };
}
