import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PartnerDataGateway } from '../api'
import { readProgramPerformance } from './performance'
import type { PerformanceQuery, ProgramPerformanceResult } from './performance'
import { performanceEventsFixture as hand } from './performance.events.fixture'
import { performanceRewardsBackendFixture as backend } from './performance.rewards-backend.fixture'
import { ProgramPerformancePage } from './ProgramPerformancePage'
import { useProgramPerformance } from './useProgramPerformance'

// The gateway ---------------------------------------------------------------------------------

function ok(data: unknown): ProgramPerformanceResult {
  const performance = readProgramPerformance(data)
  return { data: performance, status: performance.program ? 'ready' : 'empty', error: null }
}

function Page({ gateway }: { gateway: PartnerDataGateway }) {
  return <ProgramPerformancePage performance={useProgramPerformance(gateway)} />
}

function renderAnswer(data: unknown) {
  const getProgramPerformance = vi.fn((_query: PerformanceQuery) => Promise.resolve(ok(data)))
  const gateway = { getProgramPerformance } as unknown as PartnerDataGateway
  return render(<Page gateway={gateway} />)
}

const waitForResults = () => screen.findByRole('heading', { name: 'By channel' })

/** The labels of the figures across the top, in order. */
const figureLabels = () =>
  Array.from(document.querySelectorAll('.pp-figures dt')).map((term) => term.textContent)

/** The figure with this label: its value and the quiet line under it. */
function figure(label: string) {
  const term = Array.from(document.querySelectorAll('.pp-figures dt')).find(
    (element) => element.textContent === label,
  )!
  const [value, sub] = Array.from(term.parentElement!.querySelectorAll('dd'))
  return { value: value.textContent, sub: sub?.textContent ?? null }
}

const channelTable = () => screen.getByRole('table', { name: 'By channel' })
const columns = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent)
const row = (table: HTMLElement, name: string) =>
  within(table)
    .getAllByRole('row')
    .find((element) => within(element).queryByRole('rowheader')?.textContent?.startsWith(name))!
const cells = (element: HTMLElement) =>
  within(element)
    .getAllByRole('cell')
    .map((cell) => cell.textContent)

// A program that pays for events --------------------------------------------------------------

describe('the Performance page of a program that pays for events', () => {
  it('counts events where sales were, and converts clicks into events', async () => {
    renderAnswer(backend.partner_program_performance_events_days30)
    await waitForResults()

    expect(figureLabels()).toEqual([
      'Earnings',
      'Clicks',
      'Events',
      'Conversion rate',
      'Earnings per click',
    ])
    expect(figure('Earnings').value).toBe('$18.00')
    expect(figure('Events')).toEqual({ value: '6', sub: '+4 vs prior 30 days' })
    expect(figure('Conversion rate')).toEqual({ value: '100.0%', sub: 'Events ÷ clicks' })
    expect(screen.queryByText('Sales ÷ clicks')).toBeNull()

    expect(columns(channelTable())).toEqual([
      'Channel',
      'Clicks',
      'Events',
      'Conversion',
      'Earnings',
      'Per click',
    ])
    expect(cells(row(channelTable(), 'TikTok'))).toEqual(['3', '3', '100.0%', '$9.00', '$3.00'])
    // An event that came through no link: no click to divide by, so a dash and not 0%.
    const noLink = row(channelTable(), 'No link')
    expect(within(noLink).getByText('Events we could not tie to a link')).toBeTruthy()
    expect(cells(noLink)).toEqual(['0', '1', '—', '$2.00', '—'])
    expect(screen.getByText('4 other links had no clicks or events in these 30 days.')).toBeTruthy()

    const chartShows = screen.getByRole('group', { name: 'Chart shows' })
    expect(
      within(chartShows)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Clicks', 'Events', 'Earnings'])
    expect(screen.queryByRole('columnheader', { name: 'Sales' })).toBeNull()
  })

  it('shows what each reward brought, and no budget line while there is budget left', async () => {
    renderAnswer(backend.partner_program_performance_events_days30)
    await waitForResults()

    const rewards = screen.getByRole('table', { name: 'Rewards' })
    expect(columns(rewards)).toEqual(['Reward', 'Each', 'Events', 'Earnings'])
    expect(cells(row(rewards, 'Account created'))).toEqual(['$2.00', '4', '$8.00'])
    expect(cells(row(rewards, 'Trial started'))).toEqual(['$5.00', '2', '$10.00'])
    expect(screen.queryByText(/budget/i)).toBeNull()
  })

  it('lists the latest rewards by link and reward, with a rejected one at no amount', async () => {
    renderAnswer(backend.partner_program_performance_events_days30)
    await waitForResults()

    const latest = screen.getByRole('list', { name: 'Latest rewards' })
    const items = within(latest).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[1].textContent).toContain('TikTok · Trial started')
    expect(items[1].textContent).toContain('$5.00')
    const rejected = items[3]
    expect(rejected.className).toBe('pp-returned')
    expect(rejected.textContent).toContain('Main link · Account created')
    expect(within(rejected).getByText('Rejected')).toBeTruthy()
    expect(rejected.textContent).toContain('$0.00')
    expect(screen.queryByText('Returned')).toBeNull()
  })

  it('says a new member has had no clicks or events, and lists every reward at nothing', async () => {
    renderAnswer(hand.events_quiet)
    await screen.findByRole('heading', { name: 'Rewards' })

    expect(
      screen.getByText(/Your \d+ links had no clicks or events in these 30 days\./),
    ).toBeTruthy()
    const rewards = screen.getByRole('table', { name: 'Rewards' })
    for (const element of within(rewards).getAllByRole('row').slice(1))
      expect(cells(element).slice(1)).toEqual(['0', '$0.00'])
    expect(screen.getByText('No rewards yet.')).toBeTruthy()
    expect(figure('Conversion rate')).toEqual({ value: '—', sub: 'Events ÷ clicks' })
  })
})

