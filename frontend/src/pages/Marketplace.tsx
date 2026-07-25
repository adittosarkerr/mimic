import { useEffect, useState } from 'react'
import { api, auth, saasApi, type AutomationSchema, type Listing } from '../api'

const MODEL_LABEL: Record<string, string> = {
  per_use: 'per use',
  per_100: 'per 100 uses',
  subscription: 'monthly',
}

export default function Marketplace() {
  const [listings, setListings] = useState<Listing[]>([])
  const [mine, setMine] = useState<AutomationSchema[]>([])
  const [signedIn, setSignedIn] = useState(false)
  const [showList, setShowList] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // list form
  const [autoId, setAutoId] = useState('')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [model, setModel] = useState('per_use')
  const [price, setPrice] = useState('500')

  const load = () => {
    saasApi.marketplace().then(setListings).catch(() => {})
    setSignedIn(!!auth.token())
    api.listAutomations().then(setMine).catch(() => {})
  }
  useEffect(load, [])

  async function buy(l: Listing) {
    setMsg(null)
    try {
      const r = await saasApi.buy(l.id)
      setMsg(`purchased "${l.title}" — ${r.chargedBdt} BDT (platform fee ${r.platformFeeBdt}, seller got ${r.sellerNetBdt}). it's now in your dashboard.`)
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'purchase failed')
    }
  }

  async function publish() {
    setMsg(null)
    try {
      await saasApi.listAutomation({ automationId: autoId, title, description: desc, priceModel: model, priceBdt: Number(price) })
      setShowList(false)
      setTitle(''); setDesc(''); setAutoId('')
      load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'listing failed')
    }
  }

  return (
    <div className="container" style={{ padding: '48px 24px 80px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 40 }}>marketplace</h1>
          <p style={{ color: 'var(--ink-soft)', marginTop: 6 }}>buy ready-made automations, or sell the ones you built.</p>
        </div>
        {signedIn && (
          <button className="btn" onClick={() => setShowList(!showList)}>
            {showList ? 'cancel' : 'sell an automation'}
          </button>
        )}
      </div>

      {msg && (
        <div className="brutal" style={{ padding: '12px 16px', marginTop: 18, fontSize: 13, background: 'var(--beige-deep)' }}>{msg}</div>
      )}

      {showList && (
        <div className="glass" style={{ padding: '22px 22px', marginTop: 20 }}>
          <h3 style={{ fontSize: 18, marginBottom: 14 }}>list your automation</h3>
          <label style={lbl}>which automation</label>
          <select value={autoId} onChange={(e) => { setAutoId(e.target.value); const a = mine.find((m) => m.automationId === e.target.value); if (a && !title) setTitle(a.title) }} style={{ marginBottom: 12 }}>
            <option value="">select one…</option>
            {mine.map((a) => <option key={a.automationId} value={a.automationId}>{a.title}</option>)}
          </select>
          <label style={lbl}>title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 12 }} />
          <label style={lbl}>description</label>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ marginBottom: 12 }} />
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>pricing</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="per_use">per single use</option>
                <option value="per_100">per 100 uses</option>
                <option value="subscription">monthly subscription</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>price (BDT)</label>
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </div>
          <button className="btn" style={{ marginTop: 16 }} disabled={!autoId || !title} onClick={publish}>publish listing</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18, marginTop: 28 }}>
        {listings.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>no listings yet — be the first to sell one.</p>}
        {listings.map((l) => (
          <div key={l.id} className="brutal" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ fontSize: 19 }}>{l.title}</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, margin: 0, flex: 1 }}>{l.description || 'no description'}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 18 }}>
                {l.priceBdt} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-soft)' }}>BDT {MODEL_LABEL[l.priceModel]}</span>
              </span>
              <span className="pill-tag" style={{ fontSize: 10 }}>{l.sales} sold</span>
            </div>
            <button className="btn" disabled={!signedIn} onClick={() => buy(l)}>
              {signedIn ? 'buy' : 'sign in to buy'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }
