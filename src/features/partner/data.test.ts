import { describe, expect, it } from 'vitest'
import {
  chartData,
  csvContent,
  defaultFilters,
  filterRecords,
  groupedReport,
  money,
  periodLabel,
  previewPayouts,
  previewRecords,
  sumMetric,
  trackedPreviewUrl,
} from './data'
import type { ReportGrouping, ReportingPeriod } from './data'

describe('deterministic preview data', () => {
  it.each([
    ['7', 35, '2026-08-20'],
    ['30', 150, '2026-07-28'],
    ['90', 450, '2026-05-29'],
  ] as const)('limits the %s-day report to the inclusive UTC range', (period, count, start) => {
    const rows = filterRecords({ ...defaultFilters, period })
    expect(rows).toHaveLength(count)
    expect(rows[0].date).toBe(start)
    expect(rows.at(-1)?.date).toBe('2026-08-26')
    expect(rows.every((row) => row.date >= start && row.date <= '2026-08-26')).toBe(true)
  })

  it('combines source, country, campaign, funnel, and Sub ID filters', () => {
    const rows = filterRecords({
      ...defaultFilters,
      source: 'Social media',
      country: 'Canada',
      campaign: 'Example launch',
      funnel: 'Example funnel A',
      subId: 'PLACEMENT-1',
    })
    expect(rows).toHaveLength(10)
    expect(rows.every((row) => row.country === 'Canada' && row.source === 'Social media')).toBe(
      true,
    )
    expect(filterRecords({ ...defaultFilters, subId: 'not-present' })).toEqual([])
  })

  it('retains Direct / untagged in unfiltered reports', () => {
    expect(
      filterRecords(defaultFilters).filter((row) => row.source === 'Direct / untagged'),
    ).toHaveLength(30)
  })

  it.each(['source', 'day', 'week', 'month'] as ReportGrouping[])(
    'preserves totals grouped by %s',
    (grouping) => {
      const rows = filterRecords(defaultFilters)
      const groups = groupedReport(rows, grouping)
      for (const metric of ['clicks', 'leads', 'purchases', 'earningsMinor'] as const) {
        expect(groups.reduce((total, group) => total + group[metric], 0)).toBe(
          sumMetric(rows, metric),
        )
      }
    },
  )

  it('groups weeks on Monday in UTC, including a partial first week', () => {
    const weeks = groupedReport(filterRecords(defaultFilters), 'week')
    expect(weeks[0].key).toBe('2026-07-27')
    expect(weeks.every((week) => new Date(`${week.key}T00:00:00Z`).getUTCDay() === 1)).toBe(true)
  })

  it.each(['7', '30', '90'] as ReportingPeriod[])(
    'renders every calendar day in a %s-day chart',
    (period) => {
      const rows = filterRecords({
        ...defaultFilters,
        period,
        source: 'Social media',
        country: 'Canada',
      })
      const data = chartData(rows, 'clicks', period)
      expect(data).toHaveLength(Number(period))
      expect(data.reduce((total, point) => total + point.value, 0)).toBe(sumMetric(rows, 'clicks'))
      expect(data.some((point) => point.value === 0)).toBe(true)
      expect(data.at(-1)?.date).toBe('Aug 26')
    },
  )

  it('uses minor-unit money with the currency exponent', () => {
    expect(money(12345)).toBe('$123.45')
    expect(money(-1494)).toBe('-$14.94')
    expect(money(12345, 'JPY')).toBe('¥12,345')
    expect(money(12345, 'BHD')).toContain('12.345')
    expect(previewRecords.every((row) => Number.isInteger(row.earningsMinor))).toBe(true)
  })

  it('converts chart earnings to USD exactly once', () => {
    const rows = filterRecords({ ...defaultFilters, period: '7' })
    const total = chartData(rows, 'earningsMinor', '7').reduce((sum, row) => sum + row.value, 0)
    expect(total).toBeCloseTo(sumMetric(rows, 'earningsMinor') / 100, 8)
    expect(periodLabel('7')).toBe('Aug 20 – Aug 26, 2026')
  })

  it('uses 14-day Monday-to-Sunday payout periods and Friday payment examples', () => {
    for (const payout of previewPayouts) {
      const start = new Date(`${payout.start}T00:00:00Z`)
      const end = new Date(`${payout.end}T00:00:00Z`)
      const due = new Date(`${payout.due}T00:00:00Z`)
      expect(start.getUTCDay()).toBe(1)
      expect(end.getUTCDay()).toBe(0)
      expect((end.getTime() - start.getTime()) / 86400000).toBe(13)
      expect(due.getUTCDay()).toBe(5)
      expect(payout.finalMinor).toBe(payout.earningsMinor + payout.adjustmentsMinor)
      const rows = previewRecords.filter(
        (row) => row.date >= payout.start && row.date <= payout.end,
      )
      expect(payout.earningsMinor).toBe(sumMetric(rows, 'earningsMinor'))
    }
    expect(previewPayouts[0].statement).toBeNull()
  })

  it('escapes CSV fields and guards spreadsheet-formula injection', () => {
    expect(
      csvContent(
        ['Label', 'Amount'],
        [
          ['A, "quoted" label', -1494],
          ['=SUM(1,2)', 3],
        ],
      ),
    ).toBe('"Label","Amount"\r\n"A, ""quoted"" label","-1494"\r\n"\'=SUM(1,2)","3"')
    for (const input of ['+formula', '-formula', '@formula', '\tformula', '\rformula']) {
      expect(csvContent(['Value'], [[input]])).toContain(`"'${input}"`)
    }
  })

  it('creates only reserved .invalid URLs and encodes placement IDs', () => {
    const url = new URL(
      trackedPreviewUrl({
        source: 'Content & SEO',
        subId: 'placement/a b',
        campaign: 'Example launch',
        funnel: 'Example funnel A',
        sub2: '',
        sub3: '',
      }),
    )
    expect(url.hostname).toBe('go.example.invalid')
    expect(url.pathname).toBe('/r/preview-partner/content-seo')
    expect(url.searchParams.get('sub1')).toBe('placement/a b')
    expect(url.href).toContain('placement%2Fa+b')
  })
})
