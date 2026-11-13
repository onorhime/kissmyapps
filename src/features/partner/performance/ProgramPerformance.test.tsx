import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import {
  PARTNER_RPCS,
  createPartnerDataGateway,
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
} from '../api'
import type {
  PartnerDataErrorCode,
  PartnerDataGateway,
  PartnerDataResult,
  PartnerProduct,
  PartnerSupabaseClient,
} from '../api'
import { LivePartnerPortal } from '../live/LivePartnerPortal'
import { PartnerLiveWorkspaceProvider } from '../live/PartnerLiveWorkspace'
import { readProgramPerformance } from './performance'
import type { PerformanceQuery, ProgramPerformance, ProgramPerformanceResult } from './performance'
import { performanceFixture as fixture } from './performance.fixture'
import { ProgramPerformancePage } from './ProgramPerformancePage'
import { useProgramPerformance } from './useProgramPerformance'

// Answers as the database sends them ----------------------------------------------------------

const speaksix = { program_id: 'prog-1', slug: 'speaksix', name: 'SpeakSix', currency: 'USD' }
const dramapal = { program_id: 'prog-2', slug: 'dramapal', name: 'DramaPal', currency: 'EUR' }
const programs = [dramapal, speaksix]

const DAY_MS = 86_400_000
const ENDS_ON = '2026-11-12'

type Numbers = { clicks: number; sales: number; earnings_minor: number }
const nothing: Numbers = { clicks: 0, sales: 0, earnings_minor: 0 }

