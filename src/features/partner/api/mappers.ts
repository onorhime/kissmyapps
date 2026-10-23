import type {
  NotificationPreferences,
  PartnerAgreement,
  PartnerAgreementStatus,
  PartnerCommissionModel,
  PartnerCommissionRule,
  PartnerDashboardSummary,
  PartnerDocument,
  PartnerDocumentStatus,
  PartnerLink,
  PartnerLinkOption,
  PartnerLinkOptionKind,
  PartnerLinkStatus,
  PartnerMetricValues,
  PartnerPayout,
  PartnerPayoutCalculationLine,
  PartnerPayoutDetail,
  PartnerPayoutHistoryEntry,
  PartnerPayoutStatus,
  PartnerProduct,
  PartnerProductStatus,
  PartnerProductTrackingMode,
  PartnerProfile,
  PartnerReconciliationStage,
  PartnerRole,
  PartnerSignatureReceipt,
  PartnerSignatureRequest,
  PartnerStatus,
  PartnerTrendPoint,
} from './types'

type JsonRecord = Record<string, unknown>

function record(value: unknown, label = 'row'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as JsonRecord
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is not a string`)
  return value
}

function possiblyEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`)
  return value
}

function nullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : string(value, label)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`)
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer`)
  }
  return value
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : integer(value, label)
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} has an unsupported value`)
  }
  return value as T
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} is not a string array`)
  }
  return value
}

function records(value: unknown, label: string): readonly JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value.map((item) => record(item, label))
}

const partnerRoles: readonly PartnerRole[] = ['owner', 'finance', 'analyst', 'member']
const partnerStatuses: readonly PartnerStatus[] = [
  'draft',
  'invited',
  'active',
  'paused',
  'terminated',
]
const productStatuses: readonly PartnerProductStatus[] = ['draft', 'active', 'paused', 'archived']
const productTrackingModes: readonly PartnerProductTrackingMode[] = ['commercial', 'tracking_only']
const agreementStatuses: readonly PartnerAgreementStatus[] = [
  'draft',
  'awaiting_signature',
  'active',
  'superseded',
  'expired',
  'terminated',
]
const commissionModels: readonly PartnerCommissionModel[] = [
  'cpl',
  'cpa',
  'revenue_share',
  'hybrid',
]
const linkOptionKinds: readonly PartnerLinkOptionKind[] = ['funnel', 'source', 'campaign']
const linkStatuses: readonly PartnerLinkStatus[] = ['active', 'paused', 'archived']
const payoutStatuses: readonly PartnerPayoutStatus[] = [
  'open',
  'review',
  'approved',
  'scheduled',
  'paid',
  'on_hold',
  'failed',
  'carried_forward',
]
const reconciliationStages: readonly PartnerReconciliationStage[] = [
  'preliminary',
  'reconciled',
  'finalized',
]
const documentStatuses: readonly PartnerDocumentStatus[] = [
  'draft',
  'awaiting_partner_signature',
  'awaiting_kissmyapps_signature',
  'signed',
  'active',
  'superseded',
  'expired',
  'terminated',
]

function notifications(value: unknown): NotificationPreferences {
  const row = record(value, 'notifications')
  return {
    statements: boolean(row.statements, 'notifications.statements'),
    payouts: boolean(row.payouts, 'notifications.payouts'),
    verification: boolean(row.verification, 'notifications.verification'),
    signatures: boolean(row.signatures, 'notifications.signatures'),
    adjustments: boolean(row.adjustments, 'notifications.adjustments'),
    inactiveLinks: boolean(row.inactive_links, 'notifications.inactive_links'),
  }
}

export function mapPartnerProfile(value: unknown): PartnerProfile {
  const row = record(value)
  return {
    email: string(row.email, 'email'),
    fullName: string(row.full_name, 'full_name'),
    publicName: string(row.public_name, 'public_name'),
    legalName: string(row.legal_name, 'legal_name'),
    entityType:
      row.entity_type === null || row.entity_type === undefined
        ? null
        : enumValue(row.entity_type, ['Individual', 'Company'] as const, 'entity_type'),
    countryCode: nullableString(row.country_code, 'country_code'),
    timezone: string(row.timezone, 'timezone'),
    preferredCurrency: string(row.preferred_currency, 'preferred_currency'),
    website: nullableString(row.website, 'website'),
    category: nullableString(row.category, 'category'),
    audienceDescription: nullableString(row.audience_description, 'audience_description'),
    audienceCountries: strings(row.audience_countries, 'audience_countries'),
    channels: strings(row.channels, 'channels'),
    channelDetails: nullableString(row.channel_details, 'channel_details'),
    role: enumValue(row.role, partnerRoles, 'role'),
    status: enumValue(row.status, partnerStatuses, 'status'),
    notifications: notifications(row.notifications),
  }
}

