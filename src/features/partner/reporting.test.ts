import { describe, expect, it } from 'vitest'
import { csvContent, previewLinks, previewPayouts, previewRecords, sumMetric } from './data'
import {
  additiveMetrics,
  aggregateReport,
  allPeriodMetrics,
  currentSubscriptions,
  defaultReportingFilters,
  dimensionReport,
  effectiveStage,
  filterReportingRecords,
  formatMetric,
  metricDefinitions,
  rangeLabel,
  reportCsv,
  reportingRecords,
  reportRange,
  resetDimensions,
  shiftDate,
  sortReport,
  timeBuckets,
  timeReport,
  validateCustomRange,
} from './reporting'
import type { Breakdown, ReportingFilters, ReportingRecord, ReportRow } from './reporting'

const defaultRows = filterReportingRecords(defaultReportingFilters)
function record(values: Partial<ReportingRecord> = {}): ReportingRecord {
  return { ...reportingRecords[0], ...values }
}

describe('reporting dates and scope', () => {
  it.each([
    ['14', '2026-08-13', 14],
    ['30', '2026-07-28', 30],
    ['90', '2026-05-29', 90],
    ['year', '2026-01-01', 238],
  ] as const)('covers every day for %s with inclusive UTC endpoints', (period, start, days) => {
    const filters = { ...defaultReportingFilters, period }
    expect(reportRange(filters)).toEqual({ start, end: '2026-08-26' })
    const rows = filterReportingRecords(filters)
    expect(rows).toHaveLength(days * 5)
    expect(new Set(rows.map((row) => row.date)).size).toBe(days)
    expect(rows[0].date).toBe(start)
    expect(rows.at(-1)?.date).toBe('2026-08-26')
    expect(timeReport(rows, reportRange(filters), 'day')).toHaveLength(days)
  })

  it.each([
    ['', '2026-08-26', 'start'],
    ['2026-02-30', '2026-08-26', 'start'],
    ['2026-02-01', '2026-02-29', 'end'],
    ['2026-01-01', '', 'end'],
    ['2025-12-31', '2026-01-01', 'start'],
    ['2026-08-27', '2026-08-28', 'start'],
    ['2026-08-10', '2026-08-09', 'end'],
    ['2026-08-01', '2026-08-27', 'end'],
  ])('rejects invalid custom range %s to %s', (start, end, field) => {
    expect(validateCustomRange(start, end)?.field).toBe(field)
    expect(() =>
      reportRange({
        ...defaultReportingFilters,
        period: 'custom',
        customStart: start,
        customEnd: end,
      }),
    ).toThrow(RangeError)
  })

  it('allows one-day and full-coverage custom ranges, including both endpoints', () => {
    expect(validateCustomRange('2026-08-26', '2026-08-26')).toBeNull()
    expect(validateCustomRange('2026-01-01', '2026-08-26')).toBeNull()
    const filters: ReportingFilters = {
      ...defaultReportingFilters,
      period: 'custom',
      customStart: '2026-08-26',
      customEnd: '2026-08-26',
    }
    expect(filterReportingRecords(filters)).toHaveLength(5)
    expect(rangeLabel(reportRange(filters))).toBe('Aug 26 – Aug 26, 2026')
  })

  it('keeps calendar arithmetic in UTC across leap days and year boundaries', () => {
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDate('2024-02-29', 1)).toBe('2024-03-01')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    const buckets = timeBuckets({ start: '2024-02-28', end: '2024-03-01' }, 'month')
    expect(buckets.map(({ start, end }) => [start, end])).toEqual([
      ['2024-02-28', '2024-02-29'],
      ['2024-03-01', '2024-03-01'],
    ])
  })

  it('clips Monday-based weekly buckets to the selected interval', () => {
    const buckets = timeBuckets(reportRange(defaultReportingFilters), 'week')
    expect(buckets[0]).toEqual({
      key: '2026-07-27',
      start: '2026-07-28',
      end: '2026-08-02',
      label: 'Jul 28 – Aug 2',
    })
    expect(buckets.at(-1)?.end).toBe('2026-08-26')
    expect(buckets.every((bucket) => new Date(`${bucket.key}T00:00:00Z`).getUTCDay() === 1)).toBe(
      true,
    )
  })

  it('combines every dimension, trims Sub ID search, and preserves custom dates on reset', () => {
    const filters: ReportingFilters = {
      ...defaultReportingFilters,
      period: 'custom',
      customStart: '2026-08-01',
      customEnd: '2026-08-16',
      source: 'Social media',
      country: 'Canada',
      campaign: 'Example launch',
      funnel: 'Example funnel A',
      subId: ' PLACEMENT-1 ',
    }
    const rows = filterReportingRecords(filters)
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.every(
        (row) =>
          row.source === filters.source &&
          row.country === filters.country &&
          row.campaign === filters.campaign &&
          row.funnel === filters.funnel &&
          row.subId === 'placement-1',
      ),
    ).toBe(true)
    expect(resetDimensions(filters)).toEqual({
      ...defaultReportingFilters,
      period: 'custom',
      customStart: '2026-08-01',
      customEnd: '2026-08-16',
    })
    expect(filterReportingRecords({ ...filters, subId: 'nonexistent' })).toEqual([])
  })

  it('does not renumber or change any original 90-day financial or count fixture', () => {
    const rows = filterReportingRecords({ ...defaultReportingFilters, period: '90' })
    expect(rows).toHaveLength(previewRecords.length)
    rows.forEach((row, index) => {
      for (const key of [
        'date',
        'source',
        'country',
        'clicks',
        'leads',
        'trials',
        'installs',
        'purchases',
        'activations',
        'eligibleRevenueMinor',
        'earningsMinor',
      ] as const)
        expect(row[key]).toBe(previewRecords[index][key])
      expect(row.visitorIds).toHaveLength(previewRecords[index].visitors)
    })
    expect(previewPayouts[0].earningsMinor).toBe(
      sumMetric(
        previewRecords.filter((row) => row.date >= previewPayouts[0].start),
        'earningsMinor',
      ),
    )
    expect(previewLinks.reduce((total, link) => total + link.earningsMinor, 0)).toBe(
      aggregateReport(defaultRows.filter((row) => row.source !== 'Direct / untagged'))
        .earningsMinor,
    )
  })
})

