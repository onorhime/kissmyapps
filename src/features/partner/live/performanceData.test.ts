import { describe, expect, it } from 'vitest'
import { emptyPartnerDashboardSummary, type PartnerTrendPoint } from '../api'
import { dailySeries, rate, sourceBreakdown } from './performanceData'

function point(date: string, key: string, clicks: number | null): PartnerTrendPoint {
  return {
    bucketStart: date,
    bucketEnd: date,
    dimensionKey: key,
    dimensionLabel: key.toUpperCase(),
    reconciliationStage: 'preliminary',
    metrics: { ...emptyPartnerDashboardSummary().metrics, clicks, funnelStarts: 0 },
  }
}

describe('partner performance data', () => {
  it('fills every day of the window and sums sources per day', () => {
    const series = dailySeries(
      [point('2026-10-01', 'a', 3), point('2026-10-01', 'b', 2), point('2026-10-03', 'a', 1)],
      '2026-10-01',
      '2026-10-04',
    )
    expect(series.map((day) => [day.date, day.metrics.clicks])).toEqual([
      ['2026-10-01', 5],
      ['2026-10-02', 0],
      ['2026-10-03', 1],
      ['2026-10-04', 0],
    ])
  })

  it('keeps an unknown bucket unknown instead of adding it as zero', () => {
    const [day] = dailySeries(
      [point('2026-10-01', 'a', 3), point('2026-10-01', 'b', null)],
      '2026-10-01',
      '2026-10-01',
    )
    expect(day.metrics.clicks).toBeNull()
    expect(sourceBreakdown([point('2026-10-01', 'b', null)])[0].metrics.clicks).toBeNull()
  })

  it('formats rates only when both sides are known', () => {
    expect(rate(61, 1596)).toBe('3.8%')
    expect(rate(55, 100)).toBe('55%')
    expect(rate(null, 100)).toBeNull()
    expect(rate(1, 0)).toBeNull()
  })
})
