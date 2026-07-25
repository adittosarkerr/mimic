import type { RecordedEvent, RecordingSession, RuntimeMessage, SiteSegment } from '../shared/types'

/**
 * MV3 service workers are killed after ~30s idle. All recording state must
 * live in chrome.storage.local and be re-read lazily on every message.
 */
interface PersistedState {
  recording: boolean
  session: RecordingSession | null
}

let cache: PersistedState | null = null

async function loadState(): Promise<PersistedState> {
  if (cache) return cache
  const raw = await chrome.storage.local.get(['recording', 'session'])
  cache = {
    recording: raw.recording === true,
    session: (raw.session as RecordingSession | undefined) ?? null,
  }
  return cache
}

async function saveState(state: PersistedState): Promise<void> {
  cache = state
  await chrome.storage.local.set({ recording: state.recording, session: state.session })
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function rebuildSegments(events: RecordedEvent[]): SiteSegment[] {
  const segments: SiteSegment[] = []
  for (let i = 0; i < events.length; i++) {
    const domain = events[i].domain
    const last = segments[segments.length - 1]
    if (last && last.domain === domain) {
      last.endIndex = i
    } else {
      segments.push({ domain, startIndex: i, endIndex: i })
    }
  }
  return segments
}

async function broadcastToAllTabs(msg: RuntimeMessage) {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (tab.id == null) continue
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {})
  }
}

/**
 * After an extension reload, content scripts in already-open tabs are orphaned
 * (dead message channel) and capture nothing. Ping each tab; if no live recorder
 * answers, inject a fresh copy of the built content script.
 */
async function ensureRecorderInAllTabs() {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js
  if (!files || files.length === 0) return
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (tab.id == null || !tab.url || !/^https?:/.test(tab.url)) continue
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'recorder/ping' } satisfies RuntimeMessage)
    } catch {
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files })
        .catch(() => {})
    }
  }
}

chrome.runtime.onMessage.addListener(
  (msg: RuntimeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: RuntimeMessage) => void) => {
    ;(async () => {
      const state = await loadState()

      if (msg.kind === 'recorder/start') {
        const session: RecordingSession = {
          id: makeId(),
          startedAt: Date.now(),
          stoppedAt: null,
          events: [],
          segments: [],
        }
        await saveState({ recording: true, session })
        await ensureRecorderInAllTabs()
        broadcastToAllTabs({ kind: 'recorder/start' })
        sendResponse({ kind: 'recorder/state', recording: true, eventCount: 0 })
        return
      }

      if (msg.kind === 'recorder/stop') {
        if (state.session) state.session.stoppedAt = Date.now()
        await saveState({ recording: false, session: state.session })
        broadcastToAllTabs({ kind: 'recorder/stop' })
        sendResponse({ kind: 'recorder/state', recording: false, eventCount: state.session?.events.length ?? 0 })
        return
      }

      if (msg.kind === 'recorder/event') {
        if (!state.recording || !state.session) return
        const event = { ...msg.event, tabId: sender.tab?.id ?? -1, frameId: sender.frameId ?? -1 }
        state.session.events.push(event)
        state.session.segments = rebuildSegments(state.session.events)
        await saveState(state)
        return
      }

      if (msg.kind === 'recorder/getState') {
        sendResponse({
          kind: 'recorder/state',
          recording: state.recording,
          eventCount: state.session?.events.length ?? 0,
        })
        return
      }

      if (msg.kind === 'recorder/getSession') {
        sendResponse({ kind: 'recorder/session', session: state.session })
        return
      }

      if (msg.kind === 'recorder/clearSession') {
        await saveState({ recording: false, session: null })
        sendResponse({ kind: 'recorder/state', recording: false, eventCount: 0 })
        return
      }

      if (msg.kind === 'replay/run') {
        // Fire-and-forget; progress is reported to the mimic tab via replay/status.
        runInBrowser(msg.automationId, msg.values, msg.credentials).catch((e) => {
          notifyMimicTabs({ kind: 'replay/status', runId: 'x', status: 'failed', message: String(e) })
        })
        sendResponse({ kind: 'replay/status', runId: 'x', status: 'running', message: 'started' })
      }
    })()
    return true
  },
)

const BACKEND = 'http://localhost:4545'
const MIMIC = 'http://localhost:5174'

interface PlanStep {
  event: RecordedEvent
  override: string | null
  isPassword: boolean
  guests: { adults?: number; children?: number; rooms?: number } | null
  autocomplete?: boolean
  /** Recorded old suggestion text — a following click on it must be skipped. */
  staleText?: string | null
  /** Check-in + check-out sharing ONE recorded calendar click (see ensureCheckoutDate). */
  dateRange?: { checkIn?: string; checkOut?: string } | null
}

async function notifyMimicTabs(msg: RuntimeMessage) {
  const tabs = await chrome.tabs.query({ url: `${MIMIC}/*` })
  for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, msg).catch(() => {})
}

async function waitTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab?.status === 'complete') return
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Extension-driven replay: run the automation's steps in a real tab in the
 * user's own browser (already logged in, real fingerprint). Reuses the backend's
 * collapse/override logic via /replay-plan; the in-page executor performs steps.
 */
