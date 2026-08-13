import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { WorldState } from '@ashes/contracts';

/**
 * Worlds: one row per world. The authoritative aggregate is stored as a
 * JSONB `state` payload; the scalar columns mirror the fields the scheduler
 * and tooling query without parsing the aggregate (see docs/ADR-003).
 */
export const worldsTable = pgTable('worlds', {
  id: text('id').primaryKey(),
  seed: integer('seed').notNull(),
  tick: integer('tick').notNull(),
  nextTickAt: bigint('next_tick_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  lastResolvedAt: bigint('last_resolved_at', { mode: 'number' }),
  worldVersion: text('world_version').notNull(),
  contentVersion: text('content_version').notNull(),
  tickDurationMs: integer('tick_duration_ms').notNull(),
  state: jsonb('state').$type<WorldState>().notNull(),
  version: integer('version').notNull(),
});

/**
 * One immutable resolution per world/tick (DEVELOPMENT_PLAN.md §9). The
 * composite primary key makes duplicate resolution impossible at the storage
 * layer; the engine additionally replays idempotently under the world lock.
 */
export const tickResolutionsTable = pgTable(
  'tick_resolutions',
  {
    worldId: text('world_id')
      .notNull()
      .references(() => worldsTable.id, { onDelete: 'cascade' }),
    tick: integer('tick').notNull(),
    contentVersion: text('content_version').notNull(),
    commandCutoffAt: bigint('command_cutoff_at', { mode: 'number' }).notNull(),
    resolvedAt: bigint('resolved_at', { mode: 'number' }).notNull(),
    seed: text('seed').notNull(),
    phaseHashes: jsonb('phase_hashes').$type<Record<string, string>>().notNull(),
    planetStateHash: text('planet_state_hash').notNull(),
    status: text('status').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.tick] })],
);

/**
 * Accounts: one row per registered player. Holds the password hash and the
 * session bearer token; the game-side identity (player, home planet, faction)
 * lives in the world aggregate and is referenced here by id.
 */
export const accountsTable = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Legacy token column; migrated to hashed account_sessions and kept nullable for old rows. */
    token: text('token'),
    worldId: text('world_id').notNull(),
    playerId: text('player_id').notNull(),
    name: text('name').notNull(),
    factionId: text('faction_id').notNull(),
    symbolId: text('symbol_id').notNull(),
    homePlanetId: text('home_planet_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('accounts_username_lower_unique').on(sql`lower(${t.username})`)],
);

/** Opaque, expiring bearer sessions. Raw tokens are never persisted. */
export const accountSessionsTable = pgTable(
  'account_sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accountsTable.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (t) => [
    uniqueIndex('account_sessions_token_hash_unique').on(t.tokenHash),
    index('account_sessions_account_id_idx').on(t.accountId),
    index('account_sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export type WorldRow = typeof worldsTable.$inferInsert;
export type TickResolutionRow = typeof tickResolutionsTable.$inferInsert;
export type AccountRow = typeof accountsTable.$inferInsert;
export type AccountSessionRow = typeof accountSessionsTable.$inferInsert;
