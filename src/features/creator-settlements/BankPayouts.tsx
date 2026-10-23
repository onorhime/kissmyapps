import { settlementMoney, type BankPayout } from './gateway'

export function BankPayouts({ items }: { items: BankPayout[] }) {
  return (
    <section aria-label="Bank payout activity">
      <h3>Bank payout activity</h3>
      <p className="settlement-muted">
        These are account-level Stripe payouts across products. A bank payout can combine several
        transfers; it is not assigned to an individual product or commission batch.
      </p>
      {!items.length ? (
        <p>No bank payout events have been received yet.</p>
      ) : (
        <div className="settlement-table-wrap">
          <table className="settlement-table">
            <thead>
              <tr>
                <th>Account / mode</th>
                <th>Amount</th>
                <th>Bank payout status</th>
                <th>Expected arrival</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.platform_account_id}:${item.livemode}:${item.payout_id}`}>
                  <td>
                    {item.connected_account_id}
                    <br />
                    {item.livemode ? 'Live' : 'Test'}
                  </td>
                  <td>{settlementMoney(item.amount_minor, item.currency)}</td>
                  <td>
                    {item.status.replaceAll('_', ' ')}
                    {item.failure_code && (
                      <p className="settlement-error">{item.failure_code.replaceAll('_', ' ')}</p>
                    )}
                  </td>
                  <td>
                    {item.arrival_date
                      ? new Date(item.arrival_date).toLocaleDateString()
                      : 'Not available'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
