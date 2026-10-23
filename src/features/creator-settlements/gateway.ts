import { providerMoney, parseProviderMoney } from '../../lib/providerMoney'
import { supabase } from '../../lib/supabase'

export type SettlementScope = {
  product_id: string
  product_name: string
  funnel_id: string
  funnel_name: string
  affiliate_id: string
  affiliate_name: string
  stripe_account_id: string
  platform_account_id: string
  livemode: boolean
  currency: string | null
}
export type CanonicalSettlementRule = {
  id: string
  version: number
  name: string
  model: string
  status: string
  trigger_event: string
  fixed_amount_minor: number | null
  rate_basis_points: number | null
  currency: string | null
  validation_window_hours: number
  first_purchase_only?: boolean
  fulfilment_required?: boolean
  refund_cutoff_days: number | null
  commission_basis_policy: 'net_after_fees' | 'subtotal_ex_tax_shipping'
  policy_version: number
}
export type CanonicalSettlementAgreement = {
  id: string
  version: number
  product_id: string
  affiliate_id: string
  status: string
  model: string
  payout_currency: string
  attribution_window_days: number
  renewal_duration_days: number | null
  payout_frequency_days: number
  minimum_payout_minor: number
  starts_at: string | null
  ends_at: string | null
  signed_document_id: string | null
  terms_sha256: string | null
  eligible: boolean
  rules: CanonicalSettlementRule[]
}
export type CommissionTerms = {
  agreement_id?: string | null
  commission_rule_id?: string | null
  signed_document_id?: string | null
  agreement_version?: number | null
  commission_rule_version?: number | null
  terms_sha256?: string | null
  validation_window_hours?: number | null
  first_purchase_only?: boolean
  fulfilment_required?: boolean
  refund_cutoff_days?: number | null
  commission_basis_policy?: 'net_after_fees' | 'subtotal_ex_tax_shipping' | null
  minimum_payout_minor?: number | null
  payout_frequency_days?: number | null
  funding_model?: 'merchant_direct' | 'prefunded_platform' | 'application_fee' | null
  id: string
  version: number
  revision: number
  status: 'draft' | 'approved'
  product_id: string
  funnel_id: string
  affiliate_id: string
  stripe_account_id: string
  platform_account_id: string
  livemode: boolean
  currency: string
  calculation: 'percentage' | 'fixed' | 'hybrid'
  basis_points: number | null
  fixed_minor: number | null
  hold_days: number
  attribution_window_days: number
  effective_from: string
  effective_until: string | null
  approved_at: string | null
  reason: string | null
}
export type ExternalCommission = {
  id: string
  order_id: string
  product_id: string
  funnel_id: string
  affiliate_id: string
  livemode: boolean
  currency: string
  commission_minor: number
  basis_minor: number | null
  status: string
  blocker: string | null
  eligible_at: string | null
  payout_blocker?: string | null
  payout_period_end?: string | null
  payout_next_at?: string | null
  terms_id: string | null
  revision: number
}
export type SettlementBatch = {
  id: string
  revision: number
  status: string
  product_id: string
  funnel_id: string
  affiliate_id: string
  platform_account_id: string
  livemode: boolean
  currency: string
  amount_minor: number
  created_at: string
  reviewed_at: string | null
  approved_at: string | null
  transferred_at: string | null
  reason: string | null
  items: {
    award_id: string
    order_id: string
    amount_minor: number
    status: string
    eligible_at: string | null
  }[]
  provider_jobs: {
    kind: 'transfer' | 'reversal'
    state: string
    last_error: string | null
    attempts: number
    first_attempt_at: string | null
  }[]
}
export type SettlementBalance = {
  affiliate_id: string
  platform_account_id: string
  livemode: boolean
  currency: string
  earned_minor: number
  reversed_minor: number
  transferred_minor: number
  recovered_minor: number
  balance_minor: number
  debt_minor: number
  review_required: boolean
}
export type SettlementAccount = {
  affiliate_id: string
  platform_account_id: string
  livemode: boolean
  status: string
  details_submitted: boolean
  transfers_enabled: boolean
  payouts_enabled: boolean
  requirements_due: string[]
  revision: number
  verified_at: string | null
}
export type SettlementWorkspace = {
  agreements?: CanonicalSettlementAgreement[]
  scopes: SettlementScope[]
  platforms: {
    platform_account_id: string
    livemode: boolean
    enabled: boolean
    revision: number
  }[]
  terms: CommissionTerms[]
  commissions: ExternalCommission[]
  batches: SettlementBatch[]
  accounts: SettlementAccount[]
  balances: SettlementBalance[]
  bank_payouts?: BankPayout[]
  truncated: boolean
}
export type BankPayout = {
  affiliate_id?: string
  platform_account_id: string
  livemode: boolean
  connected_account_id: string
  payout_id: string
  status: string
  amount_minor: number
  currency: string
  arrival_date: string | null
  failure_code: string | null
  observed_at: string
}
export type SettlementFilter = {
  product_id?: string
  funnel_id?: string
  affiliate_id?: string
  livemode?: boolean
}
export type SettlementClient = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
}
export type SettlementGateway = {
  workspace(admin: boolean, filter?: SettlementFilter): Promise<SettlementWorkspace>
  configure(input: Record<string, unknown>): Promise<unknown>
  action(input: Record<string, unknown>): Promise<unknown>
}

