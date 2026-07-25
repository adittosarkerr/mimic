import { chromium, type Frame, type Locator, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationSchema, RecordedEvent, RecordingSession, RunResult } from '../types.js'
import { collapseInputEvents } from '../inference/schema.js'
import { BROWSER_PROFILE_DIR, findInstalledBrowser } from './browser.js'
import { getAdapter } from './siteAdapters.js'

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Resolve the frame an event targeted by walking its recorded framePath */
function resolveFrame(page: Page, framePath: string[]): Frame {
  let frame: Frame = page.mainFrame()
  for (const hint of framePath) {
    const child = frame
      .childFrames()
      .find((f) => f.url().includes(hint) || f.name() === hint)
    frame = child ?? frame
  }
  return frame
}

/**
 * Auto-generated ids (React useId ":r1a:", radix "radix-:r5:") are random per
 * page load — on a fresh visit the same id lands on a DIFFERENT element. Never
 * trust them for relocation.
 */
function isGeneratedId(id: string): boolean {
  return /^:r[\w]+:$/.test(id) || /^radix-/.test(id) || /^(mui|mantine|headlessui)-/i.test(id)
}

/** Try each selector signal in priority order until one resolves to exactly one visible element */
async function locate(frame: Frame, e: RecordedEvent): Promise<Locator | null> {
  const s = e.selector
  const candidates: Locator[] = []

  if (s.dataTestid) {
    candidates.push(frame.locator(`[data-testid="${s.dataTestid}"], [data-test-id="${s.dataTestid}"], [data-test="${s.dataTestid}"], [data-qa="${s.dataTestid}"]`))
  }
  if (s.id && !isGeneratedId(s.id)) candidates.push(frame.locator(`#${CSS_escape(s.id)}`))
  if (s.name) candidates.push(frame.locator(`[name="${s.name}"]`))
  if (s.ariaLabel) candidates.push(frame.locator(`[aria-label="${s.ariaLabel}"]`))
  if (s.placeholder) candidates.push(frame.locator(`[placeholder="${s.placeholder}"]`))
  if (s.css && !/#\\?:r[\w]+\\?:/.test(s.css)) candidates.push(frame.locator(s.css))
  if (s.xpath) candidates.push(frame.locator(`xpath=${s.xpath}`))
  if (s.textContent && s.textContent.length > 2 && s.textContent.length < 60) {
    candidates.push(frame.getByText(s.textContent, { exact: true }).first())
  }

  for (const loc of candidates) {
    try {
      const count = await loc.count()
      if (count >= 1) {
        const first = loc.first()
        await first.waitFor({ state: 'visible', timeout: 3000 })
        return first
      }
    } catch {
      continue
    }
  }
  return null
}

function CSS_escape(s: string): string {
  return s.replace(/([^\w-])/g, '\\$1')
}

/**
 * For choice variables (clicked options like calendar days or dropdown items):
 * find the element with the NEW text near where the original option lived —
 * search within the recorded selector's ancestor container first, then page-wide.
 */
async function locateChoice(frame: Frame, e: RecordedEvent, newValue: string): Promise<Locator | null> {
  const scopes: Locator[] = []
  if (e.selector.css) {
    const parts = e.selector.css.split(' > ')
    for (const trim of [2, 3]) {
      if (parts.length > trim) {
        scopes.push(frame.locator(parts.slice(0, parts.length - trim).join(' > ')))
      }
    }
  }
  scopes.push(frame.locator('body'))

  for (const scope of scopes) {
    try {
      const candidate = scope.getByText(newValue, { exact: true }).first()
      await candidate.waitFor({ state: 'visible', timeout: 2500 })
      return candidate
    } catch {
      continue
    }
  }
  // Partial match (currency rows like "USD U.S. Dollar", options with counts).
  for (const scope of scopes) {
    try {
      const candidate = scope.getByText(newValue, { exact: false }).first()
      await candidate.waitFor({ state: 'visible', timeout: 1500 })
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Fill a city/destination autocomplete and pick the matching suggestion.
 * Types the value to open the dropdown, waits, then clicks the option whose
 * text contains the value (or the first option). Falls back to Enter, then to
 * a plain fill, so it degrades gracefully.
 */
async function selectAutocomplete(frame: Frame, input: Locator, value: string): Promise<void> {
  // Make sure the value actually LANDS in the box — on re-rendering autocompletes
  // a plain type() can silently no-op, leaving it empty (→ site shows geolocated
  // defaults, e.g. "Sylhet" → random hotels). Type, verify, and retype if needed.
  const ensureTyped = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await input.click().catch(() => {})
      await input.fill('').catch(() => {})
      await input.type(value, { delay: 90 }).catch(() => {})
      await frame.page().waitForTimeout(250)
      const got = (await input.inputValue().catch(() => '')) || ''
      if (got.toLowerCase().includes(value.toLowerCase().slice(0, 4))) return true
    }
    return false
  }
  const typed = await ensureTyped()
  if (!typed) {
    // Couldn't get text in — bail without pressing Enter (Enter on an empty box
    // triggers a garbage default search).
    return
  }

  const optionSel =
    '[data-testid="autocomplete-result"], [role="option"], [role="listbox"] [role="option"], ul[role="listbox"] li, [data-testid*="autocomplete" i] li, [data-testid*="suggestion" i], [class*="autocomplete" i] li, [class*="suggestion" i], [class*="dropdown" i] li, [class*="result-item" i], [class*="option-item" i]'
  // Poll for a suggestion that ACTUALLY matches what we typed. Compare with
  // spacing/punctuation stripped so "KualaLumpur" matches "Kuala Lumpur,
  // Malaysia". Never click a random "first option" (wrong city); only a real
  // match, else search the typed text.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = normalize(value)
  const options = frame.locator(optionSel)
  type Match = { rawTitle: string; title: string; full: string }
  const collect = async (): Promise<Match[]> => {
    const count = Math.min(await options.count().catch(() => 0), 12)
    const out: Match[] = []
    for (let k = 0; k < count; k++) {
      const opt = options.nth(k)
      if (!(await opt.isVisible().catch(() => false))) continue
      const raw = (await opt.innerText().catch(() => '')) || ''
      const rawTitle = (raw.split('\n')[0] || '').trim()
      const title = normalize(rawTitle)
      const full = normalize(raw)
      if (full && wanted && (full.includes(wanted) || wanted.includes(full.slice(0, Math.max(4, wanted.length))))) {
        out.push({ rawTitle, title, full })
      }
    }
    return out
  }
  const rank = (ms: Match[]) =>
    ms.find((m) => m.title === wanted) ??
    ms.find((m) => m.title.startsWith(wanted) && m.title.length <= wanted.length + 2) ??
    ms.find((m) => m.title.startsWith(wanted)) ??
    [...ms].sort((a, b) => a.title.length - b.title.length)[0]

  // Suggestions STREAM in and the list reorders — ranking against a snapshot
  // and then clicking by index lands on whatever moved there (the airport bug).
  // Wait until two consecutive samples agree, then click by the chosen TEXT.
  const deadline = Date.now() + 8000
  let prevSig = ''
  let stable: Match[] | null = null
  while (Date.now() < deadline) {
    const ms = await collect()
    const sig = ms.map((m) => m.title).join('|')
    if (ms.length > 0 && sig === prevSig) {
      stable = ms
      break
    }
    prevSig = sig
    await frame.page().waitForTimeout(450)
  }
  if (stable && stable.length > 0) {
    const best = rank(stable)
    console.log(`[mimic autocomplete] wanted="${wanted}" picked="${best.rawTitle}" of`, stable.map((m) => m.title).slice(0, 6))
    // Click by text so a late reorder can't redirect the click.
    const target = options.filter({ hasText: best.rawTitle }).first()
    await target.click({ timeout: 3000 }).catch(() => {})
    await frame.page().waitForTimeout(400)
    return
  }
  // No matching suggestion after the text is confirmed in the box — search it.
  await input.press('Enter').catch(() => {})
}

/**
 * Find an input to type an autocomplete value into when the recorded target is a
 * suggestion that isn't on the page yet (Booking destination, flight origin, etc.).
 * A KNOWN, STABLE field name (Booking's "ss") is checked FIRST and is deterministic
 * — relying on `:focus` first (the previous priority) was a race: focus can drift
 * to something else between steps, so the SAME automation would sometimes type
 * into the right box and sometimes not, purely by timing. Only fall back to
 * `:focus`/generic guesses for sites without a recognized stable field name.
 */
async function findSearchInput(frame: Frame): Promise<Locator | null> {
  const stableGuesses = ['input[name="ss"]'] // Booking's destination field — always this
  for (const g of stableGuesses) {
    const loc = frame.locator(g).first()
    try {
      if (await loc.isVisible({ timeout: 400 })) return loc
    } catch {
      /* next guess */
    }
  }
  try {
    const focused = frame.locator(':focus').first()
    if ((await focused.count()) > 0) {
      const ok = await focused
        .evaluate((el) => {
          const t = el.tagName.toLowerCase()
          return (
            t === 'input' ||
            t === 'textarea' ||
            (el as HTMLElement).isContentEditable ||
            ['combobox', 'searchbox'].includes(el.getAttribute('role') || '')
          )
        })
        .catch(() => false)
      if (ok) return focused
    }
  } catch {
    /* no focused element */
  }
  const guesses = [
    'input[type="search"]',
    'input[role="combobox"]',
    '[role="combobox"] input',
    'input[placeholder*="destination" i]',
    'input[placeholder*="going" i]',
    'input[aria-label*="destination" i]',
    'input[aria-label*="search" i]',
    'input[type="text"]:not([readonly])',
  ]
  for (const g of guesses) {
    const loc = frame.locator(g).first()
    try {
      if (await loc.isVisible({ timeout: 400 })) return loc
    } catch {
      /* next guess */
    }
  }
  return null
}

/**
 * Last-resort recovery for a choice/option that couldn't be found: treat it as a
 * typed autocomplete — type the value into the search input and pick the matching
 * suggestion. Returns false if there's no input to type into.
 */
async function recoverAutocomplete(frame: Frame, value: string): Promise<boolean> {
  const input = await findSearchInput(frame)
  if (!input) return false
  await selectAutocomplete(frame, input, value)
  return true
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Find a calendar cell for an ISO date. Calendar cells almost always carry a
 * data-date attribute or an aria-label like "Thursday, July 16, 2026" — try
 * both formats. Best-effort; returns null if the calendar isn't showing it.
 */
async function locateDateCell(frame: Frame, iso: string): Promise<Locator | null> {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10))
  const monthName = MONTH_NAMES[m - 1]
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()]

  const tryFind = async (): Promise<Locator | null> => {
    const candidates: Locator[] = [
      frame.locator(`[data-date="${iso}"]`),
      frame.locator(`td[data-date="${iso}"], [aria-label="${weekday}, ${monthName} ${d}, ${y}"]`),
      frame.locator(`[aria-label*="${monthName} ${d}, ${y}"]`),
      frame.locator(`[aria-label*="${monthName} ${d} ${y}"]`),
      frame.locator(`[aria-label*="${d} ${monthName} ${y}"]`),
    ]
    for (const loc of candidates) {
      try {
        const first = loc.first()
        await first.waitFor({ state: 'visible', timeout: 900 })
        return first
      } catch {
        continue
      }
    }
    return null
  }

  let found = await tryFind()
  if (found) return found
  // Target month may be in the future — click the calendar's "next month" arrow
  // until the date shows (or we give up). Booking/most pickers show 2 months.
  const nextBtn = frame
    .locator(
      'button[aria-label*="Next month" i], button[aria-label*="Next" i], [data-testid*="next" i], [aria-label*="next" i][role="button"]',
    )
    .first()
  for (let k = 0; k < 15 && !found; k++) {
    if (!(await nextBtn.isVisible({ timeout: 400 }).catch(() => false))) break
    await nextBtn.click({ timeout: 1200 }).catch(() => {})
    await frame.page().waitForTimeout(300)
    found = await tryFind()
  }
  return found
}

