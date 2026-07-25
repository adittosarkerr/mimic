import type { RecordedEvent, ReplayStepResult, RuntimeMessage } from '../shared/types'

/** Client-side element resolution — mirrors the server engine's locate() order. */
function findElement(e: RecordedEvent): Element | null {
  const s = e.selector
  const tries: (() => Element | null)[] = [
    () => (s.dataTestid ? document.querySelector(`[data-testid="${cssEsc(s.dataTestid)}"], [data-test-id="${cssEsc(s.dataTestid)}"], [data-qa="${cssEsc(s.dataTestid)}"]`) : null),
    // Skip auto-generated ids (React ":r1a:", radix) — random per page load.
    () => (s.id && !/^:r[\w]+:$/.test(s.id) && !/^radix-/.test(s.id) ? document.getElementById(s.id) : null),
    () => (s.name ? document.querySelector(`[name="${cssEsc(s.name)}"]`) : null),
    () => (s.ariaLabel ? document.querySelector(`[aria-label="${cssEsc(s.ariaLabel)}"]`) : null),
    () => (s.placeholder ? document.querySelector(`[placeholder="${cssEsc(s.placeholder)}"]`) : null),
    () => (s.css ? safeQuery(s.css) : null),
    () => (s.xpath ? byXpath(s.xpath) : null),
    () => (s.textContent && s.textContent.length > 2 && s.textContent.length < 60 ? byText(s.textContent) : null),
  ]
  for (const t of tries) {
    try {
      const el = t()
      if (el) return el
    } catch {
      /* keep trying */
    }
  }
  return null
}

function cssEsc(s: string): string {
  return s.replace(/(["\\])/g, '\\$1')
}
function safeQuery(sel: string): Element | null {
  try {
    return document.querySelector(sel)
  } catch {
    return null
  }
}
function byXpath(xp: string): Element | null {
  try {
    const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
    return r.singleNodeValue as Element | null
  } catch {
    return null
  }
}
function byText(text: string): Element | null {
  const target = text.trim()
  const els = document.querySelectorAll('a, button, span, div, li, td, [role]')
  for (const el of els) {
    if ((el.textContent || '').trim() === target) return el
  }
  return null
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Dismiss a modal/close button that's likely intercepting clicks (sign-in trap, promo popup). */
function dismissOverlaysInPage(): void {
  const selectors = [
    'button[aria-label="Dismiss sign-in info."]',
    '[aria-label*="Dismiss" i]',
    'button[aria-label*="Close" i]',
    'button[title*="Close" i]',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (el && isVisible(el)) {
      el.click()
      return
    }
  }
}

/** Click that survives a modal overlay intercepting the pointer — the same class
 * of failure ("subtree intercepts pointer events") the server engine hits on
 * Booking's sign-in trap. Retry after dismissing, then force as a last resort. */
function robustClickInPage(el: Element): void {
  const target = el as HTMLElement
  try {
    target.click()
    return
  } catch {
    /* fall through */
  }
  dismissOverlaysInPage()
  target.click()
}

async function waitFor(pred: () => Element | null, ms = 7000): Promise<Element | null> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const el = pred()
    if (el && isVisible(el)) return el
    await sleep(150)
  }
  return pred()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function typeInto(el: Element, value: string) {
  ;(el as HTMLElement).focus()
  await sleep(60)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, value)
  } else if ((el as HTMLElement).isContentEditable) {
    // Contenteditable (Gmail body, rich editors): clear then insert text and
    // fire the events editors listen for so the value sticks.
    const h = el as HTMLElement
    h.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(h)
    sel?.removeAllRanges()
    sel?.addRange(range)
    let inserted = false
    try {
      inserted = document.execCommand('insertText', false, value)
    } catch {
      inserted = false
    }
    if (!inserted) {
      h.textContent = value
    }
    h.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    h.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

function findChoiceByText(text: string): Element | null {
  return byText(text) ?? byTextPartial(text)
}

/** Smallest visible element whose text contains `text` (filters, currency rows). */
function byTextPartial(text: string): Element | null {
  const needle = text.trim().toLowerCase()
  if (!needle) return null
  let best: Element | null = null
  let bestLen = Infinity
  for (const el of document.querySelectorAll('label, a, button, span, div, li, td, [role]')) {
    const t = (el.textContent || '').trim()
    if (t.length < needle.length || t.length > 120) continue
    if (!t.toLowerCase().includes(needle)) continue
    if (!isVisible(el)) continue
    if (t.length < bestLen) {
      best = el
      bestLen = t.length
    }
  }
  return best
}

/** Fallback for clicks whose selectors drifted: find by stable visible label. */
function findByLabelFallback(e: RecordedEvent): Element | null {
  const label = (e.selector.labelText ?? e.selector.ariaLabel ?? e.selector.textContent ?? '')
    .replace(/:?\s*\d[\d,]*\s*(properties|results|hotels)?\s*$/i, '')
    .trim()
  if (label.length < 2 || label.length > 60) return null
  return byText(label) ?? byTextPartial(label)
}

function findDateCellOnce(iso: string): Element | null {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10))
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const monthName = months[m - 1]
  const candidates = [
    `[data-date="${iso}"]`,
    `[aria-label*="${monthName} ${d}, ${y}"]`,
    `[aria-label*="${monthName} ${d} ${y}"]`,
    `[aria-label*="${d} ${monthName} ${y}"]`,
  ]
  for (const sel of candidates) {
    const el = document.querySelector(sel)
    if (el && isVisible(el)) return el
  }
  return null
}

/**
 * Find a calendar day cell for an ISO date, navigating the calendar forward by
 * month if the target isn't showing yet (a future month for a fresh run) —
 * without this, only dates in the CURRENTLY displayed month(s) could ever be
 * selected on replay.
 */
async function findDateCellInPage(iso: string): Promise<Element | null> {
  let found = findDateCellOnce(iso)
  if (found) return found
  const nextBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
    const aria = (b as HTMLElement).getAttribute('aria-label') || ''
    const testid = (b as HTMLElement).getAttribute('data-testid') || ''
    return /next/i.test(aria) || /next/i.test(testid)
  }) as HTMLElement | undefined
  for (let k = 0; k < 15 && !found && nextBtn && isVisible(nextBtn); k++) {
    nextBtn.click()
    await sleep(300)
    found = findDateCellOnce(iso)
  }
  return found
}

