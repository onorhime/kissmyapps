import { describe, expect, it, vi } from 'vitest'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataError,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerDashboardQuery,
  type PartnerProduct,
  type PartnerProfile,
  type PartnerTrendQuery,
} from '../api'
import { loadPartnerLiveWorkspace } from './loader'
import type { PartnerLiveReportingQuery } from './types'

const reporting: PartnerLiveReportingQuery = {
  startsOn: '2026-08-01',
  endsOn: '2026-08-27',
  timezone: 'Africa/Lagos',
  sourceId: null,
  campaignId: null,
  funnelId: null,
  countryCode: null,
  subId: null,
  grain: 'day',
  breakdown: 'date',
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

function result<T>(
  data: T,
  status: PartnerDataResult<T>['status'],
  error: PartnerDataError | null = null,
): PartnerDataResult<T> {
  return { data, status, error }
}

function gateway(overrides: Partial<PartnerDataGateway> = {}): PartnerDataGateway {
  return {
    getCurrentPartnerProfile: async () => result(profile, 'ready'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    getProducts: async () => result([], 'empty'),
    getLinkDirectory: async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    ...overrides,
  }
}

describe('live partner workspace loader', () => {
  it('loads account-wide documents even while reports are scoped to another product', async () => {
    const getDocuments = vi.fn(async () => result([], 'empty'))
    await loadPartnerLiveWorkspace(gateway({ getDocuments }), {
      productId: 'active-other-product',
      reporting,
    })
    expect(getDocuments).toHaveBeenCalledWith()
  })
  it('represents a configured partner with no product as a known ready-empty workspace', async () => {
    const snapshot = await loadPartnerLiveWorkspace(gateway(), {
      productId: null,
      reporting,
    })

    expect(snapshot.status).toBe('ready-empty')
    expect(snapshot.availability).toEqual({
      profile: 'available',
      products: 'none',
      funnels: 'none',
      activity: 'none',
      emptyReason: 'no_products',
    })
    expect(snapshot.resources.products.data).toEqual([])
    expect(snapshot.resources.dashboardSummary.data.metrics.earningsMinor).toBeNull()
  })

  it('keeps zero values separate from unavailable nullable metrics', async () => {
    const summary = emptyPartnerDashboardSummary()
    const snapshot = await loadPartnerLiveWorkspace(
      gateway({
        getProducts: async () => result([product], 'ready'),
        getLinkDirectory: async () =>
          result(
            {
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
            'ready',
          ),
        getDashboardSummary: async () =>
          result(
            {
              ...summary,
              hasData: true,
              metrics: { ...summary.metrics, clicks: 0, installs: null, earningsMinor: 0 },
            },
            'ready',
          ),
      }),
      { productId: product.id, reporting },
    )

    expect(snapshot.status).toBe('ready')
    expect(snapshot.availability).toMatchObject({
      products: 'available',
      funnels: 'available',
      activity: 'available',
      emptyReason: null,
    })
    expect(snapshot.resources.dashboardSummary.data.metrics).toMatchObject({
      clicks: 0,
      installs: null,
      earningsMinor: 0,
    })
  })

  it('uses the authenticated partner profile timezone for reporting RPCs', async () => {
    let summaryQuery: PartnerDashboardQuery | null = null
    let trendQuery: PartnerTrendQuery | null = null

    await loadPartnerLiveWorkspace(
      gateway({
        getDashboardSummary: async (query) => {
          summaryQuery = query
          return result(emptyPartnerDashboardSummary(), 'empty')
        },
        getDashboardTrends: async (query) => {
          trendQuery = query
          return result([], 'empty')
        },
      }),
      {
        productId: null,
        reporting: { ...reporting, timezone: 'UTC' },
      },
    )

    expect(summaryQuery).toMatchObject({ timezone: 'Africa/Lagos' })
    expect(trendQuery).toMatchObject({ timezone: 'Africa/Lagos' })
  })

  it('preserves successful resources when one endpoint is temporarily unavailable', async () => {
    const snapshot = await loadPartnerLiveWorkspace(
      gateway({
        getProducts: async () => result([product], 'ready'),
        getDashboardTrends: async () => {
          throw new Error('network details must not escape')
        },
      }),
      { productId: product.id, reporting },
    )

    expect(snapshot.status).toBe('partial')
    expect(snapshot.resources.products).toMatchObject({ status: 'ready', data: [product] })
    expect(snapshot.resources.dashboardTrends).toEqual({
      data: [],
      status: 'unavailable',
      error: {
        code: 'temporarily_unavailable',
        message: 'Partner data is temporarily unavailable.',
        retryable: true,
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('network details')
  })

  it('distinguishes fully unavailable, unconfigured, and non-retryable error states', async () => {
    const rejected = async () => {
      throw new Error('offline')
    }
    const unavailable = await loadPartnerLiveWorkspace(
      gateway({
        getCurrentPartnerProfile: rejected,
        getDashboardSummary: rejected,
        getDashboardTrends: rejected,
        getProducts: rejected,
        getLinkDirectory: rejected,
        getPartnerLinks: rejected,
        getPayoutSummary: rejected,
        getPayoutHistory: rejected,
        getDocuments: rejected,
        getAgreements: rejected,
      }),
      { productId: null, reporting },
    )
    expect(unavailable.status).toBe('unavailable')

    const connectionError: PartnerDataError = {
      code: 'not_configured',
      message: 'The partner data connection is not configured.',
      retryable: false,
    }
    const unconfiguredResult = async () => result([], 'unconfigured', connectionError)
    const unconfigured = await loadPartnerLiveWorkspace(
      gateway({
        getCurrentPartnerProfile: async () => result(null, 'unconfigured', connectionError),
        getDashboardSummary: async () =>
          result(emptyPartnerDashboardSummary(), 'unconfigured', connectionError),
        getDashboardTrends: unconfiguredResult,
        getProducts: unconfiguredResult,
        getLinkDirectory: async () =>
          result(
            { products: [], funnels: [], sources: [], campaigns: [] },
            'unconfigured',
            connectionError,
          ),
        getPartnerLinks: unconfiguredResult,
        getPayoutSummary: async () =>
          result(emptyPartnerPayoutSummary(), 'unconfigured', connectionError),
        getPayoutHistory: unconfiguredResult,
        getDocuments: unconfiguredResult,
        getAgreements: unconfiguredResult,
      }),
      { productId: null, reporting },
    )
    expect(unconfigured.status).toBe('unconfigured')

    const authorizationError: PartnerDataError = {
      code: 'not_authorized',
      message: 'This partner account cannot access that data.',
      retryable: false,
    }
    const forbiddenResult = async () => result([], 'error', authorizationError)
    const forbidden = await loadPartnerLiveWorkspace(
      gateway({
        getCurrentPartnerProfile: async () => result(null, 'error', authorizationError),
        getDashboardSummary: async () =>
          result(emptyPartnerDashboardSummary(), 'error', authorizationError),
        getDashboardTrends: forbiddenResult,
        getProducts: forbiddenResult,
        getLinkDirectory: async () =>
          result(
            { products: [], funnels: [], sources: [], campaigns: [] },
            'error',
            authorizationError,
          ),
        getPartnerLinks: forbiddenResult,
        getPayoutSummary: async () =>
          result(emptyPartnerPayoutSummary(), 'error', authorizationError),
        getPayoutHistory: forbiddenResult,
        getDocuments: forbiddenResult,
        getAgreements: forbiddenResult,
      }),
      { productId: null, reporting },
    )
    expect(forbidden.status).toBe('error')
  })
})
