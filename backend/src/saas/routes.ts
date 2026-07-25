import { Router, type Request, type Response, type NextFunction } from 'express'
import { saasStore } from './store.js'
import { hashPassword, verifyPassword, makeToken, makeApiKey, maskApiKey, isValidEmail } from './auth.js'
import { PLANS, DEFAULT_PLAN, platformFeePct, type PlanId } from './plans.js'
import { BILLING_ENABLED, bkash, checkCreationQuota, refreshDailyQuota } from './billing.js'
import type { ApiKey, Listing, PublicUser, Transaction, User, PriceModel } from './types.js'

export const saas = Router()

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function publicUser(u: User): PublicUser {
  refreshDailyQuota(u)
  return {
    id: u.id,
    email: u.email,
    plan: u.plan,
    bkashAccount: u.bkashAccount,
    paymentMethods: u.paymentMethods ?? [],
    apiKeys: (u.apiKeys ?? []).map((k) => ({
      id: k.id,
      label: k.label,
      masked: maskApiKey(k.key),
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })),
    dailyCreations: u.dailyCreations,
    createdAt: u.createdAt,
  }
}

function bearer(req: Request): string | null {
  const h = req.header('authorization')
  if (h?.startsWith('Bearer ')) return h.slice(7)
  return null
}

/** Attaches req.user when a valid token is present. */
export async function withUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req)
  if (token) {
    const userId = await saasStore.userIdForToken(token)
    if (userId) {
      const u = await saasStore.getUser(userId)
      if (u) (req as Request & { user?: User }).user = u
    }
  }
  next()
}

function requireUser(req: Request, res: Response): User | null {
  const u = (req as Request & { user?: User }).user
  if (!u) {
    res.status(401).json({ error: 'sign in required' })
    return null
  }
  return u
}

// --- auth ---

saas.post('/auth/register', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string }
  if (!email || !isValidEmail(email)) {
    res.status(400).json({ error: 'valid email required' })
    return
  }
  if (!password || password.length < 6) {
    res.status(400).json({ error: 'password must be at least 6 characters' })
    return
  }
  if (await saasStore.getUserByEmail(email)) {
    res.status(409).json({ error: 'an account with this email already exists' })
    return
  }
  const now = Date.now()
  const user: User = {
    id: makeId(),
    email,
    passwordHash: hashPassword(password),
    plan: DEFAULT_PLAN,
    bkashAccount: null,
    paymentMethods: [],
    dailyCreations: 0,
    creationsResetAt: now + 24 * 60 * 60 * 1000,
    createdAt: now,
  }
  await saasStore.saveUser(user)
  const token = makeToken()
  await saasStore.createSession(token, user.id)
  res.json({ token, user: publicUser(user) })
})

saas.post('/auth/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string }
  const user = email ? await saasStore.getUserByEmail(email) : null
  if (!user || !password || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ error: 'wrong email or password' })
    return
  }
  const token = makeToken()
  await saasStore.createSession(token, user.id)
  res.json({ token, user: publicUser(user) })
})

saas.post('/auth/logout', withUser, async (req, res) => {
  const token = bearer(req)
  if (token) await saasStore.destroySession(token)
  res.json({ ok: true })
})

saas.get('/auth/me', withUser, (req, res) => {
  const u = (req as Request & { user?: User }).user
  res.json({ user: u ? publicUser(u) : null, billingEnabled: BILLING_ENABLED })
})

// --- plans + subscription ---

saas.get('/plans', (_req, res) => {
  res.json({
    plans: Object.values(PLANS).map((p) => ({ ...p, dailyCreations: p.dailyCreations === Infinity ? -1 : p.dailyCreations })),
    billingEnabled: BILLING_ENABLED,
  })
})

