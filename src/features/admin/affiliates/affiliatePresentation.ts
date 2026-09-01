import type {
  AdminAffiliateActivationStatus,
  AdminAffiliateEmailConfirmationStatus,
  AdminAffiliateRegistrationKind,
  AdminAffiliateStatus,
} from '../api'

const affiliateStatusLabels: Record<AdminAffiliateStatus, string> = {
  draft: 'Draft',
  invited: 'Invited',
  active: 'Active',
  paused: 'Paused',
  terminated: 'Terminated',
}

const confirmationLabels: Record<AdminAffiliateEmailConfirmationStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Awaiting confirmation',
  unknown: 'Unavailable',
}

const activationLabels: Record<AdminAffiliateActivationStatus, string> = {
  active: 'Active',
  pending: 'Pending activation',
  disabled: 'Disabled',
  missing: 'No account',
}

const registrationLabels: Record<AdminAffiliateRegistrationKind, string> = {
  public: 'Public registration',
  invited: 'Admin invitation',
  legacy: 'Legacy account',
}

export function affiliateStatusLabel(status: AdminAffiliateStatus): string {
  return affiliateStatusLabels[status]
}

export function confirmationStatusLabel(status: AdminAffiliateEmailConfirmationStatus): string {
  return confirmationLabels[status]
}

export function activationStatusLabel(status: AdminAffiliateActivationStatus): string {
  return activationLabels[status]
}

export function registrationKindLabel(kind: AdminAffiliateRegistrationKind): string {
  return registrationLabels[kind]
}

export function formatAdminTimestamp(value: string | null): string {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)} UTC`
}

export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

export function affiliateInitial(publicName: string): string {
  return publicName.trim().slice(0, 1).toUpperCase() || 'A'
}