// A program that pays for both ------------------------------------------------------------------

describe('the Performance page of a program that pays for sales and events', () => {
  it('puts events beside sales, and keeps converting clicks into sales', async () => {
    renderAnswer(backend.partner_program_performance_both_days30)
    await waitForResults()

    expect(figureLabels()).toEqual([
      'Earnings',
      'Clicks',
      'Events',
      'Sales',
      'Conversion rate',
      'Earnings per click',
    ])
    expect(figure('Conversion rate').sub).toBe('Sales ÷ clicks')
    expect(columns(channelTable())).toEqual([
      'Channel',
      'Clicks',
      'Events',
      'Sales',
      'Conversion',
      'Earnings',
      'Per click',
    ])
    expect(cells(row(channelTable(), 'TikTok'))).toEqual([
      '1',
      '1',
      '0',
      '0.0%',
      '$10.00',
      '$10.00',
    ])

    const latest = screen.getByRole('list', { name: 'Latest sales and rewards' })
    expect(
      within(latest)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.pp-latest-what')!.textContent!.split(' · ').slice(1)),
    ).toEqual([['Main link', 'Sign-up'], ['Main link'], ['TikTok', 'Free trial'], ['Main link']])
    expect(screen.getByRole('table', { name: 'Rewards' })).toBeTruthy()
  })
})

// The budget ---------------------------------------------------------------------------------

describe('a month whose reward budget is used up', () => {
  it('says so in one quiet line on the Rewards card, with no amount and nothing to do', async () => {
    renderAnswer(backend.partner_program_performance_budget_reached)
    await waitForResults()

    const line = screen.getByText('Budget reached for this month')
    expect(line.tagName).toBe('P')
    expect(line.closest('section')).toBe(
      screen.getByRole('heading', { name: 'Rewards' }).closest('section'),
    )
    expect(line.closest('[role="alert"], [role="status"]')).toBeNull()
    expect(within(line).queryByRole('button')).toBeNull()
    expect(line.textContent).not.toMatch(/\d/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never shows the line for a program that pays for sales, whatever the answer says', async () => {
    renderAnswer({
      ...(backend.partner_program_performance_sales_program as Record<string, unknown>),
      budget_reached: true,
    })
    await waitForResults()
    expect(screen.queryByText('Budget reached for this month')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Rewards' })).toBeNull()
  })
})

// A program that pays for sales -----------------------------------------------------------------

describe('the Performance page of a program that pays for sales, from a Phase 6 database', () => {
  it('looks exactly as it did before events could be rewarded', async () => {
    const before = renderAnswer(hand.sales_program_before)
    await waitForResults()
    await waitFor(() => expect(screen.getByRole('list', { name: 'Latest sales' })).toBeTruthy())
    const html = before.container.innerHTML
    before.unmount()

    const now = renderAnswer(hand.sales_program)
    await waitForResults()
    await waitFor(() => expect(screen.getByRole('list', { name: 'Latest sales' })).toBeTruthy())
    expect(now.container.innerHTML).toBe(html)
  })

  it('reads a real sales answer with no Events and no Rewards', async () => {
    renderAnswer(backend.partner_program_performance_sales_program)
    await waitForResults()
    expect(figureLabels()).toEqual([
      'Earnings',
      'Clicks',
      'Sales',
      'Conversion rate',
      'Earnings per click',
    ])
    expect(figure('Conversion rate').sub).toBe('Sales ÷ clicks')
    expect(screen.queryByText('Events')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Rewards' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Latest sales' })).toBeTruthy()
  })
})
