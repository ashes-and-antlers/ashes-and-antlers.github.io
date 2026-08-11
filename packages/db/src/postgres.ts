import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { worldId, type TickResolution, type WorldId, type WorldState } from '@ashes/contracts';
import type { TickResolutionRow } from './schema';
import type { WorldRepository } from './repository';
import { tickResolutionsTable, worldsTable, type WorldRow } from './schema';

export type PostgresWorldRepositoryOptions = {
  connectionString: string;
  /** Pool size. 10 is plenty for the API + worker + tests. */
  poolSize?: number;
};

/**
 * PostgreSQL-backed WorldRepository (ADR-003). The authoritative world is
 * stored as a JSONB aggregate with mirrored scalar columns; resolutions are
 * immutable rows keyed by (worldId, tick).
 *
 * Cross-process safety comes from `withWorldLocked`: a transaction holding
 * `pg_advisory_xact_lock(worldId)` so only one resolver can advance a world at
 * a time, with the engine's idempotency check inside the same transaction.
 */
export class PostgresWorldRepository implements WorldRepository {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;

  constructor(options: PostgresWorldRepositoryOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 10,
    });
    this.db = drizzle(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveWorld(world: WorldState): Promise<void> {
    await insertWorld(this.db, world);
  }

  async getWorld(worldId: WorldId): Promise<WorldState | undefined> {
    const rows = await this.db
      .select()
      .from(worldsTable)
      .where(eq(worldsTable.id, worldId))
      .limit(1);
    return rows[0]?.state;
  }

  async saveResolution(resolution: TickResolution): Promise<void> {
    await insertResolution(this.db, resolution);
  }

  async getResolution(worldId: WorldId, tick: number): Promise<TickResolution | undefined> {
    const rows = await this.db
      .select()
      .from(tickResolutionsTable)
      .where(and(eq(tickResolutionsTable.worldId, worldId), eq(tickResolutionsTable.tick, tick)))
      .limit(1);
    return rows[0] ? resolutionFromRow(rows[0]) : undefined;
  }

  async listWorldIds(): Promise<WorldId[]> {
    const rows = await this.db.select({ id: worldsTable.id }).from(worldsTable);
    return rows.map((r) => worldId(r.id));
  }

  async deleteWorld(worldId: WorldId): Promise<void> {
    await this.db.delete(worldsTable).where(eq(worldsTable.id, worldId));
  }

  async withWorldLocked<T>(worldId: WorldId, fn: (tx: WorldRepository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize all resolvers of this world across every process sharing
      // the database. The lock releases automatically at COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [worldId]);
      const tx = new ScopedRepository(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Repository view bound to one transaction client. Reads and writes through
 * `tx` see the transaction snapshot, so the engine's idempotency check and
 * its saves are atomic. Not usable outside the lock scope.
 */
class ScopedRepository implements WorldRepository {
  private readonly db: NodePgDatabase;

  constructor(client: PoolClient) {
    this.db = drizzle(client);
  }

  async saveWorld(world: WorldState): Promise<void> {
    await insertWorld(this.db, world);
  }

  async getWorld(worldId: WorldId): Promise<WorldState | undefined> {
    const rows = await this.db
      .select()
      .from(worldsTable)
      .where(eq(worldsTable.id, worldId))
      .limit(1);
    return rows[0]?.state;
  }

  async saveResolution(resolution: TickResolution): Promise<void> {
    await insertResolution(this.db, resolution);
  }

  async getResolution(worldId: WorldId, tick: number): Promise<TickResolution | undefined> {
    const rows = await this.db
      .select()
      .from(tickResolutionsTable)
      .where(and(eq(tickResolutionsTable.worldId, worldId), eq(tickResolutionsTable.tick, tick)))
      .limit(1);
    return rows[0] ? resolutionFromRow(rows[0]) : undefined;
  }

  async listWorldIds(): Promise<WorldId[]> {
    throw new Error('listWorldIds is not available inside a world lock scope');
  }

  async deleteWorld(worldId: WorldId): Promise<void> {
    await this.db.delete(worldsTable).where(eq(worldsTable.id, worldId));
  }

  async withWorldLocked<T>(): Promise<T> {
    throw new Error('nested world locks are not supported');
  }
}

function worldRow(world: WorldState): WorldRow {
  return {
    id: world.id,
    seed: world.seed,
    tick: world.tick,
    nextTickAt: world.nextTickAt,
    createdAt: world.createdAt,
    lastResolvedAt: world.lastResolvedAt,
    worldVersion: world.worldVersion,
    contentVersion: world.contentVersion,
    tickDurationMs: world.tickDurationMs,
    state: world,
    version: world.version,
  };
}

async function insertWorld(db: NodePgDatabase, world: WorldState): Promise<void> {
  const row = worldRow(world);
  await db
    .insert(worldsTable)
    .values(row)
    .onConflictDoUpdate({
      target: worldsTable.id,
      set: {
        seed: row.seed,
        tick: row.tick,
        nextTickAt: row.nextTickAt,
        createdAt: row.createdAt,
        lastResolvedAt: row.lastResolvedAt,
        worldVersion: row.worldVersion,
        contentVersion: row.contentVersion,
        tickDurationMs: row.tickDurationMs,
        state: row.state,
        version: row.version,
      },
    });
}

function resolutionRow(resolution: TickResolution): TickResolutionRow {
  return {
    worldId: resolution.worldId,
    tick: resolution.tick,
    contentVersion: resolution.contentVersion,
    commandCutoffAt: resolution.commandCutoffAt,
    resolvedAt: resolution.resolvedAt,
    seed: resolution.seed,
    phaseHashes: resolution.phaseHashes,
    planetStateHash: resolution.planetStateHash,
    status: resolution.status,
  };
}

function resolutionFromRow(row: typeof tickResolutionsTable.$inferSelect): TickResolution {
  return {
    worldId: worldId(row.worldId),
    tick: row.tick,
    contentVersion: row.contentVersion,
    commandCutoffAt: row.commandCutoffAt,
    resolvedAt: row.resolvedAt,
    seed: row.seed,
    phaseHashes: row.phaseHashes,
    planetStateHash: row.planetStateHash,
    status: row.status as TickResolution['status'],
  };
}

async function insertResolution(db: NodePgDatabase, resolution: TickResolution): Promise<void> {
  await db.insert(tickResolutionsTable).values(resolutionRow(resolution)).onConflictDoNothing();
}
