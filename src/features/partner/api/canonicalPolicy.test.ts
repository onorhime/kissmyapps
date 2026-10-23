import { describe, expect, it } from 'vitest'
import { mapPartnerSignatureQueue, mapPartnerAgreement } from './mappers'
const rule = {
  name: 'Purchase share',
  model: 'revenue_share',
  trigger_event: 'purchase.completed',
  fixed_amount_minor: null,
  rate_basis_points: 1500,
  currency: null,
  policy_version: 2,
  validation_window_hours: 72,
  refund_cutoff_days: 30,
  commission_basis_policy: 'net_after_fees',
  external_refund_calculation: 'proportional_commission',
}
const agreement = {
  product_id: 'product-one',
  product_name: 'Course',
  version: 2,
  status: 'active',
  model: 'revenue_share',
  starts_at: null,
  ends_at: null,
  attribution_window_days: 30,
  renewal_duration_days: null,
  payout_frequency_days: 14,
  payout_currency: 'USD',
  minimum_payout_minor: 2000,
  rules: [rule],
}
const request = {
  ...agreement,
  document_id: 'document-one',
  agreement_id: 'agreement-one',
  name: 'Signed terms',
  file_path: 'private/terms.pdf',
  requested_at: '2026-10-15T00:00:00Z',
  terms_sha256: 'a'.repeat(64),
}
describe('canonical partner policy contract', () => {
  it('maps policy from the frozen signature request and current agreement read', () => {
    const expected = {
      refundCutoffDays: 30,
      commissionBasisPolicy: 'net_after_fees',
      policyVersion: 2,
      validationWindowHours: 72,
      externalRefundCalculation: 'proportional_commission',
    }
    expect(mapPartnerSignatureQueue([request])[0]).toMatchObject({
      termsSha256: 'a'.repeat(64),
      rules: [expected],
    })
    expect(mapPartnerAgreement(agreement).rules[0]).toMatchObject(expected)
  })
  it('rejects incomplete v2 policy instead of inventing refund terms', () => {
    for (const invalid of [
      { ...rule, refund_cutoff_days: undefined },
      { ...rule, commission_basis_policy: 'gross' },
      { ...rule, external_refund_calculation: undefined },
    ]) {
      expect(() => mapPartnerSignatureQueue([{ ...request, rules: [invalid] }])).toThrow()
    }
  })
  it('preserves legacy document meaning when the old snapshot omits policy fields', () => {
    const {
      policy_version,
      refund_cutoff_days,
      commission_basis_policy,
      external_refund_calculation,
      ...legacy
    } = rule
    expect([
      policy_version,
      refund_cutoff_days,
      commission_basis_policy,
      external_refund_calculation,
    ]).toHaveLength(4)
    const mapped = mapPartnerSignatureQueue([{ ...request, rules: [legacy] }])[0].rules?.[0]
    expect(mapped).not.toHaveProperty('refundCutoffDays')
    expect(mapped).not.toHaveProperty('commissionBasisPolicy')
  })
})
