import { describe, expect, it } from 'vitest'
import { linksBackendFixture as backend } from '../../../merchant/links-backend.fixture'
import {
  channelRows,
  conversionText,
  earningsPerClickText,
  NO_RATE,
  readProgramPerformance,
  saleStatus,
} from './performance'

const DAY = 86_400_000
const sum = (rows: readonly { clicks: number; sales: number; earnings_minor: number }[]) =>
  rows.reduce(
    (total, row) => ({
      clicks: total.clicks + row.clicks,
      sales: total.sales + row.sales,
      earnings_minor: total.earnings_minor + row.earnings_minor,
    }),
    { clicks: 0, sales: 0, earnings_minor: 0 },
  )

// The creator's Performance reader against what partner_program_performance really returns.
describe("a creator's performance and the real backend answers", () => {
  it('reads a creator with no program', () => {
    const none = readProgramPerformance(backend.partner_program_performance_none)
    expect(none).toMatchObject({
      days: 30,
      programs: [],
      program: null,
      totals: { clicks: 0, sales: 0, earnings_minor: 0 },
      daily: [],
      channels: [],
      money: null,
      latest: [],
    })
  })

  it('reads a new member: every link listed, nothing counted yet', () => {
    const quiet = readProgramPerformance(backend.partner_program_performance_no_results)
    expect(quiet.program?.slug).toBe('speaksix')
    expect(quiet.daily).toHaveLength(7)
    expect(quiet.channels.map((row) => row.name)).toEqual([
      'Main link',
      'TikTok',
      'Instagram',
      'YouTube',
      'Facebook',
      'X',
      'Newsletter',
    ])
    expect(sum(quiet.channels)).toEqual({ clicks: 0, sales: 0, earnings_minor: 0 })
    expect(quiet.money).toMatchObject({ pending_minor: 0, approved_minor: 0, paid_minor: 0 })
    expect(conversionText(quiet.totals.sales, quiet.totals.clicks)).toBe(NO_RATE)
    expect(channelRows(quiet.channels)).toEqual({ rows: [], quiet: 7 })
  })

  it.each([
    ['partner_program_performance_days7', 7],
    ['partner_program_performance_days30', 30],
    ['partner_program_performance_days90', 90],
  ] as const)('reads %s: one row per day, and the days add up to the totals', (key, days) => {
    const report = readProgramPerformance(backend[key])
    expect(report.days).toBe(days)
    expect(report.daily).toHaveLength(days)
    expect(report.daily[0].day).toBe(report.starts_on)
    expect(report.daily[days - 1].day).toBe(report.ends_on)
    expect(Date.parse(report.ends_on) - Date.parse(report.starts_on)).toBe((days - 1) * DAY)
    expect(sum(report.daily)).toEqual(report.totals)
    // Every click and sale belongs to one row of the channel table.
    expect(sum(report.channels)).toEqual(report.totals)
    expect(report.programs.map((program) => program.name)).toEqual(['Rival Reader', 'SpeakSix'])
    expect(report.program).toMatchObject({ slug: 'speaksix', currency: 'USD' })
  })

  it('reads 30 days by link, with the money to date and the latest sales', () => {
    const report = readProgramPerformance(backend.partner_program_performance_days30)
    expect(report.totals).toEqual({ clicks: 9, sales: 4, earnings_minor: 6270 })
    expect(report.previous).toEqual({ clicks: 2, sales: 1, earnings_minor: 1470 })
    expect(report.channels.map((row) => [row.kind, row.channel, row.name])).toEqual([
      ['main', null, 'Main link'],
      ['channel', 'tiktok', 'TikTok'],
      ['channel', 'instagram', 'Instagram'],
      ['channel', 'youtube', 'YouTube'],
      ['channel', 'facebook', 'Facebook'],
      ['channel', 'x', 'X'],
      ['channel', 'newsletter', 'Newsletter'],
      ['custom', null, 'Podcast'],
      ['custom', null, 'Blog post'],
      ['custom', null, 'Old bio'],
    ])
    const tiktok = report.channels[1]
    expect(tiktok).toMatchObject({ clicks: 3, sales: 1, earnings_minor: 1470 })
    expect(conversionText(tiktok.sales, tiktok.clicks)).toBe('33.3%')
    expect(earningsPerClickText(tiktok.earnings_minor, tiktok.clicks, 'USD')).toBe('$4.90')
    for (const row of report.channels) expect(row.link_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(report.money).toMatchObject({
      pending_minor: 6270,
      approved_minor: 1470,
      paying_minor: 1800,
      paid_minor: 0,
    })
    expect(report.latest).toHaveLength(5)
    expect(report.latest.map((sale) => sale.status)).toContain('reversed')
    const returned = report.latest.find((sale) => sale.status === 'reversed')!
    expect(returned.amount_minor).toBe(0)
    expect(saleStatus(returned.status).label).not.toBe('')
    // No buyer data reaches a creator.
    expect(JSON.stringify(report)).not.toMatch(/@|pi_|cus_|ch_/)
  })

  it('reads the first program by name when none is asked for', () => {
    const report = readProgramPerformance(backend.partner_program_performance_first_program)
    expect(report.program?.slug).toBe('rival-reader')
    expect(report.totals).toEqual({ clicks: 2, sales: 2, earnings_minor: 1500 })
  })

  it('reads sales that are tied to no link as a last row', () => {
    const report = readProgramPerformance(backend.partner_program_performance_sale_without_link)
    const last = report.channels[report.channels.length - 1]
    expect(last).toMatchObject({ kind: 'none', link_id: null, name: 'No link', sales: 1 })
    expect(report.channels.filter((row) => row.kind === 'none')).toHaveLength(1)
    expect(sum(report.channels)).toEqual(report.totals)
  })

  it('reads a paused program: clicks are still shown, nothing was earned', () => {
    const report = readProgramPerformance(backend.partner_program_performance_paused_program)
    expect(report.program?.slug).toBe('quiet-club')
    expect(report.totals).toEqual({ clicks: 2, sales: 0, earnings_minor: 0 })
  })
})
