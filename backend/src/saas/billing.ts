import { randomBytes } from 'node:crypto'
import type { User } from './types.js'
import { PLANS } from './plans.js'

/** Master switch: when false, nothing is charged and all quotas pass. Lets the
 * product be built and tested end-to-end without real payments getting in the
 * way. Flip BILLING_ENABLED=true in .env to enforce charges + limits. */
export const BILLING_ENABLED = process.env.BILLING_ENABLED === 'true'

export interface ChargeRequest {
  amountBdt: number
  description: string
  payerRef?: string // e.g. bKash number
}

export interface ChargeResult {
  ok: boolean
  ref: string
  provider: string
  note: string
}

/** A payment provider. bKash is the first; card/bank can be added as siblings. */
export interface PaymentProvider {
  readonly name: string
  charge(req: ChargeRequest): Promise<ChargeResult>
  payout(req: ChargeRequest): Promise<ChargeResult>
}

/**
 * bKash provider. Real integration targets bKash's sandbox tokenized checkout;
 * this stub returns a simulated success so flows work end-to-end. Wire the real
 * API here when going live — the interface above stays the same.
 */
class BkashProvider implements PaymentProvider {
  readonly name = 'bkash'
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (!BILLING_ENABLED) {
      return { ok: true, ref: 'DEV-BYPASS', provider: this.name, note: 'billing disabled (dev mode)' }
    }
    // TODO(real): call bKash sandbox create+execute payment with a merchant grant token.
    const ref = 'BKASH-' + randomBytes(6).toString('hex').toUpperCase()
    return { ok: true, ref, provider: this.name, note: `simulated bKash charge for ${req.amountBdt} BDT` }
  }
  async payout(req: ChargeRequest): Promise<ChargeResult> {
    if (!BILLING_ENABLED) {
      return { ok: true, ref: 'DEV-BYPASS', provider: this.name, note: 'billing disabled (dev mode)' }
    }
    const ref = 'PAYOUT-' + randomBytes(6).toString('hex').toUpperCase()
    return { ok: true, ref, provider: this.name, note: `simulated payout of ${req.amountBdt} BDT` }
  }
}

export const bkash: PaymentProvider = new BkashProvider()

/** Resolve today's remaining daily creation attempts, resetting the counter if
 * the 24h window has rolled over. Mutates the passed user's counters. */
export function refreshDailyQuota(user: User): void {
  const now = Date.now()
  if (now >= user.creationsResetAt) {
    user.dailyCreations = 0
    user.creationsResetAt = now + 24 * 60 * 60 * 1000
  }
}

export interface QuotaCheck {
  allowed: boolean
  reason: string | null
  remaining: number
}

/** Can this user create another automation today? Always allowed when billing is
 * off, so testing is never blocked. */
export function checkCreationQuota(user: User): QuotaCheck {
  refreshDailyQuota(user)
  const limit = PLANS[user.plan].dailyCreations
  const remaining = limit === Infinity ? Infinity : Math.max(0, limit - user.dailyCreations)
  if (!BILLING_ENABLED) return { allowed: true, reason: null, remaining }
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `Daily build limit reached for the ${PLANS[user.plan].name} plan. Upgrade for more.`,
      remaining: 0,
    }
  }
  return { allowed: true, reason: null, remaining }
}
