import type { AdminProgramProduct } from '../api'

/**
 * The products that belong to a merchant's program, by product id. A program creates its
 * own product and landing page when its first listing is approved, so such a product is
 * never set up through the product setup wizard: only a custom deal is.
 *
 * Every admin screen asks this and nothing else. It is built from the answer of
 * `get_admin_program_products`, which the workspace reads together with the products.
 */
export type ProgramProducts = ReadonlyMap<string, AdminProgramProduct>

export const NO_PROGRAM_PRODUCTS: ProgramProducts = new Map<string, AdminProgramProduct>()

export function programProductsById(entries: readonly AdminProgramProduct[]): ProgramProducts {
  return new Map(entries.map((entry) => [entry.productId, entry]))
}