async function runInBrowser(
  automationId: string,
  values: Record<string, string>,
  credentials?: { username: string; password: string },
): Promise<void> {
  const runId = `${Date.now()}`
  const runStartedAt = Date.now()
  const say = (status: 'running' | 'success' | 'failed', message: string, url?: string) =>
    notifyMimicTabs({ kind: 'replay/status', runId, status, message, url })

  say('running', 'building plan…')
  const planResp = await fetch(`${BACKEND}/api/automations/${automationId}/replay-plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variables: values, credentials }),
  })
  if (!planResp.ok) {
    say('failed', 'could not build replay plan')
    return
  }
  const plan = (await planResp.json()) as { startUrl: string; steps: PlanStep[]; direct?: boolean }
  if (!plan.startUrl || (plan.steps.length === 0 && !plan.direct)) {
    say('failed', 'nothing to replay')
    return
  }

  const tab = await chrome.tabs.create({ url: plan.startUrl, active: true })
  const tabId = tab.id!
  await waitTabComplete(tabId)
  // Direct-URL runs (Booking search) load results asynchronously — give the
  // listings time to render before scraping. Step runs need less.
  await new Promise((r) => setTimeout(r, plan.direct ? 4000 : 800))

  let executed = 0
  let currentUrl = plan.startUrl
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  let skipStale: string | null = null
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    // After an autocomplete substitution, the recording's old suggestion click
    // must not replay (it would re-select the old city via some other element).
    if (skipStale && step.event.type === 'click') {
      const stale = skipStale
      skipStale = null
      const t = (step.event.selector.textContent ?? '').trim()
      if (t && (norm(t).includes(norm(stale)) || norm(stale).includes(norm(t)))) continue
    }
    if (step.autocomplete && step.override) skipStale = step.staleText ?? step.event.selector.textContent ?? null
    // Cross-domain navigation between steps
    if (step.event.url && !step.event.url.includes(new URL(currentUrl).hostname)) {
      try {
        const stepHost = new URL(step.event.url).hostname
        const live = await chrome.tabs.get(tabId)
        if (live.url && !live.url.includes(stepHost)) {
          await chrome.tabs.update(tabId, { url: step.event.url })
          await waitTabComplete(tabId)
          await new Promise((r) => setTimeout(r, 600))
        }
      } catch {
        /* ignore */
      }
    }
    say('running', `step ${i + 1} of ${plan.steps.length}…`)
    const res = (await chrome.tabs
      .sendMessage(tabId, {
        kind: 'replay/execEvent',
        event: step.event,
        override: step.override,
        isPassword: step.isPassword,
        guests: step.guests,
        autocomplete: step.autocomplete,
        dateRange: step.dateRange,
      } satisfies RuntimeMessage)
      .catch(() => null)) as RuntimeMessage | null
    if (res?.kind === 'replay/execResult' && res.result.ok && !res.result.skipped) executed++
    await waitTabComplete(tabId, 8000)
    const live = await chrome.tabs.get(tabId).catch(() => null)
    if (live?.url) currentUrl = live.url
    await new Promise((r) => setTimeout(r, 400))
  }

  // Guarantee guest counts via URL params when the site expresses them there
  // (group_adults / group_children / no_rooms) — widget DOMs shift, URLs don't.
  const wantedGuests = plan.steps.reduce<{ adults?: number; children?: number; rooms?: number }>(
    (a, s) => (s.guests ? { ...a, ...s.guests } : a),
    {},
  )
  if (Object.keys(wantedGuests).length > 0) {
    try {
      const liveTab = await chrome.tabs.get(tabId)
      const u = new URL(liveTab.url ?? currentUrl)
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
        await chrome.tabs.update(tabId, { url: u.toString() })
        await waitTabComplete(tabId)
        await new Promise((r) => setTimeout(r, 2500))
        currentUrl = u.toString()
      }
    } catch {
      /* leave as-is */
    }
  }

  if (plan.direct) say('running', 'loading results…')
  // Scrape final page. Direct-URL results (Booking/GoZayaan) load their listings
  // via XHR after navigation, so a single early scrape can catch an empty page —
  // retry a few times until results appear (or we run out of tries).
  const scrapeOnce = async () =>
    (await chrome.tabs
      .sendMessage(tabId, { kind: 'replay/scrape' } satisfies RuntimeMessage)
      .catch(() => null)) as RuntimeMessage | null
  let scraped = await scrapeOnce()
  const count = (m: RuntimeMessage | null) => {
    const o = m?.kind === 'replay/scraped' ? (m.output as { results?: unknown[] }) : null
    return o && Array.isArray(o.results) ? o.results.length : 0
  }
  for (let tries = 0; plan.direct && count(scraped) === 0 && tries < 5; tries++) {
    await new Promise((r) => setTimeout(r, 1500))
    scraped = await scrapeOnce()
  }
  const output = scraped?.kind === 'replay/scraped' ? scraped.output : null
  const snapshotHtml = scraped?.kind === 'replay/scraped' ? scraped.html : undefined
  const live = await chrome.tabs.get(tabId).catch(() => null)
  if (live?.url) currentUrl = live.url

  // A run counts as successful if it captured results, even with 0 clicked steps
  // (direct-URL search runs legitimately execute nothing but return listings).
  const resultCount =
    output && typeof output === 'object' && Array.isArray((output as { results?: unknown[] }).results)
      ? (output as { results: unknown[] }).results.length
      : 0
  const ok = executed > 0 || resultCount > 0

  // Persist the run so it shows on the mimic site like a server run.
  await fetch(`${BACKEND}/api/automations/${automationId}/browser-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stepsExecuted: executed,
      stepsTotal: plan.steps.length,
      output,
      finalUrl: currentUrl,
      snapshotHtml,
      startedAt: runStartedAt,
    }),
  }).catch(() => {})

  const doneMsg = plan.direct ? `done — ${resultCount} results` : `done — ${executed}/${plan.steps.length} steps`
  say(ok ? 'success' : 'failed', ok ? doneMsg : 'nothing captured', currentUrl)
}
