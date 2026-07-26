import { Router, type Request } from 'express'
import type { AutomationSchema, RecordingSession } from '../types.js'
import { store } from '../store/index.js'
import { collapseInputEvents, detectEmailAction, detectLogin, detectVariablesHeuristic, ensureAutocompleteFlags, ensureCheckoutDate, refineWithLlm, synthesizeForm } from '../inference/schema.js'
import { introspectForm } from '../inference/introspect.js'
import { replaySession, loginSession, buildReplaySteps } from '../replay/engine.js'
import type { Credentials } from '../types.js'
import { SMTP_PRESETS, emailStore, sendEmail, type EmailConfig } from '../saas/email.js'
import { saasStore } from '../saas/store.js'

export const api = Router()

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

api.post('/recordings', async (req, res) => {
  const session = req.body as RecordingSession
  if (!session?.id || !Array.isArray(session.events)) {
    res.status(400).json({ error: 'invalid session payload' })
    return
  }
  await store.saveRecording(session)
  res.json({ ok: true, recordingId: session.id, eventCount: session.events.length })
})

api.get('/recordings', async (_req, res) => {
  const all = await store.listRecordings()
  res.json(
    all.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      eventCount: r.events.length,
      domains: r.segments.map((s) => s.domain),
    })),
  )
})

api.get('/recordings/:id', async (req, res) => {
  const rec = await store.getRecording(req.params.id)
  if (!rec) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(rec)
})

api.post('/recordings/:id/analyze', async (req, res) => {
  const rec = await store.getRecording(req.params.id)
  if (!rec) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const userId = await userIdFromReq(req)
  const existing = (await store.listAutomations()).find((a) => a.recordingId === rec.id)
  if (existing && !req.query.force) {
    res.json(existing)
    return
  }
  // Primary: let the LLM synthesize the whole canonical form from the full
  // recording (reliable, task-aware). Fall back to the heuristic + label pass
  // when the LLM is unavailable or fails, so this never blocks.
  let refined = await synthesizeForm(rec)
  if (!refined) {
    const collapsed = collapseInputEvents(rec.events)
    const heuristic = detectVariablesHeuristic(collapsed)
    const remapped = heuristic.map((v) => ({
      ...v,
      eventIndex: rec.events.findIndex((e) => e.id === collapsed[v.eventIndex].id),
    }))
    refined = await refineWithLlm(rec, remapped)
  }
  refined.variables = ensureCheckoutDate(refined.variables)
  refined.variables = ensureAutocompleteFlags(refined.variables)

  // Live-read the real form so dropdowns show genuine options and numeric
  // fields carry real bounds. Best-effort — never blocks automation creation.
  const introspected = await introspectForm(rec, refined.variables)

  const login = detectLogin(rec.events)
  // The login username field is handled in the credentials section — don't also
  // surface it as an ordinary variable.
  const loginIndices = new Set(
    login ? [login.passwordEventIndex, login.usernameEventIndex].filter((n): n is number => n != null) : [],
  )

  const schema: AutomationSchema = {
    automationId: makeId(),
    recordingId: rec.id,
    title: refined.title,
    description: refined.description,
    variables: introspected.variables.filter((v) => !loginIndices.has(v.eventIndex)),
    createdAt: Date.now(),
    ...(userId ? { userId } : {}),
    startUrl: rec.events[0]?.url,
    login,
    email: detectEmailAction(rec, introspected.variables.filter((v) => !loginIndices.has(v.eventIndex))),
    introspection: { reached: introspected.reached, note: introspected.note },
  }
  await store.saveAutomation(schema)
  res.json(schema)
})

// Only the caller's OWN automations. Previously this returned every automation
// in the system to anybody, so a brand-new account saw (and could run, delete,
// or list for sale on the marketplace) everyone else's work.
api.get('/automations', async (req, res) => {
  const userId = await userIdFromReq(req)
  if (!userId) {
    res.json([])
    return
  }
  const all = await store.listAutomations()
  res.json(all.filter((a) => a.userId === userId))
})

api.get('/automations/:id', async (req, res) => {
  const a = await store.getAutomation(req.params.id)
  if (!a) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(a)
})

interface RunBody {
  variables?: Record<string, string>
  captureOutput?: boolean
  assisted?: boolean
  credentials?: Credentials
  // When the caller (a browser with the extension) can take over on a bot-wall,
  // skip the slow visible-browser escalation and fail fast so it can hand off.
  noEscalate?: boolean
}

