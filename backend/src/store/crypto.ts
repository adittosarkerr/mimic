import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), 'data')
const KEY_FILE = join(DATA_DIR, '.cred-key')

/**
 * Local encryption key for credentials at rest. Generated once and stored in a
 * restricted-permission file. This protects stored passwords from casual disk
 * reads — it is NOT a substitute for a real secrets manager in production.
 */
function getKey(): Buffer {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE)
  mkdirSync(DATA_DIR, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(KEY_FILE, key)
  try {
    chmodSync(KEY_FILE, 0o600)
  } catch {
    /* best-effort on non-POSIX */
  }
  return key
}

/** Returns base64(iv | authTag | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function decryptSecret(blob: string): string {
  const raw = Buffer.from(blob, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const enc = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
