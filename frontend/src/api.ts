// Local dev: the backend runs on its own port (localhost:4545). Production
// build (Vercel etc.): default to a same-origin relative path — this repo's
// vercel.json runs frontend + backend as two services in one project and
// rewrites /api/* to the backend service, so a relative path just works with
// no env var needed. Only set VITE_API_BASE if the backend is hosted
// somewhere else entirely (a separate VPS, Railway, Render, Fly.io, etc).
const BASE = import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? 'http://localhost:4545/api' : '/api')
/** Public base URL of the REST API — shown in the docs/curl examples. */
export const API_BASE = BASE

// --- auth token (persisted) ---
const TOKEN_KEY = 'mimic_token'
export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}
function authHeaders(): Record<string, string> {
  const t = auth.token()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface PaymentMethod {
  id: string
  type: 'bkash' | 'card' | 'bank'
  label: string
  isDefault: boolean
}

export interface PublicApiKey {
  id: string
  label: string
  masked: string
  createdAt: number
  lastUsedAt: number | null
}

export interface PublicUser {
  id: string
  email: string
  plan: 'fledgling' | 'songbird' | 'mockingbird' | 'lyrebird'
  bkashAccount: string | null
  paymentMethods: PaymentMethod[]
  apiKeys: PublicApiKey[]
  dailyCreations: number
  createdAt: number
}

export interface Plan {
  id: string
  name: string
  tagline: string
  priceBdt: number | null
  dailyCreations: number
  marketplaceSeller: boolean
  perks: string[]
}

export interface Listing {
  id: string
  automationId: string
  sellerId: string
  title: string
  description: string
  priceModel: 'per_use' | 'per_100' | 'subscription'
  priceBdt: number
  createdAt: number
  sales: number
}

export const saasApi = {
  me: () =>
    fetch(`${BASE}/auth/me`, { headers: authHeaders() }).then((r) =>
      r.json() as Promise<{ user: PublicUser | null; billingEnabled: boolean }>,
    ),
  register: (email: string, password: string) =>
    fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'register failed')
      return j as { token: string; user: PublicUser }
    }),
  login: (email: string, password: string) =>
    fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'login failed')
      return j as { token: string; user: PublicUser }
    }),
  logout: () => fetch(`${BASE}/auth/logout`, { method: 'POST', headers: authHeaders() }),
  plans: () =>
    fetch(`${BASE}/plans`).then((r) => r.json() as Promise<{ plans: Plan[]; billingEnabled: boolean }>),
  subscribe: (plan: string, bkashAccount?: string) =>
    fetch(`${BASE}/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ plan, bkashAccount }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'subscribe failed')
      return j as { ok: boolean; user: PublicUser }
    }),
  paymentMethods: () =>
    fetch(`${BASE}/payment-methods`, { headers: authHeaders() }).then((r) => r.json() as Promise<PaymentMethod[]>),
  addPaymentMethod: (type: string, number: string, holder: string) =>
    fetch(`${BASE}/payment-methods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type, number, holder }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'failed')
      return j as { paymentMethods: PaymentMethod[] }
    }),
  deletePaymentMethod: (id: string) =>
    fetch(`${BASE}/payment-methods/${id}`, { method: 'DELETE', headers: authHeaders() }).then(
      (r) => r.json() as Promise<{ paymentMethods: PaymentMethod[] }>,
    ),
  apiKeys: () =>
    fetch(`${BASE}/api-keys`, { headers: authHeaders() }).then((r) => r.json() as Promise<PublicApiKey[]>),
  createApiKey: (label: string) =>
    fetch(`${BASE}/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ label }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'failed')
      return j as { id: string; key: string; label: string; createdAt: number }
    }),
  deleteApiKey: (id: string) =>
    fetch(`${BASE}/api-keys/${id}`, { method: 'DELETE', headers: authHeaders() }).then(
      (r) => r.json() as Promise<{ apiKeys: PublicApiKey[] }>,
    ),
  marketplace: () => fetch(`${BASE}/marketplace`).then((r) => r.json() as Promise<Listing[]>),
  listAutomation: (body: { automationId: string; title: string; description: string; priceModel: string; priceBdt: number }) =>
    fetch(`${BASE}/marketplace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'listing failed')
      return j as Listing
    }),
  buy: (listingId: string) =>
    fetch(`${BASE}/marketplace/${listingId}/buy`, { method: 'POST', headers: authHeaders() }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'purchase failed')
      return j as { ok: boolean; chargedBdt: number; platformFeeBdt: number; sellerNetBdt: number }
    }),
}

export interface RecordingSummary {
  id: string
  startedAt: number
  eventCount: number
  domains: string[]
}