/**
 * Run an automation through the escalation ladder and persist the result.
 * Shared by the app's own `/run` and the public REST `/v1/.../run` endpoints.
 *  1) headless: fast + silent, works for most sites.
 *  2) stealth-headed: a real browser rendered OFF-SCREEN with a fresh profile —
 *     invisible to the user but beats bot-walls that block headless (Booking).
 *  3) assisted: a VISIBLE window, only when a human must solve a CAPTCHA / log in.
 */
async function executeReplay(schema: AutomationSchema, recording: RecordingSession, body: RunBody) {
  const { variables, captureOutput, assisted, credentials, noEscalate } = body

  // Login credentials: per-run values if given, else stored (encrypted) creds.
  let creds: Credentials | undefined = credentials
  if (!creds && schema.login && (await store.hasCredentials(schema.automationId))) {
    creds = (await store.getCredentials(schema.automationId)) ?? undefined
  }

  const baseOpts = { schema, variableValues: variables ?? {}, captureOutput, credentials: creds }
  const domainsStr = `${schema.startUrl ?? ''} ${(recording.segments ?? []).map((s) => s.domain).join(' ')} ${(recording.events ?? []).map((e) => e.url).join(' ')}`
  const blocksHeadless = /booking\.com|kayak\.com/i.test(domainsStr)

  let out
  if (assisted === true) {
    out = await replaySession(recording, { ...baseOpts, assisted: true })
  } else if (blocksHeadless) {
    out = await replaySession(recording, { ...baseOpts, stealthHeaded: true })
  } else {
    out = await replaySession(recording, { ...baseOpts })
    if (out.result.botWall && noEscalate !== true) {
      out = await replaySession(recording, { ...baseOpts, stealthHeaded: true })
    }
  }
  if (out.result.botWall && !out.result.assisted && noEscalate !== true) {
    out = await replaySession(recording, { ...baseOpts, assisted: true })
  }

  await store.saveRun(out.result)
  if (out.snapshotHtml) await store.saveSnapshot(out.result.runId, out.snapshotHtml)
  return out
}

api.post('/automations/:id/run', async (req, res) => {
  const schema = await store.getAutomation(req.params.id)
  if (!schema) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const recording = await store.getRecording(schema.recordingId)
  if (!recording) {
    res.status(410).json({ error: 'source recording missing' })
    return
  }
  const { result } = await executeReplay(schema, recording, req.body as RunBody)
  res.status(result.status === 'success' ? 200 : 500).json(result)
})

// --- Public REST API (v1) — authenticated by an API key, not a session cookie.
// This is the "hidden" endpoint each automation exposes; it only works with a
// valid key belonging to a signed-up account.
function bearerKey(req: Request): string | null {
  const h = req.header('authorization')
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}

api.post('/v1/automations/:id/run', async (req, res) => {
  const key = bearerKey(req)
  if (!key) {
    res.status(401).json({ error: 'API key required — send header: Authorization: Bearer mk_live_...' })
    return
  }
  const userId = await saasStore.userIdForApiKey(key)
  if (!userId) {
    res.status(401).json({ error: 'invalid or revoked API key' })
    return
  }
  const schema = await store.getAutomation(req.params.id)
  if (!schema) {
    res.status(404).json({ error: 'automation not found' })
    return
  }
  const recording = await store.getRecording(schema.recordingId)
  if (!recording) {
    res.status(410).json({ error: 'source recording missing' })
    return
  }
  // Stamp lastUsedAt on the key.
  const user = await saasStore.getUser(userId)
  const usedKey = user?.apiKeys?.find((k) => k.key === key)
  if (user && usedKey) {
    usedKey.lastUsedAt = Date.now()
    await saasStore.saveUser(user)
  }

  const { variables, captureOutput } = req.body as RunBody
  const { result } = await executeReplay(schema, recording, { variables, captureOutput })
  res.status(result.status === 'success' ? 200 : 500).json({
    runId: result.runId,
    status: result.status,
    output: result.output,
    error: result.error,
    stepsExecuted: result.stepsExecuted,
    stepsTotal: result.stepsTotal,
  })
})

// Open a visible browser so the user can sign in to a site once; the session
// is saved to the shared profile and reused by later runs (even headless).
api.post('/login-session', async (req, res) => {
  const { url } = req.body as { url?: string }
  if (!url || !/^https?:\/\//.test(url)) {
    res.status(400).json({ error: 'valid url required' })
    return
  }
  const result = await loginSession(url)
  res.json(result)
})

