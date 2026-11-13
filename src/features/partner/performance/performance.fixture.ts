/**
 * Answers of `partner_program_performance`, written by hand to the shape in the Phase 5
 * contract. One creator in three programs (DramaPal, Loop Habits and SpeakSix, in the order the
 * database lists them: by name), and one creator in none. To be replaced by output captured
 * from the database, so nothing here should be read as what the database really sends beyond
 * the shape.
 */

const DAY_MS = 86_400_000

/** One row per day from `startsOn`, each sale worth `saleMinor` in commission. */
function daily(startsOn: string, clicks: number[], sales: number[], saleMinor: number) {
  const first = Date.parse(`${startsOn}T00:00:00Z`)
  return clicks.map((count, index) => ({
    day: new Date(first + index * DAY_MS).toISOString().slice(0, 10),
    clicks: count,
    sales: sales[index],
    earnings_minor: sales[index] * saleMinor,
  }))
}

const dramapal = {
  program_id: '5a1e0000-0000-4000-8000-000000000001',
  slug: 'dramapal',
  name: 'DramaPal',
  currency: 'EUR',
}
const loopHabits = {
  program_id: '5a1e0000-0000-4000-8000-000000000002',
  slug: 'loop-habits',
  name: 'Loop Habits',
  currency: 'USD',
}
const speaksix = {
  program_id: '5a1e0000-0000-4000-8000-000000000003',
  slug: 'speaksix',
  name: 'SpeakSix',
  currency: 'USD',
}
const programs = [dramapal, loopHabits, speaksix]

const link = (program: number, number: number) =>
  `5a1e0000-0000-4000-8000-00000000${program}0${String(number).padStart(2, '0')}`

/** A member's links in the order of the Links page, each with its numbers for the window. */
function channels(program: number, numbers: [clicks: number, sales: number, earnings: number][]) {
  const links = [
    { kind: 'main', channel: null, name: 'Main link' },
    { kind: 'channel', channel: 'tiktok', name: 'TikTok' },
    { kind: 'channel', channel: 'instagram', name: 'Instagram' },
    { kind: 'channel', channel: 'youtube', name: 'YouTube' },
    { kind: 'channel', channel: 'facebook', name: 'Facebook' },
    { kind: 'channel', channel: 'x', name: 'X' },
    { kind: 'channel', channel: 'newsletter', name: 'Newsletter' },
  ]
  return links.map((row, index) => ({
    link_id: link(program, index + 1),
    ...row,
    clicks: numbers[index][0],
    sales: numbers[index][1],
    earnings_minor: numbers[index][2],
  }))
}

// SpeakSix: 90 days of clicks and sales, oldest first. A sale earns $6.00.
const SPEAKSIX_CLICKS = [
  16, 24, 32, 22, 32, 53, 41, 30, 38, 33, 36, 33, 56, 57, 31, 39, 47, 36, 48, 72, 59, 45, 39, 48,
  51, 49, 75, 75, 45, 54, 69, 57, 71, 86, 85, 66, 60, 70, 72, 72, 104, 103, 66, 76, 71, 73, 88, 107,
  105, 82, 77, 87, 89, 89, 125, 107, 82, 93, 88, 88, 61, 58, 70, 65, 80, 112, 105, 70, 64, 77, 83,
  90, 130, 122, 84, 79, 88, 95, 102, 148, 139, 96, 91, 99, 108, 117, 160, 152, 105, 70,
]
const SPEAKSIX_SALES = [
  0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 2, 0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 2, 1, 2, 2, 2, 2,
  2, 2, 1, 2, 1, 2, 2, 3, 3, 1, 2, 1, 2, 2, 3, 3, 1, 2, 1, 2, 2, 3, 3, 1, 3, 1, 2, 1, 1, 1, 1, 2, 3,
  3, 1, 1, 2, 2, 2, 4, 3, 2, 2, 2, 2, 3, 4, 4, 2, 2, 2, 3, 3, 4, 4, 2, 2,
]

