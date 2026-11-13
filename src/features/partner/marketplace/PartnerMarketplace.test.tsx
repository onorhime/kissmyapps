import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceUnreadable } from '../../marketplace/model'
import type { PartnerDataGateway } from '../api'
import { PartnerMarketplace } from './PartnerMarketplace'
import {
  membershipStanding,
  programError,
  programErrorMessage,
  programFailure,
  readMembership,
  readMembershipAnswer,
  readPartnerMarketplace,
  readPartnerProgramView,
  shareableLink,
} from './programs'
import type {
  PartnerMarketplace as MarketplaceData,
  PartnerProgramErrorCode,
  PartnerProgramResult,
  PartnerProgramView,
  ProgramJoinInput,
  ProgramMembership,
  ProgramTermsInput,
} from './programs'
import {
  clearWantedProgram,
  peekWantedProgram,
  rememberWantedProgram,
  takeWantedProgram,
  wantedProgramClearedUrl,
  wantedProgramFromSearch,
} from './wantedProgram'

const SHA = 'a'.repeat(64)
const NEW_SHA = 'b'.repeat(64)
const LONG_LINK = 'https://go.kissmyapps.dev/r/ana-creator/k3x9q2'
const SHORT_LINK = 'https://go.kissmyapps.dev/speaksix/ana'
/** A timestamp exactly as the database sends it. */
const WHEN = '2026-11-13T13:52:14.059098+00:00'

// Rows as the backend sends them -------------------------------------------------------------

const speaksixCard = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: null,
  brand_name: 'SpeakSix Ltd',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 1,
}

const fieldnoteCard = {
  ...speaksixCard,
  slug: 'fieldnote',
  name: 'Fieldnote',
  category: 'productivity',
  tagline: 'Voice notes that turn into tidy meeting minutes.',
  brand_name: 'Fieldnote GmbH',
  approval_mode: 'manual',
}

function agreementFor(name: string, brand: string) {
  return {
    title: `${name} Affiliate Agreement`,
    brand_name: brand,
    program_name: name,
    summary: [
      { label: 'Commission', value: '30% of every payment for 12 months' },
      { label: 'Attribution window', value: '30 days' },
      { label: 'Hold before payout', value: '30 days' },
      { label: 'Minimum payout', value: '$20.00' },
    ],
    sections: [
      {
        heading: '1. Who this agreement is between',
        paragraphs: [`This agreement is between you, the creator, and ${brand}.`],
      },
    ],
    extra_terms: null,
  }
}

const speaksixDetail = {
  ...speaksixCard,
  id: 'prog-1',
  status: 'live',
  landing_url: 'https://speaksix.com/start',
  agreement: agreementFor('SpeakSix', 'SpeakSix Ltd'),
  agreement_sha256: SHA,
}

const fieldnoteDetail = {
  ...fieldnoteCard,
  id: 'prog-2',
  status: 'live',
  landing_url: 'https://fieldnote.app',
  agreement: agreementFor('Fieldnote', 'Fieldnote GmbH'),
  agreement_sha256: SHA,
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    program_id: 'prog-1',
    program: speaksixCard,
    program_status: 'live',
    status: 'active',
    terms_version: 1,
    accepted_at: WHEN,
    needs_new_terms: false,
    link: { url: LONG_LINK, short_url: SHORT_LINK, working: true },
    requested_at: WHEN,
    activated_at: WHEN,
    ended_at: null,
    decision_note: null,
    ...overrides,
  }
}

const pendingRow = (overrides: Record<string, unknown> = {}) =>
  membershipRow({
    id: 'mem-2',
    program_id: 'prog-2',
    program: fieldnoteCard,
    status: 'pending',
    link: null,
    activated_at: null,
    ...overrides,
  })

function viewOf(overrides: Record<string, unknown> = {}): PartnerProgramView {
  return readPartnerProgramView({
    program: speaksixDetail,
    membership: null,
    accept_name: 'Ana Creator',
    ...overrides,
  })
}

function marketplaceOf(overrides: Record<string, unknown> = {}): MarketplaceData {
  return readPartnerMarketplace({
    tracking_ready: true,
    programs: [speaksixCard, fieldnoteCard],
    memberships: [],
    ...overrides,
  })
}

// A gateway that answers from memory ----------------------------------------------------------

function ok<T>(data: T): PartnerProgramResult<T | null> {
  return { data, status: 'ready', error: null }
}

function failed<T>(code: PartnerProgramErrorCode): PartnerProgramResult<T | null> {
  return { data: null, status: 'error', error: programError(code) }
}

type Answer<T> = Promise<PartnerProgramResult<T | null>>

function fakeGateway() {
  const calls = {
    getMarketplace: vi.fn((): Answer<MarketplaceData> => Promise.resolve(ok(marketplaceOf()))),
    getProgram: vi.fn((slug: string): Answer<PartnerProgramView> => {
      void slug
      return Promise.resolve(ok(viewOf()))
    }),
    joinProgram: vi.fn((input: ProgramJoinInput): Answer<ProgramMembership> => {
      void input
      return Promise.resolve(ok(readMembership(membershipRow())))
    }),
    acceptProgramTerms: vi.fn((input: ProgramTermsInput): Answer<ProgramMembership> => {
      void input
      return Promise.resolve(ok(readMembership(membershipRow({ terms_version: 2 }))))
    }),
    leaveProgram: vi.fn((programId: string): Answer<ProgramMembership> => {
      void programId
      return Promise.resolve(
        ok(readMembership(membershipRow({ status: 'left', ended_at: WHEN, link: null }))),
      )
    }),
  }
  return { calls, gateway: calls as unknown as PartnerDataGateway }
}

function openProgram(gateway: PartnerDataGateway, slug = 'speaksix') {
  return render(<PartnerMarketplace gateway={gateway} slug={slug} />)
}

function openList(gateway: PartnerDataGateway) {
  return render(<PartnerMarketplace gateway={gateway} slug={null} />)
}

