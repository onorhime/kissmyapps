import { payoutStatusLabels } from './data'
import type { PayoutStatus } from './data'

export function PayoutBadge({ status }: { status: PayoutStatus }) {
  const color =
    status === 'paid' || status === 'approved'
      ? 'green'
      : status === 'review' || status === 'on_hold'
        ? 'amber'
        : status === 'failed'
          ? 'red'
          : status === 'scheduled'
            ? 'blue'
            : 'neutral'
  return (
    <span className={`status-badge badge-${color}`}>
      <span aria-hidden="true" />
      {payoutStatusLabels[status]}
    </span>
  )
}
