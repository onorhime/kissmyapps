import type { ExternalCommission } from './gateway'

export function CommissionSchedule({ commission }: { commission: ExternalCommission }) {
  const {
    payout_blocker: blocker,
    payout_period_end: periodEnd,
    payout_next_at: nextAt,
  } = commission
  if (!blocker && !periodEnd && !nextAt) return null
  return (
    <div className="settlement-muted">
      {blocker && (
        <p>
          {blocker === 'next_agreed_payout_period'
            ? 'Waiting for the next agreed payout period.'
            : blocker.replaceAll('_', ' ')}
        </p>
      )}
      {nextAt ? (
        <p>
          Next agreed payout boundary:{' '}
          <time dateTime={nextAt}>{new Date(nextAt).toLocaleString()}</time>.
        </p>
      ) : periodEnd ? (
        <p>
          Payout period boundary:{' '}
          <time dateTime={periodEnd}>{new Date(periodEnd).toLocaleString()}</time>.
        </p>
      ) : null}
      {(nextAt || blocker) && (
        <p>The schedule does not guarantee payment; eligibility and batch approval still apply.</p>
      )}
    </div>
  )
}
