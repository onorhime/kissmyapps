import { describe, expect, it } from 'vitest'
import { readRevenueSetup } from './api'
import { attributionRevenueBackendFixture as backend } from './attribution-revenue-backend.fixture'
import { checkRevenueEvents, skipReason } from './roi'

const copy = (value: unknown) => structuredClone(value)
// Times change on every run of the database suite, so only their form is checked.
const MOMENT = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/)

// The Settings revenue card and the Track revenue step against what the database really returns.
describe('revenue setup readers and the real backend answers', () => {
  it('reads the payment events, each with its amount and currency', () => {
    const setup = readRevenueSetup(copy(backend.revenue_setup))
    expect(setup.currency).toBe('USD')
    expect(setup.events).toEqual([
      {
        event: 'order_paid',
        amount_property: 'value',
        unit: 'major',
        currency_property: 'currency',
        currency: null,
      },
      {
        event: 'coins_bought',
        amount_property: 'price_cents',
        unit: 'minor',
        currency_property: null,
        currency: 'USD',
      },
    ])
    // What the database answers can be saved again as it is.
    expect(checkRevenueEvents(setup.events).size).toBe(0)
  })

  it('reads the last 7 days, where payments came from, and what was not counted', () => {
    const setup = readRevenueSetup(copy(backend.revenue_setup))
    expect(setup.last_7d).toEqual({
      payments: 4,
      refunds: 1,
      payers: 3,
      revenue: 34.38,
      unconverted: 1,
    })
    expect(setup.by_origin).toEqual([
      { origin: 'event', payments: 3 },
      { origin: 'store', payments: 1 },
    ])
    expect(setup.skipped_7d).toEqual([
      { reason: 'bad_amount', events: 2 },
      { reason: 'no_currency', events: 1 },
    ])
    for (const item of setup.skipped_7d)
      expect(skipReason(item.reason)).not.toBe('could not be read')
    expect(setup.last_received_at).toEqual(MOMENT)
    expect(setup.last_development_at).toEqual(MOMENT)
    expect(setup.rates_day).toBe('2026-11-06')
  })

  it('reads both store tools, with the one this project connected', () => {
    const setup = readRevenueSetup(copy(backend.revenue_setup))
    expect(setup.stores).toEqual([
      { provider: 'revenuecat', connected: true },
      { provider: 'adapty', connected: false },
    ])
  })

  it('reads a project with no payments yet', () => {
    expect(readRevenueSetup(copy(backend.revenue_setup_empty))).toEqual({
      currency: 'USD',
      events: [],
      stores: [
        { provider: 'revenuecat', connected: false },
        { provider: 'adapty', connected: false },
      ],
      last_7d: { payments: 0, refunds: 0, payers: 0, revenue: 0, unconverted: 0 },
      last_received_at: null,
      last_development_at: null,
      by_origin: [],
      skipped_7d: [],
      rates_day: '2026-11-03',
    })
  })
})
