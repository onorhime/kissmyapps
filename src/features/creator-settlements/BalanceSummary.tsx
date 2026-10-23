import { settlementMoney, type SettlementBalance } from './gateway'

export function BalanceSummary({
  items,
  admin = false,
}: {
  items: SettlementBalance[]
  admin?: boolean
}) {
  if (!items.length) return null
  return (
    <section aria-label="Funding account balances">
      <h3>Funding account balances</h3>
      <p className="settlement-muted">
        Totals cover all products sharing this funding account and currency. The recorded balance
        includes held earnings and is not an amount available to withdraw. A recovery hold blocks
        new transfers until the earlier refund or reversal is resolved.
      </p>
      {items.map((item) => (
        <article
          className="settlement-card"
          key={`${item.affiliate_id}:${item.platform_account_id}:${item.livemode}:${item.currency}`}
        >
          <strong>
            {item.platform_account_id} · {item.currency} · {item.livemode ? 'Live' : 'Test'}
          </strong>
          {admin && <p className="settlement-muted">Creator: {item.affiliate_id}</p>}
          {item.review_required && (
            <p role="status">
              Transfers are on hold: a partial refund or dispute needs finance review.
            </p>
          )}
          <dl>
            <div>
              <dt>Earned</dt>
              <dd>{settlementMoney(item.earned_minor, item.currency)}</dd>
            </div>
            <div>
              <dt>Reversed earnings</dt>
              <dd>{settlementMoney(item.reversed_minor, item.currency)}</dd>
            </div>
            <div>
              <dt>Transferred to Stripe</dt>
              <dd>{settlementMoney(item.transferred_minor, item.currency)}</dd>
            </div>
            <div>
              <dt>Recovered from Stripe</dt>
              <dd>{settlementMoney(item.recovered_minor, item.currency)}</dd>
            </div>
            <div>
              <dt>Recorded balance</dt>
              <dd>{settlementMoney(item.balance_minor, item.currency)}</dd>
            </div>
            <div>
              <dt>Recovery hold</dt>
              <dd>{settlementMoney(item.debt_minor, item.currency)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </section>
  )
}
