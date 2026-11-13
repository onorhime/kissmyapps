import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PartnerDataGateway } from '../api'
import { LinksUnreadable, readLinkProgram, readProgramLinks } from './links'
import type { ProgramLinks, ProgramLinksResult } from './links'
import { linksSampleFixture } from './links.fixture'
import { linksPhase8Fixture as hand } from './links.phase8.fixture'
import { ProgramLinksPage } from './ProgramLinksPage'
import { promoCodeLine, promoCodeNote, readPromoCode } from './promoCode'

// Answers written by hand to the Phase 8 contract until the database's own are captured: see
// links.phase8.fixture.ts.

type Answer = { programs: Record<string, unknown>[] } & Record<string, unknown>

const ok = <T,>(data: T): ProgramLinksResult<T | null> => ({ data, status: 'ready', error: null })

function renderAnswer(answer: unknown) {
  const getProgramLinks = vi.fn(async () => ok<ProgramLinks>(readProgramLinks(answer)))
  const gateway = { getProgramLinks } as unknown as PartnerDataGateway
  return render(<ProgramLinksPage gateway={gateway} />)
}

const loaded = () => screen.findByRole('table', { name: 'Results by channel' })
const promoPanel = () => screen.queryByRole('region', { name: 'Promo code' })

/** The SpeakSix answer with its program's `promo_code` set to this. */
function withCode(promoCode: unknown) {
  const answer = hand.promo_active as Answer
  return { ...answer, programs: [{ ...answer.programs[0], promo_code: promoCode }] }
}

const ready = { code: 'ADAOKAFOR10', discount_bps: 1000, status: 'active' }

describe('reading promo codes on the Links page', () => {
  it('reads a code of each state on its own program', () => {
    const programs = readProgramLinks(hand.with_codes).programs
    expect(programs.map((program) => [program.slug, program.promo_code])).toEqual([
      ['dramapal', { code: 'ADAOKAFOR15', discount_bps: 1500, status: 'pending' }],
      ['loop-habits', undefined],
      ['speaksix', { code: 'ADAOKAFOR10', discount_bps: 1000, status: 'active' }],
    ])
    expect(readProgramLinks(hand.promo_failed).programs[0].promo_code?.status).toBe('failed')
  })

  it('reads no code, a retired code and an answer from before promo codes alike', () => {
    const before = readProgramLinks(linksSampleFixture.partner_program_links)
    const speaksixBefore = before.programs[2]
    expect('promo_code' in speaksixBefore).toBe(false)
    for (const answer of [hand.promo_none, hand.promo_retired]) {
      expect(readProgramLinks(answer).programs[0]).toEqual(speaksixBefore)
    }
  })

  it('keeps the code on the program a link change answers with', () => {
    expect(readLinkProgram(hand.link_create_with_code).promo_code).toEqual(ready)
  })

  it('reads a code at its limits: 3 and 20 characters, 1% and 90%', () => {
    expect(readPromoCode({ code: 'ADA', discount_bps: 100, status: 'active' })).toEqual({
      code: 'ADA',
      discount_bps: 100,
      status: 'active',
    })
    expect(readProgramLinks(hand.promo_longest).programs[0].promo_code).toEqual({
      code: 'ADAOKAFORCREATOR9099',
      discount_bps: 9000,
      status: 'active',
    })
  })

  it.each([
    ['the code is in small letters', { ...ready, code: 'adaokafor10' }],
    ['the code has a space', { ...ready, code: 'ADA 10' }],
    ['the code is too short', { ...ready, code: 'AD' }],
    ['the code is too long', { ...ready, code: 'A'.repeat(21) }],
    ['the code is a number', { ...ready, code: 10 }],
    ['the code is missing', { discount_bps: 1000, status: 'active' }],
    ['the discount is under 1%', { ...ready, discount_bps: 99 }],
    ['the discount is over 90%', { ...ready, discount_bps: 9001 }],
    ['the discount is a fraction', { ...ready, discount_bps: 1000.5 }],
    ['the discount is text', { ...ready, discount_bps: '1000' }],
    ['the status is one the page does not know', { ...ready, status: 'expired' }],
    ['it is not an object', 'ADAOKAFOR10'],
  ])('refuses the answer when %s', (_name, promoCode) => {
    expect(() => readProgramLinks(withCode(promoCode))).toThrow(LinksUnreadable)
  })

  it('carries nothing about buyers: no email, no name, no customer', () => {
    const text = JSON.stringify(hand)
    expect(text).not.toContain('@example')
    expect(text).not.toMatch(
      /"(customer[a-z_]*|buyer_(email|name|id)|email|person_id|user_id|app_user_id)"/,
    )
  })
})

