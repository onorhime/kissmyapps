import { describe, expect, it } from 'vitest'
import { readProgramLinks } from './links'
import { linksPhase8BackendFixture as backend } from './links.phase8-backend.fixture'

// The creator's Links reader against what partner_program_links really returns once the
// creator has a promo code.
describe("a creator's links and the real answer with a promo code", () => {
  it('reads the code, its discount and its state', () => {
    const links = readProgramLinks(backend.partner_program_links_with_code)
    expect(links.programs).toHaveLength(1)
    expect(links.programs[0]).toMatchObject({
      slug: 'fluent',
      promo_code: { code: 'ANNA10', discount_bps: 1000, status: 'active' },
    })
  })
})
