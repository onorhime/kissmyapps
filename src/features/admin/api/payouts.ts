import { singleAdminRow } from './mappers'

export const PAYOUT_STATUSES = [
  'open',
  'review',
  'approved',
  'scheduled',
  'paid',
  'on_hold',
  'failed',
  'carried_forward',
] as const
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number]
export const PAYOUT_ACTIONS = [
  'create_period',
  'review_period',
  'close_period',
  'prepare_statements',
  'review',
  'approve',
  'hold',
  'resume',
  'carry_forward',
] as const
export type PayoutAction = (typeof PAYOUT_ACTIONS)[number]
export const PAYOUT_ACTION_LABELS: Record<PayoutAction, string> = {
  create_period: 'Create period',
  review_period: 'Start period review',
  close_period: 'Close period',
  prepare_statements: 'Prepare statements',
  review: 'Mark reviewed',
  approve: 'Approve statement',
  hold: 'Place on hold',
  resume: 'Resume statement',
  carry_forward: 'Carry balance forward',
}
export const PAYOUT_BLOCKERS: Record<string, string> = {
  validation_window_pending: 'The signed rule’s validation hold has not ended yet.',
  cadence_policy_required:
    'This workflow supports 14-day terms. Other payout cadences need a separate settlement policy.',
  period_not_closed: 'Close the payout period first.',
  ledger_unavailable: 'A complete, single-currency ledger is required.',
  statement_out_of_date:
    'The statement no longer matches its ledger. Investigate before proceeding.',
  agreement_snapshot_missing: 'Frozen agreement evidence is missing.',
  reconciliation_required:
    'A fresh, passed Stripe reconciliation for this exact period and currency is required.',
  processing_not_ready: 'Resolve processing health or unprocessed billing events first.',
  review_required: 'Mark this statement reviewed first.',
  partner_not_active: 'The partner is not active.',
  no_positive_balance: 'There is no positive balance to pay.',
  below_minimum: 'The balance is below the agreement minimum.',
  verified_destination_required:
    'A verified payment destination with its security hold completed is required.',
}
export type PayoutPeriod = {
  id: string
  starts_at: string
  ends_at: string
  review_starts_at: string
  payout_due_at: string
  status: 'open' | 'review' | 'closed'
  updated_at: string
}
export type Payout = {
  id: string
  period_id: string
  period_start: string
  period_end: string
  due_at: string
  product_id: string
  product_name: string
  affiliate_id: string
  partner_name: string
  status: PayoutStatus
  currency: string
  eligible_net_minor: number
  earnings_minor: number
  adjustments_minor: number
  carry_in_minor: number
  carry_out_minor: number
  final_payout_minor: number
  minimum_minor: number | null
  frequency_days: number | null
  ledger_count: number
  snapshot_count: number
  statement_number: string | null
  updated_at: string
  reviewed_at: string | null
  approved_at: string | null
  paid_at: string | null
  hold_reason: string | null
  held_from_status: PayoutStatus | null
  destination_label: string | null
  frozen_destination_label: string | null
  reconciliation_status: string | null
  reconciled_at: string | null
  common_blockers: string[]
  approval_blockers: string[]
  external_transfer_enabled: false
}
export type PayoutWorkspace = {
  generated_at: string
  selected_period_id: string | null
  periods: PayoutPeriod[]
  periods_truncated: boolean
  total: number
  items: Payout[]
  unprepared_groups: number
  processing_attention: boolean
  external_transfer_enabled: false
}
export type PayoutStatement = {
  payout: Payout
  agreements: {
    agreement_id: string
    version: number
    model: string
    minimum_minor: number
    frequency_days: number
    currency: string
  }[]
  ledger: {
    id: string
    entry_type: string
    amount_minor: number
    currency: string
    description: string | null
    created_at: string
    source_payout_id: string | null
  }[]
  ledger_truncated: boolean
}
export type PayoutFilters = {
  periodId?: string
  query?: string
  status?: PayoutStatus | ''
  offset?: number
  limit?: number
}
export type PayoutActionInput = {
  request_id: string
  action: PayoutAction
  reason: string
  id?: string
  expected_updated_at?: string
  starts_at?: string
  ends_at?: string
  review_starts_at?: string
  payout_due_at?: string
  next_period_id?: string
}
export type PayoutActionResult = {
  request_id: string
  action: PayoutAction
  id: string
  external_transfer: false
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid payout object')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000)
    throw Error('Invalid payout text')
  return value
}
function uuid(value: unknown): string {
  const s = text(value)
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s)) throw Error('Invalid payout ID')
  return s
}
function time(value: unknown): string {
  const s = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s)))
    throw Error('Invalid payout date')
  return s
}
function integer(value: unknown, min = Number.MIN_SAFE_INTEGER): number {
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min)
    throw Error('Invalid payout integer')
  return n
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Error('Invalid payout flag')
  return value
}
function noTransfer(value: unknown): false {
  if (value !== false) throw Error('Unexpected transfer contract')
  return false
}
function nullable<T>(value: unknown, mapper: (v: unknown) => T): T | null {
  return value === null ? null : mapper(value)
}
function list<T>(value: unknown, mapper: (v: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) throw Error('Invalid payout list')
  return value.map(mapper)
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw Error('Invalid payout state')
  return value as T
}
function root(value: unknown, rpc: string) {
  const r = object(singleAdminRow(value))
  return Object.hasOwn(r, rpc) ? object(r[rpc]) : r
}
function currency(value: unknown) {
  const s = text(value)
  if (!/^[A-Z]{3}$/.test(s)) throw Error('Invalid payout currency')
  return s
}
function blockers(value: unknown) {
  return list(value, (v) => choice(v, Object.keys(PAYOUT_BLOCKERS)), 20)
}
export function mapPayout(value: unknown): Payout {
  const r = object(value)
  const result: Payout = {
    id: uuid(r.id),
    period_id: uuid(r.period_id),
    period_start: time(r.period_start),
    period_end: time(r.period_end),
    due_at: time(r.due_at),
    product_id: uuid(r.product_id),
    product_name: text(r.product_name),
    affiliate_id: uuid(r.affiliate_id),
    partner_name: text(r.partner_name),
    status: choice(r.status, PAYOUT_STATUSES),
    currency: currency(r.currency),
    eligible_net_minor: integer(r.eligible_net_minor),
    earnings_minor: integer(r.earnings_minor),
    adjustments_minor: integer(r.adjustments_minor),
    carry_in_minor: integer(r.carry_in_minor),
    carry_out_minor: integer(r.carry_out_minor),
    final_payout_minor: integer(r.final_payout_minor, 0),
    minimum_minor: nullable(r.minimum_minor, (v) => integer(v, 0)),
    frequency_days: nullable(r.frequency_days, (v) => integer(v, 1)),
    ledger_count: integer(r.ledger_count, 0),
    snapshot_count: integer(r.snapshot_count, 0),
    statement_number: nullable(r.statement_number, text),
    updated_at: time(r.updated_at),
    reviewed_at: nullable(r.reviewed_at, time),
    approved_at: nullable(r.approved_at, time),
    paid_at: nullable(r.paid_at, time),
    hold_reason: nullable(r.hold_reason, text),
    held_from_status: nullable(r.held_from_status, (v) => choice(v, PAYOUT_STATUSES)),
    destination_label: nullable(r.destination_label, text),
    frozen_destination_label: nullable(r.frozen_destination_label, text),
    reconciliation_status: nullable(r.reconciliation_status, text),
    reconciled_at: nullable(r.reconciled_at, time),
    common_blockers: blockers(r.common_blockers),
    approval_blockers: blockers(r.approval_blockers),
    external_transfer_enabled: noTransfer(r.external_transfer_enabled),
  }
  if (
    BigInt(result.earnings_minor) +
      BigInt(result.adjustments_minor) +
      BigInt(result.carry_in_minor) -
      BigInt(result.carry_out_minor) !==
    BigInt(result.final_payout_minor)
  )
    throw Error('Payout balance mismatch')
  if (
    (result.status === 'paid' && result.paid_at === null) ||
    (['approved', 'scheduled', 'paid'].includes(result.status) && result.approved_at === null) ||
    (result.status === 'review' && result.reviewed_at === null) ||
    (result.status === 'on_hold' && (!result.hold_reason || !result.held_from_status))
  )
    throw Error('Payout state evidence missing')
  return result
}
export function mapPayoutWorkspace(value: unknown): PayoutWorkspace {
  const r = root(value, 'get_admin_payout_workspace')
  const result: PayoutWorkspace = {
    generated_at: time(r.generated_at),
    selected_period_id: nullable(r.selected_period_id, uuid),
    periods: list(
      r.periods,
      (v) => {
        const p = object(v)
        return {
          id: uuid(p.id),
          starts_at: time(p.starts_at),
          ends_at: time(p.ends_at),
          review_starts_at: time(p.review_starts_at),
          payout_due_at: time(p.payout_due_at),
          status: choice(p.status, ['open', 'review', 'closed'] as const),
          updated_at: time(p.updated_at),
        }
      },
      200,
    ),
    periods_truncated: flag(r.periods_truncated),
    total: integer(r.total, 0),
    items: list(r.items, mapPayout, 100),
    unprepared_groups: integer(r.unprepared_groups, 0),
    processing_attention: flag(r.processing_attention),
    external_transfer_enabled: noTransfer(r.external_transfer_enabled),
  }
  if (
    result.items.length > result.total ||
    result.items.some((p) => p.period_id !== result.selected_period_id)
  )
    throw Error('Payout page mismatch')
  return result
}
export function mapPayoutStatement(value: unknown): PayoutStatement {
  const r = root(value, 'get_admin_payout_statement')
  const result: PayoutStatement = {
    payout: mapPayout(r.payout),
    agreements: list(
      r.agreements,
      (v) => {
        const a = object(v)
        return {
          agreement_id: uuid(a.agreement_id),
          version: integer(a.version, 1),
          model: text(a.model),
          minimum_minor: integer(a.minimum_minor, 0),
          frequency_days: integer(a.frequency_days, 1),
          currency: currency(a.currency),
        }
      },
      1000,
    ),
    ledger: list(
      r.ledger,
      (v) => {
        const e = object(v)
        return {
          id: uuid(e.id),
          entry_type: text(e.entry_type),
          amount_minor: integer(e.amount_minor),
          currency: currency(e.currency),
          description: nullable(e.description, text),
          created_at: time(e.created_at),
          source_payout_id: nullable(e.source_payout_id, uuid),
        }
      },
      500,
    ),
    ledger_truncated: flag(r.ledger_truncated),
  }
  if (
    result.agreements.length !== result.payout.snapshot_count ||
    result.ledger.length !== Math.min(500, result.payout.ledger_count) ||
    result.ledger_truncated !== result.payout.ledger_count > 500 ||
    result.ledger.some((e) => e.currency !== result.payout.currency) ||
    result.agreements.some((a) => a.currency !== result.payout.currency) ||
    new Set(result.ledger.map((e) => e.id)).size !== result.ledger.length
  )
    throw Error('Payout evidence projection mismatch')
  return result
}
export function mapPayoutActionResult(value: unknown): PayoutActionResult {
  const r = root(value, 'perform_admin_payout_action')
  return {
    request_id: uuid(r.request_id),
    action: choice(r.action, PAYOUT_ACTIONS),
    id: uuid(r.id),
    external_transfer: noTransfer(r.external_transfer),
  }
}
