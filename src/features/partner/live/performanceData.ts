import type { PartnerMetricValues, PartnerTrendPoint } from '../api'

export const reportingPeriods = [7, 30, 90] as const
export type ReportingPeriod = (typeof reportingPeriods)[number]

export type MetricKey = keyof Pick<
  PartnerMetricValues,
  'clicks' | 'funnelStarts' | 'paymentViews' | 'appStoreClicks' | 'purchases'
>

export const metricLabels: Record<MetricKey, string> = {
  clicks: 'Clicks',
  funnelStarts: 'Funnel starts',
  paymentViews: 'Payment views',
  appStoreClicks: 'App-store clicks',
  purchases: 'Paid purchases',
}

export type TrafficMetrics = Readonly<Pick<PartnerMetricValues, MetricKey>>

type TrafficSourceRow = Readonly<{
  key: string
  label: string
  metrics: TrafficMetrics
}>

export type DailyPoint = Readonly<{ date: string; metrics: TrafficMetrics }>

/** A share of a known whole; unknown inputs stay unknown instead of becoming 0%. */
export function rate(part: number | null, whole: number | null) {
  if (part === null || whole === null || whole === 0) return null
  const value = (part / whole) * 100
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')}%`
}

export function addKnown(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right
}

function pick(metrics: PartnerMetricValues): TrafficMetrics {
  return {
    clicks: metrics.clicks,
    funnelStarts: metrics.funnelStarts,
    paymentViews: metrics.paymentViews,
    appStoreClicks: metrics.appStoreClicks,
    purchases: metrics.purchases,
  }
}

function combine(left: TrafficMetrics, right: TrafficMetrics): TrafficMetrics {
  return {
    clicks: addKnown(left.clicks, right.clicks),
    funnelStarts: addKnown(left.funnelStarts, right.funnelStarts),
    paymentViews: addKnown(left.paymentViews, right.paymentViews),
    appStoreClicks: addKnown(left.appStoreClicks, right.appStoreClicks),
    purchases: addKnown(left.purchases, right.purchases),
  }
}

/**
 * Source reporting remains date-grained in the RPC so the UI combines each
 * source's buckets. A null bucket keeps the aggregate unknown instead of being
 * silently treated as zero.
 */
export function sourceBreakdown(points: readonly PartnerTrendPoint[]): readonly TrafficSourceRow[] {
  const rows = new Map<string, TrafficSourceRow>()
  for (const point of points) {
    const current = rows.get(point.dimensionKey)
    rows.set(point.dimensionKey, {
      key: point.dimensionKey,
      label: point.dimensionLabel,
      metrics: current ? combine(current.metrics, pick(point.metrics)) : pick(point.metrics),
    })
  }
  return [...rows.values()].sort((left, right) => {
    const clickDifference = (right.metrics.clicks ?? -1) - (left.metrics.clicks ?? -1)
    return clickDifference || left.label.localeCompare(right.label)
  })
}

const zero: TrafficMetrics = {
  clicks: 0,
  funnelStarts: 0,
  paymentViews: 0,
  appStoreClicks: 0,
  purchases: 0,
}

/**
 * One entry per calendar day in the window. A day with no reported bucket had
 * no attributed activity, so it is a real zero; a null bucket stays unknown.
 */
export function dailySeries(
  points: readonly PartnerTrendPoint[],
  startsOn: string | null,
  endsOn: string | null,
): readonly DailyPoint[] {
  const days = new Map<string, TrafficMetrics>()
  for (const point of points) {
    const date = point.bucketStart.slice(0, 10)
    const current = days.get(date)
    days.set(date, current ? combine(current, pick(point.metrics)) : pick(point.metrics))
  }
  const known = [...days.keys()].sort()
  const first = startsOn ?? known[0]
  const last = endsOn ?? known.at(-1)
  if (!first || !last) return []
  const series: DailyPoint[] = []
  for (
    let cursor = Date.parse(`${first}T00:00:00Z`);
    cursor <= Date.parse(`${last}T00:00:00Z`) && series.length < 400;
    cursor += 86_400_000
  ) {
    const date = new Date(cursor).toISOString().slice(0, 10)
    series.push({ date, metrics: days.get(date) ?? zero })
  }
  return series
}
