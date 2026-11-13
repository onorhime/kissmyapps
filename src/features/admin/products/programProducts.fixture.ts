/**
 * The answer of `get_admin_program_products`, written by hand to the shape the function
 * returns, for tests and local previews. Not production data.
 */
import type { AdminProgramProduct } from '../api'
import { programProductsById, type ProgramProducts } from './programProducts'

export const speakSixProductId = '11111111-1111-4111-8111-111111111111'
export const lingoLoopProductId = '22222222-2222-4222-8222-222222222222'

export function programProductsResponse() {
  return {
    products: [
      {
        product_id: lingoLoopProductId,
        program_id: 'a1b2c3d4-0000-4000-8000-000000000003',
        program_name: 'Lingo Loop',
        program_slug: 'lingo-loop',
        program_status: 'paused',
      },
      {
        product_id: speakSixProductId,
        program_id: 'a1b2c3d4-0000-4000-8000-000000000002',
        program_name: 'SpeakSix',
        program_slug: 'speaksix',
        program_status: 'live',
      },
    ],
  }
}

/** A program entry for a product of a component test. */
export function programProductEntry(
  productId: string,
  programName = 'SpeakSix',
): AdminProgramProduct {
  return {
    productId,
    programId: `program-of-${productId}`,
    programName,
    programSlug: 'speaksix',
    programStatus: 'live',
  }
}

export function programProductsOf(...productIds: string[]): ProgramProducts {
  return programProductsById(productIds.map((productId) => programProductEntry(productId)))
}
