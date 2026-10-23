import { TermsSnapshot } from './TermsSnapshot'
import { CommissionSchedule } from './CommissionSchedule'
import { useEffect, useMemo, useState } from 'react'
import { CreatorConnectCard } from './CreatorConnectCard'
import { BankPayouts } from './BankPayouts'
import { BalanceSummary } from './BalanceSummary'
import type { ConnectClient } from './connect'
import {
  createSettlementGateway,
  settlementMoney,
  type SettlementClient,
  type SettlementGateway,
  type SettlementWorkspace,
} from './gateway'
import './settlements.css'

export function CreatorEarningsPanel({
  productId,
  client,
  gateway: supplied,
}: {
  productId: string
  client?: (SettlementClient & ConnectClient) | null
  gateway?: SettlementGateway
}) {
  const gateway = useMemo(() => supplied ?? createSettlementGateway(client), [client, supplied])
  const [loaded, setLoaded] = useState<{ productId: string; data: SettlementWorkspace } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const data = loaded?.productId === productId ? loaded.data : null
  useEffect(() => {
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setBusy(true)
      setError(null)
      try {
        const result = await gateway.workspace(false, { product_id: productId })
        if (active) setLoaded({ productId, data: result })
      } catch (e) {
        if (active) {
          setLoaded(null)
          setError(e instanceof Error ? e.message : 'Earnings are unavailable.')
        }
      } finally {
        if (active) setBusy(false)
      }
    })
    return () => {
      active = false
    }
  }, [gateway, productId, revision])
  return (
    <>
      <section className="creator-settlements panel" aria-label="External purchase earnings">
        <header>
          <div>
            <h2>Purchase commissions</h2>
            <p>
              Verified purchases are calculated using your approved agreement. Test activity is
              shown separately.
            </p>
          </div>
          <button type="button" disabled={busy} onClick={() => setRevision((n) => n + 1)}>
            {busy ? 'Loading earnings…' : 'Refresh earnings'}
          </button>
        </header>
        {error && (
          <p role="alert" className="settlement-error">
            {error}
          </p>
        )}
        {data?.truncated && (
          <p role="status">
            Showing the latest 100 records in each section. This view is not a complete statement.
          </p>
        )}
        {data && !data.commissions.length && (
          <p>No attributed purchase commissions are recorded for this product yet.</p>
        )}
        {data && data.commissions.length > 0 && (
          <div className="settlement-table-wrap">
            <table className="settlement-table">
              <caption>Recorded purchase commissions</caption>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Commission</th>
                  <th>Status</th>
                  <th>Hold ends</th>
                </tr>
              </thead>
              <tbody>
                {data.commissions.map((item) => (
                  <tr key={item.id}>
                    <td>{item.livemode ? 'Live' : 'Test'}</td>
                    <td>
                      {item.status === 'unconfigured' || item.basis_minor === null
                        ? 'Not calculated'
                        : settlementMoney(item.commission_minor, item.currency)}
                    </td>
                    <td>
                      {item.status.replaceAll('_', ' ')}
                      {item.blocker && (
                        <p className="settlement-muted">{item.blocker.replaceAll('_', ' ')}</p>
                      )}
                      <CommissionSchedule commission={item} />
                    </td>
                    <td>
                      {item.status === 'reversed'
                        ? 'Not payable'
                        : item.eligible_at
                          ? new Date(item.eligible_at).toLocaleDateString()
                          : 'Pending'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.batches.length > 0 && (
          <div className="settlement-table-wrap">
            <table className="settlement-table">
              <caption>Settlement history</caption>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Mode</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{new Date(batch.created_at).toLocaleDateString()}</td>
                    <td>{batch.livemode ? 'Live' : 'Test'}</td>
                    <td>{settlementMoney(batch.amount_minor, batch.currency)}</td>
                    <td>
                      {batch.status === 'transferred'
                        ? 'Transferred to your Stripe account'
                        : batch.status.replaceAll('_', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="settlement-muted">
          Approval does not mean money has been sent. Transfers go to your connected Stripe balance;
          Stripe manages the separate payout to your bank. Refunds can reverse earnings or create an
          amount to recover.
        </p>
        {data && data.terms.length > 0 && (
          <section aria-label="Signed commission terms">
            <h3>Your signed commission terms</h3>
            {data.terms
              .filter((terms) => terms.status === 'approved')
              .map((terms) => (
                <TermsSnapshot key={terms.id} terms={terms} />
              ))}
          </section>
        )}
        {data && <BankPayouts items={data.bank_payouts ?? []} />}
        {data && <BalanceSummary items={data.balances} />}
      </section>
      <CreatorConnectCard client={client} />
    </>
  )
}
