import type { FunnelMetricValue } from '../../funnel-metrics'

export function formatFunnelMetric(metric: Pick<FunnelMetricValue, 'kind' | 'value'>): string {
  if (metric.value === null || !Number.isFinite(metric.value)) return '—'
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: metric.kind === 'ratio' ? 1 : 0,
  }).format(metric.value)
  // The reporting contract returns percentages, not fractions.
  return metric.kind === 'ratio' ? `${formatted}%` : formatted
}

export function funnelMetricMeaning(kind: string): string {
  switch (kind) {
    case 'event_count':
      return 'Events in the selected reporting period. Repeat actions can count more than once.'
    case 'unique_people':
      return 'Distinct people in the selected reporting period. Repeat events from the same person count once.'
    case 'unique_per_context':
      return 'Distinct person and context pairs. One person can count again in a different configured context.'
    case 'current_state':
      return 'People per context in the configured state at the report snapshot time. One person can count in multiple contexts.'
    case 'live_presence':
      return 'People per context with an unexpired presence signal at the report snapshot time. One person can count in multiple contexts. This is not total attendance.'
    case 'ratio':
      return 'Percentage calculated from the configured numerator and denominator for this reporting scope.'
    default:
      return 'Calculated using the published funnel definition.'
  }
}

export function formatFunnelTimestamp(value: string | null, timeZone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not available'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function formatFunnelMoney(minor: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency })
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  return formatter.format(minor / 10 ** digits)
}

export function funnelMetricDateError(from: string, to: string): string | null {
  const valid = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  if (!valid(from) || !valid(to)) return 'Choose a valid start and end date.'
  if (from > to) return 'The start date must be on or before the end date.'
  if (Date.parse(to) - Date.parse(from) > 365 * 86_400_000)
    return 'Choose a reporting period of up to 366 days.'
  return null
}
