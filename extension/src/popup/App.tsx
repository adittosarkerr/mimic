import { useEffect, useState } from 'react'
import type { RuntimeMessage } from '../shared/types'
import './App.css'

function App() {
  const [recording, setRecording] = useState(false)
  const [eventCount, setEventCount] = useState(0)
  const [uploadState, setUploadState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  useEffect(() => {
    const poll = () =>
      chrome.runtime
        .sendMessage({ kind: 'recorder/getState' } satisfies RuntimeMessage)
        .then((res: RuntimeMessage) => {
          if (res?.kind === 'recorder/state') {
            setRecording(res.recording)
            setEventCount(res.eventCount)
          }
        })
        .catch(() => {})
    poll()
    const interval = setInterval(poll, 1000)
    return () => clearInterval(interval)
  }, [])

  async function uploadSession() {
    setUploadState('sending')
    try {
      const res = (await chrome.runtime.sendMessage({ kind: 'recorder/getSession' } satisfies RuntimeMessage)) as RuntimeMessage
      if (res?.kind !== 'recorder/session' || !res.session) throw new Error('no session')
      const resp = await fetch('http://localhost:4545/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(res.session),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) throw new Error(`backend ${resp.status}`)
      setUploadState('sent')
      await chrome.runtime.sendMessage({ kind: 'recorder/clearSession' } satisfies RuntimeMessage)
      setEventCount(0)
      // Reuse one mimic tab instead of spawning a new one every time.
      const url = `http://localhost:5174/dashboard?new=${res.session.id}`
      const existing = await chrome.tabs.query({ url: 'http://localhost:5174/*' })
      if (existing.length > 0 && existing[0].id != null) {
        await chrome.tabs.update(existing[0].id, { url, active: true })
        if (existing[0].windowId != null) chrome.windows.update(existing[0].windowId, { focused: true })
      } else {
        chrome.tabs.create({ url })
      }
      setTimeout(() => setUploadState('idle'), 2500)
    } catch {
      setUploadState('error')
      setTimeout(() => setUploadState('idle'), 4000)
    }
  }

  async function toggleRecording() {
    const kind = recording ? 'recorder/stop' : 'recorder/start'
    setUploadState('idle')
    const res = (await chrome.runtime.sendMessage({ kind } satisfies RuntimeMessage)) as RuntimeMessage
    if (res?.kind === 'recorder/state') {
      setRecording(res.recording)
      setEventCount(res.eventCount)
    }
  }

  async function discard() {
    await chrome.runtime.sendMessage({ kind: 'recorder/clearSession' } satisfies RuntimeMessage)
    setEventCount(0)
    setUploadState('idle')
  }

  const hasRecording = eventCount > 0 && !recording
  const version = chrome.runtime.getManifest().version

  return (
    <div className="popup">
      <div className="grain" aria-hidden="true" />

      <header className="hdr">
        <div className="brand">
          <span className="logo-dot" />
          <span className="wordmark">mimic</span>
        </div>
        <span className="ver">v{version}</span>
      </header>

      <div className="stage">
        <button
          type="button"
          className={`rec ${recording ? 'on' : ''}`}
          onClick={toggleRecording}
          aria-pressed={recording}
          aria-label={recording ? 'stop recording' : 'start recording'}
        >
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="ring r3" />
          <span className="core">{recording ? <span className="stopsq" /> : <span className="recdot" />}</span>
        </button>

        <div className="readout">
          <span className={`state ${recording ? 'live' : ''}`}>
            {recording ? 'recording' : hasRecording ? 'ready to build' : 'idle'}
          </span>
          <span className="steps">
            <b>{eventCount}</b> {eventCount === 1 ? 'step' : 'steps'}
          </span>
        </div>
      </div>

      <div className="hint">
        {recording
          ? 'do your task on any site — click stop when done'
          : hasRecording
            ? 'turn this recording into an automation'
            : 'press record, then do a task on any website'}
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn primary"
          disabled={!hasRecording || uploadState === 'sending'}
          onClick={uploadSession}
        >
          {uploadState === 'idle' && 'review & build →'}
          {uploadState === 'sending' && 'sending…'}
          {uploadState === 'sent' && 'opened in mimic ✓'}
          {uploadState === 'error' && 'failed — backend off?'}
        </button>
        {hasRecording && (
          <button type="button" className="btn subtle" onClick={discard}>
            discard
          </button>
        )}
      </div>
    </div>
  )
}

export default App
