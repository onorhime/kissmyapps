// The Rewards answers the database suite does not make, written by hand to the shapes of
// `workspace_program_rewards` and `workspace_program_reward_reject`: a busy month with a page
// after it, a creator that stands out, a budget nearly or wholly used, a viewer, a program with
// one reward. What the database really returns is in rewards-backend.fixture.ts, and
// rewards.backend.test.ts checks that every answer here has the same keys at every level.
// Nothing here says who did an event: the database sends no person, session or event id, and
// none is invented.

const PROGRAM = {
  id: '6b1f7a52-3c0e-4d7b-9a41-5e2d8c0f1a11',
  slug: 'fluent',
  name: 'Fluent',
  status: 'live',
  earn_from: 'events',
}

const MIRA = '1c9e4b7a-52d1-4f08-8a63-0b7d2e5f9a21'
const JONAS = '2d0f5c8b-63e2-4a19-9b74-1c8e3f6a0b32'
const ADA = '3e1a6d9c-74f3-4b2a-8c85-2d9f4a7b1c43'
const DEAL = '4f2b7e0d-8504-4c3b-9d96-3e0a5b8c2d54'

const SIGNUP = { key: 'signup_completed', label: 'Account created', amount_minor: 200 }
const TRIAL = { key: 'trial_started', label: 'Trial started', amount_minor: 600 }

/** One reward as `workspace_program_rewards` lists it. */
const award = (over: Record<string, unknown>) => ({
  award_id: '00000000-0000-4000-8000-000000000000',
  occurred_at: '2026-11-13T09:41:07.120045+00:00',
  member_id: MIRA,
  creator_name: 'Mira Maker',
  link_name: 'TikTok',
  reward_key: SIGNUP.key,
  reward_label: SIGNUP.label,
  amount_minor: SIGNUP.amount_minor,
  status: 'pending',
  reason: null,
  hold_until: '2026-12-13T09:41:07.120045+00:00',
  reject_reason: null,
  can_reject: true,
  ...over,
})

/** A reward that did not count: no hold, nothing to reject. */
const notCounted = (reason: string, over: Record<string, unknown>) =>
  award({ status: 'not_counted', reason, hold_until: null, can_reject: false, ...over })

/** One creator's last 30 days as `workspace_program_rewards` lists them. */
const creator = (over: Record<string, unknown>) => ({
  member_id: MIRA,
  name: 'Mira Maker',
  clicks: 340,
  people: 25,
  went_further: 9,
  counts: [
    { key: SIGNUP.key, count: 25 },
    { key: TRIAL.key, count: 9 },
  ],
  earned_minor: 10400,
  pending_minor: 5200,
  rejected: 1,
  not_counted: 4,
  ...over,
})

const miraSignup = award({ award_id: '7a0c1a10-0001-4c00-8a00-0000000000a1' })
const miraTrial = award({
  award_id: '7a0c1a10-0002-4c00-8a00-0000000000a2',
  occurred_at: '2026-11-13T08:12:44.501200+00:00',
  link_name: 'Main link',
  reward_key: TRIAL.key,
  reward_label: TRIAL.label,
  amount_minor: TRIAL.amount_minor,
  hold_until: '2026-12-13T08:12:44.501200+00:00',
})
const jonasSignup = award({
  award_id: '7a0c1a10-0003-4c00-8a00-0000000000a3',
  occurred_at: '2026-11-12T19:02:10.000000+00:00',
  member_id: JONAS,
  creator_name: 'Jonas Weber',
  link_name: 'YouTube',
  hold_until: '2026-12-12T19:02:10.000000+00:00',
})
const adaSignup = award({
  award_id: '7a0c1a10-0004-4c00-8a00-0000000000a4',
  occurred_at: '2026-11-12T14:30:00.000000+00:00',
  member_id: ADA,
  creator_name: 'Ada Okafor',
  link_name: 'No link',
  hold_until: '2026-12-12T14:30:00.000000+00:00',
})
const jonasApproved = award({
  award_id: '7a0c1a10-0005-4c00-8a00-0000000000a5',
  occurred_at: '2026-10-09T07:15:30.000000+00:00',
  member_id: JONAS,
  creator_name: 'Jonas Weber',
  link_name: 'YouTube',
  reward_key: TRIAL.key,
  reward_label: TRIAL.label,
  amount_minor: TRIAL.amount_minor,
  status: 'approved',
  hold_until: '2026-11-08T07:15:30.000000+00:00',
  can_reject: false,
})
const miraRejected = award({
  award_id: '7a0c1a10-0006-4c00-8a00-0000000000a6',
  occurred_at: '2026-11-11T16:45:00.000000+00:00',
  link_name: 'Instagram',
  status: 'rejected',
  reject_reason: 'duplicate',
  hold_until: '2026-12-11T16:45:00.000000+00:00',
  can_reject: false,
})
const miraAlready = notCounted('already_rewarded', {
  award_id: '7a0c1a10-0007-4c00-8a00-0000000000a7',
  occurred_at: '2026-11-11T11:20:00.000000+00:00',
})
const adaOwn = notCounted('own_action', {
  award_id: '7a0c1a10-0008-4c00-8a00-0000000000a8',
  occurred_at: '2026-11-10T20:31:00.000000+00:00',
  member_id: ADA,
  creator_name: 'Ada Okafor',
  link_name: 'Main link',
})
const jonasDaily = notCounted('daily_limit', {
  award_id: '7a0c1a10-0009-4c00-8a00-0000000000a9',
  occurred_at: '2026-11-10T08:05:00.000000+00:00',
  member_id: JONAS,
  creator_name: 'Jonas Weber',
  link_name: 'YouTube',
  reward_key: TRIAL.key,
  reward_label: TRIAL.label,
  amount_minor: TRIAL.amount_minor,
})
const lenaLeft = notCounted('not_a_member', {
  award_id: '7a0c1a10-0010-4c00-8a00-0000000000b0',
  occurred_at: '2026-11-09T12:00:00.000000+00:00',
  member_id: null,
  creator_name: 'Lena Hoffmann',
  link_name: 'Newsletter',
})
const adaBudget = notCounted('budget_reached', {
  award_id: '7a0c1a10-0011-4c00-8a00-0000000000b1',
  occurred_at: '2026-10-31T23:10:00.000000+00:00',
  member_id: ADA,
  creator_name: 'Ada Okafor',
  link_name: 'Instagram',
})
const jonasOlder = award({
  award_id: '7a0c1a10-0012-4c00-8a00-0000000000b2',
  occurred_at: '2026-10-02T10:10:10.000000+00:00',
  member_id: JONAS,
  creator_name: 'Jonas Weber',
  link_name: 'YouTube',
  status: 'approved',
  hold_until: '2026-11-01T10:10:10.000000+00:00',
  can_reject: false,
})

