/**
 * Answers of `partner_program_performance` for programs that pay for events, written by hand to
 * the shape in the Phase 6 contract (Piece 3, item 3): every count row gains `events`, a program
 * gains `earn_from`, a latest row gains `kind` and `reward_label`, and the answer gains
 * `rewards` and `budget_reached`. One creator in three programs: Fluent pays for events, Loop
 * Habits for sales and events, SpeakSix for sales. To be joined by output captured from the
 * database, so nothing here should be read as what the database really sends beyond the shape.
 */
import { performanceFixture } from './performance.fixture'

const DAY_MS = 86_400_000
const STARTS_ON = '2026-10-14'
const ENDS_ON = '2026-11-12'

const fluent = {
  program_id: '5a1e0000-0000-4000-8000-000000000004',
  slug: 'fluent',
  name: 'Fluent',
  currency: 'USD',
  earn_from: 'events',
}
const loopHabits = {
  program_id: '5a1e0000-0000-4000-8000-000000000002',
  slug: 'loop-habits',
  name: 'Loop Habits',
  currency: 'USD',
  earn_from: 'both',
}
const speaksix = {
  program_id: '5a1e0000-0000-4000-8000-000000000003',
  slug: 'speaksix',
  name: 'SpeakSix',
  currency: 'USD',
  earn_from: 'sales',
}
const programs = [fluent, loopHabits, speaksix]

type Counts = { clicks: number; sales: number; events: number; earnings_minor: number }

const sum = (rows: readonly Counts[]): Counts =>
  rows.reduce(
    (total, row) => ({
      clicks: total.clicks + row.clicks,
      sales: total.sales + row.sales,
      events: total.events + row.events,
      earnings_minor: total.earnings_minor + row.earnings_minor,
    }),
    { clicks: 0, sales: 0, events: 0, earnings_minor: 0 },
  )

const total = (numbers: readonly number[]) => numbers.reduce((all, number) => all + number, 0)

/** One row per day from 14 October 2026, oldest first. */
function daily(rows: readonly Counts[]) {
  const first = Date.parse(`${STARTS_ON}T00:00:00Z`)
  return rows.map((row, index) => ({
    day: new Date(first + index * DAY_MS).toISOString().slice(0, 10),
    ...row,
  }))
}

const LINKS = [
  { kind: 'main', channel: null, name: 'Main link' },
  { kind: 'channel', channel: 'tiktok', name: 'TikTok' },
  { kind: 'channel', channel: 'instagram', name: 'Instagram' },
  { kind: 'channel', channel: 'youtube', name: 'YouTube' },
  { kind: 'channel', channel: 'facebook', name: 'Facebook' },
  { kind: 'channel', channel: 'x', name: 'X' },
  { kind: 'channel', channel: 'newsletter', name: 'Newsletter' },
]

/**
 * A member's links in the order of the Links page. TikTok, the second, is given what is left of
 * the totals once the others have theirs, so the channels always add up to the days.
 */
function channels(program: number, totals: Counts, others: Record<string, Counts>) {
  const given = sum(Object.values(others))
  const rest: Counts = {
    clicks: totals.clicks - given.clicks,
    sales: totals.sales - given.sales,
    events: totals.events - given.events,
    earnings_minor: totals.earnings_minor - given.earnings_minor,
  }
  const nothing: Counts = { clicks: 0, sales: 0, events: 0, earnings_minor: 0 }
  return LINKS.map((link, index) => ({
    link_id: `5a1e0000-0000-4000-8000-00000000${program}0${String(index + 1).padStart(2, '0')}`,
    ...link,
    ...(link.name === 'TikTok' ? rest : (others[link.name] ?? nothing)),
  }))
}

// Fluent: a web funnel with no payment. An account created earns $2.00, a trial started $5.00.
const SIGNUP_MINOR = 200
const TRIAL_MINOR = 500
const FLUENT_CLICKS = [
  38, 44, 52, 47, 61, 83, 76, 49, 45, 58, 63, 66, 91, 88, 52, 48, 57, 62, 69, 97, 92, 60, 55, 63,
  70, 74, 104, 99, 66, 41,
]
const FLUENT_SIGNUPS = [
  2, 3, 4, 3, 4, 6, 5, 3, 3, 4, 5, 5, 7, 6, 4, 3, 4, 4, 5, 7, 7, 4, 4, 5, 5, 5, 8, 7, 5, 3,
]
const FLUENT_TRIALS = [
  0, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 1, 1, 2, 1, 2, 3, 2, 1, 1,
]

