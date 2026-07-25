import type { PlanId } from './plans.js'

export type PaymentMethodType = 'bkash' | 'card' | 'bank'

export interface PaymentMethod {
  id: string
  type: PaymentMethodType
  /** Display label only — masked (e.g. "bKash •••• 4321"). No secrets stored. */
  label: string
  isDefault: boolean
}

/** An API key lets a user call the REST API for their automations. The full
 * secret is shown once at creation; afterwards only a masked label is returned. */
export interface ApiKey {
  id: string
  key: string // full secret, e.g. "mk_live_<hex>"
  label: string
  createdAt: number
  lastUsedAt: number | null
}

export interface User {
  id: string
  email: string
  passwordHash: string
  plan: PlanId
  bkashAccount: string | null
  paymentMethods: PaymentMethod[]
  apiKeys?: ApiKey[]
  dailyCreations: number
  creationsResetAt: number // epoch ms; counter resets when now passes this
  createdAt: number
}

export type PriceModel = 'per_use' | 'per_100' | 'subscription'

export interface Listing {
  id: string
  automationId: string
  sellerId: string
  title: string
  description: string
  priceModel: PriceModel
  priceBdt: number
  createdAt: number
  active: boolean
  sales: number
}

export type TxnType = 'subscription' | 'api_creation' | 'marketplace_purchase' | 'payout'

export interface Transaction {
  id: string
  userId: string
  type: TxnType
  amountBdt: number
  platformFeeBdt: number
  netBdt: number
  status: 'pending' | 'completed' | 'failed'
  ref: string | null
  meta: Record<string, unknown>
  createdAt: number
}

/** Masked API key — safe to return to the client (no full secret). */
export interface PublicApiKey {
  id: string
  label: string
  masked: string // e.g. "mk_live_1a2b…f9c0"
  createdAt: number
  lastUsedAt: number | null
}

/** Public shape of a user — never leaks the password hash. */
export interface PublicUser {
  id: string
  email: string
  plan: PlanId
  bkashAccount: string | null
  paymentMethods: PaymentMethod[]
  apiKeys: PublicApiKey[]
  dailyCreations: number
  createdAt: number
}
