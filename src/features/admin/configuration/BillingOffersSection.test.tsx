import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminBillingOffer,
  AdminConfigurationGateway,
  AdminProductConfiguration,
} from '../api'
import { BillingOffersSection } from './BillingOffersSection'
import { billingOfferActivationBlockers, canVerifyBillingOfferPrice } from './billingOfferReadiness'

const offer: AdminBillingOffer = {
  id: 'offer-1',
  productId: 'product-1',
  key: 'monthly',
  version: 1,
  name: 'Monthly subscription',
  billingMode: 'subscription',
  stripePriceId: 'price_abcdefgh1234',
  currency: 'USD',
  unitAmountMinor: 1999,
  successUrlTemplate: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.kissmyapps.dev/checkout',
  status: 'draft',
  stripePriceVerified: true,
  stripeLivemodeVerifiedAt: '2026-08-28T12:00:00.000Z',
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T12:00:00.000Z',
}

const managedProof = {
  configuredPriceId: offer.stripePriceId!,
  accountId: 'acct_catalogfixture',
  livemode: false,
  stripePriceId: 'price_ManagedTestFixture',
  currency: offer.currency!,
  unitAmountMinor: offer.unitAmountMinor!,
  offerVersion: offer.version,
  verifiedAt: offer.updatedAt,
}

const configuration: AdminProductConfiguration = {
  product: {
    id: 'product-1',
    name: 'Daily Planner',
    slug: 'daily-planner',
    status: 'active',
    trackingMode: 'commercial',
    trackingOnlyApprovedAt: null,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
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
  billingOffers: [offer],
  mainLinks: [],
}

describe('Admin billing offers', () => {
  it('requires explicit confirmation before activating a ready subscription', async () => {
    const user = userEvent.setup()
    const setBillingOfferStatus = vi.fn(async () => ({
      data: { ...offer, status: 'active' as const },
      status: 'ready' as const,
      error: null,
    }))
    render(
      <BillingOffersSection
        configuration={configuration}
        gateway={{ setBillingOfferStatus } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    expect(setBillingOfferStatus).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(setBillingOfferStatus).toHaveBeenCalledWith({
      billingOfferId: offer.id,
      status: 'active',
    })
  })

  it('keeps one-time activation blocked until managed checkout is explicitly configured', () => {
    const payment = { ...offer, id: 'offer-2', billingMode: 'payment' as const }
    expect(billingOfferActivationBlockers(payment, true)[0]).toMatch(/managed checkout integration/)
    expect(canVerifyBillingOfferPrice({ ...payment, stripePriceVerified: false })).toBe(true)
    render(
      <BillingOffersSection
        configuration={{ ...configuration, billingOffers: [payment] }}
        gateway={{} as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={vi.fn()}
      />,
    )
    expect(
      screen.getByText('One-time payment · managed checkout', { selector: 'span' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review activation' })).toBeDisabled()
    expect(screen.getByText(/Managed checkout is disabled for this product/)).toBeVisible()
    expect(screen.getByText(/Test verification alone does not qualify/)).toBeVisible()
    expect(screen.queryByText(/does not unlock.*partner-link launch/)).not.toBeInTheDocument()
  })

  it('reviews a verified managed one-time offer without changing commission settings', async () => {
    const user = userEvent.setup()
    const payment = {
      ...offer,
      id: 'offer-2',
      billingMode: 'payment' as const,
      managedPriceVerifications: [managedProof],
    }
    const setBillingOfferStatus = vi.fn(async () => ({
      data: { ...payment, status: 'active' as const },
      status: 'ready' as const,
      error: null,
    }))
    expect(billingOfferActivationBlockers(payment, true, true)).toEqual([])
    expect(
      billingOfferActivationBlockers({ ...payment, managedPriceVerifications: [] }, true, true),
    ).toContain('Verify a Price for the managed checkout account and mode.')
    expect(
      billingOfferActivationBlockers({ ...payment, stripePriceVerified: false }, true, true),
    ).toEqual([])
    expect(
      billingOfferActivationBlockers({ ...payment, unitAmountMinor: 1 }, true, true),
    ).toContain('Verify a Price for the managed checkout account and mode.')
    render(
      <BillingOffersSection
        configuration={{
          ...configuration,
          billingOffers: [payment],
          readiness: { ...configuration.readiness, managedPaymentCheckoutEnabled: true },
        }}
        gateway={{ setBillingOfferStatus } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    expect(setBillingOfferStatus).not.toHaveBeenCalled()
    expect(screen.getByText(/It does not enable the subscription checkout/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(setBillingOfferStatus).toHaveBeenCalledWith({
      billingOfferId: payment.id,
      status: 'active',
    })
  })

  it('verifies a complete draft by sending only its offer ID', async () => {
    const user = userEvent.setup()
    const draft = {
      ...offer,
      stripePriceVerified: false,
      stripeLivemodeVerifiedAt: null,
    }
    const verifyBillingOfferPrice = vi.fn(async (_input: { billingOfferId: string }) => ({
      data: {
        verified: true as const,
        billingOfferId: draft.id,
        requestId: 'request-1',
      },
      status: 'ready' as const,
      error: null,
    }))
    expect(canVerifyBillingOfferPrice(draft)).toBe(true)
    expect(canVerifyBillingOfferPrice({ ...draft, unitAmountMinor: null })).toBe(false)
    render(
      <BillingOffersSection
        configuration={{ ...configuration, billingOffers: [draft] }}
        gateway={{ verifyBillingOfferPrice } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Verify live Price' }))

    expect(verifyBillingOfferPrice).toHaveBeenCalledWith({ billingOfferId: draft.id })
    expect(Object.keys(verifyBillingOfferPrice.mock.calls[0]?.[0] ?? {})).toEqual([
      'billingOfferId',
    ])
  })
})

it('verifies a managed Price using the configured binding and shows Test mode clearly', async () => {
  const user = userEvent.setup()
  const payment = {
    ...offer,
    billingMode: 'payment' as const,
    managedPriceVerifications: [managedProof],
  }
  const verifyBillingOfferPrice = vi.fn(async () => ({
    data: { verified: true as const, billingOfferId: offer.id, requestId: 'fixture' },
    status: 'ready' as const,
    error: null,
  }))
  render(
    <BillingOffersSection
      configuration={{ ...configuration, billingOffers: [payment] }}
      gateway={{ verifyBillingOfferPrice } as unknown as AdminConfigurationGateway}
      canManage
      pendingKey={null}
      runAction={async (_key, operation) => Boolean((await operation()).data)}
    />,
  )
  expect(screen.getByText('Test Price verified')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Verify live Price' })).not.toBeInTheDocument()
  await user.click(screen.getByText('Verify a managed Stripe Price'))
  await user.type(screen.getByLabelText('Managed integration ID'), 'marathon-test')
  await user.clear(screen.getByLabelText('Managed Stripe Price ID'))
  await user.type(screen.getByLabelText('Managed Stripe Price ID'), 'price_ManagedTestFixture')
  await user.click(screen.getByRole('button', { name: 'Verify managed Price' }))
  expect(verifyBillingOfferPrice).toHaveBeenCalledWith({
    billingOfferId: offer.id,
    managed: { bindingId: 'marathon-test', stripePriceId: 'price_ManagedTestFixture' },
  })
})
