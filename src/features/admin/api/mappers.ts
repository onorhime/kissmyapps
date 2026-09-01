import {
  ADMIN_PRODUCT_STATUSES,
  ADMIN_PRODUCT_TRACKING_MODES,
  ADMIN_ROLES,
  type AdminContext,
  type AdminProduct,
  type AdminProductStatus,
  type AdminProductTrackingMode,
  type AdminRole,
} from './types'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object row.')
  }
  return value as Record<string, unknown>
}

function string(row: Record<string, unknown>, key: string): string {
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

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
  return value
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error('Invalid enum value.')
  }
  return value as T
}

export function singleAdminRow(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.length !== 1) throw new Error('Expected one row.')
    return value[0]
  }
  return value ?? null
}

export function mapAdminContext(value: unknown): AdminContext {
  const row = object(value)
  return {
    userId: string(row, 'user_id'),
    email: string(row, 'email'),
    fullName: nullableString(row, 'full_name'),
    role: enumValue<AdminRole>(row.role, ADMIN_ROLES),
    active: boolean(row, 'active'),
  }
}

export function mapAdminProduct(value: unknown): AdminProduct {
  const row = object(value)
  const rawTrackingMode = row.tracking_mode ?? row.trackingMode ?? 'commercial'
  return {
    id: string(row, 'id'),
    name: string(row, 'name'),
    slug: string(row, 'slug'),
    status: enumValue<AdminProductStatus>(row.status, ADMIN_PRODUCT_STATUSES),
    trackingMode: enumValue<AdminProductTrackingMode>(
      rawTrackingMode,
      ADMIN_PRODUCT_TRACKING_MODES,
    ),
    trackingOnlyApprovedAt: nullableString(
      row,
      Object.hasOwn(row, 'tracking_only_approved_at')
        ? 'tracking_only_approved_at'
        : 'trackingOnlyApprovedAt',
    ),
    createdAt: string(row, 'created_at'),
    updatedAt: string(row, 'updated_at'),
  }
}

export function mapAdminRows<T>(value: unknown, mapper: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Expected a row collection.')
  return value.map(mapper)
}
