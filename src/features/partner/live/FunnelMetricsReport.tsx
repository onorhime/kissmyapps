import { useEffect, useId, useMemo, useState } from 'react'
import { AlertCircle, ChartNoAxesCombined, LoaderCircle, RefreshCw } from 'lucide-react'
import {
  createFunnelMetricsGateway,
  type FunnelMetricReport,
  type FunnelMetricReportFilter,
  type FunnelMetricValue,
  type FunnelMetricsGateway,
  type FunnelMetricsResult,
} from '../../funnel-metrics'
import type { PartnerLiveWorkspaceValue } from './types'
import {
  formatFunnelMetric,
  formatFunnelMoney,
  formatFunnelTimestamp,
  funnelMetricDateError,
  funnelMetricMeaning,
} from './funnelMetricPresentation'
import './FunnelMetricsReport.css'
import { JourneyPerformance, JourneyReportFilters } from '../../funnel-metrics/JourneyPerformance'
import { validateMetricReportFilter } from '../../funnel-metrics/validation'

type Props = {
  workspace: Pick<
    PartnerLiveWorkspaceValue,
    'selectedProductId' | 'sessionUserId' | 'snapshot' | 'reporting' | 'client'
  >
  /** The production composition uses the shared, authenticated RPC gateway. */
  gateway?: Pick<FunnelMetricsGateway, 'getReport'>
}

const isKnown = (status: string) => status === 'ready' || status === 'empty'

