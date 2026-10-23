import type { FunnelMetricDefinition, FunnelMetricReportFilter } from './types'
export const FUNNEL_METRIC_LIMIT = 24
export const FUNNEL_METRIC_KINDS = [
  'event_count',
  'unique_people',
  'unique_per_context',
  'current_state',
  'live_presence',
  'ratio',
] as const
export const FUNNEL_METRIC_RATIO_KINDS: readonly string[] = [
  'event_count',
  'unique_people',
  'unique_per_context',
  'current_state',
]
export const metricKindLabels = {
  event_count: 'Number of events',
  unique_people: 'Unique people',
  unique_per_context: 'Unique people per event or cohort',
  current_state: 'People currently in a state',
  live_presence: 'People active right now',
  ratio: 'Ratio percentage',
}
const keyPattern = /^[a-z][a-z0-9_]{0,49}$/
const eventPattern = /^[a-z][a-z0-9_]{0,79}$/
export function validateMetricDefinitions(
  metrics: FunnelMetricDefinition[],
  allowEmpty = true,
): string[] {
  const errors: string[] = []
  if (!allowEmpty && metrics.length === 0) errors.push('Add at least one metric before publishing.')
  if (metrics.length > FUNNEL_METRIC_LIMIT)
    errors.push(`A funnel can have up to ${FUNNEL_METRIC_LIMIT} metrics.`)
  const keys = new Set<string>()
  metrics.forEach((metric, index) => {
    const prefix = `Metric ${index + 1}: `
    if (!keyPattern.test(metric.key))
      errors.push(
        prefix +
          'use a key of 1–50 lowercase letters, numbers and underscores, starting with a letter.',
      )
    if (keys.has(metric.key)) errors.push(prefix + 'choose a unique metric key.')
    keys.add(metric.key)
    if (!metric.label.trim() || metric.label.trim().length > 80)
      errors.push(prefix + 'enter a name of 1–80 characters.')
    if (!FUNNEL_METRIC_KINDS.includes(metric.kind))
      errors.push(prefix + 'choose a supported counting method.')
    if (metric.kind !== 'ratio' && !eventPattern.test(metric.eventKey))
      errors.push(prefix + 'enter an event key of 1–80 lowercase letters, numbers and underscores.')
    if (metric.kind === 'current_state' && !keyPattern.test(metric.config.stateValue || ''))
      errors.push(prefix + 'enter the state value to count.')
    if (metric.kind === 'ratio') {
      const preceding = metrics
        .slice(0, index)
        .filter((item) => FUNNEL_METRIC_RATIO_KINDS.includes(item.kind))
      if (
        !preceding.some((item) => item.key === metric.config.numeratorKey) ||
        !preceding.some((item) => item.key === metric.config.denominatorKey)
      )
        errors.push(prefix + 'choose two count metrics above this percentage.')
      if (metric.config.numeratorKey === metric.config.denominatorKey)
        errors.push(prefix + 'choose different numerator and denominator metrics.')
    }
  })
  return errors
}
export function validateMetricReportFilter(input: FunnelMetricReportFilter) {
  if (
    input.journeyVersion !== undefined &&
    (!Number.isSafeInteger(input.journeyVersion) || input.journeyVersion < 1)
  )
    return 'Choose a published journey version.'
  if (input.environment !== undefined && !['test', 'live'].includes(input.environment))
    return 'Choose Test or Live reporting.'
  if (
    input.conversionWindowDays !== undefined &&
    (!Number.isInteger(input.conversionWindowDays) ||
      input.conversionWindowDays < 1 ||
      input.conversionWindowDays > 365)
  )
    return 'Choose a reporting conversion window between 1 and 365 days.'
  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency))
    return 'Use a three-letter uppercase currency code, such as USD.'
  for (const key of ['channel', 'entryVariant', 'webinarId', 'intakeId', 'contextId'] as const) {
    if (input[key] !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input[key]!))
      return 'Use a channel or context ID containing letters, numbers, underscores or hyphens.'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to))
    return 'Choose valid start and end dates.'
  const first = Date.parse(input.from + 'T00:00:00Z'),
    last = Date.parse(input.to + 'T00:00:00Z')
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    new Date(first).toISOString().slice(0, 10) !== input.from ||
    new Date(last).toISOString().slice(0, 10) !== input.to ||
    last < first
  )
    return 'The end date must be on or after the start date.'
  if ((last - first) / 86400000 > 366) return 'Choose a reporting period of up to one year.'
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format()
  } catch {
    return 'Choose a valid reporting time zone.'
  }
  return null
}