const budget = {
  month: '2026-11',
  budget_minor: 50000,
  used_minor: 17600,
  daily_limit_minor: 5000,
  fee_bps: 1000,
}

const rewards = [
  { ...SIGNUP, count: 43, amount_total_minor: 8600 },
  { ...TRIAL, count: 15, amount_total_minor: 9000 },
]

const creators = [
  creator({}),
  creator({
    member_id: JONAS,
    name: 'Jonas Weber',
    clicks: 1210,
    people: 18,
    went_further: 6,
    counts: [
      { key: SIGNUP.key, count: 18 },
      { key: TRIAL.key, count: 6 },
    ],
    earned_minor: 7200,
    pending_minor: 2400,
    rejected: 0,
    not_counted: 2,
  }),
  creator({
    member_id: ADA,
    name: 'Ada Okafor',
    clicks: 96,
    people: 4,
    went_further: 2,
    counts: [
      { key: SIGNUP.key, count: 4 },
      { key: TRIAL.key, count: 2 },
    ],
    earned_minor: 2000,
    pending_minor: 2000,
    rejected: 0,
    not_counted: 2,
  }),
]

/** Fifty first rewards a day from one creator, and nobody going on to a trial. */
const dealRows = Array.from({ length: 12 }, (_, index) =>
  award({
    award_id: `7a0c1a10-01${String(index).padStart(2, '0')}-4c00-8a00-0000000000c0`,
    occurred_at: `2026-11-13T07:${String(58 - index * 4).padStart(2, '0')}:00.000000+00:00`,
    member_id: DEAL,
    creator_name: 'Deal Drop',
    link_name: 'Telegram',
    hold_until: `2026-12-13T07:${String(58 - index * 4).padStart(2, '0')}:00.000000+00:00`,
  }),
)

