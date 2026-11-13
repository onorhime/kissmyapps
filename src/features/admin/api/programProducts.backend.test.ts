import { describe, expect, it } from 'vitest'
import { linksBackendFixture as backend } from '../../../merchant/links-backend.fixture'
import { programProductsById } from '../products/programProducts'
import { mapAdminProgramProducts } from './programProducts'

// The admin reader of which products belong to a program, against the real database answer.
describe('admin program products and the real backend answer', () => {
  it('reads one entry per program that has a product', () => {
    const products = mapAdminProgramProducts(backend.get_admin_program_products_listed)
    expect(products.map((product) => product.programName)).toEqual([
      'Quiet Club',
      'Rival Reader',
      'SpeakSix',
    ])
    for (const product of products) {
      expect(product.productId).toMatch(/^[0-9a-f-]{36}$/)
      expect(product.programId).toMatch(/^[0-9a-f-]{36}$/)
      expect(product.productId).not.toBe(product.programId)
      expect(['live', 'paused']).toContain(product.programStatus)
    }
    const byProduct = programProductsById(products)
    expect(byProduct.size).toBe(3)
    expect(byProduct.get(products[2].productId)?.programSlug).toBe('speaksix')
  })
})
