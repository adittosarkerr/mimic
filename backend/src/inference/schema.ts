import type { RecordedEvent, RecordingSession, VariableField } from '../types.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

/**
 * Stable identity for a field. React autocompletes rewrite the CSS path on every
 * keystroke, so keying on css alone splits one field into many. Prefer durable
 * attributes (id / name / aria-label / placeholder / data-testid) and only fall
 * back to css when none exist.
 */
function stableFieldKey(e: RecordedEvent): string {
  const s = e.selector
  const stable = s.id || s.name || s.ariaLabel || s.placeholder || s.dataTestid
  return `${s.framePath.join('/')}|${stable ? `stable:${stable}` : `css:${s.css}`}`
}

/**
 * Collapse per-keystroke input events. For each field only the latest value
 * matters — but it must be flushed BEFORE any subsequent interactive event
 * (click/keydown/submit), else "type then Enter" replays as "Enter then type".
 * Progressive typing on a field whose css keeps changing is merged by detecting
 * prefix growth even when the key differs.
 */
export function collapseInputEvents(events: RecordedEvent[]): RecordedEvent[] {
  const out: RecordedEvent[] = []
  const pending = new Map<string, RecordedEvent>()
  const lastFlushed = new Map<string, string | null>()

  const flush = () => {
    for (const [key, e] of pending) {
      if (lastFlushed.get(key) === e.value) continue
      out.push(e)
      lastFlushed.set(key, e.value)
    }
    pending.clear()
  }

  // A checkbox/radio toggle fires THREE raw events for one physical click
  // (click, then input, then change on the same element). Only 'input'/'change'
  // collapse together below — a bare 'click' would otherwise survive as its own
  // separate step AND variable, producing a duplicate field for the same filter.
  // Route checkbox/radio clicks through the same pending-merge path.
  const isCheckboxClick = (e: RecordedEvent) =>
    e.type === 'click' && (e.inputType === 'checkbox' || e.inputType === 'radio')

  for (const e of events) {
    if (e.type === 'input' || e.type === 'change' || isCheckboxClick(e)) {
      const key = stableFieldKey(e)
      // If the only pending field is progressive typing (prev value is a prefix
      // of this one, or vice versa), treat it as the same field even if the css
      // key changed — replace it rather than accumulating duplicates.
      if (!pending.has(key) && pending.size === 1) {
        const [[onlyKey, onlyEvt]] = [...pending.entries()]
        const a = onlyEvt.value ?? ''
        const b = e.value ?? ''
        if (a && b && (b.startsWith(a) || a.startsWith(b))) {
          pending.delete(onlyKey)
        }
      }
      pending.set(key, e)
    } else {
      flush()
      out.push(e)
    }
  }
  flush()
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Find indices of plain clicks that are really the SAME user action as the
 * checkbox/radio toggle immediately after them (clicking a filter row bubbles a
 * click on the row div AND fires the actual input toggle). Returned as a set of
 * ORIGINAL indices (not a filtered array) so every other index stays aligned —
 * replay maps variables straight to `session.events[eventIndex]`, and shifting
 * indices here would silently break every field after the first drop.
 */
function findRedundantRowClickIndices(events: RecordedEvent[]): Set<number> {
  const drop = new Set<number>()
  events.forEach((e, i) => {
    if (e.type !== 'click' || e.inputType === 'checkbox' || e.inputType === 'radio') return
    const next = events[i + 1]
    if (!next || (next.inputType !== 'checkbox' && next.inputType !== 'radio')) return
    const a = norm(e.selector.labelText || e.selector.textContent || '')
    const b = norm(next.selector.ariaLabel || next.selector.labelText || '')
    if (a && b && (a.includes(b) || b.includes(a))) drop.add(i)
  })
  return drop
}

/**
 * Scan ALL events (not just ones that became variables) for a date-shaped label —
 * typically a "Select dates" trigger showing the current range ("Fri, Jul 24 —
 * Tue, Aug 5"). Its own click rarely qualifies as a variable (odd separator text),
 * but its label carries the month/year context bare calendar-cell numbers lack.
 */
function findContextRefDate(events: RecordedEvent[]): string | null {
  for (const e of events) {
    if (e.type !== 'click') continue
    const year = new Date(e.timestamp || Date.now()).getFullYear()
    for (const src of [e.selector.labelText, e.selector.ariaLabel, e.selector.textContent]) {
      const iso = parseDateLabel(null, src, year)
      if (iso) return iso
    }
  }
  return null
}

/**
 * Pull EVERY "<month> <day>" occurrence out of a string, in order. Used to read
 * a full date-range summary ("Select dates Wed, Jul 29 — Mon, Aug 17 Select
 * occupancy…") in one shot, rather than resolving check-in/check-out from
 * separate single-date guesses.
 */
function parseAllDatesInLabel(text: string | null, contextYear: number): string[] {
  if (!text) return []
  const src = text.toLowerCase()
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{1,2})\b/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const month = MONTHS[m[1]]
    const day = parseInt(m[2], 10)
    if (day < 1 || day > 31) continue
    const tail = src.slice(m.index, m.index + 40)
    const yearMatch = tail.match(/\b(20\d{2})\b/)
    const year = yearMatch ? parseInt(yearMatch[1], 10) : contextYear
    out.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return out
}

/**
 * Scan ALL events (not just clicks — a "Select dates Jul 29 — Aug 17" summary
 * is often only captured as part of a SUBMIT event's textContent, e.g. Booking's
 * form-region aria snapshot) for a string naming two full dates. Returns them in
 * the order they appear (check-in first, check-out second) — the reliable way
 * to resolve a cross-month calendar range, vs. guessing a month offset between
 * two bare day-of-month cells.
 */
