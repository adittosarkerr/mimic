export type PlanId = 'fledgling' | 'songbird' | 'mockingbird' | 'lyrebird'

export interface Plan {
  id: PlanId
  name: string
  tagline: string
  priceBdt: number | null // null = custom / free handled by 0
  dailyCreations: number // Infinity for unlimited
  marketplaceSeller: boolean
  platformFeeDiscount: boolean
  perks: string[]
}

/**
 * Bird-themed tiers — mimics are the great mimic birds. Limits follow the PRD
 * (5 / 30 / unlimited daily API-creation attempts; enterprise custom).
 */
export const PLANS: Record<PlanId, Plan> = {
  fledgling: {
    id: 'fledgling',
    name: 'Fledgling',
    tagline: 'Leave the nest — try it free',
    priceBdt: 0,
    dailyCreations: 5,
    marketplaceSeller: false,
    platformFeeDiscount: false,
    perks: ['5 automation builds per day', 'Unlimited runs on saved automations', 'Community support'],
  },
  songbird: {
    id: 'songbird',
    name: 'Songbird',
    tagline: 'Find your voice',
    priceBdt: 1500,
    dailyCreations: 30,
    marketplaceSeller: false,
    platformFeeDiscount: false,
    perks: ['30 automation builds per day', 'Unlimited runs', 'Priority support'],
  },
  mockingbird: {
    id: 'mockingbird',
    name: 'Mockingbird',
    tagline: 'Mimic anything, sell everything',
    priceBdt: 3500,
    dailyCreations: Infinity,
    marketplaceSeller: true,
    platformFeeDiscount: true,
    perks: [
      'Unlimited automation builds',
      'Unlimited runs',
      'Marketplace seller access (lower fees)',
      'Early access to new features',
    ],
  },
  lyrebird: {
    id: 'lyrebird',
    name: 'Lyrebird',
    tagline: 'The ultimate mimic — for teams',
    priceBdt: null,
    dailyCreations: Infinity,
    marketplaceSeller: true,
    platformFeeDiscount: true,
    perks: ['Everything in Mockingbird', 'Team accounts', 'Dedicated support', 'Custom billing'],
  },
}

export const DEFAULT_PLAN: PlanId = 'fledgling'

/**
 * Dynamic marketplace platform fee — bigger orders keep a larger share for the
 * seller (PRD tiers). Mockingbird/Lyrebird sellers get a small extra discount.
 */
export function platformFeePct(orderBdt: number, discount = false): number {
  let base: number
  if (orderBdt < 500) base = 20
  else if (orderBdt < 2000) base = 15
  else if (orderBdt < 10000) base = 10
  else base = 7
  return discount ? Math.max(base - 2, 5) : base
}
