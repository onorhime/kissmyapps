import {
  money,
  number,
  previewCampaigns,
  previewCountries,
  previewFunnels,
  previewRecords,
  previewSources,
  shortDate,
} from './data'
import type { PerformanceRecord } from './data'

// This module is a UI fixture projection, not an analytics or payment integration.
// Keep the existing 90-day link/payout fixtures unchanged when extending reporting.
export const REPORT_TODAY = '2026-08-26'
export const REPORT_COVERAGE_START = '2026-01-01'
const DAY_MS = 86_400_000
const originalStart = '2026-05-29'

export type ReportingPeriod = '14' | '30' | '90' | 'year' | 'custom'
export type TimeGrain = 'day' | 'week' | 'month'
export type Breakdown = 'date' | 'source' | 'country' | 'campaign' | 'funnel' | 'subId'
export type ChartGroup = 'traffic' | 'conversion' | 'revenue'
export type ReconciliationStage = 'preliminary' | 'reconciled' | 'finalized'
export type DateRange = { start: string; end: string }
type Dimensions = Pick<PerformanceRecord, 'source' | 'country' | 'campaign' | 'funnel' | 'subId'>

export type ReportingFilters = Dimensions & {
  period: ReportingPeriod
  customStart: string
  customEnd: string
}

export const defaultReportingFilters: ReportingFilters = {
  period: '30',
  customStart: '2026-07-28',
  customEnd: REPORT_TODAY,
  source: 'all',
  country: 'all',
  campaign: 'all',
  funnel: 'all',
  subId: '',
}

export const additiveMetrics = [
  'clicks',
  'funnelStarts',
  'paymentViews',
  'appStoreClicks',
  'leads',
  'trials',
  'installs',
  'purchases',
  'activations',
  'renewals',
  'cancellations',
  'refunds',
  'disputes',
  'grossCollectedMinor',
  'eligibleRevenueMinor',
  'earningsMinor',
] as const
type AdditiveMetric = (typeof additiveMetrics)[number]
export type PeriodMetric = AdditiveMetric | 'visitors' | 'newPaidRate'
export type MetricKey = PeriodMetric | 'activeSubscriptions'
export type MetricValues = Record<PeriodMetric, number | null>
export type ReportingRecord = Dimensions &
  Record<AdditiveMetric, number | null> & {
    date: string
    // Synthetic identities exist only to test distinct-count semantics. A real
    // portal adapter must receive safe aggregate results, never raw visitor IDs.
    visitorIds: readonly string[] | null
  }

type MetricDefinition = {
  label: string
  kind: 'count' | 'money' | 'snapshot' | 'rate'
  definition: string
  note: string
}