/**
 * Every ISO date appearing in any URL the recording touched, in order. After a
 * search submits, the site puts the dates it actually used into the results URL
 * (Booking's "checkin=2026-07-29", GoZayaan's "trips=CGP,ZYL,2026-07-22,..."),
 * which is the most authoritative record of what the user picked — far better
 * than inferring a month for a bare day-of-month calendar cell. Some pickers
 * (GoZayaan) render day cells with no aria-label, no data-date and no visible
 * month anywhere, so this is the ONLY place their real dates survive.
 */
function findDatesInUrls(events: RecordedEvent[]): string[] {
  const out: string[] = []
  for (const e of events) {
    const re = /(20\d{2}-\d{2}-\d{2})/g
    let m: RegExpExecArray | null
    while ((m = re.exec(e.url ?? ''))) {
      if (!out.includes(m[1])) out.push(m[1])
    }
  }
  return out
}

function findContextDateRange(events: RecordedEvent[]): string[] | null {
  for (const e of events) {
    const year = new Date(e.timestamp || Date.now()).getFullYear()
    for (const src of [e.selector.textContent, e.selector.ariaLabel, e.selector.labelText]) {
      const dates = parseAllDatesInLabel(src, year)
      if (dates.length >= 2) return dates
    }
  }
  return null
}

const CHOICE_ROLES = new Set(['option', 'gridcell', 'cell', 'tab', 'radio', 'menuitem', 'td', 'listitem'])

/** Plain action buttons — clicking these is navigation, never a changeable preference */
const ACTION_WORDS = new Set([
  'search', 'done', 'submit', 'ok', 'cancel', 'close', 'next', 'back', 'continue',
  'go', 'apply', 'save', 'login', 'log in', 'sign in', 'sign up', 'accept', 'agree',
])

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Parse a full ISO date (YYYY-MM-DD) from a calendar cell's aria-label or text.
 * Handles "Thursday, July 16, 2026", "Wed, Jul 22", "16 July 2026", etc.
 * Returns null if no confident date. Year falls back to the given context year.
 */
export function parseDateLabel(aria: string | null, text: string | null, contextYear: number): string | null {
  const src = `${aria ?? ''} ${text ?? ''}`.toLowerCase()
  const monthMatch = src.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/)
  if (!monthMatch) return null
  const month = MONTHS[monthMatch[1]]
  const dayMatch = src.match(/\b(\d{1,2})\b(?!\s*:)/)
  if (!dayMatch) return null
  const day = parseInt(dayMatch[1], 10)
  if (day < 1 || day > 31) return null
  const yearMatch = src.match(/\b(20\d{2})\b/)
  const year = yearMatch ? parseInt(yearMatch[1], 10) : contextYear
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Does this click look like picking an option (calendar day, dropdown item,
 * suggestion, filter tab)?
 *
 * `maxLen` is context-dependent on purpose. A generic page click gets a tight
 * cap so long marketing copy ("Promotions, deals, and special offers for you")
 * never becomes a form field. But a click landing right after the user opened a
 * search box is a SUGGESTION, and those are legitimately longer — a recent-route
 * chip reads "Dallas (DFW) - Los Angeles (LAX)" (32 chars). Capping those at 30
 * silently threw the whole choice away, which is why flight forms came out with
 * no destination field at all.
 */
function isChoiceClick(e: RecordedEvent, maxLen = 30): boolean {
  if (e.type !== 'click') return false
  const text = e.selector.textContent?.trim() ?? ''
  if (!text || text.length < 1 || text.length > maxLen) return false
  if (ACTION_WORDS.has(text.toLowerCase())) return false
  const role = (e.selector.role ?? '').toLowerCase()
  const numeric = /^\d{1,3}$/.test(text)
  const dateLike = /^\d{1,2}[\s/-]|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text)
  const shortLabel = text.length <= maxLen && /^[\w\s.,'’&()-]+$/.test(text)
  return CHOICE_ROLES.has(role) || numeric || dateLike || shortLabel
}

/** Is this click opening a destination/location search box (the step right before a place-name choice)? */
function isSearchBoxOpener(e: RecordedEvent): boolean {
  if (e.type !== 'click') return false
  const role = (e.selector.role ?? '').toLowerCase()
  const hint = `${e.selector.ariaLabel ?? ''} ${e.selector.labelText ?? ''}`
  return role === 'combobox' || role === 'searchbox' || /destination|where|going|location|search/i.test(hint)
}

/**
 * Which side of a two-box journey search this input represents. Flight/car forms
 * label their boxes explicitly ("Origin location" / "From?" vs "Destination
 * location" / "To?"), so a suggestion clicked right after opening one can be
 * named for the box it fills instead of a meaningless "choice 2". The site
 * adapters match origin/destination BY NAME, so getting this right is what lets
 * a flight search build a real URL rather than falling back to fragile replay.
 */
function openerFieldRole(e: RecordedEvent | undefined): 'origin' | 'destination' | null {
  if (!e) return null
  const hint = `${e.selector.ariaLabel ?? ''} ${e.selector.labelText ?? ''} ${e.selector.placeholder ?? ''}`.toLowerCase()
  if (/\borigin\b|\bfrom\b|from\?|leaving|pick.?up/.test(hint)) return 'origin'
  if (/\bdestination\b|\bto\b|to\?|going|arrival|drop.?off/.test(hint)) return 'destination'
  return null
}

/**
 * A single "recent search" chip can name BOTH ends of a journey — "Dallas (DFW)
 * - Los Angeles (LAX)". Clicking it fills origin and destination at once, so it
 * must become two fields, not one. Requires whitespace around the dash so real
 * hyphenated place names ("Stratford-upon-Avon", "Cox's Bazar-2") never split.
 */
function splitRoutePair(text: string): [string, string] | null {
  const m = text.match(/^(.{2,28}?)\s+[-–—]\s+(.{2,28})$/)
  if (!m) return null
  const [, a, b] = m
  // Both halves must read like place names, not a sentence fragment or a range.
  if (!/[a-z]/i.test(a) || !/[a-z]/i.test(b)) return null
  return [a.trim(), b.trim()]
}

