import { singleAdminRow } from './mappers'

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'unpaid',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]
export const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  incomplete: 'Incomplete',
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  cancelled: 'Cancelled',
  unpaid: 'Unpaid',
}
export type SubscriptionFilters = {
  query?: string
  status?: SubscriptionStatus | ''
  productId?: string
  limit?: number
  offset?: number
  sort?: 'newest' | 'oldest'
}
export type AdminSubscription = {
  id: string
  stripeId: string
  accountId: string
  productId: string
  productName: string
  partnerName: string | null
  affiliateId: string | null
  acquisitionId: string | null
  status: SubscriptionStatus
  currency: string
  createdAt: string
  updatedAt: string
  periodStart: string | null
  periodEnd: string | null
  cancelledAt: string | null
  evidenceAt: string | null
  sourceName: string | null
  campaignName: string | null
  funnelName: string | null
  sub1: string | null
  sub2: string | null
  sub3: string | null
  offerName: string | null
  checkoutListAmountMinor: number | null
  zeroTotalCheckout: boolean
  recordedPaidInvoices: number
}
export type AdminSubscriptionPage = {
  generatedAt: string
  stripeWorkPending: boolean
  total: number
  summary: { active: number; trialing: number; paymentAttention: number; cancelled: number }
  items: AdminSubscription[]
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid subscription object')
  return v as Record<string, unknown>
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500) throw Error('Invalid subscription text')
  return v
}
function optional(v: unknown): string | null {
  return v === null ? null : text(v)
}
function id(v: unknown): string {
  const s = text(v)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s))
    throw Error('Invalid subscription ID')
  return s
}
function time(v: unknown): string {
  const s = text(v)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s)))
    throw Error('Invalid subscription time')
  return s
}
function nullableTime(v: unknown): string | null {
  return v === null ? null : time(v)
}
function count(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw Error('Invalid subscription count')
  return n
}
function flag(v: unknown): boolean {
  if (typeof v !== 'boolean') throw Error('Invalid subscription flag')
  return v
}
export function mapAdminSubscriptionPage(value: unknown): AdminSubscriptionPage {
  let r = object(singleAdminRow(value))
  if (Object.hasOwn(r, 'get_admin_subscriptions')) r = object(r.get_admin_subscriptions)
  const s = object(r.summary)
  const summary = {
    active: count(s.active),
    trialing: count(s.trialing),
    paymentAttention: count(s.payment_attention),
    cancelled: count(s.cancelled),
  }
  const total = count(r.total)
  if (
    Object.values(summary).reduce((a, b) => a + b, 0) !== total ||
    !Array.isArray(r.items) ||
    r.items.length > 100 ||
    r.items.length > total
  )
    throw Error('Inconsistent subscription page')
  const items = r.items.map((raw): AdminSubscription => {
    const v = object(raw)
    const status = text(v.status) as SubscriptionStatus
    const currency = text(v.currency)
    const stripeId = text(v.stripe_subscription_id)
    if (
      !SUBSCRIPTION_STATUSES.includes(status) ||
      !/^[A-Z]{3}$/.test(currency) ||
      !/^sub_[A-Za-z0-9_]{8,160}$/.test(stripeId)
    )
      throw Error('Invalid subscription state')
    const periodStart = nullableTime(v.period_start),
      periodEnd = nullableTime(v.period_end)
    if (periodStart && periodEnd && Date.parse(periodStart) >= Date.parse(periodEnd))
      throw Error('Invalid billing period')
    return {
      id: id(v.id),
      stripeId,
      accountId: id(v.account_id),
      productId: id(v.product_id),
      productName: text(v.product_name),
      partnerName: optional(v.partner_name),
      affiliateId: v.affiliate_id === null ? null : id(v.affiliate_id),
      acquisitionId: v.acquisition_id === null ? null : id(v.acquisition_id),
      status,
      currency,
      createdAt: time(v.created_at),
      updatedAt: time(v.updated_at),
      periodStart,
      periodEnd,
      cancelledAt: nullableTime(v.cancelled_at),
      evidenceAt: nullableTime(v.evidence_at),
      sourceName: optional(v.source_name),
      campaignName: optional(v.campaign_name),
      funnelName: optional(v.funnel_name),
      sub1: optional(v.sub1),
      sub2: optional(v.sub2),
      sub3: optional(v.sub3),
      offerName: optional(v.offer_name),
      checkoutListAmountMinor:
        v.checkout_list_amount_minor === null ? null : count(v.checkout_list_amount_minor),
      zeroTotalCheckout: flag(v.zero_total_checkout),
      recordedPaidInvoices: count(v.recorded_paid_invoices),
    }
  })
  if (new Set(items.map((v) => v.id)).size !== items.length) throw Error('Duplicate subscription')
  return {
    generatedAt: time(r.generated_at),
    stripeWorkPending: flag(r.stripe_work_pending),
    total,
    summary,
    items,
  }
}
