import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { auth, saasApi, type PublicUser } from './api'
import Home from './pages/Home'
import Dashboard from './pages/Dashboard'
import Run from './pages/Run'
import Auth from './pages/Auth'
import Account from './pages/Account'
import Marketplace from './pages/Marketplace'

const PLAN_NAME: Record<string, string> = {
  fledgling: 'Fledgling',
  songbird: 'Songbird',
  mockingbird: 'Mockingbird',
  lyrebird: 'Lyrebird',
}

function Nav() {
  const { pathname } = useLocation()
  const [user, setUser] = useState<PublicUser | null>(null)

  useEffect(() => {
    if (auth.token()) saasApi.me().then((r) => setUser(r.user)).catch(() => {})
  }, [pathname])

  const linkStyle = (active: boolean) => ({ fontWeight: active ? 700 : 400, color: 'var(--ink)' })

  return (
    <nav
      className="glass"
      style={{
        position: 'sticky', top: 16, zIndex: 50, margin: '16px auto 0', maxWidth: 1012,
        padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}
    >
      <Link to="/" style={{ fontWeight: 700, fontSize: 22, color: 'var(--ink)', letterSpacing: '-0.02em' }}>
        mimic<span style={{ color: 'var(--orange)' }}>.</span>
      </Link>
      <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
        <Link to="/dashboard" style={linkStyle(pathname.startsWith('/dashboard'))}>dashboard</Link>
        <Link to="/marketplace" style={linkStyle(pathname.startsWith('/marketplace'))}>marketplace</Link>
        {user ? (
          <Link to="/account" style={{ ...linkStyle(pathname.startsWith('/account')), display: 'flex', alignItems: 'center', gap: 6 }}>
            account
            <span className="pill-tag" style={{ fontSize: 10, padding: '2px 8px' }}>{PLAN_NAME[user.plan] ?? user.plan}</span>
          </Link>
        ) : (
          <Link to="/auth?mode=register" style={linkStyle(pathname.startsWith('/auth'))}>sign up</Link>
        )}
      </div>
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/run/:id" element={<Run />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/account" element={<Account />} />
        <Route path="/marketplace" element={<Marketplace />} />
      </Routes>
    </BrowserRouter>
  )
}
