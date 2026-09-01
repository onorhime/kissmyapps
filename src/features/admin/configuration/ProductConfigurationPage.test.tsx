import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminConfigurationGateway,
  AdminContext,
  AdminDataResult,
  AdminGateway,
  AdminProduct,
  AdminProductConfiguration,
} from '../api'
import { ProductConfigurationPage } from './ProductConfigurationPage'

const owner: AdminContext = {
  userId: 'admin-1',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const product: AdminProduct = {
  id: 'product-1',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'draft',
  trackingMode: 'commercial',
  trackingOnlyApprovedAt: null,
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
}

const emptyConfiguration: AdminProductConfiguration = {
  product,
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

function ready<T>(data: T): AdminDataResult<T> {
  return { data, status: 'ready', error: null }
}

function fakeGateway(configuration = emptyConfiguration) {
  const unavailable = async () => ({
    data: null,
    status: 'error' as const,
    error: {
      code: 'invalid_state' as const,
      message: 'This action is not available in the current state.',
      retryable: false,
    },
  })
  return {
    getAdminContext: vi.fn(async () => ready(owner)),
    getProducts: vi.fn(async () => ready([configuration.product])),
    createProduct: vi.fn(unavailable),
    getProductConfiguration: vi.fn(async () => ready(configuration)),
    getAffiliates: vi.fn(async () => ready([])),
    getSources: vi.fn(async () => ready([])),
    createFunnel: vi.fn(unavailable),
    updateFunnel: vi.fn(unavailable),
    setFunnelStatus: vi.fn(unavailable),
    createSource: vi.fn(unavailable),
    createCampaign: vi.fn(unavailable),
    setCampaignStatus: vi.fn(unavailable),
    createAgreement: vi.fn(unavailable),
    createCommissionRule: vi.fn(unavailable),
    setCommissionRuleStatus: vi.fn(unavailable),
    activateAgreement: vi.fn(unavailable),
    activateProduct: vi.fn(unavailable),
    setProductTrackingMode: vi.fn(unavailable),
    issueMainLink: vi.fn(unavailable),
    createBillingOffer: vi.fn(unavailable),
    updateBillingOffer: vi.fn(unavailable),
    setBillingOfferStatus: vi.fn(unavailable),
    verifyBillingOfferPrice: vi.fn(unavailable),
  } as unknown as AdminGateway & AdminConfigurationGateway
}

describe('Product configuration page', () => {
  it('renders truthful zero-data sections with no accessibility violations', async () => {
    const gateway = fakeGateway()
    const { container } = render(
      <ProductConfigurationPage
        productId="product-1"
        context={owner}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Daily Planner', level: 1 })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No funnels configured' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No partner agreements' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No billing offers configured' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No main links issued' })).toBeVisible()
    expect(screen.queryByText(/\.invalid/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review product activation' })).toBeDisabled()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('masks raw destinations for read-only roles', async () => {
    const destination = 'https://secret.example.test/production-checkout'
    const gateway = fakeGateway({
      ...emptyConfiguration,
      funnels: [
        {
          id: 'funnel-1',
          productId: 'product-1',
          key: 'checkout',
          name: 'Checkout',
          destinationConfigured: true,
          destinationUrl: null,
          isDefault: true,
          status: 'live',
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
        },
      ],
    })
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={{ ...owner, role: 'analyst' }}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )

    await screen.findByRole('heading', { name: 'Daily Planner', level: 1 })
    expect(screen.queryByText(destination)).not.toBeInTheDocument()
    expect(screen.getByText('HTTPS destination configured')).toBeVisible()
    expect(screen.getByText(/destinations remain masked/i)).toBeVisible()
  })

  it('confirms product activation and calls the server once', async () => {
    const user = userEvent.setup()
    const configured: AdminProductConfiguration = {
      ...emptyConfiguration,
      tracking: { enabled: false, baseUrl: 'https://go.example.test' },
      readiness: {
        hasLiveDefaultFunnel: true,
        hasActiveAgreement: false,
        hasActiveBillingOffer: false,
        trackingReady: false,
        trackingOnlyReady: false,
        trackingOnlyCanIssueLinks: false,
      },
    }
    const gateway = fakeGateway(configured)
    gateway.activateProduct = vi.fn(async () => ready({ ...product, status: 'active' as const }))
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={owner}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )
    await screen.findByRole('heading', { name: 'Daily Planner', level: 1 })
    expect(
      screen.getByText(/tracking origin is configured; collection may remain disabled/i),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Review product activation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm activation' }))

    await waitFor(() => expect(gateway.activateProduct).toHaveBeenCalledOnce())
    expect(gateway.activateProduct).toHaveBeenCalledWith({ productId: 'product-1' })
  })

  it('requires an Owner confirmation and timestamp guard before enabling tracking-only mode', async () => {
    const user = userEvent.setup()
    const configured: AdminProductConfiguration = {
      ...emptyConfiguration,
      readiness: {
        ...emptyConfiguration.readiness,
        hasLiveDefaultFunnel: true,
      },
    }
    const gateway = fakeGateway(configured)
    gateway.setProductTrackingMode = vi.fn(async () =>
      ready({
        ...product,
        trackingMode: 'tracking_only' as const,
        trackingOnlyApprovedAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
      }),
    )
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={owner}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )
    await screen.findByRole('heading', { name: 'Tracking-only testing' })

    await user.click(screen.getByRole('button', { name: 'Review tracking-only mode' }))
    const confirm = screen.getByRole('button', { name: 'Confirm tracking-only mode' })
    await waitFor(() => expect(confirm).toHaveFocus())
    expect(
      screen.getByText(
        /checkout, purchase qualification, commissions, and payouts remain disabled/i,
      ),
    ).toBeVisible()

    await user.click(confirm)
    await waitFor(() => expect(gateway.setProductTrackingMode).toHaveBeenCalledOnce())
    expect(gateway.setProductTrackingMode).toHaveBeenCalledWith({
      productId: product.id,
      mode: 'tracking_only',
      expectedUpdatedAt: product.updatedAt,
    })
  })

  it('keeps tracking-mode approval Owner-only', async () => {
    const configured: AdminProductConfiguration = {
      ...emptyConfiguration,
      readiness: { ...emptyConfiguration.readiness, hasLiveDefaultFunnel: true },
    }
    const gateway = fakeGateway(configured)
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={{ ...owner, role: 'operations' }}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )

    expect(await screen.findByText(/only an owner can approve or change/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review tracking-only mode' })).toBeDisabled()
  })

  it('issues a main link with only partner and product identifiers', async () => {
    const user = userEvent.setup()
    const affiliate = {
      id: 'affiliate-1',
      publicName: 'Creator Studio',
      slug: 'creator-studio',
      status: 'active' as const,
      preferredCurrency: null,
    }
    const configured: AdminProductConfiguration = {
      ...emptyConfiguration,
      product: { ...product, status: 'active' },
      tracking: { enabled: true, baseUrl: 'https://go.example.test' },
      readiness: {
        hasLiveDefaultFunnel: true,
        hasActiveAgreement: true,
        hasActiveBillingOffer: true,
        trackingReady: true,
        trackingOnlyReady: false,
        trackingOnlyCanIssueLinks: false,
      },
      agreements: [
        {
          id: 'agreement-1',
          affiliateId: affiliate.id,
          productId: product.id,
          version: 1,
          model: 'cpa',
          status: 'active',
          attributionWindowDays: 30,
          renewalDurationDays: null,
          payoutFrequencyDays: 14,
          payoutCurrency: 'USD',
          minimumPayoutMinor: 10000,
          startsAt: product.createdAt,
          endsAt: null,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
          partnerName: affiliate.publicName,
          partnerSlug: affiliate.slug,
          hasSignedDocument: true,
          launchReady: true,
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
              createdAt: product.createdAt,
              updatedAt: product.updatedAt,
            },
          ],
        },
      ],
      billingOffers: [
        {
          id: 'offer-1',
          productId: product.id,
          key: 'monthly',
          version: 1,
          name: 'Monthly subscription',
          billingMode: 'subscription',
          stripePriceId: 'price_abcdefgh1234',
          currency: 'USD',
          unitAmountMinor: 1999,
          successUrlTemplate: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
          cancelUrl: 'https://app.kissmyapps.dev/checkout',
          status: 'active',
          stripePriceVerified: true,
          stripeLivemodeVerifiedAt: product.updatedAt,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
        },
      ],
    }
    const gateway = fakeGateway(configured)
    gateway.getAffiliates = vi.fn(async () => ready([affiliate]))
    gateway.issueMainLink = vi.fn(async () =>
      ready({
        id: 'link-1',
        affiliateId: affiliate.id,
        partnerName: affiliate.publicName,
        productId: product.id,
        funnelId: 'funnel-1',
        name: null,
        publicCode: null,
        trackingUrl: 'https://go.example.test/r/creator-studio/code',
        status: 'active' as const,
        createdAt: product.createdAt,
      }),
    )
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={owner}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )
    await screen.findByRole('heading', { name: 'Daily Planner', level: 1 })

    await user.selectOptions(screen.getByLabelText('Eligible partner'), affiliate.id)
    await user.click(screen.getByRole('button', { name: 'Review main-link issuance' }))
    await user.click(screen.getByRole('button', { name: 'Confirm link issuance' }))

    await waitFor(() => expect(gateway.issueMainLink).toHaveBeenCalledOnce())
    const input = (gateway.issueMainLink as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(input).toEqual({ affiliateId: affiliate.id, productId: product.id })
    expect(Object.keys(input)).toEqual(['productId', 'affiliateId'])
  })

  it('issues a non-commercial tracking-only main link without billing or agreement fixtures', async () => {
    const user = userEvent.setup()
    const affiliate = {
      id: 'affiliate-demo',
      publicName: 'Demo Creator',
      slug: 'demo-creator',
      status: 'active' as const,
      preferredCurrency: null,
    }
    const configured: AdminProductConfiguration = {
      ...emptyConfiguration,
      product: {
        ...product,
        status: 'active',
        trackingMode: 'tracking_only',
        trackingOnlyApprovedAt: product.updatedAt,
      },
      tracking: { enabled: true, baseUrl: 'https://go.kissmyapps.dev' },
      readiness: {
        ...emptyConfiguration.readiness,
        hasLiveDefaultFunnel: true,
        trackingOnlyReady: true,
        trackingOnlyCanIssueLinks: true,
      },
    }
    const gateway = fakeGateway(configured)
    gateway.getAffiliates = vi.fn(async () => ready([affiliate]))
    gateway.issueMainLink = vi.fn(async () =>
      ready({
        id: 'link-demo',
        affiliateId: affiliate.id,
        partnerName: affiliate.publicName,
        productId: product.id,
        funnelId: 'funnel-demo',
        name: null,
        publicCode: null,
        trackingUrl: 'https://go.kissmyapps.dev/r/demo-creator/code',
        status: 'active' as const,
        createdAt: product.createdAt,
      }),
    )
    render(
      <ProductConfigurationPage
        productId="product-1"
        context={owner}
        gateway={gateway}
        onBack={vi.fn()}
      />,
    )

    expect(await screen.findByText('Tracking only')).toBeVisible()
    expect(screen.getByText(/no checkout sessions, qualified purchases/i)).toBeVisible()
    expect(screen.getByText('Server tracking-only link gate is ready')).toBeVisible()
    expect(screen.queryByText(/live-verified subscription offer exists/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Billing offers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Partner agreements' })).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Eligible partner'), affiliate.id)
    await user.click(screen.getByRole('button', { name: 'Review main-link issuance' }))
    expect(screen.getByText(/this link cannot create commercial facts/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Confirm link issuance' }))

    await waitFor(() =>
      expect(gateway.issueMainLink).toHaveBeenCalledWith({
        productId: product.id,
        affiliateId: affiliate.id,
      }),
    )
  })
})
