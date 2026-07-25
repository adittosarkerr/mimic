import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { auth, saasApi } from '../api'

export default function Auth() {
  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'register'>(searchParams.get('mode') === 'register' ? 'register' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = mode === 'login' ? await saasApi.login(email, password) : await saasApi.register(email, password)
      auth.set(res.token)
      navigate('/dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container" style={{ padding: '60px 24px', maxWidth: 460 }}>
      <span className="pill-tag">{mode === 'login' ? 'welcome back' : 'join mimic'}</span>
      <h1 style={{ fontSize: 38, margin: '14px 0 6px' }}>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
        {mode === 'login' ? 'run and manage your automations.' : 'start on the free Fledgling plan — upgrade anytime.'}
      </p>

      <div className="glass" style={{ padding: '26px 24px', marginTop: 24 }}>
        <label style={{ display: 'block', fontWeight: 700, fontSize: 14, marginBottom: 6 }}>email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={{ marginBottom: 16 }} />

        <label style={{ display: 'block', fontWeight: 700, fontSize: 14, marginBottom: 6 }}>password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={mode === 'register' ? 'at least 6 characters' : 'password'}
          style={{ marginBottom: 20 }}
        />

        {error && (
          <div className="brutal" style={{ padding: '10px 14px', marginBottom: 16, background: 'var(--orange-soft)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <button className="btn" style={{ width: '100%', fontSize: 15, padding: 13 }} disabled={busy} onClick={submit}>
          {busy ? 'please wait…' : mode === 'login' ? 'sign in' : 'create account'}
        </button>
      </div>

      <p style={{ textAlign: 'center', marginTop: 18, fontSize: 14, color: 'var(--ink-soft)' }}>
        {mode === 'login' ? "no account yet? " : 'already have one? '}
        <button
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}
          style={{ background: 'none', border: 'none', color: 'var(--orange-dark)', fontWeight: 700, cursor: 'pointer', fontSize: 14, width: 'auto', padding: 0 }}
        >
          {mode === 'login' ? 'create one' : 'sign in'}
        </button>
      </p>
    </div>
  )
}
