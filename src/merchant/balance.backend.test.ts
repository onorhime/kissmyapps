import { describe, expect, it } from 'vitest'
import {
  entryLabel,
  hasStarted,
  heldBackByLimit,
  pausedForBalance,
  readBalance,
  topupReason,
} from './balance'
import { balanceBackendFixture as backend } from './balance-backend.fixture'

// The Balance page's reader against what the database functions really return.
describe('the balance reader and the real backend answers', () => {
  it('reads every state the database sends without refusing one', () => {
    for (const [name, answer] of Object.entries(backend)) {
      const state = readBalance(answer)
      expect(state.fee_bps, name).toBe(1000)
      expect(state.min_deposit_minor, name).toBe(5000)
      expect(state.can_manage, name).toBe(true)
    }
  })

  it('shows nothing to fund while program money is off or there is no program', () => {
    const off = readBalance(backend.balance_money_off)
    expect(off.enabled).toBe(false)
    expect(off.account).toBeNull()
    const none = readBalance(backend.balance_no_program)
    expect(none.enabled).toBe(true)
    expect(none.program).toBeNull()
    const fresh = readBalance(backend.balance_no_account)
    expect(fresh.program).toMatchObject({ name: 'SpeakSix', status: 'live', currency: 'USD' })
    expect(fresh.account).toBeNull()
    expect(hasStarted(fresh)).toBe(false)
  })

  it('reads a first deposit that is on its way', () => {
    const state = readBalance(backend.balance_first_deposit_pending)
    expect(state.pending_topup).toMatchObject({ amount_minor: 5000, status: 'processing' })
    expect(state.account).toMatchObject({ available_minor: 0, card: null, topup_limit: null })
  })

  it('reads a funded balance with its card, its sums and its activity', () => {
    const state = readBalance(backend.balance_funded)
    expect(hasStarted(state)).toBe(true)
    expect(state.account).toMatchObject({
      currency: 'USD',
      available_minor: 10149,
      reserved_minor: 1617,
      creators_pending_minor: 1470,
      creators_approved_minor: 2940,
      fees_minor: 441,
      deposited_minor: 15000,
      card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029 },
      auto_topup: true,
      min_balance_minor: 20000,
      topup_amount_minor: 10000,
      topup_problem: null,
    })
    // Newest first, each with the balance it left behind and words for what it was.
    expect(state.activity[0]).toMatchObject({
      kind: 'fee_reserved',
      amount_minor: -147,
      available_after_minor: 10149,
      creator_name: 'Ada Okafor',
      sale_amount_minor: 4900,
    })
    for (const entry of state.activity) {
      expect(entryLabel(entry)).not.toBe('')
      expect(entry.created_at).not.toBeNull()
      expect(JSON.stringify(entry)).not.toContain('@')
    }
    expect(state.activity.some((entry) => entry.kind === 'deposit')).toBe(true)
  })

  it('reads the saved settings the settings function answers with', () => {
    const state = readBalance(backend.balance_settings)
    expect(state.account).toMatchObject({ auto_topup: false })
  })

  it('reads a failed top-up, with and without another try coming', () => {
    const failed = readBalance(backend.balance_topup_failed).account?.topup_problem
    expect(failed?.code).toBe('card_declined')
    expect(failed?.failed_at).not.toBeNull()
    expect(failed?.retry_at).not.toBeNull()
    expect(topupReason(failed!.code)).toBe('your card was declined')
    const stopped = readBalance(backend.balance_topup_stopped).account?.topup_problem
    expect(stopped).toMatchObject({ code: 'expired_card', retry_at: null })
  })

  it("reads the day's limit on automatic top-ups while it holds one back", () => {
    const account = readBalance(backend.balance_topup_limited).account
    expect(account?.topup_limit?.per_day).toBe(5)
    expect(account?.topup_limit?.resumes_at).not.toBeNull()
    expect(heldBackByLimit(account ?? null)).toEqual(account?.topup_limit)
    expect(heldBackByLimit(readBalance(backend.balance_funded).account)).toBeNull()
  })

  it('reads a program paused because its balance ran out', () => {
    const state = readBalance(backend.balance_paused_for_balance)
    expect(pausedForBalance(state.program)).toBe(true)
    expect(state.account?.available_minor).toBe(0)
    expect(state.activity[0]).toMatchObject({ kind: 'deposit_reversed', amount_minor: -1500 })
    expect(state.activity[0].note).toBe('Card payment dispute lost')
  })
})
