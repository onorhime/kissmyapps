import { describe, expect, it } from 'vitest'
import {
  commissionAmount,
  commissionStatusLine,
  hasRewards,
  programActivity,
  readProgramEarnings,
  rewardLine,
} from './earnings'
import { earningsRewardsBackendFixture as backend } from './earnings.rewards-backend.fixture'

const NOW = new Date('2026-11-13T12:00:00Z')
const answer = backend.partner_program_earnings_with_rewards as {
  recent: Record<string, unknown>[]
}

// The creator's Earnings reader against what partner_program_earnings returns once a program
// can pay per event (suite 86 of the database tests).
describe("a creator's earnings and the real answer with rewards in it", () => {
  it('reads each program with its sales and its rewarded events', () => {
    const earnings = readProgramEarnings(answer)
    expect(earnings.programs.map((row) => [row.name, row.sales, row.events])).toEqual([
      ['Quiet Club', 2, 0],
      ['Rival Reader', 2, 2],
      ['SpeakSix', 1, 8],
    ])
    expect(earnings.programs.map(programActivity)).toEqual([
      '2 sales',
      '2 sales · 2 events',
      '1 sale · 8 events',
    ])
    expect(hasRewards(earnings)).toBe(true)
  })

  it('reads every recent row as a sale or a reward, and a reward has no sale amount', () => {
    const earnings = readProgramEarnings(answer)
    expect(earnings.recent).toHaveLength(answer.recent.length)
    expect(earnings.recent.filter((row) => row.kind === 'sale')).toHaveLength(5)
    for (const row of earnings.recent.filter((commission) => commission.kind === 'reward')) {
      expect(row.sale_amount_minor).toBeNull()
      expect(row.reward_label).toBeTruthy()
    }
    expect(earnings.recent.slice(0, 3).map((row) => [row.program_name, rewardLine(row)])).toEqual([
      ['Quiet Club', null],
      ['Rival Reader', 'Reward: Sign-up'],
      ['SpeakSix', 'Reward: Account created'],
    ])
    expect(earnings.recent[0].sale_amount_minor).toBe(4000)
  })

  it('reads a rejected reward: nothing to pay, rejected by the brand and not refunded', () => {
    const rejected = readProgramEarnings(answer).recent.find(
      (row) => row.kind === 'reward' && row.status === 'reversed',
    )!
    expect(rejected.amount_minor).toBe(0)
    expect(commissionStatusLine(rejected, NOW)).toBe('Rejected by the brand')
    // The amount on the row is what the brand turned down, drawn as a returned row is.
    expect(commissionAmount(rejected)).toEqual({ amount: '$2.00', was: null })
  })

  it('finds nobody in the answer: no email, no person, no event id', () => {
    const text = JSON.stringify(answer)
    expect(text).not.toContain('@')
    expect(text).not.toMatch(/"(event_id|session_id|person_id|external_id|user_id)"/)
  })

  it('leaves out a recent row of a kind it has no words for', () => {
    const changed = structuredClone(answer)
    changed.recent[1].kind = 'bonus'
    const earnings = readProgramEarnings(changed)
    expect(earnings.recent).toHaveLength(answer.recent.length - 1)
    expect(earnings.recent.map((row) => row.id)).not.toContain(answer.recent[1].id)
  })
})
