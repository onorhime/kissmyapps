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

const configuration: AdminProductConfiguration = {
  product: {
    id: 'product-1',
    name: 'Daily Planner',
    slug: 'daily-planner',
    status: 'active',
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  },
  tracking: { enabled: false, baseUrl: null },
  readiness: {
    hasLiveDefaultFunnel: false,
    hasActiveAgreement: false,
    hasActiveBillingOffer: false,
    trackingReady: false,
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

  it('keeps payment mode visibly draft-only and blocked', () => {
    const payment = { ...offer, id: 'offer-2', billingMode: 'payment' as const }
    expect(billingOfferActivationBlockers(payment, true)[0]).toMatch(/draft-only/)
    expect(canVerifyBillingOfferPrice({ ...payment, stripePriceVerified: false })).toBe(false)
    render(
      <BillingOffersSection
        configuration={{ ...configuration, billingOffers: [payment] }}
        gateway={{} as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={vi.fn()}
      />,
    )
    expect(screen.getByText('Payment · draft only')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Review activation' })).not.toBeInTheDocument()
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