export interface ReplayOptions {
  headless?: boolean
  variableValues?: Record<string, string>
  schema?: AutomationSchema
  captureOutput?: boolean
  /** Assisted mode: open a real visible browser, pause for human CAPTCHA/login. */
  assisted?: boolean
  /**
   * Stealth-headed mode: a REAL (headed) browser rendered OFF-SCREEN with a fresh
   * throwaway profile. Sites like Booking block headless entirely but serve a
   * genuine rendered browser — this beats their bot-wall invisibly (no window the
   * user sees), so "go" can still return results on the mimic site.
   */
  stealthHeaded?: boolean
  /** Login credentials injected at the recording's username/password steps. */
  credentials?: { username: string; password: string }
}

export interface ReplayOutcome {
  result: RunResult
  snapshotHtml: string | null
}

// The shared persistent profile permits only one browser at a time, so runs
// are serialized — each waits for the previous to finish before launching.
let runQueue: Promise<unknown> = Promise.resolve()

/**
 * Hide the stealth browser's window entirely (screen AND taskbar) via Win32
 * ShowWindow(SW_HIDE). Off-screen positioning alone still leaves a taskbar
 * button the user can't meaningfully interact with. Best-effort, async — the
 * page keeps rendering thanks to the no-backgrounding launch flags.
 */
const HIDE_SCRIPT_PATH = join(tmpdir(), 'mimic-hide-window.ps1')
let hideScriptWritten = false
function hideStealthWindow(profileDir: string): void {
  if (process.platform !== 'win32') return
  try {
    if (!hideScriptWritten) {
      writeFileSync(
        HIDE_SCRIPT_PATH,
        `param([string]$Marker)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);' -Name W -Namespace U
for($i=0;$i -lt 25;$i++){
  $p = Get-CimInstance Win32_Process -Filter "Name='brave.exe' OR Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like ('*'+$Marker+'*') } | Select-Object -First 1
  if($p){
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if($proc -and $proc.MainWindowHandle -ne 0){ [U.W]::ShowWindow($proc.MainWindowHandle,0) | Out-Null; break }
  }
  Start-Sleep -Milliseconds 400
}
`,
      )
      hideScriptWritten = true
    }
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HIDE_SCRIPT_PATH, '-Marker', profileDir],
      () => {},
    )
  } catch {
    /* best-effort — window stays off-screen regardless */
  }
}

/**
 * Kill any browser processes still running from a PREVIOUS stealth run that
 * didn't get cleaned up (e.g. the node process was restarted mid-run). Scoped
 * strictly to processes whose command line references a "mimic-stealth-"
 * throwaway profile directory — NEVER touches the user's real browser windows,
 * unlike a blanket process kill. Left-over instances pile up over many runs and
 * can hold stale remote-debugging ports, causing confusing cross-run behavior.
 */