export function mapPartnerProduct(value: unknown): PartnerProduct {
  const row = record(value)
  return {
    id: string(row.id, 'id'),
    slug: string(row.slug, 'slug'),
    name: string(row.name, 'name'),
    status: enumValue(row.status, productStatuses, 'status'),
    trackingMode: enumValue(row.tracking_mode, productTrackingModes, 'tracking_mode'),
    agreementStatus:
      row.agreement_status === null || row.agreement_status === undefined
        ? null
        : enumValue(row.agreement_status, agreementStatuses, 'agreement_status'),
    commercialModel:
      row.commercial_model === null || row.commercial_model === undefined
        ? null
        : enumValue(row.commercial_model, commissionModels, 'commercial_model'),
    payoutCurrency: nullableString(row.payout_currency, 'payout_currency'),
    hasLiveFunnel: boolean(row.has_live_funnel, 'has_live_funnel'),
    mainLinkId: nullableString(row.main_link_id, 'main_link_id'),
    testMainLinkId: nullableString(row.test_main_link_id, 'test_main_link_id'),
    testMainTrackingUrl:
      nullableString(row.test_main_short_url, 'test_main_short_url') ??
      nullableString(row.test_main_tracking_url, 'test_main_tracking_url'),
    mainTrackingUrl:
      nullableString(row.main_short_url, 'main_short_url') ??
      nullableString(row.main_tracking_url, 'main_tracking_url'),
  }
}

export function mapPartnerLinkOption(value: unknown): PartnerLinkOption {
  const row = record(value)
  return {
    id: string(row.id, 'id'),
    kind: enumValue(row.kind, linkOptionKinds, 'kind'),
    productId: nullableString(row.product_id, 'product_id'),
    key: string(row.key, 'key'),
    name: string(row.name, 'name'),
    available: boolean(row.available, 'available'),
  }
}

export function mapPartnerLink(value: unknown): PartnerLink {
  const row = record(value)
  return {
    id: string(row.id, 'id'),
    name: string(row.name, 'name'),
    productId: string(row.product_id, 'product_id'),
    productName: string(row.product_name, 'product_name'),
    productSlug: string(row.product_slug, 'product_slug'),
    funnelId: string(row.funnel_id, 'funnel_id'),
    funnelName: string(row.funnel_name, 'funnel_name'),
    sourceId: nullableString(row.source_id, 'source_id'),
    sourceName: nullableString(row.source_name, 'source_name'),
    campaignId: nullableString(row.campaign_id, 'campaign_id'),
    campaignName: nullableString(row.campaign_name, 'campaign_name'),
    sub1: string(row.sub1, 'sub1'),
    sub2: possiblyEmptyString(row.sub2, 'sub2'),
    sub3: possiblyEmptyString(row.sub3, 'sub3'),
    status: enumValue(row.status, linkStatuses, 'status'),
    trackingUrl:
      nullableString(row.short_url, 'short_url') ?? string(row.tracking_url, 'tracking_url'),
    environment: enumValue(row.environment ?? 'live', ['test', 'live'] as const, 'environment'),
    parentLinkId: nullableString(row.parent_link_id, 'parent_link_id'),
    commercialEligible: boolean(row.commercial_eligible, 'commercial_eligible'),
    clicks: integer(row.clicks, 'clicks'),
    leads: nullableInteger(row.leads, 'leads'),
    installs: nullableInteger(row.installs, 'installs'),
    purchases: nullableInteger(row.purchases, 'purchases'),
    earningsMinor: nullableInteger(row.earnings_minor, 'earnings_minor'),
    currency: nullableString(row.currency, 'currency'),
    createdAt: string(row.created_at, 'created_at'),
  }
}

