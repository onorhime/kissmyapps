export interface PaywallOffer {
  key: string
  version: number
  name: string
  currency: string
  unit_amount_minor: number
  billing_mode: 'subscription'
  interval: 'day' | 'week' | 'month' | 'year'
  interval_count: number
}
export function isPaywallOffer(value: unknown): value is PaywallOffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).length === 8 &&
    typeof item.key === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.key) &&
    Number.isSafeInteger(item.version) &&
    Number(item.version) >= 1 &&
    Number(item.version) <= 999999999 &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    item.name.length <= 120 &&
    typeof item.currency === 'string' &&
    /^[A-Z]{3}$/.test(item.currency) &&
    Number.isSafeInteger(item.unit_amount_minor) &&
    Number(item.unit_amount_minor) > 0 &&
    Number(item.unit_amount_minor) <= 99999999 &&
    item.billing_mode === 'subscription' &&
    ['day', 'week', 'month', 'year'].includes(String(item.interval)) &&
    Number.isSafeInteger(item.interval_count) &&
    Number(item.interval_count) >= 1 &&
    Number(item.interval_count) <= 365
  )
}