/**
 * Clicking a field's OWN label (e.g. a `<label>` wrapping/pointing at an empty
 * "Enter destination" box) is just focusing the field — its text is placeholder
 * prompt copy, never a real value. Without this it becomes its own spurious
 * variable duplicating the real destination field that follows.
 */
function isPlaceholderPrompt(e: RecordedEvent): boolean {
  if (e.type !== 'click') return false
  const text = (e.selector.textContent ?? '').trim()
  if (!text) return false
  const label = (e.selector.labelText ?? e.selector.ariaLabel ?? '').trim()
  // Own-label click: the visible text IS the field's label/prompt, not a value.
  if (label && text.toLowerCase() === label.toLowerCase() && /^(enter|select|choose|search for|pick|add)\b/i.test(text)) {
    return true
  }
  return /^(enter|select|choose|search for|pick)\s+\w/i.test(text) && text.length < 40
}

/**
 * Insert a space at a lowercase→uppercase boundary — recovers from the recorder
 * concatenating visually-separate sibling text (city + country tiles, "Kuala
 * Lumpur" + "Malaysia") with no whitespace between them: "KualaLumpur" or
 * "DhakaBangladesh" → readable, correctly-matchable text. A no-op on normal text.
 */
function repairConcatenatedWords(s: string): string {
  return s.replace(/([a-zÀ-ɏ])([A-Z])/g, '$1 $2')
}

/** Heuristic variable detection — used standalone and as fallback when LLM unavailable */
export function detectVariablesHeuristic(events: RecordedEvent[]): VariableField[] {
  // Indices to SKIP for being a redundant row-click duplicate of the very next
  // checkbox toggle — kept as a set (not a filtered array) so every eventIndex
  // stays a true index into `events`, matching what replay expects.
  const skipRowClick = findRedundantRowClickIndices(events)
  const contextRefDate = findContextRefDate(events)
  const vars: VariableField[] = []
  events.forEach((e, i) => {
    if (skipRowClick.has(i)) return
    // A field's own "Enter destination"/"Select dates" prompt click — never a value.
    if (isPlaceholderPrompt(e)) return

    // A date-shaped aria/label ALWAYS wins over role, even role="checkbox" — some
    // sites (Booking) implement calendar day cells with a literal checkbox ARIA
    // role, which would otherwise turn "Thursday, July 23, 2026" into a nonsense
    // boolean filter instead of the check-in/check-out date it actually is.
    const looksLikeDate =
      e.type === 'click' &&
      (parseDateLabel(e.selector.ariaLabel, null, new Date(e.timestamp || Date.now()).getFullYear()) != null ||
        parseDateLabel(null, e.selector.textContent, new Date(e.timestamp || Date.now()).getFullYear()) != null)

    // Checkbox / radio (side filters, sub-options) → an on/off toggle field.
    const isToggle =
      !looksLikeDate &&
      (e.inputType === 'checkbox' || e.inputType === 'radio' || (e.selector.role ?? '').toLowerCase() === 'checkbox') &&
      (e.type === 'input' || e.type === 'change' || e.type === 'click')
    if (isToggle) {
      const rawLabel =
        e.selector.ariaLabel || e.selector.labelText || e.selector.textContent || e.selector.name || `filter ${vars.length + 1}`
      const on = e.value == null ? true : e.value !== 'false'
      vars.push({
        name: rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `filter_${vars.length + 1}`,
        label: rawLabel.slice(0, 60),
        type: 'boolean',
        kind: 'input',
        eventIndex: i,
        sampleValue: on ? 'true' : 'false',
        required: false,
      })
      return
    }

    const editable =
      e.inputType !== null &&
      !['checkbox', 'radio', 'submit', 'button'].includes(e.inputType) &&
      (e.type === 'input' || e.type === 'change') &&
      e.value !== null &&
      e.value.length > 0

    if (editable) {
      const rawLabel =
        e.selector.labelText || e.selector.ariaLabel || e.selector.placeholder || e.selector.id || `field ${vars.length + 1}`
      const type: VariableField['type'] =
        e.inputType === 'date' ? 'date'
        : e.inputType === 'number' ? 'number'
        : e.inputType === 'email' ? 'email'
        : e.inputType === 'select' ? 'select'
        : 'text'
      vars.push({
        name: rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `field_${vars.length + 1}`,
        label: rawLabel.slice(0, 60),
        type,
        kind: 'input',
        eventIndex: i,
        sampleValue: e.value,
        required: true,
      })
      return
    }

    // A click landing straight after a search box was opened is a suggestion, so
    // it earns a longer text allowance than an arbitrary page click (see
    // isChoiceClick) — recent-route chips are longer than a plain city name.
    const prevEvt = events[i - 1]
    const openedBox = prevEvt != null && isSearchBoxOpener(prevEvt)

    if (isChoiceClick(e, openedBox ? 60 : 30)) {
      const text = e.selector.textContent!.trim()
      const label = e.selector.labelText?.trim() ?? ''
      // A destination/location tile right after opening a search box often has a
      // compound layout (bold city + grey country). labelText usually carries the
      // primary name ("Bangkok"), textContent can land on a child subtitle
      // ("Thailand") — using text unconditionally produced the wrong value. When
      // this follows a search-box opener and the two differ, trust the label.
      const afterOpener = openedBox
      const useLabelAsValue = afterOpener && label && norm(label) !== norm(text)
      const rawLabel = e.selector.ariaLabel || (afterOpener ? 'Destination' : label) || `choice ${vars.length + 1}`
      // Destination tiles concatenate sibling text with no space ("KualaLumpur",
      // "DhakaBangladesh") when the recorder captures them before the layout-aware
      // text fix takes effect on older recordings — repair defensively either way.
      const value = afterOpener ? repairConcatenatedWords(useLabelAsValue ? label : text) : useLabelAsValue ? label : text
      const contextYear = new Date(e.timestamp || Date.now()).getFullYear()
      // Aria-resolved dates are reliable; text-only ("Wed, Jul 22") are weak guesses.
      const isoFromAria = parseDateLabel(e.selector.ariaLabel, null, contextYear)
      const iso = isoFromAria ?? parseDateLabel(null, value, contextYear)

      // One chip naming BOTH ends of a journey ("Dallas (DFW) - Los Angeles
      // (LAX)") fills origin and destination at once — emit both fields so the
      // form is complete and the flight adapter can resolve a real route.
      const routePair = !iso && afterOpener ? splitRoutePair(value) : null
      if (routePair) {
        const [from, to] = routePair
        for (const [side, sideValue] of [['origin', from], ['destination', to]] as const) {
          vars.push({
            name: side,
            label: side === 'origin' ? 'From' : 'To',
            type: 'text',
            kind: 'choice',
            eventIndex: i,
            sampleValue: sideValue,
            required: true,
            autocomplete: true,
          })
        }
        return
      }

      // Name a suggestion after the box it fills ("Origin location" → origin),
      // so journey forms read correctly and adapters can match by name. Dates
      // are exempt: they're renamed to check-in/check-out by actual value later.
      const side = iso ? null : openerFieldRole(prevEvt)
      const fallbackName = rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      vars.push({
        name: (side ?? (afterOpener ? 'destination' : fallbackName)).slice(0, 40) || `choice_${vars.length + 1}`,
        // Only an origin box needs relabelling — rawLabel's fallback is the word
        // "Destination", which is plainly wrong for a "From" field. Everything
        // else keeps the label it already had (a hotel's destination box must
        // stay "Destination", not become a journey-style "To").
        label: side === 'origin' ? 'From' : rawLabel.slice(0, 60),
        type: iso ? 'date' : 'text',
        kind: 'choice',
        eventIndex: i,
        sampleValue: iso ?? value,
        required: true,
        ...(iso ? { dateStrong: isoFromAria !== null } : {}),
        ...(afterOpener ? { autocomplete: true } : {}),
      } as VariableField & { dateStrong?: boolean })
    }
  })
  // uniqueNames last: two clicks can legitimately share a label (a site with
  // several unlabelled location boxes yields three "destination" fields), and
  // duplicate names collide in the values map — the form renders repeated rows
  // that overwrite each other. The LLM paths already do this; the heuristic
  // path did not.
  return uniqueNames(
    renameJourneyDates(
      dropDuplicateLocationChoices(
        dedupeSameField(splitOccupancy(cleanDateChoices(mergeTypedAutocomplete(vars, events), events, contextRefDate)), events),
      ),
    ),
  )
}

