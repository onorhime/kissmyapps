import { useMemo, useState } from 'react'
import {
  AlertCircle,
  BadgeDollarSign,
  CircleHelp,
  Link2,
  MousePointerClick,
  RefreshCw,
  Repeat,
  ShoppingBag,
  Smartphone,
  SquareMousePointer,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { providerMoney } from '../../../lib/providerMoney'
import type { PartnerDashboardSummary, PartnerMetricValues, PartnerTrendPoint } from '../api'
import type { PartnerLiveResource } from './types'
import './LivePerformance.css'
import {
  addKnown,
  dailySeries,
  metricLabels,
  rate,
  reportingPeriods,
  sourceBreakdown,
  type DailyPoint,
  type MetricKey,
  type ReportingPeriod,
} from './performanceData'

function count(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function money(value: number | null, currency: string | null) {
  if (value === null || !currency) return '—'
  try {
    return providerMoney(value, currency)
  } catch {
    return '—'
  }
}

function shortDate(date: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function KpiCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
}) {
  return (
    <article className="panel performance-kpi">
      <span className="performance-kpi-label">
        <span className="performance-kpi-icon">
          <Icon size={16} aria-hidden="true" />
        </span>
        {label}
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function TrendChart({
  series,
  metrics,
}: {
  series: readonly DailyPoint[]
  metrics: readonly MetricKey[]
}) {
  const [selected, setSelected] = useState<MetricKey>(metrics[0])
  const active = metrics.includes(selected) ? selected : metrics[0]
  const values = series.map((point) => point.metrics[active])
  const known = values.filter((value): value is number => value !== null)
  const top = Math.max(...known, 1)
  const total = known.reduce((sum, value) => sum + value, 0)
  const best = series.reduce<DailyPoint | null>(
    (winner, point) =>
      (point.metrics[active] ?? -1) > (winner?.metrics[active] ?? -1) ? point : winner,
    null,
  )
  const label = metricLabels[active]
  const summary =
    series.length && best
      ? `${label} per day from ${shortDate(series[0].date)} to ${shortDate(series.at(-1)!.date)}. Total ${count(total)}. Best day ${shortDate(best.date)} with ${count(best.metrics[active])}.`
      : `${label} per day. No activity yet.`
  const ticks = series.length
    ? [series[0], series[Math.floor((series.length - 1) / 2)], series.at(-1)!]
    : []

  return (
    <section className="panel performance-trend" aria-labelledby="performance-trend-title">
      <div className="performance-section-heading">
        <div>
          <h2 id="performance-trend-title">Day by day</h2>
          <p>Spot good days and quiet days. Hover a bar to see the exact number.</p>
        </div>
        <div className="performance-segmented" role="group" aria-label="Chart metric">
          {metrics.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === active}
              onClick={() => setSelected(key)}
            >
              {metricLabels[key]}
            </button>
          ))}
        </div>
      </div>
      <div className="performance-trend-total">
        <strong>{count(total)}</strong>
        <span>
          {label.toLowerCase()} in this period
          {best && best.metrics[active] ? ` · best day ${shortDate(best.date)}` : ''}
        </span>
      </div>
      <div className="performance-chart" role="img" aria-label={summary}>
        <div className="performance-chart-bars" aria-hidden="true">
          {series.map((point) => {
            const value = point.metrics[active]
            return (
              <span
                key={point.date}
                className={value === null ? 'performance-bar-unknown' : undefined}
                title={`${shortDate(point.date)}: ${count(value)} ${label.toLowerCase()}`}
              >
                <i style={{ height: value === null ? '100%' : `${(value / top) * 100}%` }} />
              </span>
            )
          })}
        </div>
        <div className="performance-chart-axis" aria-hidden="true">
          {ticks.map((point, index) => (
            <span key={`${point.date}:${index}`}>{shortDate(point.date)}</span>
          ))}
        </div>
      </div>
    </section>
  )
}

