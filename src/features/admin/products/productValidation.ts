import type { AdminProductCreate } from '../api'

export type ProductDraftField = 'name' | 'slug'
export type ProductDraftErrors = Partial<Record<ProductDraftField, string>>

const productSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function slugifyProductName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')
}

export function normalizeProductDraft(name: string, slug: string): AdminProductCreate {
  return {
    name: name.trim().replace(/\s+/g, ' '),
    slug: slug.trim().toLowerCase(),
  }
}

export function validateProductDraft(name: string, slug: string): ProductDraftErrors {
  const normalized = normalizeProductDraft(name, slug)
  const errors: ProductDraftErrors = {}

  if (!normalized.name) errors.name = 'Enter a product name.'
  else if (normalized.name.length > 120) errors.name = 'Use 120 characters or fewer.'

  if (!normalized.slug) errors.slug = 'Enter a product slug.'
  else if (normalized.slug.length > 120) errors.slug = 'Use 120 characters or fewer.'
  else if (!productSlugPattern.test(normalized.slug)) {
    errors.slug = 'Use lowercase letters, numbers, and single hyphens only.'
  }

  return errors
}