/** Reopen a closed date picker so a calendar cell can be found (dismissal, rerender). */
async function reopenDatePicker(): Promise<void> {
  const openers = [
    '[data-testid="searchbox-dates-container"]',
    '[data-testid="date-display-field-start"]',
    '[aria-label*="Check-in" i]',
  ]
  for (const sel of openers) {
    const el = document.querySelector(sel) as HTMLElement | null
    if (el && isVisible(el)) {
      el.click()
      await sleep(600)
      return
    }
  }
}

async function setGuests(target: { adults?: number; children?: number; rooms?: number }): Promise<boolean> {
  const groups: { key: 'adults' | 'children' | 'rooms'; word: string; min: number }[] = [
    { key: 'adults', word: 'adult', min: 1 },
    { key: 'children', word: 'child', min: 0 },
    { key: 'rooms', word: 'room', min: 1 },
  ]
  let found = false
  for (const { key, word, min } of groups) {
    const want = target[key]
    if (want === undefined) continue
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
    const dec = btns.find((b) => /decrease|remove/i.test(b.getAttribute('aria-label') || '') && new RegExp(word, 'i').test(b.getAttribute('aria-label') || ''))
    const inc = btns.find((b) => /increase|add/i.test(b.getAttribute('aria-label') || '') && new RegExp(word, 'i').test(b.getAttribute('aria-label') || ''))
    if (inc) {
      found = true
      for (let k = 0; k < 12 && dec && !dec.disabled; k++) { dec.click(); await sleep(120) }
      for (let k = 0; k < Math.max(0, want - min); k++) { inc.click(); await sleep(150) }
      continue
    }
    // Structural fallback — steppers without aria-labels (current Booking): the
    // row containing the group word with 2-3 buttons; first=−, last=+, row's
    // number is the live count. Only inside an OPEN dialog/popup, else the
    // closed searchbox summary false-matches.
    const dialogRoots = Array.from(
      document.querySelectorAll('[role="dialog"], [data-testid*="popup" i], [class*="popover" i], [class*="dropdown" i]'),
    ).filter((r) => (r as HTMLElement).offsetParent !== null)
    if (dialogRoots.length === 0) continue
    // Row holds word + number, and the count must move the right way after ONE
    // probe click — else abort (never spam). Children's row often grows an
    // age-select control once count>0, so accept ANY number of buttons as long
    // as the FIRST/LAST stay glyph-styled ("-"/"+"), not just exactly two.
    const isGlyphBtn = (b: Element) => ((b.textContent || '').trim().length <= 2)
    let row: Element | null = null
    for (const el of dialogRoots.flatMap((r) => Array.from(r.querySelectorAll('div, li')))) {
      if ((el as HTMLElement).offsetParent === null) continue
      const t = el.textContent || ''
      if (t.length >= 60 || !new RegExp('\\b' + word, 'i').test(t) || !/\d/.test(t)) continue
      const bs = Array.from(el.querySelectorAll('button'))
      if (bs.length >= 2 && isGlyphBtn(bs[0]) && isGlyphBtn(bs[bs.length - 1])) { row = el; break }
    }
    if (row) {
      const bs = row.querySelectorAll('button')
      const rDec = bs[0] as HTMLButtonElement
      const rInc = bs[bs.length - 1] as HTMLButtonElement
      const cur = () => { const m = (row!.textContent || '').match(/\d+/); return m ? parseInt(m[0], 10) : null }
      let c = cur()
      if (c == null) continue
      found = true
      if (c === want) continue
      const target = Math.max(want, min)
      const btn = c < target ? rInc : rDec
      const dir = c < target ? 1 : -1
      btn.click(); await sleep(250)
      let n = cur()
      if (n == null || n !== c + dir) continue // wrong row — abort
      c = n
      let guard = 0
      while (c !== target && guard++ < 12) {
        btn.click(); await sleep(250)
        n = cur()
        if (n == null || n === c) break
        c = n
      }
    }
  }
  document.querySelectorAll('select[aria-label*="age" i], select[name*="age" i]').forEach((s) => {
    const sel = s as HTMLSelectElement
    const opt = Array.from(sel.options).find((o) => o.value === '0') ?? sel.options[1]
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })) }
  })
  await sleep(300)
  return found
}

