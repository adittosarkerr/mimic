import type { RuntimeMessage } from '../shared/types'

/**
 * Bridge between the mimic web app (localhost:5174) and the extension. The page
 * can't message the extension directly, so this content-script relays:
 *   page  --window.postMessage-->  bridge  --chrome.runtime-->  background
 *   background --chrome.runtime--> bridge --window.postMessage--> page
 * Only runs on the mimic origin.
 */
const MIMIC_ORIGIN = 'http://localhost:5174'

if (location.origin === MIMIC_ORIGIN) {
  // Announce the extension is present so the page can enable "run in my browser".
  window.postMessage({ __mimic: true, kind: 'extension/present' }, MIMIC_ORIGIN)

  window.addEventListener('message', (ev) => {
    if (ev.origin !== MIMIC_ORIGIN) return
    const data = ev.data
    if (!data || data.__mimic !== true) return
    if (data.kind === 'run-in-browser' && typeof data.automationId === 'string') {
      chrome.runtime.sendMessage({
        kind: 'replay/run',
        automationId: data.automationId,
        values: data.values ?? {},
        credentials: data.credentials,
      } satisfies RuntimeMessage).catch(() => {})
    }
    if (data.kind === 'extension/ping') {
      window.postMessage({ __mimic: true, kind: 'extension/present' }, MIMIC_ORIGIN)
    }
  })

  // Relay replay status from the background back into the page.
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
    if (msg.kind === 'replay/status') {
      window.postMessage({ __mimic: true, kind: 'replay-status', status: msg.status, message: msg.message, url: msg.url }, MIMIC_ORIGIN)
    }
  })
}
