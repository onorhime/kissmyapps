import type { PartnerCommissionRule } from '../api'
import { providerMoney } from '../../../lib/providerMoney'
export function PartnerRuleTerms({
  rule,
  currency,
}: {
  rule: PartnerCommissionRule
  currency: string
}) {
  return (
    <div>
      <strong>
        {rule.name}
        {rule.version ? ` · v${rule.version}` : ''}
        {rule.status ? ` · ${rule.status}` : ''}
      </strong>
      <p>
        {[
          rule.rateBasisPoints !== null ? `${rule.rateBasisPoints / 100}%` : '',
          rule.fixedAmountMinor !== null
            ? providerMoney(rule.fixedAmountMinor, rule.currency ?? currency)
            : '',
        ]
          .filter(Boolean)
          .join(' + ')}{' '}
        · {rule.triggerEvent}
      </p>
      {rule.policyVersion !== undefined && rule.policyVersion >= 2 && (
        <>
          <p>
            Basis:{' '}
            {rule.commissionBasisPolicy === 'net_after_fees'
              ? 'net after payment fees'
              : 'subtotal after discounts, excluding tax and shipping'}
            .
          </p>
          <p>
            {rule.firstPurchaseOnly && 'First verified product purchase only. '}
            Validation hold: {rule.validationWindowHours} hours
            {rule.fulfilmentRequired ? ' after verified service fulfilment' : ' after purchase'}.
            Ordinary refund cutoff:{' '}
            {rule.refundCutoffDays === null ? 'unlimited' : `${rule.refundCutoffDays} days`} from
            purchase.
          </p>
          <p>
            Verified external purchase refunds adjust commission proportionally within this cutoff.
            Disputes and suspected fraud remain subject to review. The validation hold does not
            extend the refund cutoff.
          </p>
        </>
      )}
    </div>
  )
}
