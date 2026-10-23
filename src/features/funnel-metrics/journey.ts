/** Same-acquisition-cohort reporting. These values never change commercial agreement terms. */
export const JOURNEY_LEARNER_KEYS = [
  'visitors',
  'leads',
  'verified',
  'assessment_started',
  'assessment_completed',
  'availability_saved',
  'invitation_requested',
  'registered',
  'attended',
  'attendance_unknown',
  'attendance_missed',
  'checkout_started',
  'cancelled_checkout',
  'paid',
  'matching_pool',
  'group_confirmed',
] as const

export type FunnelJourneyReport = {
  schemaVersion: 2
  environment: 'test' | 'live'
  conversionWindowDays: number
  cohortFrom: string
  cohortTo: string
  observedUntil: string
  immature: boolean
  validClicks: number
  unclassifiedClicks: number
  definitionVersion?: number | null
  definitionPublishedAt?: string | null
  template?: import('./journeyDefinitions').JourneyTemplate | null
  configuredStages?: Array<{ key: string; label: string; people: number }>
  configuredRates?: FunnelJourneyReport['rates']
  configuredPaths?: Array<{ key: string; label: string; people: number }>
  learners: Record<(typeof JOURNEY_LEARNER_KEYS)[number], number>
  rates: Array<{
    key: string
    label: string
    numerator: number
    denominator: number
    value: number | null
    status: 'available' | 'zero_denominator'
  }>
  paths: Array<{ key: string; label: string; orders: number }>
  commerce: Array<{
    currency: string
    paidOrders: number
    refundedOrders: number
    collectedMinor: number
    refundedMinor: number
    refundRate: number | null
    refundedRevenueRate: number | null
    pendingCommissionMinor: number
    approvedCommissionMinor: number
    paidCommissionMinor: number
    reversedCommissionMinor: number
    approvedEpcMinor: number | null
    pendingEpcMinor: number | null
    earningsPer1000ClicksMinor: number | null
  }>
  warnings: string[]
}

type Row = Record<string, unknown>
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid journey.')
  return value as Row
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw Error('Invalid journey text.')
  return value
}
const numeric = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid journey number.')
  return value
}
const count = (value: unknown): number => {
  const parsed = numeric(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Error('Invalid journey count.')
  return parsed
}
const money = (value: unknown): number => {
  const parsed = numeric(value)
  if (!Number.isSafeInteger(parsed)) throw Error('Invalid journey amount.')
  return parsed
}
const nullable = (value: unknown, parse = numeric): number | null =>
  value === null ? null : parse(value)
const percentage = (value: unknown): number => {
  const parsed = numeric(value)
  if (parsed < 0 || parsed > 100) throw Error('Invalid journey percentage.')
  return parsed
}
const list = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw Error('Invalid journey collection.')
  return value.map(object)
}

