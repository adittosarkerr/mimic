export type RecordedEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'keydown'
  | 'submit'
  | 'navigation'

export interface SelectorFingerprint {
  css: string | null
  xpath: string | null
  id: string | null
  ariaLabel: string | null
  textContent: string | null
  labelText: string | null
  role: string | null
  dataTestid: string | null
  name: string | null
  placeholder: string | null
  framePath: string[]
  shadowPath: string[]
}

export interface RecordedEvent {
  id: string
  type: RecordedEventType
  timestamp: number
  tabId: number
  frameId: number
  domain: string
  url: string
  selector: SelectorFingerprint
  value: string | null
  inputType: string | null
  key: string | null
}

export interface SiteSegment {
  domain: string
  startIndex: number
  endIndex: number
}

export interface RecordingSession {
  id: string
  startedAt: number
  stoppedAt: number | null
  events: RecordedEvent[]
  segments: SiteSegment[]
}

export interface VariableFieldLite {
  name: string
  kind?: 'input' | 'choice' | 'guests'
  guestType?: 'adults' | 'children' | 'rooms'
  type?: string
  eventIndex: number
  sampleValue: string | null
}

export interface LoginInfoLite {
  passwordEventIndex: number
  usernameEventIndex: number | null
}

export interface ReplayPlan {
  runId: string
  startUrl: string
  events: RecordedEvent[]
  variables: VariableFieldLite[]
  values: Record<string, string>
  login: LoginInfoLite | null
  credentials?: { username: string; password: string }
}

export interface ReplayStepResult {
  index: number
  ok: boolean
  skipped: boolean
  note: string
}

export type RuntimeMessage =
  | { kind: 'recorder/start' }
  | { kind: 'recorder/stop' }
  | { kind: 'recorder/event'; event: RecordedEvent }
  | { kind: 'recorder/getState' }
  | { kind: 'recorder/state'; recording: boolean; eventCount: number }
  | { kind: 'recorder/getSession' }
  | { kind: 'recorder/session'; session: RecordingSession | null }
  | { kind: 'recorder/ping' }
  | { kind: 'recorder/pong' }
  | { kind: 'recorder/clearSession' }
  // Extension-driven replay (runs in the user's own logged-in browser)
  | { kind: 'replay/run'; automationId: string; values: Record<string, string>; credentials?: { username: string; password: string } }
  | { kind: 'replay/status'; runId: string; status: 'running' | 'success' | 'failed'; message: string; url?: string }
  | { kind: 'replay/execEvent'; event: RecordedEvent; override: string | null; isPassword: boolean; guests: { adults?: number; children?: number; rooms?: number } | null; autocomplete?: boolean; dateRange?: { checkIn?: string; checkOut?: string } | null }
  | { kind: 'replay/execResult'; result: ReplayStepResult }
  | { kind: 'replay/scrape' }
  | { kind: 'replay/scraped'; output: unknown; html?: string }
