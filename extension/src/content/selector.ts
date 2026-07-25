import type { SelectorFingerprint } from '../shared/types'

function cssPath(el: Element): string | null {
  if (!(el instanceof Element)) return null
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
    let selector = node.tagName.toLowerCase()
    if (node.id) {
      selector += `#${node.id}`
      parts.unshift(selector)
      break
    }
    const parent = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (siblings.length > 1) {
        const index = siblings.indexOf(node) + 1
        selector += `:nth-of-type(${index})`
      }
    }
    parts.unshift(selector)
    node = node.parentElement
  }
  return parts.join(' > ')
}

function xpath(el: Element): string | null {
  if (!(el instanceof Element)) return null
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    let index = 1
    let sibling = node.previousElementSibling
    while (sibling) {
      if (sibling.tagName === node.tagName) index++
      sibling = sibling.previousElementSibling
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`)
    node = node.parentElement
  }
  return '/' + parts.join('/')
}

/**
 * Rendered text of an element, WITH the whitespace its layout implies. Raw
 * `.textContent` blindly concatenates every descendant text node with no regard
 * for CSS — sibling spans like "Dhaka" + "Bangladesh" (city + country, laid out
 * as separate inline-block/flex children) collapse into "DhakaBangladesh" with
 * no space, which silently corrupts every value read from that element downstream
 * (destination search, autocomplete matching, choice labels). `.innerText`
 * respects rendering and inserts real whitespace/line-breaks at layout
 * boundaries — normalize those to single spaces for a clean value.
 */
function visibleText(el: Element): string {
  const raw = el instanceof HTMLElement && el.isConnected ? el.innerText : el.textContent
  return (raw || '').replace(/\s+/g, ' ').trim()
}

function findLabelText(el: Element): string | null {
  const id = el.getAttribute('id')
  if (id) {
    const labelFor = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    if (labelFor) {
      const t = visibleText(labelFor)
      if (t) return t.slice(0, 100)
    }
  }
  const closestLabel = el.closest('label')
  if (closestLabel) {
    const t = visibleText(closestLabel)
    if (t) return t.slice(0, 100)
  }
  const prev = el.previousElementSibling
  if (prev && /label|span|div/i.test(prev.tagName)) {
    const t = visibleText(prev)
    if (t) return t.slice(0, 100)
  }
  return null
}

/** Path of frame identifiers from top document down to the frame containing el, empty if top-level */
function framePath(): string[] {
  const path: string[] = []
  try {
    let win: Window = window
    while (win !== win.parent) {
      const frameElement = win.frameElement as HTMLIFrameElement | null
      path.unshift(frameElement?.id || frameElement?.name || frameElement?.src || 'iframe')
      win = win.parent
    }
  } catch {
    path.unshift('cross-origin-frame')
  }
  return path
}

/** Path of shadow-root hosts from document down to el's containing root, empty if not inside shadow DOM */
function shadowPath(el: Element): string[] {
  const path: string[] = []
  let root = el.getRootNode()
  while (root instanceof ShadowRoot) {
    const host = root.host
    path.unshift(cssPath(host) || host.tagName.toLowerCase())
    root = host.getRootNode()
  }
  return path
}

export function buildSelectorFingerprint(el: Element): SelectorFingerprint {
  return {
    css: cssPath(el),
    xpath: xpath(el),
    id: el.getAttribute('id'),
    ariaLabel: el.getAttribute('aria-label'),
    textContent: visibleText(el) ? visibleText(el).slice(0, 100) : null,
    labelText: findLabelText(el),
    role: el.getAttribute('role') || el.tagName.toLowerCase(),
    dataTestid:
      el.getAttribute('data-testid') ||
      el.getAttribute('data-test-id') ||
      el.getAttribute('data-test') ||
      el.getAttribute('data-qa') ||
      null,
    name: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'),
    framePath: framePath(),
    shadowPath: shadowPath(el),
  }
}

/** Resolve the real target element, piercing shadow DOM via composedPath */
export function resolveDeepTarget(e: Event): Element | null {
  const path = e.composedPath()
  for (const node of path) {
    if (node instanceof Element) return node
  }
  return e.target instanceof Element ? e.target : null
}
