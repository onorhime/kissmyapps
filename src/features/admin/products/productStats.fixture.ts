// Synthetic records for ProductStatsPage tests. No real partner or customer data.
import type {
  AdminAttributionOverview,
  AdminContext,
  AdminDataResult,
  AdminGateway,
  AdminProductConfiguration,
} from '../api'
import type { AdminSubscriptionPage } from '../api/subscriptions'

export const statsOwner: AdminContext = {
  userId: 'admin-1',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

export const statsConfiguration: AdminProductConfiguration = {
  product: {
    id: 'product-1',
    name: 'Daily Planner',
    slug: 'daily-planner',
    status: 'active',
    trackingMode: 'commercial',
    trackingOnlyApprovedAt: null,
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
  },
  tracking: { enabled: true, baseUrl: 'https://go.example.test' },
  readiness: {
    hasLiveDefaultFunnel: true,
    hasActiveAgreement: false,
    hasActiveBillingOffer: false,
    trackingReady: true,
    trackingOnlyReady: false,
    trackingOnlyCanIssueLinks: false,
  },
  funnels: [],
  campaigns: [],
  agreements: [],
  billingOffers: [],
  mainLinks: [
    {
      id: 'link-1',
      affiliateId: 'affiliate-1',
      partnerName: 'Creator Studio',
      productId: 'product-1',
      funnelId: 'funnel-1',
      name: null,
      publicCode: null,
      trackingUrl: 'https://go.example.test/r/creator-studio/code',
      environment: 'live',
      status: 'active',
      createdAt: '2026-08-28T10:00:00.000Z',
    },
  ],
}

export const statsOverview: AdminAttributionOverview = {
  generatedAt: '2026-10-20T12:00:00.000Z',
  window: { startsAt: '2026-09-20T12:00:00.000Z', endsAt: '2026-10-20T12:00:00.000Z' },
  filters: { productId: 'product-1', sourceId: null },
  readiness: {
    trackingEnabled: true,
    baseUrlConfigured: true,
    activeProductCount: 1,
    liveFunnelCount: 1,
    activeLinkCount: 1,
    lastClickAt: '2026-10-20T11:40:00.000Z',
    lastEventAt: '2026-10-20T11:42:00.000Z',
    lastConversionAt: '2026-10-19T08:10:00.000Z',
  },
  summary: {
    clicks: 1340,
    botClicks: 140,
    acquisitions: 420,
    resolvedAcquisitions: 380,
    rejectedAcquisitions: 40,
    events: 910,
    trustedEvents: 902,
    commercialEligibleEvents: 61,
    qualifiedConversions: 54,
  },
  breakdown: [
    {
      productId: 'product-1',
      productName: 'Daily Planner',
      sourceId: 'source-1',
      sourceName: 'TikTok',
      clicks: 820,
      acquisitions: 250,
      qualifiedConversions: 30,
    },
    {
      productId: 'product-1',
      productName: 'Daily Planner',
      sourceId: 'source-2',
      sourceName: 'Instagram',
      clicks: 380,
      acquisitions: 110,
      qualifiedConversions: 20,
    },
    {
      productId: 'product-1',
      productName: 'Daily Planner',
      sourceId: null,
      sourceName: 'No source',
      clicks: 140,
      acquisitions: 20,
      qualifiedConversions: 4,
    },
  ],
  eventTypes: [
    {
      eventName: 'signup.completed',
      eventCount: 610,
      commercialEligibleCount: 0,
      lastOccurredAt: '2026-10-20T11:42:00.000Z',
    },
    {
      eventName: 'purchase.completed',
      eventCount: 61,
      commercialEligibleCount: 61,
      lastOccurredAt: '2026-10-19T08:10:00.000Z',
    },
  ],
  recentAcquisitions: {
    items: [
      {
        productName: 'Daily Planner',
        partnerName: 'Creator Studio',
        sourceName: 'TikTok',
        campaignName: 'Autumn launch',
        funnelName: 'Checkout',
        attributionMethod: 'deterministic_web',
        status: 'resolved',
        clickCountry: 'US',
        installCountry: null,
        createdAt: '2026-10-20T11:40:00.000Z',
        resolvedAt: '2026-10-20T11:41:00.000Z',
      },
    ],
    totalCount: 1,
  },
  sources: [
    { id: 'source-1', name: 'TikTok' },
    { id: 'source-2', name: 'Instagram' },
  ],
}

export const statsSubscriptions: AdminSubscriptionPage = {
  generatedAt: '2026-10-20T12:00:00.000Z',
  stripeWorkPending: false,
  total: 48,
  summary: { active: 41, trialing: 3, paymentAttention: 2, cancelled: 2 },
  items: [],
}

export function ready<T>(data: T): AdminDataResult<T> {
  return { data, status: 'ready', error: null }
}

export function statsGateway(delay = 0): AdminGateway {
  const wait = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delay))
  return {
    getAdminContext: async () => ready(statsOwner),
    getProducts: async () => ready([statsConfiguration.product]),
    createProduct: async () => ready(null),
    getProductConfiguration: async () => wait(ready(statsConfiguration)),
    getAttributionOverview: async () => wait(ready(statsOverview)),
    getDataHealth: async () => ready(null),
    getSubscriptions: async () => wait(ready(statsSubscriptions)),
  }
}
