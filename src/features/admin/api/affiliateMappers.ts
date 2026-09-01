import {
  ADMIN_AFFILIATE_ACTIVATION_STATUSES,
  ADMIN_AFFILIATE_EMAIL_CONFIRMATION_STATUSES,
  ADMIN_AFFILIATE_REGISTRATION_KINDS,
  ADMIN_AFFILIATE_STATUSES,
  type AdminAffiliateActivationStatus,
  type AdminAffiliateDirectoryPage,
  type AdminAffiliateDirectoryRecord,
  type AdminAffiliateDirectorySummary,
  type AdminAffiliateEmailConfirmationStatus,
  type AdminAffiliateRegistrationKind,
  type AdminAffiliateStatus,
  type AdminAffiliateStatusChange,
} from './types'

const entityTypes = ['individual', 'company'] as const
const affiliateUserRoles = ['owner', 'finance', 'analyst', 'member'] as const
const changedStatuses = ['active', 'paused', 'terminated'] as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an affiliate-management object.')
  }
  return value as Record<string, unknown>
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}.`)
  return value
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Invalid ${key}.`)
  return value.trim() || null
}

function timestamp(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key)
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${key}.`)
  return value
}

function nullableTimestamp(row: Record<string, unknown>, key: string): string | null {
  const value = nullableString(row, key)
  if (value !== null && Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${key}.`)
  return value
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
  return value
}

function nullableBoolean(row: Record<string, unknown>, key: string): boolean | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
  return value
}

