import { describe, expect, it } from 'vitest'
import { payoutBackendFixture as backend } from '../../../merchant/payout-backend.fixture'
import { mapAdminProgramPayouts, openPayoutWords, payoutFailureWords } from './api'

// The admin payouts reader against what the database functions really return.
describe('admin program payouts and the real backend answers', () => {
  it('reads payouts before any program has a balance', () => {
    expect(mapAdminProgramPayouts(backend.get_admin_program_payouts_no_platform)).toMatchObject({
      enabled: false,
      moneyEnabled: true,
      minPayoutMinor: 2500,
      platform: null,
      creators: [],
      open: [],
      recent: [],
      totals: { readyCount: 0, readyMinorByCurrency: {} },
    })
  })

  it('reads what creators are owed while payouts are off, one row per currency', () => {
    const off = mapAdminProgramPayouts(backend.get_admin_program_payouts_off)
    expect(off.enabled).toBe(false)
    expect(off.platform).toEqual({
      accountId: 'acct_KMAPlatform',
      registered: false,
      enabled: false,
    })
    expect(off.creators.map((row) => [row.name, row.currency, row.payableMinor])).toEqual([
      ['Ada Okafor', 'EUR', 3000],
      ['Ada Okafor', 'USD', 4410],
      ['Ben Creator', 'USD', 900],
      ['Cy Park', 'USD', 3000],
      ['Dee Vale', 'USD', 3600],
      ['Eve Stone', 'USD', 4000],
    ])
    expect(new Set(off.creators.map((row) => row.blocker))).toEqual(new Set(['payouts_off']))
    expect(off.totals.waitingMinorByCurrency).toEqual({ EUR: 3000, USD: 15910 })
  })

  it('reads the answer to switching payouts on', () => {
    const on = mapAdminProgramPayouts(backend.configure_admin_program_payouts_on)
    expect(on.enabled).toBe(true)
    expect(on.updatedAt).toMatch(/^2026-/)
    expect(on.platform).toMatchObject({ registered: true, enabled: true })
    expect(new Set(on.creators.map((row) => row.blocker))).toEqual(new Set(['no_account']))
  })

  it('reads who can be paid and why the others cannot', () => {
    const ready = mapAdminProgramPayouts(backend.get_admin_program_payouts_ready)
    expect(ready.creators.map((row) => [row.name, row.currency, row.blocker])).toEqual([
      ['Ada Okafor', 'EUR', null],
      ['Ada Okafor', 'USD', null],
      ['Eve Stone', 'USD', null],
      ['Ben Creator', 'USD', 'below_minimum'],
      ['Cy Park', 'USD', 'no_account'],
      ['Dee Vale', 'USD', 'account_not_ready'],
    ])
    expect(ready.totals).toMatchObject({
      readyCount: 3,
      readyMinorByCurrency: { EUR: 3000, USD: 8410 },
      waitingMinorByCurrency: { EUR: 0, USD: 7500 },
    })
    const ada = ready.creators[1]
    expect(ada.accountStatus).toBe('ready')
    expect(ada.programs.reduce((sum, program) => sum + program.amountMinor, 0)).toBe(4410)
    for (const program of ada.programs) expect(program.name).not.toBe('')
  })

  it('reads the answers to paying one creator, canceling, and paying all who are ready', () => {
    const paid = mapAdminProgramPayouts(backend.perform_admin_program_payout_pay)
    expect(paid.open).toHaveLength(1)
    expect(paid.open[0]).toMatchObject({
      name: 'Ada Okafor',
      currency: 'USD',
      amountMinor: 4410,
      status: 'approved',
      canCancel: true,
    })
    expect(openPayoutWords(paid.open[0])).toBe('Queued')
    expect(paid.creators.some((row) => row.name === 'Ada Okafor' && row.currency === 'USD')).toBe(
      false,
    )

    const canceled = mapAdminProgramPayouts(backend.perform_admin_program_payout_cancel)
    expect(canceled.open).toEqual([])
    expect(canceled.recent[0]).toMatchObject({ status: 'canceled', amountMinor: 4410 })
    expect(canceled.recent[0].closedAt).toMatch(/^2026-/)

    const all = mapAdminProgramPayouts(backend.perform_admin_program_payout_pay_ready)
    expect(all.open.map((row) => [row.name, row.amountMinor])).toEqual([
      ['Ada Okafor', 7410],
      ['Eve Stone', 4000],
    ])
    expect(all.totals.readyCount).toBe(1)
  })

  it('reads payouts under way, paid, failed and canceled together', () => {
    const full = mapAdminProgramPayouts(backend.get_admin_program_payouts_full)
    const [queued, retrying] = full.open
    expect(queued).toMatchObject({ name: 'Eve Stone', status: 'approved', canCancel: true })
    expect(retrying).toMatchObject({
      name: 'Ada Okafor',
      currency: 'EUR',
      status: 'processing',
      attempts: 1,
      canCancel: false,
    })
    expect(retrying.nextAttemptAt).toMatch(/^2026-/)
    expect(openPayoutWords(retrying)).toBe('Trying again: platform balance too low')
    expect(full.recent.map((row) => row.status)).toEqual([
      'failed',
      'canceled',
      'failed',
      'paid',
      'canceled',
    ])
    const sent = full.recent.find((row) => row.status === 'paid')
    expect(sent).toMatchObject({ amountMinor: 7410, transferId: 'tr_AdaOne' })
    for (const row of full.recent.filter((entry) => entry.status === 'failed')) {
      expect(payoutFailureWords(row.failureCode)).toBe('Payout account could not receive it')
    }
    expect(full.creators.find((row) => row.name === 'Eve Stone')).toMatchObject({
      blocker: 'payout_open',
      payableMinor: 1000,
      accountCountry: 'GB',
    })
    expect(full.totals.paidMinorByCurrency).toEqual({ EUR: 0, USD: 7410 })
    expect(JSON.stringify(full)).not.toContain('@')
  })

  it('has words for every reason the payout worker records', () => {
    // Why a payout ended as failed.
    expect(payoutFailureWords('account_not_ready')).toBe('Payout account could not receive it')
    expect(payoutFailureWords('currency_unavailable')).toBe('Account cannot receive this currency')
    expect(payoutFailureWords('transfer_rejected')).toBe('Stripe refused the transfer')
    expect(payoutFailureWords('platform_balance_low')).toBe('Platform balance too low')
    expect(payoutFailureWords('transfer_not_found')).toBe('Stripe has no record of the transfer')
    // Why one is still being tried.
    expect(payoutFailureWords('stripe_unavailable')).toBe('Stripe did not answer')
    expect(payoutFailureWords('stripe_key_refused')).toBe('Stripe key was refused')
    expect(payoutFailureWords('destination_changed')).toBe('Payout account changed')
    expect(payoutFailureWords('destination_missing')).toBe('Payout account changed')
    expect(payoutFailureWords('manual_reconciliation_required')).toBe('Needs a check in Stripe')
    expect(payoutFailureWords('provider_balance_or_account_unavailable')).toBe(
      'Platform balance too low',
    )
  })
})
