import { singleAdminRow } from './mappers'
import { ADMIN_TRACKING_ORIGIN, type AdminPlatformSettings } from './types'

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

function settingsRoot(value: unknown): Record<string, unknown> {
  const outer = record(singleAdminRow(value), 'settings response')
  for (const functionName of ['get_admin_platform_settings', 'configure_admin_tracking']) {
    if (Object.hasOwn(outer, functionName)) {
      return record(outer[functionName], functionName)
    }
  }
  return outer
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
  return value
}

function nonNegativeInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${key}.`)
  }
  return value
}

function nullableTimestamp(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Invalid ${key}.`)
  }
  return value
}

function httpsOrigin(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`Invalid ${key}.`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid ${key}.`)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(`Invalid ${key}.`)
  }
  return value
}

function nullableHttpsOrigin(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return value === null ? null : httpsOrigin(value, key)
}

export function mapAdminPlatformSettings(value: unknown): AdminPlatformSettings {
  const row = settingsRoot(value)
  const tracking = record(row.tracking, 'tracking')
  const readiness = record(row.readiness, 'readiness')
  const expectedHosts = record(row.expected_hosts, 'expected_hosts')

  const baseUrl = nullableHttpsOrigin(tracking, 'base_url')
  const trackingHost = httpsOrigin(expectedHosts.tracking, 'tracking')
  if (
    (baseUrl !== null && baseUrl !== ADMIN_TRACKING_ORIGIN) ||
    trackingHost !== ADMIN_TRACKING_ORIGIN
  ) {
    throw new Error('Invalid canonical tracking origin.')
  }

  return {
    tracking: {
      baseUrl,
      enabled: boolean(tracking, 'enabled'),
      updatedAt: nullableTimestamp(tracking, 'updated_at'),
    },
    readiness: {
      canEnable: boolean(readiness, 'can_enable'),
      activeProductCount: nonNegativeInteger(readiness, 'active_product_count'),
      liveDefaultFunnelCount: nonNegativeInteger(readiness, 'live_default_funnel_count'),
      launchReadyAgreementCount: nonNegativeInteger(readiness, 'launch_ready_agreement_count'),
      verifiedActiveOfferCount: nonNegativeInteger(readiness, 'verified_active_offer_count'),
      enableReadyProductCount: nonNegativeInteger(readiness, 'enable_ready_product_count'),
    },
    expectedHosts: {
      partner: httpsOrigin(expectedHosts.partner, 'partner'),
      admin: httpsOrigin(expectedHosts.admin, 'admin'),
      tracking: trackingHost,
    },
  }
}