export interface FieldOption {
  value: string
  label: string
}

export interface VariableField {
  name: string
  label: string
  type: 'text' | 'date' | 'number' | 'email' | 'select' | 'boolean'
  kind?: 'input' | 'choice' | 'guests'
  guestType?: 'adults' | 'children' | 'rooms'
  autocomplete?: boolean
  eventIndex: number
  sampleValue: string | null
  required: boolean
  options?: FieldOption[]
  hint?: string | null
}

export interface LoginInfo {
  passwordEventIndex: number
  usernameEventIndex: number | null
  usernameLabel: string
  domain: string
}

export interface AutomationSchema {
  automationId: string
  recordingId: string
  title: string
  description: string
  variables: VariableField[]
  createdAt: number
  startUrl?: string
  login?: LoginInfo | null
  email?: { provider: string; toField: string | null; subjectField: string | null; bodyField: string | null } | null
  introspection?: { reached: boolean; note: string | null }
}

export interface SmtpPreset {
  id: string
  name: string
  host: string
  port: number
  secure: boolean
  appPasswordUrl: string | null
}

export const emailApi = {
  presets: () => fetch(`${BASE}/email/presets`).then((r) => r.json() as Promise<SmtpPreset[]>),
  config: () =>
    fetch(`${BASE}/email/config`, { headers: authHeaders() }).then(
      (r) => r.json() as Promise<{ configured: boolean; email: string | null }>,
    ),
  saveConfig: (body: { email: string; appPassword: string; provider: string; host?: string; port?: number; secure?: boolean }) =>
    fetch(`${BASE}/email/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'failed')
      return j as { ok: boolean }
    }),
  send: (automationId: string, values: Record<string, string>) =>
    fetch(`${BASE}/automations/${automationId}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ values }),
    }).then(async (r) => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'send failed')
      return j as { ok: boolean }
    }),
}

export interface ResultItem {
  title: string
  href: string | null
  thumbnail: string | null
  meta: string[]
}

export interface RunResult {
  runId: string
  automationId: string
  status: 'success' | 'failed'
  startedAt: number
  finishedAt: number
  output: {
    title?: string
    url?: string
    results?: ResultItem[]
  } | null
  error: string | null
  stepsExecuted: number
  stepsTotal: number
  skippedSteps?: string[]
  hasSnapshot?: boolean
  botWall?: boolean
  assisted?: boolean
}

export const snapshotUrl = (runId: string) => `${BASE}/runs/${runId}/snapshot`

async function json<T>(res: Response): Promise<T> {
  if (!res.ok && res.status !== 500) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  listRecordings: () => fetch(`${BASE}/recordings`).then((r) => json<RecordingSummary[]>(r)),
  listAutomations: () => fetch(`${BASE}/automations`).then((r) => json<AutomationSchema[]>(r)),
  getAutomation: (id: string) => fetch(`${BASE}/automations/${id}`).then((r) => json<AutomationSchema>(r)),
  analyze: (recordingId: string) =>
    fetch(`${BASE}/recordings/${recordingId}/analyze`, { method: 'POST' }).then((r) => json<AutomationSchema>(r)),
  run: (
    automationId: string,
    variables: Record<string, string>,
    captureOutput: boolean,
    credentials?: { username: string; password: string },
    noEscalate?: boolean,
  ) => {
    // A hung server request (or one stuck behind a busy replay queue) would
    // otherwise leave the "running…" spinner stuck forever — fetch() has no
    // default timeout. Abort after 4 minutes so the UI always recovers.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 240_000)
    return fetch(`${BASE}/automations/${automationId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variables, captureOutput, credentials, noEscalate }),
      signal: controller.signal,
    })
      .then((r) => json<RunResult>(r))
      .finally(() => clearTimeout(timeout))
  },
  getCredentialStatus: (automationId: string) =>
    fetch(`${BASE}/automations/${automationId}/credentials`).then((r) => json<{ hasCredentials: boolean }>(r)),
  saveCredentials: (automationId: string, username: string, password: string) =>
    fetch(`${BASE}/automations/${automationId}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then((r) => json<{ ok: boolean }>(r)),
  deleteCredentials: (automationId: string) =>
    fetch(`${BASE}/automations/${automationId}/credentials`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  loginSession: (url: string) =>
    fetch(`${BASE}/login-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => json<{ ok: boolean; note: string }>(r)),
  listRuns: (automationId: string) =>
    fetch(`${BASE}/automations/${automationId}/runs`).then((r) => json<RunResult[]>(r)),
  deleteAutomation: (id: string) =>
    fetch(`${BASE}/automations/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  deleteRecording: (id: string) =>
    fetch(`${BASE}/recordings/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
}
