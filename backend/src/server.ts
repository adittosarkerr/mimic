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

const PORT = Number(process.env.PORT) || 4000

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `mimic backend listening on http://localhost:${PORT} (storage: ${dbEnabled ? 'postgres' : 'local files'})`,
      )
    })
  })
  .catch((err) => {
    console.error('failed to initialize database schema:', err)
    process.exit(1)
  })
