import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PartnerDataGateway } from '../api'
import { readProgramEarnings } from './earnings'
import type { ProgramEarningsResult } from './earnings'
import { earningsEventsFixture as hand } from './earnings.events.fixture'
import { earningsRewardsBackendFixture as backend } from './earnings.rewards-backend.fixture'
import { ProgramEarningsPanel } from './ProgramEarningsPanel'

type Answer = { programs: Record<string, unknown>[]; recent: Record<string, unknown>[] }

function renderAnswer(answer: unknown) {
  const result: ProgramEarningsResult = {
    data: readProgramEarnings(answer),
    status: 'ready',
    error: null,
  }
  const getProgramEarnings = vi.fn(() => Promise.resolve(result))
  return render(
    <ProgramEarningsPanel gateway={{ getProgramEarnings } as unknown as PartnerDataGateway} />,
  )
}

/** The page's markup, with React's generated ids made the same from one render to the next. */
const markup = (container: HTMLElement) => container.innerHTML.replace(/_r_[0-9a-z]+_/g, 'id')

const columns = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent)
const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

describe('Program earnings with rewards in them', () => {
  it('names rewards beside commission, and counts events under each program', async () => {
    renderAnswer(backend.partner_program_earnings_with_rewards)
    const table = await screen.findByRole('table', { name: 'Recent earnings' })

    expect(screen.getByText(/Commission and rewards from the programs you joined/)).toBeTruthy()
    const programs = screen.getByRole('list', { name: 'Earnings by program' })
    expect(
      within(programs)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('small')!.textContent),
    ).toEqual(['2 sales', '2 sales · 2 events', '1 sale · 8 events'])

    expect(columns(table)).toEqual(['Date', 'Program', 'Sale', 'You earn', 'Status'])
    const [sale, reward] = rows(table)
    expect(within(sale).getByRole('rowheader').textContent).toBe('Quiet Club')
    expect(within(sale).getAllByRole('cell')[1].textContent).toBe('$40.00')
    expect(within(reward).getByRole('rowheader').textContent).toBe('Rival ReaderReward: Sign-up')
    // A reward has no sale behind it.
    expect(within(reward).getAllByRole('cell')[1].textContent).toBe('—')
    expect(within(reward).getAllByRole('cell')[2].textContent).toBe('$3.00')
  })

  it('shows a rejected reward as rejected by the brand, not as a refund', async () => {
    renderAnswer(backend.partner_program_earnings_with_rewards)
    const table = await screen.findByRole('table', { name: 'Recent earnings' })
    const rejected = rows(table).find((row) => row.textContent?.includes('Rejected by the brand'))!
    expect(rejected.className).toContain('pe-returned')
    expect(within(rejected).getByRole('rowheader').textContent).toBe(
      'SpeakSixReward: Account created',
    )
    expect(screen.queryByText(/before a refund/)).toBeNull()
  })

  it('leaves the Sale column out when every row is a reward', async () => {
    renderAnswer(hand.rewards_only)
    const table = await screen.findByRole('table', { name: 'Recent earnings' })
    expect(columns(table)).toEqual(['Date', 'Program', 'You earn', 'Status'])
    expect(
      within(screen.getByRole('list', { name: 'Earnings by program' })).getByText('3 events'),
    ).toBeTruthy()
    expect(screen.queryByText(/\bsales?\b/)).toBeNull()
  })
})

describe('Program earnings of a program that pays for sales, from a Phase 6 database', () => {
  it('looks exactly as it did before events could be rewarded', async () => {
    const all = backend.partner_program_earnings_with_rewards as Answer
    const quietClub = (row: Record<string, unknown>) =>
      row.program_id === all.programs[0].program_id
    const now = {
      programs: all.programs.filter(quietClub),
      recent: all.recent.filter(quietClub),
      payouts: [],
    }
    const before = {
      programs: now.programs.map(({ events: _events, ...row }) => row),
      recent: now.recent.map(({ kind: _kind, reward_label: _label, ...row }) => row),
      payouts: [],
    }
    expect(now.recent.every((row) => row.kind === 'sale')).toBe(true)

    const old = renderAnswer(before)
    await screen.findByRole('table', { name: 'Recent commissions' })
    const html = markup(old.container)
    old.unmount()

    const current = renderAnswer(now)
    await screen.findByRole('table', { name: 'Recent commissions' })
    expect(markup(current.container)).toBe(html)
  })
})