// Steps for extension-driven replay (runs in the user's own browser). Reuses
// the same collapse/override logic as server replay so behavior is consistent.
api.post('/automations/:id/replay-plan', async (req, res) => {
  const schema = await store.getAutomation(req.params.id)
  if (!schema) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const recording = await store.getRecording(schema.recordingId)
  if (!recording) {
    res.status(410).json({ error: 'source recording missing' })
    return
  }
  const { variables, credentials } = req.body as {
    variables?: Record<string, string>
    credentials?: Credentials
  }
  let creds = credentials
  if (!creds && schema.login && (await store.hasCredentials(schema.automationId))) {
    creds = (await store.getCredentials(schema.automationId)) ?? undefined
  }
  const { startUrl, steps, direct, extractScript, waitSelector } = buildReplaySteps(recording, {
    schema,
    variableValues: variables ?? {},
    credentials: creds,
  })
  res.json({
    startUrl,
    steps,
    direct: direct ?? false,
    extractScript: extractScript ?? null,
    waitSelector: waitSelector ?? null,
    login: schema.login ?? null,
  })
})

// Save the result of an extension-driven (browser) replay so it appears in the
// automation's run history alongside server runs.
api.post('/automations/:id/browser-run', async (req, res) => {
  const schema = await store.getAutomation(req.params.id)
  if (!schema) {
    res.status(404).json({ error: 'not found' })
    return
  }
  const { stepsExecuted, stepsTotal, output, finalUrl, snapshotHtml, startedAt } = req.body as {
    stepsExecuted?: number
    stepsTotal?: number
    output?: unknown
    finalUrl?: string
    snapshotHtml?: string
    startedAt?: number
  }
  // A run "worked" if it either executed steps OR captured real results — direct
  // URL runs (Booking search) legitimately execute 0 steps but return listings.
  const resultCount =
    output && typeof output === 'object' && Array.isArray((output as { results?: unknown[] }).results)
      ? (output as { results: unknown[] }).results.length
      : 0
  const ok = (stepsExecuted ?? 0) > 0 || resultCount > 0

  // Wrap the captured HTML like the server does: strip scripts, add a <base> so
  // relative CSS/images/links resolve against the source site.
  let snapshot: string | null = null
  if (snapshotHtml && finalUrl) {
    const stripped = snapshotHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '')
    const baseTag = `<base href="${finalUrl}" target="_blank">`
    snapshot = /<head[^>]*>/i.test(stripped)
      ? stripped.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : baseTag + stripped
  }

  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    automationId: schema.automationId,
    status: (ok ? 'success' : 'failed') as 'success' | 'failed',
    startedAt: startedAt ?? Date.now(),
    finishedAt: Date.now(),
    output: (output ?? null) as unknown,
    error: ok ? null : `nothing was captured in the browser${finalUrl ? ` (ended at ${finalUrl})` : ''}`,
    stepsExecuted: (stepsExecuted ?? 0) || (ok ? 1 : 0),
    stepsTotal: (stepsTotal ?? 0) || 1,
    assisted: true,
    hasSnapshot: snapshot !== null,
  }
  await store.saveRun(run)
  if (snapshot) await store.saveSnapshot(run.runId, snapshot)
  res.json(run)
})

// --- email connector (SMTP; reliable send that bypasses Gmail-DOM replay) ---

api.get('/email/presets', (_req, res) => {
  res.json(SMTP_PRESETS)
})

// SMTP config is stored per user (encrypted). We resolve the user from a token.
async function userIdFromReq(req: Request): Promise<string | null> {
  const h = req.header('authorization')
  const token = h?.startsWith('Bearer ') ? h.slice(7) : null
  return token ? saasStore.userIdForToken(token) : null
}

api.get('/email/config', async (req, res) => {
  const userId = await userIdFromReq(req)
  if (!userId) {
    res.status(401).json({ error: 'sign in required' })
    return
  }
  const cfg = await emailStore.get(userId)
  res.json({ configured: !!cfg, email: cfg?.email ?? null, host: cfg?.host ?? null })
})

