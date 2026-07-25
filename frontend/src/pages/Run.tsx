import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, auth, emailApi, saasApi, snapshotUrl, API_BASE, type AutomationSchema, type PublicUser, type ResultItem, type RunResult, type SmtpPreset } from '../api'

const inputTypeFor = (t: string) =>
  t === 'date' ? 'date' : t === 'number' ? 'number' : t === 'email' ? 'email' : 'text'

/**
 * Compact themed spinner. `progress` null = indeterminate (spins with a fixed
 * arc); a 0–1 value = determinate ring that fills as steps complete. Kept small
 * and inline so it reads as a status line, not a giant dial.
 */
function CircularLoader({ progress, label, sub }: { progress: number | null; label: string; sub?: string }) {
  const size = 22
  const stroke = 3
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const frac = progress == null ? 0.3 : Math.max(0.03, Math.min(1, progress))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
      <style>{`@keyframes mimicSpin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: size, height: size, flexShrink: 0, animation: progress == null ? 'mimicSpin .85s linear infinite' : undefined }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--beige-deep)" strokeWidth={stroke} opacity={0.6} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--orange)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circ * frac} ${circ}`}
            style={{ transition: 'stroke-dasharray .4s ease' }}
          />
        </svg>
      </div>
      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{label}</span>
      {progress != null && (
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--orange-dark)', fontWeight: 700 }}>{Math.round(frac * 100)}%</span>
      )}
      {sub && (
        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
          {sub}
        </span>
      )}
    </div>
  )
}

const clamp2: CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
}

