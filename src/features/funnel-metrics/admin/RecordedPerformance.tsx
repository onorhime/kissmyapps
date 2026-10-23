import { useState, type FormEvent } from 'react'
import type { FunnelMetricReport, FunnelMetricReportFilter, FunnelMetricsGateway } from '../types'
import { formatFunnelMetric, formatFunnelMoney } from '../../partner/live/funnelMetricPresentation'
import { validateMetricReportFilter } from '../validation'
import { JourneyPerformance, JourneyReportFilters } from '../JourneyPerformance'

/** A read-only view in the existing funnel editor; definitions and money are never mutated here. */
export function RecordedPerformance({
  productId,
  funnelId,
  gateway,
}: {
  productId: string
  funnelId: string
  gateway: FunnelMetricsGateway
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [filters, setFilters] = useState({
    from: today,
    to: today,
    channel: '',
    entryVariant: '',
    webinarId: '',
    intakeId: '',
    contextId: '',
    environment: 'live' as 'test' | 'live',
    conversionWindowDays: '',
    currency: '',
    journeyVersion: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState<FunnelMetricReport | null>(null)
  async function load(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const filter: FunnelMetricReportFilter = {
      productId,
      funnelId,
      from: filters.from,
      to: filters.to,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      environment: filters.environment,
      ...(filters.conversionWindowDays
        ? { conversionWindowDays: Number(filters.conversionWindowDays) }
        : {}),
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...(filters.journeyVersion ? { journeyVersion: Number(filters.journeyVersion) } : {}),
      ...Object.fromEntries(
        (['channel', 'entryVariant', 'webinarId', 'intakeId', 'contextId'] as const)
          .filter((key) => filters[key].trim())
          .map((key) => [key, filters[key].trim()]),
      ),
    }
    const invalid = validateMetricReportFilter(filter)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    setError('')
    setReport(null)
    try {
      const result = await gateway.getAdminReport(filter)
      if (result.data) setReport(result.data)
      else setError(result.error?.message || 'Recorded performance could not be loaded.')
    } catch {
      setError('Recorded performance could not be loaded. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="admin-config-subpanel funnel-recorded-performance">
      <summary>Recorded performance</summary>
      <p>
        View real events received for this product and funnel, including the journey and earnings
        report. Sample events below are excluded. Choose Test for test activity; older events
        without a verified Test/Live classification are excluded from either mode. These filters do
        not alter commission or payout settings.
      </p>
      <form onSubmit={load}>
        <fieldset disabled={busy}>
          <legend>Report filters</legend>
          <div className="admin-config-form-grid">
            <JourneyReportFilters
              value={filters}
              onChange={(patch) => {
                setFilters({ ...filters, ...patch })
                setReport(null)
              }}
              prefix="Performance"
            />
            {(['from', 'to'] as const).map((key) => (
              <label className="admin-field" key={key}>
                {key === 'from' ? 'Performance from' : 'Performance through'}
                <input
                  type="date"
                  value={filters[key]}
                  onChange={(e) => {
                    setFilters({ ...filters, [key]: e.target.value })
                    setReport(null)
                  }}
                />
              </label>
            ))}
            {(
              [
                ['channel', 'Channel'],
                ['entryVariant', 'Entry option'],
                ['webinarId', 'Webinar ID'],
                ['intakeId', 'Intake ID'],
                ['contextId', 'Context ID'],
              ] as const
            ).map(([key, label]) => (
              <label className="admin-field" key={key}>
                {label}
                <input
                  maxLength={128}
                  value={filters[key]}
                  placeholder="All"
                  onChange={(e) => {
                    setFilters({ ...filters, [key]: e.target.value })
                    setReport(null)
                  }}
                />
              </label>
            ))}
          </div>
          <button className="admin-secondary-button" type="submit">
            {busy ? 'Loading performance…' : 'Load recorded performance'}
          </button>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div aria-live="polite">
          <JourneyPerformance
            report={report.journey}
            timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
          <h3>Published period metrics</h3>
          <p>
            These optional custom cards count events within the published version and selected
            reporting period. Their ratios do not measure acquisition-cohort conversions; use the
            journey report above for those conversions.
          </p>
          <p>
            Published version {report.version ?? 'not available'} ·{' '}
            {report.status.replaceAll('_', ' ')}. Data received:{' '}
            {report.lastReceivedAt
              ? new Date(report.lastReceivedAt).toLocaleString()
              : 'awaiting events'}
            .
          </p>
          <dl className="funnel-performance-values">
            {report.metrics.map((metric) => (
              <div key={metric.key}>
                <dt>{metric.label}</dt>
                <dd>
                  {metric.status === 'available' ? formatFunnelMetric(metric) : 'Awaiting data'}
                </dd>
              </div>
            ))}
          </dl>
          {!report.journey && (
            <>
              <p>Verified external sales (separate from creator earnings):</p>
              {report.externalCommerce?.map((row) => (
                <p key={`${row.currency}:${row.livemode}`}>
                  {row.currency} · {row.livemode ? 'Live' : 'Test'} · {row.purchases} purchases ·{' '}
                  {row.refunds} refunds · {formatFunnelMoney(row.netCents, row.currency)} net
                </p>
              ))}
              {!report.externalCommerce?.length && (
                <p>
                  {report.externalCommerceStatus === 'available'
                    ? 'No matching verified sales.'
                    : 'Sales integration is not connected.'}
                </p>
              )}
            </>
          )}
          {report.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
    </details>
  )
}