function metricValues(row: JsonRecord): PartnerMetricValues {
  return {
    clicks: nullableInteger(row.clicks, 'clicks'),
    visitors: nullableInteger(row.visitors, 'visitors'),
    funnelStarts: nullableInteger(row.funnel_starts, 'funnel_starts'),
    paymentViews: nullableInteger(row.payment_views, 'payment_views'),
    appStoreClicks: nullableInteger(row.app_store_clicks, 'app_store_clicks'),
    leads: nullableInteger(row.leads, 'leads'),
    trials: nullableInteger(row.trials, 'trials'),
    installs: nullableInteger(row.installs, 'installs'),
    purchases: nullableInteger(row.purchases, 'purchases'),
    activations: nullableInteger(row.activations, 'activations'),
    renewals: nullableInteger(row.renewals, 'renewals'),
    cancellations: nullableInteger(row.cancellations, 'cancellations'),
    refunds: nullableInteger(row.refunds, 'refunds'),
    disputes: nullableInteger(row.disputes, 'disputes'),
    grossCollectedMinor: nullableInteger(row.gross_collected_minor, 'gross_collected_minor'),
    eligibleRevenueMinor: nullableInteger(row.eligible_revenue_minor, 'eligible_revenue_minor'),
    earningsMinor: nullableInteger(row.earnings_minor, 'earnings_minor'),
    activeSubscriptions: nullableInteger(row.active_subscriptions, 'active_subscriptions'),
  }
}

function nullableReconciliationStage(value: unknown): PartnerReconciliationStage | null {
  return value === null || value === undefined
    ? null
    : enumValue(value, reconciliationStages, 'reconciliation_stage')
}

export function mapPartnerDashboardSummary(value: unknown): PartnerDashboardSummary {
  const row = record(value)
  return {
    startsOn: nullableString(row.starts_on, 'starts_on'),
    endsOn: nullableString(row.ends_on, 'ends_on'),
    timezone: string(row.timezone, 'timezone'),
    currency: nullableString(row.currency, 'currency'),
    hasData: boolean(row.has_data, 'has_data'),
    reconciliationStage: nullableReconciliationStage(row.reconciliation_stage),
    reconciledThrough: nullableString(row.reconciled_through, 'reconciled_through'),
    metrics: metricValues(row),
  }
}

export function mapPartnerTrendPoint(value: unknown): PartnerTrendPoint {
  const row = record(value)
  return {
    bucketStart: string(row.bucket_start, 'bucket_start'),
    bucketEnd: string(row.bucket_end, 'bucket_end'),
    dimensionKey: string(row.dimension_key, 'dimension_key'),
    dimensionLabel: string(row.dimension_label, 'dimension_label'),
    reconciliationStage: nullableReconciliationStage(row.reconciliation_stage),
    metrics: metricValues(row),
  }
}

export function mapPartnerPayoutSummary(value: unknown) {
  const row = record(value)
  return {
    currency: nullableString(row.currency, 'currency'),
    openMinor: nullableInteger(row.open_minor, 'open_minor'),
    approvedMinor: nullableInteger(row.approved_minor, 'approved_minor'),
    scheduledMinor: nullableInteger(row.scheduled_minor, 'scheduled_minor'),
    paidMinor: nullableInteger(row.paid_minor, 'paid_minor'),
    carriedForwardMinor: nullableInteger(row.carried_forward_minor, 'carried_forward_minor'),
    nextExpectedPaymentAt: nullableString(row.next_expected_payment_at, 'next_expected_payment_at'),
  }
}

export function mapPartnerPayout(value: unknown): PartnerPayout {
  const row = record(value)
  return {
    id: string(row.id, 'id'),
    productName: string(row.product_name, 'product_name'),
    periodStartsAt: string(row.period_starts_at, 'period_starts_at'),
    periodEndsAt: string(row.period_ends_at, 'period_ends_at'),
    expectedPaymentAt: nullableString(row.expected_payment_at, 'expected_payment_at'),
    status: enumValue(row.status, payoutStatuses, 'status'),
    eligibleNetMinor: integer(row.eligible_net_minor, 'eligible_net_minor'),
    earningsMinor: integer(row.earnings_minor, 'earnings_minor'),
    adjustmentsMinor: integer(row.adjustments_minor, 'adjustments_minor'),
    finalPayoutMinor: integer(row.final_payout_minor, 'final_payout_minor'),
    currency: string(row.currency, 'currency'),
    statementNumber: nullableString(row.statement_number, 'statement_number'),
    statementAvailable: boolean(row.statement_available, 'statement_available'),
    paymentMethod:
      row.payment_method === null || row.payment_method === undefined
        ? null
        : enumValue(row.payment_method, ['bank', 'crypto'] as const, 'payment_method'),
    paymentReference: nullableString(row.payment_reference, 'payment_reference'),
    paidAt: nullableString(row.paid_at, 'paid_at'),
  }
}

