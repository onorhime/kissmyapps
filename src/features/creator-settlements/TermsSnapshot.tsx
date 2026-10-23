import { settlementMoney, commissionLabel, type CommissionTerms } from './gateway'
export function TermsSnapshot({
  terms,
  admin = false,
}: {
  terms: CommissionTerms
  admin?: boolean
}) {
  if (!terms.agreement_id)
    return (
      <p className="settlement-muted">
        Historical settlement terms · no canonical signed agreement is linked. Existing records
        retain their original terms.
      </p>
    )
  return (
    <details className="settlement-card">
      <summary>
        Signed agreement v{terms.agreement_version ?? '?'} · rule v
        {terms.commission_rule_version ?? '?'} · frozen terms
      </summary>
      <p>
        {terms.first_purchase_only && 'First product purchase only · '}
        {terms.fulfilment_required && 'Verified fulfilment required · '}
        {commissionLabel(terms)} · {terms.validation_window_hours}-hour validation hold
        {terms.fulfilment_required
          ? ' after verified service fulfilment'
          : ' after purchase'} · {terms.attribution_window_days}-day attribution window
      </p>
      <p>
        Basis:{' '}
        {terms.commission_basis_policy === 'net_after_fees'
          ? 'net after payment fees'
          : 'subtotal after discounts, excluding tax and shipping'}
        .
      </p>
      <p>
        Ordinary refund cutoff:{' '}
        {terms.refund_cutoff_days === null ? 'unlimited' : `${terms.refund_cutoff_days} days`} from
        purchase. Disputes and fraud remain subject to review.
      </p>
      <p>
        Payout cadence: {terms.payout_frequency_days} days · Minimum:{' '}
        {settlementMoney(terms.minimum_payout_minor ?? 0, terms.currency)}. Each batch still
        requires manual review and approval.
      </p>
      <p>
        Funding:{' '}
        {terms.funding_model === 'merchant_direct'
          ? 'merchant account directly'
          : terms.funding_model === 'application_fee'
            ? 'collected from merchant checkout'
            : 'pre-funded platform balance'}{' '}
        · {terms.livemode ? 'Live' : 'Test'}.
      </p>
      <dl>
        <dt>Agreement ID</dt>
        <dd>{terms.agreement_id}</dd>
        <dt>Commission rule ID</dt>
        <dd>{terms.commission_rule_id}</dd>
        <dt>Signed document ID</dt>
        <dd>{terms.signed_document_id ?? 'Unavailable'}</dd>
        <dt>Signed terms fingerprint</dt>
        <dd style={{ overflowWrap: 'anywhere' }}>{terms.terms_sha256}</dd>
      </dl>
      {admin && (
        <a href={`#admin/products/${encodeURIComponent(terms.product_id)}/configuration`}>
          Open product agreement settings
        </a>
      )}
    </details>
  )
}
