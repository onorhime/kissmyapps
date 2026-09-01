import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  DatabaseZap,
  EyeOff,
  Link2,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ServerCog,
  ShieldCheck,
} from 'lucide-react'
import type { AdminDataHealthStatus, AdminGateway } from '../api'
import {
  dataHealthStatusLabel,
  formatAdminCount,
  formatAdminOperationalTimestamp,
  providerLabel,
  queueLabel,
} from './observabilityPresentation'
import { useDataHealth } from './useObservability'

export type DataHealthPageProps = Readonly<{
  gateway: AdminGateway
  onOpenFunnelsLinks: () => void
}>

function HealthBadge({ status }: { status: AdminDataHealthStatus }) {
  return (
    <span className={`admin-health-badge admin-health-badge-${status}`}>
      {dataHealthStatusLabel(status)}
    </span>
  )
}

function DataHealthState({
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
      <h2>{loading ? 'Reading data health' : 'Data Health is unavailable'}</h2>
      <p>{message}</p>
      {!loading && kind !== 'unconfigured' && (
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          <RefreshCw size={17} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  )
}

export function DataHealthPage({ gateway, onOpenFunnelsLinks }: DataHealthPageProps) {
  const { state, refresh } = useDataHealth(gateway)

  return (
    <section
      className="admin-page admin-observability-page"
      aria-labelledby="admin-data-health-title"
    >
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">DATABASE EVIDENCE</p>
          <h1 id="admin-data-health-title">Data Health</h1>
          <p>
            Inspect collection evidence, durable processing queues, reporting freshness, and
            reconciliation state without opening raw operational records.
          </p>
        </div>
        <button
          className="admin-secondary-button"
          type="button"
          disabled={state.status === 'loading' || state.refreshing}
          onClick={refresh}
        >
          {state.refreshing ? (
            <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
          ) : (
            <RefreshCw size={17} aria-hidden="true" />
          )}
          {state.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {state.status === 'loading' ? (
        <DataHealthState
          kind="loading"
          message="Reading aggregate database evidence. No fixture health state is shown."
          onRetry={refresh}
        />
      ) : state.status === 'unconfigured' ? (
        <DataHealthState
          kind="unconfigured"
          message="The protected Data Health read model is not available in this deployment yet."
          onRetry={refresh}
        />
      ) : state.status !== 'ready' || !state.data ? (
        <DataHealthState
          kind="error"
          message={state.error?.message ?? 'Data Health could not be loaded safely.'}
          onRetry={refresh}
        />
      ) : (
        <>
          <div className={`admin-health-overall admin-health-overall-${state.data.overallStatus}`}>
            {state.data.overallStatus === 'attention' ? (
              <CircleAlert size={22} aria-hidden="true" />
            ) : state.data.overallStatus === 'ready' ? (
              <ShieldCheck size={22} aria-hidden="true" />
            ) : (
              <EyeOff size={22} aria-hidden="true" />
            )}
            <div>
              <span>Overall database evidence</span>
              <strong>{dataHealthStatusLabel(state.data.overallStatus)}</strong>
              <small>Generated {formatAdminOperationalTimestamp(state.data.generatedAt)}</small>
            </div>
            <HealthBadge status={state.data.overallStatus} />
          </div>

          <div className="admin-observability-summary-grid" aria-label="Data readiness summary">
            <article className="admin-observability-summary-card">
              <DatabaseZap size={20} aria-hidden="true" />
              <span>Tracking</span>
              <strong>{state.data.catalog.trackingEnabled ? 'Enabled' : 'Disabled'}</strong>
              <small>
                Host {state.data.catalog.baseUrlConfigured ? 'configured' : 'not configured'}
              </small>
            </article>
            <article className="admin-observability-summary-card">
              <PackageCheck size={20} aria-hidden="true" />
              <span>Active products</span>
              <strong>{formatAdminCount(state.data.catalog.activeProductCount)}</strong>
              <small>{formatAdminCount(state.data.catalog.liveFunnelCount)} live funnels</small>
            </article>
            <article className="admin-observability-summary-card">
              <Link2 size={20} aria-hidden="true" />
              <span>Active links</span>
              <strong>{formatAdminCount(state.data.catalog.activeLinkCount)}</strong>
              <small>Server-issued links</small>
            </article>
            <article className="admin-observability-summary-card">
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>Launch-ready terms</span>
              <strong>{formatAdminCount(state.data.catalog.launchReadyAgreementCount)}</strong>
              <small>
                {formatAdminCount(state.data.catalog.verifiedActiveOfferCount)} verified offers
              </small>
            </article>
          </div>

          {!state.data.catalog.trackingEnabled && (
            <div className="admin-observability-notice admin-observability-notice-warning">
              <CircleAlert size={19} aria-hidden="true" />
              <div>
                <strong>Collection is disabled</strong>
                <p>
                  Provider and queue zeroes below are readiness facts, not proof of healthy traffic.
                </p>
              </div>
              <button className="admin-text-button" type="button" onClick={onOpenFunnelsLinks}>
                Review routing <Link2 size={15} aria-hidden="true" />
              </button>
            </div>
          )}

          <section className="admin-observability-panel" aria-labelledby="provider-evidence-title">
            <div className="admin-observability-panel-heading">
              <div>
                <h2 id="provider-evidence-title">Collection evidence</h2>
                <p>Observed database facts only; zero events remain unobserved.</p>
              </div>
            </div>
            <div className="admin-health-provider-grid">
              {state.data.providers.map((provider) => (
                <article className="admin-health-provider-card" key={provider.id}>
                  <div>
                    <Activity size={18} aria-hidden="true" />
                    <strong>{providerLabel(provider.id)}</strong>
                  </div>
                  <HealthBadge status={provider.status} />
                  <dl>
                    <div>
                      <dt>Observed</dt>
                      <dd>{formatAdminCount(provider.observedCount)}</dd>
                    </div>
                    <div>
                      <dt>Verified</dt>
                      <dd>{formatAdminCount(provider.verifiedCount)}</dd>
                    </div>
                    <div>
                      <dt>Rejected / failed</dt>
                      <dd>{formatAdminCount(provider.failedCount)}</dd>
                    </div>
                  </dl>
                  <small>Last {formatAdminOperationalTimestamp(provider.lastObservedAt)}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-observability-panel" aria-labelledby="durable-queues-title">
            <div className="admin-observability-panel-heading">
              <div>
                <h2 id="durable-queues-title">Durable queues</h2>
                <p>Failures and expired leases need attention; empty means no queued evidence.</p>
              </div>
            </div>
            <div
              className="admin-table-scroll"
              role="region"
              aria-label="Durable processing queues"
              tabIndex={0}
            >
              <table className="admin-products-table admin-observability-table admin-health-queue-table">
                <thead>
                  <tr>
                    <th scope="col">Queue</th>
                    <th scope="col">State</th>
                    <th scope="col">Pending</th>
                    <th scope="col">Processing</th>
                    <th scope="col">Failed</th>
                    <th scope="col">Retry ready</th>
                    <th scope="col">Expired leases</th>
                    <th scope="col">Oldest pending</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.queues.map((queue) => (
                    <tr key={queue.id}>
                      <th scope="row" data-label="Queue">
                        {queueLabel(queue.id)}
                      </th>
                      <td data-label="State">
                        <HealthBadge status={queue.status} />
                      </td>
                      <td data-label="Pending">{formatAdminCount(queue.pendingCount)}</td>
                      <td data-label="Processing">{formatAdminCount(queue.processingCount)}</td>
                      <td data-label="Failed">{formatAdminCount(queue.failedCount)}</td>
                      <td data-label="Retry ready">{formatAdminCount(queue.retryReadyCount)}</td>
                      <td data-label="Expired leases">{formatAdminCount(queue.staleLeaseCount)}</td>
                      <td data-label="Oldest pending">
                        {formatAdminOperationalTimestamp(queue.oldestPendingAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="admin-observability-two-column">
            <section
              className="admin-observability-panel"
              aria-labelledby="reporting-freshness-title"
            >
              <div className="admin-observability-panel-heading">
                <div>
                  <h2 id="reporting-freshness-title">Reporting freshness</h2>
                  <p>Calculation time is not proof that every upstream source is current.</p>
                </div>
              </div>
              <dl className="admin-observability-definition-list">
                <div>
                  <dt>Metric rows</dt>
                  <dd>{formatAdminCount(state.data.metrics.rowCount)}</dd>
                </div>
                <div>
                  <dt>Partial rows</dt>
                  <dd>{formatAdminCount(state.data.metrics.partialCount)}</dd>
                </div>
                <div>
                  <dt>Reconciled rows</dt>
                  <dd>{formatAdminCount(state.data.metrics.reconciledCount)}</dd>
                </div>
                <div>
                  <dt>Finalized rows</dt>
                  <dd>{formatAdminCount(state.data.metrics.finalizedCount)}</dd>
                </div>
                <div>
                  <dt>Latest metric date</dt>
                  <dd>{state.data.metrics.latestMetricDate ?? 'Not started'}</dd>
                </div>
                <div>
                  <dt>Last calculated</dt>
                  <dd>{formatAdminOperationalTimestamp(state.data.metrics.latestCalculatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section
              className="admin-observability-panel"
              aria-labelledby="reconciliation-health-title"
            >
              <div className="admin-observability-panel-heading">
                <div>
                  <h2 id="reconciliation-health-title">Reconciliation</h2>
                  <p>Statuses and exception counts only; financial evidence stays server-side.</p>
                </div>
              </div>
              <dl className="admin-observability-definition-list">
                <div>
                  <dt>Total runs</dt>
                  <dd>{formatAdminCount(state.data.reconciliation.runCount)}</dd>
                </div>
                <div>
                  <dt>Open exceptions</dt>
                  <dd>{formatAdminCount(state.data.reconciliation.openExceptionCount)}</dd>
                </div>
              </dl>
              {state.data.reconciliation.recentRuns.length ? (
                <ul className="admin-observability-list admin-health-run-list">
                  {state.data.reconciliation.recentRuns.map((run, index) => (
                    <li key={`${run.provider}:${run.scheduledFor}:${index}`}>
                      <div>
                        <strong>{providerLabel(run.provider)}</strong>
                        <small>{formatAdminOperationalTimestamp(run.scheduledFor)}</small>
                      </div>
                      <span>
                        {run.status} · {formatAdminCount(run.exceptionCount)} exceptions
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-observability-inline-empty">No reconciliation runs started.</p>
              )}
            </section>
          </div>

          <div className="admin-health-limitations">
            <ServerCog size={20} aria-hidden="true" />
            <div>
              <strong>What this page cannot prove</strong>
              <p>
                Database evidence cannot confirm Edge Function deployment, secret presence,
                scheduler configuration, or worker liveness. Those require separate deployment and
                runtime checks.
              </p>
            </div>
            <Clock3 size={18} aria-hidden="true" />
          </div>
        </>
      )}
    </section>
  )
}