saas.post('/subscription', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const { plan, bkashAccount } = req.body as { plan?: PlanId; bkashAccount?: string }
  if (!plan || !(plan in PLANS)) {
    res.status(400).json({ error: 'unknown plan' })
    return
  }
  const target = PLANS[plan]
  // Charge (or dev-bypass) for paid plans.
  if (target.priceBdt && target.priceBdt > 0) {
    const charge = await bkash.charge({
      amountBdt: target.priceBdt,
      description: `${target.name} monthly subscription`,
      payerRef: bkashAccount,
    })
    if (!charge.ok) {
      res.status(402).json({ error: 'payment failed', note: charge.note })
      return
    }
    const txn: Transaction = {
      id: makeId(),
      userId: user.id,
      type: 'subscription',
      amountBdt: target.priceBdt,
      platformFeeBdt: 0,
      netBdt: target.priceBdt,
      status: 'completed',
      ref: charge.ref,
      meta: { plan },
      createdAt: Date.now(),
    }
    await saasStore.saveTransaction(txn)
  }
  user.plan = plan
  if (bkashAccount) user.bkashAccount = bkashAccount
  await saasStore.saveUser(user)
  res.json({ ok: true, user: publicUser(user) })
})

// --- payment methods (dummy, masked; no real card/account numbers stored) ---

saas.get('/payment-methods', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  res.json(user.paymentMethods ?? [])
})

saas.post('/payment-methods', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const { type, number, holder } = req.body as { type?: string; number?: string; holder?: string }
  if (!type || !['bkash', 'card', 'bank'].includes(type)) {
    res.status(400).json({ error: 'type must be bkash, card or bank' })
    return
  }
  const digits = (number ?? '').replace(/\D/g, '')
  const last4 = digits.slice(-4) || '????'
  const label =
    type === 'bkash' ? `bKash ${last4 ? '•••• ' + last4 : ''}`.trim()
    : type === 'card' ? `Card •••• ${last4}${holder ? ` · ${holder}` : ''}`
    : `Bank •••• ${last4}${holder ? ` · ${holder}` : ''}`
  const method = {
    id: makeId(),
    type: type as 'bkash' | 'card' | 'bank',
    label,
    isDefault: (user.paymentMethods ?? []).length === 0,
  }
  user.paymentMethods = [...(user.paymentMethods ?? []), method]
  await saasStore.saveUser(user)
  res.json({ ok: true, method, paymentMethods: user.paymentMethods })
})

saas.delete('/payment-methods/:id', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const mid = String(req.params.id)
  user.paymentMethods = (user.paymentMethods ?? []).filter((m) => m.id !== mid)
  if (user.paymentMethods.length > 0 && !user.paymentMethods.some((m) => m.isDefault)) {
    user.paymentMethods[0].isDefault = true
  }
  await saasStore.saveUser(user)
  res.json({ ok: true, paymentMethods: user.paymentMethods })
})

// --- API keys (for the REST API — created here, shown in full only once) ---

saas.get('/api-keys', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  res.json(publicUser(user).apiKeys)
})

saas.post('/api-keys', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const { label } = req.body as { label?: string }
  const key: ApiKey = {
    id: makeId(),
    key: makeApiKey(),
    label: (label ?? '').trim() || 'API key',
    createdAt: Date.now(),
    lastUsedAt: null,
  }
  user.apiKeys = [...(user.apiKeys ?? []), key]
  await saasStore.saveUser(user)
  await saasStore.registerApiKey(key.key, user.id)
  // Return the FULL key exactly once so the caller can copy it now.
  res.json({ ok: true, id: key.id, key: key.key, label: key.label, createdAt: key.createdAt })
})

saas.delete('/api-keys/:id', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const kid = String(req.params.id)
  const gone = (user.apiKeys ?? []).find((k) => k.id === kid)
  user.apiKeys = (user.apiKeys ?? []).filter((k) => k.id !== kid)
  await saasStore.saveUser(user)
  if (gone) await saasStore.unregisterApiKey(gone.key)
  res.json({ ok: true, apiKeys: publicUser(user).apiKeys })
})