/**
 * Collapse "typed into an autocomplete, then clicked a suggestion" into ONE
 * field. The recording captures both halves separately, so a car-hire pick-up
 * came out as two junk fields — a half-typed "Dala" AND a "Dalaman Airport
 * (DLM)" choice — neither of which reads as the single location box the user
 * actually filled.
 *
 * Keeps the TYPED field's identity (its label is the real one — "Pick-up
 * location") and its eventIndex (replay must type into the box, not click a
 * suggestion that isn't rendered yet), but takes the SUGGESTION's value, since
 * that's the resolved, complete place name rather than a partial prefix.
 */
function mergeTypedAutocomplete(vars: VariableField[], events: RecordedEvent[]): VariableField[] {
  const drop = new Set<number>()
  for (let a = 0; a < vars.length; a++) {
    const typed = vars[a]
    if (typed.kind !== 'input' || typed.type !== 'text' || !typed.sampleValue) continue
    const next = vars[a + 1]
    if (!next || next.kind !== 'choice' || next.type !== 'text' || !next.sampleValue) continue
    // Must be the same interaction: the suggestion click follows the typing
    // within a couple of events, not some unrelated later choice.
    if (next.eventIndex <= typed.eventIndex || next.eventIndex - typed.eventIndex > 2) continue

    const prefix = norm(typed.sampleValue)
    const suggestionLabel = events[next.eventIndex]?.selector.labelText?.trim() ?? ''
    // What was typed must actually be a prefix of what got picked — otherwise
    // these are two genuinely different fields that merely sit next to each other.
    if (!prefix || (!norm(next.sampleValue).startsWith(prefix) && !norm(suggestionLabel).startsWith(prefix))) continue

    // Prefer the suggestion's own label ("Dalaman Airport (DLM)") over the row's
    // descriptive text ("Dalaman, Aegean Region, Turkey") — it's the canonical
    // name the site's own autocomplete will match on a re-run.
    typed.sampleValue = suggestionLabel || next.sampleValue
    typed.autocomplete = true
    drop.add(a + 1)
  }
  return vars.filter((_, i) => !drop.has(i))
}

/**
 * On a journey search (an explicit origin AND destination, no rooms/guests),
 * hotel wording is just wrong — a flight has a departure and a return, not a
 * check-in and a check-out. Purely presentational, but "no clear form" is a real
 * usability complaint. Names stay adapter-compatible: every flight adapter
 * already matches departure via /depart/ and return via /return/.
 */
function renameJourneyDates(vars: VariableField[]): VariableField[] {
  const isJourney =
    vars.some((v) => v.name === 'origin') &&
    vars.some((v) => v.name === 'destination') &&
    !vars.some((v) => v.kind === 'guests')
  if (!isJourney) return vars
  return vars.map((v) =>
    v.name === 'check_in_date' ? { ...v, name: 'departure_date', label: 'Departure date' }
    : v.name === 'check_out_date' ? { ...v, name: 'return_date', label: 'Return date' }
    : v,
  )
}

/**
 * Drop an unnamed "choice_N" location that merely repeats a value already held
 * by a properly-named field. Clicking a recent-search chip can register both a
 * bare city click and the full route chip; without this the form shows the
 * origin twice, once under a meaningless label.
 */
function dropDuplicateLocationChoices(vars: VariableField[]): VariableField[] {
  const named = vars.filter((v) => v.type === 'text' && !/^choice_\d+$/.test(v.name))
  return vars.filter((v) => {
    if (!/^choice_\d+$/.test(v.name) || v.type !== 'text' || !v.sampleValue) return true
    return !named.some((n) => n.sampleValue && norm(n.sampleValue) === norm(v.sampleValue!))
  })
}