export const metricDefinitions: Record<MetricKey, MetricDefinition> = {
  clicks: {
    label: 'Link clicks',
    kind: 'count',
    definition:
      'Valid tracking-link clicks after backend validation. A click is not a unique visitor or an install.',
    note: 'Validated tracking clicks',
  },
  visitors: {
    label: 'Unique visitors',
    kind: 'count',
    definition:
      'Distinct attributable visitors or sessions in the selected window. Totals are deduplicated across dates, not added from daily unique counts.',
    note: 'Deduplicated across the period',
  },
  funnelStarts: {
    label: 'Funnel starts',
    kind: 'count',
    definition:
      'Validated starts of an attributed web funnel. Repeated starts are events, not unique visitors.',
    note: 'Attributed funnel events',
  },
  paymentViews: {
    label: 'Payment views',
    kind: 'count',
    definition:
      'Attributed views of the payment step. A view does not confirm a payment or create earnings.',
    note: 'Payment-step views',
  },
  appStoreClicks: {
    label: 'App Store clicks',
    kind: 'count',
    definition:
      'Attributed outbound clicks to the App Store. These are separate from provider-confirmed installs.',
    note: 'Store visits, not installs',
  },
  leads: {
    label: 'Qualified leads',
    kind: 'count',
    definition:
      'Backend-approved lead events that meet the product’s qualification rules. Raw form submissions are not automatically qualified.',
    note: 'Validated lead events',
  },
  trials: {
    label: 'Trial starts',
    kind: 'count',
    definition:
      'Normalized, valid trial starts. Trial activity alone does not generate revenue-share earnings.',
    note: 'Valid trials, not paid customers',
  },
  installs: {
    label: 'Confirmed installs',
    kind: 'count',
    definition:
      'Installs confirmed through Singular where that integration is available. Unavailable install data is shown as an em dash, never zero.',
    note: 'Provider-confirmed installs',
  },
  purchases: {
    label: 'New paid customers',
    kind: 'count',
    definition:
      'First verified successful payments by attributed customers. Renewals are reported separately and do not count as new paid customers.',
    note: 'Verified first purchases',
  },
  activations: {
    label: 'App activations',
    kind: 'count',
    definition:
      'Attributed account activations confirmed by backend app events. An install alone is not an activation.',
    note: 'Attributed account activations',
  },
  renewals: {
    label: 'Renewals',
    kind: 'count',
    definition:
      'Verified repeat subscription payments in the reporting period. These are not first purchases.',
    note: 'Verified repeat payments',
  },
  cancellations: {
    label: 'Cancellations',
    kind: 'count',
    definition:
      'Normalized subscription cancellation events in the period. Cancellation and refund are different events.',
    note: 'Subscription cancellation events',
  },
  refunds: {
    label: 'Refunds',
    kind: 'count',
    definition:
      'Verified refund events in the period. Their financial effect is reflected in the eligible-revenue and commission ledgers.',
    note: 'Verified refund events',
  },
  disputes: {
    label: 'Disputes',
    kind: 'count',
    definition:
      'Normalized payment dispute events. Financial adjustments follow the agreement and the backend ledger, not a browser calculation.',
    note: 'Verified dispute events',
  },
  grossCollectedMinor: {
    label: 'Gross collected',
    kind: 'money',
    definition:
      'Verified gross payment collections before deductions used to determine eligible revenue. All displayed sample amounts are in USD.',
    note: 'Before eligibility deductions',
  },
  eligibleRevenueMinor: {
    label: 'Eligible revenue',
    kind: 'money',
    definition:
      'The agreement-defined revenue basis supplied by the backend ledger. It is not necessarily gross collections and is not the partner’s payout.',
    note: 'Revenue-share basis · Example terms',
  },
  earningsMinor: {
    label: 'Partner earnings',
    kind: 'money',
    definition:
      'Commission recorded by the backend ledger for the selected period, before payout adjustments. Sample terms are 30% revenue share; these are not a live agreement.',
    note: 'Before payout adjustments',
  },
  activeSubscriptions: {
    label: 'Active subscriptions',
    kind: 'snapshot',
    definition:
      'Current eligible active or trialing subscriptions, as of Aug 26, 2026 UTC in this sample. Dimension filters apply; the date range does not change this current snapshot. Daily subscription counts must never be added together.',
    note: 'Current · Aug 26, 2026 UTC',
  },
  newPaidRate: {
    label: 'New paid / click',
    kind: 'rate',
    definition:
      'New paid customers divided by validated clicks for the same selection. Totals use the total numerator and denominator, not an average of row percentages. No clicks means the rate is undefined.',
    note: 'Total new paid ÷ total clicks',
  },
}

export const primaryMetrics: MetricKey[] = [
  'earningsMinor',
  'clicks',
  'leads',
  'trials',
  'installs',
  'purchases',
  'activations',
  'activeSubscriptions',
]
export const secondaryMetrics: PeriodMetric[] = [
  'visitors',
  'eligibleRevenueMinor',
  'renewals',
  'cancellations',
  'refunds',
  'disputes',
]
export const chartGroups: Record<
  ChartGroup,
  { label: string; metrics: PeriodMetric[]; defaults: PeriodMetric[] }
> = {
  traffic: {
    label: 'Traffic',
    metrics: ['clicks', 'visitors', 'funnelStarts', 'paymentViews', 'appStoreClicks', 'installs'],
    defaults: ['clicks', 'visitors'],
  },
  conversion: {
    label: 'Conversion',
    metrics: [
      'leads',
      'trials',
      'purchases',
      'activations',
      'renewals',
      'cancellations',
      'refunds',
      'disputes',
    ],
    defaults: ['leads', 'purchases'],
  },
  revenue: {
    label: 'Revenue',
    metrics: ['grossCollectedMinor', 'eligibleRevenueMinor', 'earningsMinor'],
    defaults: ['earningsMinor'],
  },
}
export const tableMetrics: PeriodMetric[] = [
  'clicks',
  'visitors',
  'leads',
  'trials',
  'installs',
  'purchases',
  'activations',
  'renewals',
  'cancellations',
  'refunds',
  'eligibleRevenueMinor',
  'earningsMinor',
  'newPaidRate',
]
export const allPeriodMetrics: PeriodMetric[] = [
  ...tableMetrics,
  'funnelStarts',
  'paymentViews',
  'appStoreClicks',
  'disputes',
  'grossCollectedMinor',
]
export const breakdownLabels: Record<Breakdown, string> = {
  date: 'Date',
  source: 'Traffic source',
  country: 'Country',
  campaign: 'Campaign',
  funnel: 'Funnel',
  subId: 'Sub ID',
}