const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('Settlement response is incomplete. Refresh before proceeding.')
  return v as Record<string, unknown>
}
export function mapSettlementWorkspace(value: unknown): SettlementWorkspace {
  const row = record(value)
  for (const name of [
    'scopes',
    'platforms',
    'terms',
    'commissions',
    'batches',
    'accounts',
    'balances',
  ]) {
    if (!Array.isArray(row[name]))
      throw Error('Settlement response is incomplete. Refresh before proceeding.')
    for (const entry of row[name]) {
      const item = record(entry)
      if (typeof item.livemode !== 'boolean') throw Error('Settlement mode is missing.')
      for (const [key, val] of Object.entries(item)) {
        if (
          (key.endsWith('_minor') ||
            ['revision', 'version', 'basis_points', 'attribution_window_days'].includes(key)) &&
          val !== null &&
          !Number.isSafeInteger(val)
        )
          throw Error('Settlement amount or version is invalid.')
      }
      if (
        name !== 'platforms' &&
        name !== 'accounts' &&
        !(name === 'scopes' && item.currency === null) &&
        (typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency))
      )
        throw Error('Settlement currency is missing.')
      if (
        ['terms', 'commissions', 'batches'].includes(name) &&
        (typeof item.id !== 'string' ||
          typeof item.status !== 'string' ||
          !Number.isSafeInteger(item.revision))
      )
        throw Error('Settlement record is incomplete.')
      if (
        name === 'terms' &&
        (!['draft', 'approved'].includes(String(item.status)) ||
          !['percentage', 'fixed', 'hybrid'].includes(String(item.calculation)) ||
          !Number.isSafeInteger(item.version) ||
          typeof item.hold_days !== 'number' ||
          !Number.isFinite(item.hold_days) ||
          item.hold_days < 0 ||
          !Number.isSafeInteger(item.attribution_window_days) ||
          (item.calculation !== 'fixed' && !Number.isSafeInteger(item.basis_points)) ||
          (item.calculation !== 'percentage' && !Number.isSafeInteger(item.fixed_minor)))
      )
        throw Error('Commission terms are incomplete.')
      if (
        name === 'commissions' &&
        (!Number.isSafeInteger(item.commission_minor) ||
          Number(item.commission_minor) < 0 ||
          !['unconfigured', 'held', 'eligible', 'reversed'].includes(String(item.status)))
      )
        throw Error('Commission result is incomplete.')
      if (name === 'commissions') {
        if (item.payout_blocker != null && typeof item.payout_blocker !== 'string')
          throw Error('Commission payout eligibility is incomplete.')
        for (const field of ['payout_period_end', 'payout_next_at']) {
          const date = item[field]
          if (date != null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date))))
            throw Error('Commission payout schedule is invalid.')
        }
      }
      if (
        name === 'batches' &&
        ![
          'draft',
          'reviewed',
          'approved',
          'held',
          'processing',
          'transferred',
          'cancelled',
        ].includes(String(item.status))
      )
        throw Error('Settlement batch status is incomplete.')
      if (
        name === 'platforms' &&
        (typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.revision))
      )
        throw Error('Funding platform status is incomplete.')
    }
  }
  for (const item of row.balances as Record<string, unknown>[]) {
    if (typeof item.review_required !== 'boolean')
      throw Error('Settlement review status is missing.')
    for (const key of [
      'earned_minor',
      'reversed_minor',
      'transferred_minor',
      'recovered_minor',
      'balance_minor',
      'debt_minor',
    ]) {
      if (!Number.isSafeInteger(item[key])) throw Error('Settlement balance is incomplete.')
    }
  }
  for (const item of row.batches as Record<string, unknown>[]) {
    if (!Number.isSafeInteger(item.amount_minor) || Number(item.amount_minor) < 0)
      throw Error('Settlement amount is incomplete.')
    if (!Array.isArray(item.items) || !item.items.length)
      throw Error('Frozen settlement items are missing. Refresh before approving.')
    const ids = new Set<string>()
    let total = 0
    for (const value of item.items) {
      const line = record(value)
      if (
        typeof line.award_id !== 'string' ||
        ids.has(line.award_id) ||
        typeof line.order_id !== 'string' ||
        typeof line.status !== 'string' ||
        !Number.isSafeInteger(line.amount_minor) ||
        Number(line.amount_minor) <= 0
      )
        throw Error('Frozen settlement items are incomplete.')
      ids.add(line.award_id)
      total += Number(line.amount_minor)
    }
    if (!Number.isSafeInteger(total) || total !== item.amount_minor)
      throw Error('Frozen settlement items do not match the batch amount.')
    if (!Array.isArray(item.provider_jobs)) throw Error('Provider operation status is missing.')
    for (const value of item.provider_jobs) {
      const job = record(value)
      if (
        !['transfer', 'reversal'].includes(String(job.kind)) ||
        typeof job.state !== 'string' ||
        !Number.isSafeInteger(job.attempts) ||
        (job.last_error !== null && typeof job.last_error !== 'string')
      )
        throw Error('Provider operation status is incomplete.')
    }
  }
  if (row.agreements !== undefined) {
    if (!Array.isArray(row.agreements)) throw Error('Canonical agreement options are missing.')
    for (const value of row.agreements) {
      const agreement = record(value)
      for (const key of [
        'id',
        'product_id',
        'affiliate_id',
        'status',
        'model',
        'payout_currency',
      ]) {
        if (typeof agreement[key] !== 'string' || !agreement[key])
          throw Error('Canonical agreement is incomplete.')
      }
      for (const key of [
        'version',
        'attribution_window_days',
        'payout_frequency_days',
        'minimum_payout_minor',
      ]) {
        if (!Number.isSafeInteger(agreement[key]) || Number(agreement[key]) < 0)
          throw Error('Canonical agreement amount or version is invalid.')
      }
      if (
        !/^[A-Z]{3}$/.test(String(agreement.payout_currency)) ||
        typeof agreement.eligible !== 'boolean' ||
        !Array.isArray(agreement.rules)
      )
        throw Error('Canonical agreement is incomplete.')
      if (
        agreement.eligible &&
        (agreement.status !== 'active' ||
          typeof agreement.signed_document_id !== 'string' ||
          typeof agreement.terms_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(agreement.terms_sha256))
      )
        throw Error('Signed agreement evidence is missing.')
      for (const value of agreement.rules) {
        const rule = record(value)
        if (
          typeof rule.id !== 'string' ||
          typeof rule.name !== 'string' ||
          typeof rule.status !== 'string' ||
          typeof rule.model !== 'string' ||
          typeof rule.trigger_event !== 'string' ||
          !Number.isSafeInteger(rule.version) ||
          !Number.isSafeInteger(rule.validation_window_hours) ||
          !Number.isSafeInteger(rule.policy_version)
        )
          throw Error('Canonical commission rule is incomplete.')
        if (
          !['net_after_fees', 'subtotal_ex_tax_shipping'].includes(
            String(rule.commission_basis_policy),
          ) ||
          (rule.refund_cutoff_days !== null &&
            (!Number.isSafeInteger(rule.refund_cutoff_days) ||
              Number(rule.refund_cutoff_days) < 0 ||
              Number(rule.refund_cutoff_days) > 3650))
        )
          throw Error('Canonical refund policy is incomplete.')
        for (const key of ['fixed_amount_minor', 'rate_basis_points']) {
          if (rule[key] !== null && (!Number.isSafeInteger(rule[key]) || Number(rule[key]) < 0))
            throw Error('Canonical commission amount is invalid.')
        }
      }
    }
  }
  for (const value of row.terms as Record<string, unknown>[]) {
    if (value.agreement_id != null) {
      if (
        typeof value.agreement_id !== 'string' ||
        typeof value.commission_rule_id !== 'string' ||
        typeof value.terms_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.terms_sha256) ||
        !Number.isSafeInteger(value.validation_window_hours) ||
        !Number.isSafeInteger(value.minimum_payout_minor) ||
        !Number.isSafeInteger(value.payout_frequency_days) ||
        !['net_after_fees', 'subtotal_ex_tax_shipping'].includes(
          String(value.commission_basis_policy),
        ) ||
        !['merchant_direct', 'prefunded_platform', 'application_fee'].includes(
          String(value.funding_model),
        )
      )
        throw Error('Canonical settlement snapshot is incomplete.')
      if (
        value.refund_cutoff_days !== null &&
        (!Number.isSafeInteger(value.refund_cutoff_days) ||
          Number(value.refund_cutoff_days) < 0 ||
          Number(value.refund_cutoff_days) > 3650)
      )
        throw Error('Canonical refund policy is incomplete.')
    }
  }
  if (typeof row.truncated !== 'boolean') throw Error('Settlement coverage is missing.')
  if (row.bank_payouts !== undefined) {
    if (!Array.isArray(row.bank_payouts)) throw Error('Bank payout response is incomplete.')
    for (const value of row.bank_payouts) {
      const payout = record(value)
      if (
        typeof payout.payout_id !== 'string' ||
        typeof payout.status !== 'string' ||
        typeof payout.livemode !== 'boolean' ||
        typeof payout.currency !== 'string' ||
        !/^[A-Z]{3}$/.test(payout.currency) ||
        !Number.isSafeInteger(payout.amount_minor)
      )
        throw Error('Bank payout response is incomplete.')
    }
  }
  return row as unknown as SettlementWorkspace
}