const side = () => within(screen.getByRole('complementary', { name: 'Your membership' }))
/** Waits until the program has loaded and its side box is there. */
const loaded = () => screen.findByRole('complementary', { name: 'Your membership' })
const agreeBox = () =>
  screen.getByRole('checkbox', { name: 'I have read and agree to this agreement' })

/** The whole address a card or the side box shows for a program. */
function shownLink(program: string, scope: Pick<typeof screen, 'getByText'> = screen) {
  return scope.getByText(`Your ${program} link:`).parentElement
}

/** A membership's card on the list, found by the program's name. */
function memberCard(program: string) {
  const yours = screen.getByRole('region', { name: 'Your programs' })
  const card = within(yours).getByRole('link', { name: program }).closest('article')
  if (!card) throw new Error(`No card for ${program}`)
  return within(card)
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reading what the program functions answer', () => {
  it('reads a membership with its program, link and database timestamps', () => {
    expect(readMembership(membershipRow())).toEqual({
      id: 'mem-1',
      program_id: 'prog-1',
      // A card from before programs could pay for events pays for sales and has no rewards.
      program: { ...speaksixCard, earn_from: 'sales', rewards: [], membership_status: null },
      program_status: 'live',
      status: 'active',
      terms_version: 1,
      accepted_at: WHEN,
      needs_new_terms: false,
      link: { url: LONG_LINK, short_url: SHORT_LINK, working: true },
      requested_at: WHEN,
      activated_at: WHEN,
      ended_at: null,
      decision_note: null,
    })
  })

  it('keeps a membership that has no link, no program id and no alias', () => {
    expect(readMembership(pendingRow({ program_id: undefined }))).toMatchObject({
      status: 'pending',
      program_id: null,
      link: null,
    })
    expect(
      readMembership(membershipRow({ link: { url: LONG_LINK, short_url: null, working: false } }))
        .link,
    ).toEqual({ url: LONG_LINK, short_url: null, working: false })
  })

  it('drops a link that is not a plain https address and a time that is not one', () => {
    for (const url of ['javascript:alert(1)', 'http://go.kissmyapps.dev/x', 'not a link', 7]) {
      expect(readMembership(membershipRow({ link: { url, working: true } })).link).toBeNull()
    }
    expect(
      readMembership(
        membershipRow({ link: { url: LONG_LINK, short_url: 'javascript:x', working: true } }),
      ).link,
    ).toEqual({ url: LONG_LINK, short_url: null, working: true })
    expect(readMembership(membershipRow({ accepted_at: 'yesterday' })).accepted_at).toBeNull()
  })

  it('refuses a membership with no id, an unknown status or an unreadable program', () => {
    expect(() => readMembership(membershipRow({ id: null }))).toThrow(MarketplaceUnreadable)
    expect(() => readMembership(membershipRow({ status: 'banned' }))).toThrow(MarketplaceUnreadable)
    expect(() => readMembership(membershipRow({ program: { name: 'x' } }))).toThrow(
      MarketplaceUnreadable,
    )
    expect(() => readMembershipAnswer({ row: membershipRow() })).toThrow(MarketplaceUnreadable)
    expect(readMembershipAnswer({ membership: membershipRow() }).id).toBe('mem-1')
  })

  it('reads the signed-in marketplace and refuses a body that is not one', () => {
    const read = readPartnerMarketplace({
      tracking_ready: false,
      programs: [{ ...speaksixCard, membership_status: 'active' }, { name: 'no slug' }],
      memberships: [membershipRow()],
    })
    expect(read.tracking_ready).toBe(false)
    expect(read.programs.map((program) => [program.slug, program.membership_status])).toEqual([
      ['speaksix', 'active'],
    ])
    expect(read.memberships).toHaveLength(1)
    expect(marketplaceOf().tracking_ready).toBe(true)
    expect(() => readPartnerMarketplace({ programs: [] })).toThrow(MarketplaceUnreadable)
    expect(() => readPartnerMarketplace(null)).toThrow(MarketplaceUnreadable)
  })

  it('reads one program with the id, the membership and the name it is accepted under', () => {
    const read = viewOf({ membership: membershipRow() })
    expect(read.program).toMatchObject({ id: 'prog-1', status: 'live', agreement_sha256: SHA })
    expect(read.membership?.status).toBe('active')
    expect(read.accept_name).toBe('Ana Creator')
    expect(viewOf({ accept_name: '' }).accept_name).toBeNull()
    expect(viewOf().membership).toBeNull()
    expect(() => readPartnerProgramView({ membership: null })).toThrow(MarketplaceUnreadable)
  })
})