const fluentDays = FLUENT_CLICKS.map((clicks, index): Counts => ({
  clicks,
  sales: 0,
  events: FLUENT_SIGNUPS[index] + FLUENT_TRIALS[index],
  earnings_minor: FLUENT_SIGNUPS[index] * SIGNUP_MINOR + FLUENT_TRIALS[index] * TRIAL_MINOR,
}))
const fluentTotals = sum(fluentDays)

const fluentRewards = [
  {
    key: 'signup_completed',
    label: 'Account created',
    amount_minor: SIGNUP_MINOR,
    count: total(FLUENT_SIGNUPS),
    earnings_minor: total(FLUENT_SIGNUPS) * SIGNUP_MINOR,
  },
  {
    key: 'trial_started',
    label: 'Trial started',
    amount_minor: TRIAL_MINOR,
    count: total(FLUENT_TRIALS),
    earnings_minor: total(FLUENT_TRIALS) * TRIAL_MINOR,
  },
]

const events_days30 = {
  days: 30,
  timezone: 'Europe/London',
  starts_on: STARTS_ON,
  ends_on: ENDS_ON,
  programs,
  program: fluent,
  totals: fluentTotals,
  previous: { clicks: 1604, sales: 0, events: 131, earnings_minor: 37900 },
  daily: daily(fluentDays),
  channels: channels(4, fluentTotals, {
    'Main link': { clicks: 74, sales: 0, events: 2, earnings_minor: 400 },
    Instagram: { clicks: 512, sales: 0, events: 41, earnings_minor: 11800 },
    YouTube: { clicks: 236, sales: 0, events: 22, earnings_minor: 7100 },
    Newsletter: { clicks: 88, sales: 0, events: 12, earnings_minor: 3900 },
  }),
  money: {
    pending_minor: 31200,
    approved_minor: 18600,
    paying_minor: 0,
    paid_minor: 22400,
    next_release_at: '2026-11-14T09:12:40.118204+00:00',
  },
  latest: [
    {
      paid_at: '2026-11-12T11:02:18.402117+00:00',
      link_name: 'TikTok',
      amount_minor: 500,
      status: 'held',
      kind: 'reward',
      reward_label: 'Trial started',
    },
    {
      paid_at: '2026-11-12T10:47:03.915560+00:00',
      link_name: 'TikTok',
      amount_minor: 200,
      status: 'held',
      kind: 'reward',
      reward_label: 'Account created',
    },
    {
      paid_at: '2026-11-11T18:30:55.208341+00:00',
      link_name: 'Instagram',
      amount_minor: 200,
      status: 'held',
      kind: 'reward',
      reward_label: 'Account created',
    },
    {
      paid_at: '2026-11-10T07:14:26.660912+00:00',
      link_name: null,
      amount_minor: 0,
      status: 'reversed',
      kind: 'reward',
      reward_label: 'Account created',
    },
    {
      paid_at: '2026-10-28T15:41:09.337025+00:00',
      link_name: 'Newsletter',
      amount_minor: 500,
      status: 'approved',
      kind: 'reward',
      reward_label: 'Trial started',
    },
  ],
  rewards: fluentRewards,
  budget_reached: false,
}

// Loop Habits: a sale earns $9.00 in commission and an account created earns $1.50.
const SALE_MINOR = 900
const ACCOUNT_MINOR = 150
const LOOP_CLICKS = [
  21, 26, 30, 24, 33, 47, 41, 27, 25, 31, 36, 38, 52, 49, 28, 26, 33, 35, 40, 58, 54, 34, 30, 37,
  41, 44, 63, 59, 38, 22,
]
const LOOP_ACCOUNTS = [
  2, 2, 3, 2, 3, 4, 4, 2, 2, 3, 3, 3, 5, 4, 2, 2, 3, 3, 4, 5, 5, 3, 3, 3, 4, 4, 6, 5, 3, 2,
]
const LOOP_SALES = [
  0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 2, 0, 1, 0, 1, 1, 2, 1, 1, 0,
]

const loopDays = LOOP_CLICKS.map((clicks, index): Counts => ({
  clicks,
  sales: LOOP_SALES[index],
  events: LOOP_ACCOUNTS[index],
  earnings_minor: LOOP_SALES[index] * SALE_MINOR + LOOP_ACCOUNTS[index] * ACCOUNT_MINOR,
}))
const loopTotals = sum(loopDays)

