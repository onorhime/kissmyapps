import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PartnerDataGateway } from '../api'
import { readProgramLinks } from './links'
import type { ProgramLinks, ProgramLinksResult } from './links'
import { linksEventsFixture as hand } from './links.events.fixture'
import { linksSampleFixture } from './links.fixture'
import { linksRewardsBackendFixture as backend } from './links.rewards-backend.fixture'
import { ProgramLinksPage } from './ProgramLinksPage'

const ok = <T,>(data: T): ProgramLinksResult<T | null> => ({ data, status: 'ready', error: null })

function renderAnswer(answer: unknown) {
  const getProgramLinks = vi.fn(async () => ok<ProgramLinks>(readProgramLinks(answer)))
  const gateway = { getProgramLinks } as unknown as PartnerDataGateway
  return render(<ProgramLinksPage gateway={gateway} />)
}

/** The page's markup, with React's generated ids made the same from one render to the next. */
const markup = (container: HTMLElement) => container.innerHTML.replace(/_r_[0-9a-z]+_/g, 'id')

const results = () => screen.findByRole('table', { name: 'Results by channel' })
const columns = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent)
/** The numbers of a link's row, after its address. */
function numbers(table: HTMLElement, name: string) {
  const row = within(table)
    .getAllByRole('row')
    .find((element) => within(element).queryByRole('rowheader')?.textContent === name)!
  return within(row)
    .getAllByRole('cell')
    .slice(1)
    .map((cell) => cell.textContent)
}

describe('the Links page of a program that pays for events', () => {
  it('counts events in place of sales, and converts clicks into events', async () => {
    renderAnswer(backend.partner_program_links_events_program)
    const table = await results()

    expect(columns(table)).toEqual([
      'Channel',
      'Link',
      'Clicks',
      'Events',
      'Conversion',
      'Earnings',
    ])
    expect(numbers(table, 'Main link')).toEqual(['1', '2', '200.0%', '$7.00'])
    // No click, no rate: a dash and not 0%.
    expect(numbers(table, 'TikTok')).toEqual(['0', '0', '—', '$0.00'])
    expect(screen.getByText(/compare where your events come from\./)).toBeTruthy()
    expect(screen.getByText('Live')).toBeTruthy()
    expect(table.closest('section')!.className).not.toContain('pl-results-wide')
  })

  it('says a paused program does not credit events', async () => {
    renderAnswer(hand.events_paused)
    await results()
    expect(screen.getByText('Paused by the brand: events are not credited right now.')).toBeTruthy()
  })
})

describe('the Links page of a program that pays for sales and events', () => {
  it('puts events beside sales, and keeps converting clicks into sales', async () => {
    const user = userEvent.setup()
    renderAnswer(backend.partner_program_links_both_program)
    await results()
    await user.click(
      within(screen.getByRole('group', { name: 'Program' })).getByRole('button', {
        name: 'Rival Reader',
      }),
    )

    const table = await results()
    expect(columns(table)).toEqual([
      'Channel',
      'Link',
      'Clicks',
      'Events',
      'Sales',
      'Conversion',
      'Earnings',
    ])
    expect(numbers(table, 'Main link')).toEqual(['1', '1', '2', '200.0%', '$18.00'])
    expect(numbers(table, 'TikTok')).toEqual(['1', '1', '0', '0.0%', '$10.00'])
    expect(table.closest('section')!.className).toContain('pl-results-wide')
    expect(screen.getByText(/compare where your sales and events come from\./)).toBeTruthy()
  })

  it('says an empty balance stops sales and events being credited', async () => {
    renderAnswer(hand.both_balance_empty)
    await results()
    expect(
      screen.getByText(
        'Paused: the brand’s balance is empty, so sales and events are not credited right now.',
      ),
    ).toBeTruthy()
  })

  it('switches back to a sales program without an Events column', async () => {
    const user = userEvent.setup()
    renderAnswer(backend.partner_program_links_both_program)
    await results()
    await user.click(
      within(screen.getByRole('group', { name: 'Program' })).getByRole('button', {
        name: 'Rival Reader',
      }),
    )
    await user.click(
      within(screen.getByRole('group', { name: 'Program' })).getByRole('button', {
        name: 'Quiet Club',
      }),
    )
    expect(columns(await results())).toEqual([
      'Channel',
      'Link',
      'Clicks',
      'Sales',
      'Conversion',
      'Earnings',
    ])
  })
})

describe('the Links page of programs that pay for sales, from a Phase 6 database', () => {
  it('looks exactly as it did before events could be rewarded', async () => {
    const before = renderAnswer(linksSampleFixture.partner_program_links)
    await results()
    const html = markup(before.container)
    before.unmount()

    const now = renderAnswer(hand.sales_programs)
    await results()
    expect(markup(now.container)).toBe(html)
  })
})
