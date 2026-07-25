import { chromium, type Frame, type Page } from 'playwright'
import type { RecordingSession, VariableField } from '../types.js'

/** Marker text for common CAPTCHA / anti-bot interstitials */
const BOT_MARKERS = [
  '#baxia-dialog-content', '.baxia-dialog', 'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '#px-captcha',
  '#challenge-running', '#cf-challenge-running',
]

/**
 * Open the recorded starting page and read the REAL form structure so the
 * generated form reflects what the site actually offers — not just what the
 * recording captured. For each variable we try to locate its element live and
 * pull genuine <select>/listbox options, numeric bounds, and placeholder hints.
 *
 * Purely additive and best-effort: if the site blocks us (CAPTCHA, network),
 * we return the variables untouched plus a note. Never throws.
 */
export async function introspectForm(
  session: RecordingSession,
  variables: VariableField[],
): Promise<{ variables: VariableField[]; reached: boolean; note: string | null }> {
  if (variables.length === 0 || session.events.length === 0) {
    return { variables, reached: false, note: null }
  }

  const startUrl = session.events[0].url
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    })
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    })
    await context.addInitScript(`Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`)
    const page = await context.newPage()
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 12000 })
    await page.waitForTimeout(1000)

    const blocked = await page.evaluate(
      `(() => { const s=${JSON.stringify(BOT_MARKERS)}; for(const q of s){if(document.querySelector(q))return true;} return /are you (a )?human|verify you are|not a robot/i.test(document.body.innerText||''); })()`,
    )
    if (blocked) {
      return {
        variables,
        reached: false,
        note: 'The site showed a CAPTCHA on load, so live options could not be read. Fields fall back to free text.',
      }
    }

    const enriched: VariableField[] = []
    for (const v of variables) {
      enriched.push(await enrichVariable(page, session, v))
    }
    return { variables: enriched, reached: true, note: null }
  } catch {
    return {
      variables,
      reached: false,
      note: 'This site blocks automated access, so live dropdown options could not be read. Fields use your recorded values — an assisted run will still let you pick real options in the browser.',
    }
  } finally {
    await browser?.close().catch(() => {})
  }
}

function frameFor(page: Page, framePath: string[]): Frame {
  let frame: Frame = page.mainFrame()
  for (const hint of framePath) {
    const child = frame.childFrames().find((f) => f.url().includes(hint) || f.name() === hint)
    if (child) frame = child
  }
  return frame
}

async function enrichVariable(page: Page, session: RecordingSession, v: VariableField): Promise<VariableField> {
  const e = session.events[v.eventIndex]
  if (!e) return v
  const frame = frameFor(page, e.selector.framePath)

  // Build a small set of candidate selectors to find this field live
  const s = e.selector
  const queries: string[] = []
  if (s.dataTestid) queries.push(`[data-testid="${s.dataTestid}"]`)
  if (s.id) queries.push(`#${cssEscape(s.id)}`)
  if (s.name) queries.push(`[name="${s.name}"]`)
  if (s.ariaLabel) queries.push(`[aria-label="${cssEscape(s.ariaLabel)}"]`)
  if (s.placeholder) queries.push(`[placeholder="${cssEscape(s.placeholder)}"]`)
  if (s.css) queries.push(s.css)

  for (const q of queries) {
    try {
      const info = (await frame.evaluate(`(${readFieldInfo})(${JSON.stringify(q)})`)) as FieldInfo | null
      if (!info) continue

      const out: VariableField = { ...v }
      if (info.options && info.options.length > 1) {
        out.options = info.options.slice(0, 60)
        out.type = 'select'
      }
      if (info.min != null || info.max != null) {
        out.type = out.type === 'select' ? out.type : 'number'
        out.hint = `allowed range ${info.min ?? '?'}–${info.max ?? '?'}`
      }
      if (!out.hint && info.placeholder) out.hint = `e.g. ${info.placeholder}`
      return out
    } catch {
      continue
    }
  }
  return v
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1')
}

interface FieldInfo {
  options: { value: string; label: string }[] | null
  min: string | null
  max: string | null
  placeholder: string | null
}

/**
 * Runs inside the page. Given a selector, returns real option list / numeric
 * bounds / placeholder for that control, resolving native selects, ARIA
 * listboxes/comboboxes, and radio groups.
 */
const readFieldInfo = `(q) => {
  const el = document.querySelector(q);
  if (!el) return null;
  const out = { options: null, min: null, max: null, placeholder: null };

  if (el.tagName === 'SELECT') {
    out.options = Array.from(el.options)
      .filter(o => o.value !== '' && !/^-?1$/.test(o.value) || o.textContent.trim())
      .map(o => ({ value: o.value, label: (o.textContent || o.value).trim().slice(0, 60) }))
      .filter(o => o.label && !/^age needed|^select|^choose/i.test(o.label));
    return out;
  }

  if (el.tagName === 'INPUT') {
    if (el.min !== '') out.min = el.min;
    if (el.max !== '') out.max = el.max;
    if (el.placeholder) out.placeholder = el.placeholder;
    if (el.list) {
      out.options = Array.from(el.list.options).map(o => ({ value: o.value, label: (o.label || o.value).trim() }));
    }
  }

  if (el.placeholder && !out.placeholder) out.placeholder = el.placeholder;

  // ARIA combobox/listbox — find the popup it controls
  const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (owns) {
    const list = document.getElementById(owns);
    if (list) {
      const opts = Array.from(list.querySelectorAll('[role="option"], li, option'));
      if (opts.length > 1) {
        out.options = opts.map(o => ({ value: (o.textContent||'').trim(), label: (o.textContent||'').trim().slice(0,60) }))
          .filter(o => o.label);
      }
    }
  }

  return out;
}`
