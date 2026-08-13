import { Pool } from 'pg';
import type { AdminResolutionRow, DatabaseStatus, TableStat, WorldId } from '@ashes/contracts';

/**
 * Operator-facing database introspection (M4). The admin dashboard reads
 * database health and per-table statistics, and browses immutable tick
 * resolutions — all read-only. Mutations never go through this surface: game
 * state changes use the engine under the world lock, account changes use the
 * account repository.
 */
export interface DatabaseAdmin {
  getStatus(): Promise<DatabaseStatus>;
  /** Newest-first immutable resolution history for one world. */
  listResolutions(worldId: WorldId, limit: number): Promise<AdminResolutionRow[]>;
  countResolutions(worldId: WorldId): Promise<number>;
}

const TABLES = ['worlds', 'tick_resolutions', 'accounts', 'account_sessions'];

/** PostgreSQL-backed introspection via the same pool pattern as the repos. */
export class PostgresDatabaseAdmin implements DatabaseAdmin {
  private readonly pool: Pool;

  constructor(options: { connectionString: string; poolSize?: number }) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 5,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getStatus(): Promise<DatabaseStatus> {
    const [version, database, tables] = await Promise.all([
      this.scalar<string>('SELECT version() AS v'),
      this.scalar<string>('SELECT current_database() AS v'),
      this.tableStats(),
    ]);
    let appliedMigrations = 0;
    try {
      appliedMigrations =
        (await this.scalar<number>(
          'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
        )) ?? 0;
    } catch {
      // Migrations table not created yet (pre-boot); report 0.
    }
    return {
      driver: 'postgres',
      serverVersion: (version ?? 'unknown').split(' on ')[0] ?? version ?? 'unknown',
      databaseName: database ?? 'unknown',
      appliedMigrations,
      tables,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
    };
  }

  async listResolutions(worldId: WorldId, limit: number): Promise<AdminResolutionRow[]> {
    const rows = await this.pool.query(
      `SELECT tick, resolved_at, status, planet_state_hash, phase_hashes
         FROM tick_resolutions
        WHERE world_id = $1
        ORDER BY tick DESC
        LIMIT $2`,
      [worldId, Math.max(1, Math.min(limit, 200))],
    );
    return rows.rows.map((r) => ({
      tick: Number(r.tick),
      resolvedAt: Number(r.resolved_at),
      status: String(r.status),
      planetStateHash: String(r.planet_state_hash),
      phaseHashes: (r.phase_hashes ?? {}) as Record<string, string>,
    }));
  }

  async countResolutions(worldId: WorldId): Promise<number> {
    const rows = await this.pool.query(
      'SELECT count(*)::int AS n FROM tick_resolutions WHERE world_id = $1',
      [worldId],
    );
    return Number(rows.rows[0]?.n ?? 0);
  }

  private async tableStats(): Promise<TableStat[]> {
    const sizes = await this.pool.query(
      `SELECT c.relname AS name,
              pg_size_pretty(pg_total_relation_size(c.oid)) AS size
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    const sizeByName = new Map<string, string>(
      sizes.rows.map((r) => [String(r.name), String(r.size)]),
    );
    const stats: TableStat[] = [];
    for (const table of TABLES) {
      let rows = 0;
      try {
        rows =
          (await this.scalar<number>(`SELECT count(*)::int AS n FROM "public"."${table}"`)) ?? 0;
      } catch {
        // Table does not exist yet (pre-migration boot); report 0.
      }
      stats.push({
        name: table,
        rows,
        size: sizeByName.get(table) ?? '—',
      });
    }
    return stats;
  }

  private async scalar<T>(sql: string): Promise<T | undefined> {
    const rows = await this.pool.query(sql);
    const value = rows.rows[0];
    if (!value) return undefined;
    const key = Object.keys(value)[0];
    return value[key] as T;
  }
}

type MemoryResolution = AdminResolutionRow & { worldId: string };

/** In-memory stub for unit tests: reports the counts given at construction. */
export class InMemoryDatabaseAdmin implements DatabaseAdmin {
  private readonly counts: {
    worlds?: number;
    accounts?: number;
    sessions?: number;
    resolutions?: number;
  };
  private readonly resolutions: MemoryResolution[];

  constructor(options?: {
    counts?: { worlds?: number; accounts?: number; sessions?: number; resolutions?: number };
    resolutions?: MemoryResolution[];
  }) {
    this.counts = options?.counts ?? {};
    this.resolutions = options?.resolutions ?? [];
  }

  async getStatus(): Promise<DatabaseStatus> {
    const tables: TableStat[] = [
      { name: 'worlds', rows: this.counts.worlds ?? 0, size: '—' },
      { name: 'tick_resolutions', rows: this.counts.resolutions ?? 0, size: '—' },
      { name: 'accounts', rows: this.counts.accounts ?? 0, size: '—' },
      { name: 'account_sessions', rows: this.counts.sessions ?? 0, size: '—' },
    ];
    return {
      driver: 'memory',
      serverVersion: 'in-memory',
      databaseName: 'memory',
      appliedMigrations: 0,
      tables,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
    };
  }

  async listResolutions(worldId: WorldId, limit: number): Promise<AdminResolutionRow[]> {
    return this.resolutions
      .filter((r) => r.worldId === worldId)
      .map(({ worldId: _worldId, ...row }) => row)
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  async countResolutions(worldId: WorldId): Promise<number> {
    return this.resolutions.filter((r) => r.worldId === worldId).length;
  }
}
