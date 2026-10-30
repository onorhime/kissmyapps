import { describe, expect, it } from 'vitest'
import type { AdminProductConfiguration } from '../api'
import { initialSetupStep, setupProgress, setupSteps, stepForBlocker } from './setupSteps'

const configuration: AdminProductConfiguration = {
  product: {
    id: 'product-1',
    name: 'Daily Planner',
    slug: 'daily-planner',
    status: 'draft',
    trackingMode: 'commercial',
    trackingOnlyApprovedAt: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
  },
  tracking: { enabled: false, baseUrl: null },
  readiness: {
    hasLiveDefaultFunnel: false,
    hasActiveAgreement: false,
    hasActiveBillingOffer: false,
    trackingReady: false,
    trackingOnlyReady: false,
    trackingOnlyCanIssueLinks: false,
  },
  funnels: [],
  campaigns: [],
  agreements: [],
  billingOffers: [],
  mainLinks: [],
}

describe('product setup steps', () => {
  it('orders the commercial journey and keeps settings unnumbered', () => {
    const steps = setupSteps(configuration)
    expect(steps.map((step) => [step.id, step.number])).toEqual([
      ['funnel', 1],
      ['sources', 2],
      ['payments', 3],
      ['agreement', 4],
      ['launch', 5],
      ['settings', null],
    ])
    expect(setupProgress(steps)).toEqual({ complete: 0, total: 4 })
    expect(initialSetupStep(steps)).toBe('funnel')
  })

  it('replaces payments and agreements with Owner approval for tracking-only products', () => {
    const steps = setupSteps({
      ...configuration,
      product: { ...configuration.product, trackingMode: 'tracking_only' },
      readiness: { ...configuration.readiness, hasLiveDefaultFunnel: true },
    })
    expect(steps.map((step) => step.id)).toEqual([
      'funnel',
      'sources',
      'approval',
      'launch',
      'settings',
    ])
    expect(initialSetupStep(steps)).toBe('approval')
  })

  it('treats sources as optional and opens Go live once required steps are done', () => {
    const steps = setupSteps({
      ...configuration,
      product: { ...configuration.product, status: 'active', trackingMode: 'tracking_only' },
      readiness: {
        ...configuration.readiness,
        hasLiveDefaultFunnel: true,
        trackingOnlyReady: true,
      },
      mainLinks: [
        {
          id: 'link-1',
          affiliateId: 'affiliate-1',
          partnerName: 'Creator',
          productId: 'product-1',
          funnelId: 'funnel-1',
          name: null,
          publicCode: null,
          trackingUrl: 'https://go.example.test/r/creator/code',
          status: 'active',
          createdAt: '2026-08-28T10:00:00.000Z',
        },
      ],
    })
    expect(steps.find((step) => step.id === 'sources')?.state).toBe('optional')
    expect(setupProgress(steps)).toEqual({ complete: 3, total: 3 })
    expect(initialSetupStep(steps)).toBe('launch')
  })

  it('maps launch blockers to the step that fixes them', () => {
    expect(stepForBlocker('default_funnel_not_live')).toBe('funnel')
    expect(stepForBlocker('active_billing_offer_missing')).toBe('payments')
    expect(stepForBlocker('launch_ready_agreement_missing')).toBe('agreement')
    expect(stepForBlocker('tracking_only_approval_required')).toBe('approval')
    expect(stepForBlocker('tracking_not_configured')).toBeNull()
  })
})
