import type { RecordedEvent, RecordedEventType, RuntimeMessage } from '../shared/types'
import { buildSelectorFingerprint, resolveDeepTarget } from './selector'
import { showHud, hideHud, isHudPath } from './hud'
import './executor' // registers the browser-replay executor listener on this page
import './bridge' // relays run-in-browser requests between the mimic site and the extension

// Takeover protocol: each copy of this script announces itself; older copies
// (including orphaned ones left behind by an extension reload) deactivate.
const INSTANCE_TOKEN = `${Date.now()}-${Math.random()}`
let active = true
document.addEventListener('__mimic_takeover', (e) => {
  if ((e as CustomEvent).detail !== INSTANCE_TOKEN) {
    active = false
    hideHud()
  }
})
document.dispatchEvent(new CustomEvent('__mimic_takeover', { detail: INSTANCE_TOKEN }))

let recording = false

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function inputValueOf(el: Element): { value: string | null; inputType: string | null } {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return { value: null, inputType: el.type }
    if (el.type === 'checkbox' || el.type === 'radio') {
      return { value: String(el.checked), inputType: el.type }
    }
    return { value: el.value, inputType: el.type }
  }
  if (el instanceof HTMLTextAreaElement) return { value: el.value, inputType: 'textarea' }
  if (el instanceof HTMLSelectElement) return { value: el.value, inputType: 'select' }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return { value: el.textContent, inputType: 'contenteditable' }
  }
  return { value: null, inputType: null }
}

function emit(type: RecordedEventType, el: Element | null, key: string | null = null) {
  if (!recording || !active) return
  const { value, inputType } = el ? inputValueOf(el) : { value: null, inputType: null }
  const event: RecordedEvent = {
    id: makeId(),
    type,
    timestamp: Date.now(),
    tabId: -1,
    frameId: -1,
    domain: location.hostname,
    url: location.href,
    selector: el ? buildSelectorFingerprint(el) : {
      css: null, xpath: null, id: null, ariaLabel: null,
      textContent: null, labelText: null, role: null,
      dataTestid: null, name: null, placeholder: null, framePath: [], shadowPath: [],
    },
    value,
    inputType,
    key,
  }
  chrome.runtime.sendMessage({ kind: 'recorder/event', event } satisfies RuntimeMessage).catch(() => {})
}

function onClick(e: MouseEvent) {
  if (isHudPath(e.composedPath())) return
  emit('click', resolveDeepTarget(e))
}

function onInput(e: Event) {
  if (isHudPath(e.composedPath())) return
  emit('input', resolveDeepTarget(e))
}

function onChange(e: Event) {
  if (isHudPath(e.composedPath())) return
  emit('change', resolveDeepTarget(e))
}

function onKeydown(e: KeyboardEvent) {
  if (isHudPath(e.composedPath())) return
  const notable = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']
  if (notable.includes(e.key)) {
    emit('keydown', resolveDeepTarget(e), e.key)
  }
}

function onSubmit(e: Event) {
  if (isHudPath(e.composedPath())) return
  emit('submit', resolveDeepTarget(e))
}

function attachListeners(root: Document | ShadowRoot = document) {
  root.addEventListener('click', onClick as EventListener, { capture: true })
  root.addEventListener('input', onInput, { capture: true })
  root.addEventListener('change', onChange, { capture: true })
  root.addEventListener('keydown', onKeydown as EventListener, { capture: true })
  root.addEventListener('submit', onSubmit, { capture: true })
}

/** Watch for new shadow roots being attached so deep custom-element widgets stay covered */
function observeShadowRoots() {
  const seen = new WeakSet<Node>()
  const scan = (node: ParentNode) => {
    node.querySelectorAll('*').forEach((el) => {
      const sr = (el as HTMLElement).shadowRoot
      if (sr && !seen.has(sr)) {
        seen.add(sr)
        attachListeners(sr)
        scan(sr)
      }
    })
  }
  scan(document)
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n instanceof Element) scan(n)
      })
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
}

attachListeners(document)
observeShadowRoots()

let lastUrl = location.href
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href
    if (recording) emit('navigation', document.documentElement)
  }
}).observe(document.documentElement, { childList: true, subtree: true })

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (!active) return
  if (msg.kind === 'recorder/ping') {
    sendResponse({ kind: 'recorder/pong' })
    return
  }
  if (msg.kind === 'recorder/start') {
    recording = true
    showHud()
  }
  if (msg.kind === 'recorder/stop') {
    recording = false
    hideHud()
  }
})

chrome.runtime.sendMessage({ kind: 'recorder/getState' } satisfies RuntimeMessage).then((res) => {
  if (res && (res as RuntimeMessage).kind === 'recorder/state') {
    recording = (res as Extract<RuntimeMessage, { kind: 'recorder/state' }>).recording
    if (recording) showHud()
  }
}).catch(() => {})
