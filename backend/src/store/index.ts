import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationSchema, Credentials, RecordingSession, RunResult } from '../types.js'
import { encryptSecret, decryptSecret } from './crypto.js'
import { dbEnabled, query } from './db.js'

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
    const raw = await readFile(join(DATA_DIR, sub, `${id}.json`), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function listJson<T>(sub: string): Promise<T[]> {
  try {
    const dir = join(DATA_DIR, sub)
    const files = await readdir(dir)
    const out: T[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const raw = await readFile(join(dir, f), 'utf8')
      out.push(JSON.parse(raw) as T)
    }
    return out
  } catch {
    return []
  }
}

async function deleteJson(sub: string, id: string): Promise<void> {
  try {
    await unlink(join(DATA_DIR, sub, `${id}.json`))
  } catch {
    /* already gone */
  }
}

export interface Store {
  saveRecording(s: RecordingSession): Promise<void>
  getRecording(id: string): Promise<RecordingSession | null>
  listRecordings(): Promise<RecordingSession[]>
  deleteRecording(id: string): Promise<void>

  saveAutomation(a: AutomationSchema): Promise<void>
  getAutomation(id: string): Promise<AutomationSchema | null>
  listAutomations(): Promise<AutomationSchema[]>
  deleteAutomation(id: string): Promise<void>

  saveRun(r: RunResult): Promise<void>
  getRun(id: string): Promise<RunResult | null>
  listRuns(): Promise<RunResult[]>
  deleteRun(id: string): Promise<void>

  saveSnapshot(runId: string, html: string): Promise<void>
  getSnapshot(runId: string): Promise<string | null>

  saveCredentials(automationId: string, creds: Credentials): Promise<void>
  getCredentials(automationId: string): Promise<Credentials | null>
  hasCredentials(automationId: string): Promise<boolean>
  deleteCredentials(automationId: string): Promise<void>
}

/** Local JSON files — used when no Postgres connection string is configured. */
const fileStore: Store = {
  saveRecording: (s) => writeJson('recordings', s.id, s),
  getRecording: (id) => readJson<RecordingSession>('recordings', id),
  listRecordings: () => listJson<RecordingSession>('recordings'),
  deleteRecording: (id) => deleteJson('recordings', id),

  saveAutomation: (a) => writeJson('automations', a.automationId, a),
  getAutomation: (id) => readJson<AutomationSchema>('automations', id),
  listAutomations: () => listJson<AutomationSchema>('automations'),
  deleteAutomation: (id) => deleteJson('automations', id),

  saveRun: (r) => writeJson('runs', r.runId, r),
  getRun: (id) => readJson<RunResult>('runs', id),
  listRuns: () => listJson<RunResult>('runs'),
  deleteRun: (id) => deleteJson('runs', id),

  saveSnapshot: async (runId, html) => {
    const dir = await ensureDir('snapshots')
    await writeFile(join(dir, `${runId}.html`), html, 'utf8')
  },
  getSnapshot: async (runId) => {
    try {
      return await readFile(join(DATA_DIR, 'snapshots', `${runId}.html`), 'utf8')
    } catch {
      return null
    }
  },

  saveCredentials: async (automationId, creds) => {
    const dir = await ensureDir('credentials')
    await writeFile(join(dir, `${automationId}.enc`), encryptSecret(JSON.stringify(creds)), 'utf8')
  },
  getCredentials: async (automationId) => {
    try {
      const blob = await readFile(join(DATA_DIR, 'credentials', `${automationId}.enc`), 'utf8')
      return JSON.parse(decryptSecret(blob)) as Credentials
    } catch {
      return null
    }
  },
  hasCredentials: async (automationId) => existsSync(join(DATA_DIR, 'credentials', `${automationId}.enc`)),
  deleteCredentials: async (automationId) => {
    try {
      await unlink(join(DATA_DIR, 'credentials', `${automationId}.enc`))
    } catch {
      /* already gone */
    }
  },
}

/** Postgres — used in production (Vercel etc.) so data survives redeploys. */
const pgStore: Store = {
  saveRecording: async (s) => {
    await query('INSERT INTO recordings (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [s.id, s])
  },
  getRecording: async (id) => {
    const rows = await query<{ data: RecordingSession }>('SELECT data FROM recordings WHERE id = $1', [id])
    return rows[0]?.data ?? null
  },
  listRecordings: async () => {
    const rows = await query<{ data: RecordingSession }>('SELECT data FROM recordings')
    return rows.map((r) => r.data)
  },
  deleteRecording: async (id) => {
    await query('DELETE FROM recordings WHERE id = $1', [id])
  },

  saveAutomation: async (a) => {
    await query('INSERT INTO automations (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [
      a.automationId,
      a,
    ])
  },
  getAutomation: async (id) => {
    const rows = await query<{ data: AutomationSchema }>('SELECT data FROM automations WHERE id = $1', [id])
    return rows[0]?.data ?? null
  },
  listAutomations: async () => {
    const rows = await query<{ data: AutomationSchema }>('SELECT data FROM automations')
    return rows.map((r) => r.data)
  },
  deleteAutomation: async (id) => {
    await query('DELETE FROM automations WHERE id = $1', [id])
  },

  saveRun: async (r) => {
    await query(
      'INSERT INTO runs (id, automation_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
      [r.runId, r.automationId, r],
    )
  },
  getRun: async (id) => {
    const rows = await query<{ data: RunResult }>('SELECT data FROM runs WHERE id = $1', [id])
    return rows[0]?.data ?? null
  },
  listRuns: async () => {
    const rows = await query<{ data: RunResult }>('SELECT data FROM runs')
    return rows.map((r) => r.data)
  },
  deleteRun: async (id) => {
    await query('DELETE FROM runs WHERE id = $1', [id])
  },

  saveSnapshot: async (runId, html) => {
    await query('INSERT INTO snapshots (run_id, html) VALUES ($1, $2) ON CONFLICT (run_id) DO UPDATE SET html = $2', [
      runId,
      html,
    ])
  },
  getSnapshot: async (runId) => {
    const rows = await query<{ html: string }>('SELECT html FROM snapshots WHERE run_id = $1', [runId])
    return rows[0]?.html ?? null
  },

  saveCredentials: async (automationId, creds) => {
    const enc = encryptSecret(JSON.stringify(creds))
    await query(
      'INSERT INTO credentials (automation_id, enc) VALUES ($1, $2) ON CONFLICT (automation_id) DO UPDATE SET enc = $2',
      [automationId, enc],
    )
  },
  getCredentials: async (automationId) => {
    const rows = await query<{ enc: string }>('SELECT enc FROM credentials WHERE automation_id = $1', [automationId])
    if (!rows[0]) return null
    try {
      return JSON.parse(decryptSecret(rows[0].enc)) as Credentials
    } catch {
      return null
    }
  },
  hasCredentials: async (automationId) => {
    const rows = await query('SELECT 1 FROM credentials WHERE automation_id = $1', [automationId])
    return rows.length > 0
  },
  deleteCredentials: async (automationId) => {
    await query('DELETE FROM credentials WHERE automation_id = $1', [automationId])
  },
}

export const store: Store = dbEnabled ? pgStore : fileStore