describe('what each program failure means', () => {
  it.each([
    [{ code: 'P0002', details: 'program_not_found' }, 'program_not_found'],
    [{ code: 'P0002' }, 'program_not_found'],
    [{ code: '22023', details: 'program_not_open' }, 'program_not_open'],
    [{ code: '40001', details: 'terms_changed' }, 'terms_changed'],
    [{ code: '40001', details: null }, 'terms_changed'],
    [{ code: '22023', details: 'already_member' }, 'already_member'],
    [{ code: '22023', details: 'membership_closed' }, 'membership_closed'],
    [{ code: '22023', details: 'tracking_not_enabled' }, 'tracking_not_enabled'],
    [{ code: '22023', details: 'not_a_member' }, 'not_a_member'],
    [{ code: '22023', details: 'status_not_allowed' }, 'status_not_allowed'],
    [{ code: '22023', details: 'invalid_accept_name' }, 'name_missing'],
    [{ code: '22023', details: 'invalid_input' }, 'invalid_request'],
    [{ code: '22023', details: 'invalid_slug' }, 'invalid_request'],
    [{ code: '22023', details: 'invalid_terms_version' }, 'invalid_request'],
    [{ code: '22023', details: 'invalid_agreement_sha256' }, 'invalid_request'],
    [{ code: '22023', details: 'invalid_program_id' }, 'invalid_request'],
  ] as const)('maps %o to %s', (failure, code) => {
    expect(programFailure(failure)?.code).toBe(code)
  })

  it('leaves a failure it does not know to the general mapping', () => {
    expect(programFailure({ code: '42501' })).toBeNull()
    expect(programFailure({ code: '22023', details: 'something else entirely' })).toBeNull()
    expect(programFailure({ code: '22023', details: 'constructor' })).toBeNull()
    expect(programFailure({})).toBeNull()
  })

  it('has a short sentence for every code, with no code names in it', () => {
    const codes: PartnerProgramErrorCode[] = [
      'program_not_found',
      'program_not_open',
      'terms_changed',
      'already_member',
      'membership_closed',
      'tracking_not_enabled',
      'not_a_member',
      'status_not_allowed',
      'name_missing',
      'invalid_request',
      'not_authenticated',
      'not_authorized',
      'contract_unavailable',
      'not_configured',
      'temporarily_unavailable',
      'invalid_response',
      'unknown',
    ]
    for (const code of codes) {
      for (const step of ['load', 'change'] as const) {
        const message = programErrorMessage(programError(code), step)
        expect(message.length).toBeGreaterThan(10)
        expect(message.length).toBeLessThan(110)
        expect(message).not.toMatch(/_|partner data|test mode/i)
      }
    }
    expect(programErrorMessage(null)).toBe('That did not go through. Try again.')
  })

  it('says the things the brief asks for in plain words', () => {
    expect(programErrorMessage(programError('tracking_not_enabled'))).toBe(
      'Links are not available yet. Try again later.',
    )
    expect(programErrorMessage(programError('terms_changed'))).toMatch(/^The terms changed/)
    expect(programErrorMessage(programError('name_missing'))).toMatch(/^Add your name/)
    expect(programErrorMessage(programError('not_authorized'), 'change')).toBe(
      'Only the owner of this creator account can do this.',
    )
    expect(programErrorMessage(programError('not_authorized'), 'load')).toBe(
      'Your creator account is not active, so programs are not available to it.',
    )
  })

  it('lets only a failure that can pass be tried again', () => {
    expect(programError('tracking_not_enabled').retryable).toBe(true)
    expect(programError('temporarily_unavailable').retryable).toBe(true)
    expect(programError('not_authorized').retryable).toBe(false)
    expect(programError('contract_unavailable').retryable).toBe(false)
    expect(programError('program_not_found').retryable).toBe(false)
  })
})

describe('where a creator stands with a program', () => {
  it.each([
    ['active', 'live', false, 'Active', 'good'],
    ['active', 'live', true, 'New terms', 'waiting'],
    ['active', 'paused', false, 'Paused', 'waiting'],
    ['active', 'archived', false, 'Ended', 'quiet'],
    ['pending', 'live', false, 'Waiting', 'waiting'],
    ['pending', 'paused', false, 'Waiting', 'waiting'],
    ['declined', 'live', false, 'Declined', 'quiet'],
    ['removed', 'live', false, 'Removed', 'quiet'],
    ['left', 'paused', false, 'Left', 'quiet'],
  ] as const)('%s in a %s program (new terms: %s) is %s', (status, program, terms, label, tone) => {
    expect(membershipStanding(status, program, terms)).toEqual({ label, tone })
  })

  it('hands out the short address when there is one', () => {
    expect(shareableLink({ url: LONG_LINK, short_url: SHORT_LINK, working: true })).toBe(SHORT_LINK)
    expect(shareableLink({ url: LONG_LINK, short_url: null, working: true })).toBe(LONG_LINK)
  })
})

describe('the program a signed-out visitor wanted', () => {
  it('is kept in this browser and handed over once', () => {
    rememberWantedProgram('speaksix')
    expect(peekWantedProgram()).toBe('speaksix')
    expect(peekWantedProgram()).toBe('speaksix')
    expect(takeWantedProgram()).toBe('speaksix')
    expect(takeWantedProgram()).toBeNull()
  })

  it('stores the slug and an expiry and nothing else', () => {
    rememberWantedProgram('speaksix', 1_000)
    expect(Object.keys(localStorage)).toEqual(['kma:partner:wanted-program'])
    expect(JSON.parse(localStorage.getItem('kma:partner:wanted-program')!)).toEqual({
      slug: 'speaksix',
      expiresAt: 1_000 + 24 * 60 * 60 * 1000,
    })
  })

  it('is forgotten after a day, when cleared, and when what is stored is not a slug', () => {
    rememberWantedProgram('speaksix', 1_000)
    expect(peekWantedProgram(1_000 + 23 * 60 * 60 * 1000)).toBe('speaksix')
    expect(peekWantedProgram(1_000 + 24 * 60 * 60 * 1000)).toBeNull()
    expect(localStorage.getItem('kma:partner:wanted-program')).toBeNull()

    rememberWantedProgram('speaksix')
    clearWantedProgram()
    expect(peekWantedProgram()).toBeNull()

    rememberWantedProgram('../admin')
    rememberWantedProgram('Not A Slug')
    expect(localStorage.length).toBe(0)

    localStorage.setItem(
      'kma:partner:wanted-program',
      JSON.stringify({ slug: '<script>', expiresAt: Date.now() + 1_000 }),
    )
    expect(peekWantedProgram()).toBeNull()
    localStorage.setItem('kma:partner:wanted-program', 'not json')
    expect(peekWantedProgram()).toBeNull()
  })

  it('survives a browser that refuses storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => rememberWantedProgram('speaksix')).not.toThrow()
    expect(takeWantedProgram()).toBeNull()
  })

  it('reads ?program= from the address and takes it out again', () => {
    expect(wantedProgramFromSearch('?program=speaksix')).toBe('speaksix')
    expect(wantedProgramFromSearch('?campaign=qa&program=bc-learn')).toBe('bc-learn')
    expect(wantedProgramFromSearch('?program=Not%20A%20Slug')).toBeNull()
    expect(wantedProgramFromSearch('')).toBeNull()
    expect(
      wantedProgramClearedUrl({
        pathname: '/',
        search: '?program=speaksix',
        hash: '#auth/sign-up',
      }),
    ).toBe('/#auth/sign-up')
    expect(
      wantedProgramClearedUrl({
        pathname: '/',
        search: '?campaign=qa&program=speaksix',
        hash: '#auth/sign-in',
      }),
    ).toBe('/?campaign=qa#auth/sign-in')
  })
})

