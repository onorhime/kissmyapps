import { mapAdminProduct, singleAdminRow } from './mappers'
import {
  ADMIN_AFFILIATE_STATUSES,
  ADMIN_AGREEMENT_STATUSES,
  ADMIN_BILLING_MODES,
  ADMIN_BILLING_OFFER_STATUSES,
  ADMIN_CAMPAIGN_STATUSES,
  ADMIN_COMMISSION_MODELS,
  ADMIN_COMMISSION_RULE_STATUSES,
  ADMIN_DOCUMENT_STATUSES,
  ADMIN_FUNNEL_STATUSES,
  type AdminAffiliate,
  type AdminAffiliateStatus,
  type AdminAgreement,
  type AdminAgreementDocument,
  type AdminAgreementStatus,
  type AdminBillingMode,
  type AdminBillingOffer,
  type AdminBillingOfferStatus,
  type AdminCampaign,
  type AdminCampaignStatus,
  type AdminCommissionModel,
  type AdminCommissionRule,
  type AdminCommissionRuleStatus,
  type AdminDocumentStatus,
  type AdminFunnel,
  type AdminFunnelStatus,
  type AdminMainLink,
  type AdminProductConfiguration,
  type AdminSource,
} from './types'

const linkStatuses = ['active', 'paused', 'archived'] as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object row.')
  }
  return value as Record<string, unknown>
}

function valueAt(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(row, key)) return row[key]
  }
  return undefined
}

function requiredString(row: Record<string, unknown>, ...keys: string[]): string {
  const value = valueAt(row, ...keys)
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${keys[0]}.`)
  return value
}

function nullableString(row: Record<string, unknown>, ...keys: string[]): string | null {
  const value = valueAt(row, ...keys)
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Invalid ${keys[0]}.`)
  return value.trim() || null
}

function integer(row: Record<string, unknown>, ...keys: string[]): number {
  const raw = valueAt(row, ...keys)
  const value =
    typeof raw === 'string' && /^-?\d+$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number'
        ? raw
        : Number.NaN
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${keys[0]}.`)
  return value
}

function nullableInteger(row: Record<string, unknown>, ...keys: string[]): number | null {
  const value = valueAt(row, ...keys)
  if (value === null || value === undefined || value === '') return null
  return integer(row, ...keys)
}

function boolean(row: Record<string, unknown>, ...keys: string[]): boolean {
  const value = valueAt(row, ...keys)
  if (typeof value !== 'boolean') throw new Error(`Invalid ${keys[0]}.`)
  return value
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error('Invalid enum value.')
  }
  return value as T
}

function rows(row: Record<string, unknown>, ...keys: string[]): unknown[] {
  const value = valueAt(row, ...keys)
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Invalid ${keys[0]} collection.`)
  return value
}

export function mapAdminAffiliate(value: unknown): AdminAffiliate {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    publicName: requiredString(row, 'public_name', 'publicName'),
    slug: requiredString(row, 'slug'),
    status: enumValue<AdminAffiliateStatus>(row.status, ADMIN_AFFILIATE_STATUSES),
    preferredCurrency: nullableString(row, 'preferred_currency', 'preferredCurrency'),
  }
}

export function mapAdminFunnel(value: unknown): AdminFunnel {
  const row = record(value)
  const destinationUrl = nullableString(row, 'destination_url', 'destinationUrl')
  const configuredValue = valueAt(row, 'destination_configured', 'destinationConfigured')
  const destinationConfigured =
    configuredValue === undefined
      ? destinationUrl !== null
      : boolean(row, 'destination_configured', 'destinationConfigured')
  return {
    id: requiredString(row, 'id'),
    productId: requiredString(row, 'product_id', 'productId'),
    key: requiredString(row, 'key'),
    name: requiredString(row, 'name'),
    destinationConfigured,
    destinationUrl,
    isDefault: boolean(row, 'is_default', 'isDefault'),
    status: enumValue<AdminFunnelStatus>(row.status, ADMIN_FUNNEL_STATUSES),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
  }
}

export function mapAdminSource(value: unknown): AdminSource {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    key: requiredString(row, 'key'),
    name: requiredString(row, 'name'),
    active: boolean(row, 'active'),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
  }
}

export function mapAdminCampaign(value: unknown): AdminCampaign {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    productId: requiredString(row, 'product_id', 'productId'),
    key: requiredString(row, 'key'),
    name: requiredString(row, 'name'),
    startsAt: nullableString(row, 'starts_at', 'startsAt'),
    endsAt: nullableString(row, 'ends_at', 'endsAt'),
    status: enumValue<AdminCampaignStatus>(row.status, ADMIN_CAMPAIGN_STATUSES),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
  }
}

