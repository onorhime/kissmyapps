// Sample answers of `partner_program_earnings` with rewards, written by hand to the shape in the
// Phase 6 contract (Piece 3, item 1): a program gains `events`, and a recent row gains `kind`
// and `reward_label`; for a reward `sale_amount_minor` is null and `paid_at` is when the event
// happened. To be joined by output captured from the database.

const fluent = '00000000-0000-4000-8000-000000000006'
const loopHabits = '00000000-0000-4000-8000-000000000003'
const speaksix = '00000000-0000-4000-8000-000000000001'

const row = (number: number) => `00000000-0000-4000-9000-${String(number).padStart(12, '0')}`

function reward(
  number: number,
  program: [id: string, name: string],
  label: string,
  amountMinor: number,
  occurredAt: string,
  status: 'held' | 'approved' | 'reversed',
  holdUntil: string,
) {
  return {
    id: row(number),
    program_id: program[0],
    program_name: program[1],
    status,
    amount_minor: status === 'reversed' ? 0 : amountMinor,
    earned_minor: amountMinor,
    currency: 'USD',
    sale_amount_minor: null,
    paid_at: occurredAt,
    hold_until: holdUntil,
    approved_at: status === 'approved' ? holdUntil : null,
    kind: 'reward',
    reward_label: label,
  }
}

function sale(
  number: number,
  program: [id: string, name: string],
  saleMinor: number,
  commissionMinor: number,
  paidAt: string,
  status: 'held' | 'approved' | 'reversed',
  holdUntil: string,
) {
  return {
    id: row(number),
    program_id: program[0],
    program_name: program[1],
    status,
    amount_minor: status === 'reversed' ? 0 : commissionMinor,
    earned_minor: commissionMinor,
    currency: 'USD',
    sale_amount_minor: saleMinor,
    paid_at: paidAt,
    hold_until: holdUntil,
    approved_at: status === 'approved' ? holdUntil : null,
    kind: 'sale',
    reward_label: null,
  }
}

const FLUENT: [string, string] = [fluent, 'Fluent']
const LOOP: [string, string] = [loopHabits, 'Loop Habits']
const SPEAKSIX: [string, string] = [speaksix, 'SpeakSix']

const fluentRewards = [
  reward(
    1,
    FLUENT,
    'Trial started',
    500,
    '2026-11-12T11:02:18.402117+00:00',
    'held',
    '2026-11-26T11:02:18.402117+00:00',
  ),
  reward(
    2,
    FLUENT,
    'Account created',
    200,
    '2026-11-12T10:47:03.915560+00:00',
    'held',
    '2026-11-26T10:47:03.915560+00:00',
  ),
  reward(
    5,
    FLUENT,
    'Account created',
    200,
    '2026-11-10T07:14:26.660912+00:00',
    'reversed',
    '2026-11-24T07:14:26.660912+00:00',
  ),
  reward(
    8,
    FLUENT,
    'Trial started',
    500,
    '2026-10-28T15:41:09.337025+00:00',
    'approved',
    '2026-11-11T15:41:09.337025+00:00',
  ),
]

const payoutsOff = {
  enabled: false,
  min_payout_minor: 2500,
  platform_account_id: null,
  payable: [],
}

export const earningsEventsFixture: Record<string, unknown> = {
  /** Three programs: one pays for events, one for sales and events, one for sales. */
  with_rewards: {
    programs: [
      {
        program_id: fluent,
        slug: 'fluent',
        name: 'Fluent',
        currency: 'USD',
        pending_minor: 31200,
        approved_minor: 18600,
        paying_minor: 0,
        paid_minor: 22400,
        sales: 0,
        events: 186,
        next_release_at: '2026-11-14T09:12:40.118204+00:00',
      },
      {
        program_id: loopHabits,
        slug: 'loop-habits',
        name: 'Loop Habits',
        currency: 'USD',
        pending_minor: 24150,
        approved_minor: 12300,
        paying_minor: 0,
        paid_minor: 18750,
        sales: 20,
        events: 101,
        next_release_at: '2026-11-15T13:26:51.774038+00:00',
      },
      {
        program_id: speaksix,
        slug: 'speaksix',
        name: 'SpeakSix',
        currency: 'USD',
        pending_minor: 4410,
        approved_minor: 1470,
        paying_minor: 0,
        paid_minor: 0,
        sales: 4,
        events: 0,
        next_release_at: '2026-12-13T08:20:11.004512+00:00',
      },
    ],
    recent: [
      fluentRewards[0],
      fluentRewards[1],
      sale(
        3,
        LOOP,
        3000,
        900,
        '2026-11-12T09:58:14.250771+00:00',
        'held',
        '2026-11-26T09:58:14.250771+00:00',
      ),
      reward(
        4,
        LOOP,
        'Account created',
        150,
        '2026-11-12T09:31:40.006318+00:00',
        'held',
        '2026-11-26T09:31:40.006318+00:00',
      ),
      fluentRewards[2],
      sale(
        6,
        SPEAKSIX,
        4900,
        1470,
        '2026-11-09T16:22:45.730018+00:00',
        'held',
        '2026-12-09T16:22:45.730018+00:00',
      ),
      sale(
        7,
        LOOP,
        3000,
        900,
        '2026-11-09T12:44:02.903355+00:00',
        'reversed',
        '2026-11-23T12:44:02.903355+00:00',
      ),
      fluentRewards[3],
    ],
    payouts: [],
    payout: payoutsOff,
  },
  /** A creator whose only program pays for events: no row has a sale behind it. */
  rewards_only: {
    programs: [
      {
        program_id: fluent,
        slug: 'fluent',
        name: 'Fluent',
        currency: 'USD',
        pending_minor: 700,
        approved_minor: 500,
        paying_minor: 0,
        paid_minor: 0,
        sales: 0,
        events: 3,
        next_release_at: '2026-11-26T10:47:03.915560+00:00',
      },
    ],
    recent: fluentRewards,
    payouts: [],
    payout: payoutsOff,
  },
}