describe('the Marketplace page of the partner dashboard', () => {
  it('shows the grid taking shape while it loads, then every program', async () => {
    const { gateway, calls } = fakeGateway()
    let answer: (value: PartnerProgramResult<MarketplaceData | null>) => void = () => {}
    calls.getMarketplace.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    openList(gateway)

    expect(screen.getByRole('heading', { level: 1, name: 'Marketplace.' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading programs' })).toBeInTheDocument()
    expect(document.title).toBe('Marketplace · KissMyApps Partners')

    answer(ok(marketplaceOf()))
    expect(await screen.findByRole('link', { name: 'View program: SpeakSix' })).toHaveAttribute(
      'href',
      '#marketplace/speaksix',
    )
    expect(screen.getByRole('link', { name: 'View program: Fieldnote' })).toHaveAttribute(
      'href',
      '#marketplace/fieldnote',
    )
    expect(screen.queryByRole('status', { name: 'Loading programs' })).not.toBeInTheDocument()
    // With no memberships there is one list, so it needs no "Your programs" above it.
    expect(screen.queryByRole('heading', { name: 'Your programs' })).not.toBeInTheDocument()
    expect(screen.getByText('2 programs')).toBeInTheDocument()
  })

  it('says so when there are no programs at all', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(ok(marketplaceOf({ programs: [] })))
    openList(gateway)

    expect(await screen.findByRole('heading', { name: 'No programs yet' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('explains a failed load and loads again on Try again', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValueOnce(failed('temporarily_unavailable'))
    openList(gateway)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading')).toHaveTextContent('The marketplace did not load')
    expect(alert).toHaveTextContent('That did not go through. Check your connection and try again.')

    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'View program: SpeakSix' })).toBeInTheDocument()
    expect(calls.getMarketplace).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no retry for a failure that trying again cannot fix', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(failed('not_authorized'))
    openList(gateway)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Your creator account is not active, so programs are not available to it.',
    )
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
  })

  it('treats a gateway without the marketplace, and one that throws, as a failed load', async () => {
    const { unmount } = openList({} as PartnerDataGateway)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The marketplace is not available yet.',
    )
    unmount()

    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockRejectedValue(new Error('network'))
    openList(gateway)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Check your connection and try again.')
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('says links are not available yet while programs cannot be joined', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(ok(marketplaceOf({ tracking_ready: false })))
    openList(gateway)

    expect(
      await screen.findByText(
        'Links are not available yet, so programs cannot be joined right now.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View program: SpeakSix' })).toBeInTheDocument()
  })

  it('shows an active membership with its whole link, and the creator’s standing on the grid', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(
      ok(
        marketplaceOf({
          programs: [
            { ...speaksixCard, membership_status: 'active' },
            { ...fieldnoteCard, membership_status: 'pending' },
          ],
          memberships: [membershipRow(), pendingRow()],
        }),
      ),
    )
    openList(gateway)

    expect(await screen.findByRole('heading', { name: 'Your programs' })).toBeInTheDocument()
    const active = memberCard('SpeakSix')
    expect(active.getByRole('link', { name: 'SpeakSix' })).toHaveAttribute(
      'href',
      '#marketplace/speaksix',
    )
    expect(active.getByText('Active')).toBeInTheDocument()
    expect(active.getByText('30% of every payment for 12 months')).toBeInTheDocument()
    expect(shownLink('SpeakSix', active)).toHaveTextContent(SHORT_LINK)
    expect(active.getByRole('button', { name: 'Copy' })).toBeInTheDocument()

    const waiting = memberCard('Fieldnote')
    expect(waiting.getByText('Waiting')).toBeInTheDocument()
    expect(waiting.getByText('Waiting for Fieldnote GmbH to approve.')).toBeInTheDocument()
    expect(waiting.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()

    const all = within(screen.getByRole('region', { name: 'All programs' }))
    const speaksix = all.getByRole('link', { name: 'View program: SpeakSix' }).closest('article')!
    expect(within(speaksix).getByText('Active')).toBeInTheDocument()
    const fieldnote = all.getByRole('link', { name: 'View program: Fieldnote' }).closest('article')!
    expect(within(fieldnote).getByText('Waiting')).toBeInTheDocument()
  })

  it('falls back to the long address when the link has no short one', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(
      ok(
        marketplaceOf({
          memberships: [
            membershipRow({ link: { url: LONG_LINK, short_url: null, working: true } }),
          ],
        }),
      ),
    )
    openList(gateway)

    await screen.findByRole('heading', { name: 'Your programs' })
    expect(shownLink('SpeakSix', memberCard('SpeakSix'))).toHaveTextContent(LONG_LINK)
  })

  it('copies the link, and selects it when the clipboard refuses', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(ok(marketplaceOf({ memberships: [membershipRow()] })))
    openList(gateway)

    await screen.findByRole('heading', { name: 'Your programs' })
    await user.click(memberCard('SpeakSix').getByRole('button', { name: 'Copy' }))
    expect(copy).toHaveBeenCalledWith(SHORT_LINK)
    expect(await memberCard('SpeakSix').findByRole('button', { name: 'Copied' })).toBeEnabled()

    copy.mockRejectedValueOnce(new Error('denied'))
    await user.click(memberCard('SpeakSix').getByRole('button', { name: 'Copied' }))
    expect(
      await memberCard('SpeakSix').findByText('The link is selected. Copy it with your keyboard.'),
    ).toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe(SHORT_LINK)
  })

  it('says what a paused program and new terms mean for an active member', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(
      ok(
        marketplaceOf({
          memberships: [
            membershipRow({ program_status: 'paused', link: { url: LONG_LINK, working: false } }),
            membershipRow({
              id: 'mem-2',
              program_id: 'prog-2',
              program: fieldnoteCard,
              needs_new_terms: true,
            }),
          ],
        }),
      ),
    )
    openList(gateway)

    await screen.findByRole('heading', { name: 'Your programs' })
    const paused = memberCard('SpeakSix')
    expect(paused.getByText('Paused')).toBeInTheDocument()
    expect(
      paused.getByText(
        'Paused by SpeakSix Ltd: your link still opens the page but sales are not credited.',
      ),
    ).toBeInTheDocument()
    // The link still opens the page, so it stays on the card.
    expect(shownLink('SpeakSix', paused)).toHaveTextContent(LONG_LINK)

    const terms = memberCard('Fieldnote')
    expect(terms.getByText('New terms')).toBeInTheDocument()
    expect(terms.getByRole('link', { name: 'New terms to accept' })).toHaveAttribute(
      'href',
      '#marketplace/fieldnote',
    )
  })

  it('shows ended memberships with the merchant’s note and no link', async () => {
    const program = (slug: string, name: string) => ({ ...speaksixCard, slug, name })
    const { gateway, calls } = fakeGateway()
    calls.getMarketplace.mockResolvedValue(
      ok(
        marketplaceOf({
          memberships: [
            membershipRow({
              id: 'm-declined',
              program: program('declined-app', 'Declined App'),
              status: 'declined',
              link: null,
              ended_at: WHEN,
              decision_note: 'We only work with fitness creators.',
            }),
            membershipRow({
              id: 'm-removed',
              program: program('removed-app', 'Removed App'),
              status: 'removed',
              link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
              ended_at: WHEN,
              decision_note: 'Coupon sites are not allowed.',
            }),
            membershipRow({
              id: 'm-left',
              program: program('left-app', 'Left App'),
              status: 'left',
              link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
              ended_at: WHEN,
            }),
            membershipRow({
              id: 'm-ended',
              program: program('ended-app', 'Ended App'),
              program_status: 'archived',
              needs_new_terms: true,
              link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
            }),
          ],
        }),
      ),
    )
    openList(gateway)

    await screen.findByRole('heading', { name: 'Your programs' })
    const declined = memberCard('Declined App')
    expect(declined.getByText('Declined')).toBeInTheDocument()
    expect(declined.getByText('SpeakSix Ltd declined your request.')).toBeInTheDocument()
    expect(declined.getByText('We only work with fitness creators.')).toBeInTheDocument()

    const removed = memberCard('Removed App')
    expect(removed.getByText('Removed')).toBeInTheDocument()
    expect(removed.getByText('SpeakSix Ltd removed you from this program.')).toBeInTheDocument()
    expect(removed.getByText('Coupon sites are not allowed.')).toBeInTheDocument()
    expect(removed.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()

    const left = memberCard('Left App')
    expect(left.getByText('Left')).toBeInTheDocument()
    expect(left.getByText('You left this program.')).toBeInTheDocument()
    expect(left.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()

    const ended = memberCard('Ended App')
    expect(ended.getByText('Ended')).toBeInTheDocument()
    expect(ended.getByText('This program has ended.')).toBeInTheDocument()
    expect(ended.queryByRole('link', { name: 'New terms to accept' })).not.toBeInTheDocument()
  })
})