const both_days30 = {
  days: 30,
  timezone: 'Europe/London',
  starts_on: STARTS_ON,
  ends_on: ENDS_ON,
  programs,
  program: loopHabits,
  totals: loopTotals,
  previous: { clicks: 968, sales: 16, events: 84, earnings_minor: 27000 },
  daily: daily(loopDays),
  channels: channels(2, loopTotals, {
    'Main link': { clicks: 41, sales: 0, events: 3, earnings_minor: 450 },
    Instagram: { clicks: 318, sales: 6, events: 29, earnings_minor: 9750 },
    YouTube: { clicks: 127, sales: 3, events: 11, earnings_minor: 4350 },
    X: { clicks: 36, sales: 0, events: 0, earnings_minor: 0 },
  }),
  money: {
    pending_minor: 24150,
    approved_minor: 12300,
    paying_minor: 4500,
    paid_minor: 18750,
    next_release_at: '2026-11-15T13:26:51.774038+00:00',
  },
  latest: [
    {
      paid_at: '2026-11-12T09:58:14.250771+00:00',
      link_name: 'TikTok',
      amount_minor: 900,
      status: 'held',
      kind: 'sale',
      reward_label: null,
    },
    {
      paid_at: '2026-11-12T09:31:40.006318+00:00',
      link_name: 'TikTok',
      amount_minor: 150,
      status: 'held',
      kind: 'reward',
      reward_label: 'Account created',
    },
    {
      paid_at: '2026-11-11T21:05:27.481906+00:00',
      link_name: 'Instagram',
      amount_minor: 150,
      status: 'held',
      kind: 'reward',
      reward_label: 'Account created',
    },
    {
      paid_at: '2026-11-09T12:44:02.903355+00:00',
      link_name: 'YouTube',
      amount_minor: 0,
      status: 'reversed',
      kind: 'sale',
      reward_label: null,
    },
    {
      paid_at: '2026-10-30T08:19:36.115720+00:00',
      link_name: 'Instagram',
      amount_minor: 150,
      status: 'approved',
      kind: 'reward',
      reward_label: 'Account created',
    },
  ],
  rewards: [
    {
      key: 'account_created',
      label: 'Account created',
      amount_minor: ACCOUNT_MINOR,
      count: total(LOOP_ACCOUNTS),
      earnings_minor: total(LOOP_ACCOUNTS) * ACCOUNT_MINOR,
    },
  ],
  budget_reached: false,
}

/** A program that pays for sales, as a Phase 6 database sends it: the new keys say nothing. */
function withNeutralKeys(answer: (typeof performanceFixture)['speaksix_30']) {
  const quiet = <T extends object>(row: T) => ({ ...row, events: 0 })
  return {
    ...answer,
    programs,
    program: speaksix,
    totals: quiet(answer.totals),
    previous: quiet(answer.previous),
    daily: answer.daily.map(quiet),
    channels: answer.channels.map(quiet),
    latest: answer.latest.map((sale) => ({ ...sale, kind: 'sale', reward_label: null })),
    rewards: [],
    budget_reached: false,
  }
}

/** A new member of a program that pays for events: every reward listed, nothing counted. */
const events_quiet = {
  ...events_days30,
  totals: { clicks: 0, sales: 0, events: 0, earnings_minor: 0 },
  previous: { clicks: 0, sales: 0, events: 0, earnings_minor: 0 },
  daily: daily(
    FLUENT_CLICKS.map((): Counts => ({ clicks: 0, sales: 0, events: 0, earnings_minor: 0 })),
  ),
  channels: channels(4, { clicks: 0, sales: 0, events: 0, earnings_minor: 0 }, {}),
  money: null,
  latest: [],
  rewards: fluentRewards.map((reward) => ({ ...reward, count: 0, earnings_minor: 0 })),
}

export const performanceEventsFixture = {
  /** A program that pays for events only. */
  events_days30,
  /** A program that pays a commission on sales and a reward for an event. */
  both_days30,
  /** The brand's budget for rewards is used up for this month. */
  budget_reached: { ...events_days30, budget_reached: true },
  /** Joined, and nothing has happened yet. */
  events_quiet,
  /** A program that pays for sales, with the keys every Phase 6 answer carries. */
  sales_program: withNeutralKeys(performanceFixture.speaksix_30),
  /** The same program as a database from before Phase 6 sends it, with the same picker. */
  sales_program_before: {
    ...performanceFixture.speaksix_30,
    programs: programs.map(({ earn_from: _earnFrom, ...program }) => program),
  },
}