/**
 * Find an input to type an autocomplete value into when the recorded suggestion
 * isn't on the page yet. Prefers the focused editable element, then falls back to
 * common destination/search input signatures.
 */
// A KNOWN, STABLE field name (Booking's "ss") is checked FIRST and is
// deterministic — relying on document.activeElement first was a race: focus
// can drift to something else between steps, so the SAME automation would
// sometimes type into the right box and sometimes not, purely by timing.
function findSearchInputInPage(): HTMLElement | null {
  const stable = safeQuery('input[name="ss"]') as HTMLElement | null
  if (stable && isVisible(stable)) return stable
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const t = active.tagName.toLowerCase()
    if (t === 'input' || t === 'textarea' || active.isContentEditable || ['combobox', 'searchbox'].includes(active.getAttribute('role') || '')) {
      return active
    }
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
    const el = safeQuery(g) as HTMLElement | null
    if (el && isVisible(el)) return el
  }
  return null
}

/** Fill a city/destination autocomplete in-page and click the MATCHING suggestion. */
async function selectAutocompleteInPage(input: HTMLElement, value: string): Promise<boolean> {
  input.focus()
  await typeInto(input, '')
  // Type char-by-char so the site's suggestion dropdown opens.
  for (const ch of value) {
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      setNativeValue(input, (input.value || '') + ch)
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
    await sleep(70)
  }
  const optSel = '[data-testid="autocomplete-result"], [role="option"], ul[role="listbox"] li, [class*="autocomplete" i] li, [class*="suggestion" i]'
  // Poll for a suggestion that ACTUALLY matches — spacing/punctuation stripped
  // so "KualaLumpur" matches "Kuala Lumpur, Malaysia". Never a random first
  // option (wrong city). Fall back to Enter.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const wanted = normalize(value)
  const collect = () =>
    Array.from(document.querySelectorAll(optSel))
      .filter((o) => (o as HTMLElement).offsetParent !== null)
      .map((o) => {
        const raw = (o as HTMLElement).innerText || o.textContent || ''
        return { el: o, title: normalize(raw.split('\n')[0] || ''), full: normalize(raw) }
      })
      .filter(({ full }) => full && wanted && (full.includes(wanted) || wanted.includes(full.slice(0, Math.max(4, wanted.length)))))
  // Suggestions stream in and reorder — wait for two consecutive identical
  // samples before ranking, then click the fresh element from that sample.
  const deadline = Date.now() + 7000
  let prevSig = ''
  while (Date.now() < deadline) {
    const matches = collect()
    const sig = matches.map((m) => m.title).join('|')
    if (matches.length > 0 && sig === prevSig) {
      const best =
        matches.find((m) => m.title === wanted) ??
        matches.find((m) => m.title.startsWith(wanted) && m.title.length <= wanted.length + 2) ??
        matches.find((m) => m.title.startsWith(wanted)) ??
        [...matches].sort((a, b) => a.title.length - b.title.length)[0]
      ;(best.el as HTMLElement).click()
      await sleep(400)
      return true
    }
    prevSig = sig
    await sleep(400)
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return false
}

/** Execute a single recorded event with an optional override value. */
export async function execEvent(
  e: RecordedEvent,
  override: string | null,
  isPassword: boolean,
  guests: { adults?: number; children?: number; rooms?: number } | null,
  autocomplete = false,
  dateRange?: { checkIn?: string; checkOut?: string } | null,
): Promise<ReplayStepResult> {
  const idx = -1
  const desc = `${e.type}${e.selector.textContent ? ` "${e.selector.textContent.slice(0, 24)}"` : ''}`
  try {
    if (e.type === 'click') {
      // Check-in + check-out sharing ONE recorded calendar click (the
      // recording only ever captured a single date — see ensureCheckoutDate):
      // click BOTH dates in this one calendar visit.
      if (dateRange && dateRange.checkIn) {
        const clickDate = async (iso: string): Promise<boolean> => {
          let cell = await findDateCellInPage(iso)
          if (!cell) {
            await reopenDatePicker()
            cell = await findDateCellInPage(iso)
          }
          if (cell) {
            ;(cell as HTMLElement).scrollIntoView({ block: 'center' })
            robustClickInPage(cell)
            await sleep(400)
            return true
          }
          return false
        }
        const inOk = await clickDate(dateRange.checkIn)
        if (inOk && dateRange.checkOut) await clickDate(dateRange.checkOut)
        return { index: idx, ok: inOk, skipped: !inOk, note: 'date range' }
      }
      // Destination recorded as clicks only: type the NEW value and pick its
      // matching suggestion. Deliberately skip findElement(e) here — its
      // recorded text (a plain city name) can match an unrelated element with
      // the same text elsewhere on a fresh page (e.g. a "trending destination"
      // shortcut tile), and clicking THAT silently keeps the old city instead
      // of substituting. findSearchInputInPage() finds the real search box
      // directly without needing to click a possibly-wrong recorded element.
      if (autocomplete && override) {
        const input = findSearchInputInPage()
        if (input) await selectAutocompleteInPage(input, override)
        await sleep(900)
        return { index: idx, ok: true, skipped: false, note: `autocomplete "${override}"` }
      }
      if (guests) {
        const el = await waitFor(() => findElement(e))
        if (el) {
          ;(el as HTMLElement).click()
          await sleep(600)
          const found = await setGuests(guests)
          if (!found) {
            // Second click may have toggled the panel closed — reopen and retry.
            ;(el as HTMLElement).click()
            await sleep(600)
            await setGuests(guests)
          }
        }
        return { index: idx, ok: true, skipped: !el, note: 'guests' }
      }
      // Boolean filter recorded as a click: "false" means don't apply it — never
      // reached the choice-substitution logic below, where "true"/"false" would
      // be treated as an unmatched place name and typed into the search box
      // (the exact bug that produced "true" in the destination field). "true"
      // just needs the located element clicked normally, like the server does.
      if (override === 'false') return { index: idx, ok: true, skipped: true, note: 'filter off' }
      const isBoolOverride = override === 'true'

      if (!isBoolOverride && override !== null && override !== (e.selector.textContent ?? '').trim()) {
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(override)
        let el: Element | null = null
        if (isDate) {
          el = await findDateCellInPage(override)
          if (!el) {
            await reopenDatePicker()
            el = await findDateCellInPage(override)
          }
          el = el ?? findChoiceByText(override)
        } else {
          el = findChoiceByText(override)
        }
        if (!el) {
          // Not a pre-existing option — treat as a typed autocomplete suggestion
          // (city/destination) and type it into the search box, then pick it.
          // Never for a date: typing an ISO date into a search box is garbage.
          const input = isDate ? null : findSearchInputInPage()
          if (input) {
            await selectAutocompleteInPage(input, override)
            await sleep(900)
            return { index: idx, ok: true, skipped: false, note: `autocomplete "${override}"` }
          }
          if (isDate && new Date(`${override}T00:00:00`) < new Date(new Date().toDateString())) {
            return { index: idx, ok: false, skipped: true, note: `${override} is in the past — can't select it on a live calendar` }
          }
          return { index: idx, ok: false, skipped: true, note: `option "${override}" not found` }
        }
        ;(el as HTMLElement).scrollIntoView({ block: 'center' })
        robustClickInPage(el)
      } else {
        const el = (await waitFor(() => findElement(e))) ?? findByLabelFallback(e)
        if (!el) return { index: idx, ok: false, skipped: true, note: `${desc}: not found` }
        ;(el as HTMLElement).scrollIntoView({ block: 'center' })
        robustClickInPage(el)
      }
      // Clicks that open compose windows / panels animate — give the next
      // field time to mount before the following step looks for it.
      await sleep(900)
      return { index: idx, ok: true, skipped: false, note: desc }
    }

    if (e.type === 'input' || e.type === 'change') {
      const el = await waitFor(() => findElement(e))
      if (!el) return { index: idx, ok: false, skipped: true, note: `${desc}: not found` }
      const value = isPassword ? (override ?? '') : override ?? e.value ?? ''
      if (el instanceof HTMLSelectElement) {
        el.value = value
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = value === 'true'
        if (el.checked !== want) el.click()
      } else if (autocomplete && value) {
        await selectAutocompleteInPage(el as HTMLElement, value)
      } else {
        await typeInto(el, value)
      }
      await sleep(250)
      return { index: idx, ok: true, skipped: false, note: desc }
    }

    if (e.type === 'keydown' && e.key) {
      const el = (await waitFor(() => findElement(e))) ?? (document.activeElement as Element | null)
      if (el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: e.key, bubbles: true }))
        if (e.key === 'Enter' && (el as HTMLElement).closest('form')) {
          ;(el as HTMLElement).closest('form')?.requestSubmit?.()
        }
      }
      await sleep(400)
      return { index: idx, ok: true, skipped: !el, note: `key ${e.key}` }
    }

    if (e.type === 'submit') {
      const el = findElement(e)
      const form = (el as HTMLElement | null)?.closest('form') ?? document.querySelector('form')
      form?.requestSubmit?.()
      await sleep(400)
      return { index: idx, ok: true, skipped: !form, note: 'submit' }
    }

    return { index: idx, ok: true, skipped: true, note: `unhandled ${e.type}` }
  } catch (err) {
    return { index: idx, ok: false, skipped: false, note: err instanceof Error ? err.message.slice(0, 60) : 'error' }
  }
}

