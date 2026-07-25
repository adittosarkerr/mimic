import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Listing, Transaction, User } from './types.js'
import { dbEnabled, query } from '../store/db.js'

const DATA_DIR = join(process.cwd(), 'data')

async function ensureDir(sub: string): Promise<string> {
  const dir = join(DATA_DIR, sub)
  await mkdir(dir, { recursive: true })
  return dir
}
async function writeJson(sub: string, id: string, value: unknown): Promise<void> {
  const dir = await ensureDir(sub)
  await writeFile(join(dir, `${id}.json`), JSON.stringify(value, null, 2), 'utf8')
}
async function readJson<T>(sub: string, id: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, sub, `${id}.json`), 'utf8')) as T
  } catch {
    return null
  }
}
async function listJson<T>(sub: string): Promise<T[]> {
  try {
    const files = await readdir(join(DATA_DIR, sub))
    const out: T[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      out.push(JSON.parse(await readFile(join(DATA_DIR, sub, f), 'utf8')) as T)
    }
    return out
  } catch {
    return []
  }
}

// Sessions: token -> userId, kept in a single JSON map (file backend only).
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')
async function readSessions(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(SESSIONS_FILE, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}
async function writeSessions(map: Record<string, string>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(SESSIONS_FILE, JSON.stringify(map), 'utf8')
}

// API keys: fullKey -> userId (file backend only).
const APIKEYS_FILE = join(DATA_DIR, 'apikeys.json')
async function readApiKeys(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(APIKEYS_FILE, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}
async function writeApiKeys(map: Record<string, string>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(APIKEYS_FILE, JSON.stringify(map), 'utf8')
}

export interface SaasStore {
  saveUser(u: User): Promise<void>
  getUser(id: string): Promise<User | null>
  listUsers(): Promise<User[]>
  getUserByEmail(email: string): Promise<User | null>

  createSession(token: string, userId: string): Promise<void>
  userIdForToken(token: string): Promise<string | null>
  destroySession(token: string): Promise<void>

  saveListing(l: Listing): Promise<void>
  getListing(id: string): Promise<Listing | null>
  listListings(): Promise<Listing[]>
  deleteListing(id: string): Promise<void>

  registerApiKey(key: string, userId: string): Promise<void>
  userIdForApiKey(key: string): Promise<string | null>
  unregisterApiKey(key: string): Promise<void>

  saveTransaction(t: Transaction): Promise<void>
  listTransactions(): Promise<Transaction[]>
}

/** Local JSON files — used when no Postgres connection string is configured. */
const fileSaasStore: SaasStore = {
  saveUser: (u) => writeJson('users', u.id, u),
  getUser: (id) => readJson<User>('users', id),
  listUsers: () => listJson<User>('users'),
  async getUserByEmail(email) {
    const users = await listJson<User>('users')
    return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null
  },

  async createSession(token, userId) {
    const map = await readSessions()
    map[token] = userId
    await writeSessions(map)
  },
  async userIdForToken(token) {
    const map = await readSessions()
    return map[token] ?? null
  },
  async destroySession(token) {
    const map = await readSessions()
    delete map[token]
    await writeSessions(map)
  },

  saveListing: (l) => writeJson('listings', l.id, l),
  getListing: (id) => readJson<Listing>('listings', id),
  listListings: () => listJson<Listing>('listings'),
  async deleteListing(id) {
    try {
      await unlink(join(DATA_DIR, 'listings', `${id}.json`))
    } catch {
      /* gone */
    }
  },

  async registerApiKey(key, userId) {
    const map = await readApiKeys()
    map[key] = userId
    await writeApiKeys(map)
  },
  async userIdForApiKey(key) {
    const map = await readApiKeys()
    return map[key] ?? null
  },
  async unregisterApiKey(key) {
    const map = await readApiKeys()
    delete map[key]
    await writeApiKeys(map)
  },

  saveTransaction: (t) => writeJson('transactions', t.id, t),
  listTransactions: () => listJson<Transaction>('transactions'),
}

/** Postgres — used in production (Vercel etc.) so accounts survive redeploys. */
const pgSaasStore: SaasStore = {
  saveUser: async (u) => {
    await query(
      'INSERT INTO users (id, email, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email = $2, data = $3',
      [u.id, u.email, u],
    )
  },
  getUser: async (id) => {
    const rows = await query<{ data: User }>('SELECT data FROM users WHERE id = $1', [id])
    return rows[0]?.data ?? null
  },
  listUsers: async () => {
    const rows = await query<{ data: User }>('SELECT data FROM users')
    return rows.map((r) => r.data)
  },
  getUserByEmail: async (email) => {
    const rows = await query<{ data: User }>('SELECT data FROM users WHERE lower(email) = lower($1)', [email])
    return rows[0]?.data ?? null
  },

  createSession: async (token, userId) => {
    await query('INSERT INTO sessions (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_id = $2', [
      token,
      userId,
    ])
  },
  userIdForToken: async (token) => {
    const rows = await query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token = $1', [token])
    return rows[0]?.user_id ?? null
  },
  destroySession: async (token) => {
    await query('DELETE FROM sessions WHERE token = $1', [token])
  },

  saveListing: async (l) => {
    await query(
      'INSERT INTO listings (id, active, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET active = $2, data = $3',
      [l.id, l.active, l],
    )
  },
  getListing: async (id) => {
    const rows = await query<{ data: Listing }>('SELECT data FROM listings WHERE id = $1', [id])
    return rows[0]?.data ?? null
  },
  listListings: async () => {
    const rows = await query<{ data: Listing }>('SELECT data FROM listings')
    return rows.map((r) => r.data)
  },
  deleteListing: async (id) => {
    await query('DELETE FROM listings WHERE id = $1', [id])
  },

  registerApiKey: async (key, userId) => {
    await query('INSERT INTO api_keys (key, user_id) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET user_id = $2', [
      key,
      userId,
    ])
  },
  userIdForApiKey: async (key) => {
    const rows = await query<{ user_id: string }>('SELECT user_id FROM api_keys WHERE key = $1', [key])
    return rows[0]?.user_id ?? null
  },
  unregisterApiKey: async (key) => {
    await query('DELETE FROM api_keys WHERE key = $1', [key])
  },

  saveTransaction: async (t) => {
    await query(
      'INSERT INTO transactions (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
      [t.id, t.userId, t],
    )
  },
  listTransactions: async () => {
    const rows = await query<{ data: Transaction }>('SELECT data FROM transactions')
    return rows.map((r) => r.data)
  },
}

export const saasStore: SaasStore = dbEnabled ? pgSaasStore : fileSaasStore