/**
 * If the user edited one field twice (e.g. typed a subject, changed it), the
 * recording yields two variables for the same physical field. Keep only the
 * last edit per field. Only merges text/input fields — choices, guests and
 * booleans are left alone.
 */
function dedupeSameField(vars: VariableField[], events: RecordedEvent[]): VariableField[] {
  const lastIdxForKey = new Map<string, number>()
  vars.forEach((v, arrIdx) => {
    if (v.kind !== 'input' || v.type === 'boolean') return
    const e = events[v.eventIndex]
    if (!e) return
    lastIdxForKey.set(stableFieldKey(e), arrIdx)
  })
  const dropArrIdx = new Set<number>()
  const seen = new Map<string, number>()
  vars.forEach((v, arrIdx) => {
    if (v.kind !== 'input' || v.type === 'boolean') return
    const e = events[v.eventIndex]
    if (!e) return
    const key = stableFieldKey(e)
    if (seen.has(key)) dropArrIdx.add(seen.get(key)!) // drop the earlier one
    seen.set(key, arrIdx)
  })
  return vars.filter((_, i) => !dropArrIdx.has(i))
}

/**
 * Split an occupancy choice like "2 adults · 0 children · 1 room" into editable
 * adults / children / rooms number fields sharing the occupancy event, so the
 * user can change the guest counts (e.g. number of children) on a run.
 */
function splitOccupancy(vars: VariableField[]): VariableField[] {
  const out: VariableField[] = []
  for (const v of vars) {
    const m = (v.sampleValue ?? '').match(/(\d+)\s*adult.*?(\d+)\s*child.*?(\d+)\s*room/i)
    if (v.kind === 'choice' && m) {
      const [adults, children, rooms] = [m[1], m[2], m[3]]
      const base = { eventIndex: v.eventIndex, kind: 'guests' as const, type: 'number' as const, required: true }
      out.push({ ...base, name: 'adults', label: 'Adults', guestType: 'adults', sampleValue: adults })
      out.push({ ...base, name: 'children', label: 'Children', guestType: 'children', sampleValue: children })
      out.push({ ...base, name: 'rooms', label: 'Rooms', guestType: 'rooms', sampleValue: rooms })
    } else {
      out.push(v)
    }
  }
  return out
}

/**
 * Resolve the calendar-click mess: booking-style pickers emit a noise click
 * (old selected date) plus the real check-in and check-out. Drop weak text-only
 * date guesses next to reliable aria-resolved ones, and fill bare day-numbers
 * ("24") with the month/year of the nearest reliable date — from another strong
 * date var if one exists, else from the "Select dates" trigger's own label.
 */
/**
 * Dual/multi-month calendars (Booking, Airbnb, Expedia...) show two month grids
 * side by side as sibling containers — a bare day cell in the SECOND grid means
 * next month, not the same month as a reference cell in the first. Extract which
 * sibling table a cell's recorded css path sits in, e.g. "...div:nth-of-type(2)
 * > table..." → 2, so bare-day fills can offset the month instead of assuming
 * every date shares the reference's exact month.
 */
function calendarTableOrdinal(css: string | null | undefined): number {
  if (!css) return 1
  const m = css.match(/div(?::nth-of-type\((\d+)\))?\s*>\s*table\b/)
  return m ? parseInt(m[1] ?? '1', 10) : 1
}

