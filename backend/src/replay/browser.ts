import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Playwright's bundled Chromium fails to launch headed on some Windows setups
 * ("side-by-side configuration is incorrect"). For assisted (visible) runs we
 * use an installed Chromium-family browser instead. Returns an executablePath
 * or null if none found (caller falls back to bundled/headless).
 */
export function findInstalledBrowser(): string | null {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] ?? ''

  const candidates = [
    join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local && join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    join(pf86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean) as string[]

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * One persistent browser profile shared by every run (headless and assisted).
 * A login done once — in an assisted window — is saved here, so subsequent
 * headless runs on that site are already signed in.
 */
export const BROWSER_PROFILE_DIR = join(process.cwd(), 'data', 'browser-profile')
