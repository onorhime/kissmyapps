import { describe, expect, it } from 'vitest'
import { countKinds, countOf, conversionOf, earnFromOf } from '../links/earnFrom'
import {
  channelRows,
  conversionText,
  latestTitle,
  latestWhat,
  NO_RATE,
  PerformanceUnreadable,
  readProgramPerformance,
  saleStatus,
} from './performance'
import type { PerformanceCounts } from './performance'
import { performanceRewardsBackendFixture as backend } from './performance.rewards-backend.fixture'

const DAY = 86_400_000
const sum = (rows: readonly PerformanceCounts[]) =>
  rows.reduce<Required<PerformanceCounts>>(
    (total, row) => ({
      clicks: total.clicks + row.clicks,
      sales: total.sales + row.sales,
      events: total.events + (row.events ?? 0),
      earnings_minor: total.earnings_minor + row.earnings_minor,
    }),
    { clicks: 0, sales: 0, events: 0, earnings_minor: 0 },
  )

/** A copy of a real answer with one part changed, for the readers' refusals. */
function changed(key: keyof typeof backend, change: (answer: Record<string, unknown>) => void) {
  const answer = structuredClone(backend[key]) as Record<string, unknown>
  change(answer)
  return answer
}

// The creator's Performance reader against what partner_program_performance returns for a
// program that pays per event (suite 86 of the database tests).
describe("a creator's performance and the real answers for programs that pay per event", () => {
  it.each([
    ['partner_program_performance_events_days7', 7],
    ['partner_program_performance_events_days30', 30],
    ['partner_program_performance_events_days90', 90],
  ] as const)('reads %s: the days and the channels add up to the totals', (key, days) => {
    const report = readProgramPerformance(backend[key])
    expect(report.days).toBe(days)
    expect(report.daily).toHaveLength(days)
    expect(report.daily[0].day).toBe(report.starts_on)
    expect(report.daily[days - 1].day).toBe(report.ends_on)
    expect(Date.parse(report.ends_on) - Date.parse(report.starts_on)).toBe((days - 1) * DAY)
    expect(sum(report.daily)).toEqual(report.totals)
    // Every click, event and cent belongs to one row of the channel table, "No link" included.
    expect(sum(report.channels)).toEqual(report.totals)
    expect(report.program).toMatchObject({ slug: 'speaksix', earn_from: 'events' })
  })

  it('reads 30 days of an events program: rewards, a No link row and the latest rewards', () => {
    const report = readProgramPerformance(backend.partner_program_performance_events_days30)
    expect(report.totals).toEqual({ clicks: 6, sales: 0, events: 6, earnings_minor: 1800 })
    expect(report.previous).toEqual({ clicks: 2, sales: 0, events: 2, earnings_minor: 400 })
    expect(report.programs.map((program) => [program.name, program.earn_from])).toEqual([
      ['Quiet Club', 'sales'],
      ['Rival Reader', 'both'],
      ['SpeakSix', 'events'],
    ])
    expect(report.rewards).toEqual([
      {
        key: 'signup_completed',
        label: 'Account created',
        amount_minor: 200,
        count: 4,
        earnings_minor: 800,
      },
      {
        key: 'trial_started',
        label: 'Trial started',
        amount_minor: 500,
        count: 2,
        earnings_minor: 1000,
      },
    ])
    // What each reward brought adds up to what the program earned.
    expect(report.rewards!.reduce((all, reward) => all + reward.earnings_minor, 0)).toBe(
      report.totals.earnings_minor,
    )
    expect(report.budget_reached).toBe(false)

    const { rows, quiet } = channelRows(report.channels)
    expect(rows.map((row) => [row.kind, row.name, row.clicks, row.events])).toEqual([
      ['main', 'Main link', 1, 0],
      ['channel', 'TikTok', 3, 3],
      ['channel', 'Instagram', 1, 1],
      ['custom', 'Podcast', 1, 1],
      ['none', 'No link', 0, 1],
    ])
    expect(quiet).toBe(4)
    // An event with no click: the No link row has no rate to give.
    const noLink = rows.at(-1)!
    expect(conversionText(countOf(noLink, conversionOf('events')), noLink.clicks)).toBe(NO_RATE)

    expect(report.latest.map((item) => [latestWhat(item), item.status, item.amount_minor])).toEqual(
      [
        ['TikTok · Account created', 'held', 200],
        ['TikTok · Trial started', 'held', 500],
        ['TikTok · Account created', 'held', 200],
        ['Main link · Account created', 'reversed', 0],
        ['Podcast · Account created', 'held', 200],
      ],
    )
    // A rejected reward is not a refund, and it is drawn as quietly as a returned sale.
    expect(saleStatus('reversed', 'reward')).toEqual({ label: 'Rejected', tone: 'quiet' })
    expect(saleStatus('reversed', 'sale')).toEqual({ label: 'Returned', tone: 'quiet' })
    expect(latestTitle(earnFromOf(report.program!))).toBe('Latest rewards')
  })

  it('reads a program that pays for both: sales and events side by side', () => {
    const report = readProgramPerformance(backend.partner_program_performance_both_days30)
    expect(report.program).toMatchObject({ slug: 'rival-reader', earn_from: 'both' })
    expect(report.totals).toEqual({ clicks: 2, sales: 2, events: 2, earnings_minor: 2800 })
    expect(sum(report.daily)).toEqual(report.totals)
    expect(sum(report.channels)).toEqual(report.totals)
    expect(countKinds(earnFromOf(report.program!))).toEqual(['events', 'sales'])
    expect(report.latest.map((item) => [item.kind, latestWhat(item)])).toEqual([
      ['reward', 'Main link · Sign-up'],
      ['sale', 'Main link'],
      ['reward', 'TikTok · Free trial'],
      ['sale', 'Main link'],
    ])
    expect(latestTitle('both')).toBe('Latest sales and rewards')
    expect(report.rewards?.map((reward) => reward.label)).toEqual(['Sign-up', 'Free trial'])
  })

  it('reads a month whose budget is used up as one yes, never an amount', () => {
    const report = readProgramPerformance(backend.partner_program_performance_budget_reached)
    expect(report.budget_reached).toBe(true)
    expect(JSON.stringify(backend.partner_program_performance_budget_reached)).not.toMatch(
      /budget_minor|monthly_budget|budget_left/,
    )
    expect(Object.keys(report)).not.toContain('budget_minor')
  })

  it('reads a program that pays for sales with the new keys saying nothing', () => {
    const report = readProgramPerformance(backend.partner_program_performance_sales_program)
    expect(report.program).toMatchObject({ slug: 'quiet-club', earn_from: 'sales' })
    expect(report.rewards).toEqual([])
    expect(report.budget_reached).toBe(false)
    expect(report.latest.every((item) => item.kind === 'sale' && item.reward_label === null)).toBe(
      true,
    )
    expect(report.latest.map(latestWhat)).toEqual(['Main link', 'Main link'])
    expect(latestTitle('sales')).toBe('Latest sales')
    expect(sum(report.channels)).toEqual(report.totals)
  })

  it('finds nobody in the answers: no email, no person, no event id', () => {
    for (const answer of Object.values(backend)) {
      const text = JSON.stringify(answer)
      expect(text).not.toContain('@')
      expect(text).not.toMatch(/"(event_id|session_id|person_id|external_id|user_id)"/)
    }
  })

  it('refuses an answer it cannot read rather than guessing', () => {
    const key = 'partner_program_performance_events_days30'
    const refusals = [
      changed(key, (answer) => {
        ;(answer.program as Record<string, unknown>).earn_from = 'clicks'
      }),
      changed(key, (answer) => {
        ;(answer.totals as Record<string, unknown>).events = -1
      }),
      changed(key, (answer) => {
        ;(answer.channels as Record<string, unknown>[])[1].events = 1.5
      }),
      changed(key, (answer) => {
        answer.rewards = 'none'
      }),
      changed(key, (answer) => {
        ;(answer.rewards as Record<string, unknown>[])[0].amount_minor = 0
      }),
      changed(key, (answer) => {
        ;(answer.rewards as Record<string, unknown>[])[0].label = ''
      }),
      changed(key, (answer) => {
        answer.budget_reached = 'yes'
      }),
    ]
    for (const answer of refusals)
      expect(() => readProgramPerformance(answer)).toThrow(PerformanceUnreadable)
  })

  it('leaves out a latest row of a kind it has no words for, as it does an unknown status', () => {
    const answer = changed('partner_program_performance_events_days30', (body) => {
      ;(body.latest as Record<string, unknown>[])[0].kind = 'refund'
    })
    expect(readProgramPerformance(answer).latest).toHaveLength(4)
  })
})
