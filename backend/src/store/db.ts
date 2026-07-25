import { Pool } from 'pg'

/**
 * Postgres is used when a connection string is configured (e.g. Vercel's
 * Postgres/Neon integration sets POSTGRES_URL). Without one, every store
 * falls back to local JSON files — local dev needs no database at all.
 */
const CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL || null

export const dbEnabled = CONNECTION_STRING !== null

let pool: Pool | null = null

function getPool(): Pool {
  if (!CONNECTION_STRING) throw new Error('no Postgres connection string configured')
  if (!pool) {
    const isLocal = /localhost|127\.0\.0\.1/.test(CONNECTION_STRING)
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    })
  }
  return pool
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params)
  return res.rows as T[]
}

let schemaReady: Promise<void> | null = null

/** Idempotent — safe to call on every boot. Creates tables only if missing. */
export function ensureSchema(): Promise<void> {
  if (!dbEnabled) return Promise.resolve()
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_automation_id_idx ON runs (automation_id);
      CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT PRIMARY KEY, html TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (automation_id TEXT PRIMARY KEY, enc TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (key TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, active BOOLEAN NOT NULL DEFAULT true, data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions (user_id);
      CREATE TABLE IF NOT EXISTS email_configs (user_id TEXT PRIMARY KEY, enc TEXT NOT NULL);
    `).then(() => undefined)
  }
  return schemaReady
}
