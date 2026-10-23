// Audit-only synthetic gateway. No network, credentials, or live writes.
import type {
  AdminConfigurationGateway,
  AdminContext,
  AdminDataResult,
  AdminGateway,
  AdminProductConfiguration,
} from '../../src/features/admin/api'

export const owner: AdminContext = {
  userId: 'ui-audit-owner',
  email: 'audit@example.test',
  fullName: 'UI Audit Owner',
  role: 'owner',
  active: true,
}
const timestamp = '2026-09-05T00:00:00.000Z'
export const configuration: AdminProductConfiguration = {
  product: {
    id: 'ui-audit-product',
    name: 'Synthetic UI audit',
    slug: 'ui-audit',
    status: 'active',
    trackingMode: 'commercial',
    trackingOnlyApprovedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
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
  mainLinks: [],
  billingOffers: [
    {
      id: 'ui-audit-offer',
      productId: 'ui-audit-product',
      name: 'Audit monthly offer',
      key: 'monthly',
      version: 1,
      billingMode: 'subscription',
      stripePriceId: 'price_audit123456',
      currency: 'USD',
      unitAmountMinor: 100,
      status: 'draft',
      stripePriceVerified: true,
      stripeLivemodeVerifiedAt: timestamp,
      // References only: the fixture never navigates to these or creates checkout sessions.
      successUrlTemplate: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.kissmyapps.dev/checkout',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
}

export function ready<T>(data: T): AdminDataResult<T> {
  return { status: 'ready', data, error: null }
}
export const unavailable = () => ({
  status: 'error' as const,
  data: null,
  error: {
    code: 'temporarily_unavailable' as const,
    message: 'Synthetic refresh failure.',
    retryable: true,
  },
})

export function auditGateway(readDelayMs = 0): AdminGateway & AdminConfigurationGateway {
  let snapshot = structuredClone(configuration)
  const methods: Record<string, unknown> = {
    getAdminContext: async () => ready(owner),
    getProducts: async () => ready([snapshot.product]),
    getProductConfiguration: async () => {
      if (readDelayMs) await new Promise((resolve) => setTimeout(resolve, readDelayMs))
      return ready(snapshot)
    },
    getAffiliates: async () => ready([]),
    getSources: async () => ready([]),
    createFunnel: async (input: Record<string, unknown>) => {
      const funnel = {
        id: 'ui-audit-funnel',
        productId: snapshot.product.id,
        name: String(input.name),
        key: String(input.key),
        destinationUrl: String(input.destinationUrl),
        destinationConfigured: Boolean(input.destinationUrl),
        isDefault: Boolean(input.isDefault),
        status: 'draft' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      snapshot = { ...snapshot, funnels: [...snapshot.funnels, funnel] }
      return ready(funnel)
    },
    setBillingOfferStatus: async (input: { status: 'active' | 'paused' | 'archived' }) => {
      const offer = { ...snapshot.billingOffers[0], status: input.status }
      snapshot = { ...snapshot, billingOffers: [offer] }
      return ready(offer)
    },
  }
  // Unsupported actions fail locally instead of falling through to a real gateway.
  return new Proxy(methods, {
    get: (target, key) => target[String(key)] ?? (async () => unavailable()),
  }) as unknown as AdminGateway & AdminConfigurationGateway
}
