import { describe, expect, it } from 'vitest'
import { programCheckoutBackendFixture as phase8 } from './program-checkout-backend.fixture'
import { programBackendFixture as before } from './program-backend.fixture'
import { programAppsBackendFixture as phase7 } from './program-apps-backend.fixture'
import {
  CHECKOUT_LINK_PREFIX,
  changedInput,
  changesAgreement,
  checkoutLinkOf,
  checkoutPrice,
  describeProblem,
  discountBps,
  discountLine,
  draftCheckout,
  draftFromProgram,
  offersCheckout,
  ProgramError,
  productLine,
  promoCountLine,
  promoErrorWords,
  promoFailureLine,
  readState,
  validateDraft,
} from './programs'
import { readSales, saleSource } from './sales'

type Answer = { program: Record<string, unknown> } & Record<string, unknown>
const answer = (name: string) => structuredClone(phase8[name]) as Answer
/** The checkout-link program with one of its values changed. */
const withValue = (key: string, value: unknown) => {
  const changed = answer('workspace_program_get.kma_checkout')
  changed.program[key] = value
  return changed
}

// The program form's readers against what the Phase 8 database functions really return
// (suite 90_program_checkout_promo.sql), and against the answers of older databases.
describe('program readers and the real backend answers, checkout link and promo codes', () => {
  it('reads the checkout-link program: its product, discount, codes and link', () => {
    const state = readState(answer('workspace_program_get.kma_checkout'))
    const program = state.program!
    expect(program.payment_mode).toBe('kma_checkout')
    expect(program.checkout).toEqual({
      name: 'Fluent Pro',
      amount_minor: 999,
      interval: 'month',
      success_url: 'https://fluent-app.io/welcome',
    })
    expect(program.buyer_discount_bps).toBe(1000)
    expect(program.promo_codes).toEqual({ active: 0, pending: 0, failed: 0, last_error: null })
    expect(state.stripe_charges_enabled).toBe(true)
    expect(offersCheckout(state)).toBe(true)
    // The database makes the address; the form shows it and never sends it.
    expect(checkoutLinkOf(program)).toBe(`${CHECKOUT_LINK_PREFIX}fluent`)
    expect(productLine(program.checkout, 'USD')).toBe('Fluent Pro, $9.99 a month')
    expect(discountLine(1000)).toBe('Buyers get 10% off with a creator’s code')

    const draft = draftFromProgram(program, true, true)
    expect(draft).toMatchObject({
      paymentMode: 'kma_checkout',
      productName: 'Fluent Pro',
      productPrice: '9.99',
      productInterval: 'month',
      successUrl: 'https://fluent-app.io/welcome',
      codes: true,
      discount: '10',
    })
    expect(draftCheckout(draft)).toEqual(program.checkout)
    expect(validateDraft(draft, true)).toEqual({})
    // Read back unchanged, nothing is sent but the revision.
    expect(changedInput(draft, program)).toEqual({ revision: program.revision })
  })

  it('reads a draft on its own checkout: no product, no discount, no codes', () => {
    const state = readState(answer('workspace_program_get.own_checkout'))
    const program = state.program!
    expect(program.payment_mode).toBe('own_checkout')
    expect(program.checkout).toBeNull()
    expect(program.buyer_discount_bps).toBeNull()
    expect(program.promo_codes).toBeNull()
    expect(checkoutLinkOf(program)).toBeNull()
    const draft = draftFromProgram(program, true, true)
    expect(draft).toMatchObject({ paymentMode: 'own_checkout', codes: false, discount: '' })
    expect(changedInput(draft, program)).toEqual({ revision: program.revision })
  })

  it('sends a checkout link without a landing page, and the discount in basis points', () => {
    const program = readState(answer('workspace_program_get.own_checkout')).program!
    const draft = {
      ...draftFromProgram(program, true, true),
      paymentMode: 'kma_checkout' as const,
      productName: '  Fluent Pro ',
      productPrice: '12.50',
      productInterval: 'year' as const,
      successUrl: 'https://fluent.example.test/welcome',
      codes: true,
      discount: '15',
    }
    const sent = changedInput(draft, program)
    expect(sent).toEqual({
      payment_mode: 'kma_checkout',
      checkout: {
        name: 'Fluent Pro',
        amount_minor: 1250,
        interval: 'year',
        success_url: 'https://fluent.example.test/welcome',
      },
      buyer_discount_bps: 1500,
      revision: program.revision,
    })
    expect(sent).not.toHaveProperty('landing_url')
    expect(changesAgreement(draft, program)).toBe(true)
    // A one-time product has no interval.
    const once = changedInput({ ...draft, productInterval: 'once' }, program)
    expect(once.checkout).toMatchObject({ interval: null })
    // Turning codes off on a program with a discount sends none.
    const live = readState(answer('workspace_program_get.kma_checkout')).program!
    const off = changedInput({ ...draftFromProgram(live, true, true), codes: false }, live)
    expect(off).toEqual({ buyer_discount_bps: null, revision: live.revision })
    expect(changesAgreement({ ...draftFromProgram(live, true, true), codes: false }, live)).toBe(
      true,
    )
  })

  it('keeps the product saved when the program goes back to its own checkout', () => {
    const program = readState(answer('workspace_program_get.kma_checkout')).program!
    const draft = {
      ...draftFromProgram(program, true, true),
      paymentMode: 'own_checkout' as const,
      landingUrl: 'https://fluent.example.test/pricing',
    }
    const sent = changedInput(draft, program)
    expect(sent).toMatchObject({
      payment_mode: 'own_checkout',
      landing_url: 'https://fluent.example.test/pricing',
    })
    expect(sent).not.toHaveProperty('checkout')
  })

  it('checks prices and discounts the way the database does', () => {
    expect(checkoutPrice('9.99')).toBe(999)
    expect(checkoutPrice('0')).toBeNull()
    expect(checkoutPrice('nine')).toBeNull()
    expect(discountBps('1')).toBe(100)
    expect(discountBps('90%')).toBe(9000)
    expect(discountBps('95')).toBeNull()
    expect(discountBps('0')).toBeNull()
    expect(discountBps('12.5')).toBeNull()
  })

  it('reads every answer from before Phase 8 with no payment choice and nothing sent for it', () => {
    const older = [
      before.state_draft,
      before.state_live,
      phase7['workspace_program_get.app_program'],
    ]
    for (const value of older) {
      const state = readState(value)
      expect(state).not.toHaveProperty('stripe_charges_enabled')
      expect(state.program).not.toHaveProperty('payment_mode')
      expect(state.program).not.toHaveProperty('promo_codes')
      expect(offersCheckout(state)).toBe(false)
      const draft = draftFromProgram(state.program, true, offersCheckout(state))
      expect(draft.paymentMode).toBeUndefined()
      const sent = changedInput({ ...draft, name: `${draft.name} 2` }, state.program)
      for (const key of ['payment_mode', 'checkout', 'buyer_discount_bps'])
        expect(sent).not.toHaveProperty(key)
    }
    // A new program on a Phase 8 database is asked how its buyers pay.
    expect(offersCheckout({ program: null })).toBe(true)
  })

  it('refuses an answer whose payment, product, discount or codes cannot be read', () => {
    const broken = [
      withValue('payment_mode', 'stripe_link'),
      withValue('checkout', 'Fluent Pro'),
      withValue('checkout', { name: 'Fluent Pro', amount_minor: -5 }),
      withValue('checkout', { name: 'Fluent Pro', interval: 'week' }),
      withValue('checkout', { name: 'Fluent Pro', success_url: 'http://fluent.example.test' }),
      withValue('buyer_discount_bps', 50),
      withValue('buyer_discount_bps', 9500),
      withValue('buyer_discount_bps', '1000'),
      withValue('promo_codes', 3),
      withValue('promo_codes', { active: 1, pending: -1, failed: 0, last_error: null }),
      withValue('promo_codes', { active: 1, pending: 0, failed: 0, last_error: 7 }),
      withValue('promo_codes', { active: 1, failed: 0, last_error: null }),
    ]
    for (const value of broken) {
      expect(() => readState(value)).toThrow(ProgramError)
      expect(() => readState(value)).toThrow(
        expect.objectContaining({ code: 'response_unreadable' }),
      )
    }
    // An answer without a reason for the last failure is read as having none.
    const plain = withValue('promo_codes', { active: 3, pending: 1, failed: 0 })
    expect(readState(plain).program?.promo_codes).toEqual({
      active: 3,
      pending: 1,
      failed: 0,
      last_error: null,
    })
    // A program with no discount answers null, and a missing key reads as none.
    expect(readState(withValue('promo_codes', null)).program?.promo_codes).toBeNull()
    const missing = answer('workspace_program_get.kma_checkout')
    delete missing.program.promo_codes
    expect(readState(missing).program?.promo_codes ?? null).toBeNull()
  })

  it('says how the creators’ codes stand, and why some could not be made', () => {
    expect(promoCountLine({ active: 12, pending: 1, failed: 0, last_error: null })).toBe(
      '12 codes ready, 1 being made',
    )
    expect(promoCountLine({ active: 1, pending: 0, failed: 0, last_error: null })).toBe(
      '1 code ready',
    )
    expect(promoCountLine({ active: 0, pending: 3, failed: 0, last_error: null })).toBe(
      '3 codes being made',
    )
    expect(promoCountLine({ active: 0, pending: 0, failed: 0, last_error: null })).toBe(
      'No creator has a code yet. Each one gets a code when they join.',
    )
    expect(promoFailureLine({ active: 12, pending: 1, failed: 0, last_error: null })).toBeNull()
    expect(promoFailureLine({ active: 12, pending: 1, failed: 2, last_error: 'code_taken' })).toBe(
      '2 codes could not be made on your Stripe account.',
    )
    expect(promoFailureLine({ active: 0, pending: 0, failed: 1, last_error: null })).toBe(
      '1 code could not be made on your Stripe account.',
    )
    expect(promoErrorWords('code_taken')).toBe(
      'A code with that name already exists on your Stripe account.',
    )
    expect(promoErrorWords('stripe_account_denied')).toMatch(/Reconnect it in Connections/)
    expect(promoErrorWords('stripe_unreachable')).toBe('Stripe could not be reached.')
    // A reason the console has no words for is not shown as a code.
    expect(promoErrorWords('worker_error')).toBeNull()
    expect(promoErrorWords(null)).toBeNull()
  })

  it('says plainly when the Stripe account cannot take payments yet', () => {
    const state = readState({
      ...answer('workspace_program_get.kma_checkout'),
      stripe_charges_enabled: false,
    })
    expect(state.stripe_charges_enabled).toBe(false)
    const problem = describeProblem(
      new ProgramError('stripe_charges_disabled'),
      'publish',
      'sales',
      'kma_checkout',
    )
    expect(problem.message).toBe(
      'Your Stripe account cannot take payments yet, so a checkout link would not work. Finish setting it up in Stripe, then publish.',
    )
    expect(problem.recovery).toBe('connections')
  })

  it('reads the sales of a code as Stripe sales, before piece B names their source', () => {
    const state = readSales(answer('workspace_program_sales.promo'))
    expect(state.sales).toHaveLength(3)
    for (const sale of state.sales) {
      expect(sale.source).toBe('stripe')
      expect(sale.store).toBeNull()
      expect(sale.promotion_code).toBeNull()
      expect(saleSource(sale)).toBe('Stripe')
    }
    expect(state.sales.map((sale) => sale.match_source)).toEqual([
      'metadata',
      'promotion_code',
      'metadata',
    ])
  })
})
