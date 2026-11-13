import { describe, expect, it } from 'vitest'
import { marketplacePhase8BackendFixture as backend } from './marketplace.phase8-backend.fixture'
import { buyerOfferLines, readProgramDetail } from './model'

// The marketplace reader against what marketplace_program really returns for a program that
// sells through a KissMyApps checkout link and gives buyers a discount with creators' codes.
describe('marketplace reader and the real answer for a checkout-link program with codes', () => {
  it('reads the product, its price and the buyer discount', () => {
    const answer = backend.marketplace_program_with_checkout as { program: unknown }
    const detail = readProgramDetail(answer.program)
    expect(detail).toMatchObject({
      slug: 'fluent',
      payment_mode: 'kma_checkout',
      checkout: { name: 'Fluent Pro', amount_minor: 999, interval: 'month' },
      buyer_discount_bps: 1000,
    })
    expect(buyerOfferLines(detail).map((line) => line.text.replace(/\u00a0/g, ' '))).toEqual([
      'Your link opens the checkout for Fluent Pro, $9.99 a month',
      'Buyers get 10% off with your code',
    ])
  })
})
