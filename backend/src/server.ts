import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { api } from './routes/api.js'
import { saas } from './saas/routes.js'
import { dbEnabled, ensureSchema, query } from './store/db.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

// dbEnabled only means POSTGRES_URL is set — it says nothing about whether the
// connection actually works (wrong password, blocked network, expired
// project, etc). Run a real query so this genuinely proves connectivity.
async function health(_req: express.Request, res: express.Response) {
  if (!dbEnabled) {
    res.json({ ok: true, service: 'mimic-backend', storage: 'file' })
    return
  }
  try {
    await query('SELECT 1')
    res.json({ ok: true, service: 'mimic-backend', storage: 'postgres', dbConnected: true })
  } catch (err) {
    res.status(503).json({
      ok: false,
      service: 'mimic-backend',
      storage: 'postgres',
      dbConnected: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
app.get('/health', health)
// Also reachable at /api/health — this repo's vercel.json only rewrites
// /api/* to this service, so the bare /health path is unreachable once
// deployed (it falls through to the frontend's catch-all instead).
app.get('/api/health', health)

app.use('/api', api)
app.use('/api', saas)

// Express 5 auto-forwards a rejected promise from any async route handler to
// error-handling middleware (e.g. a query against an unreachable database) —
// but its BUILT-IN handler renders an HTML page. The frontend always expects
// JSON (`res.json()`), so an unhandled error was surfacing there as
// "Unexpected token '<', <!DOCTYPE...'" instead of a readable message. This
// must be registered after every route (4-arg signature is how Express
// recognizes error middleware).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('unhandled route error:', err)
  if (res.headersSent) return
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal server error' })
})

const PORT = Number(process.env.PORT) || 4000

// A bad/unreachable POSTGRES_URL must NEVER take the whole app down — on a
// normal server process.exit(1) just triggers a restart, but on Vercel it
// kills the ONE process serving every request, so a single wrong connection
// string bricks the entire site (every route, not just DB-dependent ones).
// Log it and start anyway; /api/health's own dbConnected check surfaces the
// real problem instead.
ensureSchema()
  .catch((err) => {
    console.error('database schema init failed — starting anyway; /api/health will report the DB as unreachable:', err)
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(
        `mimic backend listening on http://localhost:${PORT} (storage: ${dbEnabled ? 'postgres' : 'local files'})`,
      )
    })
  })
