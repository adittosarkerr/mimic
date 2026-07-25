import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'

/** scrypt password hashing — format: salt:hash (both hex). No external deps. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function makeToken(): string {
  return randomBytes(32).toString('hex')
}

/** A REST API key. `mk_live_` prefix so it's recognizable in logs/headers. */
export function makeApiKey(): string {
  return `mk_live_${randomBytes(24).toString('hex')}`
}

/** Mask a key for display: keep the prefix + last 4, hide the middle. */
export function maskApiKey(key: string): string {
  const tail = key.slice(-4)
  const head = key.slice(0, 11) // "mk_live_" + 3
  return `${head}…${tail}`
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