function mapCalculationLine(value: unknown): PartnerPayoutCalculationLine {
  const row = record(value, 'calculation line')
  return {
    key: string(row.key, 'calculation.key'),
    label: string(row.label, 'calculation.label'),
    amountMinor: integer(row.amount_minor, 'calculation.amount_minor'),
    note: string(row.note, 'calculation.note'),
  }
}

function mapPayoutHistoryEntry(value: unknown): PartnerPayoutHistoryEntry {
  const row = record(value, 'history entry')
  return {
    occurredAt: string(row.occurred_at, 'history.occurred_at'),
    label: string(row.label, 'history.label'),
    amountMinor: nullableInteger(row.amount_minor, 'history.amount_minor'),
  }
}

export function mapPartnerPayoutDetail(value: unknown): PartnerPayoutDetail {
  const row = record(value)
  return {
    ...mapPartnerPayout(row),
    agreementVersion: integer(row.agreement_version, 'agreement_version'),
    agreementLabel: string(row.agreement_label, 'agreement_label'),
    commercialModel: enumValue(row.commercial_model, commissionModels, 'commercial_model'),
    minimumPayoutMinor: integer(row.minimum_payout_minor, 'minimum_payout_minor'),
    payoutFrequencyDays: integer(row.payout_frequency_days, 'payout_frequency_days'),
    calculation: records(row.calculation, 'calculation').map(mapCalculationLine),
    history: records(row.history, 'history').map(mapPayoutHistoryEntry),
  }
}

function mapCommissionRule(value: unknown): PartnerCommissionRule {
  const row = record(value, 'commission rule')
  const policyVersion =
    row.policy_version === undefined
      ? undefined
      : integer(row.policy_version, 'rule.policy_version')
  const policy =
    policyVersion !== undefined && policyVersion >= 2
      ? {
          policyVersion,
          ...(policyVersion >= 3
            ? {
                firstPurchaseOnly: boolean(row.first_purchase_only, 'rule.first_purchase_only'),
                fulfilmentRequired: boolean(row.fulfilment_required, 'rule.fulfilment_required'),
              }
            : {}),
          validationWindowHours: integer(
            row.validation_window_hours,
            'rule.validation_window_hours',
          ),
          refundCutoffDays:
            row.refund_cutoff_days === null
              ? null
              : integer(row.refund_cutoff_days, 'rule.refund_cutoff_days'),
          commissionBasisPolicy: enumValue(
            row.commission_basis_policy,
            ['net_after_fees', 'subtotal_ex_tax_shipping'] as const,
            'rule.commission_basis_policy',
          ),
          externalRefundCalculation: enumValue(
            row.external_refund_calculation,
            ['proportional_commission'] as const,
            'rule.external_refund_calculation',
          ),
        }
      : {}
  return {
    ...policy,
    ...(row.version === undefined ? {} : { version: integer(row.version, 'rule.version') }),
    ...(row.status === undefined ? {} : { status: string(row.status, 'rule.status') }),
    name: string(row.name, 'rule.name'),
    model: enumValue(row.model, commissionModels, 'rule.model'),
    triggerEvent: string(row.trigger_event, 'rule.trigger_event'),
    fixedAmountMinor: nullableInteger(row.fixed_amount_minor, 'rule.fixed_amount_minor'),
    rateBasisPoints: nullableInteger(row.rate_basis_points, 'rule.rate_basis_points'),
    currency: nullableString(row.currency, 'rule.currency'),
  }
}

export function mapPartnerAgreement(value: unknown): PartnerAgreement {
  const row = record(value)
  return {
    productId: string(row.product_id, 'product_id'),
    productName: string(row.product_name, 'product_name'),
    version: integer(row.version, 'version'),
    status: enumValue(row.status, agreementStatuses, 'status'),
    model: enumValue(row.model, commissionModels, 'model'),
    startsAt: nullableString(row.starts_at, 'starts_at'),
    endsAt: nullableString(row.ends_at, 'ends_at'),
    attributionWindowDays: integer(row.attribution_window_days, 'attribution_window_days'),
    renewalDurationDays: nullableInteger(row.renewal_duration_days, 'renewal_duration_days'),
    payoutFrequencyDays: integer(row.payout_frequency_days, 'payout_frequency_days'),
    payoutCurrency: string(row.payout_currency, 'payout_currency'),
    minimumPayoutMinor: integer(row.minimum_payout_minor, 'minimum_payout_minor'),
    rules: records(row.rules, 'rules').map(mapCommissionRule),
  }
}