export function mapAdminBillingOffer(value: unknown): AdminBillingOffer {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    productId: requiredString(row, 'product_id', 'productId'),
    key: requiredString(row, 'key'),
    version: integer(row, 'version'),
    name: requiredString(row, 'name'),
    billingMode: enumValue<AdminBillingMode>(
      valueAt(row, 'billing_mode', 'billingMode'),
      ADMIN_BILLING_MODES,
    ),
    stripePriceId: nullableString(row, 'stripe_price_id', 'stripePriceId'),
    currency: nullableString(row, 'currency'),
    unitAmountMinor: nullableInteger(row, 'unit_amount_minor', 'unitAmountMinor'),
    successUrlTemplate: nullableString(row, 'success_url_template', 'successUrlTemplate'),
    cancelUrl: nullableString(row, 'cancel_url', 'cancelUrl'),
    status: enumValue<AdminBillingOfferStatus>(row.status, ADMIN_BILLING_OFFER_STATUSES),
    stripePriceVerified: boolean(row, 'stripe_price_verified', 'stripePriceVerified'),
    stripeLivemodeVerifiedAt: nullableString(
      row,
      'stripe_livemode_verified_at',
      'stripeLivemodeVerifiedAt',
    ),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
  }
}

export function mapAdminCommissionRule(value: unknown): AdminCommissionRule {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    agreementId: requiredString(row, 'agreement_id', 'agreementId'),
    name: requiredString(row, 'name'),
    version: integer(row, 'version'),
    status: enumValue<AdminCommissionRuleStatus>(row.status, ADMIN_COMMISSION_RULE_STATUSES),
    model: enumValue<AdminCommissionModel>(row.model, ADMIN_COMMISSION_MODELS),
    triggerEvent: requiredString(row, 'trigger_event', 'triggerEvent'),
    fixedAmountMinor: nullableInteger(row, 'fixed_amount_minor', 'fixedAmountMinor'),
    rateBasisPoints: nullableInteger(row, 'rate_basis_points', 'rateBasisPoints'),
    currency: nullableString(row, 'currency'),
    validationWindowHours: integer(row, 'validation_window_hours', 'validationWindowHours'),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
  }
}

const ADMIN_AGREEMENT_DOCUMENT_STATUSES = [
  'awaiting_partner_signature',
  'awaiting_kissmyapps_signature',
  'signed',
] as const

const documentStatuses: readonly AdminDocumentStatus[] = ADMIN_DOCUMENT_STATUSES

function nullableDocument(
  row: Record<string, unknown>,
  ...keys: string[]
): AdminAgreementDocument | null {
  const value = valueAt(row, ...keys)
  if (value === null || value === undefined) return null
  const documentRow = record(value)
  const status = enumValue<AdminDocumentStatus>(documentRow.status, documentStatuses)
  if (!ADMIN_AGREEMENT_DOCUMENT_STATUSES.includes(status as 'signed')) {
    return null
  }
  return mapAgreementDocumentRow(documentRow, status)
}

function mapAgreementDocumentRow(
  row: Record<string, unknown>,
  status: AdminDocumentStatus,
): AdminAgreementDocument {
  return {
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    version: integer(row, 'version'),
    status,
    partnerSignerName: nullableString(row, 'partner_signer_name', 'partnerSignerName'),
    partnerSignedAt: nullableString(
      row,
      'signed_by_partner_at',
      'partner_signed_at',
      'partnerSignedAt',
    ),
    companySignedAt: nullableString(
      row,
      'signed_by_kissmyapps_at',
      'signed_by_kissmyapps_at',
      'companySignedAt',
    ),
    filePath: nullableString(row, 'file_path', 'filePath'),
    createdAt: nullableString(row, 'created_at', 'createdAt'),
  }
}

export function mapAdminAgreementDocument(value: unknown): AdminAgreementDocument {
  const row = record(value)
  return mapAgreementDocumentRow(row, enumValue<AdminDocumentStatus>(row.status, documentStatuses))
}

