import type { RuntimeMessage } from '../shared/types'

let hudHost: HTMLElement | null = null
let countEl: HTMLElement | null = null
let pollTimer: number | null = null

export function isHudElement(node: EventTarget | null): boolean {
  return node instanceof Node && hudHost !== null && hudHost.contains(node)
}

export function isHudPath(path: EventTarget[]): boolean {
  return hudHost !== null && path.includes(hudHost)
}

export function showHud() {
  if (window !== window.top) return
  if (hudHost) return

  hudHost = document.createElement('div')
  hudHost.id = 'mimic-recorder-hud'
  hudHost.style.cssText = 'all: initial; position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;'
  const shadow = hudHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `
    .pill {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(245, 239, 230, 0.75);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1.5px solid rgba(43, 36, 32, 0.25);
      box-shadow: 0 4px 18px rgba(43, 36, 32, 0.25);
      font-family: system-ui, sans-serif;
      color: #2b2420;
      user-select: none;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #b84a1d;
      animation: mimic-pulse 1.1s ease-in-out infinite;
    }
    @keyframes mimic-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
    .label { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
    .count { font-size: 12px; opacity: 0.65; min-width: 52px; }
    .stop {
      border: 2px solid #2b2420;
      background: #d8672a;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      padding: 5px 12px;
      border-radius: 999px;
      cursor: pointer;
      box-shadow: 2px 2px 0 #2b2420;
    }
    .stop:active { transform: translate(1px, 1px); box-shadow: 1px 1px 0 #2b2420; }
  `
  shadow.appendChild(style)

  const pill = document.createElement('div')
  pill.className = 'pill'

  const dot = document.createElement('div')
  dot.className = 'dot'

  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = 'mimic'

  countEl = document.createElement('span')
  countEl.className = 'count'
  countEl.textContent = '0 steps'

  const stopBtn = document.createElement('button')
  stopBtn.className = 'stop'
  stopBtn.textContent = 'Stop'
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    chrome.runtime.sendMessage({ kind: 'recorder/stop' } satisfies RuntimeMessage).catch(() => {})
  })

  pill.append(dot, label, countEl, stopBtn)
  shadow.appendChild(pill)

  const mount = () => {
    if (document.body && hudHost) document.body.appendChild(hudHost)
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })

  pollTimer = window.setInterval(() => {
    // Some sites aggressively prune foreign DOM nodes — re-attach if removed
    if (hudHost && document.body && !document.body.contains(hudHost)) {
      document.body.appendChild(hudHost)
    }
    chrome.runtime.sendMessage({ kind: 'recorder/getState' } satisfies RuntimeMessage).then((res) => {
      const state = res as RuntimeMessage | undefined
      if (state?.kind === 'recorder/state' && countEl) {
        countEl.textContent = `${state.eventCount} step${state.eventCount === 1 ? '' : 's'}`
        if (!state.recording) hideHud()
      }
    }).catch(() => {})
  }, 800)
}

export function hideHud() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  hudHost?.remove()
  hudHost = null
  countEl = null
}
