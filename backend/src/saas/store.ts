import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Listing, Transaction, User } from './types.js'

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

// Sessions: token -> userId, kept in a single JSON map.
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

// API keys: fullKey -> userId, a single JSON map (mirrors sessions).
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

export const saasStore = {
  saveUser: (u: User) => writeJson('users', u.id, u),
  getUser: (id: string) => readJson<User>('users', id),
  listUsers: () => listJson<User>('users'),
  async getUserByEmail(email: string): Promise<User | null> {
    const users = await listJson<User>('users')
    return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null
  },

  async createSession(token: string, userId: string): Promise<void> {
    const map = await readSessions()
    map[token] = userId
    await writeSessions(map)
  },
  async userIdForToken(token: string): Promise<string | null> {
    const map = await readSessions()
    return map[token] ?? null
  },
  async destroySession(token: string): Promise<void> {
    const map = await readSessions()
    delete map[token]
    await writeSessions(map)
  },

  saveListing: (l: Listing) => writeJson('listings', l.id, l),
  getListing: (id: string) => readJson<Listing>('listings', id),
  listListings: () => listJson<Listing>('listings'),
  async deleteListing(id: string): Promise<void> {
    try {
      await unlink(join(DATA_DIR, 'listings', `${id}.json`))
    } catch {
      /* gone */
    }
  },

  async registerApiKey(key: string, userId: string): Promise<void> {
    const map = await readApiKeys()
    map[key] = userId
    await writeApiKeys(map)
  },
  async userIdForApiKey(key: string): Promise<string | null> {
    const map = await readApiKeys()
    return map[key] ?? null
  },
  async unregisterApiKey(key: string): Promise<void> {
    const map = await readApiKeys()
    delete map[key]
    await writeApiKeys(map)
  },

  saveTransaction: (t: Transaction) => writeJson('transactions', t.id, t),
  listTransactions: () => listJson<Transaction>('transactions'),
}