export function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validateCustomRange(
  start: string,
  end: string,
): { field: 'start' | 'end'; message: string } | null {
  if (!validDate(start)) return { field: 'start', message: 'Enter a valid start date.' }
  if (!validDate(end)) return { field: 'end', message: 'Enter a valid end date.' }
  if (start < REPORT_COVERAGE_START)
    return { field: 'start', message: 'Sample data starts on Jan 1, 2026.' }
  if (start > REPORT_TODAY)
    return { field: 'start', message: 'Choose a start date on or before Aug 26, 2026.' }
  if (end < start)
    return { field: 'end', message: 'The end date must be on or after the start date.' }
  if (end > REPORT_TODAY)
    return { field: 'end', message: 'The sample snapshot ends on Aug 26, 2026.' }
  return null
}

export function reportRange(filters: ReportingFilters): DateRange {
  if (filters.period === 'custom') {
    const error = validateCustomRange(filters.customStart, filters.customEnd)
    if (error) throw new RangeError(error.message)
    return { start: filters.customStart, end: filters.customEnd }
  }
  return {
    start:
      filters.period === 'year'
        ? REPORT_COVERAGE_START
        : shiftDate(REPORT_TODAY, 1 - Number(filters.period)),
    end: REPORT_TODAY,
  }
}

export function rangeLabel(range: DateRange): string {
  return `${shortDate(range.start)} – ${shortDate(range.end)}, ${range.end.slice(0, 4)}`
}

export function resetDimensions(filters: ReportingFilters): ReportingFilters {
  return {
    ...defaultReportingFilters,
    period: filters.period,
    customStart: filters.customStart,
    customEnd: filters.customEnd,
  }
}

function matchesDimensions(row: Dimensions, filters: ReportingFilters): boolean {
  return (
    (['source', 'country', 'campaign', 'funnel'] as const).every(
      (key) => filters[key] === 'all' || row[key] === filters[key],
    ) &&
    (!filters.subId.trim() || row.subId.toLowerCase().includes(filters.subId.trim().toLowerCase()))
  )
}

function priorRecord(date: string, sourceIndex: number): PerformanceRecord {
  // Anchor to the original May 29 fixture rather than renumbering its dates.
  const day = (Date.parse(date) - Date.parse(originalStart)) / DAY_MS
  const clicks = Math.max(
    12,
    Math.round(225 - sourceIndex * 39 + day * 0.9 + Math.sin(day / 3.2 + sourceIndex) * 19),
  )
  const purchases = Math.round(clicks * (0.016 + sourceIndex * 0.0018))
  const renewals = (day + sourceIndex) % 3 === 0 ? 2 : 1
  const refunds = (day + sourceIndex) % 19 === 0 ? 1 : 0
  const eligibleRevenueMinor = (purchases + renewals - refunds) * 2490
  return {
    date,
    source: previewSources[sourceIndex],
    campaign: previewCampaigns[sourceIndex % 2],
    funnel: previewFunnels[sourceIndex % 2],
    country: previewCountries[(((day + sourceIndex) % 3) + 3) % 3],
    subId: sourceIndex === 4 ? 'untagged' : `placement-${sourceIndex + 1}`,
    clicks,
    visitors: Math.round(clicks * 0.82),
    leads: Math.round(clicks * 0.16),
    trials: Math.round(clicks * 0.06),
    installs: Math.round(clicks * 0.07),
    purchases,
    renewals,
    cancellations: (day + sourceIndex) % 11 === 0 ? 1 : 0,
    activations: Math.round(clicks * 0.048),
    refunds,
    eligibleRevenueMinor,
    earningsMinor: Math.round(eligibleRevenueMinor * 0.3),
  }
}

