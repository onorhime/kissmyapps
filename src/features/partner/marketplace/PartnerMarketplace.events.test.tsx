import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceUnreadable, programHeadline, programRewardsLine } from '../../marketplace/model'
import type { PartnerDataGateway } from '../api'
import { PartnerMarketplace } from './PartnerMarketplace'
import { readPartnerMarketplace, readPartnerProgramView } from './programs'
import type { PartnerMarketplace as MarketplaceData, PartnerProgramView } from './programs'
import { programsEventsFixture as hand } from './programs.events.fixture'
import { programsRewardsBackendFixture as backend } from './programs.rewards-backend.fixture'

type View = { program: Record<string, unknown>; membership: Record<string, unknown> | null }

const detailEvents = backend.partner_program_detail_events as View
const detailBoth = backend.partner_program_detail_both as View
const mixed = backend.marketplace_programs_mixed as { programs: Record<string, unknown>[] }

/**
 * The Marketplace page of a creator in the two captured programs: the cards of the captured
 * list, and the two memberships exactly as the program pages answered them.
 */
const marketplaceAnswer = {
  tracking_ready: true,
  programs: mixed.programs.map((program) => ({
    ...program,
    membership_status: program.slug === 'quiet-club' ? null : 'active',
  })),
  memberships: [detailEvents.membership, detailBoth.membership],
}

function gatewayFor({
  view,
  marketplace = marketplaceAnswer,
}: {
  view?: unknown
  marketplace?: unknown
}): PartnerDataGateway {
  return {
    getMarketplace: vi.fn(async () => ({
      data: readPartnerMarketplace(marketplace) as MarketplaceData,
      status: 'ready',
      error: null,
    })),
    getProgram: vi.fn(async () => ({
      data: readPartnerProgramView(view) as PartnerProgramView,
      status: 'ready',
      error: null,
    })),
    getProgramEarnings: vi.fn(async () => ({ data: null, status: 'empty', error: null })),
  } as unknown as PartnerDataGateway
}

const openProgram = (view: unknown) =>
  render(<PartnerMarketplace gateway={gatewayFor({ view })} slug="program" />)
const loaded = () => screen.findByRole('complementary', { name: 'Your membership' })
const earnList = () => screen.queryByRole('list', { name: 'What you earn' })
const items = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((item) => item.textContent)

beforeEach(() => {
  localStorage.clear()
})

// Reading ---------------------------------------------------------------------------------------

describe('the program functions and the real answers for programs that pay per event', () => {
  it('reads a program that pays for events: no commission, its rewards in order', () => {
    const { program, membership } = readPartnerProgramView(detailEvents)
    expect(program).toMatchObject({ slug: 'fluent', earn_from: 'events', commission_type: null })
    expect(program.rewards.map((reward) => [reward.label, reward.amount_minor])).toEqual([
      ['Account created', 300],
      ['Trial started', 500],
      ['First lesson', 100],
    ])
    expect(programHeadline(program)).toBe(
      '$3.00 per Account created, $5.00 per Trial started and 1 more reward',
    )
    expect(programRewardsLine(program)).toBeNull()
    expect(membership?.status).toBe('active')
    expect(membership?.program.earn_from).toBe('events')
  })

  it('reads a program that pays for both: the commission, plus rewards in a line of their own', () => {
    const { program } = readPartnerProgramView(detailBoth)
    expect(program).toMatchObject({ slug: 'rival-reader', earn_from: 'both' })
    expect(programHeadline(program)).toBe('20% of every payment for 6 months, plus rewards')
    expect(programRewardsLine(program)).toBe('$1.50 per First chapter read')
  })

  it('reads the cards of a creator in a program of each kind', () => {
    const marketplace = readPartnerMarketplace(marketplaceAnswer)
    expect(marketplace.programs.map((program) => [program.name, programHeadline(program)])).toEqual(
      [
        ['Rival Reader', '20% of every payment for 6 months, plus rewards'],
        ['Fluent', '$3.00 per Account created, $5.00 per Trial started and 1 more reward'],
        ['Quiet Club', '20% of every payment'],
      ],
    )
    expect(marketplace.memberships.map((membership) => membership.program.earn_from)).toEqual([
      'events',
      'both',
    ])
  })

  it('finds nobody in the answers but the creator’s own name: no email, no event id', () => {
    for (const answer of Object.values(backend)) {
      const text = JSON.stringify(answer)
      expect(text).not.toContain('@')
      expect(text).not.toMatch(/"(event_id|session_id|person_id|external_id|user_id)"/)
    }
  })

  it('refuses a card with neither a commission nor a reward', () => {
    const nothing = { ...mixed.programs[1], rewards: [], membership_status: null }
    expect(() => readPartnerMarketplace({ programs: [nothing], memberships: [] })).not.toThrow()
    expect(readPartnerMarketplace({ programs: [nothing], memberships: [] }).programs).toEqual([])
    expect(() =>
      readPartnerProgramView({
        ...detailEvents,
        program: { ...detailEvents.program, rewards: [] },
      }),
    ).toThrow(MarketplaceUnreadable)
  })
})

