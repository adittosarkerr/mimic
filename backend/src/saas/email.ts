import nodemailer from 'nodemailer'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { encryptSecret, decryptSecret } from '../store/crypto.js'
import { dbEnabled, query } from '../store/db.js'

const DATA_DIR = join(process.cwd(), 'data')

export interface SmtpProviderPreset {
  id: string
  name: string
  host: string
  port: number
  secure: boolean
  appPasswordUrl: string | null
}

/** SMTP presets for the common providers. Users supply an app password (not
 * their real password) — the app-password flow already lives in the UI. */
export const SMTP_PRESETS: SmtpProviderPreset[] = [
  { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, appPasswordUrl: 'https://myaccount.google.com/apppasswords' },
  { id: 'outlook', name: 'Outlook / Hotmail', host: 'smtp-mail.outlook.com', port: 587, secure: false, appPasswordUrl: 'https://account.microsoft.com/security' },
  { id: 'yahoo', name: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, secure: true, appPasswordUrl: 'https://login.yahoo.com/account/security' },
  { id: 'custom', name: 'Custom SMTP', host: '', port: 587, secure: false, appPasswordUrl: null },
]

export interface EmailConfig {
  email: string
  appPassword: string
  host: string
  port: number
  secure: boolean
}

interface EmailStore {
  save(userId: string, cfg: EmailConfig): Promise<void>
  get(userId: string): Promise<EmailConfig | null>
  has(userId: string): Promise<boolean>
  delete(userId: string): Promise<void>
}

/** Local JSON files — used when no Postgres connection string is configured. */
const fileEmailStore: EmailStore = {
  async save(userId, cfg) {
    const dir = join(DATA_DIR, 'email-config')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${userId}.enc`), encryptSecret(JSON.stringify(cfg)), 'utf8')
  },
  async get(userId) {
    try {
      return JSON.parse(decryptSecret(await readFile(join(DATA_DIR, 'email-config', `${userId}.enc`), 'utf8'))) as EmailConfig
    } catch {
      return null
    }
  },
  async has(userId) {
    return existsSync(join(DATA_DIR, 'email-config', `${userId}.enc`))
  },
  async delete(userId) {
    try {
      await unlink(join(DATA_DIR, 'email-config', `${userId}.enc`))
    } catch {
      /* gone */
    }
  },
}

/** Postgres — used in production (Vercel etc.) so configs survive redeploys. */
const pgEmailStore: EmailStore = {
  async save(userId, cfg) {
    const enc = encryptSecret(JSON.stringify(cfg))
    await query(
      'INSERT INTO email_configs (user_id, enc) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET enc = $2',
      [userId, enc],
    )
  },
  async get(userId) {
    const rows = await query<{ enc: string }>('SELECT enc FROM email_configs WHERE user_id = $1', [userId])
    if (!rows[0]) return null
    try {
      return JSON.parse(decryptSecret(rows[0].enc)) as EmailConfig
    } catch {
      return null
    }
  },
  async has(userId) {
    const rows = await query('SELECT 1 FROM email_configs WHERE user_id = $1', [userId])
    return rows.length > 0
  },
  async delete(userId) {
    await query('DELETE FROM email_configs WHERE user_id = $1', [userId])
  },
}

/** Encrypted per-user email/SMTP config. Never returned in cleartext. */
export const emailStore: EmailStore = dbEnabled ? pgEmailStore : fileEmailStore

export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
}

/** Send an email over SMTP using the given config. */
export async function sendEmail(cfg: EmailConfig, msg: { to: string; subject: string; body: string }): Promise<SendResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.email, pass: cfg.appPassword },
    })
    const info = await transporter.sendMail({
      from: cfg.email,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
    })
    return { ok: true, messageId: info.messageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' }
  }
}