describe('joining a program', () => {
  it('shows the agreement beside the box that accepts it', async () => {
    const { gateway, calls } = fakeGateway()
    let answer: (value: PartnerProgramResult<PartnerProgramView | null>) => void = () => {}
    calls.getProgram.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    openProgram(gateway)

    expect(screen.getByRole('status', { name: 'Loading the agreement' })).toBeInTheDocument()
    expect(calls.getProgram).toHaveBeenCalledWith('speaksix')

    answer(ok(viewOf()))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(document.title).toBe('SpeakSix · KissMyApps Partners')

    const agreement = within(screen.getByRole('article', { name: 'SpeakSix Affiliate Agreement' }))
    expect(
      agreement.getByText('Between SpeakSix Ltd and Ana Creator · Version 1'),
    ).toBeInTheDocument()
    expect(
      agreement.getByText('Commission', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('30% of every payment for 12 months')
    expect(agreement.getByText('Minimum payout').nextElementSibling).toHaveTextContent('$20.00')
    expect(
      agreement.getByRole('heading', { level: 3, name: '1 Who this agreement is between' }),
    ).toBeInTheDocument()

    expect(side().getByRole('heading', { name: 'Accept and get your link' })).toBeInTheDocument()
    expect(side().getByText('Ana Creator')).toBeInTheDocument()
    expect(agreeBox()).not.toBeChecked()
    expect(side().getByRole('button', { name: 'Accept and get my link' })).toBeEnabled()
    expect(side().getByText('We record the version you accepted and the date.')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Marketplace/SpeakSix',
    )
  })

  it('asks for the box to be ticked before it sends anything', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    openProgram(gateway)

    await user.click(await screen.findByRole('button', { name: 'Accept and get my link' }))
    expect(side().getByRole('alert')).toHaveTextContent(
      'Tick the box to confirm you have read the agreement.',
    )
    expect(agreeBox()).toBeInvalid()
    expect(calls.joinProgram).not.toHaveBeenCalled()

    await user.click(agreeBox())
    expect(side().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('joins an automatic program with the version and hash on screen and shows the link', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    const { gateway, calls } = fakeGateway()
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(calls.joinProgram).toHaveBeenCalledExactlyOnceWith({
      slug: 'speaksix',
      termsVersion: 1,
      agreementSha256: SHA,
    })
    expect(await side().findByText('You joined SpeakSix.')).toBeInTheDocument()
    expect(side().getByRole('heading', { name: 'Your link' })).toBeInTheDocument()
    expect(side().getByText('Active')).toBeInTheDocument()
    expect(shownLink('SpeakSix', side())).toHaveTextContent(SHORT_LINK)
    expect(side().getByText('Sales that come through this link are credited to you.')).toBeVisible()
    expect(
      side().getByText(/^Accepted as Ana Creator on .*2026.* · Version 1$/),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'SpeakSix' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(side().getByRole('button', { name: 'Copy' }))
    expect(copy).toHaveBeenCalledWith(SHORT_LINK)
    // Nothing was fetched again: the answer to joining is the membership.
    expect(calls.getProgram).toHaveBeenCalledTimes(1)
  })

  it('asks to join a manual program and then waits for the merchant', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(ok(viewOf({ program: fieldnoteDetail })))
    calls.joinProgram.mockResolvedValue(ok(readMembership(pendingRow())))
    openProgram(gateway, 'fieldnote')
    await loaded()

    expect(
      await side().findByRole('heading', { name: 'Accept and ask to join' }),
    ).toBeInTheDocument()
    expect(side().getByText(/Fieldnote GmbH approves each creator/)).toBeInTheDocument()
    await user.click(agreeBox())
    await user.click(side().getByRole('button', { name: 'Accept and ask to join' }))

    expect(calls.joinProgram).toHaveBeenCalledExactlyOnceWith({
      slug: 'fieldnote',
      termsVersion: 1,
      agreementSha256: SHA,
    })
    expect(await side().findByText('Your request was sent to Fieldnote GmbH.')).toBeInTheDocument()
    expect(side().getByRole('heading', { name: 'Waiting for approval' })).toBeInTheDocument()
    expect(side().getByText('Waiting')).toBeInTheDocument()
    expect(side().getByText(/Your link appears here as soon as they approve you/)).toBeVisible()
    expect(side().queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
    expect(side().getByRole('button', { name: 'Cancel request' })).toBeInTheDocument()
  })

  it('reloads the agreement when the terms changed and asks again', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockResolvedValueOnce(failed('terms_changed'))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: {
            ...speaksixDetail,
            terms_version: 2,
            agreement_sha256: NEW_SHA,
            agreement: {
              ...speaksixDetail.agreement,
              summary: [{ label: 'Commission', value: '25% of every payment for 12 months' }],
            },
          },
        }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(await side().findByRole('alert')).toHaveTextContent(
      'The terms changed while this page was open. This is the latest agreement. Read it and accept again.',
    )
    expect(calls.getProgram).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Between SpeakSix Ltd and Ana Creator · Version 2')).toBeInTheDocument()
    expect(screen.getByText('25% of every payment for 12 months')).toBeInTheDocument()
    expect(agreeBox()).not.toBeChecked()
    expect(screen.getByRole('complementary', { name: 'Your membership' })).toHaveFocus()

    await user.click(agreeBox())
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))
    expect(calls.joinProgram).toHaveBeenLastCalledWith({
      slug: 'speaksix',
      termsVersion: 2,
      agreementSha256: NEW_SHA,
    })
    expect(await side().findByText('You joined SpeakSix.')).toBeInTheDocument()
    expect(side().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says links are not available yet and keeps the form as it was', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockResolvedValue(failed('tracking_not_enabled'))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(await side().findByRole('alert')).toHaveTextContent(
      'Links are not available yet. Try again later.',
    )
    expect(agreeBox()).toBeChecked()
    expect(screen.getByRole('button', { name: 'Accept and get my link' })).toBeEnabled()
    expect(calls.getProgram).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['name_missing', /^Add your name in your profile first/],
    ['not_authorized', 'Only the owner of this creator account can do this.'],
    ['invalid_request', 'That could not be sent. Reload the page and try again.'],
    ['membership_closed', /^Your membership of this program was closed/],
    ['temporarily_unavailable', 'That did not go through. Check your connection and try again.'],
    ['not_authenticated', 'Your session has expired. Sign in again to continue.'],
  ] as const)('explains %s in words when joining fails', async (code, message) => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockResolvedValue(failed(code))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(await side().findByRole('alert')).toHaveTextContent(message)
    expect(side().queryByText(/You joined/)).not.toBeInTheDocument()
  })

  it('shows the link they already have when the program says they are a member', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockResolvedValue(failed('already_member'))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    calls.getProgram.mockResolvedValue(ok(viewOf({ membership: membershipRow() })))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(await side().findByRole('heading', { name: 'Your link' })).toBeInTheDocument()
    expect(shownLink('SpeakSix', side())).toHaveTextContent(SHORT_LINK)
    expect(side().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the program as closed when it stopped taking creators meanwhile', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockResolvedValue(failed('program_not_open'))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    calls.getProgram.mockResolvedValue(
      ok(viewOf({ program: { ...speaksixDetail, status: 'paused' } })),
    )
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(
      await side().findByRole('heading', { name: 'Not taking new creators' }),
    ).toBeInTheDocument()
    expect(side().getByRole('alert')).toHaveTextContent(
      'This program is not taking new creators right now.',
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('treats a join that throws, and a gateway that cannot join, as a failure it explains', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.joinProgram.mockRejectedValue(new Error('network'))
    const { unmount } = openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))
    expect(await side().findByRole('alert')).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    )
    unmount()

    const older = { getProgram: calls.getProgram } as unknown as PartnerDataGateway
    openProgram(older)
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))
    expect(await side().findByRole('alert')).toHaveTextContent(
      'The marketplace is not available yet.',
    )
  })

  it('sends a creator with no name to their profile instead of offering the box', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(ok(viewOf({ accept_name: '' })))
    openProgram(gateway)
    await loaded()

    expect(await side().findByText('Add your name first.')).toBeInTheDocument()
    expect(side().getByRole('link', { name: 'Open your profile' })).toHaveAttribute(
      'href',
      '#profile',
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Accept/ })).not.toBeInTheDocument()
    expect(screen.getByText('Between SpeakSix Ltd and you · Version 1')).toBeInTheDocument()
  })

  it('does not offer a paused program to someone who is not in it', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(viewOf({ program: { ...speaksixDetail, status: 'paused' } })),
    )
    openProgram(gateway)
    await loaded()

    expect(
      await side().findByRole('heading', { name: 'Not taking new creators' }),
    ).toBeInTheDocument()
    expect(
      side().getByText('SpeakSix Ltd has paused this program. Check back later.'),
    ).toBeVisible()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('says a program was not found, with a way back', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(failed('program_not_found'))
    openProgram(gateway, 'gone')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Program not found' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the marketplace' })).toHaveAttribute(
      'href',
      '#marketplace',
    )
    expect(document.title).toBe('Marketplace · KissMyApps Partners')
  })

  it('explains a program that did not load and loads it again on Try again', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValueOnce(failed('temporarily_unavailable'))
    openProgram(gateway)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading')).toHaveTextContent('This program did not load')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(calls.getProgram).toHaveBeenCalledTimes(2)
  })
})

