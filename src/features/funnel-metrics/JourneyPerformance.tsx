import { useId } from 'react'
import type { FunnelJourneyReport } from './journey'
import { formatFunnelMoney, formatFunnelTimestamp } from '../partner/live/funnelMetricPresentation'
import './JourneyPerformance.css'

const count = (value: number) => new Intl.NumberFormat('en-US').format(value)
const percent = (value: number | null) =>
  value === null
    ? '—'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`
const epc = (value: number | null, currency: string) => {
  if (value === null) return '—'
  const digits =
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits + 2, 4),
  }).format(value / 10 ** digits)
}

/** One shared, read-only view for creators and administrators. Financial totals come from the ledger. */
export function JourneyPerformance({
  report,
  timeZone,
}: {
  report?: FunnelJourneyReport
  timeZone: string
}) {
  const id = useId()
  return (
    <section className="journey-performance" aria-labelledby={`${id}-heading`}>
      <div>
        <h3 id={`${id}-heading`}>Acquisition cohort and earnings</h3>
        <p>
          Follow the audience referred by creator-link clicks in this period. Returning visits and
          follow-up emails do not create a new lead or replace creator credit.
        </p>
      </div>
      {!report ? (
        <p role="status">
          Journey reporting is not available in this response. This does not mean activity or
          earnings are zero.
        </p>
      ) : (
        <>
          <div className="journey-performance-scope">
            <strong>
              {report.environment === 'test' ? 'TEST data — no real earnings' : 'LIVE data'}
            </strong>
            <span>
              Creator-link clicks from {formatFunnelTimestamp(report.cohortFrom, timeZone)} to
              before {formatFunnelTimestamp(report.cohortTo, timeZone)}
            </span>
            <span>{report.conversionWindowDays}-day conversion window</span>
            <span>Observed through {formatFunnelTimestamp(report.observedUntil, timeZone)}</span>
          </div>
          <p>
            The reporting window measures conversions; it does not change the attribution window,
            commission terms or payout eligibility.
          </p>
          {report.validClicks === 0 && (
            <p role="status">
              No classified creator clicks are recorded for this cohort yet. Only accepted tracked
              activity is included in these results.
            </p>
          )}
          {report.immature && (
            <p className="journey-performance-notice">
              Some people are still within their conversion window. These results can increase as
              they return.
            </p>
          )}
          <dl className="journey-performance-counts">
            <div>
              <dt>Valid attributed clicks</dt>
              <dd>{count(report.validClicks)}</dd>
            </div>
          </dl>
          {report.unclassifiedClicks > 0 && (
            <p className="journey-performance-notice">
              {count(report.unclassifiedClicks)}{' '}
              {report.unclassifiedClicks === 1 ? 'click has' : 'clicks have'} no verified Test/Live
              classification and {report.unclassifiedClicks === 1 ? 'is' : 'are'} excluded from EPC.
            </p>
          )}
          {report.definitionVersion == null ? (
            <p role="status" className="journey-performance-notice">
              No configurable journey is published for this report. A funnel administrator can
              define stages, conversion rates and paths in Journey stages and conversion paths.
              Standard clicks, verified orders and earnings remain available below.
            </p>
          ) : (
            <>
              <div>
                <h4>Configured journey · version {report.definitionVersion}</h4>
                <p>
                  These stages and paths come from this funnel’s published journey definition.
                  People are counted once per stage in this acquisition cohort.
                </p>
                {!report.configuredStages?.length && (
                  <p>No journey stages are configured in this version.</p>
                )}
                <dl className="journey-performance-counts">
                  {report.configuredStages?.map((stage) => (
                    <div key={stage.key}>
                      <dt>{stage.label}</dt>
                      <dd>{count(stage.people)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {Boolean(report.configuredRates?.length) && (
                <div
                  className="journey-performance-table-scroll"
                  role="region"
                  aria-label="Cohort conversion rates"
                  tabIndex={0}
                >
                  <table>
                    <caption>Configured conversions within the same referred audience</caption>
                    <thead>
                      <tr>
                        <th scope="col">Conversion</th>
                        <th scope="col">Qualifying people</th>
                        <th scope="col">Eligible audience</th>
                        <th scope="col">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.configuredRates?.map((rate) => (
                        <tr key={rate.key}>
                          <th scope="row">{rate.label}</th>
                          <td>{count(rate.numerator)}</td>
                          <td>
                            {count(rate.denominator)} {rate.denominator === 1 ? 'person' : 'people'}
                          </td>
                          <td>
                            {percent(rate.value)}
                            {rate.status === 'zero_denominator' && (
                              <span className="journey-performance-inline-note">
                                No eligible audience yet
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p>
                    A person qualifies only when every configured step happens in order within the
                    reporting window. The eligible audience is people reaching the first step.
                  </p>
                </div>
              )}
              {Boolean(report.configuredPaths?.length) && (
                <div>
                  <h4>Configured journey paths</h4>
                  <p>
                    Each path counts distinct people who complete its steps in order. Paths are
                    independent: the same person may qualify for more than one path.
                  </p>
                  <dl className="journey-performance-counts">
                    {report.configuredPaths?.map((path) => (
                      <div key={path.key}>
                        <dt>{path.label}</dt>
                        <dd>
                          {count(path.people)} {path.people === 1 ? 'person' : 'people'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          )}
          <div>
            <h4>Revenue and creator earnings</h4>
            <p>
              Approved earnings include amounts already transferred, after applicable reversals. A
              transfer is not additional earnings. Currencies are never combined.
            </p>
            {!report.commerce.length && (
              <p role="status">
                No matching verified orders or commission entries are available for this cohort.
              </p>
            )}
            {report.commerce.map((item) => (
              <section
                key={item.currency}
                className="journey-performance-money"
                aria-label={`${item.currency} cohort revenue and earnings`}
              >
                <h5>
                  {item.currency} · {report.environment === 'test' ? 'Test' : 'Live'}
                </h5>
                <dl className="journey-performance-counts">
                  <div>
                    <dt>Paid orders</dt>
                    <dd>{count(item.paidOrders)}</dd>
                  </div>
                  <div>
                    <dt>Orders with a successful refund</dt>
                    <dd>{count(item.refundedOrders)}</dd>
                  </div>
                  <div>
                    <dt>Collected revenue</dt>
                    <dd>{formatFunnelMoney(item.collectedMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Successfully refunded</dt>
                    <dd>{formatFunnelMoney(item.refundedMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Refunded order rate</dt>
                    <dd>{percent(item.refundRate)}</dd>
                  </div>
                  <div>
                    <dt>Refunded revenue rate</dt>
                    <dd>{percent(item.refundedRevenueRate)}</dd>
                  </div>
                  <div>
                    <dt>Pending commission</dt>
                    <dd>{formatFunnelMoney(item.pendingCommissionMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Approved earnings, including transferred</dt>
                    <dd>{formatFunnelMoney(item.approvedCommissionMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Transferred to Stripe</dt>
                    <dd>{formatFunnelMoney(item.paidCommissionMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Commission reversals</dt>
                    <dd>{formatFunnelMoney(item.reversedCommissionMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Approved EPC</dt>
                    <dd>{epc(item.approvedEpcMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Pending EPC</dt>
                    <dd>{epc(item.pendingEpcMinor, item.currency)}</dd>
                  </div>
                  <div>
                    <dt>Approved earnings per 1,000 clicks</dt>
                    <dd>
                      {item.earningsPer1000ClicksMinor === null
                        ? '—'
                        : formatFunnelMoney(item.earningsPer1000ClicksMinor, item.currency)}
                    </dd>
                  </div>
                </dl>
              </section>
            ))}
            <p>
              EPC = net approved commission ÷ valid attributed clicks. A dash means there is no
              eligible denominator. Transfers to Stripe are not confirmation of a bank payout; see
              Payouts for its receipts and status.
            </p>
          </div>
          {report.warnings.length > 0 && (
            <ul className="journey-performance-notice" aria-label="Journey reporting notes">
              {report.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

export function JourneyReportFilters({
  value,
  onChange,
  prefix,
}: {
  value: {
    environment: 'test' | 'live'
    conversionWindowDays: string
    currency: string
    journeyVersion?: string
  }
  onChange: (patch: Partial<typeof value>) => void
  prefix: string
}) {
  return (
    <>
      <label>
        Data environment
        <select
          aria-label={`${prefix} environment`}
          value={value.environment}
          onChange={(event) => onChange({ environment: event.target.value as 'test' | 'live' })}
        >
          <option value="live">Live</option>
          <option value="test">Test</option>
        </select>
      </label>
      <label>
        Reporting conversion window (days)
        <input
          aria-label={`${prefix} conversion window`}
          type="number"
          min={1}
          max={365}
          placeholder="Use funnel default"
          value={value.conversionWindowDays}
          onChange={(event) => onChange({ conversionWindowDays: event.target.value })}
        />
      </label>
      <label>
        Journey definition version
        <input
          aria-label={`${prefix} journey version`}
          type="number"
          min={1}
          value={value.journeyVersion ?? ''}
          placeholder="Latest published"
          onChange={(event) => onChange({ journeyVersion: event.target.value })}
        />
      </label>
      <label>
        Earnings currency
        <input
          aria-label={`${prefix} earnings currency`}
          value={value.currency}
          maxLength={3}
          placeholder="All currencies, shown separately"
          onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
        />
      </label>
    </>
  )
}
