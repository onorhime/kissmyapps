import { describe, expect, it } from 'vitest'
import { mapAdminProgramMoney } from '../../admin/api/programMoney'
import { moneyBackendFixture as backend } from '../../../merchant/money-backend.fixture'
import { earningsLine, earningsOfProgram, hasEarnings, readProgramEarnings } from './earnings'

// The earnings and admin money readers against what the database functions really return.
describe('money readers and the real backend answers', () => {
  it("reads a creator's earnings across two programs", () => {
    const earnings = readProgramEarnings(backend.partner_program_earnings)
    expect(hasEarnings(earnings)).toBe(true)
    expect(earnings.programs.map((program) => program.name)).toEqual(['Rival Reader', 'SpeakSix'])
    const rival = earnings.programs[0]
    expect(rival).toMatchObject({
      slug: 'rival-reader',
      currency: 'USD',
      pending_minor: 1300,
      approved_minor: 500,
      paid_minor: 0,
      sales: 4,
    })
    expect(Number.isNaN(new Date(rival.next_release_at!).getTime())).toBe(false)
    expect(earningsOfProgram(earnings, { id: rival.program_id, slug: 'rival-reader' })).toEqual(
      rival,
    )
    expect(earningsOfProgram(earnings, { id: null, slug: 'speaksix' })?.name).toBe('SpeakSix')
    expect(earningsLine(rival)).toBe('Pending $13.00 · Approved $5.00')
    expect(earnings.recent).toHaveLength(19)
    expect(new Set(earnings.recent.map((commission) => commission.status))).toEqual(
      new Set(['held', 'approved', 'reversed']),
    )
    const reduced = earnings.recent.find(
      (commission) => commission.amount_minor < commission.earned_minor,
    )
    expect(reduced).toBeDefined()
    for (const commission of earnings.recent) {
      expect(commission.sale_amount_minor).toBeGreaterThan(0)
      expect(commission.program_name).not.toBe('')
      expect(JSON.stringify(commission)).not.toContain('@')
    }
  })

  it('reads the earnings of creators with one program and with none', () => {
    expect(readProgramEarnings(backend.partner_program_earnings_dee).recent[0].status).toBe(
      'approved',
    )
    expect(
      readProgramEarnings(backend.partner_program_earnings_ben).programs.length,
    ).toBeGreaterThan(0)
    const none = readProgramEarnings(backend.partner_program_earnings_none)
    expect(none).toEqual({ programs: [], recent: [] })
    expect(hasEarnings(none)).toBe(false)
  })

  it('reads the admin program money settings and totals', () => {
    expect(mapAdminProgramMoney(backend.admin_program_money_off)).toMatchObject({
      enabled: false,
      feeBps: 1000,
      minDepositMinor: 5000,
      totals: { programsWithBalance: 0, availableMinorByCurrency: {} },
    })
    const changed = mapAdminProgramMoney(backend.admin_program_money_on)
    expect(changed).toMatchObject({ enabled: true, feeBps: 1200, minDepositMinor: 2500 })
    expect(changed.updatedAt).toMatch(/^2026-/)
    expect(mapAdminProgramMoney(backend.admin_program_money_totals).totals).toEqual({
      programsWithBalance: 4,
      availableMinorByCurrency: { USD: 272605 },
      reservedMinorByCurrency: { USD: 19385 },
      owedToCreatorsMinorByCurrency: { USD: 10055 },
    })
  })
})
