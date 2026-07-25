import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth, saasApi, type PaymentMethod, type Plan, type PublicApiKey, type PublicUser } from '../api'

export default function Account() {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [billingEnabled, setBillingEnabled] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [addType, setAddType] = useState<'bkash' | 'card' | 'bank'>('bkash')
  const [pmNumber, setPmNumber] = useState('')
  const [pmHolder, setPmHolder] = useState('')
  const [keys, setKeys] = useState<PublicApiKey[]>([])
  const [newKeyLabel, setNewKeyLabel] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const navigate = useNavigate()

  const load = () => {
    saasApi.me().then((r) => {
      if (!r.user) { navigate('/auth'); return }
      setUser(r.user)
      setBillingEnabled(r.billingEnabled)
      setMethods(r.user.paymentMethods ?? [])
      setKeys(r.user.apiKeys ?? [])
    })
    saasApi.plans().then((r) => setPlans(r.plans))
  }
  useEffect(load, [])

  async function createKey() {
    try {
      const r = await saasApi.createApiKey(newKeyLabel.trim() || 'API key')
      setFreshKey(r.key)
      setCopied(false)
      setNewKeyLabel('')
      setKeys(await saasApi.apiKeys())
    } catch (e) {
      alert(e instanceof Error ? e.message : 'failed')
    }
  }

  async function removeKey(id: string) {
    const r = await saasApi.deleteApiKey(id)
    setKeys(r.apiKeys)
  }

  async function addMethod() {
    try {
      const r = await saasApi.addPaymentMethod(addType, pmNumber, pmHolder)
      setMethods(r.paymentMethods)
      setPmNumber(''); setPmHolder('')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'failed')
    }
  }

  async function choose(planId: string) {
    setBusy(planId)
    try {
      const r = await saasApi.subscribe(planId)
      setUser(r.user)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(null)
    }
  }

  if (!user) return <div className="container" style={{ padding: 48, color: 'var(--ink-soft)' }}>loading…</div>

  return (
    <div className="container" style={{ padding: '48px 24px 80px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 40 }}>account</h1>
          <p style={{ color: 'var(--ink-soft)', marginTop: 6 }}>{user.email}</p>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => { saasApi.logout(); auth.clear(); navigate('/auth') }}
        >
          sign out
        </button>
      </div>

      {!billingEnabled && (
        <div className="brutal" style={{ padding: '12px 16px', marginTop: 16, fontSize: 13, background: 'var(--beige-deep)' }}>
          billing is in test mode — plan changes apply instantly and nothing is charged.
        </div>
      )}

      <h2 style={{ fontSize: 24, margin: '40px 0 20px' }}>choose your song</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 18 }}>
        {plans.map((p) => {
          const current = p.id === user.plan
          return (
            <div
              key={p.id}
              className="brutal"
              style={{ padding: '22px 20px', display: 'flex', flexDirection: 'column', gap: 10, ...(current ? { borderColor: 'var(--orange)', boxShadow: '4px 4px 0 var(--orange)' } : {}) }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h3 style={{ fontSize: 22 }}>{p.name}</h3>
                  {current && <span className="pill-tag" style={{ fontSize: 10 }}>current</span>}
                </div>
                <p style={{ color: 'var(--ink-soft)', fontSize: 13, margin: '4px 0 0', fontStyle: 'italic' }}>{p.tagline}</p>
              </div>
              <div style={{ fontSize: 26, fontWeight: 700 }}>
                {p.priceBdt === null ? 'Custom' : p.priceBdt === 0 ? 'Free' : `${p.priceBdt}`}
                {typeof p.priceBdt === 'number' && p.priceBdt > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--ink-soft)' }}> BDT/mo</span>
                )}
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                {p.perks.map((perk) => (
                  <li key={perk} style={{ fontSize: 13, color: 'var(--ink)', paddingLeft: 18, position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 0, color: 'var(--orange)' }}>✓</span>
                    {perk}
                  </li>
                ))}
              </ul>
              <button
                className="btn"
                style={{ width: '100%', marginTop: 6, opacity: current ? 0.5 : 1 }}
                disabled={current || busy === p.id || p.priceBdt === null}
                onClick={() => choose(p.id)}
              >
                {current ? 'your plan' : p.priceBdt === null ? 'contact us' : busy === p.id ? 'switching…' : 'choose'}
              </button>
            </div>
          )
        })}
      </div>

      <h2 style={{ fontSize: 24, margin: '48px 0 16px' }}>payment methods</h2>
      <div className="glass" style={{ padding: '22px 22px' }}>
        {methods.length === 0 && <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>no saved payment methods yet.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: methods.length ? 20 : 0 }}>
          {methods.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '2px solid var(--ink)', borderRadius: 10 }}>
              <span style={{ fontWeight: 500 }}>
                {m.label}
                {m.isDefault && <span className="pill-tag" style={{ marginLeft: 10, fontSize: 10 }}>default</span>}
              </span>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => saasApi.deletePaymentMethod(m.id).then((r) => setMethods(r.paymentMethods))}>
                remove
              </button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid rgba(43,36,32,0.15)', paddingTop: 18 }}>
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>add a method</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['bkash', 'card', 'bank'] as const).map((t) => (
              <button key={t} className={addType === t ? 'btn' : 'btn btn-ghost'} style={{ padding: '8px 16px', fontSize: 13, textTransform: 'capitalize' }} onClick={() => setAddType(t)}>
                {t === 'bkash' ? 'bKash' : t}
              </button>
            ))}
          </div>
          <input
            value={pmNumber}
            onChange={(e) => setPmNumber(e.target.value)}
            placeholder={addType === 'bkash' ? 'bKash number (e.g. 01700000000)' : addType === 'card' ? 'card number' : 'account number'}
            style={{ marginBottom: 10 }}
          />
          {addType !== 'bkash' && (
            <input value={pmHolder} onChange={(e) => setPmHolder(e.target.value)} placeholder="name on account" style={{ marginBottom: 10 }} />
          )}
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
            only the last 4 digits are stored (masked). test mode — nothing is charged.
          </p>
          <button className="btn" disabled={!pmNumber} onClick={addMethod}>save method</button>
        </div>
      </div>

      <h2 style={{ fontSize: 24, margin: '48px 0 8px' }}>API access</h2>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0, fontSize: 14, lineHeight: 1.6 }}>
        create a key to run your automations over the REST API. each automation exposes a{' '}
        <span className="mono">POST /v1/automations/&lt;id&gt;/run</span> endpoint — see the "REST API" box on any
        automation's run page for a ready-to-copy example.
      </p>
      <div className="glass" style={{ padding: '22px 22px' }}>
        {freshKey && (
          <div className="brutal" style={{ padding: '14px 16px', marginBottom: 18, background: 'var(--orange-soft)' }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
              your new key — copy it now, it won't be shown in full again
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all', flex: 1, minWidth: 200 }}>{freshKey}</code>
              <button
                className="btn"
                style={{ fontSize: 12, padding: '7px 14px' }}
                onClick={() => { navigator.clipboard?.writeText(freshKey).then(() => setCopied(true)) }}
              >
                {copied ? 'copied ✓' : 'copy'}
              </button>
            </div>
          </div>
        )}

        {keys.length === 0 && !freshKey && (
          <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>no API keys yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: keys.length ? 20 : 0 }}>
          {keys.map((k) => (
            <div key={k.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '2px solid var(--ink)', borderRadius: 10, gap: 12, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{k.label}</span>
                <span className="mono" style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--ink-soft)' }}>{k.masked}</span>
                <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--ink-soft)' }}>
                  {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
                </span>
              </span>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => removeKey(k.id)}>revoke</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid rgba(43,36,32,0.15)', paddingTop: 18 }}>
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>create a key</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={newKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
              placeholder="label (e.g. production, my script)"
              style={{ flex: 1, minWidth: 200, marginBottom: 0 }}
              onKeyDown={(e) => e.key === 'Enter' && createKey()}
            />
            <button className="btn" onClick={createKey}>generate key</button>
          </div>
        </div>
      </div>
    </div>
  )
}
