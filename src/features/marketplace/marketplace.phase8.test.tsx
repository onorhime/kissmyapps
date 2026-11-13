import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PublicMarketplace } from './PublicMarketplace'
import type { PublicMarketplaceApi } from './PublicMarketplace'
import {
  MarketplaceUnreadable,
  buyerDiscountLine,
  buyerOfferLines,
  checkoutProductLine,
  readProgram,
  readProgramDetail,
  readProgramList,
} from './model'
import {
  marketplacePhase8Cards as cards,
  marketplacePhase8Fixture as hand,
} from './marketplace.phase8.fixture'

// Answers written by hand to the Phase 8 contract until the database's own are captured: see
// marketplace.phase8.fixture.ts.

type Detail = { program: Record<string, unknown> }

const fluentDetail = (hand.marketplace_program_with_checkout as Detail).program
const NBSP = '\u00a0'
/** The words as they read, with the spaces that never break a line made plain again. */
const plain = (words: string | null) => words?.replaceAll(NBSP, ' ') ?? null

/** A program from before checkout links and promo codes: none of their keys. */
const before = Object.fromEntries(
  Object.entries(cards.fieldnote).filter(
    ([key]) => !['payment_mode', 'checkout', 'buyer_discount_bps'].includes(key),
  ),
)

describe('reading what buyers get on a card', () => {
  it('reads a checkout link: its product, the price, how often, and the discount', () => {
    expect(readProgram(cards.fluentPro)).toMatchObject({
      payment_mode: 'kma_checkout',
      checkout: { name: 'Fluent Pro', amount_minor: 999, interval: 'month' },
      buyer_discount_bps: 1000,
    })
    expect(readProgram(cards.pocketChef)).toMatchObject({
      payment_mode: 'kma_checkout',
      checkout: { name: 'Pocket Chef Lifetime', amount_minor: 4900, interval: null },
    })
    expect(readProgram(cards.pocketChef)).not.toHaveProperty('buyer_discount_bps')
  })

  it('reads the merchant’s own checkout with a discount, and with neither', () => {
    const speaksix = readProgram(cards.speaksix)!
    expect(speaksix).toMatchObject({ payment_mode: 'own_checkout', buyer_discount_bps: 1500 })
    expect(speaksix).not.toHaveProperty('checkout')
    const fieldnote = readProgram(cards.fieldnote)!
    expect(fieldnote.payment_mode).toBe('own_checkout')
    expect(fieldnote).not.toHaveProperty('buyer_discount_bps')
  })

  it('reads a card from before checkout links as it always has', () => {
    const read = readProgram(before)!
    expect(read).not.toHaveProperty('payment_mode')
    expect(read).not.toHaveProperty('checkout')
    expect(read).not.toHaveProperty('buyer_discount_bps')
    expect(buyerOfferLines(read)).toEqual([])
    expect(readProgram({ ...before, payment_mode: null, buyer_discount_bps: null })).toEqual(read)
  })

  it('does not read a product sent with the merchant’s own checkout', () => {
    const read = readProgram({ ...cards.speaksix, checkout: cards.fluentPro.checkout })
    expect(read).not.toHaveProperty('checkout')
    expect(buyerOfferLines(read!).map((line) => line.key)).toEqual(['discount'])
  })

  it('keeps only the three fields of a product and tidies its name', () => {
    const read = readProgram({
      ...cards.fluentPro,
      checkout: {
        ...cards.fluentPro.checkout,
        name: '  Fluent Pro ',
        success_url: 'https://fluent.example.test/welcome',
      },
    })
    expect(read?.checkout).toEqual({ name: 'Fluent Pro', amount_minor: 999, interval: 'month' })
  })

  it('reads the limits: an 80-character name, a discount of 1% and of 90%', () => {
    const name = 'é'.repeat(80)
    expect(
      readProgram({ ...cards.fluentPro, checkout: { ...cards.fluentPro.checkout, name } })?.checkout
        ?.name,
    ).toBe(name)
    expect(readProgram({ ...cards.speaksix, buyer_discount_bps: 100 })?.buyer_discount_bps).toBe(
      100,
    )
    expect(readProgram(cards.loopHabits)?.buyer_discount_bps).toBe(9000)
  })

  const product = cards.fluentPro.checkout
  it.each([
    ['it is paid in a way the page does not know', { ...cards.speaksix, payment_mode: 'invoice' }],
    ['a checkout link has no product', { ...cards.fluentPro, checkout: null }],
    ['a checkout link’s product is not an object', { ...cards.fluentPro, checkout: 'Fluent Pro' }],
    ['the product has no name', { ...cards.fluentPro, checkout: { ...product, name: '  ' } }],
    [
      'the product name is longer than 80 characters',
      { ...cards.fluentPro, checkout: { ...product, name: 'a'.repeat(81) } },
    ],
    [
      'the product costs nothing',
      { ...cards.fluentPro, checkout: { ...product, amount_minor: 0 } },
    ],
    [
      'the price has a fraction of a cent',
      { ...cards.fluentPro, checkout: { ...product, amount_minor: 999.5 } },
    ],
    ['the price is text', { ...cards.fluentPro, checkout: { ...product, amount_minor: '999' } }],
    [
      'it renews in a way the page does not know',
      { ...cards.fluentPro, checkout: { ...product, interval: 'week' } },
    ],
    [
      'it does not say how often it is paid',
      { ...cards.fluentPro, checkout: { name: 'Fluent Pro', amount_minor: 999 } },
    ],
    ['the discount is under 1%', { ...cards.speaksix, buyer_discount_bps: 99 }],
    ['the discount is over 90%', { ...cards.speaksix, buyer_discount_bps: 9001 }],
    ['the discount is a fraction', { ...cards.speaksix, buyer_discount_bps: 1250.5 }],
    ['the discount is text', { ...cards.speaksix, buyer_discount_bps: '1500' }],
  ])('refuses a card when %s', (_name, row) => {
    expect(readProgram(row)).toBeNull()
    expect(readProgramList({ programs: [cards.fieldnote, row] }).map((p) => p.slug)).toEqual([
      'fieldnote',
    ])
    expect(() => readProgramDetail({ ...fluentDetail, ...row })).toThrow(MarketplaceUnreadable)
  })

  it('reads the same keys on a program’s page', () => {
    expect(readProgramDetail(fluentDetail)).toMatchObject({
      slug: 'fluent-pro',
      payment_mode: 'kma_checkout',
      checkout: { name: 'Fluent Pro', amount_minor: 999, interval: 'month' },
      buyer_discount_bps: 1000,
    })
  })
})