function nonNegativeInteger(row: Record<string, unknown>, key: string): number {
  const raw = row[key]
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number'
        ? raw
        : Number.NaN
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}.`)
  return value
}

function stringArray(row: Record<string, unknown>, key: string): string[] {
  const value = row[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Invalid ${key}.`)
  }
  return value as string[]
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${key}.`)
  }
  return value as T
}

function nullableEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | null {
  if (value === null || value === undefined) return null
  return enumValue(value, allowed, key)
}

export function mapAdminAffiliateDirectoryRecord(value: unknown): AdminAffiliateDirectoryRecord {
  const row = record(value)
  const mapped: AdminAffiliateDirectoryRecord = {
    id: requiredString(row, 'id'),
    publicName: requiredString(row, 'public_name'),
    legalName: nullableString(row, 'legal_name'),
    slug: requiredString(row, 'slug'),
    status: enumValue<AdminAffiliateStatus>(row.status, ADMIN_AFFILIATE_STATUSES, 'status'),
    entityType: nullableEnumValue(row.entity_type, entityTypes, 'entity_type'),
    countryCode: nullableString(row, 'country_code'),
    reportingTimezone: requiredString(row, 'reporting_timezone'),
    preferredCurrency: requiredString(row, 'preferred_currency'),
    websiteUrl: nullableString(row, 'website_url'),
    category: nullableString(row, 'category'),
    audienceDescription: nullableString(row, 'audience_description'),
    audienceCountries: stringArray(row, 'audience_countries'),
    channels: stringArray(row, 'channels'),
    channelDetails: nullableString(row, 'channel_details'),
    primaryUserId: nullableString(row, 'primary_user_id'),
    primaryUserRole: nullableEnumValue(
      row.primary_user_role,
      affiliateUserRoles,
      'primary_user_role',
    ),
    primaryFullName: nullableString(row, 'primary_full_name'),
    primaryEmail: nullableString(row, 'primary_email'),
    registrationKind: enumValue<AdminAffiliateRegistrationKind>(
      row.registration_kind,
      ADMIN_AFFILIATE_REGISTRATION_KINDS,
      'registration_kind',
    ),
    registeredAt: timestamp(row, 'registered_at'),
    emailConfirmationStatus: enumValue<AdminAffiliateEmailConfirmationStatus>(
      row.email_confirmation_status,
      ADMIN_AFFILIATE_EMAIL_CONFIRMATION_STATUSES,
      'email_confirmation_status',
    ),
    emailConfirmedAt: nullableTimestamp(row, 'email_confirmed_at'),
    activationStatus: enumValue<AdminAffiliateActivationStatus>(
      row.activation_status,
      ADMIN_AFFILIATE_ACTIVATION_STATUSES,
      'activation_status',
    ),
    membershipActive: boolean(row, 'membership_active'),
    activationPending: boolean(row, 'activation_pending'),
    activatedAt: nullableTimestamp(row, 'activated_at'),
    memberCount: nonNegativeInteger(row, 'member_count'),
    activeMemberCount: nonNegativeInteger(row, 'active_member_count'),
    termsVersion: nullableString(row, 'terms_version'),
    termsUrl: nullableString(row, 'terms_url'),
    privacyVersion: nullableString(row, 'privacy_version'),
    privacyUrl: nullableString(row, 'privacy_url'),
    ageConfirmed: nullableBoolean(row, 'age_confirmed'),
    legalAcceptedAt: nullableTimestamp(row, 'legal_accepted_at'),
    productCount: nonNegativeInteger(row, 'product_count'),
    agreementCount: nonNegativeInteger(row, 'agreement_count'),
    activeAgreementCount: nonNegativeInteger(row, 'active_agreement_count'),
    blockingAgreementCount: nonNegativeInteger(row, 'blocking_agreement_count'),
    blockingDocumentCount: nonNegativeInteger(row, 'blocking_document_count'),
    linkCount: nonNegativeInteger(row, 'link_count'),
    activeLinkCount: nonNegativeInteger(row, 'active_link_count'),
    unsettledPayoutCount: nonNegativeInteger(row, 'unsettled_payout_count'),
    createdAt: timestamp(row, 'created_at'),
    updatedAt: timestamp(row, 'updated_at'),
  }

  if (
    mapped.activeMemberCount > mapped.memberCount ||
    mapped.activeAgreementCount > mapped.agreementCount ||
    mapped.activeAgreementCount > mapped.blockingAgreementCount ||
    mapped.blockingAgreementCount > mapped.agreementCount ||
    mapped.activeLinkCount > mapped.linkCount
  ) {
    throw new Error('Invalid affiliate directory counts.')
  }

  if (
    (mapped.emailConfirmationStatus === 'confirmed') !== (mapped.emailConfirmedAt !== null) ||
    (mapped.activationStatus === 'active' &&
      (!mapped.membershipActive || mapped.activationPending || mapped.activatedAt === null)) ||
    (mapped.activationStatus === 'pending' &&
      (mapped.membershipActive || !mapped.activationPending || mapped.activatedAt !== null))
  ) {
    throw new Error('Invalid affiliate lifecycle state.')
  }

  const legalValues = [
    mapped.termsVersion,
    mapped.termsUrl,
    mapped.privacyVersion,
    mapped.privacyUrl,
    mapped.ageConfirmed,
    mapped.legalAcceptedAt,
  ]
  const hasLegalEvidence = legalValues.every((entry) => entry !== null)
  if (
    (!hasLegalEvidence && legalValues.some((entry) => entry !== null)) ||
    (mapped.registrationKind === 'public' && (!hasLegalEvidence || mapped.ageConfirmed !== true)) ||
    (mapped.registrationKind !== 'public' && hasLegalEvidence)
  ) {
    throw new Error('Invalid affiliate legal-acceptance state.')
  }

  return mapped
}

export function mapAdminAffiliateDirectoryPage(value: unknown): AdminAffiliateDirectoryPage {
  const row = record(value)
  if (!Array.isArray(row.items)) throw new Error('Invalid items.')
  const items = row.items.map(mapAdminAffiliateDirectoryRecord)
  const totalCount = nonNegativeInteger(row, 'total_count')
  if (totalCount < items.length) throw new Error('Invalid total_count.')
  return { items, totalCount }
}

export function mapAdminAffiliateDirectorySummary(value: unknown): AdminAffiliateDirectorySummary {
  const row = record(value)
  const summary = {
    totalCount: nonNegativeInteger(row, 'total_count'),
    draftCount: nonNegativeInteger(row, 'draft_count'),
    invitedCount: nonNegativeInteger(row, 'invited_count'),
    activeCount: nonNegativeInteger(row, 'active_count'),
    pausedCount: nonNegativeInteger(row, 'paused_count'),
    terminatedCount: nonNegativeInteger(row, 'terminated_count'),
    pendingConfirmationCount: nonNegativeInteger(row, 'pending_confirmation_count'),
    pendingActivationCount: nonNegativeInteger(row, 'pending_activation_count'),
  }
  if (
    summary.draftCount +
      summary.invitedCount +
      summary.activeCount +
      summary.pausedCount +
      summary.terminatedCount !==
      summary.totalCount ||
    summary.pendingConfirmationCount > summary.totalCount ||
    summary.pendingActivationCount > summary.totalCount
  ) {
    throw new Error('Invalid affiliate summary totals.')
  }
  return summary
}

export function mapAdminAffiliateStatusChange(value: unknown): AdminAffiliateStatusChange {
  const row = record(value)
  return {
    id: requiredString(row, 'id'),
    status: enumValue(row.status, changedStatuses, 'status'),
    updatedAt: timestamp(row, 'updated_at'),
  }
}