describe('a program the creator is already in', () => {
  it('shows an active member their link, when they accepted, and a quiet way to leave', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(ok(viewOf({ membership: membershipRow() })))
    openProgram(gateway)

    expect(await screen.findByRole('heading', { level: 1, name: 'SpeakSix' })).toBeInTheDocument()
    expect(side().getByRole('heading', { name: 'Your link' })).toBeInTheDocument()
    expect(shownLink('SpeakSix', side())).toHaveTextContent(SHORT_LINK)
    expect(side().getByText(/^Accepted as Ana Creator on/)).toBeInTheDocument()
    expect(side().getByRole('button', { name: 'Leave program' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(side().queryByRole('heading', { name: 'New terms to accept' })).not.toBeInTheDocument()
  })

  it('tells an active member what a paused program means for their link', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: { ...speaksixDetail, status: 'paused' },
          membership: membershipRow({
            program_status: 'paused',
            link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
          }),
        }),
      ),
    )
    openProgram(gateway)
    await loaded()

    expect(await side().findByText('Paused')).toBeInTheDocument()
    expect(
      side().getByText(
        'Paused by SpeakSix Ltd: your link still opens the page but sales are not credited.',
      ),
    ).toBeInTheDocument()
    expect(shownLink('SpeakSix', side())).toHaveTextContent(SHORT_LINK)
  })

  it('accepts new terms with the version and hash on screen', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: { ...speaksixDetail, terms_version: 2, agreement_sha256: NEW_SHA },
          membership: membershipRow({ needs_new_terms: true }),
        }),
      ),
    )
    openProgram(gateway)
    await loaded()

    expect(await side().findByRole('heading', { name: 'New terms to accept' })).toBeInTheDocument()
    expect(side().getByText(/SpeakSix Ltd published version 2/)).toBeInTheDocument()
    // The link keeps working under the version they accepted before.
    expect(shownLink('SpeakSix', side())).toHaveTextContent(SHORT_LINK)

    await user.click(side().getByRole('button', { name: 'Accept new terms' }))
    expect(side().getByRole('alert')).toHaveTextContent('Tick the box')
    expect(calls.acceptProgramTerms).not.toHaveBeenCalled()

    await user.click(agreeBox())
    await user.click(side().getByRole('button', { name: 'Accept new terms' }))
    expect(calls.acceptProgramTerms).toHaveBeenCalledExactlyOnceWith({
      programId: 'prog-1',
      termsVersion: 2,
      agreementSha256: NEW_SHA,
    })
    expect(await side().findByText('New terms accepted.')).toBeInTheDocument()
    expect(side().queryByRole('heading', { name: 'New terms to accept' })).not.toBeInTheDocument()
    expect(side().getByText(/· Version 2$/)).toBeInTheDocument()
  })

  it('reloads when the terms changed again before they were accepted', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    const withTerms = (version: number, sha: string) =>
      ok(
        viewOf({
          program: { ...speaksixDetail, terms_version: version, agreement_sha256: sha },
          membership: membershipRow({ needs_new_terms: true }),
        }),
      )
    calls.getProgram.mockResolvedValueOnce(withTerms(2, NEW_SHA))
    calls.acceptProgramTerms.mockResolvedValueOnce(failed('terms_changed'))
    openProgram(gateway)

    await user.click(await screen.findByRole('checkbox'))
    calls.getProgram.mockResolvedValue(withTerms(3, 'c'.repeat(64)))
    await user.click(side().getByRole('button', { name: 'Accept new terms' }))

    expect(await side().findByText(/^The terms changed while this page was open/)).toBeVisible()
    expect(side().getByText(/published version 3/)).toBeInTheDocument()
    expect(agreeBox()).not.toBeChecked()
  })

  it('leaves only after a confirmation, and can then join again', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(ok(viewOf({ membership: membershipRow() })))
    openProgram(gateway)
    await loaded()

    await user.click(await side().findByRole('button', { name: 'Leave program' }))
    const confirm = within(side().getByRole('group', { name: 'Leave program' }))
    expect(
      confirm.getByText('Leave SpeakSix? Sales from your link will no longer be credited to you.'),
    ).toBeInTheDocument()
    expect(calls.leaveProgram).not.toHaveBeenCalled()

    await user.click(confirm.getByRole('button', { name: 'Stay in the program' }))
    expect(side().queryByRole('group', { name: 'Leave program' })).not.toBeInTheDocument()
    expect(calls.leaveProgram).not.toHaveBeenCalled()

    await user.click(side().getByRole('button', { name: 'Leave program' }))
    await user.click(
      within(side().getByRole('group', { name: 'Leave program' })).getByRole('button', {
        name: 'Leave program',
      }),
    )
    expect(calls.leaveProgram).toHaveBeenCalledExactlyOnceWith('prog-1')
    expect(await side().findByText('You left SpeakSix.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Join SpeakSix' })).toBeInTheDocument()
    expect(side().queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
    expect(agreeBox()).not.toBeChecked()
  })

  it('cancels a request that is still waiting', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(viewOf({ program: fieldnoteDetail, membership: pendingRow() })),
    )
    calls.leaveProgram.mockResolvedValue(
      ok(readMembership(pendingRow({ status: 'left', ended_at: WHEN }))),
    )
    openProgram(gateway, 'fieldnote')
    await loaded()

    expect(await side().findByRole('heading', { name: 'Waiting for approval' })).toBeVisible()
    await user.click(side().getByRole('button', { name: 'Cancel request' }))
    const confirm = within(side().getByRole('group', { name: 'Cancel request' }))
    expect(confirm.getByText('Cancel your request to join Fieldnote?')).toBeInTheDocument()
    expect(confirm.getByRole('button', { name: 'Keep waiting' })).toBeInTheDocument()

    await user.click(confirm.getByRole('button', { name: 'Cancel request' }))
    expect(calls.leaveProgram).toHaveBeenCalledExactlyOnceWith('prog-2')
    expect(await side().findByText('Your request was cancelled.')).toBeInTheDocument()
    expect(side().getByRole('button', { name: 'Accept and ask to join' })).toBeInTheDocument()
  })

  it('shows no link to someone who asked again and is waiting, even if an old one exists', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: fieldnoteDetail,
          membership: pendingRow({
            link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
            activated_at: WHEN,
          }),
        }),
      ),
    )
    openProgram(gateway, 'fieldnote')
    await loaded()

    expect(await side().findByRole('heading', { name: 'Waiting for approval' })).toBeVisible()
    expect(side().queryByText(/go\.kissmyapps\.dev/)).not.toBeInTheDocument()
    expect(side().queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })

  it('explains a leave that the program refuses and shows where things stand now', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValueOnce(ok(viewOf({ membership: membershipRow() })))
    calls.leaveProgram.mockResolvedValue(failed('not_a_member'))
    openProgram(gateway)
    await loaded()

    await user.click(await side().findByRole('button', { name: 'Leave program' }))
    await user.click(
      within(side().getByRole('group', { name: 'Leave program' })).getByRole('button', {
        name: 'Leave program',
      }),
    )

    expect(await side().findByRole('alert')).toHaveTextContent(
      'You are not a member of this program.',
    )
    expect(calls.getProgram).toHaveBeenCalledTimes(2)
    expect(side().getByRole('heading', { name: 'Accept and get your link' })).toBeInTheDocument()
  })

  it('does not call the backend to leave when the program’s id is unknown', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: { ...speaksixDetail, id: undefined },
          membership: membershipRow({ program_id: undefined }),
        }),
      ),
    )
    openProgram(gateway)
    await loaded()

    await user.click(await side().findByRole('button', { name: 'Leave program' }))
    await user.click(
      within(side().getByRole('group', { name: 'Leave program' })).getByRole('button', {
        name: 'Leave program',
      }),
    )
    expect(await side().findByRole('alert')).toHaveTextContent(
      'That is not available right now. Try again later.',
    )
    expect(calls.leaveProgram).not.toHaveBeenCalled()
  })

  it('uses the program’s own id when the membership does not carry one', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(viewOf({ membership: membershipRow({ program_id: undefined }) })),
    )
    openProgram(gateway)
    await loaded()

    await user.click(await side().findByRole('button', { name: 'Leave program' }))
    await user.click(
      within(side().getByRole('group', { name: 'Leave program' })).getByRole('button', {
        name: 'Leave program',
      }),
    )
    await waitFor(() => expect(calls.leaveProgram).toHaveBeenCalledExactlyOnceWith('prog-1'))
  })

  it.each([
    [
      'declined',
      'Request declined',
      'SpeakSix Ltd declined your request to join.',
      'We only work with fitness creators.',
    ],
    [
      'removed',
      'Removed from this program',
      'SpeakSix Ltd removed you from this program. Your link no longer credits sales.',
      'Coupon sites are not allowed.',
    ],
  ] as const)(
    'shows a %s creator the decision and the merchant’s note',
    async (status, title, line, note) => {
      const { gateway, calls } = fakeGateway()
      calls.getProgram.mockResolvedValue(
        ok(
          viewOf({
            membership: membershipRow({
              status,
              ended_at: WHEN,
              decision_note: note,
              link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
            }),
          }),
        ),
      )
      openProgram(gateway)
      await loaded()

      expect(await side().findByRole('heading', { name: title })).toBeInTheDocument()
      expect(side().getByText(line)).toBeInTheDocument()
      expect(side().getByText(note)).toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(side().queryByRole('button')).not.toBeInTheDocument()
      expect(side().queryByText(/go\.kissmyapps\.dev/)).not.toBeInTheDocument()
    },
  )

  it('lets someone who left join again', async () => {
    const user = userEvent.setup()
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(viewOf({ membership: membershipRow({ status: 'left', ended_at: WHEN }) })),
    )
    openProgram(gateway)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(
      side().getByText('You left this program. Accept the agreement to join it again.'),
    ).toBeInTheDocument()
    await user.click(agreeBox())
    await user.click(side().getByRole('button', { name: 'Accept and get my link' }))
    expect(await side().findByText('You joined SpeakSix.')).toBeInTheDocument()
  })

  it('shows a member an ended program with nothing left to accept or leave', async () => {
    const { gateway, calls } = fakeGateway()
    calls.getProgram.mockResolvedValue(
      ok(
        viewOf({
          program: { ...speaksixDetail, status: 'archived' },
          membership: membershipRow({
            program_status: 'archived',
            needs_new_terms: true,
            link: { url: LONG_LINK, short_url: SHORT_LINK, working: false },
          }),
        }),
      ),
    )
    openProgram(gateway)
    await loaded()

    expect(await side().findByRole('heading', { name: 'This program has ended' })).toBeVisible()
    expect(side().getByText('SpeakSix Ltd closed it. Your link no longer works.')).toBeVisible()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(side().queryByRole('button')).not.toBeInTheDocument()
    expect(side().queryByText(/go\.kissmyapps\.dev/)).not.toBeInTheDocument()
  })
})
