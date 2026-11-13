import { describe, expect, it } from 'vitest'
import { payoutBackendFixture as backend } from '../../../merchant/payout-backend.fixture'
import {
  payableNow,
  payoutRuleLine,
  payoutStatusLine,
  payoutsOn,
  readProgramEarnings,
} from './earnings'

const sums = (earnings: ReturnType<typeof readProgramEarnings>) =>
  earnings.programs.map((row) => [
    row.name,
    row.approved_minor,
    row.paying_minor ?? 0,
    row.paid_minor,
  ])

// The creator's payouts reader against what partner_program_earnings really returns.
describe("a creator's payouts and the real backend answers", () => {
  it('reads earnings while payouts are switched off', () => {
    const earnings = readProgramEarnings(backend.partner_program_earnings_payouts_off)
    expect(payoutsOn(earnings)).toBeFalsy()
    expect(payoutRuleLine(earnings)).toBeNull()
    expect(earnings.payouts).toEqual([])
    expect(sums(earnings)).toEqual([
      ['Lingot', 3000, 0, 0],
      ['Rival Reader', 1410, 0, 0],
      ['SpeakSix', 3000, 0, 0],
    ])
  })

  it('reads what can be paid before a payout is made, per currency', () => {
    const earnings = readProgramEarnings(backend.partner_program_earnings_before)
    const terms = payoutsOn(earnings)
    expect(terms).toMatchObject({
      enabled: true,
      min_payout_minor: 2500,
      platform_account_id: 'acct_KMAPlatform',
      payable: [
        { currency: 'EUR', amount_minor: 3000 },
        { currency: 'USD', amount_minor: 4410 },
      ],
    })
    expect(payoutRuleLine(earnings)).toBe(
      'KissMyApps pays out approved earnings of 25.00 EUR or $25.00 or more.',
    )
    expect(payableNow(earnings.payout!)).toBe('30.00 EUR and $44.10')
  })

  it('reads a payout on its way: the money has left approved and is not paid yet', () => {
    const earnings = readProgramEarnings(backend.partner_program_earnings_during)
    expect(sums(earnings)).toEqual([
      ['Lingot', 3000, 0, 0],
      ['Rival Reader', 0, 1410, 0],
      ['SpeakSix', 0, 3000, 0],
    ])
    expect(earnings.payouts).toHaveLength(1)
    const [payout] = earnings.payouts!
    expect(payout).toMatchObject({ amount_minor: 4410, currency: 'USD', status: 'approved' })
    expect(payoutStatusLine(payout)).toBe('On its way')
    expect(earnings.payout!.payable).toEqual([{ currency: 'EUR', amount_minor: 3000 }])
  })

  it('reads payouts that arrived and one that was taken back', () => {
    const earnings = readProgramEarnings(backend.partner_program_earnings_paid)
    expect(sums(earnings)).toEqual([
      ['Lingot', 0, 3000, 0],
      ['Rival Reader', 0, 0, 1410],
      ['SpeakSix', 0, 0, 6000],
    ])
    expect(earnings.payouts!.map((payout) => [payout.status, payout.amount_minor])).toEqual([
      ['approved', 3000],
      ['paid', 7410],
      ['canceled', 4410],
    ])
    const paid = earnings.payouts![1]
    expect(payoutStatusLine(paid, new Date('2026-11-20T00:00:00Z'))).toMatch(/^Paid \d{1,2} Nov$/)
    expect(payoutStatusLine(earnings.payouts![2])).toBe('Not sent: back in your approved earnings')
    expect(payableNow(earnings.payout!)).toBeNull()
    // A creator is never shown Stripe ids or anyone's address.
    expect(JSON.stringify(earnings.payouts)).not.toMatch(/tr_|acct_|@/)
  })
})