/** One row per day ending on 12 November 2026. */
function dailyRows(days: number, numbers: (index: number) => Numbers = () => nothing) {
  const last = Date.parse(`${ENDS_ON}T00:00:00Z`)
  return Array.from({ length: days }, (_unused, index) => ({
    day: new Date(last - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    ...numbers(index),
  }))
}

function channel(name: string, numbers: Partial<Numbers> = {}, more: Record<string, unknown> = {}) {
  return {
    link_id: `link-${name.toLowerCase().replaceAll(' ', '-')}`,
    kind: 'channel',
    channel: name.toLowerCase(),
    name,
    ...nothing,
    ...numbers,
    ...more,
  }
}

const mainLink = (numbers: Partial<Numbers> = {}) =>
  channel('Main link', numbers, { kind: 'main', channel: null })

/** An answer for SpeakSix over 30 days with nothing in it, to be filled in by each test. */
function answer(overrides: Record<string, unknown> = {}) {
  const days = (overrides.days as number | undefined) ?? 30
  const daily = dailyRows(days)
  return {
    days,
    timezone: 'Europe/London',
    starts_on: daily[0].day,
    ends_on: ENDS_ON,
    programs,
    program: speaksix,
    totals: nothing,
    previous: nothing,
    daily,
    channels: [mainLink(), channel('TikTok'), channel('Instagram')],
    money: {
      pending_minor: 0,
      approved_minor: 0,
      paying_minor: 0,
      paid_minor: 0,
      next_release_at: null,
    },
    latest: [],
    ...overrides,
  }
}

/** The mockup's 30 days: 2,920 clicks, 70 sales, $420.00. */
function busyAnswer(overrides: Record<string, unknown> = {}) {
  return answer({
    totals: { clicks: 2920, sales: 70, earnings_minor: 42000 },
    previous: { clicks: 2508, sales: 59, earnings_minor: 35400 },
    daily: dailyRows(30, (index) =>
      index === 29
        ? { clicks: 20, sales: 12, earnings_minor: 7200 }
        : { clicks: 100, sales: 2, earnings_minor: 1200 },
    ),
    channels: [
      mainLink({ clicks: 58 }),
      channel('TikTok', { clicks: 1840, sales: 46, earnings_minor: 27600 }),
      channel('Instagram', { clicks: 622, sales: 11, earnings_minor: 6600 }),
      channel('YouTube', { clicks: 304, sales: 9, earnings_minor: 5400 }),
      channel('Facebook'),
      channel('X'),
      channel('Newsletter', { clicks: 96, sales: 4, earnings_minor: 2400 }),
    ],
    money: {
      pending_minor: 42000,
      approved_minor: 31800,
      paying_minor: 0,
      paid_minor: 110400,
      next_release_at: '2099-01-05T12:00:00.000000+00:00',
    },
    latest: [
      {
        paid_at: '2026-11-12T12:00:00.000000+00:00',
        link_name: 'TikTok',
        amount_minor: 600,
        status: 'held',
      },
      {
        paid_at: '2026-11-11T12:00:00.000000+00:00',
        link_name: 'YouTube',
        amount_minor: 600,
        status: 'approved',
      },
      {
        paid_at: '2026-11-10T12:00:00.000000+00:00',
        link_name: null,
        amount_minor: 0,
        status: 'reversed',
      },
    ],
    ...overrides,
  })
}

const dramapalAnswer = (overrides: Record<string, unknown> = {}) =>
  answer({
    program: dramapal,
    totals: { clicks: 270, sales: 4, earnings_minor: 5000 },
    previous: { clicks: 198, sales: 5, earnings_minor: 6250 },
    ...overrides,
  })

// The gateway ---------------------------------------------------------------------------------

function ok(data: unknown): ProgramPerformanceResult {
  const performance = readProgramPerformance(data)
  return { data: performance, status: performance.program ? 'ready' : 'empty', error: null }
}

function failed(code: PartnerDataErrorCode, retryable = true): ProgramPerformanceResult {
  return { data: null, status: 'error', error: { code, message: 'not for the page', retryable } }
}

type Read = (query: PerformanceQuery) => Promise<ProgramPerformanceResult>

/** Only the one call the page makes. */
function gatewayWith(getProgramPerformance?: Read): PartnerDataGateway {
  return { getProgramPerformance } as unknown as PartnerDataGateway
}

/** A read the test answers by hand, to look at the page while it waits. */
function deferred() {
  let resolve!: (result: ProgramPerformanceResult) => void
  const promise = new Promise<ProgramPerformanceResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function Page({ gateway, beside }: { gateway: PartnerDataGateway; beside?: boolean }) {
  return <ProgramPerformancePage performance={useProgramPerformance(gateway)} beside={beside} />
}

function renderPage(read: Read, beside = false) {
  const getProgramPerformance = vi.fn(read)
  const view = render(<Page gateway={gatewayWith(getProgramPerformance)} beside={beside} />)
  return { ...view, getProgramPerformance }
}

const group = (name: string) => screen.getByRole('group', { name })
const pressed = (name: string) =>
  within(group(name))
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent)

/** The figure with this label: its value and the quiet line under it. */
function figure(label: string) {
  const term = screen
    .getAllByText(label)
    .find((element) => element.tagName === 'DT' && element.closest('.pp-figures'))!
  const [value, sub] = Array.from(term.parentElement!.querySelectorAll('dd'))
  return { value: value.textContent, sub: sub?.textContent ?? null }
}

const waitForResults = () => screen.findByRole('heading', { name: 'By channel' })

// The page ------------------------------------------------------------------------------------

describe('the Performance page of a creator with programs', () => {
  it('asks for the first program over 30 days, and shows a skeleton until it arrives', async () => {
    const first = deferred()
    const { getProgramPerformance, container } = renderPage(() => first.promise)

    expect(getProgramPerformance).toHaveBeenCalledExactlyOnceWith({ slug: null, days: 30 })
    expect(screen.getByRole('status')).toHaveTextContent('Loading your results')
    expect(container.querySelector('.pp-page')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('group', { name: 'Days' })).not.toBeInTheDocument()

    first.resolve(ok(busyAnswer()))
    await waitForResults()
    expect(container.querySelector('.pp-page')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('Loading your results')).not.toBeInTheDocument()
  })

  it('shows the five figures with the change against the days before', async () => {
    renderPage(async () => ok(busyAnswer()))
    await waitForResults()

    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(screen.getByText('SpeakSix · 14 October to 12 November 2026')).toBeInTheDocument()
    expect(figure('Earnings')).toEqual({ value: '$420.00', sub: '+$66.00 vs prior 30 days' })
    expect(figure('Clicks')).toEqual({ value: '2,920', sub: '+412 vs prior 30 days' })
    expect(figure('Sales')).toEqual({ value: '70', sub: '+11 vs prior 30 days' })
    expect(figure('Conversion rate')).toEqual({ value: '2.4%', sub: 'Sales ÷ clicks' })
    expect(figure('Earnings per click')).toEqual({ value: '$0.14', sub: 'Earnings ÷ clicks' })
    expect(pressed('Program')).toEqual(['SpeakSix'])
    expect(pressed('Days')).toEqual(['30 days'])
  })

  it('shows money in normal units and nothing about test data', async () => {
    const { container } = renderPage(async () => ok(busyAnswer()))
    await waitForResults()
    expect(container).toHaveTextContent('$420.00')
    expect(container).not.toHaveTextContent('42000')
    expect(container).not.toHaveTextContent('42,000')
    expect(container.textContent).not.toMatch(/test mode|sandbox|demo/i)
  })

  it('shows a dash for both rates with no clicks, never 0% or NaN', async () => {
    const { container } = renderPage(async () =>
      ok(
        answer({
          // A sale that came through no click at all: there is still nothing to divide by.
          totals: { clicks: 0, sales: 1, earnings_minor: 600 },
          channels: [
            mainLink(),
            {
              link_id: null,
              kind: 'none',
              channel: null,
              name: 'No link',
              clicks: 0,
              sales: 1,
              earnings_minor: 600,
            },
          ],
        }),
      ),
    )
    await waitForResults()

    expect(figure('Conversion rate').value).toBe('—')
    expect(figure('Earnings per click').value).toBe('—')
    const row = screen.getByRole('row', { name: /No link/ })
    expect(within(row).getAllByText('—')).toHaveLength(2)
    expect(within(row).getByText('$6.00')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/NaN|Infinity|0\.0%/)
  })

  it.each([
    [
      'up from nothing',
      { clicks: 5, sales: 1, earnings_minor: 600 },
      nothing,
      '+5',
      '+1',
      '+$6.00',
    ],
    [
      'down',
      { clicks: 40, sales: 2, earnings_minor: 1200 },
      { clicks: 52, sales: 5, earnings_minor: 3000 },
      '−12',
      '−3',
      '−$18.00',
    ],
    [
      'down to nothing',
      nothing,
      { clicks: 9, sales: 1, earnings_minor: 600 },
      '−9',
      '−1',
      '−$6.00',
    ],
  ])('shows a change %s', async (_name, totals, previous, clicks, sales, earnings) => {
    renderPage(async () => ok(answer({ totals, previous })))
    await waitForResults()
    expect(figure('Clicks').sub).toBe(`${clicks} vs prior 30 days`)
    expect(figure('Sales').sub).toBe(`${sales} vs prior 30 days`)
    expect(figure('Earnings').sub).toBe(`${earnings} vs prior 30 days`)
  })

  it('says when a number is the same, and nothing when there was nothing either time', async () => {
    renderPage(async () =>
      ok(
        answer({
          totals: { clicks: 12, sales: 0, earnings_minor: 0 },
          previous: { clicks: 12, sales: 0, earnings_minor: 0 },
        }),
      ),
    )
    await waitForResults()
    expect(figure('Clicks').sub).toBe('Same as prior 30 days')
    expect(figure('Sales')).toEqual({ value: '0', sub: null })
    expect(figure('Earnings')).toEqual({ value: '$0.00', sub: null })
  })
})

describe('picking a program or a number of days', () => {
  it('reads the other program and keeps the last answer on screen until it arrives', async () => {
    const user = userEvent.setup()
    const next = deferred()
    const { getProgramPerformance, container } = renderPage((query) =>
      query.slug === 'dramapal' ? next.promise : Promise.resolve(ok(busyAnswer())),
    )
    await waitForResults()

    await user.click(within(group('Program')).getByRole('button', { name: 'DramaPal' }))
    expect(getProgramPerformance).toHaveBeenLastCalledWith({ slug: 'dramapal', days: 30 })
    // The picker already says what was asked for; the numbers are still the last ones.
    expect(pressed('Program')).toEqual(['DramaPal'])
    expect(figure('Earnings').value).toBe('$420.00')
    expect(screen.getByText('SpeakSix · 14 October to 12 November 2026')).toBeInTheDocument()
    expect(container.querySelector('.pp-page')).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.pp-results')).toHaveClass('pp-stale')
    expect(screen.getByRole('status')).toHaveTextContent('Loading your results')

    next.resolve(ok(dramapalAnswer()))
    expect(await screen.findByText('DramaPal · 14 October to 12 November 2026')).toBeInTheDocument()
    expect(figure('Earnings')).toEqual({ value: '50.00 EUR', sub: '−12.50 EUR vs prior 30 days' })
    expect(figure('Earnings per click').value).toBe('0.19 EUR')
    expect(container.querySelector('.pp-page')).toHaveAttribute('aria-busy', 'false')
    expect(container.querySelector('.pp-results')).not.toHaveClass('pp-stale')
    expect(screen.getByText('All DramaPal earnings to date.')).toBeInTheDocument()
  })

  it('reads another number of days for the program on screen and keeps the last answer meanwhile', async () => {
    const user = userEvent.setup()
    const week = deferred()
    const { getProgramPerformance } = renderPage((query) =>
      query.days === 7 ? week.promise : Promise.resolve(ok(busyAnswer())),
    )
    await waitForResults()

    await user.click(within(group('Days')).getByRole('button', { name: '7 days' }))
    // The first answer came for "the first program"; the next one names it, so it cannot change.
    expect(getProgramPerformance).toHaveBeenLastCalledWith({ slug: 'speaksix', days: 7 })
    expect(pressed('Days')).toEqual(['7 days'])
    expect(figure('Clicks')).toEqual({ value: '2,920', sub: '+412 vs prior 30 days' })

    week.resolve(
      ok(
        answer({
          days: 7,
          totals: { clicks: 811, sales: 20, earnings_minor: 12000 },
          previous: { clicks: 759, sales: 19, earnings_minor: 11400 },
        }),
      ),
    )
    expect(await screen.findByText('SpeakSix · 6 November to 12 November 2026')).toBeInTheDocument()
    expect(figure('Clicks')).toEqual({ value: '811', sub: '+52 vs prior 7 days' })
    expect(pressed('Days')).toEqual(['7 days'])
  })

  it('takes only the last thing picked when answers arrive out of order', async () => {
    const user = userEvent.setup()
    const week = deferred()
    const quarter = deferred()
    renderPage((query) =>
      query.days === 7
        ? week.promise
        : query.days === 90
          ? quarter.promise
          : Promise.resolve(ok(busyAnswer())),
    )
    await waitForResults()

    await user.click(within(group('Days')).getByRole('button', { name: '7 days' }))
    await user.click(within(group('Days')).getByRole('button', { name: '90 days' }))
    quarter.resolve(ok(answer({ days: 90, totals: { clicks: 6744, sales: 0, earnings_minor: 0 } })))
    expect(await screen.findByText('SpeakSix · 15 August to 12 November 2026')).toBeInTheDocument()

    week.resolve(ok(answer({ days: 7, totals: { clicks: 811, sales: 0, earnings_minor: 0 } })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(figure('Clicks').value).toBe('6,744')
    expect(pressed('Days')).toEqual(['90 days'])
  })

  it('does not read again when what is on screen is picked', async () => {
    const user = userEvent.setup()
    const { getProgramPerformance } = renderPage(async () => ok(busyAnswer()))
    await waitForResults()
    await user.click(within(group('Days')).getByRole('button', { name: '30 days' }))
    await user.click(within(group('Program')).getByRole('button', { name: 'SpeakSix' }))
    expect(getProgramPerformance).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer when the next one fails, says so, and tries again', async () => {
    const user = userEvent.setup()
    let weekWorks = false
    const { getProgramPerformance } = renderPage(async (query) => {
      if (query.days === 30) return ok(busyAnswer())
      return weekWorks
        ? ok(answer({ days: 7, totals: { clicks: 811, sales: 0, earnings_minor: 0 } }))
        : failed('temporarily_unavailable')
    })
    await waitForResults()

    await user.click(within(group('Days')).getByRole('button', { name: '7 days' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('That did not load. Check your connection and try again.')
    expect(alert).not.toHaveTextContent('not for the page')
    // Still the 30 days, and the picker says so again.
    expect(figure('Clicks').value).toBe('2,920')
    expect(pressed('Days')).toEqual(['30 days'])
    expect(screen.getByText('SpeakSix · 14 October to 12 November 2026')).toBeInTheDocument()

    weekWorks = true
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(getProgramPerformance).toHaveBeenLastCalledWith({ slug: 'speaksix', days: 7 })
    expect(await screen.findByText('SpeakSix · 6 November to 12 November 2026')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(figure('Clicks').value).toBe('811')
  })

  it('drops the complaint when what is on screen is picked again', async () => {
    const user = userEvent.setup()
    const { getProgramPerformance } = renderPage(async (query) =>
      query.days === 30 ? ok(busyAnswer()) : failed('unknown'),
    )
    await waitForResults()
    await user.click(within(group('Days')).getByRole('button', { name: '90 days' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in a moment.')

    await user.click(within(group('Days')).getByRole('button', { name: '30 days' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getProgramPerformance).toHaveBeenCalledTimes(2)
  })

  it('goes back to the first program when the one picked is no longer theirs', async () => {
    const user = userEvent.setup()
    const { getProgramPerformance } = renderPage(async (query) =>
      query.slug === 'dramapal' ? failed('not_found', false) : ok(busyAnswer()),
    )
    await waitForResults()
    await user.click(within(group('Program')).getByRole('button', { name: 'DramaPal' }))

    await waitFor(() =>
      expect(getProgramPerformance).toHaveBeenLastCalledWith({ slug: null, days: 30 }),
    )
    await waitFor(() => expect(pressed('Program')).toEqual(['SpeakSix']))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no program picker with one program, and a list to choose from with many', async () => {
    const user = userEvent.setup()
    const one = renderPage(async () => ok(busyAnswer({ programs: [speaksix] })))
    await waitForResults()
    expect(screen.queryByRole('group', { name: 'Program' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Program' })).not.toBeInTheDocument()
    expect(group('Days')).toBeInTheDocument()
    one.unmount()

    const many = [
      dramapal,
      ...['Fieldnote', 'Loop Habits', 'Tandem Talk'].map((name, index) => ({
        program_id: `prog-${index + 10}`,
        slug: name.toLowerCase().replace(' ', '-'),
        name,
        currency: 'USD',
      })),
      speaksix,
    ]
    const { getProgramPerformance } = renderPage(async () => ok(busyAnswer({ programs: many })))
    await waitForResults()
    const picker = screen.getByRole('combobox', { name: 'Program' })
    expect(picker).toHaveValue('speaksix')
    expect(within(picker).getAllByRole('option')).toHaveLength(5)
    await user.selectOptions(picker, 'Loop Habits')
    expect(getProgramPerformance).toHaveBeenLastCalledWith({ slug: 'loop-habits', days: 30 })
  })
})

describe('the chart', () => {
  it('draws clicks first and switches to sales and earnings', async () => {
    const user = userEvent.setup()
    renderPage(async () => ok(busyAnswer()))
    await waitForResults()

    expect(screen.getByRole('heading', { name: 'Clicks per day' })).toBeInTheDocument()
    expect(pressed('Chart shows')).toEqual(['Clicks'])
    const chart = () =>
      screen.getByRole('group', { name: /per day, 14 October to 12 November 2026/ })
    expect(chart()).toHaveAccessibleName(/^Clicks per day, .*arrow keys/)

    // Focus reads the last day, which is today and not over yet.
    fireEvent.focus(chart())
    const reading = () => within(chart()).getByRole('status')
    expect(reading()).toHaveTextContent('Thu 12 Nov (so far)')
    expect(reading()).toHaveTextContent('20 clicks')
    fireEvent.keyDown(chart(), { key: 'ArrowLeft' })
    expect(reading()).toHaveTextContent('Wed 11 Nov')
    expect(reading()).toHaveTextContent('100 clicks')

    await user.click(within(group('Chart shows')).getByRole('button', { name: 'Sales' }))
    expect(screen.getByRole('heading', { name: 'Sales per day' })).toBeInTheDocument()
    expect(pressed('Chart shows')).toEqual(['Sales'])
    fireEvent.focus(chart())
    expect(reading()).toHaveTextContent('2 sales')

    await user.click(within(group('Chart shows')).getByRole('button', { name: 'Earnings' }))
    expect(screen.getByRole('heading', { name: 'Earnings per day' })).toBeInTheDocument()
    fireEvent.focus(chart())
    fireEvent.keyDown(chart(), { key: 'ArrowRight' })
    expect(reading()).toHaveTextContent('$72.00')
    // The axis is in dollars, not cents.
    expect(chart().querySelector('svg')).toHaveTextContent('$20')
    expect(chart().querySelector('svg')).not.toHaveTextContent('2000')
  })

  it('keeps the view picked when the days change', async () => {
    const user = userEvent.setup()
    renderPage(async (query) => ok(query.days === 7 ? answer({ days: 7 }) : busyAnswer()))
    await waitForResults()
    await user.click(within(group('Chart shows')).getByRole('button', { name: 'Earnings' }))
    await user.click(within(group('Days')).getByRole('button', { name: '7 days' }))
    await screen.findByText('SpeakSix · 6 November to 12 November 2026')
    expect(pressed('Chart shows')).toEqual(['Earnings'])
    expect(screen.getByText('No earnings in these 7 days')).toBeInTheDocument()
  })

  it('has the same days as a table for a screen reader, all 90 of them', async () => {
    const user = userEvent.setup()
    renderPage(async (query) => ok(readableAnswer(query)))
    await waitForResults()
    await user.click(within(group('Days')).getByRole('button', { name: '90 days' }))
    await screen.findByText('SpeakSix · 15 August to 12 November 2026')

    const table = screen.getByRole('table', { name: 'Clicks, sales and earnings per day' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(91)
    expect(
      within(rows[0])
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Day', 'Clicks', 'Sales', 'Earnings'])
    expect(rows[1]).toHaveTextContent('Sat 15 Aug')
    const last = rows.at(-1)!
    expect(within(last).getByRole('rowheader')).toHaveTextContent('Thu 12 Nov')
    expect(
      within(last)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['70', '2', '$12.00'])
    expect(figure('Clicks')).toEqual({ value: '6,744', sub: '+5,324 vs prior 90 days' })
    expect(figure('Earnings').value).toBe('$942.00')
  })
})

/** The hand-written fixture, by what is asked for. */
function readableAnswer(query: PerformanceQuery) {
  if (query.slug === 'loop-habits') return fixture.loop_habits_30
  if (query.slug === 'dramapal') return fixture.dramapal_30
  if (query.slug === null) return fixture.speaksix_30
  return query.days === 7
    ? fixture.speaksix_7
    : query.days === 90
      ? fixture.speaksix_90
      : fixture.speaksix_30
}

describe('by channel', () => {
  it('lists the links that brought something, in the order they came, and counts the rest', async () => {
    renderPage(async () => ok(busyAnswer()))
    await waitForResults()

    const table = screen.getByRole('table', { name: 'By channel' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Channel', 'Clicks', 'Sales', 'Conversion', 'Earnings', 'Per click'])
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Main link', 'TikTok', 'Instagram', 'YouTube', 'Newsletter'])
    const cells = (name: RegExp) =>
      within(screen.getByRole('row', { name }))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    expect(cells(/^TikTok/)).toEqual(['1,840', '46', '2.5%', '$276.00', '$0.15'])
    expect(cells(/^Main link/)).toEqual(['58', '0', '0.0%', '$0.00', '$0.00'])
    expect(
      screen.getByText('2 other links had no clicks or sales in these 30 days.'),
    ).toBeInTheDocument()
  })

  it('wraps a long link name instead of cutting it', async () => {
    const long = 'Autumn giveaway with Lisbon’s book club!'
    expect(long).toHaveLength(40)
    renderPage(async () =>
      ok(
        busyAnswer({
          channels: [
            mainLink({ clicks: 58 }),
            channel(long, { clicks: 35 }, { kind: 'custom', channel: null }),
          ],
        }),
      ),
    )
    await waitForResults()
    expect(screen.getByRole('rowheader', { name: long })).toBeInTheDocument()
  })

  it('shows every one of many links that brought something', async () => {
    const custom = Array.from({ length: 20 }, (_unused, index) =>
      channel(`Custom ${index + 1}`, { clicks: index + 1 }, { kind: 'custom', channel: null }),
    )
    renderPage(async () => ok(busyAnswer({ channels: [mainLink({ clicks: 58 }), ...custom] })))
    await waitForResults()
    expect(
      within(screen.getByRole('table', { name: 'By channel' })).getAllByRole('rowheader'),
    ).toHaveLength(21)
  })
})

describe('your money', () => {
  it('shows what is pending, approved and paid to date, and the latest sales', async () => {
    renderPage(async () =>
      ok(
        busyAnswer({
          money: {
            pending_minor: 42000,
            approved_minor: 31800,
            paying_minor: 2940,
            paid_minor: 110400,
            next_release_at: '2099-01-05T12:00:00.000000+00:00',
          },
        }),
      ),
    )
    await waitForResults()

    const money = screen.getByRole('region', { name: 'Your money' })
    expect(within(money).getByText('All SpeakSix earnings to date.')).toBeInTheDocument()
    const amounts = Object.fromEntries(
      Array.from(money.querySelectorAll('.pp-money-figures > div')).map((cell) => [
        cell.querySelector('dt')!.textContent,
        cell.querySelector('dd')!.textContent,
      ]),
    )
    expect(amounts).toEqual({ Pending: '$420.00', Approved: '$318.00', Paid: '$1,104.00' })
    expect(
      within(money).getByText('First hold ends 5 Jan 2099 · $29.40 is on its way to you'),
    ).toBeInTheDocument()

    const sales = within(within(money).getByRole('list', { name: 'Latest sales' })).getAllByRole(
      'listitem',
    )
    expect(sales).toHaveLength(3)
    expect(sales[0]).toHaveTextContent(/12 Nov( 2026)? · TikTok\$6\.00Pending/)
    expect(sales[1]).toHaveTextContent(/11 Nov( 2026)? · YouTube\$6\.00Approved/)
    expect(sales[2]).toHaveTextContent(/10 Nov( 2026)? · No link\$0\.00Returned/)
    expect(within(money).getByRole('link', { name: 'See payouts' })).toHaveAttribute(
      'href',
      '#payouts',
    )
  })

  it('shows nothing owed for a program with no money row, and no hold that has passed', async () => {
    renderPage(async () => ok(answer({ money: null })))
    await waitForResults()
    const money = screen.getByRole('region', { name: 'Your money' })
    expect(money.querySelectorAll('.pp-money-figures dd')).toHaveLength(3)
    for (const amount of money.querySelectorAll('.pp-money-figures dd'))
      expect(amount).toHaveTextContent('$0.00')
    expect(within(money).queryByText(/First hold ends/)).not.toBeInTheDocument()
    expect(within(money).getByText('No sales yet.')).toBeInTheDocument()
  })

  it('says nothing about a hold that has already ended', async () => {
    renderPage(async () =>
      ok(
        busyAnswer({
          money: {
            pending_minor: 600,
            approved_minor: 0,
            paying_minor: 0,
            paid_minor: 0,
            next_release_at: '2020-01-05T12:00:00.000000+00:00',
          },
        }),
      ),
    )
    await waitForResults()
    expect(screen.queryByText(/First hold ends/)).not.toBeInTheDocument()
  })
})

describe('when there is little or nothing to show', () => {
  it('tells a creator with no program where to find one, in one sentence', async () => {
    const { container } = renderPage(async () => ok(fixture.none_30))
    const link = await screen.findByRole('link', { name: 'Open the marketplace' })
    expect(link).toHaveAttribute('href', '#marketplace')
    expect(
      screen.getByText('Join a program to see your clicks, sales and earnings here.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('shows a program with no activity as zeros and dashes, with the way to a first click', async () => {
    const { container } = renderPage(async () => ok(fixture.loop_habits_30))
    await waitForResults()

    expect(figure('Earnings')).toEqual({ value: '$0.00', sub: null })
    expect(figure('Clicks')).toEqual({ value: '0', sub: null })
    expect(figure('Sales')).toEqual({ value: '0', sub: null })
    expect(figure('Conversion rate').value).toBe('—')
    expect(figure('Earnings per click').value).toBe('—')
    expect(screen.getByText('No clicks in these 30 days')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'By channel' })).not.toBeInTheDocument()
    expect(
      screen.getByText(/Your 7 links had no clicks or sales in these 30 days\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Share one of your links' })).toHaveAttribute(
      'href',
      '#links',
    )
    expect(screen.getByText('No sales yet.')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/NaN|0\.0%/)
  })

  it('says the first load failed in its own words, and loads on Try again', async () => {
    const user = userEvent.setup()
    let works = false
    const { getProgramPerformance } = renderPage(async () =>
      works ? ok(busyAnswer()) : failed('temporarily_unavailable'),
    )
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Performance did not load' })).toBeVisible()
    expect(alert).toHaveTextContent('Check your connection and try again.')
    expect(alert).not.toHaveTextContent('not for the page')

    works = true
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitForResults()
    expect(getProgramPerformance).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers no retry when the session has expired', async () => {
    renderPage(async () => failed('not_authenticated', false))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Your session has expired. Sign in again to see your results.')
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
  })

  it('treats a read that throws as a failure to retry', async () => {
    renderPage(async () => {
      throw new Error('offline')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection')
  })

  it.each(['contract_unavailable', 'not_configured', 'not_authorized'] as const)(
    'shows nothing at all when program results do not exist (%s)',
    async (code) => {
      const { container, getProgramPerformance } = renderPage(async () => failed(code, false))
      await waitFor(() => expect(getProgramPerformance).toHaveBeenCalled())
      await waitFor(() => expect(container).toBeEmptyDOMElement())
    },
  )

  it('shows nothing, and reads nothing, with a gateway from before program results', () => {
    const { container } = render(<Page gateway={gatewayWith(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('names and accessibility', () => {
  const longName = 'The Extraordinarily Long-Named Language Learning Companion Programme'

  it('says a long program name in full in the heading and names it on its button', async () => {
    const long = { ...speaksix, name: longName }
    renderPage(async () => ok(busyAnswer({ programs: [dramapal, long], program: long })))
    await waitForResults()
    expect(screen.getByText(`${longName} · 14 October to 12 November 2026`)).toBeInTheDocument()
    expect(within(group('Program')).getByRole('button', { name: longName })).toHaveAttribute(
      'title',
      longName,
    )
    expect(screen.getByText(`All ${longName} earnings to date.`)).toBeInTheDocument()
  })

  it('still offers the program on screen if the list leaves it out', async () => {
    renderPage(async () => ok(busyAnswer({ programs: [dramapal] })))
    await waitForResults()
    expect(pressed('Program')).toEqual(['SpeakSix'])
  })

  it.each([
    ['with results', () => busyAnswer()],
    ['with no activity', () => fixture.loop_habits_30],
    ['with no program', () => fixture.none_30],
    ['in euros with a sale through no link', () => fixture.dramapal_30],
  ])('has no accessibility violations %s', async (_name, data) => {
    const { container } = renderPage(async () => ok(data()))
    await waitFor(() =>
      expect(container.querySelector('.pp-page')).toHaveAttribute('aria-busy', 'false'),
    )
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map(({ id }) => id)).toEqual([])
  })

  it('is a section with its own heading above an older product’s report', async () => {
    renderPage(async () => ok(busyAnswer()), true)
    await waitForResults()
    expect(screen.getByRole('region', { name: 'Program results' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Program results' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })
})

// Through the gateway ---------------------------------------------------------------------------

type RpcAnswer = {
  data: unknown
  error: { code?: string; message?: string; details?: string } | null
  status?: number
}

function clientAnswering(rpcAnswer: RpcAnswer | (() => Promise<RpcAnswer>)) {
  const rpc = vi.fn((functionName: string, args?: Record<string, unknown>) => {
    void functionName
    void args
    return typeof rpcAnswer === 'function' ? rpcAnswer() : Promise.resolve(rpcAnswer)
  })
  const client: PartnerSupabaseClient = {
    from: () => {
      throw new Error('Performance reads no views.')
    },
    rpc,
  }
  return { rpc, gateway: createPartnerDataGateway(client) }
}

describe('the performance function through the partner gateway', () => {
  it('is called by its name with the slug and the days', async () => {
    expect(PARTNER_RPCS.programPerformance).toBe('partner_program_performance')
    const { gateway, rpc } = clientAnswering({ data: fixture.speaksix_7, error: null, status: 200 })
    const result = await gateway.getProgramPerformance!({ slug: 'speaksix', days: 7 })

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_performance', {
      p_input: { slug: 'speaksix', days: 7 },
    })
    expect(result.status).toBe('ready')
    expect(result.error).toBeNull()
    expect(result.data?.program?.slug).toBe('speaksix')
    expect(result.data?.daily).toHaveLength(7)
  })

  it('asks for the first program with a null slug, and reads a creator with none as empty', async () => {
    const { gateway, rpc } = clientAnswering({ data: fixture.none_30, error: null, status: 200 })
    const result = await gateway.getProgramPerformance!({ slug: null, days: 30 })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_performance', {
      p_input: { slug: null, days: 30 },
    })
    expect(result).toMatchObject({ status: 'empty', error: null, data: { program: null } })
  })

  it.each<[string, RpcAnswer, PartnerDataErrorCode]>([
    [
      'a program that is not theirs',
      { data: null, error: { code: 'P0002', details: 'program_not_found' }, status: 400 },
      'not_found',
    ],
    [
      'a database from before program results',
      { data: null, error: { code: 'PGRST202', message: 'no function' }, status: 404 },
      'contract_unavailable',
    ],
    [
      'an account that is not a creator',
      { data: null, error: { code: '42501', message: 'denied' }, status: 403 },
      'not_authorized',
    ],
    [
      'an expired session',
      { data: null, error: { code: 'PGRST301' }, status: 401 },
      'not_authenticated',
    ],
    [
      'a server error',
      { data: null, error: { message: 'boom' }, status: 503 },
      'temporarily_unavailable',
    ],
    [
      'an answer it cannot read',
      { data: { days: 30 }, error: null, status: 200 },
      'invalid_response',
    ],
  ])('turns %s into %s', async (_what, rpcAnswer, code) => {
    const { gateway } = clientAnswering(rpcAnswer)
    const result = await gateway.getProgramPerformance!({ slug: 'speaksix', days: 30 })
    expect(result.data).toBeNull()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe(code)
    // Whatever the database said stays out of what the page is given.
    expect(result.error?.message).not.toMatch(/boom|denied|no function/)
  })

  it('survives the connection dropping, and no connection at all', async () => {
    const { gateway } = clientAnswering(() => Promise.reject(new Error('offline')))
    expect((await gateway.getProgramPerformance!({ slug: null, days: 30 })).error?.code).toBe(
      'temporarily_unavailable',
    )
    const none = await createPartnerDataGateway(null).getProgramPerformance!({
      slug: null,
      days: 30,
    })
    expect(none).toMatchObject({ data: null, status: 'unconfigured' })
  })
})

// In the dashboard ------------------------------------------------------------------------------

function result<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

const olderProduct: PartnerProduct = {
  id: 'product-older',
  slug: 'older-product',
  name: 'Older product',
  status: 'active',
  trackingMode: 'commercial',
  agreementStatus: 'active',
  commercialModel: 'revenue_share',
  payoutCurrency: 'USD',
  hasLiveFunnel: true,
  mainLinkId: 'main-link',
  mainTrackingUrl: 'https://go.example.test/r/creator/main',
}

function portalGateway(
  products: PartnerProduct[],
  getProgramPerformance?: (
    query: PerformanceQuery,
  ) => Promise<PartnerDataResult<ProgramPerformance | null>>,
): PartnerDataGateway {
  return {
    getCurrentPartnerProfile: async () =>
      result(
        {
          email: 'ada@example.test',
          fullName: 'Ada Okafor',
          publicName: 'Ada Okafor',
          legalName: 'Ada Okafor',
          entityType: 'Individual',
          countryCode: 'GB',
          timezone: 'Europe/London',
          preferredCurrency: 'USD',
          website: null,
          category: null,
          audienceDescription: null,
          audienceCountries: [],
          channels: [],
          channelDetails: null,
          role: 'owner',
          status: 'active',
          notifications: {
            statements: true,
            payouts: true,
            verification: true,
            signatures: true,
            adjustments: true,
            inactiveLinks: true,
          },
        },
        'ready',
      ),
    getProducts: async () => result(products, products.length ? 'ready' : 'empty'),
    getLinkDirectory: async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    getProgramPerformance,
  }
}

function portal(gateway: PartnerDataGateway, page: 'performance' | 'payouts' | 'links') {
  return (
    <PartnerLiveWorkspaceProvider
      gateway={gateway}
      client={null}
      sessionUserId="user-1"
      reporting={{
        startsOn: '2026-10-14',
        endsOn: '2026-11-12',
        timezone: 'Europe/London',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal page={page} />
    </PartnerLiveWorkspaceProvider>
  )
}

describe('the Performance page of the live dashboard', () => {
  it('is the program results alone for a creator with no older product', async () => {
    const read = vi.fn(async (query: PerformanceQuery) => {
      void query
      return ok(busyAnswer())
    })
    render(portal(portalGateway([], read), 'performance'))

    await waitForResults()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(figure('Earnings').value).toBe('$420.00')
    await waitFor(() => expect(screen.queryByText('Loading products…')).not.toBeInTheDocument())
    // Nothing of the older report: no product picker, no "no products" panel.
    expect(screen.queryByLabelText('Product')).not.toBeInTheDocument()
    expect(screen.queryByText('No products are connected yet')).not.toBeInTheDocument()
    expect(screen.queryByText('YOUR PARTNER PERFORMANCE')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledExactlyOnceWith({ slug: null, days: 30 })
  })

  it('puts the program results above the older product’s report for a creator who has one', async () => {
    const read = vi.fn(async () => ok(busyAnswer()))
    render(portal(portalGateway([olderProduct], read), 'performance'))

    const results = await screen.findByRole('region', { name: 'Program results' })
    const older = await screen.findByRole('heading', { level: 1, name: 'Performance.' })
    expect(results.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByLabelText('Product')).toHaveValue(olderProduct.id)
    expect(within(results).getByRole('heading', { name: 'By channel' })).toBeInTheDocument()
  })

  it('says one sentence above the older report when that creator has no program', async () => {
    const read = vi.fn(async () => ok(fixture.none_30))
    render(portal(portalGateway([olderProduct], read), 'performance'))
    const results = await screen.findByRole('region', { name: 'Program results' })
    expect(
      await within(results).findByRole('link', { name: 'Open the marketplace' }),
    ).toHaveAttribute('href', '#marketplace')
    expect(screen.getByLabelText('Product')).toBeInTheDocument()
  })

  it('leaves the page as it was where program results do not exist yet', async () => {
    const read = vi.fn(async () => failed('contract_unavailable', false))
    render(portal(portalGateway([], read), 'performance'))
    expect(
      await screen.findByRole('heading', { name: 'No products are connected yet' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Program results' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'By channel' })).not.toBeInTheDocument()
  })

  it('reads nothing for the other pages', async () => {
    const read = vi.fn(async () => ok(busyAnswer()))
    render(portal(portalGateway([], read), 'payouts'))
    await screen.findByRole('heading', { name: 'No products are connected yet' })
    expect(read).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'By channel' })).not.toBeInTheDocument()
  })
})