function cleanDateChoices(
  vars: (VariableField & { dateStrong?: boolean })[],
  events: RecordedEvent[],
  contextRefDate: string | null = null,
): VariableField[] {
  const dateVars = vars.filter((v) => v.type === 'date' || (v.kind === 'choice' && /^\d{1,2}$/.test(v.sampleValue ?? '')))
  if (dateVars.length === 0) return vars.map(strip)

  const strong = vars.find((v) => v.type === 'date' && v.dateStrong && v.sampleValue)
  const refDate = strong?.sampleValue ?? contextRefDate // YYYY-MM-DD
  const refTableOrdinal = strong ? calendarTableOrdinal(events[strong.eventIndex]?.selector.css) : null

  // Prefer resolving bare day-of-month cells ("29", "17") straight from a full
  // date-RANGE summary when one exists, in click order (check-in cell clicked
  // first, check-out second) — sidesteps the fragile single-reference +
  // calendar-grid-offset guess below, which breaks whenever no individually
  // aria-labeled "strong" date exists (e.g. the range text only appears on the
  // form's SUBMIT event, not on either day-cell's own click).
  if (!strong) {
    const bareNumberVars = dateVars.filter((v) => v.kind === 'choice' && /^\d{1,2}$/.test(v.sampleValue ?? ''))
    if (bareNumberVars.length >= 2) {
      const range = findContextDateRange(events)
      if (range && range.length >= bareNumberVars.length) {
        bareNumberVars.forEach((v, idx) => {
          v.type = 'date'
          v.sampleValue = range[idx]
          v.dateStrong = true
        })
      }
    }
    // Still unresolved? Recover from the dates the SITE ITSELF put in the
    // results URL after the search ran, matching each bare cell to the URL date
    // sharing its day-of-month. Some calendars (GoZayaan) give day cells no
    // aria-label, no data-date and no visible month, so the URL is the only
    // surviving record — without this those clicks stay junk "21"/"16" text
    // fields and the run silently falls back to a default departure date.
    const stillBare = vars.filter((v) => v.kind === 'choice' && /^\d{1,2}$/.test(v.sampleValue ?? ''))
    if (stillBare.length > 0) {
      const urlDates = findDatesInUrls(events)
      const used = new Set<string>()
      for (const v of stillBare) {
        const day = parseInt(v.sampleValue!, 10)
        const hit = urlDates.find((iso) => !used.has(iso) && parseInt(iso.slice(8, 10), 10) === day)
        if (!hit) continue
        used.add(hit)
        v.type = 'date'
        v.sampleValue = hit
        v.dateStrong = true
      }
    }
  }

  const drop = new Set<VariableField>()
  for (const v of vars) {
    if (v.type !== 'date' && !(v.kind === 'choice' && /^\d{1,2}$/.test(v.sampleValue ?? ''))) continue

    // Fill a bare day-number ("24") from the reference date's month/year.
    if (/^\d{1,2}$/.test(v.sampleValue ?? '') && refDate) {
      const [y, m] = refDate.split('-').map((n) => parseInt(n, 10))
      // Bump the month by however many calendar grids over this cell sits from
      // the reference cell (0 if same grid, +1 for the next grid over, etc).
      // NOT clamped to >=0: the bare-day cell can sit in an EARLIER grid than the
      // reference (e.g. reference resolved in the second/August grid, this cell in
      // the first/July grid) — a negative offset correctly means "a month before".
      const tableOffset = refTableOrdinal != null ? calendarTableOrdinal(events[v.eventIndex]?.selector.css) - refTableOrdinal : 0
      const d = new Date(y, m - 1 + tableOffset, parseInt(String(v.sampleValue), 10))
      v.type = 'date'
      v.sampleValue = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // Weak text-only date next to a strong one = noise (old pre-selected date).
    if (v.type === 'date' && v.dateStrong === false && strong && v !== strong) {
      drop.add(v)
    }
  }
  const survivors = vars.filter((v) => !drop.has(v))
  // Rename check-in/check-out by ACTUAL DATE VALUE (earliest = check-in), not by
  // click/array order — a user can click checkout before check-in (adjusting an
  // already-selected range), so order-based naming would swap them. Done as a
  // final pass over every date (not just ones that started as bare numbers) so
  // an already-resolved cell doesn't keep an ugly literal name while a bare-
  // number cell wrongly steals the "check-in" label.
  const dateSurvivors = survivors.filter((v) => v.type === 'date').sort((a, b) => (a.sampleValue ?? '').localeCompare(b.sampleValue ?? ''))
  dateSurvivors.forEach((v, ordinal) => {
    if (ordinal === 0) {
      v.name = 'check_in_date'
      v.label = 'Check-in date'
    } else if (ordinal === 1) {
      v.name = 'check_out_date'
      v.label = 'Check-out date'
    }
  })
  return survivors.map(strip)
}

function strip(v: VariableField & { dateStrong?: boolean }): VariableField {
  const { dateStrong: _omit, ...rest } = v
  void _omit
  return rest
}

/**
 * Hotel-style searches need BOTH a check-in AND check-out date, but if the user
 * only clicked ONE calendar date while recording (a range-picker can be closed
 * after a single click, e.g. via "Done"), there's no second click for anything
 * to capture — the form would silently have no way to specify a checkout at
 * all. When exactly one date field exists alongside guest fields (adults/rooms
 * — the hotel-search signature), synthesize a checkout field sharing the SAME
 * event as check-in: replay clicks BOTH dates in one calendar visit (see the
 * shared-event date-pair handling in engine.ts) even though only one was ever
 * actually recorded.
 */
/**
 * Mark location-style text inputs as autocomplete fields. Sites like Booking
 * cars ("Pick-up location"), GoZayaan hotels ("City / area"), and tours resolve
 * a typed place to an internal id ONLY when you pick from their suggestion
 * dropdown — a plain fill leaves the search unresolved. Flagging these makes
 * replay type-then-pick-a-suggestion instead of just typing.
 */
export function ensureAutocompleteFlags(variables: VariableField[]): VariableField[] {
  return variables.map((v) => {
    if (v.type !== 'text' || v.kind !== 'input' || v.autocomplete) return v
    const s = `${v.name} ${v.label}`.toLowerCase()
    if (
      /destinat|origin|\bfrom\b|\bto\b|pick.?up|drop.?off|location|going|leaving|arriv|where|\bcity\b|airport|station|search/.test(
        s,
      )
    ) {
      return { ...v, autocomplete: true }
    }
    return v
  })
}

export function ensureCheckoutDate(variables: VariableField[]): VariableField[] {
  const dateVars = variables.filter((v) => v.type === 'date')
  const hasGuestFields = variables.some((v) => v.kind === 'guests')
  if (dateVars.length !== 1 || !hasGuestFields) return variables
  const checkIn = dateVars[0]
  if (!checkIn.sampleValue || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn.sampleValue)) return variables

  // Calendar-date arithmetic, not an instant — building it via toISOString()
  // converts to UTC and can shift the date by a day in timezones ahead of UTC.
  // Read/write the local date parts directly instead.
  const inDate = new Date(`${checkIn.sampleValue}T00:00:00`)
  const outDate = new Date(inDate)
  outDate.setDate(outDate.getDate() + 3)
  const checkOut: VariableField = {
    name: 'check_out_date',
    label: 'Check-out date',
    type: 'date',
    kind: 'input',
    eventIndex: checkIn.eventIndex,
    sampleValue: `${outDate.getFullYear()}-${String(outDate.getMonth() + 1).padStart(2, '0')}-${String(outDate.getDate()).padStart(2, '0')}`,
    required: true,
  }
  const idx = variables.indexOf(checkIn)
  const out = [...variables]
  out.splice(idx + 1, 0, checkOut)
  return out
}

/**
 * Detect a "send email" automation: the recording is on a mail provider and the
 * form has recognizable To / Subject / Body fields. When present, the app can
 * send via SMTP (reliable) instead of fragile Gmail-DOM replay.
 */