describe('the words for what buyers get', () => {
  it('names the product with its price and how often, in the program’s currency', () => {
    const line = (product: unknown, currency = 'USD') =>
      plain(checkoutProductLine(product as never, currency))
    expect(line(cards.fluentPro.checkout)).toBe('Fluent Pro, $9.99 a month')
    expect(line(cards.pocketChef.checkout)).toBe('Pocket Chef Lifetime, $49.00 one-time')
    expect(line({ name: 'Annual', amount_minor: 7900, interval: 'year' }, 'EUR')).toBe(
      'Annual, 79.00 EUR a year',
    )
    // The price and how often stay on one line.
    expect(checkoutProductLine(cards.fluentPro.checkout as never, 'USD')).toBe(
      `Fluent Pro, $9.99${NBSP}a${NBSP}month`,
    )
  })

  it('says the discount in whole and part percents', () => {
    expect(plain(buyerDiscountLine({ buyer_discount_bps: 1000 }))).toBe(
      'Buyers get 10% off with your code',
    )
    expect(plain(buyerDiscountLine({ buyer_discount_bps: 1250 }))).toBe(
      'Buyers get 12.5% off with your code',
    )
    expect(buyerDiscountLine({})).toBeNull()
  })

  it('says where a checkout link leads, then the discount', () => {
    const lines = buyerOfferLines(readProgram(cards.fluentPro)!)
    expect(lines.map((line) => [line.key, plain(line.text)])).toEqual([
      ['checkout', 'Your link opens the checkout for Fluent Pro, $9.99 a month'],
      ['discount', 'Buyers get 10% off with your code'],
    ])
  })
})

// The public pages ----------------------------------------------------------------------------

function api(detail: unknown = fluentDetail): PublicMarketplaceApi {
  return {
    loadPrograms: async () => ({
      status: 'ready',
      data: readProgramList(hand.marketplace_programs),
    }),
    loadProgram: async () => ({ status: 'ready', data: readProgramDetail(detail) }),
  }
}

/** The lines of "What buyers get" in this part of the page, or null when there is none. */
function offerOf(scope: HTMLElement) {
  const list = within(scope).queryByRole('list', { name: 'What buyers get' })
  return list ? Array.from(list.querySelectorAll('li'), (item) => plain(item.textContent)) : null
}

describe('the public marketplace', () => {
  it('says on each card what buyers get, and nothing on a card with neither', async () => {
    window.history.replaceState(null, '', '/marketplace')
    render(<PublicMarketplace api={api()} />)
    const card = async (name: string) =>
      (await screen.findByRole('heading', { name, level: 3 })).closest('article')!

    expect(offerOf(await card('Fluent'))).toEqual([
      'Your link opens the checkout for Fluent Pro, $9.99 a month',
      'Buyers get 10% off with your code',
    ])
    expect(offerOf(await card('SpeakSix'))).toEqual(['Buyers get 15% off with your code'])
    expect(offerOf(await card('Pocket Chef'))).toEqual([
      'Your link opens the checkout for Pocket Chef Lifetime, $49.00 one-time',
    ])
    expect(offerOf(await card('Loop Habits'))).toEqual([
      'Your link opens the checkout for Loop Habits Premium for Families and Small Teams, Yearly, 79.00 EUR a year',
      'Buyers get 90% off with your code',
    ])
    expect(offerOf(await card('Fieldnote'))).toBeNull()
  })

  it('says on a checkout-link program’s page where the link leads and the discount', async () => {
    window.history.replaceState(null, '', '/marketplace/fluent-pro')
    render(<PublicMarketplace api={api()} />)
    const side = await screen.findByRole('complementary', { name: 'Join this program' })
    expect(offerOf(side)).toEqual([
      'Your link opens the checkout for Fluent Pro, $9.99 a month',
      'Buyers get 10% off with your code',
    ])
    expect(within(side).getByRole('link', { name: 'Join program' })).toBeInTheDocument()
  })

  it('says only the discount on the page of a program on its own checkout', async () => {
    window.history.replaceState(null, '', '/marketplace/speaksix')
    render(<PublicMarketplace api={api((hand.marketplace_program_discount as Detail).program)} />)
    const side = await screen.findByRole('complementary', { name: 'Join this program' })
    expect(offerOf(side)).toEqual(['Buyers get 15% off with your code'])
  })
})
