import type { AdminBillingMode, AdminCommissionModel } from '../api'

export type ConfigurationFieldErrors = Readonly<Record<string, string>>

const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const eventPattern = /^[a-z][a-z0-9_.-]{0,99}$/

export function normalizeConfigurationKey(value: string): string {
  return value.trim().toLowerCase()
}

export function validateNameAndKey(name: string, key: string): ConfigurationFieldErrors {
  const errors: Record<string, string> = {}
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  const normalizedKey = normalizeConfigurationKey(key)
  if (!normalizedName) errors.name = 'Enter a name.'
  else if (normalizedName.length > 120) errors.name = 'Use 120 characters or fewer.'
  if (!normalizedKey) errors.key = 'Enter a key.'
  else if (normalizedKey.length > 120 || !keyPattern.test(normalizedKey)) {
    errors.key = 'Use lowercase letters, numbers, and single hyphens only.'
  }
  return errors
}

export function validateHttpsDestination(value: string): string | null {
  const destination = value.trim()
  if (!destination) return 'Enter the production HTTPS destination.'
  if (destination.length > 2000) return 'Use 2,000 characters or fewer.'
  try {
    const parsed = new URL(destination)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return 'Enter a complete HTTPS URL without embedded credentials.'
    }
  } catch {
    return 'Enter a complete HTTPS URL without embedded credentials.'
  }
  return null
}

export function validateProductionHttpsUrl(value: string): string | null {
  const baseError = validateHttpsDestination(value)
  if (baseError) return baseError
  const parsed = new URL(value.trim())
  const host = parsed.hostname.toLowerCase()
  if (
    /\.(?:test|invalid|example|localhost|local)$/.test(host) ||
    /(^|\.)example\.(?:com|net|org)$/.test(host) ||
    host === 'localhost'
  ) {
    return 'Use the real production HTTPS domain.'
  }
  if (parsed.hash) return 'Remove the URL fragment.'
  return null
}

export function validateOptionalProductionHttpsUrl(value: string): string | null {
  return value.trim() ? validateProductionHttpsUrl(value) : null
}

export function validateBillingOfferTerms({
  name,
  key,
  billingMode,
  stripePriceId,
  currency,
  unitAmountMinor,
  successUrlTemplate,
  cancelUrl,
}: {
  name: string
  key?: string
  billingMode: AdminBillingMode
  stripePriceId: string
  currency: string
  unitAmountMinor: string
  successUrlTemplate: string
  cancelUrl: string
}): ConfigurationFieldErrors {
  const errors: Record<string, string> = {}
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  if (!normalizedName) errors.name = 'Enter an offer name.'
  else if (normalizedName.length > 120) errors.name = 'Use 120 characters or fewer.'
  if (key !== undefined) {
    const keyErrors = validateNameAndKey(normalizedName, key)
    if (keyErrors.key) errors.key = keyErrors.key
  }
  if (!ADMIN_BILLING_MODE_VALUES.includes(billingMode)) {
    errors.billingMode = 'Choose a supported billing mode.'
  }
  if (stripePriceId.trim() && !/^price_[A-Za-z0-9_]{8,128}$/.test(stripePriceId.trim())) {
    errors.stripePriceId = 'Enter a valid Stripe Price ID.'
  }
  if (currency.trim() && !/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) {
    errors.currency = 'Use a three-letter currency code.'
  }
  if (unitAmountMinor.trim()) {
    const amount = positiveInteger(unitAmountMinor, 1, 99999999)
    if (amount === null) errors.unitAmountMinor = 'Use an integer from 1 to 99,999,999.'
  }
  if (successUrlTemplate.trim()) {
    const urlError = validateProductionHttpsUrl(successUrlTemplate)
    if (urlError) errors.successUrlTemplate = urlError
  }
  if (cancelUrl.trim()) {
    const urlError = validateProductionHttpsUrl(cancelUrl)
    if (urlError) errors.cancelUrl = urlError
  }
  return errors
}

const ADMIN_BILLING_MODE_VALUES: readonly AdminBillingMode[] = ['payment', 'subscription']

export function nullableIsoDate(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function validateCampaignDates(startsAt: string, endsAt: string): ConfigurationFieldErrors {
  const errors: Record<string, string> = {}
  const start = startsAt ? new Date(startsAt) : null
  const end = endsAt ? new Date(endsAt) : null
  if (start && Number.isNaN(start.getTime())) errors.startsAt = 'Enter a valid start date.'
  if (end && Number.isNaN(end.getTime())) errors.endsAt = 'Enter a valid end date.'
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    if (end <= start) errors.endsAt = 'The end date must be after the start date.'
  }
  return errors
}

export function positiveInteger(value: string, minimum = 1, maximum = 100000): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

export function moneyToMinor(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.trim())) return null
  const parsed = Number(value)
  const minor = Math.round(parsed * 100)
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null
}

export function percentageToBasisPoints(value: string): number | null {
  if (!/^(?:\d|\d{2}|100)(?:\.\d{1,2})?$/.test(value.trim())) return null
  const parsed = Number(value)
  const basisPoints = Math.round(parsed * 100)
  return parsed > 0 && parsed <= 100 && basisPoints <= 10000 ? basisPoints : null
}

export function validateCommissionValues({
  model,
  triggerEvent,
  fixedAmount,
  ratePercent,
  currency,
}: {
  model: AdminCommissionModel
  triggerEvent: string
  fixedAmount: string
  ratePercent: string
  currency: string
}): ConfigurationFieldErrors {
  const errors: Record<string, string> = {}
  if (!eventPattern.test(triggerEvent.trim())) {
    errors.triggerEvent = 'Use a lowercase event key such as purchase.completed.'
  }
  if (model === 'cpl' || model === 'cpa' || model === 'hybrid') {
    if (moneyToMinor(fixedAmount) === null || moneyToMinor(fixedAmount) === 0) {
      errors.fixedAmount = 'Enter a fixed amount greater than zero.'
    }
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) {
      errors.currency = 'Use a three-letter currency code.'
    }
  }
  if (model === 'revenue_share' || model === 'hybrid') {
    if (percentageToBasisPoints(ratePercent) === null) {
      errors.ratePercent = 'Enter a percentage greater than 0 and no more than 100.'
    }
  }
  return errors
}
