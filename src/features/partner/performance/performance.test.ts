import { describe, expect, it } from 'vitest'
import {
  NO_RATE,
  PerformanceUnreadable,
  axisDay,
  axisMoney,
  changeAgainst,
  changeAmount,
  changeRest,
  channelRows,
  conversionRate,
  conversionText,
  countText,
  dayAsTime,
  earningsPerClickMinor,
  earningsPerClickText,
  isQuiet,
  nothingToShow,
  performanceErrorMessage,
  periodLine,
  quietLinksLine,
  readProgramPerformance,
  saleStatus,
  tooltipDay,
} from './performance'
import type { PerformanceChannel, ProgramPerformanceResult } from './performance'
import { performanceFixture as fixture } from './performance.fixture'

/** A copy of a fixture answer that a test may break. */
function copyOf(answer: unknown): Record<string, any> {
  return structuredClone(answer) as Record<string, any>
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

describe('reading the performance answer', () => {
  it.each(Object.entries(fixture).filter(([, answer]) => answer.program !== null))(
    'reads %s: one row for every day, in order, adding up to the totals',
    (_name, answer) => {
      const performance = readProgramPerformance(answer)
      expect([7, 30, 90]).toContain(performance.days)
      expect(performance.daily).toHaveLength(performance.days)
      expect(performance.daily[0].day).toBe(performance.starts_on)
      expect(performance.daily.at(-1)!.day).toBe(performance.ends_on)
      expect(performance.program).not.toBeNull()
      expect(performance.programs.map((program) => program.slug)).toContain(
        performance.program!.slug,
      )
      // The days are the totals, a day at a time.
      expect(sum(performance.daily.map((row) => row.clicks))).toBe(performance.totals.clicks)
      expect(sum(performance.daily.map((row) => row.sales))).toBe(performance.totals.sales)
      expect(sum(performance.daily.map((row) => row.earnings_minor))).toBe(
        performance.totals.earnings_minor,
      )
      for (const sale of performance.latest)
        expect(['held', 'approved', 'reversed']).toContain(sale.status)
      // Nothing about a buyer reaches a creator: no address in anything that was read.
      expect(JSON.stringify(performance)).not.toContain('@')
    },
  )

  it('keeps the links in the order they came, with the sales through no link last', () => {
    const channels = readProgramPerformance(fixture.dramapal_30).channels
    expect(channels[0]).toMatchObject({ kind: 'main', channel: null })
    expect(channels.slice(1, 7).map((row) => row.channel)).toEqual([
      'tiktok',
      'instagram',
      'youtube',
      'facebook',
      'x',
      'newsletter',
    ])
    expect(channels.at(-1)).toMatchObject({ kind: 'none', link_id: null, channel: null })
  })

  it('reads a program with nothing in it and no money row', () => {
    const performance = readProgramPerformance(fixture.loop_habits_30)
    expect(performance.totals).toEqual({ clicks: 0, sales: 0, earnings_minor: 0 })
    expect(performance.daily.every(isQuiet)).toBe(true)
    expect(performance.money).toBeNull()
    expect(performance.latest).toEqual([])
  })

  it('reads a creator with no program: nothing to report, and nothing invented', () => {
    expect(readProgramPerformance(fixture.none_30)).toEqual({
      days: 30,
      timezone: 'UTC',
      starts_on: '2026-10-14',
      ends_on: '2026-11-12',
      programs: [],
      program: null,
      totals: { clicks: 0, sales: 0, earnings_minor: 0 },
      previous: { clicks: 0, sales: 0, earnings_minor: 0 },
      daily: [],
      channels: [],
      money: null,
      latest: [],
    })
  })

  it('takes a sum that arrives as a string of digits', () => {
    const answer = copyOf(fixture.speaksix_30)
    answer.totals.earnings_minor = '42000'
    answer.money.paid_minor = '110400'
    const performance = readProgramPerformance(answer)
    expect(performance.totals.earnings_minor).toBe(42000)
    expect(performance.money?.paid_minor).toBe(110400)
  })

  it('leaves out a latest sale whose status it has no words for', () => {
    const answer = copyOf(fixture.speaksix_30)
    answer.latest[1].status = 'not_earned'
    expect(readProgramPerformance(answer).latest).toHaveLength(
      fixture.speaksix_30.latest.length - 1,
    )
  })

  it('reads a latest sale without a link or a time', () => {
    const answer = copyOf(fixture.speaksix_30)
    answer.latest[0].link_name = null
    answer.latest[0].paid_at = 'not a time'
    expect(readProgramPerformance(answer).latest[0]).toEqual({
      paid_at: null,
      link_name: null,
      amount_minor: 600,
      status: 'held',
    })
  })

  it.each<[string, (answer: Record<string, any>) => void]>([
    ['a number of days nobody asked for', (answer) => (answer.days = 14)],
    ['days as text', (answer) => (answer.days = '30')],
    ['no time zone', (answer) => delete answer.timezone],
    ['a first day that is not a day', (answer) => (answer.starts_on = '2026-02-30')],
    ['a last day with a time on it', (answer) => (answer.ends_on = '2026-11-12T00:00:00Z')],
    ['a window that is not as long as it says', (answer) => (answer.starts_on = '2026-10-15')],
    ['programs that are not a list', (answer) => (answer.programs = {})],
    ['a program in the picker without a slug', (answer) => delete answer.programs[0].slug],
    ['a program without a name', (answer) => (answer.program.name = ' ')],
    ['a currency that is not a code', (answer) => (answer.program.currency = 'usd')],
    ['totals that are missing', (answer) => delete answer.totals],
    ['a total that is missing', (answer) => delete answer.totals.sales],
    ['clicks below zero', (answer) => (answer.totals.clicks = -1)],
    ['half a sale', (answer) => (answer.totals.sales = 1.5)],
    ['earnings that are not a number', (answer) => (answer.previous.earnings_minor = '4.2e4')],
    ['the days before missing', (answer) => (answer.previous = null)],
    ['days that are not a list', (answer) => (answer.daily = null)],
    ['a day short', (answer) => answer.daily.pop()],
    ['a day too many', (answer) => answer.daily.push({ ...answer.daily[0], day: '2026-11-13' })],
    ['days out of order', (answer) => answer.daily.reverse()],
    ['a gap in the days', (answer) => (answer.daily[3].day = answer.daily[2].day)],
    ['a day without its clicks', (answer) => delete answer.daily[5].clicks],
    ['channels that are not a list', (answer) => (answer.channels = 'none')],
    ['a kind of link it does not know', (answer) => (answer.channels[1].kind = 'campaign')],
    ['a link without a name', (answer) => (answer.channels[1].name = '')],
    ['a link without an id', (answer) => (answer.channels[1].link_id = null)],
    ['a channel without its sales', (answer) => delete answer.channels[2].sales],
    ['money without what is pending', (answer) => delete answer.money.pending_minor],
    ['money that is not a number', (answer) => (answer.money.paid_minor = 'lots')],
    ['money that is a list', (answer) => (answer.money = [])],
    ['latest sales that are not a list', (answer) => (answer.latest = null)],
    ['a latest sale without an amount', (answer) => delete answer.latest[0].amount_minor],
  ])('refuses %s', (_what, spoil) => {
    const answer = copyOf(fixture.speaksix_30)
    spoil(answer)
    expect(() => readProgramPerformance(answer)).toThrow(PerformanceUnreadable)
  })

  it('refuses the sales through no link when that row claims a link, and days with no program', () => {
    const withLink = copyOf(fixture.dramapal_30)
    withLink.channels.at(-1).link_id = 'link-1'
    expect(() => readProgramPerformance(withLink)).toThrow(PerformanceUnreadable)

    const daysWithoutProgram = copyOf(fixture.none_30)
    daysWithoutProgram.daily = copyOf(fixture.speaksix_30).daily
    expect(() => readProgramPerformance(daysWithoutProgram)).toThrow(PerformanceUnreadable)
  })

  it.each([null, undefined, 'x', 7, [], {}])('refuses %j', (value) => {
    expect(() => readProgramPerformance(value)).toThrow(PerformanceUnreadable)
  })
})

describe('rates', () => {
  it('works out conversion from the counts', () => {
    expect(conversionRate(70, 2920)).toBeCloseTo(0.02397, 4)
    expect(conversionText(70, 2920)).toBe('2.4%')
    expect(conversionText(9, 304)).toBe('3.0%')
    expect(conversionText(0, 58)).toBe('0.0%')
    expect(conversionText(2, 1)).toBe('200.0%')
  })

  it('works out earnings per click to the nearest cent', () => {
    expect(earningsPerClickMinor(42000, 2920)).toBe(14)
    expect(earningsPerClickText(42000, 2920, 'USD')).toBe('$0.14')
    expect(earningsPerClickText(2400, 96, 'USD')).toBe('$0.25')
    expect(earningsPerClickText(0, 58, 'USD')).toBe('$0.00')
    expect(earningsPerClickText(5000, 270, 'EUR')).toBe('0.19 EUR')
  })

  it('shows a dash with no clicks, never 0%, $0.00 or NaN', () => {
    expect(conversionRate(0, 0)).toBeNull()
    expect(conversionRate(3, 0)).toBeNull()
    expect(conversionText(0, 0)).toBe(NO_RATE)
    expect(conversionText(3, 0)).toBe('—')
    expect(earningsPerClickMinor(1250, 0)).toBeNull()
    expect(earningsPerClickText(0, 0, 'USD')).toBe('—')
    expect(earningsPerClickText(1250, 0, 'EUR')).toBe('—')
    for (const text of [conversionText(0, 0), earningsPerClickText(0, 0, 'USD')]) {
      expect(text).not.toMatch(/NaN|Infinity|%|\d/)
    }
  })
})

describe('change against the days before', () => {
  const money = (minor: number) => `$${(minor / 100).toFixed(2)}`

  it('is the difference, up or down', () => {
    const up = changeAgainst(2920, 2508)!
    expect(up).toEqual({ direction: 'up', difference: 412 })
    expect(changeAmount(up, countText)).toBe('+412')
    expect(changeRest(up, 30)).toBe('vs prior 30 days')

    const down = changeAgainst(5000, 6250)!
    expect(down).toEqual({ direction: 'down', difference: 1250 })
    expect(changeAmount(down, money)).toBe('−$12.50')
    expect(changeRest(down, 7)).toBe('vs prior 7 days')
  })

  it('counts up from nothing as a plain number, not a percentage', () => {
    const first = changeAgainst(1, 0)!
    expect(first).toEqual({ direction: 'up', difference: 1 })
    expect(changeAmount(first, countText)).toBe('+1')
    expect(changeAmount(changeAgainst(600, 0)!, money)).toBe('+$6.00')
    expect(changeAmount(first, countText)).not.toMatch(/%|∞|NaN|Infinity/)
  })

  it('counts down to nothing', () => {
    const gone = changeAgainst(0, 59)!
    expect(gone).toEqual({ direction: 'down', difference: 59 })
    expect(changeAmount(gone, countText)).toBe('−59')
  })

  it('says so when nothing moved, and says nothing when there was nothing either time', () => {
    const same = changeAgainst(70, 70)!
    expect(same.direction).toBe('same')
    expect(changeAmount(same, countText)).toBeNull()
    expect(changeRest(same, 90)).toBe('Same as prior 90 days')
    expect(changeAgainst(0, 0)).toBeNull()
  })

  it('writes thousands with a comma', () => {
    expect(changeAmount(changeAgainst(6744, 1420)!, countText)).toBe('+5,324')
  })
})

describe('what there is to show', () => {
  const row = (overrides: Partial<PerformanceChannel>): PerformanceChannel => ({
    link_id: 'link',
    kind: 'channel',
    channel: 'tiktok',
    name: 'TikTok',
    clicks: 0,
    sales: 0,
    earnings_minor: 0,
    ...overrides,
  })

  it('gives a row to every link that brought something and counts the rest', () => {
    const channels = [
      row({ link_id: 'a', kind: 'main', name: 'Main link', clicks: 3 }),
      row({ link_id: 'b' }),
      row({ link_id: 'c', name: 'Instagram', sales: 1, earnings_minor: 600 }),
      row({ link_id: 'd', kind: 'custom', name: 'Podcast' }),
      row({ link_id: null, kind: 'none', name: 'No link', sales: 1, earnings_minor: 600 }),
    ]
    const { rows, quiet } = channelRows(channels)
    expect(rows.map((channel) => channel.name)).toEqual(['Main link', 'Instagram', 'No link'])
    expect(quiet).toBe(2)
  })

  it('says how many links were left out', () => {
    expect(quietLinksLine(0, 5, 30)).toBeNull()
    expect(quietLinksLine(1, 5, 30)).toBe('1 other link had no clicks or sales in these 30 days.')
    expect(quietLinksLine(3, 5, 7)).toBe('3 other links had no clicks or sales in these 7 days.')
    expect(quietLinksLine(7, 0, 90)).toBe('Your 7 links had no clicks or sales in these 90 days.')
    expect(quietLinksLine(1, 0, 30)).toBe('Your link had no clicks or sales in these 30 days.')
  })

  it('shows nothing where program results do not exist', () => {
    const failed = (code: string): ProgramPerformanceResult => ({
      data: null,
      status: 'error',
      error: { code, message: 'x', retryable: false } as ProgramPerformanceResult['error'],
    })
    expect(nothingToShow({ data: null, status: 'unconfigured', error: null })).toBe(true)
    expect(nothingToShow(failed('contract_unavailable'))).toBe(true)
    expect(nothingToShow(failed('not_configured'))).toBe(true)
    expect(nothingToShow(failed('not_authorized'))).toBe(true)
    expect(nothingToShow(failed('temporarily_unavailable'))).toBe(false)
    expect(nothingToShow(failed('invalid_response'))).toBe(false)
    expect(nothingToShow(failed('not_authenticated'))).toBe(false)
  })
})

describe('words', () => {
  it('writes days the same in every time zone', () => {
    expect(axisDay('2026-10-14')).toBe('14 Oct')
    expect(axisDay(dayAsTime('2026-11-12'))).toBe('12 Nov')
    expect(tooltipDay('2026-10-14')).toBe('Wed 14 Oct')
  })

  it('writes the days shown, with the first year only when it differs', () => {
    expect(periodLine('2026-10-14', '2026-11-12')).toBe('14 October to 12 November 2026')
    expect(periodLine('2026-11-06', '2026-11-12')).toBe('6 November to 12 November 2026')
    expect(periodLine('2026-12-14', '2027-01-12')).toBe('14 December 2026 to 12 January 2027')
  })

  it('writes money on an axis in normal units', () => {
    expect(axisMoney(0, 'USD')).toBe('$0')
    expect(axisMoney(50, 'USD')).toBe('$0.50')
    expect(axisMoney(2500, 'USD')).toBe('$25')
    expect(axisMoney(150000, 'USD')).toBe('$1.5K')
    expect(axisMoney(200000, 'USD')).toBe('$2K')
    expect(axisMoney(2500, 'EUR')).toBe('25 EUR')
  })

  it('has a word for each standing of a sale', () => {
    expect(saleStatus('held')).toEqual({ label: 'Pending', tone: 'waiting' })
    expect(saleStatus('approved')).toEqual({ label: 'Approved', tone: 'good' })
    expect(saleStatus('reversed')).toEqual({ label: 'Returned', tone: 'quiet' })
  })

  it('never repeats the database in an error', () => {
    const error = (code: string) =>
      ({ code, message: 'relation "x" does not exist', retryable: true }) as NonNullable<
        ProgramPerformanceResult['error']
      >
    expect(performanceErrorMessage(error('not_authenticated'))).toMatch(/Sign in again/)
    expect(performanceErrorMessage(error('invalid_response'))).toMatch(/could not be read/)
    expect(performanceErrorMessage(error('temporarily_unavailable'))).toMatch(/connection/)
    expect(performanceErrorMessage(error('unknown'))).toBe('Try again in a moment.')
    expect(performanceErrorMessage(null)).toBe('Try again in a moment.')
  })
})