export function mapFunnelJourney(value: unknown): FunnelJourneyReport {
  const source = object(value)
  if (
    source.schema_version !== 2 ||
    !['test', 'live'].includes(String(source.environment)) ||
    typeof source.immature !== 'boolean'
  )
    throw Error('Invalid journey scope.')
  const windowDays = count(source.conversion_window_days)
  if (windowDays < 1 || windowDays > 365) throw Error('Invalid journey window.')
  const learners = object(source.learners)
  const warnings = source.warnings
  if (!Array.isArray(warnings)) throw Error('Invalid journey warnings.')
  return {
    schemaVersion: 2,
    environment: source.environment as 'test' | 'live',
    conversionWindowDays: windowDays,
    cohortFrom: text(source.cohort_from),
    cohortTo: text(source.cohort_to),
    observedUntil: text(source.observed_until),
    immature: source.immature,
    validClicks: count(source.valid_clicks),
    unclassifiedClicks: count(source.unclassified_clicks),
    ...(source.definition_version !== undefined ? configuredJourney(source) : {}),
    learners: Object.fromEntries(
      JOURNEY_LEARNER_KEYS.map((key) => [key, count(learners[key])]),
    ) as FunnelJourneyReport['learners'],
    rates: list(source.rates).map((rate) => {
      const key = text(rate.key)
      const denominator = count(rate.denominator)
      const numerator = count(rate.numerator)
      if (
        !['available', 'zero_denominator'].includes(String(rate.status)) ||
        (denominator === 0) !== (rate.status === 'zero_denominator') ||
        (rate.status === 'zero_denominator' ? rate.value !== null : rate.value === null) ||
        (key !== 'click_to_signup' && numerator > denominator)
      )
        throw Error('Invalid journey rate.')
      return {
        key,
        label: text(rate.label),
        numerator,
        denominator,
        value: nullable(
          rate.value,
          key === 'click_to_signup'
            ? (value) => {
                const parsed = numeric(value)
                if (parsed < 0) throw Error('Invalid click conversion.')
                return parsed
              }
            : percentage,
        ),
        status: rate.status as 'available' | 'zero_denominator',
      }
    }),
    paths: list(source.paths).map((path) => ({
      key: text(path.key),
      label: text(path.label),
      orders: count(path.orders),
    })),
    commerce: list(source.commerce).map((item) => {
      const currency = text(item.currency)
      if (!/^[A-Z]{3}$/.test(currency)) throw Error('Invalid journey currency.')
      return {
        currency,
        paidOrders: count(item.paid_orders),
        refundedOrders: count(item.refunded_orders),
        collectedMinor: money(item.collected_minor),
        refundedMinor: money(item.refunded_minor),
        refundRate: nullable(item.refund_rate, percentage),
        refundedRevenueRate: nullable(item.refunded_revenue_rate, percentage),
        pendingCommissionMinor: money(item.pending_commission_minor),
        approvedCommissionMinor: money(item.approved_commission_minor),
        paidCommissionMinor: money(item.paid_commission_minor),
        reversedCommissionMinor: money(item.reversed_commission_minor),
        approvedEpcMinor: nullable(item.approved_epc_minor),
        pendingEpcMinor: nullable(item.pending_epc_minor),
        earningsPer1000ClicksMinor: nullable(item.earnings_per_1000_clicks_minor),
      }
    }),
    warnings: warnings.map(text),
  }
}

function configuredJourney(
  source: Row,
): Pick<
  FunnelJourneyReport,
  | 'definitionVersion'
  | 'definitionPublishedAt'
  | 'template'
  | 'configuredStages'
  | 'configuredRates'
  | 'configuredPaths'
> {
  const version = source.definition_version === null ? null : count(source.definition_version)
  if (
    version === 0 ||
    (version !== null &&
      !['blank', 'webinar', 'sales', 'custom'].includes(String(source.definition_template)))
  )
    throw Error('Invalid configured journey version.')
  const published =
    source.definition_published_at === null ? null : text(source.definition_published_at)
  if (
    (version === null) !== (published === null) ||
    (published !== null && !Number.isFinite(Date.parse(published)))
  )
    throw Error('Invalid configured journey publication.')
  const counts = (v: unknown) =>
    list(v).map((r) => ({ key: text(r.key), label: text(r.label), people: count(r.people) }))
  const stages = counts(source.configured_stages),
    paths = counts(source.configured_paths)
  const rates = list(source.configured_rates).map((r) => {
    const numerator = count(r.numerator),
      denominator = count(r.denominator)
    if (
      numerator > denominator ||
      !['available', 'zero_denominator'].includes(String(r.status)) ||
      (denominator === 0) !== (r.status === 'zero_denominator') ||
      (denominator === 0 ? r.value !== null : r.value === null)
    )
      throw Error('Invalid configured journey rate.')
    return {
      key: text(r.key),
      label: text(r.label),
      numerator,
      denominator,
      value: nullable(r.value, percentage),
      status: r.status as 'available' | 'zero_denominator',
    }
  })
  if (version === null && (stages.length || paths.length || rates.length))
    throw Error('Unpublished journey has configured data.')
  return {
    definitionVersion: version,
    definitionPublishedAt: published,
    template: source.definition_template as FunnelJourneyReport['template'],
    configuredStages: stages,
    configuredRates: rates,
    configuredPaths: paths,
  }
}
