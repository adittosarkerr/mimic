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
  dataTestid?: string | null
  name?: string | null
  placeholder?: string | null
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

export interface FieldOption {
  value: string
  label: string
}

export interface VariableField {
  name: string
  label: string
  type: 'text' | 'date' | 'number' | 'email' | 'select' | 'boolean'
  /** input = typed value, choice = clicked option, guests = a stepper count in an occupancy widget */
  kind?: 'input' | 'choice' | 'guests'
  /** For guests fields: which counter this controls. */
  guestType?: 'adults' | 'children' | 'rooms'
  /** Free-text field with a suggestion dropdown (city/location search) — replay
   * types the value then clicks the matching suggestion. */
  autocomplete?: boolean
  eventIndex: number
  sampleValue: string | null
  required: boolean
  /** Real options read live from the site (select dropdowns, listboxes). */
  options?: FieldOption[]
  /** Live hint discovered from the site: placeholder, min/max, help text. */
  hint?: string | null
}

export interface LoginInfo {
  /** Original event index of the password field step. */
  passwordEventIndex: number
  /** Original event index of the username/email field step, if found. */
  usernameEventIndex: number | null
  usernameLabel: string
  domain: string
}

export interface EmailAction {
  provider: string // gmail | outlook | yahoo | custom
  toField: string | null
  subjectField: string | null
  bodyField: string | null
}

export interface AutomationSchema {
  automationId: string
  recordingId: string
  title: string
  description: string
  variables: VariableField[]
  createdAt: number
  /** URL the recording started at — used for the "log in to this site" action. */
  startUrl?: string
  /** Present when this is a "send email" task — offers a reliable SMTP path. */
  email?: EmailAction | null
  /** Present when the recording included a login (a password field). */
  login?: LoginInfo | null
  /** Set when live introspection could not reach the site (e.g. CAPTCHA). */
  introspection?: {
    reached: boolean
    note: string | null
  }
}

export interface Credentials {
  username: string
  password: string
}

export interface RunResult {
  runId: string
  automationId: string
  status: 'success' | 'failed'
  startedAt: number
  finishedAt: number
  output: unknown
  error: string | null
  stepsExecuted: number
  stepsTotal: number
  skippedSteps?: string[]
  hasSnapshot?: boolean
  /** A CAPTCHA / anti-bot wall was hit (signals the caller to retry assisted). */
  botWall?: boolean
  /** This run used the assisted (visible browser) path. */
  assisted?: boolean
}
