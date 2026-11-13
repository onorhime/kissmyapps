import { describe, expect, it } from 'vitest'
import { mapAdminProduct } from '../api/mappers'
import { NO_PROGRAM_PRODUCTS, programProductIds } from './programProducts'

/** A row of `get_admin_products`, with the column this reader waits for when it is given. */
function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: `slug-${id}`,
    name: `Product ${id}`,
    status: 'active',
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:00.000Z',
    tracking_mode: 'commercial',
    tracking_only_approved_at: null,
    ...extra,
  }
}

describe('program products', () => {
  it('reads the program a product belongs to from its row', () => {
    const product = mapAdminProduct(row('one', { program_id: 'program-1' }))
    expect(product.programId).toBe('program-1')
    expect(programProductIds([product])).toEqual(new Set(['one']))
  })

  it('reads a row without the column, or with null, exactly as before', () => {
    const today = mapAdminProduct(row('one'))
    const customDeal = mapAdminProduct(row('two', { program_id: null }))
    expect(Object.keys(today)).not.toContain('programId')
    expect(Object.keys(customDeal)).not.toContain('programId')
    expect(programProductIds([today, customDeal])).toEqual(NO_PROGRAM_PRODUCTS)
  })

  it('keeps only the products of programs', () => {
    const products = [
      mapAdminProduct(row('one', { program_id: 'program-1' })),
      mapAdminProduct(row('two')),
      mapAdminProduct(row('three', { program_id: 'program-3' })),
    ]
    expect([...programProductIds(products)]).toEqual(['one', 'three'])
  })

  it('refuses a program id that is not text', () => {
    expect(() => mapAdminProduct(row('one', { program_id: 7 }))).toThrow('Invalid program_id.')
    expect(() => mapAdminProduct(row('one', { program_id: true }))).toThrow('Invalid program_id.')
  })
})