// The program page ------------------------------------------------------------------------------

describe('the page of a program that pays for events', () => {
  it('lists what a member earns for each event, and credits events to the link', async () => {
    openProgram(detailEvents)
    await loaded()
    expect(items(earnList()!)).toEqual([
      '$3.00 per Account created',
      '$5.00 per Trial started',
      '$1.00 per First lesson',
    ])
    expect(screen.getByText('Events that come through this link are credited to you.')).toBeTruthy()
    // The agreement says sales earn nothing; the side box never speaks of them.
    const side = within(screen.getByRole('complementary', { name: 'Your membership' }))
    expect(side.queryByText(/sales/i)).toBeNull()
  })

  it('lists the rewards before joining, beside the agreement to accept', async () => {
    openProgram(hand.detail_events)
    await loaded()
    expect(screen.getByRole('heading', { name: 'Accept and ask to join' })).toBeTruthy()
    expect(items(earnList()!)).toEqual(['$2.00 per Account created', '$5.00 per Trial started'])
  })
})

describe('the page of a program that pays for sales and events', () => {
  it('lists the commission, then each reward, and credits both to the link', async () => {
    openProgram(detailBoth)
    await loaded()
    expect(items(earnList()!)).toEqual([
      '20% of every payment for 6 months',
      '$1.50 per First chapter read',
    ])
    expect(
      screen.getByText('Sales and events that come through this link are credited to you.'),
    ).toBeTruthy()
  })
})

describe('the page of a program that pays for sales', () => {
  it('has no list of rewards and speaks of sales, as before', async () => {
    openProgram({
      ...detailBoth,
      program: { ...detailBoth.program, earn_from: 'sales', rewards: [] },
    })
    await loaded()
    expect(earnList()).toBeNull()
    expect(screen.queryByText('What you earn')).toBeNull()
    expect(screen.getByText('Sales that come through this link are credited to you.')).toBeTruthy()
  })
})

// The list ----------------------------------------------------------------------------------------

describe('the Marketplace page of a creator in programs that pay per event', () => {
  it('says what each program pays on its card, with a both program’s rewards under it', async () => {
    render(<PartnerMarketplace gateway={gatewayFor({})} slug={null} />)
    const yours = await screen.findByRole('region', { name: 'Your programs' })
    const card = (name: string) =>
      within(within(yours).getByRole('link', { name }).closest('article')!)

    expect(
      card('Fluent').getByText(
        '$3.00 per Account created, $5.00 per Trial started and 1 more reward',
      ),
    ).toBeTruthy()
    expect(
      card('Rival Reader').getByText('20% of every payment for 6 months, plus rewards'),
    ).toBeTruthy()
    expect(card('Rival Reader').getByText('$1.50 per First chapter read')).toBeTruthy()

    // The program still to join, on the cards to browse, says it in the same words.
    const browse = screen.getAllByRole('article').filter((article) => !yours.contains(article))
    const quiet = browse.find((article) => within(article).queryByText('Quiet Club'))!
    expect(within(quiet).getByText('20% of every payment')).toBeTruthy()
  })
})