function MetricCard({ metric, timeZone }: { metric: FunnelMetricValue; timeZone: string }) {
  const explanation =
    metric.status === 'insufficient_data'
      ? 'Not enough data to calculate this percentage. Its denominator is zero.'
      : metric.status === 'no_data'
        ? 'Waiting for the configured event source. No measurement is available yet.'
        : metric.status === 'unconfigured'
          ? 'This metric is not connected yet.'
          : funnelMetricMeaning(metric.kind)
  return (
    <article className="funnel-metrics-card" aria-label={metric.label}>
      <h3>{metric.label}</h3>
      <strong className="funnel-metrics-value">
        {metric.status === 'available' ? formatFunnelMetric(metric) : '—'}
      </strong>
      <p>{explanation}</p>
      <details>
        <summary>How this is counted</summary>
        <dl>
          <div>
            <dt>Counting rule</dt>
            <dd>{funnelMetricMeaning(metric.kind)}</dd>
          </div>
          <div>
            <dt>Metric key</dt>
            <dd>{metric.key}</dd>
          </div>
          <div>
            <dt>Last event received</dt>
            <dd>{formatFunnelTimestamp(metric.updatedAt, timeZone)}</dd>
          </div>
          {metric.numerator !== undefined && (
            <div>
              <dt>Numerator</dt>
              <dd>{new Intl.NumberFormat('en-US').format(metric.numerator)}</dd>
            </div>
          )}
          {metric.denominator !== undefined && (
            <div>
              <dt>Denominator</dt>
              <dd>{new Intl.NumberFormat('en-US').format(metric.denominator)}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  )
}

function ReportContent({ report, timeZone }: { report: FunnelMetricReport; timeZone: string }) {
  const headingId = useId()
  return (
    <>
      <JourneyPerformance report={report.journey} timeZone={timeZone} />
      <h3>Published period metrics</h3>
      <p className="funnel-metrics-note">
        These custom cards count activity in the selected period. Ratios here are not
        acquisition-cohort conversions.
      </p>
      <div className="funnel-metrics-freshness funnel-metrics-note">
        <span>
          Published definition: {report.version === null ? 'None' : `version ${report.version}`}
        </span>
        <span>
          Snapshot: {formatFunnelTimestamp(report.asOf, timeZone)} · {timeZone}
        </span>
        <span>Last event received: {formatFunnelTimestamp(report.lastReceivedAt, timeZone)}</span>
      </div>
      {report.publishedAt && (
        <p className="funnel-metrics-note">
          This definition measures activity from{' '}
          {formatFunnelTimestamp(report.publishedAt, timeZone)}
          {report.effectiveUntil
            ? ` until ${formatFunnelTimestamp(report.effectiveUntil, timeZone)}`
            : ' onward'}
          . Changing the reporting dates does not combine different definition versions.
        </p>
      )}
      {report.status === 'unpublished' ? (
        <div className="funnel-metrics-status" role="status">
          <ChartNoAxesCombined size={22} aria-hidden="true" />
          <div>
            <strong>No metrics published for this funnel</strong>
            <p>An administrator can configure and publish the metrics this funnel should report.</p>
          </div>
        </div>
      ) : (
        <>
          {report.status === 'awaiting_data' && (
            <p className="funnel-metrics-note" role="status">
              The metric definitions are published. Waiting for the first accepted events.
            </p>
          )}
          {report.metrics.length ? (
            <div className="funnel-metrics-cards">
              {report.metrics.map((metric) => (
                <MetricCard key={metric.key} metric={metric} timeZone={timeZone} />
              ))}
            </div>
          ) : (
            <p role="status">There are no visible custom metrics in this published definition.</p>
          )}
        </>
      )}
      {report.warnings.length > 0 && (
        <ul className="funnel-metrics-note" aria-label="Reporting notes">
          {report.warnings.map((warning, index) => (
            <li key={`${index}:${warning}`}>{warning}</li>
          ))}
        </ul>
      )}
      {!report.journey && (
        <section className="funnel-metrics-commerce" aria-labelledby={headingId}>
          <div>
            <h3 id={headingId}>Verified external sales</h3>
            <p className="funnel-metrics-note">
              Sales verified with the product’s external payment provider. These are reported
              separately from the standard financial cards above. Sales totals are not creator
              earnings. Open Payouts to see calculated commissions, approval and payment status.
            </p>
          </div>
          {report.externalCommerceStatus === 'available' ? (
            <>
              {report.externalCommerce?.length ? (
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">
                      Your attributed external sales, separated by currency and payment mode
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Currency</th>
                        <th scope="col">Mode</th>
                        <th scope="col">Purchases</th>
                        <th scope="col">Refunds</th>
                        <th scope="col">Gross sales</th>
                        <th scope="col">Refunded</th>
                        <th scope="col">Net sales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.externalCommerce.map((row) => (
                        <tr key={`${row.currency}:${row.livemode ? 'live' : 'test'}`}>
                          <th scope="row">{row.currency}</th>
                          <td>{row.livemode ? 'Live' : 'Test'}</td>
                          <td>{row.purchases}</td>
                          <td>{row.refunds}</td>
                          <td>{formatFunnelMoney(row.grossCents, row.currency)}</td>
                          <td>{formatFunnelMoney(row.refundCents, row.currency)}</td>
                          <td>{formatFunnelMoney(row.netCents, row.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="funnel-metrics-note" role="status">
                  No verified external sales in this reporting period.
                </p>
              )}
              <p className="funnel-metrics-note">
                Last verified sale event received:{' '}
                {formatFunnelTimestamp(report.externalCommerceUpdatedAt, timeZone)}. Currencies are
                not added together. Test payments are shown separately from live sales.
              </p>
            </>
          ) : (
            <p className="funnel-metrics-note" role="status">
              External sales reporting is not connected for this funnel. This does not mean sales
              are zero.
            </p>
          )}
        </section>
      )}
    </>
  )
}

export function FunnelMetricsReport({ workspace, gateway: suppliedGateway }: Props) {
  const { selectedProductId, sessionUserId, snapshot, reporting, client } = workspace
  const id = useId()
  const gateway = useMemo(
    () => suppliedGateway ?? createFunnelMetricsGateway(client),
    [client, suppliedGateway],
  )
  const directory = snapshot.resources.linkDirectory
  const links = snapshot.resources.links
  const product = snapshot.resources.products.data.find((item) => item.id === selectedProductId)
  const funnels = directory.data.funnels.filter(
    (item) => item.productId === selectedProductId && item.available,
  )
  const accountScope = `${sessionUserId ?? 'anonymous'}:${selectedProductId ?? 'none'}`
  const [selection, setSelection] = useState({
    scope: accountScope,
    funnelId: '',
    linkId: '',
    channel: '',
    entryVariant: '',
    webinarId: '',
    intakeId: '',
    contextId: '',
    environment: 'live' as 'test' | 'live',
    conversionWindowDays: '',
    currency: '',
    journeyVersion: '',
    from: reporting.startsOn,
    to: reporting.endsOn,
  })
  const selected =
    selection.scope === accountScope
      ? selection
      : {
          scope: accountScope,
          funnelId: '',
          linkId: '',
          channel: '',
          entryVariant: '',
          webinarId: '',
          intakeId: '',
          contextId: '',
          environment: 'live' as 'test' | 'live',
          conversionWindowDays: '',
          currency: '',
          journeyVersion: '',
          from: reporting.startsOn,
          to: reporting.endsOn,
        }
  const defaultFunnel =
    funnels.find((item) => item.id === reporting.funnelId)?.id ||
    (funnels.length === 1 ? funnels[0].id : '')
  const funnelId = funnels.some((item) => item.id === selected.funnelId)
    ? selected.funnelId
    : defaultFunnel
  const ownLinks = links.data.filter(
    (item) => item.productId === selectedProductId && item.funnelId === funnelId,
  )
  const linkId = ownLinks.some((item) => item.id === selected.linkId) ? selected.linkId : ''
  const linkUnavailable = Boolean(selected.linkId && (!isKnown(links.status) || !linkId))
  const dateError =
    funnelMetricDateError(selected.from, selected.to) ||
    validateMetricReportFilter({
      productId: selectedProductId || '',
      funnelId,
      from: selected.from,
      to: selected.to,
      timeZone: reporting.timezone,
      environment: selected.environment,
      ...(selected.conversionWindowDays
        ? { conversionWindowDays: Number(selected.conversionWindowDays) }
        : {}),
      ...(selected.currency ? { currency: selected.currency } : {}),
      ...(selected.journeyVersion ? { journeyVersion: Number(selected.journeyVersion) } : {}),
    })
  const canRead = Boolean(
    sessionUserId &&
    product &&
    funnelId &&
    isKnown(directory.status) &&
    !dateError &&
    !linkUnavailable,
  )
  const filter: FunnelMetricReportFilter | null = canRead
    ? {
        productId: product!.id,
        funnelId,
        from: selected.from,
        to: selected.to,
        timeZone: reporting.timezone,
        environment: selected.environment,
        ...(selected.conversionWindowDays
          ? { conversionWindowDays: Number(selected.conversionWindowDays) }
          : {}),
        ...(selected.currency ? { currency: selected.currency } : {}),
        ...(selected.journeyVersion ? { journeyVersion: Number(selected.journeyVersion) } : {}),
        ...(linkId ? { linkId } : {}),
        ...Object.fromEntries(
          (['channel', 'entryVariant', 'webinarId', 'intakeId', 'contextId'] as const)
            .filter((key) => selected[key].trim())
            .map((key) => [key, selected[key].trim()]),
        ),
      }
    : null
  const [refresh, setRefresh] = useState(0)
  const filterKey = filter ? JSON.stringify(filter) : ''
  const requestKey = `${accountScope}:${filterKey}:${refresh}`
  const [loaded, setLoaded] = useState<{
    key: string
    gateway: typeof gateway
    result: FunnelMetricsResult<FunnelMetricReport>
  } | null>(null)
  const result = loaded?.key === requestKey && loaded.gateway === gateway ? loaded.result : null
  const loading = canRead && !result

  useEffect(() => {
    if (!filterKey) return
    let active = true
    const scope = JSON.parse(filterKey) as FunnelMetricReportFilter
    void gateway
      .getReport(scope)
      .then((result) => {
        if (!active) return
        if (
          result.data &&
          (result.data.productId !== scope.productId || result.data.funnelId !== scope.funnelId)
        ) {
          setLoaded({
            key: requestKey,
            gateway,
            result: {
              status: 'error',
              data: null,
              error: {
                code: 'invalid_response',
                message:
                  'The report did not match the selected product and funnel. Please reload it.',
                retryable: true,
              },
            },
          })
          return
        }
        setLoaded({ key: requestKey, gateway, result })
      })
      .catch(() => {
        if (active)
          setLoaded({
            key: requestKey,
            gateway,
            result: {
              status: 'error',
              data: null,
              error: {
                code: 'unavailable',
                message: 'Funnel results could not be loaded. Please try again.',
                retryable: true,
              },
            },
          })
      })
    return () => {
      active = false
    }
  }, [filterKey, gateway, requestKey])

  useEffect(() => {
    if (!canRead) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefresh((value) => value + 1)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [canRead, requestKey])

  const change = (patch: Partial<typeof selected>) => setSelection({ ...selected, ...patch })
  const hasAdvancedFilters =
    selected.environment !== 'live' ||
    Boolean(selected.conversionWindowDays || selected.currency || selected.journeyVersion) ||
    (['channel', 'entryVariant', 'webinarId', 'intakeId', 'contextId'] as const).some((key) =>
      selected[key].trim(),
    )
  return (
    <section className="panel funnel-metrics-report" aria-labelledby={`${id}-title`}>
      <div className="funnel-metrics-heading">
        <div>
          <span className="context-label">FUNNEL PERFORMANCE</span>
          <h2 id={`${id}-title`}>Configured funnel metrics</h2>
          <p>
            Results attributed to your creator links for {product?.name || 'the selected product'}.
            Pick a funnel to see each step of its journey. Use More filters for test data, a
            channel, or a specific campaign context.
          </p>
        </div>
        <button
          className="button button-white"
          disabled={!canRead || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} aria-hidden="true" />
          {loading ? 'Loading metrics…' : 'Refresh metrics'}
        </button>
      </div>
      {sessionUserId && product && isKnown(directory.status) && funnels.length > 0 && (
        <div className="funnel-metrics-filters">
          <label>
            Funnel
            <select
              aria-label="Metrics funnel"
              value={funnelId}
              onChange={(event) => change({ funnelId: event.target.value, linkId: '' })}
            >
              <option value="">Choose a funnel</option>
              {funnels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Creator link
            <select
              aria-label="Metrics creator link"
              value={linkId}
              disabled={!funnelId || !isKnown(links.status)}
              onChange={(event) => change({ linkId: event.target.value })}
            >
              <option value="">All your links in this funnel</option>
              {ownLinks.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              aria-label="Metrics start date"
              type="date"
              value={selected.from}
              onChange={(event) => change({ from: event.target.value })}
            />
          </label>
          <label>
            Through
            <input
              aria-label="Metrics end date"
              type="date"
              value={selected.to}
              onChange={(event) => change({ to: event.target.value })}
            />
          </label>
          <details className="funnel-metrics-more" open={hasAdvancedFilters || undefined}>
            <summary>More filters</summary>
            <div className="funnel-metrics-more-grid">
              <JourneyReportFilters value={selected} onChange={change} prefix="Metrics" />
              {(
                [
                  ['channel', 'Channel'],
                  ['entryVariant', 'Entry option'],
                  ['webinarId', 'Webinar ID'],
                  ['intakeId', 'Intake ID'],
                  ['contextId', 'Context ID'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={`Metrics ${label.toLowerCase()}`}
                    value={selected[key]}
                    placeholder="All"
                    maxLength={128}
                    onChange={(event) => change({ [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
          </details>
        </div>
      )}
      {!sessionUserId ? (
        <p role="status">Sign in to see your attributed funnel results.</p>
      ) : !product ? (
        <p role="status">Select an authorized product to view its funnel metrics.</p>
      ) : !isKnown(directory.status) ? (
        <p role="alert">
          Your funnel directory is unavailable. Refresh the partner workspace to try again.
        </p>
      ) : !funnels.length ? (
        <p role="status">No reporting funnel is available for this product yet.</p>
      ) : dateError ? (
        <p role="alert">{dateError}</p>
      ) : !funnelId ? (
        <p role="status">
          Choose one funnel. Different funnels may define different metrics, so their values are not
          combined here.
        </p>
      ) : linkUnavailable ? (
        <p role="alert">
          The selected creator link is unavailable. Reload your links or choose another link before
          reporting. Results have not been widened to all links.
        </p>
      ) : loading ? (
        <div className="funnel-metrics-status" role="status" aria-busy="true">
          <LoaderCircle className="spin" size={22} aria-hidden="true" />
          <div>
            <strong>Loading your funnel results</strong>
            <p>Reading the published definitions and your attributed activity.</p>
          </div>
        </div>
      ) : result?.status === 'unconfigured' ? (
        <div className="funnel-metrics-status" role="status">
          <ChartNoAxesCombined size={22} aria-hidden="true" />
          <div>
            <strong>Funnel reporting is not available yet</strong>
            <p>
              {result.error?.message ||
                'This reporting connection has not been configured. No values are shown as zero.'}
            </p>
          </div>
        </div>
      ) : result?.status !== 'ready' || !result.data ? (
        <div className="funnel-metrics-status" role="alert">
          <AlertCircle size={22} aria-hidden="true" />
          <div>
            <strong>
              {result?.status === 'unauthorized'
                ? 'Funnel access is unavailable'
                : 'Funnel results could not be loaded'}
            </strong>
            <p>
              {result?.error?.message ||
                'Try refreshing this report. Your saved configuration has not changed.'}
            </p>
          </div>
        </div>
      ) : (
        <ReportContent report={result.data} timeZone={reporting.timezone} />
      )}
    </section>
  )
}