export const rewardsFixture: Record<string, unknown> = {
  // workspace_program_rewards, first page: a month with every status and several reasons.
  rewards_busy: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget,
    rewards,
    creators,
    awards: [
      miraSignup,
      miraTrial,
      jonasSignup,
      adaSignup,
      miraRejected,
      miraAlready,
      adaOwn,
      jonasDaily,
      lenaLeft,
      adaBudget,
      jonasApproved,
    ],
    next_before: jonasApproved.occurred_at,
  },

  // The page after it: asked with "before" = the next_before above. The last one.
  rewards_next_page: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget,
    rewards,
    creators,
    awards: [jonasOlder],
    next_before: null,
  },

  // Asked with member_id = Mira's. The budget and the rewards still cover everyone.
  rewards_filtered_creator: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget,
    rewards,
    creators,
    awards: [miraSignup, miraTrial, miraRejected, miraAlready],
    next_before: null,
  },

  // Asked with status = pending.
  rewards_pending_only: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget,
    rewards,
    creators,
    awards: [miraSignup, miraTrial, jonasSignup, adaSignup],
    next_before: null,
  },

  // The same month for a member who can read the program but not manage it.
  rewards_viewer: {
    can_manage: false,
    program: PROGRAM,
    currency: 'USD',
    budget,
    rewards,
    creators,
    awards: [miraSignup, miraTrial, jonasSignup, adaSignup, miraRejected, jonasApproved].map(
      (row) => ({ ...row, can_reject: false }),
    ),
    next_before: null,
  },

  // One creator with 500 first rewards in ten days and nobody going further.
  rewards_suspicious: {
    can_manage: true,
    program: { ...PROGRAM, earn_from: 'both' },
    currency: 'USD',
    budget: { ...budget, budget_minor: 250000, used_minor: 117600, daily_limit_minor: 25000 },
    rewards: [
      { ...SIGNUP, count: 543, amount_total_minor: 108600 },
      { ...TRIAL, count: 15, amount_total_minor: 9000 },
    ],
    creators: [
      ...creators,
      creator({
        member_id: DEAL,
        name: 'Deal Drop',
        clicks: 540,
        people: 500,
        went_further: 0,
        counts: [
          { key: SIGNUP.key, count: 500 },
          { key: TRIAL.key, count: 0 },
        ],
        earned_minor: 100000,
        pending_minor: 100000,
        rejected: 0,
        not_counted: 37,
      }),
    ],
    awards: [...dealRows, miraSignup, miraTrial, jonasSignup],
    next_before: jonasSignup.occurred_at,
  },

  // Asked with member_id = the creator who stands out, status = pending.
  rewards_suspicious_creator: {
    can_manage: true,
    program: { ...PROGRAM, earn_from: 'both' },
    currency: 'USD',
    budget: { ...budget, budget_minor: 250000, used_minor: 117600, daily_limit_minor: 25000 },
    rewards: [
      { ...SIGNUP, count: 543, amount_total_minor: 108600 },
      { ...TRIAL, count: 15, amount_total_minor: 9000 },
    ],
    creators: [
      creator({
        member_id: DEAL,
        name: 'Deal Drop',
        clicks: 540,
        people: 500,
        went_further: 0,
        counts: [
          { key: SIGNUP.key, count: 500 },
          { key: TRIAL.key, count: 0 },
        ],
        earned_minor: 100000,
        pending_minor: 100000,
        rejected: 0,
        not_counted: 37,
      }),
    ],
    awards: dealRows,
    next_before: dealRows[dealRows.length - 1].occurred_at,
  },

  // Most of the month's budget is used.
  rewards_budget_nearly: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget: { ...budget, used_minor: 46400 },
    rewards: [
      { ...SIGNUP, count: 142, amount_total_minor: 28400 },
      { ...TRIAL, count: 30, amount_total_minor: 18000 },
    ],
    creators,
    awards: [miraSignup, miraTrial, jonasSignup, adaSignup],
    next_before: null,
  },

  // The month's budget is used up: the next reward would not fit.
  rewards_budget_reached: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget: { ...budget, used_minor: 50000 },
    rewards: [
      { ...SIGNUP, count: 154, amount_total_minor: 30800 },
      { ...TRIAL, count: 32, amount_total_minor: 19200 },
    ],
    creators,
    awards: [adaBudget, miraSignup],
    next_before: null,
  },

  // A program with one reward: nobody can "go further", so that figure is null.
  rewards_one_reward: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget: { ...budget, used_minor: 9400 },
    rewards: [{ ...SIGNUP, count: 47, amount_total_minor: 9400 }],
    creators: creators.map((row) => ({
      ...row,
      went_further: null,
      counts: [(row.counts as Array<{ key: string; count: number }>)[0]],
    })),
    awards: [miraSignup, jonasSignup, adaSignup],
    next_before: null,
  },

  // A live events program nobody has earned from yet.
  rewards_empty: {
    can_manage: true,
    program: PROGRAM,
    currency: 'USD',
    budget: { ...budget, used_minor: 0 },
    rewards: [
      { ...SIGNUP, count: 0, amount_total_minor: 0 },
      { ...TRIAL, count: 0, amount_total_minor: 0 },
    ],
    creators: [],
    awards: [],
    next_before: null,
  },

  // A workspace whose program pays for sales only, or that has no program.
  rewards_sales_program: {
    can_manage: true,
    program: null,
    currency: 'USD',
    budget: null,
    rewards: [],
    creators: [],
    awards: [],
    next_before: null,
  },

  // workspace_program_reward_reject: two rewards of $2.00 with their 10% fee.
  reward_reject_done: { rejected: 2, returned_minor: 440 },
}

/** The members the filtered answers were asked for. */
export const rewardsFixtureMember = MIRA
export const rewardsFixtureStandsOut = DEAL
