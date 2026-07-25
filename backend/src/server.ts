import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { api } from './routes/api.js'
import { saas } from './saas/routes.js'
import { dbEnabled, ensureSchema } from './store/db.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mimic-backend', storage: dbEnabled ? 'postgres' : 'file' })
})

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
