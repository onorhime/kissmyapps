// Hand-made answers for attribution_roi and attribution_cohorts in the shapes the database
// returns, for a busier project than the database suite builds: five sources, every day of the
// range with people and spend, and twelve weeks of cohorts. The real answers are in
// attribution-roi-backend.fixture.ts and attribution.roi.backend.test.ts checks the readers
// against them. Cell states follow the same rule: a day is partial once it has begun for some of
// the group, and future while it has begun for nobody. The project is in Africa/Lagos, today is
// 2026-11-13 and the 30-day range starts on 2026-10-15.

const TODAY = '2026-11-13'

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const ratio = (top: number, bottom: number, places = 4) =>
  bottom > 0 ? round(top / bottom, places) : null

/** The metrics block M, with the ratios worked out from the counts and amounts. */
function metrics(m: {
  users: number
  installs: number
  cost: number
  payers: number
  revenue: number
  d0: number
  d7: number
  d30: number
}) {
  return {
    users: m.users,
    installs: m.installs,
    cost: m.cost,
    payers: m.payers,
    revenue: m.revenue,
    revenue_d0: m.d0,
    revenue_d7: m.d7,
    revenue_d30: m.d30,
    cpi: m.cost > 0 ? ratio(m.cost, m.installs, 2) : null,
    cost_per_user: m.cost > 0 ? ratio(m.cost, m.users, 2) : null,
    cost_per_payer: m.cost > 0 ? ratio(m.cost, m.payers, 2) : null,
    arpu: ratio(m.revenue, m.users, 2),
    roas: ratio(m.revenue, m.cost),
    roas_d0: ratio(m.d0, m.cost),
    roas_d7: ratio(m.d7, m.cost),
    roas_d30: ratio(m.d30, m.cost),
  }
}

const meta = {
  users: 520,
  installs: 410,
  cost: 2600,
  payers: 48,
  revenue: 3380.5,
  d0: 820,
  d7: 2110.4,
  d30: 3380.5,
}
const tiktok = {
  users: 310,
  installs: 240,
  cost: 1300,
  payers: 21,
  revenue: 980.4,
  d0: 260,
  d7: 640.2,
  d30: 980.4,
}
const influencer = {
  users: 90,
  installs: 60,
  cost: 310.5,
  payers: 9,
  revenue: 420,
  d0: 95,
  d7: 300,
  d30: 420,
}
const googleAds = { users: 0, installs: 0, cost: 120, payers: 0, revenue: 0, d0: 0, d7: 0, d30: 0 }
const organic = {
  users: 320,
  installs: 150,
  cost: 0,
  payers: 18,
  revenue: 339.5,
  d0: 120,
  d7: 250,
  d30: 339.5,
}
const sum = (...rows: Array<typeof meta>) =>
  rows.reduce((total, row) => ({
    users: total.users + row.users,
    installs: total.installs + row.installs,
    cost: round(total.cost + row.cost),
    payers: total.payers + row.payers,
    revenue: round(total.revenue + row.revenue),
    d0: round(total.d0 + row.d0),
    d7: round(total.d7 + row.d7),
    d30: round(total.d30 + row.d30),
  }))

const roiBase = {
  currency: 'USD',
  range: '30d',
  from: '2026-10-15',
  to: TODAY,
  timezone: 'Africa/Lagos',
}

const spring = {
  users: 300,
  installs: 240,
  cost: 1700,
  payers: 30,
  revenue: 2210,
  d0: 540,
  d7: 1380.4,
  d30: 2210,
}
const retargeting = {
  users: 150,
  installs: 120,
  cost: 900,
  payers: 14,
  revenue: 980.5,
  d0: 230,
  d7: 610,
  d30: 980.5,
}
const metaNoCampaign = {
  users: 70,
  installs: 50,
  cost: 0,
  payers: 4,
  revenue: 190,
  d0: 50,
  d7: 120,
  d30: 190,
}