function mapAgreementWithRules(value: unknown, topLevelRules: readonly unknown[]): AdminAgreement {
  const row = record(value)
  const id = requiredString(row, 'id')
  const nestedRules = rows(row, 'commission_rules', 'commissionRules', 'rules')
  const applicableRules = nestedRules.length
    ? nestedRules
    : topLevelRules.filter((rule) => {
        try {
          return requiredString(record(rule), 'agreement_id', 'agreementId') === id
        } catch {
          return false
        }
      })
  return {
    id,
    affiliateId: requiredString(row, 'affiliate_id', 'affiliateId'),
    productId: requiredString(row, 'product_id', 'productId'),
    version: integer(row, 'version'),
    model: enumValue<AdminCommissionModel>(row.model, ADMIN_COMMISSION_MODELS),
    status: enumValue<AdminAgreementStatus>(row.status, ADMIN_AGREEMENT_STATUSES),
    attributionWindowDays: integer(row, 'attribution_window_days', 'attributionWindowDays'),
    renewalDurationDays: nullableInteger(row, 'renewal_duration_days', 'renewalDurationDays'),
    payoutFrequencyDays: integer(row, 'payout_frequency_days', 'payoutFrequencyDays'),
    payoutCurrency: requiredString(row, 'payout_currency', 'payoutCurrency'),
    minimumPayoutMinor: integer(row, 'minimum_payout_minor', 'minimumPayoutMinor'),
    startsAt: nullableString(row, 'starts_at', 'startsAt'),
    endsAt: nullableString(row, 'ends_at', 'endsAt'),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
    updatedAt: requiredString(row, 'updated_at', 'updatedAt'),
    commissionRules: applicableRules.map(mapAdminCommissionRule),
    partnerName: nullableString(row, 'partner_name', 'partnerName'),
    partnerSlug: nullableString(row, 'partner_slug', 'partnerSlug'),
    hasSignedDocument: boolean(row, 'has_signed_document', 'hasSignedDocument'),
    launchReady: boolean(row, 'launch_ready', 'launchReady'),
    document: nullableDocument(row, 'document'),
  }
}

export function mapAdminAgreement(value: unknown): AdminAgreement {
  return mapAgreementWithRules(value, [])
}

export function mapAdminMainLink(value: unknown, fallbackProductId?: string): AdminMainLink {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    affiliateId: requiredString(row, 'affiliate_id', 'affiliateId'),
    partnerName: nullableString(row, 'partner_name', 'partnerName'),
    productId:
      nullableString(row, 'product_id', 'productId') ??
      (fallbackProductId ||
        (() => {
          throw new Error('Invalid product_id.')
        })()),
    funnelId: requiredString(row, 'funnel_id', 'funnelId'),
    name: nullableString(row, 'name'),
    publicCode: nullableString(row, 'public_code', 'publicCode'),
    trackingUrl: requiredString(row, 'tracking_url', 'trackingUrl'),
    status: enumValue(row.status, linkStatuses),
    createdAt: requiredString(row, 'created_at', 'createdAt'),
  }
}

function configurationRoot(value: unknown): Record<string, unknown> {
  const single = singleAdminRow(value)
  const outer = record(single)
  const wrapped = valueAt(outer, 'get_admin_product_configuration')
  return wrapped === undefined ? outer : record(wrapped)
}

export function mapAdminProductConfiguration(value: unknown): AdminProductConfiguration {
  const row = configurationRoot(value)
  const topLevelRules = rows(row, 'commission_rules', 'commissionRules')
  const product = mapAdminProduct(valueAt(row, 'product'))
  const tracking = record(valueAt(row, 'tracking') ?? {})
  const readiness = record(valueAt(row, 'readiness') ?? {})
  return {
    product,
    tracking: {
      enabled: valueAt(tracking, 'enabled') === true,
      baseUrl:
        nullableString(tracking, 'base_url', 'baseUrl') ??
        nullableString(row, 'tracking_base_url', 'trackingBaseUrl'),
    },
    readiness: {
      hasLiveDefaultFunnel: boolean(readiness, 'has_live_default_funnel', 'hasLiveDefaultFunnel'),
      hasActiveAgreement: boolean(readiness, 'has_active_agreement', 'hasActiveAgreement'),
      hasActiveBillingOffer: boolean(
        readiness,
        'has_active_billing_offer',
        'hasActiveBillingOffer',
      ),
      trackingReady: boolean(readiness, 'tracking_ready', 'trackingReady'),
      trackingOnlyReady: boolean(readiness, 'tracking_only_ready', 'trackingOnlyReady'),
      trackingOnlyCanIssueLinks: boolean(
        readiness,
        'tracking_only_can_issue_links',
        'trackingOnlyCanIssueLinks',
      ),
    },
    funnels: rows(row, 'funnels').map(mapAdminFunnel),
    campaigns: rows(row, 'campaigns').map(mapAdminCampaign),
    agreements: rows(row, 'agreements').map((agreement) =>
      mapAgreementWithRules(agreement, topLevelRules),
    ),
    billingOffers: rows(row, 'billing_offers', 'billingOffers').map(mapAdminBillingOffer),
    mainLinks: rows(row, 'main_links', 'mainLinks').map((link) =>
      mapAdminMainLink(link, product.id),
    ),
  }
}
