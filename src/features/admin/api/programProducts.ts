/**
 * Which products belong to a merchant's program, as `get_admin_program_products` returns
 * them: one entry per program that has a product. A program makes its own product when its
 * first listing is approved, so the admin never sets such a product up.
 */
import { ADMIN_PROGRAM_STATUSES, type AdminProgramStatus } from './programs'

export type AdminProgramProduct = Readonly<{
  productId: string
  programId: string
  /** The program's name, or its marketplace address when it has no name. */
  programName: string
  programSlug: string
  programStatus: AdminProgramStatus
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.')
  }
  return value as Record<string, unknown>
}

function matching(row: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = row[key]
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${key}.`)
  return value
}

function mapAdminProgramProduct(value: unknown): AdminProgramProduct {
  const row = record(value)
  const programSlug = matching(row, 'program_slug', SLUG)
  // Only an archived program can be without a name; anything but text or null is not a name.
  const name = row.program_name
  if (name !== null && typeof name !== 'string') throw new Error('Invalid program_name.')
  const programStatus = ADMIN_PROGRAM_STATUSES.find((status) => status === row.program_status)
  if (!programStatus) throw new Error('Invalid program_status.')
  return {
    productId: matching(row, 'product_id', UUID),
    programId: matching(row, 'program_id', UUID),
    programName: name?.trim() || programSlug,
    programSlug,
    programStatus,
  }
}

/** `{"products": [...]}`. Anything else is refused whole: a partly read list marks wrongly. */
export function mapAdminProgramProducts(value: unknown): AdminProgramProduct[] {
  const products = record(value).products
  if (!Array.isArray(products)) throw new Error('Expected a list of products.')
  const mapped = products.map(mapAdminProgramProduct)
  if (new Set(mapped.map((entry) => entry.productId)).size !== mapped.length) {
    throw new Error('A product belongs to one program.')
  }
  return mapped
}