function ConversionPath({
  metrics,
  trackingOnly,
}: {
  metrics: PartnerMetricValues
  trackingOnly: boolean
}) {
  const steps: { label: string; value: number | null; explain: string }[] = [
    { label: 'Clicks', value: metrics.clicks, explain: 'Opened your link' },
    { label: 'Funnel starts', value: metrics.funnelStarts, explain: 'Began the sign-up flow' },
    { label: 'Payment views', value: metrics.paymentViews, explain: 'Reached the payment page' },
    trackingOnly
      ? {
          label: 'App-store clicks',
          value: metrics.appStoreClicks,
          explain: 'Went to the app store',
        }
      : { label: 'Paid purchases', value: metrics.purchases, explain: 'Completed a paid purchase' },
  ]
  const top = Math.max(...steps.map((step) => step.value ?? 0), 1)
  return (
    <section className="panel performance-path" aria-labelledby="performance-path-title">
      <div className="performance-section-heading">
        <div>
          <h2 id="performance-path-title">Your conversion path</h2>
          <p>How many people moved on to each next step. A big drop shows where to focus.</p>
        </div>
      </div>
      <ol>
        {steps.map((step, index) => {
          const previous = index ? steps[index - 1].value : null
          const share = index ? rate(step.value, previous) : null
          return (
            <li key={step.label}>
              <div className="performance-path-label">
                <strong>{step.label}</strong>
                <span>{step.explain}</span>
              </div>
              <div className="performance-path-bar" aria-hidden="true">
                <i style={{ width: `${((step.value ?? 0) / top) * 100}%` }} />
              </div>
              <div className="performance-path-value">
                <strong>{count(step.value)}</strong>
                {index > 0 && <span>{share ? `${share} of previous` : '—'}</span>}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function SourceResults({
  trends,
  isRefreshing,
  onRefresh,
}: {
  trends: PartnerLiveResource<readonly PartnerTrendPoint[]>
  isRefreshing: boolean
  onRefresh: () => void
}) {
  const sources = trends.status === 'ready' ? sourceBreakdown(trends.data) : []
  const totalClicks = sources.reduce<number | null>(
    (sum, source) => addKnown(sum, source.metrics.clicks),
    0,
  )
  return (
    <section className="panel live-source-breakdown" aria-labelledby="source-results-title">
      <div className="performance-section-heading">
        <div>
          <h2 id="source-results-title">Traffic source results</h2>
          <p>
            Which channels send people and how far they get. Counts are events, not unique people.
          </p>
        </div>
      </div>

      {trends.status === 'ready' && sources.length > 0 ? (
        <div className="table-scroll live-source-breakdown-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Verified clicks</th>
                <th scope="col">Share</th>
                <th scope="col">Funnel starts</th>
                <th scope="col">Payment views</th>
                <th scope="col">App-store clicks</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const share = rate(source.metrics.clicks, totalClicks)
                return (
                  <tr key={source.key}>
                    <th scope="row">{source.label}</th>
                    <td>{count(source.metrics.clicks)}</td>
                    <td>
                      <span className="performance-share">
                        <span aria-hidden="true">
                          <i style={{ width: share ?? '0%' }} />
                        </span>
                        {share ?? '—'}
                      </span>
                    </td>
                    <td>{count(source.metrics.funnelStarts)}</td>
                    <td>{count(source.metrics.paymentViews)}</td>
                    <td>{count(source.metrics.appStoreClicks)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : trends.status === 'empty' || trends.status === 'ready' ? (
        <div className="live-source-unavailable" role="status">
          <Link2 size={24} aria-hidden="true" />
          <div>
            <strong>No attributed source activity yet</strong>
            <span>Results will appear after the first verified tracking click.</span>
          </div>
        </div>
      ) : (
        <div className="live-source-unavailable" role="alert">
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <strong>Source results are temporarily unavailable</strong>
            <span>
              {trends.error?.message ?? 'The source attribution read could not be verified safely.'}
            </span>
          </div>
          <button
            className="button button-white"
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={isRefreshing ? 'spin' : ''} size={15} aria-hidden="true" />
            {isRefreshing ? 'Refreshing sources…' : 'Retry source results'}
          </button>
        </div>
      )}
    </section>
  )
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: ReportingPeriod
  onChange: (days: ReportingPeriod) => void
}) {
  return (
    <div className="performance-segmented" role="group" aria-label="Reporting period">
      {reportingPeriods.map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={value === days}
          onClick={() => onChange(days)}
        >
          {days} days
        </button>
      ))}
    </div>
  )
}

export function LivePerformance({
  summary,
  trends,
  trackingOnly,
  isRefreshing,
  onRefresh,
}: {
  summary: PartnerDashboardSummary
  trends: PartnerLiveResource<readonly PartnerTrendPoint[]>
  trackingOnly: boolean
  isRefreshing: boolean
  onRefresh: () => void
}) {
  const { metrics } = summary
  const series = useMemo(
    () =>
      trends.status === 'ready' ? dailySeries(trends.data, summary.startsOn, summary.endsOn) : [],
    [summary.endsOn, summary.startsOn, trends.data, trends.status],
  )
  const financialsMissing = metrics.purchases === null || metrics.earningsMinor === null
  const purchaseRate = rate(metrics.purchases, metrics.clicks)

  return (
    <>
      {trackingOnly ? (
        <div className="live-summary-grid live-demo-summary-grid">
          <KpiCard
            icon={MousePointerClick}
            label="Clicks"
            value={count(metrics.clicks)}
            detail="People who opened your links, bots removed"
          />
          <KpiCard
            icon={SquareMousePointer}
            label="Funnel starts"
            value={count(metrics.funnelStarts)}
            detail={
              rate(metrics.funnelStarts, metrics.clicks)
                ? `${rate(metrics.funnelStarts, metrics.clicks)} of clicks started the funnel`
                : 'Visitors who began the sign-up flow'
            }
          />
          <KpiCard
            icon={Wallet}
            label="Payment views"
            value={count(metrics.paymentViews)}
            detail="Visitors who reached the payment page"
          />
          <KpiCard
            icon={Smartphone}
            label="App-store clicks"
            value={count(metrics.appStoreClicks)}
            detail="Visitors sent on to the app store"
          />
        </div>
      ) : (
        <div className="live-summary-grid live-demo-summary-grid">
          <KpiCard
            icon={MousePointerClick}
            label="Verified clicks"
            value={count(metrics.clicks)}
            detail="People who opened your links, bots removed"
          />
          <KpiCard
            icon={ShoppingBag}
            label="Recorded paid purchases"
            value={count(metrics.purchases)}
            detail={
              purchaseRate
                ? `${purchaseRate} of clicks became a purchase`
                : 'Paid checkouts from your links'
            }
          />
          <KpiCard
            icon={BadgeDollarSign}
            label="Recorded earnings"
            value={money(metrics.earningsMinor, summary.currency)}
            detail="Commission recorded so far, before payout review"
          />
          <KpiCard
            icon={Repeat}
            label="Active / trial subscriptions"
            value={count(metrics.activeSubscriptions)}
            detail="Customers subscribed right now, including trials"
          />
        </div>
      )}

      {!trackingOnly && (
        <p className="performance-status" role="status">
          <span
            className={`performance-status-pill ${financialsMissing ? 'performance-status-pending' : ''}`}
          >
            {financialsMissing
              ? 'Financial totals are not available yet.'
              : summary.reconciliationStage === 'preliminary'
                ? 'Recorded totals · preliminary.'
                : 'Recorded totals.'}
          </span>
          <span>
            {financialsMissing
              ? 'Purchases and earnings appear once billing records are processed.'
              : summary.reconciliationStage === 'preliminary'
                ? 'Numbers can still change while billing records are checked.'
                : 'These totals have been checked against billing records.'}
          </span>
        </p>
      )}

      <TrendChart
        series={series}
        metrics={
          trackingOnly
            ? ['clicks', 'funnelStarts', 'appStoreClicks']
            : ['clicks', 'funnelStarts', 'purchases']
        }
      />

      <div className="performance-columns">
        <ConversionPath metrics={metrics} trackingOnly={trackingOnly} />
        <SourceResults trends={trends} isRefreshing={isRefreshing} onRefresh={onRefresh} />
      </div>

      <details className="panel performance-help">
        <summary>
          <CircleHelp size={16} aria-hidden="true" /> How these numbers work
        </summary>
        <ul>
          <li>
            Traffic refreshes automatically while this page is open. New activity can take a few
            minutes to process. A dash (—) means unavailable, not zero.
          </li>
          {!trackingOnly && (
            <li>
              Recorded totals reflect processed billing records, not money available for payout.
              Pending processing or missing evidence stays as —. Verified traffic can appear before
              financial totals are complete.
            </li>
          )}
          {!trackingOnly && (
            <li>
              Active / trial subscriptions include trials and $0 subscriptions; a free checkout is
              not a paid purchase and does not generate revenue-share earnings.
            </li>
          )}
          <li>
            Clicks here are bot-filtered and limited to the selected period. Links & Sources shows
            all-time raw clicks, including visits classified as bots, so its total can be higher.
          </li>
        </ul>
      </details>
    </>
  )
}