export function createSettlementGateway(
  client: SettlementClient | null = supabase,
): SettlementGateway {
  async function request(name: string, input: Record<string, unknown>) {
    if (!client) throw Error('Creator settlements are not connected in this environment.')
    const result = await client.rpc(name, { p_input: input })
    if (result.error) {
      const code = result.error.code
      if (code === '42501' || code === 'PGRST301')
        throw Error('Your account does not have access to this settlement action.')
      if (code === '40001')
        throw Error('This record changed. Refresh it before taking another action.')
      if (code === '42883' || code === 'PGRST202')
        throw Error('Creator settlements have not been installed in this environment yet.')
      if (['22023', '23514', '55000', 'P0001', 'P0002'].includes(code ?? ''))
        throw Error(
          result.error.message || 'Check the terms and settlement eligibility before retrying.',
        )
      throw Error(
        'The settlement request could not be confirmed. Retry the same request before starting another.',
      )
    }
    return result.data
  }
  return {
    workspace: async (admin, filter = {}) => {
      const value = mapSettlementWorkspace(
        await request(
          admin
            ? 'get_admin_external_settlement_workspace'
            : 'get_partner_external_settlement_workspace',
          filter,
        ),
      )
      if (
        filter.product_id &&
        [
          ...value.scopes,
          ...value.terms,
          ...value.commissions,
          ...value.batches,
          ...(value.agreements ?? []),
        ].some((item) => item.product_id !== filter.product_id)
      )
        throw Error('Settlement product scope could not be verified.')
      return value
    },
    configure: (input) => request('configure_admin_external_commission_terms', input),
    action: (input) => request('perform_admin_external_settlement_action', input),
  }
}
export const settlementGateway = createSettlementGateway()

export const settlementMoney = providerMoney
export const moneyInputToMinor = parseProviderMoney

export const commissionLabel = (terms: CommissionTerms) =>
  [
    terms.calculation !== 'fixed' ? `${(terms.basis_points ?? 0) / 100}%` : '',
    terms.calculation !== 'percentage'
      ? settlementMoney(terms.fixed_minor ?? 0, terms.currency)
      : '',
  ]
    .filter(Boolean)
    .join(' + ')