api.post('/email/config', async (req, res) => {
  const userId = await userIdFromReq(req)
  if (!userId) {
    res.status(401).json({ error: 'sign in required' })
    return
  }
  const { email, appPassword, provider, host, port, secure } = req.body as {
    email?: string
    appPassword?: string
    provider?: string
    host?: string
    port?: number
    secure?: boolean
  }
  if (!email || !appPassword) {
    res.status(400).json({ error: 'email and app password required' })
    return
  }
  const preset = SMTP_PRESETS.find((p) => p.id === provider)
  const cfg: EmailConfig = {
    email,
    appPassword,
    host: host || preset?.host || 'smtp.gmail.com',
    port: port || preset?.port || 465,
    secure: secure ?? preset?.secure ?? true,
  }
  await emailStore.save(userId, cfg)
  res.json({ ok: true, configured: true })
})

api.delete('/email/config', async (req, res) => {
  const userId = await userIdFromReq(req)
  if (!userId) {
    res.status(401).json({ error: 'sign in required' })
    return
  }
  await emailStore.delete(userId)
  res.json({ ok: true, configured: false })
})

api.post('/automations/:id/send-email', async (req, res) => {
  const userId = await userIdFromReq(req)
  if (!userId) {
    res.status(401).json({ error: 'sign in required — connect an email account first' })
    return
  }
  const schema = await store.getAutomation(req.params.id)
  if (!schema?.email) {
    res.status(400).json({ error: 'this automation is not a send-email task' })
    return
  }
  const cfg = await emailStore.get(userId)
  if (!cfg) {
    res.status(400).json({ error: 'no email account connected — add one first' })
    return
  }
  const { values } = req.body as { values?: Record<string, string> }
  const v = values ?? {}
  const to = (schema.email.toField && v[schema.email.toField]) || ''
  const subject = (schema.email.subjectField && v[schema.email.subjectField]) || ''
  const body = (schema.email.bodyField && v[schema.email.bodyField]) || ''
  if (!to) {
    res.status(400).json({ error: 'recipient (To) is required' })
    return
  }
  const result = await sendEmail(cfg, { to, subject, body })
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    automationId: schema.automationId,
    status: (result.ok ? 'success' : 'failed') as 'success' | 'failed',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    output: result.ok ? { title: 'Email sent', url: `mailto:${to}`, results: [{ title: `To: ${to} — ${subject}`, href: null, thumbnail: null, meta: [] }] } : null,
    error: result.ok ? null : result.error ?? 'send failed',
    stepsExecuted: result.ok ? 1 : 0,
    stepsTotal: 1,
    hasSnapshot: false,
  }
  await store.saveRun(run)
  res.status(result.ok ? 200 : 500).json({ ...result, run })
})

api.get('/runs/:id/snapshot', async (req, res) => {
  const html = await store.getSnapshot(req.params.id)
  if (!html) {
    res.status(404).send('snapshot not found')
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})

// --- Login credentials (encrypted at rest; values never returned) ---

api.get('/automations/:id/credentials', async (req, res) => {
  res.json({ hasCredentials: await store.hasCredentials(req.params.id) })
})

api.post('/automations/:id/credentials', async (req, res) => {
  const { username, password } = req.body as Partial<Credentials>
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'password required' })
    return
  }
  await store.saveCredentials(req.params.id, { username: username ?? '', password })
  res.json({ ok: true, hasCredentials: true })
})

api.delete('/automations/:id/credentials', async (req, res) => {
  await store.deleteCredentials(req.params.id)
  res.json({ ok: true, hasCredentials: false })
})

api.get('/runs/:id', async (req, res) => {
  const run = await store.getRun(req.params.id)
  if (!run) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(run)
})

api.get('/automations/:id/runs', async (req, res) => {
  const all = await store.listRuns()
  res.json(
    all
      .filter((r) => r.automationId === req.params.id)
      .sort((a, b) => b.startedAt - a.startedAt),
  )
})

// Deleting is owner-only. An automation with no owner (created before ownership
// existed) is treated as unclaimed and stays deletable, so old local data can
// still be tidied up.
api.delete('/automations/:id', async (req, res) => {
  const userId = await userIdFromReq(req)
  const target = await store.getAutomation(req.params.id)
  if (!target) {
    res.status(404).json({ error: 'not found' })
    return
  }
  if (target.userId && target.userId !== userId) {
    res.status(403).json({ error: 'not your automation' })
    return
  }
  await store.deleteAutomation(req.params.id)
  const runs = await store.listRuns()
  for (const r of runs.filter((r) => r.automationId === req.params.id)) {
    await store.deleteRun(r.runId)
  }
  res.json({ ok: true })
})

api.delete('/recordings/:id', async (req, res) => {
  await store.deleteRecording(req.params.id)
  res.json({ ok: true })
})