function reportingRecord(row: PerformanceRecord): ReportingRecord {
  const { visitors, ...rest } = row
  const day = (Date.parse(row.date) - Date.parse(REPORT_COVERAGE_START)) / DAY_MS
  // Each fictional identity has one exclusive attribution cohort so dimension
  // partitions reconcile, while repeat visits across dates remain deduplicated.
  const cohort = `${previewSources.indexOf(row.source)}:${previewCountries.indexOf(row.country)}`
  return {
    ...rest,
    visitorIds: Array.from(
      { length: visitors },
      (_, index) => `${cohort}:${(day % 13) * 13 + index}`,
    ),
    funnelStarts: Math.round(row.clicks * 0.75),
    paymentViews: Math.round(row.clicks * 0.12),
    appStoreClicks: Math.round(row.clicks * 0.1),
    disputes: 0,
    grossCollectedMinor: (row.purchases + row.renewals) * 2490,
  }
}

const earlierDayCount = (Date.parse(originalStart) - Date.parse(REPORT_COVERAGE_START)) / DAY_MS
export const reportingRecords: ReportingRecord[] = [
  ...Array.from({ length: earlierDayCount }, (_, day) =>
    previewSources.map((_, index) => priorRecord(shiftDate(REPORT_COVERAGE_START, day), index)),
  ).flat(),
  ...previewRecords,
].map(reportingRecord)

export function filterReportingRecords(
  filters: ReportingFilters,
  records = reportingRecords,
): ReportingRecord[] {
  const range = reportRange(filters)
  return records.filter(
    (row) => row.date >= range.start && row.date <= range.end && matchesDimensions(row, filters),
  )
}

export function aggregateReport(
  records: readonly ReportingRecord[],
  unavailable: readonly PeriodMetric[] = [],
): MetricValues {
  const values = {} as MetricValues
  for (const key of additiveMetrics) {
    values[key] =
      unavailable.includes(key) || records.some((row) => row[key] === null)
        ? null
        : records.reduce((total, row) => total + (row[key] as number), 0)
  }
  values.visitors =
    unavailable.includes('visitors') || records.some((row) => row.visitorIds === null)
      ? null
      : new Set(records.flatMap((row) => row.visitorIds ?? [])).size
  values.newPaidRate =
    unavailable.includes('newPaidRate') ||
    values.purchases === null ||
    values.clicks === null ||
    values.clicks === 0
      ? null
      : values.purchases / values.clicks
  return values
}

// A stock snapshot, independent of the selected historical date window.
export const subscriptionSnapshot = previewSources.flatMap((source, sourceIndex) =>
  previewCountries.map((country, countryIndex) => ({
    source,
    country,
    campaign: previewCampaigns[sourceIndex % 2],
    funnel: previewFunnels[sourceIndex % 2],
    subId: sourceIndex === 4 ? 'untagged' : `placement-${sourceIndex + 1}`,
    active: 83 - sourceIndex * 11 + countryIndex * 7,
  })),
)

export function currentSubscriptions(filters: ReportingFilters, empty = false): number {
  return empty
    ? 0
    : subscriptionSnapshot
        .filter((row) => matchesDimensions(row, filters))
        .reduce((total, row) => total + row.active, 0)
}

export type ReportRow = {
  key: string
  label: string
  start?: string
  end?: string
  values: MetricValues
}