const speaksixMoney = {
  pending_minor: 42000,
  approved_minor: 31800,
  paying_minor: 0,
  paid_minor: 110400,
  next_release_at: '2026-11-13T10:21:07.412903+00:00',
}

const speaksixLatest = [
  {
    paid_at: '2026-11-12T10:41:09.120394+00:00',
    link_name: 'TikTok',
    amount_minor: 600,
    status: 'held',
  },
  {
    paid_at: '2026-11-12T08:03:51.771201+00:00',
    link_name: 'YouTube',
    amount_minor: 600,
    status: 'held',
  },
  {
    paid_at: '2026-11-11T19:27:30.004417+00:00',
    link_name: 'TikTok',
    amount_minor: 600,
    status: 'held',
  },
  {
    paid_at: '2026-11-11T12:15:44.980125+00:00',
    link_name: 'Instagram',
    amount_minor: 600,
    status: 'held',
  },
  {
    paid_at: '2026-11-10T16:58:02.336870+00:00',
    link_name: 'Newsletter',
    amount_minor: 600,
    status: 'held',
  },
]

/** SpeakSix has one custom link, added by the creator, which has brought nothing yet. */
const podcast = {
  link_id: link(3, 8),
  kind: 'custom',
  channel: null,
  name: 'Podcast',
  clicks: 0,
  sales: 0,
  earnings_minor: 0,
}

const speaksix_30 = {
  days: 30,
  timezone: 'Europe/London',
  starts_on: '2026-10-14',
  ends_on: '2026-11-12',
  programs,
  program: speaksix,
  totals: { clicks: 2920, sales: 70, earnings_minor: 42000 },
  previous: { clicks: 2508, sales: 59, earnings_minor: 35400 },
  daily: daily('2026-10-14', SPEAKSIX_CLICKS.slice(60), SPEAKSIX_SALES.slice(60), 600),
  channels: [
    ...channels(3, [
      [58, 0, 0],
      [1840, 46, 27600],
      [622, 11, 6600],
      [304, 9, 5400],
      [0, 0, 0],
      [0, 0, 0],
      [96, 4, 2400],
    ]),
    podcast,
  ],
  money: speaksixMoney,
  latest: speaksixLatest,
}

const speaksix_7 = {
  days: 7,
  timezone: 'Europe/London',
  starts_on: '2026-11-06',
  ends_on: '2026-11-12',
  programs,
  program: speaksix,
  totals: { clicks: 811, sales: 20, earnings_minor: 12000 },
  previous: { clicks: 759, sales: 19, earnings_minor: 11400 },
  daily: daily('2026-11-06', SPEAKSIX_CLICKS.slice(83), SPEAKSIX_SALES.slice(83), 600),
  channels: [
    ...channels(3, [
      [16, 0, 0],
      [512, 13, 7800],
      [170, 3, 1800],
      [86, 3, 1800],
      [0, 0, 0],
      [0, 0, 0],
      [27, 1, 600],
    ]),
    podcast,
  ],
  money: speaksixMoney,
  latest: speaksixLatest,
}

const speaksix_90 = {
  days: 90,
  timezone: 'Europe/London',
  starts_on: '2026-08-15',
  ends_on: '2026-11-12',
  programs,
  program: speaksix,
  totals: { clicks: 6744, sales: 157, earnings_minor: 94200 },
  previous: { clicks: 1420, sales: 22, earnings_minor: 13200 },
  daily: daily('2026-08-15', SPEAKSIX_CLICKS, SPEAKSIX_SALES, 600),
  channels: [
    ...channels(3, [
      [131, 0, 0],
      [4210, 101, 60600],
      [1433, 27, 16200],
      [716, 20, 12000],
      [12, 0, 0],
      [0, 0, 0],
      [242, 9, 5400],
    ]),
    podcast,
  ],
  money: speaksixMoney,
  latest: speaksixLatest,
}

