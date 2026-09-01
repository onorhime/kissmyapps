import { describe, expect, it } from 'vitest'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerProduct,
  type PartnerProfile,
} from '../api'
import { toPartnerLiveWorkspaceContext } from './adapters'
import { createPartnerLiveSnapshot } from './loader'

const product: PartnerProduct = {
  id: 'product-1',
  slug: 'first-product',
  name: 'First product',
  status: 'active',
  trackingMode: 'commercial',
  agreementStatus: 'active',
  commercialModel: 'revenue_share',
  payoutCurrency: 'USD',
  hasLiveFunnel: true,
  mainLinkId: 'main-link-1',
  mainTrackingUrl: 'https://go.example.test/r/first-product',
}

const profile: PartnerProfile = {
  email: 'partner@example.test',
  fullName: 'Partner Person',
  publicName: 'Partner Studio',
  legalName: 'Partner Studio Ltd',
  entityType: 'Company',
  countryCode: 'NG',
  timezone: 'Africa/Lagos',
  preferredCurrency: 'USD',
  website: null,
  category: null,
  audienceDescription: null,
  audienceCountries: [],
  channels: [],
  channelDetails: null,
  role: 'owner',
  status: 'active',
  notifications: {
    statements: true,
    payouts: true,
    verification: true,
    signatures: true,
    adjustments: true,
    inactiveLinks: true,
  },
}

describe('live partner UI adapters', () => {
  it('exposes only direct workspace context facts and a real funnel capability', () => {
    const snapshot = createPartnerLiveSnapshot(
      {
        profile: { data: profile, status: 'ready', error: null },
        products: { data: [product], status: 'ready', error: null },
        linkDirectory: {
          data: {
            products: [product],
            funnels: [
              {
                id: 'funnel-1',
                kind: 'funnel',
                productId: product.id,
                key: 'main',
                name: 'Main funnel',
                available: true,
              },
            ],
            sources: [],
            campaigns: [],
          },
          status: 'ready',
          error: null,
        },
        links: { data: [], status: 'empty', error: null },
        payoutSummary: { data: emptyPartnerPayoutSummary(), status: 'empty', error: null },
        payoutHistory: { data: [], status: 'empty', error: null },
        documents: { data: [], status: 'empty', error: null },
        agreements: { data: [], status: 'empty', error: null },
        dashboardSummary: {
          data: emptyPartnerDashboardSummary(),
          status: 'empty',
          error: null,
        },
        dashboardTrends: { data: [], status: 'empty', error: null },
      },
      product.id,
    )

    expect(toPartnerLiveWorkspaceContext(snapshot, product.id)).toEqual({
      partnerName: 'Partner Studio',
      partnerRole: 'owner',
      partnerStatus: 'active',
      products: [{ id: product.id, name: product.name, status: 'active' }],
      selectedProduct: product,
      commercialModel: 'revenue_share',
      payoutCurrency: 'USD',
      agreementStatus: 'active',
      mainTrackingUrl: product.mainTrackingUrl,
      canCreateLinks: true,
      availability: {
        profile: 'available',
        products: 'available',
        funnels: 'available',
        activity: 'none',
        emptyReason: 'no_activity',
      },
    })
  })

  it('does not manufacture a product, agreement, URL, or funnel in a zero-product state', () => {
    const snapshot = createPartnerLiveSnapshot(
      {
        profile: { data: profile, status: 'ready', error: null },
        products: { data: [], status: 'empty', error: null },
        linkDirectory: {
          data: { products: [], funnels: [], sources: [], campaigns: [] },
          status: 'empty',
          error: null,
        },
        links: { data: [], status: 'empty', error: null },
        payoutSummary: { data: emptyPartnerPayoutSummary(), status: 'empty', error: null },
        payoutHistory: { data: [], status: 'empty', error: null },
        documents: { data: [], status: 'empty', error: null },
        agreements: { data: [], status: 'empty', error: null },
        dashboardSummary: {
          data: emptyPartnerDashboardSummary(),
          status: 'empty',
          error: null,
        },
        dashboardTrends: { data: [], status: 'empty', error: null },
      },
      null,
    )

    expect(toPartnerLiveWorkspaceContext(snapshot, null)).toMatchObject({
      products: [],
      selectedProduct: null,
      commercialModel: null,
      payoutCurrency: null,
      agreementStatus: null,
      mainTrackingUrl: null,
      canCreateLinks: false,
      availability: { emptyReason: 'no_products' },
    })
  })
})
