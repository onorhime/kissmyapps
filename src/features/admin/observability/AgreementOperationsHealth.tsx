import { useEffect, useState } from 'react'
import type { AdminAgreementOperationsHealth, AdminGateway } from '../api/types'
import { formatAdminCount, formatAdminOperationalTimestamp } from './observabilityPresentation'

export function AgreementOperationsHealth({
  gateway,
  refreshKey,
}: {
  gateway: AdminGateway
  refreshKey?: string
}) {
  const [data, setData] = useState<AdminAgreementOperationsHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let current = true
    const load = async () => {
      if (!gateway.getAgreementOperationsHealth) return
      setLoading(true)
      setError(null)
      try {
        const result = await gateway.getAgreementOperationsHealth()
        if (!current) return
        if (result.status !== 'ready' || !result.data) {
          setData(null)
          setError(
            result.status === 'unauthorized'
              ? 'A password-authenticated Owner or Operations session is required.'
              : 'Agreement operations could not be loaded. No zero or healthy state is assumed.',
          )
        } else setData(result.data)
      } catch {
        if (current) {
          setData(null)
          setError('Agreement operations could not be loaded. Try again.')
        }
      } finally {
        if (current) setLoading(false)
      }
    }
    void load()
    return () => {
      current = false
    }
  }, [gateway, refreshKey, reload])
  if (!gateway.getAgreementOperationsHealth) return null
  return (
    <section
      className="admin-observability-panel"
      aria-labelledby="agreement-operations-title"
      aria-busy={loading}
    >
      <div className="admin-observability-panel-heading">
        <div>
          <h2 id="agreement-operations-title">Agreement emails &amp; file cleanup</h2>
          <p>Committed jobs and provider receipts. Sent does not confirm inbox delivery.</p>
        </div>
        <button
          className="admin-secondary-button"
          type="button"
          disabled={loading}
          onClick={() => setReload((v) => v + 1)}
        >
          {loading ? 'Checking agreement jobs…' : 'Refresh agreement jobs'}
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : loading && !data ? (
        <p role="status">Reading agreement operations…</p>
      ) : (
        data && (
          <>
            <div className="admin-observability-summary-grid">
              <article className="admin-observability-summary-card">
                <span>Email waiting / processing</span>
                <strong>
                  {formatAdminCount(data.pending)} / {formatAdminCount(data.processing)}
                </strong>
                <small>
                  Oldest waiting: {formatAdminOperationalTimestamp(data.oldestPendingAt)}
                </small>
              </article>
              <article className="admin-observability-summary-card">
                <span>Email accepted / failed</span>
                <strong>
                  {formatAdminCount(data.sent)} / {formatAdminCount(data.failed)}
                </strong>
                <small>Accepted by the provider, not confirmed read</small>
              </article>
              <article className="admin-observability-summary-card">
                <span>Cleanup waiting / processing</span>
                <strong>
                  {formatAdminCount(data.cleanupPending)} /{' '}
                  {formatAdminCount(data.cleanupProcessing)}
                </strong>
                <small>Only explicitly queued, unreferenced files</small>
              </article>
              <article className="admin-observability-summary-card">
                <span>Cleanup done / failed</span>
                <strong>
                  {formatAdminCount(data.cleanupDone)} / {formatAdminCount(data.cleanupFailed)}
                </strong>
                <small>Fully signed files remain protected</small>
              </article>
            </div>
            {data.failed + data.cleanupFailed > 0 && (
              <p role="alert">
                Some jobs need operator review. Check the delivery or cleanup evidence before
                retrying; do not create duplicate signing requests.
              </p>
            )}
            {data.pending + data.processing + data.cleanupPending + data.cleanupProcessing > 0 && (
              <p>
                These counts do not prove the scheduler is running. Jobs that remain waiting need an
                operator to check the worker and its schedule.
              </p>
            )}
          </>
        )
      )}
    </section>
  )
}