export function mapPartnerDocument(value: unknown): PartnerDocument {
  const row = record(value)
  return {
    id: string(row.id, 'id'),
    productId: nullableString(row.product_id, 'product_id'),
    name: string(row.name, 'name'),
    type: string(row.document_type, 'document_type'),
    version: integer(row.version, 'version'),
    status: enumValue(row.status, documentStatuses, 'status'),
    createdAt: string(row.created_at, 'created_at'),
    effectiveAt: nullableString(row.effective_at, 'effective_at'),
    expiresAt: nullableString(row.expires_at, 'expires_at'),
    terminatedAt: nullableString(row.terminated_at, 'terminated_at'),
    partnerSignedAt: nullableString(row.partner_signed_at, 'partner_signed_at'),
    companySignedAt: nullableString(row.company_signed_at, 'company_signed_at'),
    supersedesDocumentId: nullableString(row.supersedes_document_id, 'supersedes_document_id'),
    supersededByDocumentId: nullableString(
      row.superseded_by_document_id,
      'superseded_by_document_id',
    ),
    downloadAvailable: boolean(row.download_available, 'download_available'),
  }
}

export function mapPartnerDocumentDownload(value: unknown) {
  const row = record(value)
  const filePath = string(row.file_path, 'file_path')
  if (
    filePath.length > 2000 ||
    !/^[0-9a-f-]{36}\//i.test(filePath) ||
    filePath.includes('\\') ||
    filePath.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid document path')
  return {
    ...(row.rules === undefined
      ? {}
      : { rules: records(row.rules, 'signature rules').map(mapCommissionRule) }),
    ...(row.terms_sha256 == null ? {} : { termsSha256: string(row.terms_sha256, 'terms_sha256') }),
    documentId: string(row.document_id, 'document_id'),
    bucket: enumValue(row.bucket, ['affiliate-private-documents'] as const, 'bucket'),
    filePath,
  }
}

export function mapPartnerSignatureReceipt(value: unknown): PartnerSignatureReceipt {
  const row = record(value)
  const signedAt = string(row.signed_by_partner_at, 'signed_by_partner_at')
  const acknowledgedAt = string(row.partner_acknowledged_at, 'partner_acknowledged_at')
  if (!Number.isFinite(Date.parse(signedAt)) || !Number.isFinite(Date.parse(acknowledgedAt)))
    throw new Error('signature evidence timestamps are invalid')
  return {
    documentId: string(row.id, 'id'),
    agreementId: string(row.agreement_id, 'agreement_id'),
    version: integer(row.version, 'version'),
    status: enumValue(row.status, ['awaiting_kissmyapps_signature'] as const, 'status'),
    signerName: string(row.partner_signer_name, 'partner_signer_name'),
    signerUserId: string(row.partner_signer_user_id, 'partner_signer_user_id'),
    signedAt,
    acknowledgedAt,
  }
}

export function mapPartnerSignatureQueue(value: unknown): readonly PartnerSignatureRequest[] {
  if (value === null || value === undefined) return []
  return records(value, 'signature queue').map((row) => ({
    ...(row.rules === undefined
      ? {}
      : { rules: records(row.rules, 'signature rules').map(mapCommissionRule) }),
    ...(row.terms_sha256 == null ? {} : { termsSha256: string(row.terms_sha256, 'terms_sha256') }),
    documentId: string(row.document_id, 'document_id'),
    name: string(row.name, 'name'),
    version: integer(row.version, 'version'),
    agreementId: string(row.agreement_id, 'agreement_id'),
    productId: string(row.product_id, 'product_id'),
    productName: string(row.product_name, 'product_name'),
    model: enumValue(row.model, commissionModels, 'model'),
    attributionWindowDays: integer(row.attribution_window_days, 'attribution_window_days'),
    payoutFrequencyDays: integer(row.payout_frequency_days, 'payout_frequency_days'),
    payoutCurrency: string(row.payout_currency, 'payout_currency'),
    minimumPayoutMinor: integer(row.minimum_payout_minor, 'minimum_payout_minor'),
    filePath: string(row.file_path, 'file_path'),
    requestedAt: string(row.requested_at, 'requested_at'),
  }))
}

export function mapRows<T>(value: unknown, mapper: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('response data is not an array')
  return value.map(mapper)
}

export function mapSingleRow<T>(value: unknown, mapper: (row: unknown) => T): T | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.length !== 1) throw new Error('response contains multiple rows')
    return mapper(value[0])
  }
  return mapper(value)
}
