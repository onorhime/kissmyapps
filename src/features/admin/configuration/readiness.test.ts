import { describe, expect, it } from 'vitest'
import type {
  AdminAffiliate,
  AdminAgreement,
  AdminBillingOffer,
  AdminProductConfiguration,
} from '../api'
import { mainLinkReadiness, productActivationReadiness } from './readiness'

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

const affiliate: AdminAffiliate = {
  id: 'affiliate-1',
  publicName: 'Creator Studio',
  slug: 'creator-studio',
  status: 'active',
  preferredCurrency: null,
}

const activeOffer: AdminBillingOffer = {
  id: 'offer-1',
  productId: configuration.product.id,
  key: 'monthly',
  version: 1,
  name: 'Monthly subscription',
  billingMode: 'subscription',
  stripePriceId: 'price_abcdefgh1234',
  currency: 'USD',
  unitAmountMinor: 1999,
  successUrlTemplate: 'https://app.example.test/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.example.test/checkout',
  status: 'active',
  stripePriceVerified: true,
  stripeLivemodeVerifiedAt: configuration.product.updatedAt,
  createdAt: configuration.product.createdAt,
  updatedAt: configuration.product.updatedAt,
}

const launchReadyAgreement: AdminAgreement = {
  id: 'agreement-1',
  affiliateId: affiliate.id,
  productId: configuration.product.id,
  version: 1,
  model: 'cpa',
  status: 'active',
  attributionWindowDays: 30,
  renewalDurationDays: null,
  payoutFrequencyDays: 14,
  payoutCurrency: 'USD',
  minimumPayoutMinor: 10000,
  startsAt: configuration.product.createdAt,
  endsAt: null,
  createdAt: configuration.product.createdAt,
  updatedAt: configuration.product.updatedAt,
  commissionRules: [
    {
      id: 'rule-1',
      agreementId: 'agreement-1',
      name: 'Paid purchase',
      version: 1,
      status: 'active',
      model: 'cpa',
      triggerEvent: 'purchase.completed',
      fixedAmountMinor: 2500,
      rateBasisPoints: null,
      currency: 'USD',
      validationWindowHours: 72,
      createdAt: configuration.product.createdAt,
      updatedAt: configuration.product.updatedAt,
    },
  ],
  partnerName: affiliate.publicName,
  partnerSlug: affiliate.slug,
  hasSignedDocument: true,
  launchReady: true,
  document: null,
}

const launchReadyConfiguration: AdminProductConfiguration = {
  ...configuration,
  product: { ...configuration.product, status: 'active' },
  tracking: { enabled: true, baseUrl: 'https://go.example.test' },
  readiness: {
    hasLiveDefaultFunnel: true,
    hasActiveAgreement: true,
    hasActiveBillingOffer: true,
    trackingReady: true,
    trackingOnlyReady: false,
    trackingOnlyCanIssueLinks: false,
  },
  agreements: [launchReadyAgreement],
  billingOffers: [activeOffer],
}