export function detectEmailAction(
  session: RecordingSession,
  variables: VariableField[],
): { provider: string; toField: string | null; subjectField: string | null; bodyField: string | null } | null {
  const domains = session.segments.map((s) => s.domain).join(' ')
  const provider =
    /mail\.google|gmail/i.test(domains) ? 'gmail'
    : /outlook|live\.com|hotmail/i.test(domains) ? 'outlook'
    : /mail\.yahoo/i.test(domains) ? 'yahoo'
    : null
  if (!provider) return null

  const find = (re: RegExp) => variables.find((v) => re.test(v.label) || re.test(v.name))?.name ?? null
  const toField = find(/recipient|^to\b|to_/i)
  const subjectField = find(/subject/i)
  const bodyField = find(/body|message|content/i)
  if (!toField && !subjectField && !bodyField) return null
  return { provider, toField, subjectField, bodyField }
}

/**
 * Detect a login in the recording: a password field means the site needed
 * sign-in. The recorder redacts the password value, so we only mark WHERE it
 * goes; the user supplies the actual secret. The username is the nearest text/
 * email input before the password.
 */
export function detectLogin(events: RecordedEvent[]): {
  passwordEventIndex: number
  usernameEventIndex: number | null
  usernameLabel: string
  domain: string
} | null {
  const pwIdx = events.findIndex(
    (e) => e.inputType === 'password' && (e.type === 'input' || e.type === 'change'),
  )
  if (pwIdx === -1) return null

  let usernameEventIndex: number | null = null
  for (let i = pwIdx - 1; i >= 0 && i >= pwIdx - 6; i--) {
    const e = events[i]
    if ((e.type === 'input' || e.type === 'change') && ['text', 'email', 'tel'].includes(e.inputType ?? '')) {
      usernameEventIndex = i
      break
    }
  }
  const uEvent = usernameEventIndex != null ? events[usernameEventIndex] : null
  const usernameLabel =
    uEvent?.selector.labelText || uEvent?.selector.ariaLabel || uEvent?.selector.placeholder || 'Username / email'

  return {
    passwordEventIndex: pwIdx,
    usernameEventIndex,
    usernameLabel: usernameLabel.slice(0, 60),
    domain: events[pwIdx].domain,
  }
}

function uniqueNames(vars: VariableField[]): VariableField[] {
  const seen = new Map<string, number>()
  return vars.map((v) => {
    const count = seen.get(v.name) ?? 0
    seen.set(v.name, count + 1)
    return count === 0 ? v : { ...v, name: `${v.name}_${count + 1}` }
  })
}

interface LlmLabel {
  eventIndex: number
  name: string
  label: string
  type: VariableField['type']
}

interface SynthField {
  name: string
  label: string
  type: VariableField['type']
  kind?: 'input' | 'choice' | 'guests'
  guestType?: 'adults' | 'children' | 'rooms'
  autocomplete?: boolean
  eventIndex: number
  sampleValue: string | number | null
}

/**
 * LLM-first form synthesis. Instead of guessing variables per-event and hoping
 * the labels come out right, we hand the model the WHOLE recording and ask it to
 * produce the clean, canonical set of fields a user would fill for this task —
 * deduplicated, correctly typed, each mapped to the event its value comes from.
 * The model reasons about the task ("hotel search → destination, dates, guests")
 * which is far more reliable than stitching noisy events together.
 *
 * Returns null (caller falls back to the heuristic) if no API key or on any
 * failure, so behavior degrades gracefully and never blocks automation creation.
 */
export async function synthesizeForm(
  session: RecordingSession,
): Promise<{ variables: VariableField[]; title: string; description: string } | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return null

  const collapsed = collapseInputEvents(session.events).filter((e) => e.type !== 'navigation')
  // Present each candidate event with its ORIGINAL index so the model maps
  // fields straight to the indices replay uses — no remapping afterwards.
  const items = collapsed
    .map((e) => {
      const originalIndex = session.events.findIndex(
        (o) => o.id === e.id || (o.selector.css === e.selector.css && o.type === e.type),
      )
      const contextYear = new Date(e.timestamp || Date.now()).getFullYear()
      const iso = e.type === 'click' ? parseDateLabel(e.selector.ariaLabel, e.selector.textContent, contextYear) : null
      return {
        eventIndex: originalIndex,
        action: e.type,
        inputType: e.inputType,
        typedValue: e.type === 'input' || e.type === 'change' ? e.value : null,
        clickedText: e.type === 'click' ? (e.selector.textContent ?? '').slice(0, 40) : null,
        ariaLabel: e.selector.ariaLabel,
        label: e.selector.labelText,
        placeholder: e.selector.placeholder,
        fieldId: e.selector.id || e.selector.name,
        resolvedDate: iso,
        isPassword: e.inputType === 'password',
      }
    })
    .filter((it) => it.eventIndex >= 0)

  const domains = session.segments.map((s) => s.domain).join(' -> ')
  const prompt = `You are turning a recorded browser task into a clean, reusable input form.
Site(s): ${domains}

Below is the ordered list of the user's actions (typed values and clicked options). Figure out what task this is, then output the MINIMAL, CANONICAL set of fields a user would fill to repeat it — as if designing the form yourself. Be precise and consistent.

RULES:
- One field per real user input. NEVER output duplicates for the same thing.
- If the user typed into an autocomplete then clicked a suggestion (e.g. a city/destination), output ONE field with a CLEAN value (the intended text, e.g. "Kuala Lumpur" — not "Kuala LumpurMalaysia"). Map it to the TYPED input event, set kind "input" AND "autocomplete": true.
- Dates: output separate "check_in_date" and "check_out_date" fields (whichever exist) as type "date" with the resolvedDate (YYYY-MM-DD) as sampleValue. Use resolvedDate to disambiguate; ignore stray/duplicate calendar clicks.
- Guest counts ("2 adults · 0 children · 1 room"): output separate number fields "adults","children","rooms" with kind "guests" and guestType set. Map all three to the occupancy event index. Do NOT output a raw "18"-style garbage number.
- Search boxes / query fields → type "text".
- Filters/checkboxes the user toggled (star rating, "Breakfast included", "Free cancellation", property type, price bands) → ONE boolean field each, label = the filter's visible name (WITHOUT result counts like ": 147 properties"), sampleValue "true", mapped to that click.
- Currency / language / units picker the user changed → ONE field named after it (e.g. "currency"), kind "choice", sampleValue the picked value (e.g. "BDT"). Skip if the user never changed it.
- Sort order the user picked → ONE choice field (e.g. "sort_by") with the clicked option text.
- DROP: password fields, pure navigation clicks, "Search"/"Done"/"Submit" buttons, and anything that isn't a value the user would change.
- Every field MUST reference a real eventIndex from the list.

Actions:
${JSON.stringify(items, null, 2)}

Respond ONLY with JSON:
{"title":"short task title","description":"one sentence","fields":[{"name":"snake_case","label":"Human Label","type":"text|date|number|email|select|boolean","kind":"input|choice|guests","guestType":"adults|children|rooms (only for guests)","autocomplete":true (only for city/location search fields),"eventIndex":<number>,"sampleValue":"..."}]}`

  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { choices: { message: { content: string } }[] }
    const parsed = JSON.parse(data.choices[0].message.content) as {
      title: string
      description: string
      fields: SynthField[]
    }
    if (!Array.isArray(parsed.fields)) return null

    const valid = parsed.fields.filter(
      (f) => Number.isInteger(f.eventIndex) && f.eventIndex >= 0 && f.eventIndex < session.events.length && f.name,
    )
    if (valid.length === 0) return null

    const variables: VariableField[] = uniqueNames(
      valid.map((f) => {
        // Safety: if the model marked a guests field but forgot guestType,
        // infer it from the field name so replay's stepper logic still works.
        let guestType = f.guestType
        if (f.kind === 'guests' && !guestType) {
          guestType = /adult/i.test(f.name) ? 'adults' : /child|kid/i.test(f.name) ? 'children' : /room/i.test(f.name) ? 'rooms' : undefined
        }
        return {
          name: f.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field',
          label: (f.label || f.name).slice(0, 60),
          type: f.type ?? 'text',
          kind: f.kind ?? 'input',
          ...(guestType ? { guestType } : {}),
          ...(f.autocomplete ? { autocomplete: true } : {}),
          eventIndex: f.eventIndex,
          // Coerce to string so a numeric 0 never renders oddly or reads as falsy.
          sampleValue: f.sampleValue == null ? null : String(f.sampleValue),
          required: true,
        }
      }),
    )
    return { variables, title: parsed.title || 'Automation', description: parsed.description || '' }
  } catch {
    return null
  }
}

