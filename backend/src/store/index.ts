import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationSchema, Credentials, RecordingSession, RunResult } from '../types.js'
import { encryptSecret, decryptSecret } from './crypto.js'

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

export const store = {
  saveRecording: (s: RecordingSession) => writeJson('recordings', s.id, s),
  getRecording: (id: string) => readJson<RecordingSession>('recordings', id),
  listRecordings: () => listJson<RecordingSession>('recordings'),
  deleteRecording: (id: string) => deleteJson('recordings', id),

  saveAutomation: (a: AutomationSchema) => writeJson('automations', a.automationId, a),
  getAutomation: (id: string) => readJson<AutomationSchema>('automations', id),
  listAutomations: () => listJson<AutomationSchema>('automations'),
  deleteAutomation: (id: string) => deleteJson('automations', id),

  saveRun: (r: RunResult) => writeJson('runs', r.runId, r),
  getRun: (id: string) => readJson<RunResult>('runs', id),
  listRuns: () => listJson<RunResult>('runs'),
  deleteRun: (id: string) => deleteJson('runs', id),

  saveSnapshot: async (runId: string, html: string) => {
    const dir = await ensureDir('snapshots')
    await writeFile(join(dir, `${runId}.html`), html, 'utf8')
  },
  getSnapshot: async (runId: string): Promise<string | null> => {
    try {
      return await readFile(join(DATA_DIR, 'snapshots', `${runId}.html`), 'utf8')
    } catch {
      return null
    }
  },

  // Credentials are encrypted at rest and never returned in cleartext except to
  // the replay engine at run time.
  saveCredentials: async (automationId: string, creds: Credentials) => {
    const dir = await ensureDir('credentials')
    await writeFile(join(dir, `${automationId}.enc`), encryptSecret(JSON.stringify(creds)), 'utf8')
  },
  getCredentials: async (automationId: string): Promise<Credentials | null> => {
    try {
      const blob = await readFile(join(DATA_DIR, 'credentials', `${automationId}.enc`), 'utf8')
      return JSON.parse(decryptSecret(blob)) as Credentials
    } catch {
      return null
    }
  },
  hasCredentials: (automationId: string): boolean =>
    existsSync(join(DATA_DIR, 'credentials', `${automationId}.enc`)),
  deleteCredentials: async (automationId: string) => {
    try {
      await unlink(join(DATA_DIR, 'credentials', `${automationId}.enc`))
    } catch {
      /* already gone */
    }
  },
}
