import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Apply pending Drizzle migrations (packages/db/drizzle) to the target
 * database. Called at API/worker boot and by the `db:migrate` script.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    const migrationsFolder = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../drizzle',
    );
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}