async function reapOrphanedStealthBrowsers(): Promise<void> {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='brave.exe' OR Name='chrome.exe' OR Name='msedge.exe'" ` +
          `| Where-Object { $_.CommandLine -like '*mimic-stealth-*' } ` +
          `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { timeout: 5000 },
      () => resolve(),
    )
  })
}

/**
 * context.close() can hang indefinitely if the browser process is already
 * wedged — since every replay is serialized through one queue, a single hung
 * close() would block every run after it forever. Race it against a timeout.
 */
async function closeWithTimeout(context: import('playwright').BrowserContext, ms = 15000): Promise<void> {
  await Promise.race([
    context.close().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

/**
 * Open a visible browser to a site so the user can log in once. The session is
 * saved to the shared persistent profile, so subsequent (even headless) runs on
 * that site are already signed in. Resolves when the user leaves the login page
 * (login complete), closes the window, or a timeout is reached.
 */
export function loginSession(url: string): Promise<{ ok: boolean; note: string }> {
  const run = runQueue.then(() => doLoginSession(url))
  runQueue = run.catch(() => {})
  return run
}

async function doLoginSession(url: string): Promise<{ ok: boolean; note: string }> {
  const exe = findInstalledBrowser()
  if (!exe) return { ok: false, note: 'No installed browser found to open a login window.' }

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    executablePath: exe,
    viewport: null,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {})
    const started = Date.now()
    let leftLoginFor = 0
    while (Date.now() - started < 300000) {
      await page.waitForTimeout(2000)
      if (page.isClosed()) return { ok: true, note: 'Login window closed — session saved.' }
      const onLogin = isLoginPage(page.url()) || (await detectBotWall(page).catch(() => false))
      leftLoginFor = onLogin ? 0 : leftLoginFor + 2000
      // Considered logged in once off the login page for a few seconds straight.
      if (leftLoginFor >= 6000) return { ok: true, note: 'Signed in — session saved for future runs.' }
    }
    return { ok: true, note: 'Login window timed out — whatever session exists was saved.' }
  } finally {
    await closeWithTimeout(context)
  }
}

export function replaySession(session: RecordingSession, opts: ReplayOptions = {}): Promise<ReplayOutcome> {
  const run = runQueue.then(() => doReplay(session, opts))
  runQueue = run.catch(() => {})
  return run
}

export interface ReplayStep {
  event: RecordedEvent
  override: string | null
  isPassword: boolean
  guests: { adults?: number; children?: number; rooms?: number } | null
  autocomplete: boolean
  /**
   * For autocomplete steps: the ORIGINALLY recorded suggestion text (e.g.
   * "Bangkok"). After substituting a new value, a following recorded click on
   * this stale text must be skipped — replaying it would re-select the old
   * choice (e.g. via a "Trending destinations" card) and wreck the run.
   */
  staleText: string | null
  /**
   * Check-in + check-out sharing ONE recorded calendar click — the recording
   * only ever captured a single date (see ensureCheckoutDate). Click BOTH
   * dates in this one calendar visit instead of just the recorded one.
   */
  dateRange: { checkIn?: string; checkOut?: string } | null
}

/**
 * Produce the ordered, collapsed steps + resolved overrides for a run, reusing
 * the exact same logic as server replay. The extension executes these in the
 * user's own browser (extension-driven replay) so behavior stays consistent.
 */
export function buildReplaySteps(
  session: RecordingSession,
  opts: ReplayOptions,
): { startUrl: string; steps: ReplayStep[]; direct?: boolean; extractScript?: string; waitSelector?: string } {
  const events = collapseInputEvents(session.events).filter((e) => e.type !== 'navigation')

  // Deterministic per-site path (Booking, GoZayaan): hand the extension the
  // site's own results URL + a fixed scraper instead of fragile step replay.
  const directAdapter = opts.schema
    ? getAdapter([opts.schema.startUrl, ...session.events.map((e) => e.url)])
    : null
  const directPlan = directAdapter && opts.schema ? directAdapter.build(opts.schema, opts.variableValues ?? {}) : null
  if (directAdapter && directPlan) {
    return {
      startUrl: directPlan.url,
      steps: [],
      direct: true,
      extractScript: directAdapter.extractScript,
      waitSelector: directPlan.waitSelector,
    }
  }
  // Search the SAME filtered array the steps are built from — navigation events
  // in the recording would otherwise skew every later index.
  const mapIdx = (originalIndex: number): number => {
    const target = session.events[originalIndex]
    if (!target) return -1
    return events.findIndex(
      (e) => e.id === target.id || (e.selector.css === target.selector.css && e.type === target.type),
    )
  }

  const overrides = new Map<number, string>()
  const guestsBy = new Map<number, { adults?: number; children?: number; rooms?: number }>()
  const autoBy = new Set<number>()
  const staleBy = new Map<number, string>()
  const dateRangeBy = new Map<number, { checkIn?: string; checkOut?: string }>()
  if (opts.schema && opts.variableValues) {
    const dateFieldsByIdx = new Map<number, typeof opts.schema.variables>()
    for (const v of opts.schema.variables) {
      if (v.type !== 'date') continue
      const idx = mapIdx(v.eventIndex)
      if (idx < 0) continue
      const arr = dateFieldsByIdx.get(idx) ?? []
      arr.push(v)
      dateFieldsByIdx.set(idx, arr)
    }
    for (const [idx, arr] of dateFieldsByIdx) {
      if (arr.length < 2) continue
      const checkInVar = arr.find((v) => /in|arriv/i.test(v.name)) ?? arr[0]
      const checkOutVar = arr.find((v) => v !== checkInVar)
      const checkInVal = opts.variableValues[checkInVar.name]
      const checkOutVal = checkOutVar ? opts.variableValues[checkOutVar.name] : undefined
      if (checkInVal === undefined) continue
      dateRangeBy.set(idx, { checkIn: checkInVal, checkOut: checkOutVal })
    }

    for (const v of opts.schema.variables) {
      const val = opts.variableValues[v.name]
      if (val === undefined) continue
      const idx = mapIdx(v.eventIndex)
      if (idx < 0) continue
      if (dateRangeBy.has(idx)) continue
      if (v.kind === 'guests' && v.guestType) {
        const g = guestsBy.get(idx) ?? {}
        g[v.guestType] = Math.max(0, parseInt(val, 10) || 0)
        guestsBy.set(idx, g)
      } else {
        overrides.set(idx, val)
        if (v.autocomplete) {
          autoBy.add(idx)
          if (v.sampleValue) staleBy.set(idx, v.sampleValue)
        }
      }
    }
  }

  const credByIdx = new Map<number, string>()
  if (opts.schema?.login && opts.credentials) {
    const pw = mapIdx(opts.schema.login.passwordEventIndex)
    if (pw >= 0) credByIdx.set(pw, opts.credentials.password)
    if (opts.schema.login.usernameEventIndex != null && opts.credentials.username) {
      const un = mapIdx(opts.schema.login.usernameEventIndex)
      if (un >= 0) credByIdx.set(un, opts.credentials.username)
    }
  }

  const steps: ReplayStep[] = events.map((event, i) => ({
    event,
    override: credByIdx.get(i) ?? overrides.get(i) ?? null,
    isPassword: credByIdx.has(i),
    guests: guestsBy.get(i) ?? null,
    autocomplete: autoBy.has(i),
    staleText: staleBy.get(i) ?? null,
    dateRange: dateRangeBy.get(i) ?? null,
  }))

  return { startUrl: session.events[0]?.url ?? '', steps }
}

async function doReplay(session: RecordingSession, opts: ReplayOptions): Promise<ReplayOutcome> {
  const runId = makeId()
  const startedAt = Date.now()
  const events = collapseInputEvents(session.events).filter((e) => e.type !== 'navigation')

  // Map into the SAME filtered array the loop iterates — recordings can contain
  // navigation events, and indexing an unfiltered array here shifts every
  // override after the first navigation onto the wrong (or no) step.
  const mapOriginalToLoopIndex = (originalIndex: number): number => {
    const target = session.events[originalIndex]
    if (!target) return -1
    return events.findIndex(
      (e) => e.id === target.id || (e.selector.css === target.selector.css && e.type === target.type),
    )
  }

  const overrides = new Map<number, string>()
  // Guests overrides (adults/children/rooms) target one occupancy step — collected
  // separately and applied by opening the widget and driving its +/- steppers.
  const guestsByLoopIndex = new Map<number, { adults?: number; children?: number; rooms?: number }>()
  // Autocomplete fields (city/destination): after filling, pick the suggestion.
  const autocompleteIndices = new Set<number>()
  // Recorded suggestion text per autocomplete step ("Bangkok") — replaying a
  // later click on that stale text would re-select the old choice.
  const staleValueByIdx = new Map<number, string>()
  // Two date fields sharing ONE recorded event (a synthesized checkout paired
  // with the only calendar click that actually happened — see
  // ensureCheckoutDate) — click BOTH dates in that one calendar visit rather
  // than fighting over a single override slot for the same index.
  const dateRangeByLoopIndex = new Map<number, { checkIn?: string; checkOut?: string }>()
  if (opts.schema && opts.variableValues) {
    const dateFieldsByIdx = new Map<number, typeof opts.schema.variables>()
    for (const v of opts.schema.variables) {
      if (v.type !== 'date') continue
      const idx = mapOriginalToLoopIndex(v.eventIndex)
      if (idx < 0) continue
      const arr = dateFieldsByIdx.get(idx) ?? []
      arr.push(v)
      dateFieldsByIdx.set(idx, arr)
    }
    for (const [idx, arr] of dateFieldsByIdx) {
      if (arr.length < 2) continue
      const checkInVar = arr.find((v) => /in|arriv/i.test(v.name)) ?? arr[0]
      const checkOutVar = arr.find((v) => v !== checkInVar)
      const checkInVal = opts.variableValues[checkInVar.name]
      const checkOutVal = checkOutVar ? opts.variableValues[checkOutVar.name] : undefined
      if (checkInVal === undefined) continue
      dateRangeByLoopIndex.set(idx, { checkIn: checkInVal, checkOut: checkOutVal })
    }

    for (const v of opts.schema.variables) {
      const val = opts.variableValues[v.name]
      if (val === undefined) continue
      const idx = mapOriginalToLoopIndex(v.eventIndex)
      if (idx < 0) continue
      if (dateRangeByLoopIndex.has(idx)) continue // handled as a pair, above
      if (v.kind === 'guests' && v.guestType) {
        const g = guestsByLoopIndex.get(idx) ?? {}
        g[v.guestType] = Math.max(0, parseInt(val, 10) || 0)
        guestsByLoopIndex.set(idx, g)
      } else {
        overrides.set(idx, val)
        if (v.autocomplete) {
          autocompleteIndices.add(idx)
          if (v.sampleValue) staleValueByIdx.set(idx, v.sampleValue)
        }
      }
    }
  }

  // Inject login credentials at the recorded username/password steps. The
  // password value was redacted during recording; this is where it's supplied.
  const credInjection = new Map<number, string>()
  if (opts.schema?.login && opts.credentials) {
    const pw = mapOriginalToLoopIndex(opts.schema.login.passwordEventIndex)
    if (pw >= 0) credInjection.set(pw, opts.credentials.password)
    if (opts.schema.login.usernameEventIndex != null && opts.credentials.username) {
      const un = mapOriginalToLoopIndex(opts.schema.login.usernameEventIndex)
      if (un >= 0) credInjection.set(un, opts.credentials.username)
    }
  }

  // Deterministic per-site fast path: build the site's own results URL from the
  // form values and scrape with fixed selectors, skipping fragile event replay.
  // build() returns null when it can't resolve the inputs → generic replay runs.
  const adapter = opts.schema
    ? getAdapter([opts.schema.startUrl, ...session.events.map((e) => e.url)])
    : null
  const adapterPlan = adapter && opts.schema ? adapter.build(opts.schema, opts.variableValues ?? {}) : null

  const stealthScript = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
  `
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
  ]

  let browser: import('playwright').Browser | null = null
  let context: import('playwright').BrowserContext
  const assistedActive = opts.assisted === true
  const stealthHeaded = opts.stealthHeaded === true
  const headed = assistedActive || stealthHeaded
  // Fresh throwaway profile for stealth runs — a burned/flagged profile gets
  // blocked, a clean one passes the site's challenge. Cleaned up in `finally`.
  let ephemeralProfile: string | null = null

  if (stealthHeaded) await reapOrphanedStealthBrowsers()

  const exe = findInstalledBrowser()
  if (exe) {
    const profileDir = stealthHeaded
      ? (ephemeralProfile = mkdtempSync(join(tmpdir(), 'mimic-stealth-')))
      : BROWSER_PROFILE_DIR
    const modeArgs = stealthHeaded
      ? [
          // Rendered but off-screen; window itself gets hidden right after launch.
          '--window-position=-3200,-3200',
          '--window-size=1366,768',
          // Keep painting while hidden/occluded — sites must not see a paused tab.
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
        ]
      : assistedActive
        ? ['--start-maximized']
        : []
    context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      executablePath: exe,
      viewport: assistedActive ? null : { width: 1366, height: 768 },
      locale: 'en-US',
      args: [...launchArgs, ...modeArgs],
      ignoreDefaultArgs: ['--enable-automation'],
    })
    await context.addInitScript(stealthScript)
    if (stealthHeaded && ephemeralProfile) hideStealthWindow(ephemeralProfile)
  } else {
    // Fallback: bundled Chromium, no persistent session.
    browser = await chromium.launch({ headless: !assistedActive, args: launchArgs })
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Dhaka',
    })
    await context.addInitScript(stealthScript)
  }

  const page = context.pages()[0] ?? (await context.newPage())

  let stepsExecuted = 0
  let error: string | null = null
  let output: unknown = null
  let snapshotHtml: string | null = null
  let botWallHit = false
  const skippedSteps: string[] = []

  // Assisted: return the moment the response commits so the page renders and
  // the user can see/solve a CAPTCHA. Headless: wait for DOM as before.
  const navigate = async (url: string) => {
    if (assistedActive) {
      await page.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {})
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    }
  }

  try {
    if (events.length === 0 && !adapterPlan) throw new Error('empty session')

    let currentDomain = events[0]?.domain ?? ''

    if (adapterPlan) {
      // Deterministic path: navigate straight to the site's results URL (built
      // from the form values) and let the fixed-selector scraper read results —
      // no step-by-step replay, so the same inputs always give the same results.
      await navigate(adapterPlan.url)
      await page.waitForTimeout(1200)
      await dismissOverlays(page)
      await page.waitForSelector(adapterPlan.waitSelector, { timeout: 20000 }).catch(() => {})
      stepsExecuted = 1
    } else {
    await navigate(events[0].url)
    await page.waitForTimeout(600)
    await dismissOverlays(page)

    currentDomain = events[0].domain
    let prevWasFocusClick = false
    // Set after an autocomplete substitution: the recorded OLD suggestion text.
    // The very next recorded click matching it is part of the replaced action
    // and must be skipped (e.g. it would hit "Bangkok" in Trending destinations).
    let skipStaleText: string | null = null
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    // Total time this WHOLE run is willing to spend waiting on a human across
    // every step combined — not per step (see waitForHuman).
    const humanWaitBudget = { remainingMs: 90000 }

    if (assistedActive) await waitForHuman(page, humanWaitBudget)

    for (let i = 0; i < events.length; i++) {
      const e = events[i]

      if (skipStaleText && e.type === 'click') {
        const stale = skipStaleText
        skipStaleText = null
        const t = (e.selector.textContent ?? '').trim()
        if (t && (norm(t).includes(norm(stale)) || norm(stale).includes(norm(t)))) {
          // Consumed as part of the previous substitution — reset prevWasFocusClick
          // too. Left stale across a skipped step, it wrongly signals "still typing
          // into the same box" to the NEXT (unrelated) step, e.g. a date cell.
          prevWasFocusClick = false
          continue
        }
      }

      if (assistedActive) await waitForHuman(page, humanWaitBudget)

      if (e.domain !== currentDomain && !page.url().includes(e.domain)) {
        await navigate(e.url)
        await page.waitForTimeout(500)
        await dismissOverlays(page)
        currentDomain = e.domain
      }

      const frame = resolveFrame(page, e.selector.framePath)

      // Check-in + check-out sharing ONE recorded calendar click (the recording
      // only ever captured a single date — see ensureCheckoutDate): click BOTH
      // dates in this one calendar visit instead of just the one that was
      // actually recorded, so a checkout the user never clicked while recording
      // still gets set on replay.
      const dateRange = dateRangeByLoopIndex.get(i)
      if (dateRange && e.type === 'click' && dateRange.checkIn) {
        const clickDate = async (iso: string) => {
          let cell = await locateDateCell(frame, iso)
          if (!cell) {
            const openers = [
              frame.locator('[data-testid="searchbox-dates-container"]').first(),
              frame.locator('[data-testid="date-display-field-start"]').first(),
              frame.locator('[aria-label*="Check-in" i]').first(),
              frame.getByText('Select dates', { exact: false }).first(),
            ]
            for (const opener of openers) {
              if (await opener.isVisible({ timeout: 500 }).catch(() => false)) {
                await opener.click({ timeout: 2000 }).catch(() => {})
                await page.waitForTimeout(600)
                break
              }
            }
            cell = await locateDateCell(frame, iso)
          }
          if (cell) {
            await robustClick(page, cell)
            stepsExecuted++
            await page.waitForTimeout(400)
            return true
          }
          return false
        }
        const inOk = await clickDate(dateRange.checkIn)
        if (inOk && dateRange.checkOut) await clickDate(dateRange.checkOut)
        prevWasFocusClick = true
        continue
      }

      // Destination/location substitution: NEVER run this through the generic
      // locate() first. A destination-suggestion click's recorded text is often
      // a common city name ("Kuala Lumpur") that ALSO exists as an unrelated
      // trending-destination shortcut elsewhere on a fresh page — locate()'s
      // last-resort exact-text match can hit THAT stray element instead, which
      // actually clicks through and silently keeps the OLD destination instead
      // of substituting the new one. Go straight to the dedicated flow: open the
      // search box, type the requested value, pick the real matching suggestion.
      if (e.type === 'click' && autocompleteIndices.has(i) && overrides.get(i)) {
        const newVal = overrides.get(i)!
        overrides.delete(i)
        const input = await findSearchInput(frame)
        if (input) {
          await input.click().catch(() => {})
          await selectAutocomplete(frame, input, newVal)
        }
        skipStaleText = staleValueByIdx.get(i) ?? ((e.selector.textContent ?? '').trim() || null)
        stepsExecuted++
        prevWasFocusClick = true
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        await page.waitForTimeout(400)
        continue
      }

      let loc = await locate(frame, e)

      if (!loc && e.type === 'click') {
        // Second chance: late-rendered UI (dropdowns, hydration)
        await page.waitForTimeout(1500)
        loc = await locate(frame, e)

        // Autocomplete fallback: the recorded click was on a suggestion that
        // only appears after typing (e.g. Booking's "New Delhi"). Type the
        // text into the currently focused field and click the suggestion.
        // NEVER for a date or boolean override — those aren't free-text place
        // names, and blindly typing "2026-07-25"/"true" into whatever element
        // happens to still have focus (often the destination box, left focused
        // by an earlier substitution) corrupts it even though this whole branch
        // ultimately fails to find a match. Dates/booleans have their own
        // dedicated handling further down; let this fall through to it untouched.
        const clickText = (overrides.get(i) ?? e.selector.textContent ?? '').trim()
        const clickTextIsDateOrBool = /^\d{4}-\d{2}-\d{2}$/.test(clickText) || clickText === 'true' || clickText === 'false'
        if (!loc && clickText && !clickTextIsDateOrBool && clickText.length <= 40 && prevWasFocusClick) {
          await page.keyboard.type(clickText.slice(0, 30), { delay: 60 })
          await page.waitForTimeout(1500)
          const suggestion = frame.getByText(clickText, { exact: false }).first()
          try {
            await suggestion.waitFor({ state: 'visible', timeout: 3000 })
            loc = suggestion
            overrides.delete(i)
          } catch {
            /* fall through to skip */
          }
        }
      }

      const isToggleInput =
        (e.inputType === 'checkbox' || e.inputType === 'radio') && (e.type === 'input' || e.type === 'change')

      if (!loc && (e.type === 'click' || isToggleInput)) {
        // User turned this filter OFF — nothing to click, and not an error.
        const want = overrides.get(i) ?? (isToggleInput ? (e.value ?? 'true') : 'true')
        if (want === 'false') {
          overrides.delete(i)
          continue
        }
        // Label-text fallback: filters, currency entries, sort options move around
        // in the DOM between visits, but their visible label is stable
        // ("Breakfast included", "BDT"). Strip result counts and find by name.
        const labelText = (e.selector.labelText ?? e.selector.ariaLabel ?? e.selector.textContent ?? '')
          .replace(/:?\s*\d[\d,]*\s*(properties|results|hotels)?\s*$/i, '')
          .trim()
        if (labelText.length >= 2 && labelText.length <= 60) {
          const ladder: Locator[] = [
            frame.getByRole('checkbox', { name: labelText, exact: false }).first(),
            frame.getByLabel(labelText, { exact: false }).first(),
            frame.getByText(labelText, { exact: true }).first(),
            frame.getByText(labelText, { exact: false }).first(),
          ]
          for (const cand of ladder) {
            if (await cand.isVisible({ timeout: 900 }).catch(() => false)) {
              loc = cand
              break
            }
          }
        }
        // A toggle found by its label is applied with a click (a label element
        // doesn't support check()) — do it here and move on.
        if (loc && isToggleInput) {
          overrides.delete(i)
          await robustClick(page, loc)
          stepsExecuted++
          prevWasFocusClick = false
          await page.waitForLoadState('domcontentloaded').catch(() => {})
          await page.waitForTimeout(500)
          continue
        }
      }

      // Calendar day cell with no live match: its recorded selector is positional
      // (nth-of-type) and points at whatever cell sits there NOW, not the date we
      // want — locate() legitimately can't find it. Go straight to the date cell
      // for our actual override value (the correctly-mapped per-field override,
      // not a separate blind queue), reopening the picker first if it's closed.
      const dateOverride = overrides.get(i)
      if (!loc && e.type === 'click' && dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
        let cell = await locateDateCell(frame, dateOverride)
        if (!cell) {
          const openers = [
            frame.locator('[data-testid="searchbox-dates-container"]').first(),
            frame.locator('[data-testid="date-display-field-start"]').first(),
            frame.locator('[aria-label*="Check-in" i]').first(),
            frame.getByText('Select dates', { exact: false }).first(),
          ]
          for (const opener of openers) {
            if (await opener.isVisible({ timeout: 500 }).catch(() => false)) {
              await opener.click({ timeout: 2000 }).catch(() => {})
              await page.waitForTimeout(600)
              break
            }
          }
          cell = await locateDateCell(frame, dateOverride)
        }
        if (cell) {
          await robustClick(page, cell)
          overrides.delete(i)
          stepsExecuted++
          prevWasFocusClick = true
          await page.waitForTimeout(400)
          continue
        }
        const isPastDate = new Date(`${dateOverride}T00:00:00`) < new Date(new Date().toDateString())
        skippedSteps.push(
          isPastDate
            ? `step ${i + 1}: ${dateOverride} is in the past — a live calendar can't select it`
            : `step ${i + 1}: date ${dateOverride} not found in calendar`,
        )
        continue
      }

      if (!loc) {
        const desc = `step ${i + 1}: ${e.type} on ${e.domain}${e.selector.textContent ? ` ("${e.selector.textContent.slice(0, 30)}")` : ''}`
        // Clicks are often decorative/focus-only (rotating placeholders, overlays).
        // Skip and keep going — honest accounting reports it; zero-executed still fails the run.
        skippedSteps.push(desc)
        continue
      }

      switch (e.type) {
        case 'click': {
          // Boolean filter recorded as a click: 'false' means don't apply it.
          const boolVal = overrides.get(i)
          if (boolVal === 'false') {
            overrides.delete(i)
            break
          }
          if (boolVal === 'true') overrides.delete(i)

          const guests = guestsByLoopIndex.get(i)
          if (guests) {
            // Occupancy widget: open it (this click), then drive the +/- steppers.
            // A recorded second click on the box can TOGGLE the panel closed —
            // if no steppers were visible, click again to reopen and retry.
            await robustClick(page, loc)
            await page.waitForTimeout(600)
            const found = await setGuestCounts(page, guests)
            if (!found) {
              await robustClick(page, loc)
              await page.waitForTimeout(600)
              await setGuestCounts(page, guests)
            }
            break
          }
          const choiceValue = overrides.get(i)
          if (choiceValue !== undefined && choiceValue !== e.selector.textContent?.trim()) {
            // Date substitution: an ISO value means click the calendar cell for that date.
            const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(choiceValue) ? choiceValue : null
            const substitute = isoDate
              ? (await locateDateCell(frame, isoDate)) ?? (await locateChoice(frame, e, choiceValue))
              : await locateChoice(frame, e, choiceValue)
            if (!substitute) {
              // The "option" is really a typed autocomplete suggestion (city /
              // destination) that only appears after typing. Type it and pick it.
              // NEVER do this for a date — typing an ISO date into a search box is
              // exactly the "2025-03-16 → random hotel" garbage bug.
              const recovered = !isoDate && (await recoverAutocomplete(frame, choiceValue))
              if (!recovered) {
                throw new Error(
                  `step ${i + 1} on ${e.domain}: could not find option "${choiceValue}" (recorded choice was "${e.selector.textContent}")`,
                )
              }
            } else {
              await robustClick(page, substitute)
            }
          } else {
            await robustClick(page, loc)
          }
          break
        }
        case 'input':
        case 'change': {
          // Credential injection takes priority for login field steps.
          const value = credInjection.get(i) ?? overrides.get(i) ?? e.value ?? ''
          if (e.inputType === 'select') {
            await loc.selectOption(value)
          } else if (e.inputType === 'checkbox' || e.inputType === 'radio') {
            // The located element may not be an actual <input type=checkbox> (id
            // drift, label wrapper). check()/uncheck() would throw and kill the
            // run — verify first, click as fallback, and never fail a whole run
            // over one filter.
            const realToggle = await loc
              .evaluate((el) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
              .catch(() => false)
            if (realToggle) {
              if (value === 'true') await loc.check({ timeout: 4000 }).catch(() => {})
              else await loc.uncheck({ timeout: 4000 }).catch(() => {})
            } else if (value === 'true') {
              await robustClick(page, loc)
            }
            // value false + not a real toggle → nothing to un-apply on a fresh page.
          } else if (autocompleteIndices.has(i)) {
            // City/destination autocomplete: type to open the suggestion list,
            // then click the option that matches — a plain fill won't register
            // the selection (Booking, flights, etc.).
            await selectAutocomplete(frame, loc, value)
            skipStaleText = staleValueByIdx.get(i) ?? null
          } else {
            await loc.fill(value)
          }
          break
        }
        case 'keydown':
          if (e.key) await loc.press(e.key)
          break
        case 'submit':
          break
      }

      stepsExecuted++
      prevWasFocusClick = e.type === 'click'
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(400)
    }
    } // end generic event-replay path (adapter runs skip straight to results)

    // Guarantee guest counts: if the results URL itself carries occupancy params
    // (group_adults / group_children / no_rooms), patch them to the requested
    // values and reload — widget DOMs shift constantly, URLs don't.
    const wantedGuests = [...guestsByLoopIndex.values()].reduce<{ adults?: number; children?: number; rooms?: number }>(
      (a, g) => ({ ...a, ...g }),
      {},
    )
    if (!adapterPlan && Object.keys(wantedGuests).length > 0) {
      try {
        const u = new URL(page.url())
        const paramMap: [keyof typeof wantedGuests, string][] = [
          ['adults', 'group_adults'],
          ['children', 'group_children'],
          ['rooms', 'no_rooms'],
        ]
        let changed = false
        for (const [key, param] of paramMap) {
          const v = wantedGuests[key]
          if (v !== undefined && u.searchParams.has(param) && u.searchParams.get(param) !== String(v)) {
            u.searchParams.set(param, String(v))
            changed = true
          }
        }
        if (changed) {
          await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
          await page.waitForTimeout(1500)
        }
      } catch {
        /* URL not parseable — leave as-is */
      }
    }

    if (opts.captureOutput !== false) {
      await page.waitForLoadState('networkidle').catch(() => {})
      // Close any open calendars / dropdowns / popovers left over from the last
      // step so the captured page shows clean results, not an overlay.
      await closeOverlays(page)
      // Nudge lazy-loaded content (thumbnails, infinite lists) into loading:
      // scroll the whole page in steps so virtualized/lazy images all render,
      // then trigger native lazy-loading before scrolling back to top.
      for (let i = 1; i <= 8; i++) {
        await page.evaluate(`window.scrollBy(0, window.innerHeight * 0.9)`)
        await page.waitForTimeout(350)
      }
      await page.evaluate(`
        document.querySelectorAll('img[loading="lazy"]').forEach(i => i.loading = 'eager');
        document.querySelectorAll('img[data-src]').forEach(i => { if (!i.src || i.src.startsWith('data:')) i.src = i.getAttribute('data-src'); });
      `).catch(() => {})
      await page.waitForTimeout(700)
      await page.evaluate('window.scrollTo(0, 0)')
      await page.waitForTimeout(600)
      output = adapterPlan ? await page.evaluate(adapter!.extractScript) : await extractOutput(page)
      snapshotHtml = await captureSnapshot(page)
    }

    if (!assistedActive && (await detectBotWall(page))) {
      botWallHit = true
      throw new Error(
        `${currentDomain} showed a CAPTCHA / anti-bot check. Retrying in a visible browser so you can solve it…`,
      )
    }

    if (stepsExecuted === 0 && events.length > 0) {
      throw new Error(
        `no steps could be executed — every selector failed to match. First miss: ${skippedSteps[0] ?? 'unknown'}. The site may have changed, or it blocks automation.`,
      )
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    // A mid-step failure is very often a CAPTCHA overlay stealing clicks, or the
    // site bounced us to a sign-in page. Either way, escalate to an assisted
    // (visible) run so the user can solve/log in — the persistent profile then
    // keeps that session for future headless runs.
    if (!assistedActive && !page.isClosed()) {
      const wall = await detectBotWall(page).catch(() => false)
      const loginRedirect = isLoginPage(page.url())
      if (wall || loginRedirect) {
        botWallHit = true
        const host = new URL(page.url()).hostname
        error = loginRedirect
          ? `${host} needs you to sign in first. Opening a visible browser — log in there once and it will remember you.`
          : `${host} put up a CAPTCHA. Retrying in a visible browser so you can solve it…`
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    else await closeWithTimeout(context)
    if (ephemeralProfile) {
      try {
        rmSync(ephemeralProfile, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  return {
    result: {
      runId,
      automationId: opts.schema?.automationId ?? 'adhoc',
      status: error ? 'failed' : 'success',
      startedAt,
      finishedAt: Date.now(),
      output,
      error: error ?? (skippedSteps.length > 0 ? `completed, but ${skippedSteps.length} step(s) skipped: ${skippedSteps.join('; ')}` : null),
      stepsExecuted,
      stepsTotal: events.length,
      skippedSteps,
      hasSnapshot: snapshotHtml !== null,
      botWall: botWallHit,
      assisted: assistedActive,
    },
    snapshotHtml,
  }
}

/**
 * Assisted mode: if the visible page is showing a CAPTCHA/anti-bot wall, stop
 * and wait for the human to solve it in the browser window. Polls until the
 * wall clears or a timeout. Non-fatal on timeout — the run then proceeds and
 * fails honestly if the wall is still up.
 *
 * `budget` is a SHARED, mutable counter (in ms) across the WHOLE replay, not a
 * per-call allowance — this is called on every step, and without a shared cap a
 * wall that never clears could cost up to maxMs on EACH of a dozen steps
 * (potentially tens of minutes total). Once the run-wide budget is spent, stop
 * waiting entirely and let the replay proceed/fail honestly instead of hanging.
 */
async function waitForHuman(page: Page, budget: { remainingMs: number }, maxMs = 60000): Promise<void> {
  const blocked = async () =>
    (await detectBotWall(page).catch(() => false)) || isLoginPage(page.url())
  if (!(await blocked())) return
  if (budget.remainingMs <= 0) return
  console.log('[mimic assisted] sign-in or verification needed — complete it in the browser window; the run will continue automatically…')
  const started = Date.now()
  const cap = Math.min(maxMs, budget.remainingMs)
  while (Date.now() - started < cap) {
    await page.waitForTimeout(2000)
    budget.remainingMs -= 2000
    if (page.isClosed()) return
    if (!(await blocked())) {
      console.log('[mimic assisted] done — continuing.')
      await page.waitForTimeout(1500)
      return
    }
  }
  console.log('[mimic assisted] timed out waiting for sign-in / verification.')
}

/**
 * Set occupancy counts in a stepper widget (Booking-style: +/- buttons with
 * aria-labels like "Increase number of Children"). Strategy: press "-" to the
 * minimum (harmless once at floor), then "+" up to the target — avoids needing
 * to read the current value. Any child-age <select> is set to 0 ("0 years old").
 */
async function setGuestCounts(
  page: Page,
  target: { adults?: number; children?: number; rooms?: number },
): Promise<boolean> {
  const groups: { key: 'adults' | 'children' | 'rooms'; word: string; min: number }[] = [
    { key: 'adults', word: 'adult', min: 1 },
    { key: 'children', word: 'child', min: 0 },
    { key: 'rooms', word: 'room', min: 1 },
  ]
  let foundSteppers = false
  for (const { key, word, min } of groups) {
    const want = target[key]
    if (want === undefined) continue
    const dec = page
      .locator(`button[aria-label*="ecrease" i][aria-label*="${word}" i], button[aria-label*="remove" i][aria-label*="${word}" i]`)
      .first()
    const inc = page
      .locator(`button[aria-label*="ncrease" i][aria-label*="${word}" i], button[aria-label*="add" i][aria-label*="${word}" i]`)
      .first()
    if (await inc.isVisible({ timeout: 800 }).catch(() => false)) {
      foundSteppers = true
      // Down to the floor.
      for (let k = 0; k < 12; k++) {
        if (!(await dec.isEnabled({ timeout: 500 }).catch(() => false))) break
        await dec.click({ timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(120)
      }
      // Up to the target.
      const clicks = Math.max(0, want - min)
      for (let k = 0; k < clicks; k++) {
        await inc.click({ timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(150)
      }
      continue
    }
    // Structural fallback — steppers without aria-labels (current Booking).
    // STRICT: the row must hold the group word + a number, have EXACTLY two
    // near-textless (glyph) buttons, and the count must move the right way
    // after ONE click — otherwise abort immediately (never spam-click a page).
    const ok = (await page
      .evaluate(
        `(async () => {
          const word = ${JSON.stringify(word)}, want = ${want}, minVal = ${min};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const isVis = (el) => el.offsetParent !== null;
          const roots = Array.from(
            document.querySelectorAll('[role="dialog"], [data-testid*="popup" i], [class*="popover" i], [class*="dropdown" i]'),
          ).filter(isVis);
          if (roots.length === 0) return false;
          const isGlyphBtn = (b) => ((b.textContent || '').trim().length <= 2);
          let row = null;
          for (const el of roots.flatMap((r) => Array.from(r.querySelectorAll('div, li')))) {
            if (!isVis(el)) continue;
            const t = el.textContent || '';
            if (t.length >= 60) continue;
            if (!new RegExp('\\\\b' + word, 'i').test(t)) continue;
            if (!/\\d/.test(t)) continue;
            // Exactly 2 glyph buttons for a simple row (adults/rooms); children's
            // row often grows an age-select control once count>0, so also accept
            // ANY number of buttons as long as the FIRST/LAST stay glyph-styled
            // (the age-selector's own controls sit strictly between them).
            const bs = Array.from(el.querySelectorAll('button'));
            if (bs.length >= 2 && isGlyphBtn(bs[0]) && isGlyphBtn(bs[bs.length - 1])) { row = el; break; }
          }
          if (!row) return false;
          const bs = row.querySelectorAll('button');
          const dec = bs[0], inc = bs[bs.length - 1];
          const cur = () => { const m = (row.textContent || '').match(/\\d+/); return m ? parseInt(m[0], 10) : null; };
          let c = cur();
          if (c == null) return false;
          if (c === want) return true;
          const target = Math.max(want, minVal);
          const btn = c < target ? inc : dec;
          const dir = c < target ? 1 : -1;
          // Probe click: verify the count moves the expected way, else abort.
          btn.click(); await sleep(250);
          let n = cur();
          if (n == null || n !== c + dir) return false;
          c = n;
          let guard = 0;
          while (c !== target && guard++ < 12) {
            btn.click(); await sleep(250);
            n = cur();
            if (n == null || n === c) break;
            c = n;
          }
          return true;
        })()`,
      )
      .catch(() => false)) as boolean
    if (ok) foundSteppers = true
  }
  // Default any child-age selects to 0.
  const ageSelects = page.locator('select[aria-label*="age" i], select[name*="age" i]')
  const count = await ageSelects.count().catch(() => 0)
  for (let k = 0; k < count; k++) {
    await ageSelects.nth(k).selectOption(['0', '0 years old', '1']).catch(() => {})
  }
  await page.waitForTimeout(300)
  return foundSteppers
}

/** Does this URL look like a sign-in / auth page the site redirected us to? */
function isLoginPage(url: string): boolean {
  return /accounts\.google\.com|\/signin|\/login|\/auth|\/sso|login\.microsoftonline|appleid\.apple\.com/i.test(url)
}

/** Detect common CAPTCHA / anti-bot interstitials by their well-known markers */
async function detectBotWall(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(`(() => {
      const sel = [
        '#baxia-dialog-content', '.baxia-dialog', 'iframe[src*="captcha"]',
        'iframe[title*="captcha" i]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
        '#px-captcha', '[class*="captcha" i]', '#challenge-running', '#cf-challenge-running',
      ];
      for (const s of sel) { if (document.querySelector(s)) return true; }
      const t = (document.body.innerText || '').toLowerCase();
      return /are you (a )?human|verify you are|confirm you.re not a robot|complete the (security )?check/.test(t);
    })()`) as boolean
  } catch {
    return false
  }
}

/**
 * Close open calendars, dropdowns, and popovers so the captured output shows the
 * actual results page — not an overlay covering it (e.g. Booking's date picker
 * left open after selecting dates). Press Escape, click a neutral corner, and
 * hide any obvious still-open floating layers.
 */
async function closeOverlays(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(200)
    // Click a neutral spot (top-left header area) to dismiss focus-open widgets.
    await page.mouse.click(5, 5).catch(() => {})
    await page.waitForTimeout(300)
    // Hide leftover open date-picker / listbox popovers that overlay content.
    await page.evaluate(`
      const sel = '[data-testid*="calendar" i], [class*="calendar" i][class*="open" i], [role="dialog"][class*="calendar" i], [aria-label*="calendar" i][role="dialog"]';
      document.querySelectorAll(sel).forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 200) el.style.display = 'none';
      });
    `).catch(() => {})
    await page.waitForTimeout(200)
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort dismissal of overlays that block interaction (cookie/consent banners
 * AND modal sign-in / promo traps like Booking's, which intercept clicks). Not
 * CAPTCHAs. Clicks accept/close controls and presses Escape; safe to call often.
 */
async function dismissOverlays(page: Page): Promise<void> {
  // 1) Consent/cookie accept buttons.
  const acceptLabels = ['Accept all', 'Accept All', 'I agree', 'Accept', 'Got it', 'OK', 'Allow all', 'Continue']
  for (const label of acceptLabels) {
    try {
      const btn = page.getByRole('button', { name: label, exact: false }).first()
      if (await btn.isVisible({ timeout: 250 })) {
        await btn.click({ timeout: 1500 })
        await page.waitForTimeout(300)
        break
      }
    } catch {
      /* none present */
    }
  }
  // 2) Modal dismiss/close buttons (Booking sign-in trap, promo popups).
  const closeSelectors = [
    'button[aria-label="Dismiss sign-in info."]',
    '[aria-label*="Dismiss" i]',
    '[data-testid*="close" i]',
    'button[aria-label*="Close" i]',
    'button[title*="Close" i]',
  ]
  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 200 })) {
        await btn.click({ timeout: 1200 }).catch(() => {})
        await page.waitForTimeout(250)
      }
    } catch {
      /* none present */
    }
  }
  // 3) Escape closes most remaining popovers.
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(150)
}

/**
 * Click that survives overlay interception — the #1 cause of replay failure on
 * complex sites. Tries a normal click; if an overlay steals the pointer, dismiss
 * overlays and retry; finally force-click (bypasses the intercept check).
 */
async function robustClick(page: Page, loc: Locator): Promise<void> {
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  try {
    await loc.click({ timeout: 4000 })
    return
  } catch {
    await dismissOverlays(page)
  }
  try {
    await loc.click({ timeout: 4000 })
    return
  } catch {
    // Last resort: force past whatever is intercepting.
    await loc.click({ timeout: 4000, force: true })
  }
}

/**
 * Capture the final page as standalone HTML: scripts stripped (rendered DOM
 * already reflects their work), URLs resolved via <base>, links open in new tabs.
 */
async function captureSnapshot(page: Page): Promise<string | null> {
  try {
    const html = await page.content()
    const stripped = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
    const baseTag = `<base href="${page.url()}" target="_blank">`
    if (/<head[^>]*>/i.test(stripped)) {
      return stripped.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    }
    return baseTag + stripped
  } catch {
    return null
  }
}

/**
 * Generic structured extraction. Finds the page's dominant repeating pattern
 * (the results list) by grouping links under a shared container signature,
 * then extracts title/link/thumbnail/meta per item. Falls back to plain links.
 */
interface ExtractedItem {
  title: string
  href: string | null
  thumbnail: string | null
  meta: string[]
}

interface ExtractedOutput {
  title: string
  url: string
  results: ExtractedItem[]
}

/**
 * Known thumbnail URL patterns for sites that lazy-load images too aggressively
 * for in-page extraction. Purely additive — generic extraction still runs first.
 */
const THUMBNAIL_RULES: { match: RegExp; build: (m: RegExpMatchArray) => string }[] = [
  {
    match: /youtube\.com\/watch\?.*v=([\w-]{11})/,
    build: (m) => `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
  },
  {
    match: /youtu\.be\/([\w-]{11})/,
    build: (m) => `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
  },
  {
    match: /youtube\.com\/shorts\/([\w-]{11})/,
    build: (m) => `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
  },
]

function enrichThumbnails(output: ExtractedOutput): ExtractedOutput {
  // A "thumbnail" repeated across many items is a sprite/logo/icon, not content
  const freq = new Map<string, number>()
  for (const item of output.results) {
    if (item.thumbnail) freq.set(item.thumbnail, (freq.get(item.thumbnail) ?? 0) + 1)
  }
  const total = output.results.length
  for (const item of output.results) {
    if (item.thumbnail) {
      const count = freq.get(item.thumbnail) ?? 0
      if (count >= 3 && count >= total / 2) item.thumbnail = null
      else if (/\.svg(\?|$)|sprite|icon/i.test(item.thumbnail)) item.thumbnail = null
    }
  }
  for (const item of output.results) {
    if (item.thumbnail || !item.href) continue
    for (const rule of THUMBNAIL_RULES) {
      const m = item.href.match(rule.match)
      if (m) {
        item.thumbnail = rule.build(m)
        break
      }
    }
  }
  return output
}

async function extractOutput(page: Page): Promise<unknown> {
  const raw = (await page.evaluate(EXTRACT_SCRIPT)) as ExtractedOutput
  return enrichThumbnails(raw)
}

/**
 * Kept as a raw string: tsx/esbuild inject a __name helper into serialized
 * function bodies which doesn't exist inside the page context.
 */
const EXTRACT_SCRIPT = `(() => {
  const abs = (u) => {
    if (!u) return null;
    try { return new URL(u, location.href).toString(); } catch { return null; }
  };

  // Site-specific: Booking property cards yield far cleaner results than the
  // generic anchor grouping (hotel name + price + score instead of stray links).
  const propCards = Array.from(document.querySelectorAll('[data-testid="property-card"]'));
  if (propCards.length >= 3) {
    const items = [];
    for (const card of propCards.slice(0, 40)) {
      const name = (card.querySelector('[data-testid="title"]') || {}).textContent;
      const linkEl = card.querySelector('a[href]');
      const href = linkEl ? abs(linkEl.getAttribute('href')) : null;
      const img = card.querySelector('img');
      let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      const price = (card.querySelector('[data-testid="price-and-discounted-price"]') || {}).textContent;
      const scoreRaw = (card.querySelector('[data-testid="review-score"]') || {}).textContent;
      const dist = (card.querySelector('[data-testid="distance"]') || {}).textContent;
      const meta = [price, scoreRaw, dist]
        .map((t) => (t || '').trim().replace(/\\s+/g, ' '))
        .filter((t) => t.length > 0)
        .slice(0, 4);
      const title = (name || '').trim().replace(/\\s+/g, ' ');
      if (title) items.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta });
    }
    if (items.length >= 3) return { title: document.title, url: location.href, results: items };
  }

  // Structured content items (articles / posts / cards) — deterministic and in
  // DOM order, so blogs & listing pages (WordPress like FitGirl, news, shops)
  // give the SAME clean list every run instead of a random pick of stray links.
  const cleanT = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  let blocks = Array.from(document.querySelectorAll('article'));
  if (blocks.length < 3) {
    blocks = Array.from(document.querySelectorAll('[class*="post"],[class*="card"],[class*="result"],[class*="listing"]'))
      .filter((el) => el.querySelector('a[href]') && (el.querySelector('h1,h2,h3,h4') || el.querySelector('[class*="title"]')));
  }
  if (blocks.length >= 3) {
    const items = [];
    const seen = new Set();
    for (const b of blocks.slice(0, 80)) {
      const titleLink =
        b.querySelector('h1 a[href], h2 a[href], h3 a[href], h4 a[href], [class*="title"] a[href], a[class*="title"][href]') ||
        b.querySelector('a[href]');
      if (!titleLink) continue;
      const href = abs(titleLink.getAttribute('href'));
      const heading = b.querySelector('h1, h2, h3, h4');
      const title = cleanT(titleLink.textContent) || cleanT(heading ? heading.textContent : '');
      if (!href || !title || title.length < 2 || seen.has(href)) continue;
      seen.add(href);
      const img = b.querySelector('img');
      let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null;
      if (thumb && thumb.startsWith('data:')) thumb = null;
      const p = b.querySelector('p');
      const excerpt = cleanT(p ? p.textContent : '').slice(0, 130);
      const meta = excerpt && excerpt !== title && !title.includes(excerpt) ? [excerpt] : [];
      items.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta });
      if (items.length >= 40) break;
    }
    if (items.length >= 3) return { title: document.title, url: location.href, results: items };
  }

  const signature = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      parts.push(node.tagName);
      node = node.parentElement;
    }
    return parts.join('>');
  };

  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
    const text = (a.textContent || '').trim();
    const rect = a.getBoundingClientRect();
    return text.length > 8 && rect.width > 0;
  });

  const groups = new Map();
  for (const a of anchors) {
    const sig = signature(a);
    const arr = groups.get(sig) || [];
    arr.push(a);
    groups.set(sig, arr);
  }

  let best = [];
  let bestScore = 0;
  for (const els of groups.values()) {
    if (els.length < 3) continue;
    const avgLen = els.reduce((s, e) => s + Math.min((e.textContent || '').trim().length, 120), 0) / els.length;
    const score = els.length * avgLen;
    if (score > bestScore) { bestScore = score; best = els; }
  }

  const itemContainer = (a) => {
    let node = a;
    for (let i = 0; i < 5; i++) {
      const parent = node.parentElement;
      if (!parent) break;
      const gp = parent.parentElement;
      const siblingsWithLinks = Array.from(gp ? gp.children : []).filter((c) => c.querySelector('a[href]'));
      if (siblingsWithLinks.length >= 3) return parent;
      node = parent;
    }
    return a.parentElement || a;
  };

  const clean = (s) => s.trim().replace(/\\s+/g, ' ');
  const dedupeWords = (s) => {
    const half = Math.floor(s.length / 2);
    const a = s.slice(0, half).trim();
    const b = s.slice(half).trim();
    return a === b ? a : s;
  };

  const items = [];
  const seenHref = new Set();
  for (const a of best.slice(0, 60)) {
    const href = abs(a.getAttribute('href'));
    if (!href || seenHref.has(href)) continue;
    seenHref.add(href);

    const container = itemContainer(a);
    const imgSrc = (img) => {
      const s = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-thumb') || '';
      if (!s || s.startsWith('data:')) return null;
      return abs(s);
    };
    let thumbnail = null;
    let bestArea = 0;
    let scope = container;
    for (let up = 0; up < 3 && scope; up++) {
      for (const img of Array.from(scope.querySelectorAll('img'))) {
        const src = imgSrc(img);
        if (!src) continue;
        const r = img.getBoundingClientRect();
        const area = Math.max(r.width * r.height, img.naturalWidth * img.naturalHeight);
        if (area > bestArea && area > 900) { bestArea = area; thumbnail = src; }
      }
      if (thumbnail) break;
      for (const el of Array.from(scope.querySelectorAll('*')).slice(0, 30)) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\\(["']?(.+?)["']?\\)/);
        if (m && !m[1].startsWith('data:')) { thumbnail = abs(m[1]); break; }
      }
      if (thumbnail) break;
      scope = scope.parentElement;
    }

    const title = dedupeWords(clean(a.textContent || ''));

    const metaSet = new Set();
    container.querySelectorAll('span, small, time, cite, p').forEach((el) => {
      const t = dedupeWords(clean(el.textContent || ''));
      if (t && t !== title && t.length > 2 && t.length < 90 && !title.includes(t)) metaSet.add(t);
    });

    items.push({ title: title.slice(0, 160), href, thumbnail, meta: Array.from(metaSet).slice(0, 4) });
    if (items.length >= 40) break;
  }

  if (items.length === 0) {
    const seen = new Set();
    for (const a of anchors) {
      const text = clean(a.textContent || '');
      const href = abs(a.getAttribute('href'));
      if (text.length > 15 && text.length < 200 && href && !seen.has(text)) {
        seen.add(text);
        items.push({ title: text, href, thumbnail: null, meta: [] });
      }
      if (items.length >= 40) break;
    }
  }

  return { title: document.title, url: location.href, results: items };
})()`
