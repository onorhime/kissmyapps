import type { AdminProduct } from '../api'

/**
 * The ids of the products that belong to a merchant's program. A program creates its own
 * product and landing page when its first listing is approved, so such a product is never
 * set up through the product setup wizard: only a custom deal is.
 *
 * Every admin screen asks this set and nothing else, so where the answer comes from is
 * decided here alone. It is read from `program_id` on the rows of `get_admin_products`.
 */
export type ProgramProducts = ReadonlySet<string>

export const NO_PROGRAM_PRODUCTS: ProgramProducts = new Set<string>()

export function programProductIds(products: readonly AdminProduct[]): ProgramProducts {
  return new Set(products.filter((product) => product.programId).map((product) => product.id))
}
