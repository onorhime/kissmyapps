import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceUnreadable } from '../../marketplace/model'
import type { PartnerDataGateway } from '../api'
import { PartnerMarketplace } from './PartnerMarketplace'
import {
  promoCodeShown,
  readMembership,
  readPartnerMarketplace,
  readPartnerProgramView,
} from './programs'
import { programsPhase8Fixture as hand } from './programs.phase8.fixture'

// Answers written by hand to the Phase 8 contract until the database's own are captured: see
// programs.phase8.fixture.ts.

type View = {
  program: Record<string, unknown>
  membership: Record<string, unknown> | null
  promo_code?: unknown
} & Record<string, unknown>

const view = (key: string) => hand[key] as View
const ready = { code: 'ADAOKAFOR10', discount_bps: 1000, status: 'active' }
const plain = (words: string | null) => words?.replaceAll(' ', ' ') ?? null

function gatewayFor(answer: unknown, extra: Partial<PartnerDataGateway> = {}): PartnerDataGateway {
  return {
    getMarketplace: vi.fn(async () => ({
      data: readPartnerMarketplace(hand.marketplace_programs),
      status: 'ready',
      error: null,
    })),
    getProgram: vi.fn(async () => ({
      data: readPartnerProgramView(answer),
      status: 'ready',
      error: null,
    })),
    getProgramEarnings: vi.fn(async () => ({ data: null, status: 'empty', error: null })),
    ...extra,
  } as unknown as PartnerDataGateway
}

const openProgram = (answer: unknown, extra: Partial<PartnerDataGateway> = {}) =>
  render(<PartnerMarketplace gateway={gatewayFor(answer, extra)} slug="program" />)
const loaded = () => screen.findByRole('complementary', { name: 'Your membership' })
const side = () => within(screen.getByRole('complementary', { name: 'Your membership' }))

/** The lines of "What buyers get" in this part of the page, or null when there is none. */
function offerOf(scope: Pick<typeof screen, 'queryByRole'>) {
  const list = scope.queryByRole('list', { name: 'What buyers get' })
  return list ? Array.from(list.querySelectorAll('li'), (item) => plain(item.textContent)) : null
}

/** The promo code's part of the side box. */
const promoBlock = () => side().queryByRole('heading', { name: 'Promo code' })?.parentElement

beforeEach(() => {
  localStorage.clear()
})

// Reading ---------------------------------------------------------------------------------------

describe('reading the creator’s code on a program’s page', () => {
  it('reads the code inside the membership', () => {
    const read = readPartnerProgramView(view('detail_checkout_member'))
    expect(read.promo_code).toEqual(ready)
    expect(read.membership?.promo_code).toEqual(ready)
    expect(read.program).toMatchObject({ payment_mode: 'kma_checkout', buyer_discount_bps: 1000 })
  })

  it('reads the code beside the membership when that is where the answer puts it', () => {
    const answer = view('detail_checkout_member')
    const { promo_code: code, ...membership } = answer.membership!
    const read = readPartnerProgramView({ ...answer, membership, promo_code: code })
    expect(read.promo_code).toEqual(ready)
    expect(read.membership).not.toHaveProperty('promo_code')
  })

  it('reads no code, a retired code and an answer from before promo codes as none', () => {
    const answer = view('detail_checkout_member')
    const { promo_code: _code, ...older } = answer.membership!
    void _code
    expect(readPartnerProgramView({ ...answer, membership: older }).promo_code).toBeNull()
    expect(readPartnerProgramView(view('detail_checkout')).promo_code).toBeNull()
    expect(
      readPartnerProgramView({
        ...answer,
        membership: { ...older, promo_code: { ...ready, status: 'retired' } },
      }).promo_code,
    ).toBeNull()
  })

  it.each([
    [
      'inside the membership',
      (code: unknown) => ({
        ...view('detail_checkout_member'),
        membership: { ...view('detail_checkout_member').membership, promo_code: code },
      }),
    ],
    [
      'beside the membership',
      (code: unknown) => ({ ...view('detail_checkout_member'), promo_code: code }),
    ],
  ])('refuses a code that is not one %s', (_where, answer) => {
    for (const code of [{ ...ready, code: 'ada10' }, { ...ready, discount_bps: 9500 }, 'ADA10']) {
      expect(() => readPartnerProgramView(answer(code))).toThrow(MarketplaceUnreadable)
    }
  })

  it('reads a membership with or without a code', () => {
    const membership = view('detail_checkout_member').membership!
    expect(readMembership(membership).promo_code).toEqual(ready)
    expect(readMembership({ ...membership, promo_code: null })).not.toHaveProperty('promo_code')
    const { promo_code: _code, ...older } = membership
    void _code
    expect(readMembership(older)).not.toHaveProperty('promo_code')
  })

  it('treats an active member of a program with a discount and no code yet as being made', () => {
    expect(promoCodeShown({ buyer_discount_bps: 1000 }, null)).toEqual({
      status: 'pending',
      discount_bps: 1000,
    })
    expect(promoCodeShown({}, null)).toBeNull()
    expect(promoCodeShown({ buyer_discount_bps: 1000 }, ready as never)).toEqual(ready)
  })
})

// The program page ------------------------------------------------------------------------------

