import { useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Filter,
  Link2,
  LoaderCircle,
  MousePointerClick,
  RefreshCw,
  Route,
  ShieldCheck,
} from 'lucide-react'
import type { AdminGateway, AdminProduct } from '../api'
import { formatAdminCount, formatAdminOperationalTimestamp } from './observabilityPresentation'
import { useAttributionOverview } from './useObservability'
import { Select } from '../../../components/Select'

export type AttributionPageProps = Readonly<{
  products: readonly AdminProduct[]
  gateway: AdminGateway
  onOpenFunnelsLinks: () => void
}>

function windowInput(days: number, end: Date) {
  return {
    startsAt: new Date(end.getTime() - days * 86_400_000).toISOString(),
    endsAt: end.toISOString(),
  }
}

function displayEnum(value: string): string {
  return value
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function conversionRate(clicks: number, conversions: number): string {
  if (clicks === 0) return '—'
  return `${((conversions / clicks) * 100).toFixed(1)}%`
}

function AttributionState({
  kind,
  message,
  onRetry,
}: {
  kind: 'loading' | 'unconfigured' | 'error'
  message: string
  onRetry: () => void
}) {
  const loading = kind === 'loading'
  const Icon = loading ? LoaderCircle : CircleAlert
  return (
    <div className={`admin-observability-state admin-observability-state-${kind}`}>
      <span className="admin-state-icon">
        <Icon className={loading ? 'admin-spin' : ''} size={28} aria-hidden="true" />
      </span>
      <h2>{loading ? 'Loading attribution evidence' : 'Attribution is unavailable'}</h2>
      <p>{message}</p>
      {!loading && kind !== 'unconfigured' && (
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          <RefreshCw size={17} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  )
}

export function AttributionPage({ products, gateway, onOpenFunnelsLinks }: AttributionPageProps) {
  const [days, setDays] = useState(30)
  const [windowEnd, setWindowEnd] = useState(() => new Date())
  const [productId, setProductId] = useState('')
  const [sourceId, setSourceId] = useState('')
  const input = useMemo(
    () => ({
      ...windowInput(days, windowEnd),
      productId: productId || null,
      sourceId: sourceId || null,
      limit: 25,
      offset: 0,
    }),
    [days, productId, sourceId, windowEnd],
  )
  const { state, refresh } = useAttributionOverview({ gateway, input })

  function changeDays(nextDays: number) {
    setDays(nextDays)
    setWindowEnd(new Date())
  }

  function refreshNow() {
    setWindowEnd(new Date())
    refresh()
  }

  return (
    <section
      className="admin-page admin-observability-page"
      aria-labelledby="admin-attribution-title"
    >
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">CANONICAL EVIDENCE</p>
          <h1 id="admin-attribution-title">Attribution</h1>
          <p>
            Follow accepted clicks, acquisitions, trusted events, and qualified conversions without
            exposing visitor or provider identifiers.
          </p>
        </div>
        <button
          className="admin-secondary-button"
          type="button"
          disabled={state.status === 'loading' || state.refreshing}
          onClick={refreshNow}
        >
          {state.refreshing ? (
            <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
          ) : (
            <RefreshCw size={17} aria-hidden="true" />
          )}
          {state.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="admin-observability-filters" aria-label="Attribution filters">
        <span className="admin-observability-filter-label">
          <Filter size={15} aria-hidden="true" /> Window
        </span>
        <div className="admin-observability-presets">
          {[7, 30, 90].map((preset) => (
            <button
              className={days === preset ? 'admin-observability-preset-active' : ''}
              type="button"
              aria-pressed={days === preset}
              onClick={() => changeDays(preset)}
              key={preset}
            >
              {preset} days
            </button>
          ))}
        </div>
        <label>
          <span>Product</span>
          <Select
            options={[
              { value: '', label: 'All products' },
              ...products.map((product) => ({ value: product.id, label: product.name })),
            ]}
            value={productId}
            onChange={setProductId}
          />
        </label>
        <label>
          <span>Source</span>
          <Select
            options={[
              { value: '', label: 'All sources' },
              ...(state.data?.sources ?? []).map((source) => ({
                value: source.id,
                label: source.name,
              })),
            ]}
            value={sourceId}
            onChange={setSourceId}
          />
        </label>
      </div>

      {state.status === 'loading' ? (
        <AttributionState
          kind="loading"
          message="Reading protected aggregate evidence. No sample traffic is substituted."
          onRetry={refresh}
        />
      ) : state.status === 'unconfigured' ? (
        <AttributionState
          kind="unconfigured"
          message="The protected attribution read model is not available in this deployment yet."
          onRetry={refresh}
        />
      ) : state.status !== 'ready' || !state.data ? (
        <AttributionState
          kind="error"
          message={state.error?.message ?? 'Attribution evidence could not be loaded safely.'}
          onRetry={refresh}
        />
      ) : (
        <>
          {!state.data.readiness.trackingEnabled || !state.data.readiness.baseUrlConfigured ? (
            <div className="admin-observability-notice admin-observability-notice-warning">
              <CircleAlert size={19} aria-hidden="true" />
              <div>
                <strong>Traffic collection is not ready</strong>
                <p>
                  Tracking is {state.data.readiness.trackingEnabled ? 'enabled' : 'disabled'} and
                  the production tracking host is{' '}
                  {state.data.readiness.baseUrlConfigured ? 'configured' : 'not configured'}.
                </p>
              </div>
              <button className="admin-text-button" type="button" onClick={onOpenFunnelsLinks}>
                Review routing <Route size={15} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="admin-observability-notice">
              <ShieldCheck size={19} aria-hidden="true" />
              <div>
                <strong>Tracking route configured</strong>
                <p>Activity below is canonical database evidence for the selected UTC window.</p>
              </div>
            </div>
          )}

          <div className="admin-observability-summary-grid" aria-label="Attribution summary">
            <article className="admin-observability-summary-card">
              <MousePointerClick size={20} aria-hidden="true" />
              <span>Clicks</span>
              <strong>{formatAdminCount(state.data.summary.clicks)}</strong>
              <small>{formatAdminCount(state.data.summary.botClicks)} bot-marked</small>
            </article>
            <article className="admin-observability-summary-card">
              <Link2 size={20} aria-hidden="true" />
              <span>Acquisitions</span>
              <strong>{formatAdminCount(state.data.summary.acquisitions)}</strong>
              <small>{formatAdminCount(state.data.summary.resolvedAcquisitions)} resolved</small>
            </article>
            <article className="admin-observability-summary-card">
              <Activity size={20} aria-hidden="true" />
              <span>Events</span>
              <strong>{formatAdminCount(state.data.summary.events)}</strong>
              <small>
                {formatAdminCount(state.data.summary.trustedEvents)} trusted ·{' '}
                {formatAdminCount(state.data.summary.commercialEligibleEvents)} commercial
              </small>
            </article>
            <article className="admin-observability-summary-card">
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>Conversions</span>
              <strong>{formatAdminCount(state.data.summary.qualifiedConversions)}</strong>
              <small>Qualified only</small>
            </article>
          </div>

          {state.data.summary.clicks === 0 &&
          state.data.summary.acquisitions === 0 &&
          state.data.summary.events === 0 ? (
            <div className="admin-observability-zero">
              <Bot size={28} aria-hidden="true" />
              <h2>No attribution evidence yet</h2>
              <p>
                This is a real zero-data state. Once a live partner link receives traffic, accepted
                clicks and downstream evidence will appear here.
              </p>
              <button className="admin-secondary-button" type="button" onClick={onOpenFunnelsLinks}>
                Open Funnels &amp; Links
              </button>
            </div>
          ) : (
            <section
              className="admin-observability-panel"
              aria-labelledby="attribution-breakdown-title"
            >
              <div className="admin-observability-panel-heading">
                <div>
                  <h2 id="attribution-breakdown-title">Product and source breakdown</h2>
                  <p>
                    Independent canonical facts are grouped without joining raw visitor records.
                  </p>
                </div>
                <span className="admin-count-badge">{state.data.breakdown.length}</span>
              </div>
              {state.data.breakdown.length ? (
                <div
                  className="admin-table-scroll"
                  role="region"
                  aria-label="Attribution breakdown table"
                  tabIndex={0}
                >
                  <table className="admin-products-table admin-observability-table">
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col">Source</th>
                        <th scope="col">Clicks</th>
                        <th scope="col">Acquisitions</th>
                        <th scope="col">Conversions</th>
                        <th scope="col">Click conversion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.breakdown.map((row) => (
                        <tr key={`${row.productId}:${row.sourceId ?? 'direct'}`}>
                          <th scope="row" data-label="Product">
                            {row.productName}
                          </th>
                          <td data-label="Source">{row.sourceName}</td>
                          <td data-label="Clicks">{formatAdminCount(row.clicks)}</td>
                          <td data-label="Acquisitions">{formatAdminCount(row.acquisitions)}</td>
                          <td data-label="Conversions">
                            {formatAdminCount(row.qualifiedConversions)}
                          </td>
                          <td data-label="Click conversion">
                            {conversionRate(row.clicks, row.qualifiedConversions)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-observability-inline-empty">
                  No grouped activity matches these filters.
                </p>
              )}
            </section>
          )}

          <div className="admin-observability-two-column">
            <section
              className="admin-observability-panel"
              aria-labelledby="attribution-events-title"
            >
              <div className="admin-observability-panel-heading">
                <div>
                  <h2 id="attribution-events-title">Event coverage</h2>
                  <p>Names and counts only; properties and provider identifiers stay private.</p>
                </div>
              </div>
              {state.data.eventTypes.length ? (
                <ul className="admin-observability-list">
                  {state.data.eventTypes.map((event) => (
                    <li key={event.eventName}>
                      <div>
                        <strong>{event.eventName}</strong>
                        <small>Last {formatAdminOperationalTimestamp(event.lastOccurredAt)}</small>
                      </div>
                      <span>
                        {formatAdminCount(event.eventCount)} ·{' '}
                        {formatAdminCount(event.commercialEligibleCount)} eligible
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-observability-inline-empty">No event types observed.</p>
              )}
            </section>

            <section
              className="admin-observability-panel"
              aria-labelledby="attribution-recency-title"
            >
              <div className="admin-observability-panel-heading">
                <div>
                  <h2 id="attribution-recency-title">Latest evidence</h2>
                  <p>Most recent canonical activity across the platform.</p>
                </div>
              </div>
              <dl className="admin-observability-definition-list">
                <div>
                  <dt>Last click</dt>
                  <dd>{formatAdminOperationalTimestamp(state.data.readiness.lastClickAt)}</dd>
                </div>
                <div>
                  <dt>Last event</dt>
                  <dd>{formatAdminOperationalTimestamp(state.data.readiness.lastEventAt)}</dd>
                </div>
                <div>
                  <dt>Last conversion</dt>
                  <dd>{formatAdminOperationalTimestamp(state.data.readiness.lastConversionAt)}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section
            className="admin-observability-panel"
            aria-labelledby="recent-acquisitions-title"
          >
            <div className="admin-observability-panel-heading">
              <div>
                <h2 id="recent-acquisitions-title">Recent acquisitions</h2>
                <p>Operational context is shown without account, click, or provider identifiers.</p>
              </div>
              <span className="admin-count-badge">{state.data.recentAcquisitions.totalCount}</span>
            </div>
            {state.data.recentAcquisitions.items.length ? (
              <div
                className="admin-table-scroll"
                role="region"
                aria-label="Recent acquisitions table"
                tabIndex={0}
              >
                <table className="admin-products-table admin-observability-table">
                  <thead>
                    <tr>
                      <th scope="col">Created</th>
                      <th scope="col">Product</th>
                      <th scope="col">Partner</th>
                      <th scope="col">Source</th>
                      <th scope="col">Method</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.recentAcquisitions.items.map((item, index) => (
                      <tr
                        key={`${item.createdAt}:${item.productName}:${item.partnerName ?? 'unattributed'}:${index}`}
                      >
                        <td data-label="Created">
                          {formatAdminOperationalTimestamp(item.createdAt)}
                        </td>
                        <th scope="row" data-label="Product">
                          {item.productName}
                        </th>
                        <td data-label="Partner">{item.partnerName ?? 'Unattributed'}</td>
                        <td data-label="Source">{item.sourceName}</td>
                        <td data-label="Method">{displayEnum(item.attributionMethod)}</td>
                        <td data-label="Status">
                          <span className={`admin-status-badge admin-status-${item.status}`}>
                            {displayEnum(item.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-observability-inline-empty">No acquisitions match this window.</p>
            )}
          </section>
        </>
      )}
    </section>
  )
}
