import { describe, expect, it, vi } from 'vitest'
import { createAdminGateway, ADMIN_RPCS } from './gateway'
import { mapAdminSubscriptionPage } from './subscriptions'
import { subscriptionRow, subscriptionResponse } from '../subscriptions/fixtures'

describe('Admin subscription read contract', () => {
  it('preserves zero-total evidence without fabricating paid revenue', () => {
    expect(mapAdminSubscriptionPage(subscriptionResponse()).items[0]).toMatchObject({
      zeroTotalCheckout: true,
      recordedPaidInvoices: 0,
      checkoutListAmountMinor: 100,
      sourceName: 'TikTok',
      sub1: 'profile',
    })
  })
  it('handles bare and named SQL responses', () => {
    const value = subscriptionResponse()
    expect(mapAdminSubscriptionPage([{ get_admin_subscriptions: value }])).toEqual(
      mapAdminSubscriptionPage(value),
    )
  })
  it.each(['total', 'generated_at', 'stripe_work_pending', 'summary', 'items'])(
    'rejects missing %s',
    (key) => {
      const v: Record<string, unknown> = subscriptionResponse()
      delete v[key]
      expect(() => mapAdminSubscriptionPage(v)).toThrow()
    },
  )
  it.each([
    'recorded_paid_invoices',
    'zero_total_checkout',
    'period_end',
    'checkout_list_amount_minor',
    'evidence_at',
  ])('rejects omitted row field %s', (key) => {
    const v = subscriptionResponse()
    delete (v.items[0] as Record<string, unknown>)[key]
    expect(() => mapAdminSubscriptionPage(v)).toThrow()
  })
  it('rejects bad status, ID, currency, count, duplicate and inconsistent totals', () => {
    for (const patch of [
      { status: 'paused' },
      { id: 'x' },
      { stripe_subscription_id: 'javascript:bad' },
      { currency: 'usd' },
      { recorded_paid_invoices: Number.MAX_SAFE_INTEGER + 1 },
      { period_end: subscriptionRow.period_start },
    ]) {
      const v = subscriptionResponse()
      Object.assign(v.items[0], patch)
      expect(() => mapAdminSubscriptionPage(v)).toThrow()
    }
    expect(() => mapAdminSubscriptionPage({ ...subscriptionResponse(), total: 2 })).toThrow()
    expect(() =>
      mapAdminSubscriptionPage({
        ...subscriptionResponse(),
        total: 2,
        summary: { active: 2, trialing: 0, payment_attention: 0, cancelled: 0 },
        items: [subscriptionRow, subscriptionRow],
      }),
    ).toThrow()
  })
  it('accepts explicit nullable fields and does not turn absent evidence into payment proof', () => {
    const v = subscriptionResponse()
    Object.assign(v.items[0], {
      evidence_at: null,
      period_start: null,
      period_end: null,
      checkout_list_amount_minor: null,
      zero_total_checkout: false,
    })
    expect(mapAdminSubscriptionPage(v).items[0]).toMatchObject({
      evidenceAt: null,
      periodEnd: null,
      checkoutListAmountMinor: null,
      zeroTotalCheckout: false,
    })
  })
  it('sends only bounded read filters, never Stripe calls or table reads', async () => {
    const rpc = vi.fn(async () => ({ data: subscriptionResponse(), error: null }))
    const gateway = createAdminGateway({ rpc })
    expect(
      (await gateway.getSubscriptions!({ query: ' TikTok ', status: 'active', offset: 25 })).status,
    ).toBe('ready')
    expect(rpc).toHaveBeenCalledExactlyOnceWith(ADMIN_RPCS.subscriptions, {
      p_query: 'TikTok',
      p_status: 'active',
      p_product_id: null,
      p_limit: 25,
      p_offset: 25,
      p_sort: 'newest',
    })
  })
  it('fails closed without configuration, permission or valid response', async () => {
    expect((await createAdminGateway(null).getSubscriptions!({})).status).toBe('unconfigured')
    const rpc = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'restricted' } }))
    expect((await createAdminGateway({ rpc }).getSubscriptions!({})).status).toBe('unauthorized')
    expect(
      (
        await createAdminGateway({ rpc: async () => ({ data: {}, error: null }) })
          .getSubscriptions!({})
      ).error?.code,
    ).toBe('invalid_response')
    expect(
      (
        await createAdminGateway({
          rpc: async () => {
            throw Error('offline')
          },
        }).getSubscriptions!({})
      ).status,
    ).toBe('error')
  })
})
