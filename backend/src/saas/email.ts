import nodemailer from 'nodemailer'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { encryptSecret, decryptSecret } from '../store/crypto.js'

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

/** Encrypted per-user email/SMTP config. Never returned in cleartext. */
export const emailStore = {
  async save(userId: string, cfg: EmailConfig): Promise<void> {
    const dir = join(DATA_DIR, 'email-config')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${userId}.enc`), encryptSecret(JSON.stringify(cfg)), 'utf8')
  },
  async get(userId: string): Promise<EmailConfig | null> {
    try {
      return JSON.parse(decryptSecret(await readFile(join(DATA_DIR, 'email-config', `${userId}.enc`), 'utf8'))) as EmailConfig
    } catch {
      return null
    }
  },
  has(userId: string): boolean {
    return existsSync(join(DATA_DIR, 'email-config', `${userId}.enc`))
  },
  async delete(userId: string): Promise<void> {
    try {
      await unlink(join(DATA_DIR, 'email-config', `${userId}.enc`))
    } catch {
      /* gone */
    }
  },
}

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