describe('admin production readiness', () => {
  it('keeps product activation independent from partner agreements and the tracking kill switch', () => {
    expect(
      productActivationReadiness({
        ...configuration,
        tracking: { enabled: false, baseUrl: 'https://go.example.test' },
        readiness: {
          ...configuration.readiness,
          trackingReady: false,
          hasLiveDefaultFunnel: true,
        },
      }),
    ).toEqual({ allowed: true, blockers: [] })
  })

  it('reports truthful zero-data blockers', () => {
    expect(productActivationReadiness(configuration)).toEqual({
      allowed: false,
      blockers: ['tracking_not_configured', 'default_funnel_missing'],
    })
    expect(mainLinkReadiness(configuration, [affiliate])).toMatchObject({
      allowed: false,
      eligibleAffiliateIds: [],
      blockers: expect.arrayContaining([
        'product_not_active',
        'active_agreement_missing',
        'active_billing_offer_missing',
        'eligible_partner_missing',
      ]),
    })
  })

  it('allows only a live-verified subscription and launch-ready signed agreement', () => {
    expect(mainLinkReadiness(launchReadyConfiguration, [affiliate])).toEqual({
      allowed: true,
      blockers: [],
      eligibleAffiliateIds: [affiliate.id],
    })
  })

  it('fails closed when the active billing offer is not live-verified', () => {
    const readiness = mainLinkReadiness(
      {
        ...launchReadyConfiguration,
        billingOffers: [{ ...activeOffer, stripeLivemodeVerifiedAt: null }],
      },
      [affiliate],
    )

    expect(readiness.allowed).toBe(false)
    expect(readiness.blockers).toContain('active_billing_offer_missing')
  })

  it('does not treat an unsigned or multi-rule agreement as launch-ready', () => {
    const secondRule = {
      ...launchReadyAgreement.commissionRules[0],
      id: 'rule-2',
      name: 'Second paid purchase rule',
    }
    const readiness = mainLinkReadiness(
      {
        ...launchReadyConfiguration,
        agreements: [
          {
            ...launchReadyAgreement,
            hasSignedDocument: false,
            commissionRules: [...launchReadyAgreement.commissionRules, secondRule],
          },
        ],
      },
      [affiliate],
    )

    expect(readiness.allowed).toBe(false)
    expect(readiness.eligibleAffiliateIds).toEqual([])
    expect(readiness.blockers).toEqual(
      expect.arrayContaining(['launch_ready_agreement_missing', 'eligible_partner_missing']),
    )
  })

  it('requires the only active rule to use the agreement payout currency', () => {
    const readiness = mainLinkReadiness(
      {
        ...launchReadyConfiguration,
        agreements: [
          {
            ...launchReadyAgreement,
            commissionRules: launchReadyAgreement.commissionRules.map((rule) => ({
              ...rule,
              currency: 'EUR',
            })),
          },
        ],
      },
      [affiliate],
    )

    expect(readiness.allowed).toBe(false)
    expect(readiness.eligibleAffiliateIds).toEqual([])
    expect(readiness.blockers).toContain('launch_ready_agreement_missing')
  })

  it('allows an active partner through the server-approved tracking-only link gate', () => {
    const trackingOnly: AdminProductConfiguration = {
      ...configuration,
      product: {
        ...configuration.product,
        status: 'active',
        trackingMode: 'tracking_only',
        trackingOnlyApprovedAt: configuration.product.updatedAt,
      },
      tracking: { enabled: true, baseUrl: 'https://go.kissmyapps.dev' },
      readiness: {
        ...configuration.readiness,
        hasLiveDefaultFunnel: true,
        trackingOnlyReady: true,
        trackingOnlyCanIssueLinks: true,
      },
    }

    expect(mainLinkReadiness(trackingOnly, [affiliate])).toEqual({
      allowed: true,
      blockers: [],
      eligibleAffiliateIds: [affiliate.id],
    })
  })

  it('fails closed when the approved tracking-only funnel snapshot is stale', () => {
    const trackingOnly: AdminProductConfiguration = {
      ...configuration,
      product: {
        ...configuration.product,
        status: 'active',
        trackingMode: 'tracking_only',
        trackingOnlyApprovedAt: configuration.product.updatedAt,
      },
      tracking: { enabled: true, baseUrl: 'https://go.kissmyapps.dev' },
      readiness: {
        ...configuration.readiness,
        hasLiveDefaultFunnel: true,
        trackingOnlyReady: false,
        trackingOnlyCanIssueLinks: false,
      },
    }

    expect(mainLinkReadiness(trackingOnly, [affiliate]).blockers).toContain(
      'tracking_only_approval_required',
    )
  })

  it('does not let an archived demo main link block a new current link', () => {
    const commercialWithArchivedDemoLink: AdminProductConfiguration = {
      ...launchReadyConfiguration,
      mainLinks: [
        {
          id: 'archived-demo-main-link',
          affiliateId: affiliate.id,
          partnerName: affiliate.publicName,
          productId: configuration.product.id,
          funnelId: 'funnel-1',
          name: 'Archived demo main link',
          publicCode: null,
          trackingUrl: 'https://go.kissmyapps.dev/r/creator-studio/archived',
          status: 'archived',
          createdAt: configuration.product.createdAt,
        },
      ],
    }

    expect(mainLinkReadiness(commercialWithArchivedDemoLink, [affiliate])).toEqual({
      allowed: true,
      blockers: [],
      eligibleAffiliateIds: [affiliate.id],
    })
  })
})
