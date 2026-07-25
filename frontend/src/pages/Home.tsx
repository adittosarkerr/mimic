import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

// Pre-built extension zip, published as a GitHub release asset (re-uploaded
// in place as the extension changes, so this URL stays stable). Unzip, then
// chrome://extensions -> Developer mode -> Load unpacked -> pick the folder.
const EXTENSION_DOWNLOAD_URL = 'https://github.com/adittosarkerr/mimic/releases/download/extension-latest/mimic-extension.zip'

function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      canvas.width = canvas.offsetWidth * dpr
      canvas.height = canvas.offsetHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const W = () => canvas.offsetWidth
    const H = () => canvas.offsetHeight

    interface Node {
      x: number
      y: number
      vx: number
      vy: number
      r: number
    }
    const nodes: Node[] = Array.from({ length: 42 }, () => ({
      x: Math.random() * 900,
      y: Math.random() * 480,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
      r: 2 + Math.random() * 3,
    }))

    let t = 0
    const draw = () => {
      t += 0.008
      ctx.clearRect(0, 0, W(), H())

      for (const n of nodes) {
        n.x += n.vx
        n.y += n.vy
        if (n.x < 0 || n.x > W()) n.vx *= -1
        if (n.y < 0 || n.y > H()) n.vy *= -1
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (d < 130) {
            ctx.strokeStyle = `rgba(216, 103, 42, ${(1 - d / 130) * 0.35})`
            ctx.lineWidth = 1.2
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      for (const n of nodes) {
        ctx.fillStyle = '#d8672a'
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
      }

      const cx = W() / 2 + Math.cos(t) * W() * 0.32
      const cy = H() / 2 + Math.sin(t * 1.4) * H() * 0.3
      ctx.fillStyle = '#2b2420'
      ctx.beginPath()
      ctx.arc(cx, cy, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(43, 36, 32, 0.5)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, 14 + Math.sin(t * 6) * 3, 0, Math.PI * 2)
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
}

export default function Home() {
  return (
    <div className="container">
      <section style={{ position: 'relative', padding: '90px 0 60px', minHeight: 480 }}>
        <HeroCanvas />
        <div style={{ position: 'relative', pointerEvents: 'none' }}>
          <span className="pill-tag" style={{ marginBottom: 20 }}>no code. no scripts. just show it.</span>
          <h1 style={{ fontSize: 'clamp(42px, 7vw, 84px)', lineHeight: 1.02, margin: '18px 0 0', maxWidth: 720 }}>
            Show it once.
            <br />
            <span style={{ color: 'var(--orange)' }}>It runs forever.</span>
          </h1>
          <p style={{ fontSize: 19, color: 'var(--ink-soft)', maxWidth: 480, marginTop: 24, lineHeight: 1.55 }}>
            Record any task on any website — searching, booking, posting — and mimic turns it into a reusable
            automation with a simple form. Even across multiple sites.
          </p>
          <div style={{ marginTop: 32, display: 'flex', gap: 14, pointerEvents: 'auto' }}>
            <Link to="/dashboard">
              <button className="btn" style={{ fontSize: 16, padding: '13px 28px' }}>open dashboard</button>
            </Link>
            <a href={EXTENSION_DOWNLOAD_URL} download rel="noreferrer">
              <button className="btn btn-ghost" style={{ fontSize: 16, padding: '13px 28px' }}>get the extension</button>
            </a>
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 14, pointerEvents: 'auto' }}>
            downloads a zip — unzip it, then <span className="mono">chrome://extensions</span> → Developer mode →
            Load unpacked → pick the unzipped folder.
          </p>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, padding: '30px 0 80px' }}>
        {[
          { n: '01', title: 'Record', body: 'Press record in the extension and do the task like you always do. mimic quietly watches every click and keystroke — across any number of sites.' },
          { n: '02', title: 'Fill the form', body: 'mimic finds the parts you would want to change — search words, dates, names — and builds a clean form out of them.' },
          { n: '03', title: 'Run it', body: 'Type new details, press go. Get tidy interactive results back — or run silently for tasks that need no output.' },
        ].map((c) => (
          <div key={c.n} className="brutal" style={{ padding: '26px 24px' }}>
            <span className="mono" style={{ color: 'var(--orange)', fontWeight: 600, fontSize: 14 }}>{c.n}</span>
            <h3 style={{ fontSize: 24, margin: '10px 0 12px' }}>{c.title}</h3>
            <p style={{ color: 'var(--ink-soft)', lineHeight: 1.6, margin: 0, fontSize: 15 }}>{c.body}</p>
          </div>
        ))}
      </section>
    </div>
  )
}