function ResultCard({ item: raw }: { item: ResultItem }) {
  // Runs saved by older versions stored { text } instead of { title, meta, thumbnail }
  const legacy = raw as ResultItem & { text?: string }
  const item: ResultItem = {
    title: legacy.title ?? legacy.text ?? '',
    href: legacy.href ?? null,
    thumbnail: legacy.thumbnail ?? null,
    meta: Array.isArray(legacy.meta) ? legacy.meta : [],
  }
  const inner = (
    // Fixed row layout with a uniform min-height so every card reads the same
    // whether or not the site gave us a thumbnail — no squashing, no jitter.
    <div
      className="glass"
      style={{
        padding: 14, display: 'flex', gap: 14, alignItems: 'stretch', minHeight: 72,
        transition: 'transform .12s ease', textDecoration: 'none',
      }}
    >
      {item.thumbnail && (
        <img
          src={item.thumbnail}
          alt=""
          loading="lazy"
          style={{ width: 104, height: 72, objectFit: 'cover', borderRadius: 10, border: '2px solid var(--ink)', flexShrink: 0, background: 'var(--beige-deep)' }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5 }}>
        <div style={{ color: 'var(--ink)', fontSize: 15, fontWeight: 700, lineHeight: 1.35, wordBreak: 'break-word', ...clamp2 }}>
          {item.title || 'untitled'}
        </div>
        {item.meta.length > 0 && (
          <div style={{ color: 'var(--ink-soft)', fontSize: 12.5, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', lineHeight: 1.4 }}>
            {item.meta.map((m, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
                {i > 0 && <span style={{ opacity: 0.4 }}>·</span>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>{m}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {item.href && <span style={{ color: 'var(--orange)', fontWeight: 700, alignSelf: 'center', flexShrink: 0 }}>↗</span>}
    </div>
  )
  return item.href ? (
    <a href={item.href} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
      {inner}
    </a>
  ) : (
    inner
  )
}

function RunOutput({ run }: { run: RunResult }) {
  // Default to the clean structured list — the full-page snapshot is a cluttered
  // copy of the whole site and is offered only as a secondary "full page" toggle.
  const [view, setView] = useState<'page' | 'list'>('list')
  if (!run.output) return null
  const resultCount = run.output.results?.length ?? 0
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ fontSize: 22, marginBottom: 6 }}>
            {run.output.title || 'results'}
            {resultCount > 0 && (
              <span className="pill-tag" style={{ marginLeft: 10, fontSize: 11, verticalAlign: 'middle' }}>
                {resultCount} result{resultCount === 1 ? '' : 's'}
              </span>
            )}
          </h2>
          {run.output.url && (
            <a
              href={run.output.url}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{ fontSize: 13, wordBreak: 'break-all', display: 'inline-block', maxWidth: '100%' }}
            >
              {run.output.url}
            </a>
          )}
        </div>
        {run.hasSnapshot && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={view === 'list' ? 'btn' : 'btn btn-ghost'} style={{ padding: '7px 16px', fontSize: 13 }} onClick={() => setView('list')}>
              list
            </button>
            <button className={view === 'page' ? 'btn' : 'btn btn-ghost'} style={{ padding: '7px 16px', fontSize: 13 }} onClick={() => setView('page')}>
              full page
            </button>
          </div>
        )}
      </div>

      {view === 'page' && run.hasSnapshot ? (
        <div className="brutal" style={{ marginTop: 16, padding: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 10px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--orange)', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--orange-soft)', display: 'inline-block' }} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--beige-deep)', display: 'inline-block', border: '1.5px solid var(--ink)' }} />
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-soft)', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {run.output.url}
            </span>
          </div>
          <iframe
            src={snapshotUrl(run.runId)}
            title="page snapshot"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            style={{ width: '100%', height: 600, border: 'none', borderRadius: 8, background: '#fff' }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
          {(run.output.results ?? []).map((item, i) => (
            <ResultCard key={i} item={item} />
          ))}
          {(run.output.results ?? []).length === 0 && (
            <p style={{ color: 'var(--ink-soft)' }}>no structured results extracted from the final page.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default function Run() {
  const { id } = useParams<{ id: string }>()
  const [schema, setSchema] = useState<AutomationSchema | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [wantOutput, setWantOutput] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [history, setHistory] = useState<RunResult[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginUser, setLoginUser] = useState('')
  const [loginPass, setLoginPass] = useState('')
  const [rememberCreds, setRememberCreds] = useState(false)
  const [hasSavedCreds, setHasSavedCreds] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectNote, setConnectNote] = useState<string | null>(null)
  const [extPresent, setExtPresent] = useState(false)
  const [browserStatus, setBrowserStatus] = useState<string | null>(null)
  const [browserRunning, setBrowserRunning] = useState(false)
  // Email connector state
  const [emailConfigured, setEmailConfigured] = useState(false)
  const [emailPresets, setEmailPresets] = useState<SmtpPreset[]>([])
  const [emProvider, setEmProvider] = useState('gmail')
  const [emAddress, setEmAddress] = useState('')
  const [emAppPass, setEmAppPass] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  // REST API docs (revealed only to signed-in accounts)
  const [me, setMe] = useState<PublicUser | null>(null)
  const [apiCopied, setApiCopied] = useState(false)

  useEffect(() => {
    if (auth.token()) saasApi.me().then((r) => setMe(r.user)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!schema?.email) return
    emailApi.presets().then(setEmailPresets).catch(() => {})
    emailApi.config().then((c) => { setEmailConfigured(c.configured); if (c.email) setEmAddress(c.email) }).catch(() => {})
  }, [schema?.email])

  async function saveEmailConfig() {
    setEmailBusy(true)
    setEmailMsg(null)
    try {
      await emailApi.saveConfig({ email: emAddress, appPassword: emAppPass, provider: emProvider })
      setEmailConfigured(true)
      setEmAppPass('')
      setEmailMsg('email account connected.')
    } catch (e) {
      setEmailMsg(e instanceof Error ? e.message : 'failed')
    } finally {
      setEmailBusy(false)
    }
  }


  useEffect(() => {
    // Detect the extension and receive browser-replay status via postMessage.
    function onMsg(ev: MessageEvent) {
      const d = ev.data
      if (!d || d.__mimic !== true) return
      if (d.kind === 'extension/present') setExtPresent(true)
      if (d.kind === 'replay-status') {
        setBrowserStatus(d.message + (d.url ? ` — ${d.url}` : ''))
        if (d.status === 'success' || d.status === 'failed') {
          setBrowserRunning(false)
          if (id)
            api
              .listRuns(id)
              .then((runs) => {
                const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)
                setHistory(sorted)
                // Surface the browser run's output inline (same card server runs use).
                if (d.status === 'success' && sorted[0]) setResult(sorted[0])
              })
              .catch(() => {})
        } else {
          setBrowserRunning(true)
        }
      }
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ __mimic: true, kind: 'extension/ping' }, window.location.origin)
    return () => window.removeEventListener('message', onMsg)
  }, [id])

  function runInBrowser() {
    if (!id) return
    const creds =
      schema?.login && (loginPass || loginUser) ? { username: loginUser, password: loginPass } : undefined
    setBrowserRunning(true)
    setBrowserStatus('starting in your browser…')
    window.postMessage({ __mimic: true, kind: 'run-in-browser', automationId: id, values, credentials: creds }, window.location.origin)
  }

  async function connectSite() {
    if (!schema?.startUrl) return
    setConnecting(true)
    setConnectNote(null)
    try {
      const r = await api.loginSession(schema.startUrl)
      setConnectNote(r.note)
    } catch {
      setConnectNote('could not open a login window — is the backend running?')
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    if (!id) return
    api.getAutomation(id).then((s) => {
      setSchema(s)
      const initial: Record<string, string> = {}
      // A recorded date can be long past by the time someone runs the automation
      // — pre-filling it would just guarantee "date not found" on a live site
      // whose calendar can't go backwards. Swap a past date for a near-future one
      // instead, keeping later date fields (check-out, etc) further out so the
      // pair stays in order.
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let pastDateOrdinal = 0
      for (const v of s.variables) {
        if (v.type === 'date' && v.sampleValue && /^\d{4}-\d{2}-\d{2}$/.test(v.sampleValue)) {
          const recorded = new Date(`${v.sampleValue}T00:00:00`)
          if (recorded < today) {
            const future = new Date(today)
            future.setDate(future.getDate() + 7 + pastDateOrdinal * 3)
            // Calendar-date arithmetic, not an instant — toISOString() converts
            // to UTC and can shift the date by a day in timezones ahead of UTC.
            initial[v.name] = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`
            pastDateOrdinal++
            continue
          }
        }
        initial[v.name] = v.sampleValue ?? ''
      }
      setValues(initial)
      if (s.login) api.getCredentialStatus(s.automationId).then((c) => setHasSavedCreds(c.hasCredentials)).catch(() => {})
    }).catch(() => setError('automation not found'))
    api.listRuns(id).then(setHistory).catch(() => {})
  }, [id])

  async function go() {
    if (!id) return
    // Email automations send reliably over SMTP instead of replaying the mail
    // site's fragile DOM — pressing "go" sends, no separate button needed.
    if (schema?.email) {
      if (!emailConfigured) {
        setEmailMsg('connect your email account above first, then press go.')
        return
      }
      setRunning(true)
      setResult(null)
      setError(null)
      setEmailMsg(null)
      try {
        await emailApi.send(id, values)
        setEmailMsg('email sent ✓')
        api.listRuns(id).then(setHistory).catch(() => {})
      } catch (e) {
        setError(e instanceof Error ? e.message : 'send failed')
      } finally {
        setRunning(false)
      }
      return
    }
    setRunning(true)
    setResult(null)
    setError(null)
    try {
      const creds =
        schema?.login && (loginPass || loginUser)
          ? { username: loginUser, password: loginPass }
          : undefined
      if (schema?.login && rememberCreds && loginPass) {
        await api.saveCredentials(id, loginUser, loginPass).then(() => setHasSavedCreds(true)).catch(() => {})
      }
      // "go" always runs on our side and shows the output here — no redirecting
      // the user's tab (that's what "run in my browser" is for). If a site blocks
      // bots, the server escalates to an assisted window and still returns output.
      const r = await api.run(id, values, wantOutput, creds)
      setResult(r)
      api.listRuns(id).then(setHistory).catch(() => {})
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'AbortError'
          ? 'run timed out after 4 minutes — the backend may be busy with another run. Try again shortly.'
          : 'run failed — backend unreachable',
      )
    } finally {
      setRunning(false)
    }
  }

  if (error && !schema) {
    return <div className="container" style={{ padding: 48 }}><div className="brutal" style={{ padding: 20 }}>{error}</div></div>
  }
  if (!schema) {
    return <div className="container" style={{ padding: 48, color: 'var(--ink-soft)' }}>loading…</div>
  }

  const pastRuns = history.filter((h) => h.runId !== result?.runId)
  // Drive the browser-run ring from "step X of N" progress messages.
  const stepMatch = browserStatus?.match(/step (\d+) of (\d+)/)
  const browserProgress = stepMatch ? Math.min(1, Number(stepMatch[1]) / Number(stepMatch[2])) : null

  return (
    <div className="container" style={{ padding: '48px 24px 80px', maxWidth: 780 }}>
      <span className="pill-tag">automation</span>
      <h1 style={{ fontSize: 36, margin: '14px 0 8px' }}>{schema.title}</h1>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>{schema.description}</p>

      <div className="glass" style={{ padding: '28px 26px', marginTop: 28 }}>
        {schema.variables.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', margin: 0 }}>no changeable inputs — this automation replays exactly as recorded.</p>
        )}
        {schema.introspection && !schema.introspection.reached && schema.introspection.note && (
          <div
            style={{
              marginBottom: 20, padding: '10px 14px', borderRadius: 10,
              background: 'rgba(216,103,42,0.1)', border: '1.5px solid var(--orange-soft)',
              fontSize: 13, color: 'var(--ink)',
            }}
          >
            {schema.introspection.note}
          </div>
        )}
        {schema.variables.map((v) => (
          v.type === 'boolean' ? (
            <label key={v.name} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(values[v.name] ?? 'false') === 'true'}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.checked ? 'true' : 'false' }))}
                style={{ width: 'auto' }}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{v.label} <span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: 12.5 }}>(filter)</span></span>
            </label>
          ) : (
          <div key={v.name} style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
              {v.label}
              {v.options && v.options.length > 0 && (
                <span className="pill-tag" style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px' }}>
                  {v.options.length} live options
                </span>
              )}
              {v.sampleValue != null && v.sampleValue !== '' ? (
                <span style={{ fontWeight: 400, color: 'var(--ink-soft)', marginLeft: 8, fontSize: 13 }}>
                  (recorded: "{v.sampleValue}")
                </span>
              ) : null}
            </label>
            {v.options && v.options.length > 0 ? (
              <select
                value={values[v.name] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              >
                {v.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={inputTypeFor(v.type)}
                min={v.type === 'number' ? 0 : undefined}
                value={values[v.name] ?? ''}
                placeholder={v.hint ?? undefined}
                onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
              />
            )}
            {v.hint && (
              <span style={{ display: 'block', marginTop: 6, fontSize: 12, color: 'var(--ink-soft)' }}>{v.hint}</span>
            )}
          </div>
          )
        ))}

        {schema.email && (
          <div style={{ margin: '4px 0 20px', padding: '18px 20px', borderRadius: 12, border: '2px solid var(--ink)', background: 'rgba(29,158,117,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>send this email reliably</span>
              <span className="pill-tag" style={{ fontSize: 10 }}>recommended</span>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.5 }}>
              instead of replaying Gmail's fragile page, mimic sends the email directly over your provider (SMTP).
              fill To / Subject / Message above, connect your account once, then press <b>go</b> to send.
            </p>

            {!emailConfigured ? (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                  {emailPresets.filter((p) => p.id !== 'custom').map((p) => (
                    <button key={p.id} type="button" className={emProvider === p.id ? 'btn' : 'btn btn-ghost'} style={{ padding: '7px 14px', fontSize: 12.5 }} onClick={() => setEmProvider(p.id)}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <input type="email" value={emAddress} onChange={(e) => setEmAddress(e.target.value)} placeholder="your email address" style={{ marginBottom: 8 }} />
                <input type="password" value={emAppPass} onChange={(e) => setEmAppPass(e.target.value)} placeholder="app password (not your normal password)" style={{ marginBottom: 8 }} />
                {emailPresets.find((p) => p.id === emProvider)?.appPasswordUrl && (
                  <p style={{ fontSize: 12, margin: '0 0 12px' }}>
                    <a href={emailPresets.find((p) => p.id === emProvider)!.appPasswordUrl!} target="_blank" rel="noreferrer">create an app password →</a>
                  </p>
                )}
                <button className="btn" disabled={emailBusy || !emAddress || !emAppPass} onClick={saveEmailConfig}>
                  {emailBusy ? 'connecting…' : 'connect email account'}
                </button>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>connected as <b>{emAddress}</b> — press <b>go</b> below to send.</span>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setEmailConfigured(false)}>change account</button>
              </div>
            )}
            {emailMsg && <div style={{ fontSize: 13, marginTop: 10, color: 'var(--orange-dark)' }}>{emailMsg}</div>}
          </div>
        )}

        {schema.login && (
          <div
            style={{
              margin: '4px 0 20px', padding: '16px 18px', borderRadius: 12,
              border: '2px solid var(--ink)', background: 'rgba(216,103,42,0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>this task needs a login</span>
              <span className="pill-tag" style={{ fontSize: 10, padding: '2px 8px' }}>{schema.login.domain}</span>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 10px', lineHeight: 1.5 }}>
              enter the credentials for this site. your password was never recorded — it's injected only at run time
              and stored encrypted on this device if you choose to remember it.
            </p>
            {/(google|gmail|outlook|yahoo|microsoft)/i.test(schema.login.domain) && (
              <p style={{ fontSize: 12, color: 'var(--orange-dark)', margin: '0 0 14px', lineHeight: 1.5 }}>
                <b>email providers block normal passwords for automation.</b> create an{' '}
                <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">app password</a>{' '}
                (account → security → app passwords) and paste that here instead of your real password.
              </p>
            )}

            <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              {schema.login.usernameLabel || 'username / email'}
            </label>
            <input
              type="text"
              autoComplete="off"
              value={loginUser}
              placeholder="you@example.com"
              onChange={(e) => setLoginUser(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={loginPass}
              placeholder={hasSavedCreds ? '•••••••• (saved — leave blank to reuse)' : 'password'}
              onChange={(e) => setLoginPass(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={rememberCreds}
                onChange={(e) => setRememberCreds(e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span style={{ fontSize: 13 }}>remember on this device (encrypted)</span>
            </label>
            {hasSavedCreds && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginTop: 10, fontSize: 12, padding: '6px 14px' }}
                onClick={() => id && api.deleteCredentials(id).then(() => setHasSavedCreds(false))}
              >
                forget saved credentials
              </button>
            )}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 14px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={wantOutput}
            onChange={(e) => setWantOutput(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span style={{ fontSize: 14 }}>give me output back (untick for silent tasks like posting or sending)</span>
        </label>

        {schema.startUrl && (
          <div style={{ margin: '0 0 16px' }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 13, padding: '9px 18px' }}
              disabled={connecting}
              onClick={connectSite}
            >
              {connecting ? 'browser open — finish signing in…' : 'log in to this site first'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 8, lineHeight: 1.5 }}>
              opens a browser so you can sign in once. mimic remembers the session, so runs that need this
              account (like sending email) work afterwards — even without a recorded login.
            </div>
            {connectNote && (
              <div style={{ fontSize: 12.5, color: 'var(--text-success, #0f6e56)', marginTop: 6 }}>{connectNote}</div>
            )}
          </div>
        )}

        <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 20px', lineHeight: 1.5 }}>
          if the site shows a CAPTCHA or needs a login, a real browser window opens automatically so you can
          complete it — then the run continues on its own.
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" style={{ fontSize: 16, padding: '13px 34px' }} disabled={running} onClick={go}>
            {running ? 'running…' : 'go'}
          </button>
          {extPresent && (
            <button className="btn btn-ghost" style={{ fontSize: 15, padding: '13px 24px' }} onClick={runInBrowser}>
              run in my browser
            </button>
          )}
        </div>
        {extPresent && (
          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 8, lineHeight: 1.5 }}>
            "run in my browser" replays in a tab of your own browser — already logged in, your real fingerprint.
            best for Gmail, sites needing login, or ones that block servers.
          </div>
        )}
        {browserStatus && (
          <div className="brutal" style={{ marginTop: 14, padding: '12px 16px', fontSize: 13 }}>
            {browserRunning ? (
              <CircularLoader progress={browserProgress} label="running in your browser…" sub={browserStatus} />
            ) : (
              <span className="mono" style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{browserStatus}</span>
            )}
          </div>
        )}
      </div>

      {running && (
        <div className="brutal" style={{ marginTop: 24, padding: '13px 18px' }}>
          <CircularLoader
            progress={null}
            label={schema.email ? 'sending your email…' : 'running your automation…'}
            sub={
              schema.email
                ? 'delivering over your connected email account.'
                : 'if a browser window pops up, complete any CAPTCHA or login there — it carries on automatically.'
            }
          />
        </div>
      )}

      {result && (
        <div style={{ marginTop: 28 }}>
          <div className="brutal" style={{ padding: '18px 22px', background: result.status === 'success' ? 'var(--beige)' : 'var(--orange-soft)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>
                {result.status === 'success' ? 'done' : 'failed'}
                {result.assisted && (
                  <span className="pill-tag" style={{ marginLeft: 10, fontSize: 10, padding: '2px 8px' }}>
                    assisted
                  </span>
                )}
              </strong>
              <span className="mono" style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                {result.stepsExecuted}/{result.stepsTotal} steps · {((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s
              </span>
            </div>
            {result.error && <p className="mono" style={{ fontSize: 13, marginTop: 10, marginBottom: 0, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{result.error}</p>}
          </div>
          <RunOutput run={result} />
        </div>
      )}

      {pastRuns.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <button className="btn btn-ghost" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'hide' : 'show'} previous runs ({pastRuns.length})
          </button>
          {showHistory && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
              {pastRuns.map((r) => (
                <details key={r.runId} className="glass" style={{ padding: '14px 18px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 14 }}>
                    <strong>{r.status}</strong>
                    <span className="mono" style={{ color: 'var(--ink-soft)', marginLeft: 10, fontSize: 12.5 }}>
                      {new Date(r.startedAt).toLocaleString()} · {r.stepsExecuted}/{r.stepsTotal} steps
                      {r.output?.title ? ` · ${r.output.title}` : ''}
                    </span>
                  </summary>
                  <RunOutput run={r} />
                </details>
              ))}
            </div>
          )}
        </div>
      )}

      <ApiDocs schema={schema} values={values} me={me} copied={apiCopied} setCopied={setApiCopied} />
    </div>
  )
}

/**
 * The REST API panel — the automation's "hidden" endpoint. Docs (endpoint, key,
 * curl) are shown only to a signed-in account; signed-out visitors see a locked
 * teaser that points them to sign in.
 */
function ApiDocs({
  schema,
  values,
  me,
  copied,
  setCopied,
}: {
  schema: AutomationSchema
  values: Record<string, string>
  me: PublicUser | null
  copied: boolean
  setCopied: (b: boolean) => void
}) {
  const endpoint = `${API_BASE}/v1/automations/${schema.automationId}/run`
  const varsObj = Object.fromEntries(schema.variables.map((v) => [v.name, values[v.name] ?? v.sampleValue ?? '']))
  const curl = [
    `curl -X POST ${endpoint} \\`,
    `  -H "Authorization: Bearer YOUR_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify({ variables: varsObj })}'`,
  ].join('\n')

  if (!me) {
    return (
      <div className="glass" style={{ marginTop: 40, padding: '24px 26px', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 6 }}>🔒</div>
        <h2 style={{ fontSize: 20, margin: '0 0 6px' }}>REST API</h2>
        <p style={{ color: 'var(--ink-soft)', margin: '0 auto 16px', maxWidth: 440, lineHeight: 1.6, fontSize: 14 }}>
          every automation is also a REST endpoint you can call from your own code. sign in to reveal this
          automation's endpoint, generate an API key, and get a ready-to-run example.
        </p>
        <Link to="/auth" className="btn" style={{ display: 'inline-block', textDecoration: 'none' }}>
          sign in to unlock
        </Link>
      </div>
    )
  }

  const hasKey = me.apiKeys.length > 0
  return (
    <div className="glass" style={{ marginTop: 40, padding: '24px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 20, margin: 0 }}>REST API</h2>
        <span className="pill-tag" style={{ fontSize: 10 }}>account only</span>
      </div>
      <p style={{ color: 'var(--ink-soft)', margin: '8px 0 18px', fontSize: 14, lineHeight: 1.6 }}>
        run this automation from your own code. authenticate with an API key (create one in{' '}
        <Link to="/account">account → API access</Link>). the JSON below mirrors the inputs above.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="pill-tag" style={{ fontSize: 10, background: 'var(--ink)', color: 'var(--beige)' }}>POST</span>
        <code className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{endpoint}</code>
      </div>

      <div style={{ position: 'relative', marginTop: 12 }}>
        <button
          className="btn btn-ghost"
          style={{ position: 'absolute', top: 8, right: 8, fontSize: 11.5, padding: '5px 12px' }}
          onClick={() => { navigator.clipboard?.writeText(curl).then(() => setCopied(true)) }}
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
        <pre
          className="mono"
          style={{
            background: 'var(--ink)', color: '#f6efe6', padding: '16px 18px', borderRadius: 10,
            overflowX: 'auto', fontSize: 12.5, lineHeight: 1.6, margin: 0,
          }}
        >
          {curl}
        </pre>
      </div>

      {!hasKey && (
        <div className="brutal" style={{ padding: '10px 14px', marginTop: 14, fontSize: 13, background: 'var(--orange-soft)' }}>
          you don't have an API key yet — <Link to="/account">create one in account</Link> and paste it in place of{' '}
          <span className="mono">YOUR_API_KEY</span>.
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: '22px 0 10px' }}>parameters</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {schema.variables.map((v) => (
          <div key={v.name} style={{ display: 'flex', gap: 10, fontSize: 13, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <code className="mono" style={{ fontWeight: 700, minWidth: 130 }}>{v.name}</code>
            <span style={{ color: 'var(--ink-soft)' }}>{v.type}</span>
            {v.required && <span className="pill-tag" style={{ fontSize: 9 }}>required</span>}
            {v.sampleValue && <span style={{ color: 'var(--ink-soft)' }}>e.g. "{v.sampleValue}"</span>}
          </div>
        ))}
        {schema.variables.length === 0 && (
          <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>no parameters — runs exactly as recorded.</span>
        )}
      </div>
    </div>
  )
}
