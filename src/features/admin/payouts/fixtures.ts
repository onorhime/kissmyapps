// Synthetic, development/test-only records. Never imported by the production entrypoint.
import type { Payout, PayoutStatement, PayoutWorkspace } from '../api/payouts'
export const fixtureId = '19000000-0000-4000-8000-000000000001'
export function payoutFixture(): Payout {
  return {
    id: fixtureId,
    period_id: '79000000-0000-4000-8000-000000000001',
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-08-15T00:00:00Z',
    due_at: '2026-08-18T00:00:00Z',
    product_id: '29000000-0000-4000-8000-000000000001',
    product_name: 'BC Learn fixture',
    affiliate_id: '39000000-0000-4000-8000-000000000001',
    partner_name: 'Example partner',
    status: 'review',
    currency: 'USD',
    eligible_net_minor: 0,
    earnings_minor: 0,
    adjustments_minor: 2500,
    carry_in_minor: 0,
    carry_out_minor: 0,
    final_payout_minor: 2500,
    minimum_minor: 2000,
    frequency_days: 14,
    ledger_count: 1,
    snapshot_count: 1,
    statement_number: 'KMA-FIXTURE-001',
    updated_at: '2026-09-07T12:00:00Z',
    reviewed_at: '2026-09-07T12:00:00Z',
    approved_at: null,
    paid_at: null,
    hold_reason: null,
    held_from_status: null,
    destination_label: null,
    frozen_destination_label: null,
    reconciliation_status: null,
    reconciled_at: null,
    common_blockers: ['reconciliation_required'],
    approval_blockers: ['reconciliation_required', 'verified_destination_required'],
    external_transfer_enabled: false,
  }
}
export function workspaceFixture(): PayoutWorkspace {
  const p = payoutFixture()
  return {
    generated_at: '2026-09-07T12:00:00Z',
    selected_period_id: p.period_id,
    periods: [
      {
        id: p.period_id,
        starts_at: p.period_start,
        ends_at: p.period_end,
        review_starts_at: '2026-08-16T00:00:00Z',
        payout_due_at: p.due_at,
        status: 'closed',
        updated_at: '2026-09-07T12:00:00Z',
      },
    ],
    periods_truncated: false,
    total: 1,
    items: [p],
    unprepared_groups: 0,
    processing_attention: false,
    external_transfer_enabled: false,
  }
}
export function statementFixture(): PayoutStatement {
  const p = payoutFixture()
  return {
    payout: p,
    agreements: [
      {
        agreement_id: '49000000-0000-4000-8000-000000000001',
        version: 1,
        model: 'revenue_share',
        minimum_minor: 2000,
        frequency_days: 14,
        currency: 'USD',
      },
    ],
    ledger: [
      {
        id: '89000000-0000-4000-8000-000000000001',
        entry_type: 'adjustment',
        amount_minor: 2500,
        currency: 'USD',
        description: 'Synthetic fixture, not a production earning',
        created_at: '2026-08-10T00:00:00Z',
        source_payout_id: null,
      },
    ],
    ledger_truncated: false,
  }
}