describe('a checkout-link program before joining', () => {
  it('says where the link leads and what buyers get, beside the agreement to accept', async () => {
    openProgram(view('detail_checkout'))
    await loaded()
    expect(side().getByRole('heading', { name: 'Accept and get your link' })).toBeInTheDocument()
    expect(offerOf(side())).toEqual([
      'Your link opens the checkout for Fluent Pro, $9.99 a month',
      'Buyers get 10% off with your code',
    ])
    expect(promoBlock()).toBeUndefined()
  })

  it('says the code is being made as soon as the creator has joined', async () => {
    const user = userEvent.setup()
    // An answer to joining that does not carry the code.
    const { promo_code: _code, ...joined } = view('detail_checkout_member').membership!
    void _code
    const joinProgram = vi.fn(async () => ({
      data: readMembership(joined),
      status: 'ready',
      error: null,
    }))
    openProgram(view('detail_checkout'), { joinProgram } as Partial<PartnerDataGateway>)
    await loaded()

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))
    expect(await side().findByText('You joined Fluent.')).toBeInTheDocument()
    expect(within(promoBlock()!).getByText(/^Your code for 10% off is being made\./)).toBeVisible()
  })
})

describe('a member of a checkout-link program', () => {
  it('shows a ready code with a Copy button, and that the link applies it', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    openProgram(view('detail_checkout_member'))
    await loaded()

    expect(offerOf(side())).toEqual(['Your link opens the checkout for Fluent Pro, $9.99 a month'])
    const block = within(promoBlock()!)
    expect(block.getByText(/^Your code/)).toHaveTextContent(
      'Your code ADAOKAFOR10 gives buyers 10% off',
    )
    expect(
      block.getByText(
        'Buyers who open your link get the discount without typing it. A sale that uses your code is credited to you, even without your link.',
      ),
    ).toBeInTheDocument()

    await user.click(block.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('ADAOKAFOR10')
    // The link keeps its own Copy button.
    expect(side().getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('says the code is being made, without its letters', async () => {
    openProgram(view('detail_checkout_member_pending'))
    await loaded()
    const block = within(promoBlock()!)
    expect(
      block.getByText(
        'Your code for 10% off is being made. It shows here when it is ready to share.',
      ),
    ).toBeInTheDocument()
    expect(block.queryByText(/ADAOKAFOR10/)).toBeNull()
    expect(block.queryByRole('button')).toBeNull()
  })

  it('says the code could not be made and that the brand, by name, has been told', async () => {
    openProgram(view('detail_checkout_member_failed'))
    await loaded()
    const block = within(promoBlock()!)
    expect(
      block.getByText('Your code for 10% off could not be made. Fluent Labs has been told.'),
    ).toBeInTheDocument()
    expect(block.getByText('Your link still works.')).toBeInTheDocument()
    expect(block.queryByRole('button')).toBeNull()
  })
})

describe('a member of a program on its own checkout with a discount', () => {
  it('shows the code without saying the link applies it', async () => {
    openProgram(view('detail_discount_member'))
    await loaded()
    expect(offerOf(side())).toBeNull()
    const block = within(promoBlock()!)
    expect(block.getByText(/^Your code/)).toHaveTextContent(
      'Your code ADAOKAFOR15 gives buyers 15% off',
    )
    expect(
      block.getByText('A sale that uses your code is credited to you, even without your link.'),
    ).toBeInTheDocument()
  })
})

describe('a creator waiting for approval in a one-time checkout-link program', () => {
  it('says where the link will lead, and nothing of a discount or a code', async () => {
    openProgram(view('detail_one_time_waiting'))
    await loaded()
    expect(side().getByRole('heading', { name: 'Waiting for approval' })).toBeInTheDocument()
    expect(offerOf(side())).toEqual([
      'Your link opens the checkout for Pocket Chef Lifetime, $49.00 one-time',
    ])
    expect(promoBlock()).toBeUndefined()
    expect(side().queryByText(/code/)).toBeNull()
  })
})

describe('the Marketplace page', () => {
  it('says on each card what buyers get', async () => {
    render(<PartnerMarketplace gateway={gatewayFor(null)} slug={null} />)
    const card = async (name: string) =>
      within((await screen.findByRole('heading', { name, level: 3 })).closest('article')!)

    expect(offerOf(await card('Fluent'))).toEqual([
      'Your link opens the checkout for Fluent Pro, $9.99 a month',
      'Buyers get 10% off with your code',
    ])
    expect(offerOf(await card('SpeakSix'))).toEqual(['Buyers get 15% off with your code'])
    expect(offerOf(await card('Fieldnote'))).toBeNull()
  })

  it('shows each active membership’s code on its card, without the longer note', async () => {
    const gateway = gatewayFor(null, {
      getMarketplace: vi.fn(async () => ({
        data: readPartnerMarketplace(hand.marketplace_members),
        status: 'ready',
        error: null,
      })),
    } as Partial<PartnerDataGateway>)
    render(<PartnerMarketplace gateway={gateway} slug={null} />)
    const yours = within(await screen.findByRole('region', { name: 'Your programs' }))
    const card = (name: string) => within(yours.getByRole('link', { name }).closest('article')!)

    expect(card('Fluent').getByText(/^Your code/)).toHaveTextContent(
      'Your code ADAOKAFOR10 gives buyers 10% off',
    )
    expect(card('Fluent').getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(card('Fluent').queryByText(/credited to you/)).toBeNull()
    expect(
      card('SpeakSix').getByText(
        'Your code for 15% off could not be made. SpeakSix Ltd has been told.',
      ),
    ).toBeInTheDocument()
    expect(card('Pocket Chef').queryByText(/code/)).toBeNull()
  })

  it('carries nothing about buyers: no email, no customer, no person', () => {
    const text = JSON.stringify(hand)
    expect(text).not.toMatch(/@(?!example\.test)/)
    expect(text).not.toMatch(
      /"(customer[a-z_]*|buyer_(email|name|id)|email|person_id|user_id|app_user_id)"/,
    )
  })
})
