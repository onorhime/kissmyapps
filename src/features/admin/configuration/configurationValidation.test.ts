import { describe, expect, it } from 'vitest'
import {
  moneyToMinor,
  percentageToBasisPoints,
  validateCampaignDates,
  validateCommissionValues,
  validateBillingOfferTerms,
  validateHttpsDestination,
  validateOptionalProductionHttpsUrl,
  validateProductionHttpsUrl,
} from './configurationValidation'

describe('admin configuration validation', () => {
  it('accepts only credential-free HTTPS production destinations', () => {
    expect(validateHttpsDestination('https://example.test/checkout')).toBeNull()
    expect(validateHttpsDestination('http://example.test')).toMatch(/HTTPS/)
    expect(validateHttpsDestination('https://user:secret@example.test')).toMatch(/credentials/)
  })

  it('rejects reversed campaign ranges', () => {
    expect(validateCampaignDates('2026-09-02T10:00', '2026-09-01T10:00')).toEqual({
      endsAt: 'The end date must be after the start date.',
    })
  })

  it('converts human money and percentages to exact minor units', () => {
    expect(moneyToMinor('19.99')).toBe(1999)
    expect(percentageToBasisPoints('12.5')).toBe(1250)
    expect(percentageToBasisPoints('0')).toBeNull()
  })

  it('enforces the values required by each commission model', () => {
    expect(
      validateCommissionValues({
        model: 'cpa',
        triggerEvent: 'purchase.completed',
        fixedAmount: '',
        ratePercent: '',
        currency: 'USD',
      }),
    ).toHaveProperty('fixedAmount')
    expect(
      validateCommissionValues({
        model: 'revenue_share',
        triggerEvent: 'purchase.completed',
        fixedAmount: '',
        ratePercent: '15',
        currency: '',
      }),
    ).toEqual({})
  })

  it('rejects reserved billing hosts and accepts incomplete draft terms', () => {
    expect(validateProductionHttpsUrl('https://checkout.example.test/success')).toMatch(
      /production/,
    )
    expect(validateProductionHttpsUrl('https://checkout.kissmyapps.dev/success')).toBeNull()
    expect(
      validateBillingOfferTerms({
        name: 'One-time launch',
        key: 'launch',
        billingMode: 'payment',
        stripePriceId: '',
        currency: '',
        unitAmountMinor: '',
        successUrlTemplate: '',
        cancelUrl: '',
      }),
    ).toEqual({})
  })

  it('allows a funnel draft without a destination but rejects non-production destinations', () => {
    expect(validateOptionalProductionHttpsUrl('')).toBeNull()
    expect(validateOptionalProductionHttpsUrl('https://checkout.kissmyapps.dev/start')).toBeNull()
    expect(validateOptionalProductionHttpsUrl('http://localhost:3000/start')).toMatch(/HTTPS/)
    expect(validateOptionalProductionHttpsUrl('https://checkout.example.test/start')).toMatch(
      /production/,
    )
  })
})
