import { useEffect, useState } from 'react'
import type { AdminGateway } from '../api'
import { PROCESSING_ALERT_LABELS, type AdminProcessingHealth } from '../api/processingHealth'
import { formatAdminCount, formatAdminOperationalTimestamp } from './observabilityPresentation'
import './ProcessingHealth.css'

export function ProcessingHealth({
  gateway,
  refreshKey,
}: {
  gateway: AdminGateway
  refreshKey?: string
}) {
  const [data, setData] = useState<AdminProcessingHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!gateway.getProcessingHealth) return
    let current = true
    let inFlight = false
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      setLoading(true)
      try {
        const result = await gateway.getProcessingHealth!()
        if (!current) return
        if (result.status !== 'ready' || !result.data) {
          setData(null)
          setError(
            result.status === 'unauthorized'
              ? 'A password-authenticated Owner or Operations session is required to view processing health.'
              : 'Processing health is unavailable. No healthy state is assumed.',
          )
        } else {
          setData(result.data)
          setError(null)
        }
      } catch {
        if (current) {
          setData(null)
          setError('Processing health could not be loaded. Try again.')
        }
      } finally {
        inFlight = false
        if (current) {
          setLoading(false)
          setNow(Date.now())
        }
      }
    }
    void load()
    const interval = window.setInterval(() => {
      setNow(Date.now())
      void load()
    }, 60_000)
    const onVisible = () => {
      setNow(Date.now())
      void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      current = false
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [gateway, refreshKey, reload])
  if (!gateway.getProcessingHealth) return null
  const stale =
    data !== null &&
    (now - Date.parse(data.generatedAt) > 180_000 || Date.parse(data.generatedAt) > now + 60_000)
  const incident = data?.lastIncident
  const notifications = data?.notifications
  const alertMonitorStale =
    data?.externalAlertsConfigured &&
    (!notifications?.lastCheckedAt || now - Date.parse(notifications.lastCheckedAt) > 180_000)
  return (
    <section
      className="admin-observability-panel admin-processing-health"
      aria-labelledby="processing-health-title"
      aria-busy={loading}
    >
      <div className="admin-observability-panel-heading">
        <div>
          <h2 id="processing-health-title">Payment processing health</h2>
          <p>Stripe → commissions → reporting. Checked every minute while this page is visible.</p>
        </div>
        <button
          className="admin-secondary-button"
          type="button"
          disabled={loading}
          onClick={() => setReload((v) => v + 1)}
        >
          {loading ? 'Checking processing…' : 'Refresh processing health'}
        </button>
      </div>
      <div className="admin-processing-body">
        {error ? (
          <p className="admin-processing-warning" role="alert">
            {error}
          </p>
        ) : !data ? (
          <p role="status">Reading processing health…</p>
        ) : (
          <>
            {stale ? (
              <p className="admin-processing-warning" role="alert">
                This health snapshot is stale. Current processing status is unknown.
              </p>
            ) : data.attentionRequired ? (
              <div className="admin-processing-warning" role="alert">
                <strong>Processing needs attention</strong>
                <ul>
                  {data.reasons.map((reason) => (
                    <li key={reason}>{PROCESSING_ALERT_LABELS[reason]}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="admin-processing-ok" role="status">
                Processing is healthy at the last check. This is not payment or payout
                reconciliation.
              </p>
            )}
            <div className="admin-observability-summary-grid">
              <article className="admin-observability-summary-card">
                <span>Schedule</span>
                <strong>{data.enabled ? 'Enabled' : 'Paused'}</strong>
                <small>{data.currentWorker}</small>
              </article>
              <article className="admin-observability-summary-card">
                <span>Last heartbeat</span>
                <strong>{formatAdminOperationalTimestamp(data.lastTickAt)}</strong>
              </article>
              <article className="admin-observability-summary-card">
                <span>Last full cycle</span>
                <strong>{formatAdminOperationalTimestamp(data.lastCycleAt)}</strong>
              </article>
              <article className="admin-observability-summary-card">
                <span>External alerts</span>
                <strong>{data.externalAlertsConfigured ? 'Configured' : 'Not configured'}</strong>
                <small>
                  {data.externalAlertsConfigured
                    ? 'Failure and recovery emails run independently of payment workers.'
                    : 'Dashboard warnings alone do not notify you while it is closed.'}
                </small>
              </article>
            </div>
            {data.managedCheckout && (
              <article
                className="admin-observability-summary-card"
                aria-label="Managed checkout delivery"
              >
                <span>Managed checkout delivery</span>
                <strong>
                  {data.managedCheckout.attentionRequired
                    ? 'Needs attention'
                    : data.managedCheckout.enabled
                      ? 'Enabled'
                      : 'Disabled'}
                </strong>
                <p>
                  Waiting: {data.managedCheckout.pending} · In progress:{' '}
                  {data.managedCheckout.leased} · Retrying: {data.managedCheckout.retrying} ·
                  Expired leases: {data.managedCheckout.expiredLeases}
                </p>
                <small>
                  Last heartbeat: {formatAdminOperationalTimestamp(data.managedCheckout.lastTickAt)}{' '}
                  · Last completed run:{' '}
                  {formatAdminOperationalTimestamp(data.managedCheckout.lastSuccessAt)}
                </small>
                <small>Sales and creator payouts have separate controls.</small>
              </article>
            )}
            {data.externalAlertsConfigured && notifications && (
              <div
                className={
                  alertMonitorStale || notifications.failed > 0
                    ? 'admin-processing-warning'
                    : undefined
                }
                role={alertMonitorStale || notifications.failed > 0 ? 'alert' : undefined}
              >
                {alertMonitorStale && (
                  <strong>
                    The email monitor is stale or has not checked in yet. Inspect the alert
                    schedule.
                  </strong>
                )}
                {notifications.failed > 0 && (
                  <p>
                    {notifications.failed} alert email(s) need operator review. They are not assumed
                    delivered.
                  </p>
                )}
                <p>
                  Alert monitor: {formatAdminOperationalTimestamp(notifications.lastCheckedAt)} ·
                  Waiting emails: {notifications.pending}
                </p>
                <p>
                  Last provider acceptance:{' '}
                  {formatAdminOperationalTimestamp(notifications.lastAcceptedAt)}. Acceptance is not
                  proof of inbox delivery.
                </p>
              </div>
            )}
            <div
              className="admin-table-scroll"
              role="region"
              aria-label="Processing worker queues"
              tabIndex={0}
            >
              <table className="admin-processing-table">
                <thead>
                  <tr>
                    <th scope="col">Worker</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Processing</th>
                    <th scope="col">Failed</th>
                    <th scope="col">Expired leases</th>
                  </tr>
                </thead>
                <tbody>
                  {data.queues.map((q) => (
                    <tr key={q.worker}>
                      <th scope="row">{q.worker}</th>
                      <td>{formatAdminCount(q.pending)}</td>
                      <td>{formatAdminCount(q.processing)}</td>
                      <td>{formatAdminCount(q.failed)}</td>
                      <td>{formatAdminCount(q.expiredLeases)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {incident && (
              <details>
                <summary>
                  Last recorded worker issue — historical, not necessarily unresolved
                </summary>
                <p>
                  {incident.worker} · {incident.outcome} ·{' '}
                  {formatAdminOperationalTimestamp(incident.dispatchedAt)}
                </p>
                <p>
                  Run: <code>{incident.runId}</code>
                </p>
                <p>
                  Dispatcher HTTP: {incident.dispatchHttpStatus ?? 'Unknown'} · Worker HTTP:{' '}
                  {incident.upstreamHttpStatus ?? 'Not recorded'}
                </p>
                <p>
                  Diagnostic:{' '}
                  {incident.diagnosticCode ??
                    incident.errorCode ??
                    'Degraded batch; inspect job evidence'}
                </p>
                {incident.durationMs !== null && <p>Dispatch duration: {incident.durationMs} ms</p>}
              </details>
            )}
            <p>
              Do not replay payments or restart workers from an ambiguous failure. An operator must
              inspect completion and leases before approving recovery.
            </p>
            <small>Snapshot: {formatAdminOperationalTimestamp(data.generatedAt)}</small>
          </>
        )}
      </div>
    </section>
  )
}
