import { describe, expect, it } from 'vitest'
import type {
  AdminAffiliate,
  AdminAgreement,
  AdminBillingOffer,
  AdminProductConfiguration,
} from '../api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { LaunchSection } from './LaunchSection'
import type { AdminConfigurationGateway } from '../api'
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
      refundCutoffDays: null,
      commissionBasisPolicy: 'net_after_fees',
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

const mainLink = {
  id: 'main-1',
  affiliateId: affiliate.id,
  partnerName: affiliate.publicName,
  productId: configuration.product.id,
  funnelId: 'funnel-1',
  name: 'Main link',
  publicCode: null,
  trackingUrl: 'https://go.example.test/r/partner/code',
  status: 'active' as const,
  createdAt: configuration.product.createdAt,
}
function show(value: AdminProductConfiguration, partners: readonly AdminAffiliate[] = [affiliate]) {
  render(
    <LaunchSection
      configuration={value}
      affiliates={partners}
      gateway={{} as AdminConfigurationGateway}
      canManage
      pendingKey={null}
      runAction={vi.fn()}
    />,
  )
}
describe('launch completion presentation', () => {
  it('shows already-active and issued steps complete without allowing duplicate actions', () => {
    const value = { ...launchReadyConfiguration, mainLinks: [mainLink] }
    show(value)
    expect(screen.getByText('Product activation is complete').closest('li')).toHaveClass(
      'admin-check-passed',
    )
    expect(
      screen.getByText('All eligible partners already have an active main link').closest('li'),
    ).toHaveClass('admin-check-passed')
    expect(screen.getByText(/Main-link issuance is complete/)).toBeVisible()
    expect(
      screen.queryByText('Choose an active partner that does not already have a main link.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activate product' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Issue main link' })).toBeDisabled()
    expect(productActivationReadiness(value).allowed).toBe(false)
    expect(mainLinkReadiness(value, [affiliate]).allowed).toBe(false)
  })
  it('does not mask a disabled tracking gateway after issuance', () => {
    show({
      ...launchReadyConfiguration,
      tracking: { ...launchReadyConfiguration.tracking, enabled: false },
      readiness: { ...launchReadyConfiguration.readiness, trackingReady: false },
      mainLinks: [mainLink],
    })
    expect(screen.getByText('Enable production tracking.')).toBeVisible()
    expect(screen.queryByText(/Main-link issuance is complete/)).not.toBeInTheDocument()
  })
  it('does not call a paused or archived link complete', () => {
    show({ ...launchReadyConfiguration, mainLinks: [{ ...mainLink, status: 'paused' }] })
    expect(
      screen.queryByText('All eligible partners already have an active main link'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('An active partner with a launch-ready agreement is eligible').closest('li'),
    ).toHaveClass('admin-check-blocked')
  })
  it('does not mask revoked agreement readiness with an old active link', () => {
    show({
      ...launchReadyConfiguration,
      agreements: [{ ...launchReadyAgreement, launchReady: false }],
      mainLinks: [mainLink],
    })
    expect(screen.queryByText(/Main-link issuance is complete/)).not.toBeInTheDocument()
    expect(
      screen.getByText('An active partner with a launch-ready agreement is eligible').closest('li'),
    ).toHaveClass('admin-check-blocked')
  })
  it('does not call issuance complete when another eligible partner only has a paused link', () => {
    const other = { ...affiliate, id: 'affiliate-2', publicName: 'Other partner' }
    show(
      {
        ...launchReadyConfiguration,
        agreements: [
          launchReadyAgreement,
          { ...launchReadyAgreement, id: 'agreement-2', affiliateId: other.id },
        ],
        mainLinks: [
          mainLink,
          { ...mainLink, id: 'main-2', affiliateId: other.id, status: 'paused' },
        ],
      },
      [affiliate, other],
    )
    expect(screen.queryByText(/Main-link issuance is complete/)).not.toBeInTheDocument()
    expect(
      screen.queryByText('All eligible partners already have an active main link'),
    ).not.toBeInTheDocument()
  })
})

describe('one-time offer main-link issuance', () => {
  const oneTime: AdminProductConfiguration = {
    ...launchReadyConfiguration,
    readiness: { ...launchReadyConfiguration.readiness, managedPaymentCheckoutEnabled: true },
    billingOffers: [
      {
        ...activeOffer,
        billingMode: 'payment',
        stripePriceVerified: false,
        stripeLivemodeVerifiedAt: null,
        mainLinkReady: true,
        managedPriceVerifications: [
          {
            configuredPriceId: activeOffer.stripePriceId!,
            accountId: 'acct_MarathonMerchant',
            livemode: true,
            stripePriceId: 'price_MarathonMerchant',
            currency: activeOffer.currency!,
            unitAmountMinor: activeOffer.unitAmountMinor!,
            offerVersion: activeOffer.version,
            verifiedAt: activeOffer.updatedAt,
          },
        ],
      },
    ],
  }

  it('issues the normal creator link only after the admin confirms', async () => {
    const user = userEvent.setup()
    const issueMainLink = vi.fn(async () => ({
      status: 'ready' as const,
      data: mainLink,
      error: null,
    }))
    render(
      <LaunchSection
        configuration={oneTime}
        affiliates={[affiliate]}
        gateway={{ issueMainLink } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Eligible partner' }),
      affiliate.id,
    )
    await user.click(screen.getByRole('button', { name: 'Issue main link' }))
    expect(issueMainLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm link issuance' }))
    expect(issueMainLink).toHaveBeenCalledExactlyOnceWith({
      productId: oneTime.product.id,
      affiliateId: affiliate.id,
      environment: 'live',
    })
  })

  it('blocks a server-rejected one-time offer even with a live price proof', () => {
    show({ ...oneTime, billingOffers: [{ ...oneTime.billingOffers[0], mainLinkReady: false }] })
    expect(screen.getByRole('combobox', { name: 'Eligible partner' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue main link' })).toBeDisabled()
  })

  it('does not grant link-creation permission to a read-only admin', () => {
    render(
      <LaunchSection
        configuration={oneTime}
        affiliates={[affiliate]}
        gateway={{} as AdminConfigurationGateway}
        canManage={false}
        pendingKey={null}
        runAction={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Eligible partner' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue main link' })).toBeDisabled()
  })
})

describe('TEST creator links', () => {
  const testConfiguration: AdminProductConfiguration = {
    ...launchReadyConfiguration,
    readiness: {
      ...launchReadyConfiguration.readiness,
      hasActiveBillingOffer: false,
      hasActiveTestBillingOffer: true,
      trackingReady: false,
      testTrackingReady: true,
    },
    billingOffers: [
      {
        ...activeOffer,
        billingMode: 'payment',
        stripePriceVerified: false,
        stripeLivemodeVerifiedAt: null,
        mainLinkReady: false,
        mainLinkTestReady: true,
        managedPriceVerifications: [
          {
            configuredPriceId: activeOffer.stripePriceId!,
            accountId: 'acct_TestMerchant',
            livemode: false,
            stripePriceId: 'price_TestMerchant',
            currency: activeOffer.currency!,
            unitAmountMinor: activeOffer.unitAmountMinor!,
            offerVersion: activeOffer.version,
            verifiedAt: activeOffer.updatedAt,
          },
        ],
      },
    ],
  }

  it('issues an explicitly selected TEST link while the LIVE offer remains unavailable', async () => {
    const user = userEvent.setup()
    const issueMainLink = vi.fn(async () => ({
      status: 'ready' as const,
      data: { ...mainLink, environment: 'test' as const },
      error: null,
    }))
    render(
      <LaunchSection
        configuration={testConfiguration}
        affiliates={[affiliate]}
        gateway={{ issueMainLink } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    expect(screen.getByRole('button', { name: 'Issue main link' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Link environment' }), 'test')
    expect(screen.getByText(/Issuing a link does not enable checkout or payouts/)).toBeVisible()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Eligible partner' }),
      affiliate.id,
    )
    await user.click(screen.getByRole('button', { name: 'Issue main link' }))
    expect(issueMainLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm link issuance' }))
    expect(issueMainLink).toHaveBeenCalledExactlyOnceWith({
      affiliateId: affiliate.id,
      productId: testConfiguration.product.id,
      environment: 'test',
    })
  })

  it('keeps eligibility separate for the same creator in TEST and LIVE', () => {
    const withLiveLink = { ...testConfiguration, mainLinks: [mainLink] }
    expect(mainLinkReadiness(withLiveLink, [affiliate], 'test').allowed).toBe(true)
    const withTestLink = {
      ...launchReadyConfiguration,
      mainLinks: [{ ...mainLink, environment: 'test' as const }],
    }
    expect(mainLinkReadiness(withTestLink, [affiliate], 'live').allowed).toBe(true)
    expect(
      mainLinkReadiness(
        { ...testConfiguration, mainLinks: withTestLink.mainLinks },
        [affiliate],
        'test',
      ).allowed,
    ).toBe(false)
  })

  it.each([
    ['server offer rejection', { ...testConfiguration.billingOffers[0], mainLinkTestReady: false }],
    ['a stale price proof', { ...testConfiguration.billingOffers[0], version: 2 }],
    [
      'only a live proof',
      {
        ...testConfiguration.billingOffers[0],
        managedPriceVerifications:
          testConfiguration.billingOffers[0].managedPriceVerifications!.map((proof) => ({
            ...proof,
            livemode: true,
          })),
      },
    ],
  ])('blocks TEST issuance for %s', (_label, offer) => {
    expect(
      mainLinkReadiness({ ...testConfiguration, billingOffers: [offer] }, [affiliate], 'test')
        .blockers,
    ).toContain('active_test_billing_offer_missing')
  })

  it('preserves agreement and tracking requirements for TEST links', () => {
    const blocked = mainLinkReadiness(
      {
        ...testConfiguration,
        readiness: { ...testConfiguration.readiness, trackingReady: false },
        tracking: { ...testConfiguration.tracking, enabled: false },
        agreements: [{ ...launchReadyAgreement, hasSignedDocument: false }],
      },
      [affiliate],
      'test',
    )
    expect(blocked.allowed).toBe(false)
    expect(blocked.blockers).toContain('tracking_disabled')
    expect(blocked.blockers).toContain('launch_ready_agreement_missing')
  })
})
