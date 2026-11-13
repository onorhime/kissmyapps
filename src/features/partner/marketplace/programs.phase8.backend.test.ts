import { describe, expect, it } from 'vitest'
import { readPartnerProgramView } from './programs'
import { programsPhase8BackendFixture as backend } from './programs.phase8-backend.fixture'

// The program page reader against what partner_program_detail really returns for a member of a
// checkout-link program whose code is ready.
describe('the program page and the real answer for a member with a promo code', () => {
  it('reads the code from the membership, and the product the link sells', () => {
    const view = readPartnerProgramView(backend.partner_program_detail_with_code)
    expect(view.promo_code).toEqual({ code: 'BENRIVERS102', discount_bps: 1000, status: 'active' })
    expect(view.program).toMatchObject({
      payment_mode: 'kma_checkout',
      checkout: { name: 'Fluent Pro', amount_minor: 999, interval: 'month' },
      buyer_discount_bps: 1000,
    })
  })
})
