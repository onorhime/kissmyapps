import { describe, expect, it } from 'vitest'
import {
  formatFunnelMetric,
  formatFunnelMoney,
  formatFunnelTimestamp,
  funnelMetricDateError,
  funnelMetricMeaning,
} from './funnelMetricPresentation'

describe('configured metric presentation', () => {
  it('distinguishes real zero, unavailable values and percentages', () => {
    expect(formatFunnelMetric({ kind: 'event_count', value: 0 })).toBe('0')
    expect(formatFunnelMetric({ kind: 'event_count', value: null })).toBe('—')
    expect(formatFunnelMetric({ kind: 'event_count', value: 1_250 })).toBe('1,250')
    expect(formatFunnelMetric({ kind: 'ratio', value: 32.55 })).toBe('32.6%')
    expect(formatFunnelMetric({ kind: 'ratio', value: 0 })).toBe('0%')
    expect(formatFunnelMetric({ kind: 'ratio', value: 150 })).toBe('150%')
    expect(formatFunnelMetric({ kind: 'ratio', value: Number.NaN })).toBe('—')
  })
  it('explains count and snapshot semantics separately', () => {
    expect(funnelMetricMeaning('unique_people')).toContain('count once')
    expect(funnelMetricMeaning('unique_per_context')).toContain('different configured context')
    expect(funnelMetricMeaning('live_presence')).toContain('not total attendance')
    expect(funnelMetricMeaning('current_state')).toContain('snapshot time')
  })
  it('preserves currency units instead of mixing money with metric counts', () => {
    expect(formatFunnelMoney(17900, 'USD')).toBe('$179.00')
    expect(formatFunnelMoney(17900, 'JPY')).toBe('¥17,900')
  })
  it('validates real calendar dates and bounds the reporting range', () => {
    expect(funnelMetricDateError('2026-02-30', '2026-03-01')).toContain('valid')
    expect(funnelMetricDateError('2026-10-14', '2026-10-13')).toContain('before')
    expect(funnelMetricDateError('2025-01-01', '2026-10-13')).toContain('366')
    expect(funnelMetricDateError('2026-10-01', '2026-10-14')).toBeNull()
    expect(formatFunnelTimestamp(null, 'UTC')).toBe('Not available')
    expect(formatFunnelTimestamp('invalid', 'UTC')).toBe('Not available')
    expect(formatFunnelTimestamp('2026-10-14T10:00:00Z', 'UTC')).toContain('10:00')
  })
})
