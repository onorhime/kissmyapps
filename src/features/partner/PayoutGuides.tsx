import { useState } from 'react'
import { money, payoutStatusLabels, shortDate } from './data'
import type { PayoutStatus } from './data'
import { PayoutBadge } from './PayoutBadge'
import { commissionExamples, payoutStateExamples } from './payoutData'
import type { CommissionExample } from './payoutData'

export function PayoutStateGuide({
  status,
  onChange,
}: {
  status: PayoutStatus
  onChange: (status: PayoutStatus) => void
}) {
  const example = payoutStateExamples[status]
  return (
    <div className="payout-guide">
      <label className="form-field">
        <span id="payout-example-status-label">Example payout status</span>
        <select
          aria-labelledby="payout-example-status-label"
          value={status}
          onChange={(event) => onChange(event.target.value as PayoutStatus)}
        >
          {Object.entries(payoutStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="payout-example-card" aria-live="polite" aria-atomic="true">
        <PayoutBadge status={status} />
        <p>{example.explanation}</p>
        <dl className="payout-example-facts">
          <div>
            <dt>Unpaid balance in this period</dt>
            <dd>{money(example.balanceMinor)}</dd>
          </div>
          <div>
            <dt>Illustrative amount transferred</dt>
            <dd>{money(example.transferredMinor)}</dd>
          </div>
          <div>
            <dt>Carried into the next period</dt>
            <dd>{money(example.carriedMinor)}</dd>
          </div>
          <div>
            <dt>{example.dateLabel}</dt>
            <dd>{example.date ? shortDate(example.date) + ', 2026' : 'Not set'}</dd>
          </div>
        </dl>
        <h3>What happens next?</h3>
        <p>{example.next}</p>
      </div>
      <p className="inline-note">
        Each status is a separate fictional outcome, not a change to your account. The examples use
        the Aug 3–16 cycle and a $100 USD minimum. The real minimum is configurable per agreement;
        no transfer, retry, approval, or hold release is available here.
      </p>
    </div>
  )
}

export function CalculationGuide() {
  const [model, setModel] = useState<CommissionExample>('revenue_share')
  const example = commissionExamples[model]
  const total = example.components.reduce((sum, part) => sum + part.amountMinor, 0)
  return (
    <div className="payout-guide">
      <div className="payout-local-note">
        <strong>Compare calculation examples</strong>
        <p>
          These examples do not change your 30% revenue-share context, payout balances, or
          agreement.
        </p>
      </div>
      <label className="form-field">
        <span id="payout-example-model-label">Example commission model</span>
        <select
          aria-labelledby="payout-example-model-label"
          value={model}
          onChange={(event) => setModel(event.target.value as CommissionExample)}
        >
          {Object.entries(commissionExamples).map(([value, item]) => (
            <option key={value} value={value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <section
        className="payout-example-card"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Commission calculation example"
      >
        <h3>{example.label}</h3>
        <p>{example.rule}</p>
        <dl className="payout-bridge">
          {example.components.map((part) => (
            <div key={part.label}>
              <dt>
                {part.label}
                <small>{part.basis}</small>
              </dt>
              <dd>{money(part.amountMinor)}</dd>
            </div>
          ))}
          <div>
            <dt>Approved adjustments</dt>
            <dd>{money(0)}</dd>
          </div>
          <div className="payout-bridge-total">
            <dt>Example earnings · USD</dt>
            <dd>{money(total)}</dd>
          </div>
        </dl>
      </section>
      <dl className="definition-list">
        <div>
          <dt>1. Verify the eligible basis</dt>
          <dd>
            Revenue share starts with verified payments, less fees, actual refund/dispute balance
            impact, taxes and contractual deductions, plus or minus Stripe settlement conversion.
            CPL/CPA use accepted conversion count × the contracted fixed rate instead.
          </dd>
        </div>
        <div>
          <dt>2. Reconcile the effective agreement</dt>
          <dd>
            Every entry keeps its agreement version. Separate approved adjustments may change the
            period amount; paid statements are never recalculated retroactively.
          </dd>
        </div>
        <div>
          <dt>3. Review, schedule, then record settlement</dt>
          <dd>
            A 14-day UTC cycle closes Sunday at 23:59:59. Review runs Monday–Thursday, with Friday
            as the expected payout day. A balance above the minimum is not approval or proof of
            payment.
          </dd>
        </div>
        <div>
          <dt>Below the minimum?</dt>
          <dd>
            The default is $100 USD, configurable by agreement. A $75 balance carries forward
            unchanged. With $60 in new earnings, the next period has $135 for review—not $135 of
            newly earned commission.
          </dd>
        </div>
      </dl>
    </div>
  )
}
