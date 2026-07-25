import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, auth, saasApi, type AutomationSchema, type PublicUser, type RecordingSummary } from '../api'

const PLAN_NAME: Record<string, string> = {
  fledgling: 'Fledgling',
  songbird: 'Songbird',
  mockingbird: 'Mockingbird',
  lyrebird: 'Lyrebird',
}

export default function Dashboard() {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([])
  const [automations, setAutomations] = useState<AutomationSchema[]>([])
  const [analyzing, setAnalyzing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [user, setUser] = useState<PublicUser | null>(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const newId = searchParams.get('new')

  const load = () => {
    api.listRecordings()
      .then((rs) => setRecordings([...rs].sort((a, b) => b.startedAt - a.startedAt)))
      .catch(() => setError('backend unreachable — is it running on port 4545?'))
    api.listAutomations()
      .then((as) => setAutomations([...as].sort((a, b) => b.createdAt - a.createdAt)))
      .catch(() => {})
    if (auth.token()) saasApi.me().then((r) => setUser(r.user)).catch(() => {})
  }

  useEffect(load, [])

  async function buildAutomation(recordingId: string) {
    setAnalyzing(recordingId)
    setError(null)
    try {
      const schema = await api.analyze(recordingId)
      navigate(`/run/${schema.automationId}`)
    } catch {
      setError('analysis failed — check backend logs')
    } finally {
      setAnalyzing(null)
    }
  }

  return (
    <div className="container" style={{ padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 40 }}>dashboard</h1>

      {user ? (
        <div
          className="glass"
          style={{
            marginTop: 18, padding: '16px 22px', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700 }}>{user.email}</span>
            <span className="pill-tag">{PLAN_NAME[user.plan] ?? user.plan} plan</span>
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {automations.length} automation{automations.length === 1 ? '' : 's'} · {user.apiKeys.length} API key{user.apiKeys.length === 1 ? '' : 's'} · {user.dailyCreations} build{user.dailyCreations === 1 ? '' : 's'} today
            </span>
          </div>
          <Link to="/account" className="btn btn-ghost" style={{ textDecoration: 'none', fontSize: 13, padding: '8px 16px' }}>
            plan, payments &amp; API keys
          </Link>
        </div>
      ) : (
        <div
          className="glass"
          style={{ marginTop: 18, padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: 14, color: 'var(--ink-soft)' }}>
            sign in to manage your plan, payment methods and REST API keys.
          </span>
          <Link to="/auth" className="btn" style={{ textDecoration: 'none', fontSize: 13, padding: '8px 16px' }}>
            sign in
          </Link>
        </div>
      )}

      {error && (
        <div className="brutal" style={{ marginTop: 20, padding: '14px 18px', background: 'var(--orange-soft)' }}>
          {error}
        </div>
      )}

      <h2 style={{ fontSize: 24, margin: '40px 0 16px' }}>your automations</h2>
      {automations.length === 0 && (
        <p style={{ color: 'var(--ink-soft)' }}>none yet — build one from a recording below.</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
        {automations.map((a) => (
          <div key={a.automationId} className="brutal" style={{ padding: '20px 22px', position: 'relative' }}>
            <button
              aria-label="delete automation"
              onClick={() => { api.deleteAutomation(a.automationId).then(load) }}
              style={{
                position: 'absolute', top: 10, right: 12, background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 16, color: 'var(--ink-soft)', padding: 4, width: 'auto',
              }}
            >
              ✕
            </button>
            <Link to={`/run/${a.automationId}`}>
              <h3 style={{ fontSize: 19, color: 'var(--ink)' }}>{a.title}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14, margin: '8px 0 12px', lineHeight: 1.5 }}>{a.description}</p>
              <span className="pill-tag">{a.variables.length} input{a.variables.length === 1 ? '' : 's'}</span>
            </Link>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 24, margin: '48px 0 16px' }}>recordings</h2>
      {recordings.length === 0 && (
        <p style={{ color: 'var(--ink-soft)' }}>
          nothing here — record a task with the extension, then press "review &amp; build" in its popup.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {recordings.map((r) => (
          <div
            key={r.id}
            className="glass"
            style={{
              padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 16, flexWrap: 'wrap',
              ...(r.id === newId ? { border: '2.5px solid var(--orange)', boxShadow: '0 0 0 4px rgba(216,103,42,0.25)' } : {}),
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                {r.domains.length > 0 ? r.domains.join(' → ') : 'unknown site'}
                {r.id === newId && <span className="pill-tag" style={{ fontSize: 11 }}>just recorded</span>}
              </div>
              <div style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 4 }}>
                {r.eventCount} steps · {new Date(r.startedAt).toLocaleString()}
                <span className="mono" style={{ marginLeft: 10, fontSize: 12 }}>{r.id}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn" disabled={analyzing === r.id} onClick={() => buildAutomation(r.id)}>
                {analyzing === r.id ? 'analyzing…' : 'build automation'}
              </button>
              <button
                aria-label="delete recording"
                onClick={() => { api.deleteRecording(r.id).then(load) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--ink-soft)', width: 'auto', padding: 4 }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