/** One row a day over the range: people by the day they arrived, spend by the day it was spent. */
function dayRows() {
  return Array.from({ length: 30 }, (_, index) => {
    const day = addDays('2026-10-15', index)
    const users = 30 + ((index * 7) % 23)
    const cost = index === 29 ? 64 : round(120 + ((index * 37) % 60) + (index % 7 === 5 ? 40 : 0))
    // Older days have had longer to pay.
    const age = 29 - index
    const revenue = round(users * (1.1 + Math.min(age, 30) * 0.16))
    const d0 = round(users * 1.1)
    return {
      key: day,
      ...metrics({
        users,
        installs: Math.round(users * 0.7),
        cost,
        payers: Math.round(users * 0.08),
        revenue,
        d0,
        d7: age >= 7 ? round(users * (1.1 + 7 * 0.16)) : revenue,
        d30: revenue,
      }),
    }
  })
}

const days = dayRows()
const dayTotals = days.reduce(
  (total, row) => ({
    users: total.users + row.users,
    installs: total.installs + row.installs,
    cost: round(total.cost + row.cost),
    payers: total.payers + row.payers,
    revenue: round(total.revenue + row.revenue),
    d0: round(total.d0 + row.revenue_d0),
    d7: round(total.d7 + row.revenue_d7),
    d30: round(total.d30 + row.revenue_d30),
  }),
  { users: 0, installs: 0, cost: 0, payers: 0, revenue: 0, d0: 0, d7: 0, d30: 0 },
)

const COHORT_DAYS = [0, 1, 3, 7, 14, 30, 60, 90]

/** A cohort's cells: complete once every person has finished day N, partial while some are on it. */
function cohortCells(users: number, cost: number, age: { first: number; last: number }) {
  return COHORT_DAYS.map((day) => {
    const state = age.last > day ? 'complete' : age.first >= day ? 'partial' : 'future'
    if (state === 'future')
      return {
        day,
        state,
        complete_users: 0,
        revenue: 0,
        revenue_per_user: users ? 0 : null,
        roas: cost > 0 ? 0 : null,
        returned: 0,
        retention: null,
      }
    const revenue = round(users * (0.9 + Math.sqrt(day) * 0.85))
    const completeUsers = state === 'complete' ? users : Math.round(users / 2)
    const returned = day === 0 ? users : Math.round(completeUsers * (0.46 / Math.sqrt(day + 1)))
    return {
      day,
      state,
      complete_users: completeUsers,
      revenue,
      revenue_per_user: ratio(revenue, users),
      roas: ratio(revenue, cost),
      returned,
      retention: ratio(returned, completeUsers),
    }
  })
}

function curve(totalUsers: number) {
  return Array.from({ length: 31 }, (_, day) => {
    const users = Math.max(0, totalUsers - day * Math.round(totalUsers / 31))
    return {
      day,
      users,
      revenue_per_user: users ? round(0.9 + Math.sqrt(day) * 0.85, 4) : null,
      retention: users ? (day === 0 ? 1 : round(0.46 / Math.sqrt(day + 1), 4)) : null,
    }
  })
}

const dailyCohorts = Array.from({ length: 30 }, (_, index) => {
  const start = addDays(TODAY, -index)
  const users = index === 22 ? 0 : 18 + ((index * 11) % 29)
  const cost = index % 9 === 4 ? 0 : round(60 + ((index * 13) % 50))
  return { start, users, cost, cells: cohortCells(users, cost, { first: index, last: index }) }
})

// Weeks start on Monday; this week began on 2026-11-09, four days before today.
const weeklyCohorts = Array.from({ length: 12 }, (_, index) => {
  const start = addDays('2026-11-09', -7 * index)
  const users = 140 + ((index * 53) % 120)
  const cost = round(480 + ((index * 71) % 300))
  return {
    start,
    users,
    cost,
    cells: cohortCells(users, cost, { first: 4 + 7 * index, last: 7 * index - 2 }),
  }
})

const emptyCells = COHORT_DAYS.map((day) => ({
  day,
  state: day === 0 ? 'partial' : 'future',
  complete_users: 0,
  revenue: 0,
  revenue_per_user: null,
  roas: null,
  returned: 0,
  retention: null,
}))