describe('the words for a code', () => {
  it('says what a ready code gives, and what being made or failing means', () => {
    // "10% off" never breaks over two lines.
    expect(promoCodeLine({ status: 'active', code: 'ANNA10', discount_bps: 1000 })).toBe(
      'Your code ANNA10 gives buyers 10%\u00a0off',
    )
    expect(promoCodeLine({ status: 'pending', discount_bps: 1250 })).toBe(
      'Your code for 12.5%\u00a0off is being made. It shows here when it is ready to share.',
    )
    expect(promoCodeLine({ status: 'failed', discount_bps: 1000 }, 'Fluent Labs')).toBe(
      'Your code for 10%\u00a0off could not be made. Fluent Labs has been told.',
    )
    expect(promoCodeLine({ status: 'failed', discount_bps: 1000 })).toMatch(
      /The brand has been told\.$/,
    )
  })

  it('says a checkout link applies the code by itself only where it does', () => {
    const code = { status: 'active', code: 'ANNA10', discount_bps: 1000 } as const
    expect(promoCodeNote(code)).toBe(
      'A sale that uses your code is credited to you, even without your link.',
    )
    expect(promoCodeNote(code, true)).toMatch(
      /^Buyers who open your link get the discount without typing it\. /,
    )
    expect(promoCodeNote({ status: 'pending', discount_bps: 1000 })).toBeNull()
    expect(promoCodeNote({ status: 'failed', discount_bps: 1000 })).toBe('Your link still works.')
  })
})

describe('the promo code on the Links page', () => {
  it('shows a ready code with what it gives buyers, and copies the code alone', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderAnswer(hand.promo_active)
    await loaded()

    const panel = within(promoPanel()!)
    expect(panel.getByText(/^Your code/)).toHaveTextContent(
      'Your code ADAOKAFOR10 gives buyers 10% off',
    )
    expect(
      panel.getByText('A sale that uses your code is credited to you, even without your link.'),
    ).toBeInTheDocument()

    await user.click(panel.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('ADAOKAFOR10')
    expect(await panel.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(panel.getByRole('status')).toHaveTextContent('ADAOKAFOR10 copied')
    // The link's own button is untouched.
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })

  it('selects the code to copy by hand when the clipboard refuses', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    renderAnswer(hand.promo_active)
    await loaded()

    const panel = within(promoPanel()!)
    await user.click(panel.getByRole('button', { name: 'Copy code' }))
    expect(await panel.findByRole('status')).toHaveTextContent(
      'The code is selected. Copy it with your keyboard.',
    )
    expect(window.getSelection()?.toString()).toBe('ADAOKAFOR10')
  })

  it('says a code is being made, without its letters or a Copy button', async () => {
    renderAnswer(hand.promo_pending)
    await loaded()
    const panel = within(promoPanel()!)
    expect(
      panel.getByText(
        'Your code for 10% off is being made. It shows here when it is ready to share.',
      ),
    ).toBeInTheDocument()
    expect(panel.queryByText(/ADAOKAFOR10/)).not.toBeInTheDocument()
    expect(panel.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says a code could not be made and that the brand has been told', async () => {
    renderAnswer(hand.promo_failed)
    await loaded()
    const panel = within(promoPanel()!)
    expect(
      panel.getByText('Your code for 10% off could not be made. The brand has been told.'),
    ).toBeInTheDocument()
    expect(panel.getByText('Your link still works.')).toBeInTheDocument()
    expect(panel.queryByText(/ADAOKAFOR10/)).not.toBeInTheDocument()
    expect(panel.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['gives buyers no discount', hand.promo_none],
    ['has a retired code', hand.promo_retired],
    ['comes from a database from before promo codes', linksSampleFixture.partner_program_links],
  ])('shows nothing about codes for a program that %s', async (_name, answer) => {
    renderAnswer(answer)
    await loaded()
    expect(promoPanel()).toBeNull()
    expect(screen.queryByText(/code/i)).toBeNull()
  })

  it('shows each program’s own code as the creator moves between programs', async () => {
    const user = userEvent.setup()
    renderAnswer(hand.with_codes)
    await loaded()
    const picker = within(screen.getByRole('group', { name: 'Program' }))

    expect(within(promoPanel()!).getByText(/is being made/)).toHaveTextContent('15% off')
    await user.click(picker.getByRole('button', { name: 'Loop Habits' }))
    expect(promoPanel()).toBeNull()
    await user.click(picker.getByRole('button', { name: 'SpeakSix' }))
    expect(within(promoPanel()!).getByText(/^Your code/)).toHaveTextContent(
      'Your code ADAOKAFOR10 gives buyers 10% off',
    )
  })
})
