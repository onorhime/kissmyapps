import { describe, expect, it } from 'vitest'
import { mapAdminProgramProducts } from '../api/programProducts'
import { NO_PROGRAM_PRODUCTS, programProductsById } from './programProducts'
import {
  lingoLoopProductId,
  programProductsResponse,
  speakSixProductId,
} from './programProducts.fixture'

describe('program products', () => {
  it('finds the program of a product by the product id', () => {
    const programs = programProductsById(mapAdminProgramProducts(programProductsResponse()))

    expect([...programs.keys()]).toEqual([lingoLoopProductId, speakSixProductId])
    expect(programs.get(speakSixProductId)).toMatchObject({
      programName: 'SpeakSix',
      programStatus: 'live',
    })
    expect(programs.has('33333333-3333-4333-8333-333333333333')).toBe(false)
  })

  it('has no program product when the answer has none', () => {
    expect(programProductsById([]).size).toBe(0)
    expect(NO_PROGRAM_PRODUCTS.size).toBe(0)
  })
})