const sumUsers = (rows: Array<{ users: number }>) =>
  rows.reduce((total, row) => total + row.users, 0)
const sumCost = (rows: Array<{ cost: number }>) =>
  round(rows.reduce((total, row) => total + row.cost, 0))

export const attributionRoiFixture: Record<string, unknown> = {
  roi_sources: {
    ...roiBase,
    group: 'source',
    filters: {},
    complete: { d0: false, d7: false, d30: false },
    totals: metrics(sum(meta, tiktok, influencer, googleAds, organic)),
    rows: [
      { key: 'meta', ...metrics(meta) },
      { key: 'tiktok', ...metrics(tiktok) },
      { key: 'influencer', ...metrics(influencer) },
      { key: 'google_ads', ...metrics(googleAds) },
      { key: null, ...metrics(organic) },
    ],
    unconverted: { revenue: 0, cost: 1, currencies: ['NGN'] },
    has_costs: true,
    has_revenue: true,
  },
  roi_campaigns: {
    ...roiBase,
    group: 'campaign',
    filters: { source: 'meta' },
    complete: { d0: false, d7: false, d30: false },
    totals: metrics(meta),
    rows: [
      { key: 'spring_sale', ...metrics(spring) },
      { key: 'retargeting', ...metrics(retargeting) },
      { key: null, ...metrics(metaNoCampaign) },
    ],
    unconverted: { revenue: 0, cost: 0, currencies: [] },
    has_costs: true,
    has_revenue: true,
  },
  roi_days: {
    ...roiBase,
    group: 'day',
    filters: {},
    complete: { d0: false, d7: false, d30: false },
    totals: metrics(dayTotals),
    rows: days,
    unconverted: { revenue: 0, cost: 1, currencies: ['NGN'] },
    has_costs: true,
    has_revenue: true,
  },
  roi_empty: {
    ...roiBase,
    group: 'source',
    filters: {},
    complete: { d0: true, d7: true, d30: true },
    totals: metrics({
      users: 0,
      installs: 0,
      cost: 0,
      payers: 0,
      revenue: 0,
      d0: 0,
      d7: 0,
      d30: 0,
    }),
    rows: [],
    unconverted: { revenue: 0, cost: 0, currencies: [] },
    has_costs: false,
    has_revenue: false,
  },
  cohorts_day: {
    currency: 'USD',
    interval: 'day',
    timezone: 'Africa/Lagos',
    today: TODAY,
    filters: {},
    days: COHORT_DAYS,
    cohorts: dailyCohorts,
    curve: curve(sumUsers(dailyCohorts)),
    totals: {
      users: sumUsers(dailyCohorts),
      cost: sumCost(dailyCohorts),
      revenue: 3120.75,
      payers: 61,
    },
    unconverted: { revenue: 0, cost: 0, currencies: [] },
  },
  cohorts_week: {
    currency: 'USD',
    interval: 'week',
    timezone: 'Africa/Lagos',
    today: TODAY,
    filters: { source: 'meta' },
    days: COHORT_DAYS,
    cohorts: weeklyCohorts,
    curve: curve(sumUsers(weeklyCohorts)),
    totals: {
      users: sumUsers(weeklyCohorts),
      cost: sumCost(weeklyCohorts),
      revenue: 9840.2,
      payers: 182,
    },
    unconverted: { revenue: 2, cost: 0, currencies: ['NGN'] },
  },
  cohorts_empty: {
    currency: 'USD',
    interval: 'day',
    timezone: 'Africa/Lagos',
    today: TODAY,
    filters: {},
    days: COHORT_DAYS,
    cohorts: Array.from({ length: 30 }, (_, index) => ({
      start: addDays(TODAY, -index),
      users: 0,
      cost: 0,
      cells: emptyCells,
    })),
    curve: curve(0),
    totals: { users: 0, cost: 0, revenue: 0, payers: 0 },
    unconverted: { revenue: 0, cost: 0, currencies: [] },
  },
}
