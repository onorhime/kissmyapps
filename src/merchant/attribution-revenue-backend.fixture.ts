// What the attribution Phase 3 revenue setup functions really return, captured from the database
// suite supabase/tests/database/93_attribution_revenue.sql (it prints one "capture" line per
// call). The revenue readers in api.ts, the Settings revenue card and the Track revenue step are
// tested against it, so a change of shape in the functions shows up as a failing front-end test
// instead of a broken page.
// To refresh: KMA_DB_TEST_OUTPUT=/tmp/out.txt PG_RUN_AS=postgres node --test
// scripts/merchant-analytics-db.test.mjs, then copy the JSON after each "capture <name>".
export const attributionRevenueBackendFixture: Record<string, unknown> = {
  revenue_setup_empty: {
    events: [],
    stores: [
      {
        provider: 'revenuecat',
        connected: false,
      },
      {
        provider: 'adapty',
        connected: false,
      },
    ],
    last_7d: {
      payers: 0,
      refunds: 0,
      revenue: 0,
      payments: 0,
      unconverted: 0,
    },
    currency: 'USD',
    by_origin: [],
    rates_day: '2026-11-03',
    skipped_7d: [],
    last_received_at: null,
    last_development_at: null,
  },
  revenue_setup: {
    events: [
      {
        unit: 'major',
        event: 'order_paid',
        currency: null,
        amount_property: 'value',
        currency_property: 'currency',
      },
      {
        unit: 'minor',
        event: 'coins_bought',
        currency: 'USD',
        amount_property: 'price_cents',
        currency_property: null,
      },
    ],
    stores: [
      {
        provider: 'revenuecat',
        connected: true,
      },
      {
        provider: 'adapty',
        connected: false,
      },
    ],
    last_7d: {
      payers: 3,
      refunds: 1,
      revenue: 34.38,
      payments: 4,
      unconverted: 1,
    },
    currency: 'USD',
    by_origin: [
      {
        origin: 'event',
        payments: 3,
      },
      {
        origin: 'store',
        payments: 1,
      },
    ],
    rates_day: '2026-11-06',
    skipped_7d: [
      {
        events: 2,
        reason: 'bad_amount',
      },
      {
        events: 1,
        reason: 'no_currency',
      },
    ],
    last_received_at: '2026-11-14T00:10:28.9414+00:00',
    last_development_at: '2026-11-14T00:10:28.9414+00:00',
  },
}