/** Scrape the final page — same shape the server returns (title/url/results). */
export function scrapePage(): unknown {
  const abs = (u: string | null) => {
    if (!u) return null
    try {
      return new URL(u, location.href).toString()
    } catch {
      return null
    }
  }
  const clean = (t: string | null | undefined) => (t || '').trim().replace(/\s+/g, ' ')

  // GoZayaan flight cards → airline + time + duration + price.
  const flightCards = Array.from(document.querySelectorAll('.flight-card'))
  if (flightCards.length >= 2) {
    const items: { title: string; href: string | null; thumbnail: string | null; meta: string[] }[] = []
    for (const card of flightCards.slice(0, 40)) {
      const img = card.querySelector('img') as HTMLImageElement | null
      const airline = clean(card.querySelector('.airline-name')?.textContent) || (img?.alt ?? '')
      if (!airline) continue
      const dep = clean(card.querySelector('.start-time .time-text')?.textContent)
      const arr = clean(card.querySelector('.end-time .time-text')?.textContent)
      const stops = clean(card.querySelector('.stop-text')?.textContent)
      const priceEl = card.querySelector('.price-and-currency') || card.querySelector('.price-text')
      let price = clean(priceEl?.textContent)
      if (price && !/[A-Za-z]/.test(price)) price = 'BDT ' + price
      let thumb = img ? abs(img.currentSrc || img.src) : null
      if (thumb && thumb.startsWith('data:')) thumb = null
      const route = [dep, arr].filter(Boolean).join(' → ')
      const meta = [route, stops, price].filter((t) => t && t.length > 0).slice(0, 4)
      items.push({ title: airline.slice(0, 120), href: location.href, thumbnail: thumb, meta })
    }
    if (items.length >= 2) return { title: document.title, url: location.href, results: items }
  }

  // Booking.com flights (booking.kayak.com) → airline + time + stops + price.
  // Kayak's class names are obfuscated, so read by text pattern (robust).
  const kayakCards = Array.from(document.querySelectorAll('.nrc6'))
  if (kayakCards.length >= 2) {
    const items: { title: string; href: string | null; thumbnail: string | null; meta: string[] }[] = []
    const seen = new Set<string>()
    for (const card of kayakCards.slice(0, 40)) {
      const t = clean(card.textContent)
      const img = card.querySelector('img') as HTMLImageElement | null
      const airline = img?.alt || 'Flight'
      const times = t.match(/\d{1,2}:\d{2}\s*[ap]m\s*[–-]\s*\d{1,2}:\d{2}\s*[ap]m/gi) || []
      const dur = (t.match(/\d+h\s*\d+m/gi) || [])
        .map((d) => { const m = d.match(/(\d+)h\s*(\d+)m/i)!; return { d, min: +m[1] * 60 + +m[2] } })
        .sort((a, b) => b.min - a.min)[0]?.d
      const stops = (t.match(/nonstop|\d+\s*stops?/i) || [])[0]
      const price = (t.match(/(?:Tk|BDT|৳|\$|€|£)\s?[\d,]+/) || [])[0]
      const key = `${airline}|${times[0] ?? ''}|${price ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const meta = [times[0], dur, stops, price].filter((x): x is string => !!x && x.length > 0).slice(0, 4)
      items.push({ title: airline.slice(0, 120), href: location.href, thumbnail: null, meta })
      if (items.length >= 40) break
    }
    if (items.length >= 2) return { title: document.title, url: location.href, results: items }
  }

  // Booking property cards → clean hotel name + price + score.
  const propCards = Array.from(document.querySelectorAll('[data-testid="property-card"]'))
  if (propCards.length >= 3) {
    const items: { title: string; href: string | null; thumbnail: string | null; meta: string[] }[] = []
    for (const card of propCards.slice(0, 40)) {
      const title = (card.querySelector('[data-testid="title"]')?.textContent || '').trim().replace(/\s+/g, ' ')
      const linkEl = card.querySelector('a[href]')
      const href = linkEl ? abs(linkEl.getAttribute('href')) : null
      const img = card.querySelector('img') as HTMLImageElement | null
      let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null
      if (thumb && thumb.startsWith('data:')) thumb = null
      const meta = [
        card.querySelector('[data-testid="price-and-discounted-price"]')?.textContent,
        card.querySelector('[data-testid="review-score"]')?.textContent,
        card.querySelector('[data-testid="distance"]')?.textContent,
      ]
        .map((t) => (t || '').trim().replace(/\s+/g, ' '))
        .filter((t) => t.length > 0)
        .slice(0, 4)
      if (title) items.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta })
    }
    if (items.length >= 3) return { title: document.title, url: location.href, results: items }
  }

  // Structured content items (articles / posts / cards) — deterministic, DOM
  // order. Handles WordPress (FitGirl), news, shops consistently every run.
  let blocks: Element[] = Array.from(document.querySelectorAll('article'))
  if (blocks.length < 3) {
    blocks = Array.from(document.querySelectorAll('[class*="post"],[class*="card"],[class*="result"],[class*="listing"]')).filter(
      (el) => el.querySelector('a[href]') && (el.querySelector('h1,h2,h3,h4') || el.querySelector('[class*="title"]')),
    )
  }
  if (blocks.length >= 3) {
    const items: { title: string; href: string | null; thumbnail: string | null; meta: string[] }[] = []
    const seen = new Set<string>()
    for (const b of blocks.slice(0, 80)) {
      const titleLink =
        b.querySelector('h1 a[href], h2 a[href], h3 a[href], h4 a[href], [class*="title"] a[href], a[class*="title"][href]') ||
        b.querySelector('a[href]')
      if (!titleLink) continue
      const href = abs(titleLink.getAttribute('href'))
      const heading = b.querySelector('h1, h2, h3, h4')
      const title = clean(titleLink.textContent) || clean(heading?.textContent)
      if (!href || !title || title.length < 2 || seen.has(href)) continue
      seen.add(href)
      const img = b.querySelector('img') as HTMLImageElement | null
      let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null
      if (thumb && thumb.startsWith('data:')) thumb = null
      const p = b.querySelector('p')
      const excerpt = clean(p?.textContent).slice(0, 130)
      const meta = excerpt && excerpt !== title && !title.includes(excerpt) ? [excerpt] : []
      items.push({ title: title.slice(0, 160), href, thumbnail: thumb, meta })
      if (items.length >= 40) break
    }
    if (items.length >= 3) return { title: document.title, url: location.href, results: items }
  }

  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
    const t = (a.textContent || '').trim()
    return t.length > 8 && a.getBoundingClientRect().width > 0
  })
  const sig = (el: Element) => {
    const parts: string[] = []
    let n: Element | null = el
    for (let i = 0; i < 4 && n; i++) { parts.push(n.tagName); n = n.parentElement }
    return parts.join('>')
  }
  const groups = new Map<string, Element[]>()
  for (const a of anchors) {
    const k = sig(a)
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(a)
  }
  let best: Element[] = []
  let bestScore = 0
  for (const els of groups.values()) {
    if (els.length < 3) continue
    const avg = els.reduce((s, e) => s + Math.min((e.textContent || '').trim().length, 120), 0) / els.length
    if (els.length * avg > bestScore) { bestScore = els.length * avg; best = els }
  }
  const results: { title: string; href: string | null; thumbnail: string | null; meta: string[] }[] = []
  const seen = new Set<string>()
  for (const a of best.slice(0, 40)) {
    const href = abs(a.getAttribute('href'))
    if (!href || seen.has(href)) continue
    seen.add(href)
    const container = a.closest('li, article, div') ?? a
    const img = container.querySelector('img') as HTMLImageElement | null
    let thumb = img ? abs(img.currentSrc || img.src || img.getAttribute('data-src')) : null
    if (thumb && thumb.startsWith('data:')) thumb = null
    results.push({ title: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160), href, thumbnail: thumb, meta: [] })
    if (results.length >= 30) break
  }
  return { title: document.title, url: location.href, results }
}

// Listen for exec/scrape requests from the background during a browser replay.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.kind === 'replay/execEvent') {
    execEvent(msg.event, msg.override, msg.isPassword, msg.guests, msg.autocomplete ?? false, msg.dateRange).then((result) => {
      sendResponse({ kind: 'replay/execResult', result } satisfies RuntimeMessage)
    })
    return true
  }
  if (msg.kind === 'replay/scrape') {
    // Capture the rendered page HTML too, so the mimic site can show a page-view
    // snapshot (the real results page) — not just the extracted list.
    let html: string | undefined
    try {
      html = document.documentElement.outerHTML
      if (html.length > 4_000_000) html = undefined // too big to ship
    } catch {
      html = undefined
    }
    sendResponse({ kind: 'replay/scraped', output: scrapePage(), html } satisfies RuntimeMessage)
  }
})
