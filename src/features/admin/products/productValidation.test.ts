import { describe, expect, it } from 'vitest'
import {
  normalizeProductDraft,
  slugifyProductName,
  validateProductDraft,
} from './productValidation'

describe('admin product draft validation', () => {
  it('creates a stable lowercase slug from names and accents', () => {
    expect(slugifyProductName('  Café Goals: 30 Days!  ')).toBe('cafe-goals-30-days')
  })

  it('normalizes product whitespace without inventing funnel or status fields', () => {
    const draft = normalizeProductDraft('  Daily   Planner  ', '  DAILY-PLANNER  ')

    expect(draft).toEqual({ name: 'Daily Planner', slug: 'daily-planner' })
    expect(Object.keys(draft)).toEqual(['name', 'slug'])
  })

  it('requires both fields and accepts only URL-safe single-hyphen slugs', () => {
    expect(validateProductDraft('', '')).toEqual({
      name: 'Enter a product name.',
      slug: 'Enter a product slug.',
    })
    expect(validateProductDraft('Daily Planner', 'Daily planner')).toEqual({
      slug: 'Use lowercase letters, numbers, and single hyphens only.',
    })
    expect(validateProductDraft('Daily Planner', 'daily--planner')).toEqual({
      slug: 'Use lowercase letters, numbers, and single hyphens only.',
    })
    expect(validateProductDraft('Daily Planner', 'daily-planner')).toEqual({})
  })

  it('enforces the 120-character contract after normalization', () => {
    expect(validateProductDraft('x'.repeat(121), 'daily-planner')).toEqual({
      name: 'Use 120 characters or fewer.',
    })
    expect(validateProductDraft('Daily Planner', 'x'.repeat(121))).toEqual({
      slug: 'Use 120 characters or fewer.',
    })
  })
})
