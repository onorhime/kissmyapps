import { describe, expect, it } from 'vitest'
import { entryDetail, readBalance } from './balance'
import { countsShown, groupCreators, readCreators, readDecision, totalsNote } from './creators'
import { rewardsBackendFixture as backend } from './rewards-backend.fixture'
import { rewardsFixture as byHand } from './rewards.fixture'
import {
  awardStatus,
  budgetLine,
  budgetStanding,
  creatorsInOrder,
  doneLine,
  goingBack,
  readRejection,
  readRewards,
  standsOut,
  withNextPage,
  wentFurther,
} from './rewards'

const busy = () => readRewards(backend.workspace_program_rewards_busy)

// The merchant Rewards page, and the growth of Creators and Balance, against what the database
// functions really return.
describe('merchant rewards and the real backend answers', () => {
  it('reads the month, the rewards and the creators of a busy program', () => {
    const page = busy()
    expect(page.can_manage).toBe(true)
    expect(page.program).toMatchObject({ slug: 'fluent', name: 'Fluent', status: 'live' })
    expect(page.program?.earn_from).toBe('events')
    expect(page.currency).toBe('USD')
    expect(page.budget).toEqual({
      month: '2026-11',
      budget_minor: 50000,
      used_minor: 3100,
      daily_limit_minor: 5000,
      fee_bps: 1000,
    })
    expect(page.rewards.map((item) => [item.label, item.amount_minor, item.count])).toEqual([
      ['Account created', 200, 7],
      ['Trial started', 600, 3],
      ['Quiz finished', 100, 1],
    ])
    // What the month used is what its rewards add up to.
    expect(page.rewards.reduce((sum, item) => sum + (item.amount_total_minor ?? 0), 0)).toBe(3100)
    expect(budgetStanding(page.budget!, page.rewards)).toMatchObject({
      left_minor: 46900,
      level: 'fine',
    })
    expect(budgetLine(page.budget!, 'USD')).toBe('$31.00 of $500.00 used')

    const ada = page.creators.find((creator) => creator.name === 'Ada Okafor')!
    expect(ada).toMatchObject({ clicks: 18, people: 8, went_further: 2, rejected: 1 })
    expect(ada.counts).toEqual({ signup_completed: 8, trial_started: 4, quiz_done: 1 })
    expect(wentFurther(ada)).toBe('2 of 8')
    // Too few people anywhere to single a creator out, so the order is the database's.
    expect(page.creators.some((creator) => standsOut(creator, page.creators))).toBe(false)
    expect(creatorsInOrder(page.creators)).toEqual(page.creators)
  })

  it('reads every way a reward can end, newest first, with words for each', () => {
    const page = busy()
    expect(page.awards).toHaveLength(45)
    const times = page.awards.map((award) => Date.parse(award.occurred_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(new Set(page.awards.map((award) => award.status))).toEqual(
      new Set(['pending', 'approved', 'rejected', 'not_counted']),
    )
    expect(
      new Set(page.awards.filter((a) => a.status === 'not_counted').map((a) => a.reason)),
    ).toEqual(
      new Set([
        'program_paused',
        'balance_empty',
        'already_rewarded',
        'not_a_member',
        'not_in_terms',
        'own_action',
        'daily_limit',
        'budget_reached',
      ]),
    )
    for (const award of page.awards) {
      const words = awardStatus(award)
      expect(words.label).not.toBe('Recorded')
      if (award.status === 'not_counted' || award.status === 'rejected')
        expect(words.detail).not.toBeNull()
      // Only a reward on hold can be rejected.
      expect(award.can_reject).toBe(award.status === 'pending')
      expect(award.amount_minor).toBeGreaterThan(0)
      expect(award.creator_name).not.toBeNull()
      expect(award.reward_label).not.toBeNull()
    }
    expect(new Set(page.awards.map((a) => a.reject_reason).filter(Boolean))).toEqual(
      new Set(['duplicate', 'low_quality', 'fake']),
    )
  })

  it('carries no person, session or event id and no email', () => {
    const page = busy()
    expect(JSON.stringify(page)).not.toMatch(/person|session|event_id|@/)
    const keys = new Set(page.awards.flatMap((award) => Object.keys(award)))
    expect(keys).toEqual(
      new Set([
        'award_id',
        'occurred_at',
        'member_id',
        'creator_name',
        'link_name',
        'reward_key',
        'reward_label',
        'amount_minor',
        'status',
        'reason',
        'hold_until',
        'reject_reason',
        'can_reject',
      ]),
    )
  })

  it('joins a next page onto the list without a reward twice', () => {
    const whole = busy()
    // The database's first page of five ends on the moment of its last reward.
    const first = {
      ...whole,
      awards: whole.awards.slice(0, 5),
      next_before: whole.awards[4].occurred_at,
    }
    const next = readRewards(backend.workspace_program_rewards_next_page)
    expect(next.awards).toHaveLength(5)
    const joined = withNextPage(first, next)
    expect(joined.awards.map((award) => award.award_id)).toEqual(
      whole.awards.slice(0, 10).map((award) => award.award_id),
    )
    expect(joined.next_before).toBe(next.next_before)
    expect(joined.next_before).not.toBeNull()
  })

  it('reads the list of one creator and of one status, with the figures of the program', () => {
    const page = busy()
    const one = readRewards(backend.workspace_program_rewards_filtered_creator)
    expect(new Set(one.awards.map((award) => award.creator_name))).toEqual(new Set(['Ben Creator']))
    expect(one.awards).toHaveLength(12)
    expect(one.budget).toEqual(page.budget)
    expect(one.creators).toEqual(page.creators)

    const waiting = readRewards(backend.workspace_program_rewards_pending_only)
    expect(waiting.awards).toHaveLength(11)
    expect(waiting.awards.every((award) => award.status === 'pending' && award.can_reject)).toBe(
      true,
    )
  })

  it('works out what a rejection gives back the way the database does', () => {
    // The capture rejected Ben's two duplicates: an Account created and a Trial started.
    const done = readRejection(backend.workspace_program_reward_reject_done)
    expect(done).toEqual({ rejected: 2, returned_minor: 770 })
    const page = busy()
    const twins = page.awards.filter(
      (award) => award.creator_name === 'Ben Creator' && award.reject_reason === 'duplicate',
    )
    expect(twins.map((award) => award.amount_minor).sort()).toEqual([200, 500])
    expect(goingBack(twins, page.budget!.fee_bps)).toEqual({
      count: 2,
      rewards_minor: 700,
      fee_minor: 70,
      total_minor: done.returned_minor,
    })
    expect(doneLine(done.rejected!, done.returned_minor, 'USD')).toBe(
      '2 rewards rejected. $7.70 is back in your balance.',
    )
  })

  it('reads a program with no reward yet, and a workspace with nothing to list', () => {
    const empty = readRewards(backend.workspace_program_rewards_empty)
    expect(empty.awards).toEqual([])
    expect(empty.creators).toEqual([])
    expect(empty.rewards.map((item) => item.count)).toEqual([0, 0])
    expect(budgetStanding(empty.budget!, empty.rewards)?.level).toBe('fine')

    const none = readRewards(backend.workspace_program_rewards_sales_program)
    expect(none).toMatchObject({ program: null, budget: null, awards: [], next_before: null })
  })

  it('is matched in shape by the answers written by hand for the states the suite does not make', () => {
    type Answer = Record<string, unknown> & {
      program: Record<string, unknown> | null
      budget: Record<string, unknown> | null
      rewards: Array<Record<string, unknown>>
      creators: Array<Record<string, unknown>>
      awards: Array<Record<string, unknown>>
    }
    const real = backend.workspace_program_rewards_busy as Answer
    const keys = (value: object | null | undefined) => Object.keys(value ?? {}).sort()
    const names = Object.keys(byHand).filter((name) => name.startsWith('rewards_'))
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) {
      const answer = byHand[name] as Answer
      expect(keys(answer), name).toEqual(keys(real))
      if (!answer.program) continue
      expect(keys(answer.program), name).toEqual(keys(real.program))
      expect(keys(answer.budget), name).toEqual(keys(real.budget))
      for (const item of answer.rewards) expect(keys(item), name).toEqual(keys(real.rewards[0]))
      for (const item of answer.creators) expect(keys(item), name).toEqual(keys(real.creators[0]))
      for (const item of answer.awards) expect(keys(item), name).toEqual(keys(real.awards[0]))
    }
    expect(keys(byHand.reward_reject_done as object)).toEqual(
      keys(backend.workspace_program_reward_reject_done as object),
    )
  })

  it('reads the events on the Creators answer, and a decision that carries them', () => {
    const state = readCreators(backend.workspace_program_creators_with_events)
    expect(state.earn_from).toBe('events')
    expect(state.totals).toMatchObject({ sales: 1, clicks: 9, events: 10 })
    expect(state.creators.map((creator) => [creator.name, creator.events])).toEqual([
      ['Ben Creator', 2],
      ['Ada Okafor', 8],
    ])
    expect(totalsNote(state, groupCreators(state.creators).active)).toBeNull()
    // The program moved to events after a sale, so the table keeps both counts.
    expect(countsShown(state)).toEqual({ sales: true, events: true })
    const raw = backend.workspace_program_creators_with_events as { creators: unknown[] }
    const decided = readDecision({ creator: raw.creators[0] })
    expect(decided.events).toBe(2)
    expect(JSON.stringify(state)).not.toContain('@')

    const none = readCreators(backend.workspace_program_creators_no_program)
    expect(none).toMatchObject({ program: null, earn_from: 'sales', totals: null })
  })

  it('names the reward on each Balance line about one', () => {
    const state = readBalance(backend.workspace_program_balance_with_rewards)
    expect(state.activity).toHaveLength(27)
    expect(state.activity.filter((line) => line.reward_label)).toHaveLength(24)
    expect(entryDetail(state.activity[0], 'USD')).toBe('Reward for Ben Creator: Trial started')
    expect(state.activity[14]).toMatchObject({ kind: 'fee_returned', amount_minor: 20 })
    expect(entryDetail(state.activity[14], 'USD')).toBe('Reward for Ada Okafor: Account created')
    // A sale's lines say null, and read as they always did.
    expect('reward_label' in state.activity[25]).toBe(false)
    expect(entryDetail(state.activity[25], 'USD')).toBe('Ada Okafor · $49.00 sale')
    expect(entryDetail(state.activity[26], 'USD')).toBeNull()
    expect(JSON.stringify(state)).not.toMatch(/person|session|event_id|@/)
  })
})
