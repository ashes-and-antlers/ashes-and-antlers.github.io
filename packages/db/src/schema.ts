import { bigint, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
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

export type WorldRow = typeof worldsTable.$inferInsert;
export type TickResolutionRow = typeof tickResolutionsTable.$inferInsert;