// DramaPal: a smaller program paid in euros, with a long custom link name, a sale that came
// through no link, fewer sales than the 30 days before, and a commission that was given back.
const dramapal_30 = {
  days: 30,
  timezone: 'Europe/London',
  starts_on: '2026-10-14',
  ends_on: '2026-11-12',
  programs,
  program: dramapal,
  totals: { clicks: 270, sales: 4, earnings_minor: 5000 },
  previous: { clicks: 198, sales: 5, earnings_minor: 6250 },
  daily: daily(
    '2026-10-14',
    [
      2, 5, 8, 11, 14, 13, 7, 10, 13, 3, 6, 9, 21, 2, 5, 8, 11, 14, 4, 16, 10, 13, 3, 6, 9, 12, 11,
      5, 8, 11,
    ],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
    1250,
  ),
  channels: [
    ...channels(1, [
      [61, 1, 1250],
      [0, 0, 0],
      [121, 1, 1250],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [53, 1, 1250],
    ]),
    {
      link_id: link(1, 8),
      kind: 'custom',
      channel: null,
      name: 'Autumn giveaway with Lisbon’s book club',
      clicks: 35,
      sales: 0,
      earnings_minor: 0,
    },
    {
      link_id: null,
      kind: 'none',
      channel: null,
      name: 'No link',
      clicks: 0,
      sales: 1,
      earnings_minor: 1250,
    },
  ],
  money: {
    pending_minor: 3750,
    approved_minor: 6250,
    paying_minor: 2500,
    paid_minor: 12500,
    next_release_at: '2026-11-17T14:02:11.508233+00:00',
  },
  latest: [
    {
      paid_at: '2026-11-10T14:02:11.508233+00:00',
      link_name: null,
      amount_minor: 1250,
      status: 'held',
    },
    {
      paid_at: '2026-11-05T09:40:26.190044+00:00',
      link_name: 'Instagram',
      amount_minor: 1250,
      status: 'held',
    },
    {
      paid_at: '2026-10-27T20:11:53.642718+00:00',
      link_name: 'Newsletter',
      amount_minor: 1250,
      status: 'held',
    },
    {
      paid_at: '2026-10-18T07:55:38.027561+00:00',
      link_name: 'Main link',
      amount_minor: 1250,
      status: 'approved',
    },
    {
      paid_at: '2026-10-09T11:30:04.915302+00:00',
      link_name: 'Instagram',
      amount_minor: 0,
      status: 'reversed',
    },
  ],
}

const quietDays = (days: number) => Array.from({ length: days }, () => 0)

// Loop Habits: joined, and nothing has happened yet.
const loop_habits_30 = {
  days: 30,
  timezone: 'Europe/London',
  starts_on: '2026-10-14',
  ends_on: '2026-11-12',
  programs,
  program: loopHabits,
  totals: { clicks: 0, sales: 0, earnings_minor: 0 },
  previous: { clicks: 0, sales: 0, earnings_minor: 0 },
  daily: daily('2026-10-14', quietDays(30), quietDays(30), 0),
  channels: channels(
    2,
    Array.from({ length: 7 }, (): [number, number, number] => [0, 0, 0]),
  ),
  money: null,
  latest: [],
}

/** A creator who has joined no program. */
const none_30 = {
  days: 30,
  timezone: 'UTC',
  starts_on: '2026-10-14',
  ends_on: '2026-11-12',
  programs: [],
  program: null,
  totals: { clicks: 0, sales: 0, earnings_minor: 0 },
  previous: { clicks: 0, sales: 0, earnings_minor: 0 },
  daily: [],
  channels: [],
  money: null,
  latest: [],
}

export const performanceFixture = {
  /** No slug asked for: the first program by name. */
  first_30: dramapal_30,
  dramapal_30,
  loop_habits_30,
  speaksix_7,
  speaksix_30,
  speaksix_90,
  none_30,
}