// --- marketplace ---

saas.get('/marketplace', async (_req, res) => {
  const listings = (await saasStore.listListings()).filter((l) => l.active)
  res.json(listings.sort((a, b) => b.createdAt - a.createdAt))
})

saas.post('/marketplace', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  if (BILLING_ENABLED && !PLANS[user.plan].marketplaceSeller) {
    res.status(403).json({ error: `Selling needs the ${PLANS.mockingbird.name} plan or higher.` })
    return
  }
  const { automationId, title, description, priceModel, priceBdt } = req.body as {
    automationId?: string
    title?: string
    description?: string
    priceModel?: PriceModel
    priceBdt?: number
  }
  if (!automationId || !title || !priceModel || typeof priceBdt !== 'number' || priceBdt <= 0) {
    res.status(400).json({ error: 'automationId, title, priceModel and a positive priceBdt are required' })
    return
  }
  const listing: Listing = {
    id: makeId(),
    automationId,
    sellerId: user.id,
    title,
    description: description ?? '',
    priceModel,
    priceBdt,
    createdAt: Date.now(),
    active: true,
    sales: 0,
  }
  await saasStore.saveListing(listing)
  res.json(listing)
})

saas.delete('/marketplace/:id', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const listingId = String(req.params.id)
  const listing = await saasStore.getListing(listingId)
  if (!listing || listing.sellerId !== user.id) {
    res.status(404).json({ error: 'listing not found' })
    return
  }
  await saasStore.deleteListing(listingId)
  res.json({ ok: true })
})

saas.post('/marketplace/:id/buy', withUser, async (req, res) => {
  const buyer = requireUser(req, res)
  if (!buyer) return
  const listing = await saasStore.getListing(String(req.params.id))
  if (!listing || !listing.active) {
    res.status(404).json({ error: 'listing not found' })
    return
  }
  const seller = await saasStore.getUser(listing.sellerId)
  const feePct = platformFeePct(listing.priceBdt, seller ? PLANS[seller.plan].platformFeeDiscount : false)
  const fee = Math.round((listing.priceBdt * feePct) / 100)
  const net = listing.priceBdt - fee

  const charge = await bkash.charge({ amountBdt: listing.priceBdt, description: `Marketplace: ${listing.title}` })
  if (!charge.ok) {
    res.status(402).json({ error: 'payment failed', note: charge.note })
    return
  }

  const purchase: Transaction = {
    id: makeId(),
    userId: buyer.id,
    type: 'marketplace_purchase',
    amountBdt: listing.priceBdt,
    platformFeeBdt: fee,
    netBdt: net,
    status: 'completed',
    ref: charge.ref,
    meta: { listingId: listing.id, sellerId: listing.sellerId, feePct },
    createdAt: Date.now(),
  }
  await saasStore.saveTransaction(purchase)

  // Seller payout (minus platform fee) — simulated in dev.
  if (seller) {
    const payout = await bkash.payout({ amountBdt: net, description: `Payout for ${listing.title}`, payerRef: seller.bkashAccount ?? undefined })
    await saasStore.saveTransaction({
      id: makeId(),
      userId: seller.id,
      type: 'payout',
      amountBdt: net,
      platformFeeBdt: 0,
      netBdt: net,
      status: payout.ok ? 'completed' : 'failed',
      ref: payout.ref,
      meta: { listingId: listing.id },
      createdAt: Date.now(),
    })
  }

  listing.sales += 1
  await saasStore.saveListing(listing)
  res.json({ ok: true, automationId: listing.automationId, chargedBdt: listing.priceBdt, platformFeeBdt: fee, sellerNetBdt: net })
})

saas.get('/transactions', withUser, async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return
  const all = await saasStore.listTransactions()
  res.json(all.filter((t) => t.userId === user.id).sort((a, b) => b.createdAt - a.createdAt))
})