describe('report aggregation semantics', () => {
  it('keeps missing dimensions separate from named values and canonicalizes untagged sources', () => {
    const rows = [
      record({ campaign: '', country: '', source: '', clicks: 2 }),
      record({
        campaign: 'No campaign',
        country: 'Country unavailable',
        source: 'Direct / untagged',
        clicks: 3,
      }),
    ]
    expect(dimensionReport(rows, 'campaign')).toHaveLength(2)
    expect(dimensionReport(rows, 'country')).toHaveLength(2)
    expect(new Set(dimensionReport(rows, 'campaign').map((row) => row.key)).size).toBe(2)
    const sources = dimensionReport(rows, 'source')
    expect(sources).toHaveLength(1)
    expect(sources[0].label).toBe('Direct / untagged')
    expect(sources[0].values.clicks).toBe(5)
  })
  it('deduplicates repeated visitor identities across dates instead of summing daily uniques', () => {
    const rows = [
      record({ date: '2026-08-01', visitorIds: ['a', 'b'] }),
      record({ date: '2026-08-02', visitorIds: ['b', 'c'] }),
    ]
    expect(aggregateReport(rows).visitors).toBe(3)
    const daily = timeReport(rows, { start: '2026-08-01', end: '2026-08-02' }, 'day')
    expect(daily.map((row) => row.values.visitors)).toEqual([2, 2])
    expect(
      timeReport(rows, { start: '2026-08-01', end: '2026-08-02' }, 'month')[0].values.visitors,
    ).toBe(3)
  })

  it('treats active subscriptions as a current snapshot that ignores date range but respects dimensions', () => {
    const expected = currentSubscriptions(defaultReportingFilters)
    expect(expected).toBeGreaterThan(0)
    expect(currentSubscriptions({ ...defaultReportingFilters, period: '14' })).toBe(expected)
    expect(
      currentSubscriptions({
        ...defaultReportingFilters,
        period: 'custom',
        customStart: '2026-01-01',
        customEnd: '2026-01-01',
      }),
    ).toBe(expected)
    expect(
      currentSubscriptions({ ...defaultReportingFilters, source: 'Social media' }),
    ).toBeLessThan(expected)
    expect(currentSubscriptions({ ...defaultReportingFilters, subId: 'absent' })).toBe(0)
    expect(currentSubscriptions(defaultReportingFilters, true)).toBe(0)
    expect(metricDefinitions.activeSubscriptions.definition).toContain('date range does not change')
    expect(allPeriodMetrics).not.toContain('activeSubscriptions')
  })

  it('uses exact ledger minor units, signed adjustments, and total-based rates', () => {
    const rows = [
      record({ clicks: 100, purchases: 5, earningsMinor: 101 }),
      record({ clicks: 10, purchases: 5, earningsMinor: -2 }),
    ]
    expect(aggregateReport(rows).earningsMinor).toBe(99)
    expect(aggregateReport(rows).newPaidRate).toBe(10 / 110)
    expect(formatMetric('earningsMinor', -1494)).toBe('-$14.94')
    expect(formatMetric('newPaidRate', 10 / 110)).toBe('9.09%')
    expect(aggregateReport([record({ clicks: 0, purchases: 0 })]).newPaidRate).toBeNull()
  })

  it('propagates missing records and provider coverage instead of reporting partial sums', () => {
    const rows = [
      record({ installs: 5, visitorIds: ['one'] }),
      record({ installs: null, visitorIds: null }),
    ]
    expect(aggregateReport(rows).installs).toBeNull()
    expect(aggregateReport(rows).visitors).toBeNull()
    expect(aggregateReport(defaultRows, ['installs', 'activations']).installs).toBeNull()
    const daily = timeReport(defaultRows, reportRange(defaultReportingFilters), 'day', [
      'installs',
      'activations',
    ])
    expect(
      daily.every((row) => row.values.installs === null && row.values.activations === null),
    ).toBe(true)
    expect(
      dimensionReport(defaultRows, 'source', ['installs']).every(
        (row) => row.values.installs === null,
      ),
    ).toBe(true)
    expect(formatMetric('installs', null)).toBe('—')
  })

  it('distinguishes known empty buckets from missing coverage, including undefined rates', () => {
    const range = { start: '2026-08-25', end: '2026-08-26' }
    const complete = timeReport([], range, 'day')
    expect(complete.map((row) => row.values.clicks)).toEqual([0, 0])
    expect(complete.every((row) => row.values.newPaidRate === null)).toBe(true)
    expect(
      timeReport([], range, 'day', ['installs']).every((row) => row.values.installs === null),
    ).toBe(true)
    expect(aggregateReport([], ['installs']).installs).toBeNull()
  })

  it.each(['source', 'country', 'campaign', 'funnel', 'subId'] as Exclude<Breakdown, 'date'>[])(
    'reconciles all dimension totals including untagged attribution for %s',
    (dimension) => {
      const grouped = dimensionReport(defaultRows, dimension)
      const totals = aggregateReport(defaultRows)
      for (const key of [...additiveMetrics, 'visitors'] as const)
        expect(grouped.reduce((total, row) => total + row.values[key]!, 0)).toBe(totals[key])
      if (dimension === 'source')
        expect(grouped.map((row) => row.label)).toContain('Direct / untagged')
      if (dimension === 'subId') expect(grouped.map((row) => row.label)).toContain('untagged')
    },
  )

  it.each(['day', 'week', 'month'] as const)(
    'reconciles additive totals across %s buckets but recomputes visitors and rates',
    (grain) => {
      const grouped = timeReport(defaultRows, reportRange(defaultReportingFilters), grain)
      const totals = aggregateReport(defaultRows)
      for (const key of additiveMetrics)
        expect(grouped.reduce((total, row) => total + row.values[key]!, 0)).toBe(totals[key])
      expect(
        grouped.reduce((total, row) => total + row.values.visitors!, 0),
      ).toBeGreaterThanOrEqual(totals.visitors!)
    },
  )

  it('sorts raw numbers and chronological date keys, with missing values last both ways', () => {
    const rows: ReportRow[] = [
      {
        key: 'a',
        label: 'Aug 10',
        start: '2026-08-10',
        values: { ...aggregateReport([]), earningsMinor: 9 },
      },
      {
        key: 'b',
        label: 'Aug 2',
        start: '2026-08-02',
        values: { ...aggregateReport([]), earningsMinor: 100 },
      },
      {
        key: 'c',
        label: 'Aug 1',
        start: '2026-08-01',
        values: { ...aggregateReport([]), earningsMinor: null },
      },
    ]
    expect(
      sortReport(rows, { key: 'earningsMinor', direction: 'asc' }).map((row) => row.key),
    ).toEqual(['a', 'b', 'c'])
    expect(
      sortReport(rows, { key: 'earningsMinor', direction: 'desc' }).map((row) => row.key),
    ).toEqual(['b', 'a', 'c'])
    expect(sortReport(rows, { key: 'label', direction: 'asc' }).map((row) => row.key)).toEqual([
      'c',
      'b',
      'a',
    ])
    expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('report export and reconciliation previews', () => {
  it('exports every sorted row and all period metrics plus deduplicated totals, not just a page', () => {
    const totals = aggregateReport(defaultRows, ['installs', 'activations'])
    const grouped = sortReport(
      timeReport(defaultRows, reportRange(defaultReportingFilters), 'day', [
        'installs',
        'activations',
      ]),
      { key: 'earningsMinor', direction: 'desc' },
    )
    const csv = reportCsv(grouped, totals, defaultReportingFilters, 'date', 'day', 'preliminary')
    expect(csv.rows).toHaveLength(31)
    expect(csv.rows[0][11]).toBe(grouped[0].label)
    expect(csv.rows[0].slice(0, 6)).toEqual([
      'UI PREVIEW ONLY',
      'Example product (sample)',
      '2026-07-28',
      '2026-08-26',
      'UTC',
      'preliminary',
    ])
    expect(csv.headers).toContain('Gross collected (USD)')
    expect(csv.headers).toContain('New paid / click (%)')
    expect(csv.rows.every((row) => row.length === csv.headers.length)).toBe(true)
    expect(
      csv.rows.every((row) => row[csv.headers.indexOf('Confirmed installs')] === 'Unavailable'),
    ).toBe(true)
    expect(csv.rows.at(-1)?.[csv.headers.indexOf('Unique visitors')]).toBe(totals.visitors)
    expect(csv.rows.at(-1)?.[csv.headers.indexOf('Partner earnings (USD)')]).toBe(
      totals.earningsMinor! / 100,
    )
    expect(csv.headers).not.toContain('Active subscriptions')
  })

  it('keeps negative money numeric and escapes formula-like dimension labels in CSV', () => {
    const totals = { ...aggregateReport([]), earningsMinor: -1494 }
    const csv = reportCsv(
      [{ key: '=formula', label: '=formula', values: totals }],
      totals,
      defaultReportingFilters,
      'source',
      'day',
      'preliminary',
    )
    expect(csv.rows[0][csv.headers.indexOf('Partner earnings (USD)')]).toBe(-14.94)
    const content = csvContent(csv.headers, csv.rows)
    expect(content).toContain('"\'=formula"')
    expect(content).toContain('"-14.94"')
    expect(content).not.toContain('"\'-14.94"')
  })

  it('never finalizes open periods or reconciles missing provider data', () => {
    const current = reportRange(defaultReportingFilters)
    const closed = { start: '2026-08-03', end: '2026-08-16' }
    expect(effectiveStage('finalized', current, false)).toBe('preliminary')
    expect(effectiveStage('finalized', closed, false)).toBe('finalized')
    expect(effectiveStage('reconciled', current, false)).toBe('reconciled')
    expect(effectiveStage('reconciled', closed, true)).toBe('preliminary')
    expect(effectiveStage('finalized', closed, true)).toBe('preliminary')
  })
})