export function timeBuckets(range: DateRange, grain: TimeGrain): Omit<ReportRow, 'values'>[] {
  const buckets = new Map<string, { start: string; end: string }>()
  for (let date = range.start; date <= range.end; date = shiftDate(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    const key =
      grain === 'day'
        ? date
        : grain === 'week'
          ? shiftDate(date, -((weekday + 6) % 7))
          : date.slice(0, 7)
    const existing = buckets.get(key)
    buckets.set(key, { start: existing?.start ?? date, end: date })
  }
  return Array.from(buckets, ([key, bucket]) => ({
    key,
    ...bucket,
    label:
      grain === 'month'
        ? new Intl.DateTimeFormat('en-US', {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(new Date(`${bucket.start}T00:00:00Z`))
        : bucket.start === bucket.end
          ? shortDate(bucket.start)
          : `${shortDate(bucket.start)} – ${shortDate(bucket.end)}`,
  }))
}

export function timeReport(
  records: readonly ReportingRecord[],
  range: DateRange,
  grain: TimeGrain,
  unavailable: readonly PeriodMetric[] = [],
): ReportRow[] {
  return timeBuckets(range, grain).map((bucket) => ({
    ...bucket,
    values: aggregateReport(
      records.filter((row) => row.date >= bucket.start! && row.date <= bucket.end!),
      unavailable,
    ),
  }))
}

export function dimensionReport(
  records: readonly ReportingRecord[],
  dimension: Exclude<Breakdown, 'date'>,
  unavailable: readonly PeriodMetric[] = [],
): ReportRow[] {
  const groups = new Map<string, { label: string; rows: ReportingRecord[] }>()
  const missingLabels = {
    source: 'Direct / untagged',
    country: 'Country unavailable',
    campaign: 'No campaign',
    funnel: 'No funnel',
    subId: 'Untagged',
  }
  for (const row of records) {
    const value = row[dimension].trim()
    // A blank source belongs to the canonical untagged source. Other missing
    // dimensions get distinct keys so a named campaign cannot swallow them.
    const key =
      dimension === 'source'
        ? `value:${value || missingLabels.source}`
        : value
          ? `value:${value}`
          : `missing:${dimension}`
    const group = groups.get(key) ?? { label: value || missingLabels[dimension], rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return Array.from(groups, ([key, group]) => ({
    key,
    label: group.label,
    values: aggregateReport(group.rows, unavailable),
  }))
}

export type ReportSort = { key: PeriodMetric | 'label'; direction: 'asc' | 'desc' }
export function sortReport(rows: readonly ReportRow[], sort: ReportSort): ReportRow[] {
  return [...rows].sort((a, b) => {
    const left = sort.key === 'label' ? (a.start ?? a.label) : a.values[sort.key]
    const right = sort.key === 'label' ? (b.start ?? b.label) : b.values[sort.key]
    // Missing values stay last in both directions; no coercion to zero.
    if (left === null && right !== null) return 1
    if (right === null && left !== null) return -1
    const compared =
      left === null || right === null
        ? 0
        : typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right))
    return compared ? compared * (sort.direction === 'asc' ? 1 : -1) : a.key.localeCompare(b.key)
  })
}

export function formatMetric(metric: MetricKey, value: number | null): string {
  if (value === null) return '—'
  const kind = metricDefinitions[metric].kind
  return kind === 'money'
    ? money(value)
    : kind === 'rate'
      ? `${(value * 100).toFixed(2)}%`
      : number(value)
}

export function effectiveStage(
  requested: ReconciliationStage,
  range: DateRange,
  partial: boolean,
): ReconciliationStage {
  if (partial || (requested === 'finalized' && range.end >= '2026-08-17')) return 'preliminary'
  return requested
}

export function reportCsv(
  rows: readonly ReportRow[],
  totals: MetricValues,
  filters: ReportingFilters,
  breakdown: Breakdown,
  grain: TimeGrain,
  stage: ReconciliationStage,
) {
  const range = reportRange(filters)
  const context: (string | number)[] = [
    'UI PREVIEW ONLY',
    'Example product (sample)',
    range.start,
    range.end,
    'UTC',
    stage,
    filters.source,
    filters.country,
    filters.campaign,
    filters.funnel,
    filters.subId || 'all',
  ]
  const values = (row: MetricValues) =>
    allPeriodMetrics.map((key) => {
      const value = row[key]
      if (value === null) return 'Unavailable'
      return metricDefinitions[key].kind === 'money'
        ? value / 100
        : key === 'newPaidRate'
          ? Number((value * 100).toFixed(2))
          : value
    })
  return {
    headers: [
      'Dataset',
      'Product',
      'Period start',
      'Period end',
      'Timezone',
      'Sample status',
      'Source filter',
      'Country filter',
      'Campaign filter',
      'Funnel filter',
      'Sub ID filter',
      `Breakdown (${breakdown === 'date' ? grain : breakdown})`,
      'Bucket start',
      'Bucket end',
      ...allPeriodMetrics.map(
        (key) =>
          `${metricDefinitions[key].label}${metricDefinitions[key].kind === 'money' ? ' (USD)' : key === 'newPaidRate' ? ' (%)' : ''}`,
      ),
    ],
    rows: [
      ...rows.map((row) => [
        ...context,
        row.label,
        row.start ?? range.start,
        row.end ?? range.end,
        ...values(row.values),
      ]),
      [
        ...context,
        'TOTAL (unique visitors deduplicated across period)',
        range.start,
        range.end,
        ...values(totals),
      ],
    ],
  }
}
