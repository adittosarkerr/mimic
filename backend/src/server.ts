import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { api } from './routes/api.js'
import { saas } from './saas/routes.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mimic-backend' })
})

app.use('/api', api)
app.use('/api', saas)

const PORT = Number(process.env.PORT) || 4000
app.listen(PORT, () => {
  console.log(`mimic backend listening on http://localhost:${PORT}`)
})