/** Ask DeepSeek to produce human-meaningful names/labels for detected variables */
export async function refineWithLlm(
  session: RecordingSession,
  heuristic: VariableField[],
): Promise<{ variables: VariableField[]; title: string; description: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  const fallback = {
    variables: heuristic,
    title: `Automation on ${session.segments.map((s) => s.domain).join(', ') || 'unknown site'}`,
    description: `Recorded ${session.events.length} steps.`,
  }
  if (!apiKey) return fallback

  // Guests fields (adults/children/rooms) keep their own names/labels — the LLM
  // never sees or renames them (they'd collide on a shared event index).
  const context = heuristic
    .filter((v) => v.kind !== 'guests')
    .map((v) => {
    const e = session.events[v.eventIndex]
    return {
      eventIndex: v.eventIndex,
      kind: v.kind ?? 'input',
      domain: e.domain,
      inputType: e.inputType,
      labelText: e.selector.labelText,
      ariaLabel: e.selector.ariaLabel,
      idAttr: e.selector.id,
      placeholder: e.selector.placeholder,
      clickedText: v.kind === 'choice' ? e.selector.textContent : null,
      resolvedDate: v.type === 'date' ? v.sampleValue : null,
      sampleValue: v.sampleValue,
    }
  })

  const prompt = `You are analyzing a recorded browser automation. The user visited: ${session.segments.map((s) => s.domain).join(' -> ')}.
Below are candidate changeable fields. kind "input" = something the user typed. kind "choice" = an option the user clicked (calendar day, dropdown item, filter tab).

For each field the user would plausibly want to change on a future run, produce a JSON object with:
- eventIndex (copy as-is)
- name: short snake_case machine name (e.g. "search_query", "check_in_date")
- label: human-friendly label (e.g. "Search query", "Check-in date")
- type: one of text|date|number|email|select|boolean

Omit "choice" candidates that are NOT real user preferences (e.g. clicking a random UI element, plain navigation, closing a popup). KEEP choices that select among alternatives: destination/location suggestions (like a city name), calendar dates, filter tabs (like "Shorts"/"Videos"), sort orders, category options, quantities. Keep ALL "input" candidates.

DATE PICKERS — important: a user often clicks a currently-shown/old date before picking the real one, so calendar clicks contain noise. Use the "resolvedDate" field (ISO YYYY-MM-DD) to reason. Output AT MOST ONE check-in date and ONE check-out date. When several date choices exist, the check-in is the earlier meaningful date and check-out the later one; DROP redundant/duplicate date clicks. Give date fields type "date" and a name like "check_in_date" / "check_out_date".

Also produce "title" (short automation title) and "description" (one sentence).

Fields:
${JSON.stringify(context, null, 2)}

Respond ONLY with JSON: {"title": "...", "description": "...", "fields": [{...}]}`

  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    })
    if (!resp.ok) return fallback
    const data = (await resp.json()) as { choices: { message: { content: string } }[] }
    const parsed = JSON.parse(data.choices[0].message.content) as {
      title: string
      description: string
      fields: LlmLabel[]
    }
    const variables = uniqueNames(
      heuristic
        .map((v) => {
          if (v.kind === 'guests') return v // keep verbatim, never LLM-renamed
          const llm = parsed.fields.find((f) => f.eventIndex === v.eventIndex)
          if (!llm) return v.kind === 'choice' ? null : v
          return { ...v, name: llm.name, label: llm.label, type: llm.type }
        })
        .filter((v): v is VariableField => v !== null),
    )
    return { variables, title: parsed.title, description: parsed.description }
  } catch {
    return fallback
  }
}
