import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminAffiliate,
  AdminAgreement,
  AdminConfigurationGateway,
  AdminProductConfiguration,
} from '../api'
import { AgreementSection } from './AgreementSection'

const createdAt = '2026-08-28T10:00:00.000Z'

const affiliate: AdminAffiliate = {
  id: 'affiliate-1',
  publicName: 'Creator Studio',
  slug: 'creator-studio',
  status: 'active',
  preferredCurrency: 'USD',
}

const agreement: AdminAgreement = {
  id: 'agreement-1',
  affiliateId: affiliate.id,
  productId: 'product-1',
  version: 1,
  model: 'cpa',
  status: 'awaiting_signature',
  attributionWindowDays: 30,
  renewalDurationDays: null,
  payoutFrequencyDays: 14,
  payoutCurrency: 'USD',
  minimumPayoutMinor: 10000,
  startsAt: null,
  endsAt: null,
  createdAt,
  updatedAt: createdAt,
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
      createdAt,
      updatedAt: createdAt,
    },
  ],
  partnerName: affiliate.publicName,
  partnerSlug: affiliate.slug,
  hasSignedDocument: false,
  launchReady: false,
}

function configuration(currentAgreement: AdminAgreement): AdminProductConfiguration {
  return {
    product: {
      id: 'product-1',
      name: 'Daily Planner',
      slug: 'daily-planner',
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    },
    tracking: { enabled: true, baseUrl: 'https://go.example.test' },
    readiness: {
      hasLiveDefaultFunnel: true,
      hasActiveAgreement: false,
      hasActiveBillingOffer: true,
      trackingReady: true,
    },
    funnels: [],
    campaigns: [],
    agreements: [currentAgreement],
    billingOffers: [],
    mainLinks: [],
  }
}

function renderSection(currentAgreement: AdminAgreement, activateAgreement = vi.fn()) {
  render(
    <AgreementSection
      configuration={configuration(currentAgreement)}
      affiliates={[affiliate]}
      gateway={{ activateAgreement } as unknown as AdminConfigurationGateway}
      canManage
      pendingKey={null}
      runAction={async (_key, operation) => Boolean((await operation()).data)}
    />,
  )
  return activateAgreement
}

describe('Admin agreement launch gates', () => {
  it('blocks activation until a bilateral signed document is recorded', () => {
    renderSection(agreement)

    expect(screen.getByRole('button', { name: 'Activate agreement' })).toBeDisabled()
    expect(screen.getByText(/signed by both the partner and KissMyApps/i)).toBeVisible()
  })

  it('blocks activation when more than one supported purchase rule is active', () => {
    const duplicateRule = {
      ...agreement.commissionRules[0],
      id: 'rule-2',
      name: 'Second paid purchase',
    }
    renderSection({
      ...agreement,
      hasSignedDocument: true,
      commissionRules: [...agreement.commissionRules, duplicateRule],
    })

    expect(screen.getByRole('button', { name: 'Activate agreement' })).toBeDisabled()
    expect(screen.getByText(/supersede extra active rules/i)).toBeVisible()
  })

  it('blocks activation when the active rule currency conflicts with the agreement', () => {
    renderSection({
      ...agreement,
      hasSignedDocument: true,
      commissionRules: agreement.commissionRules.map((rule) => ({ ...rule, currency: 'EUR' })),
    })

    expect(screen.getByRole('button', { name: 'Activate agreement' })).toBeDisabled()
    expect(screen.getByText(/compatible payout currency/i)).toBeVisible()
  })

  it('activates only a signed agreement with exactly one supported purchase rule', async () => {
    const user = userEvent.setup()
    const activateAgreement = vi.fn(async () => ({
      data: { ...agreement, status: 'active' as const },
      status: 'ready' as const,
      error: null,
    }))
    renderSection({ ...agreement, hasSignedDocument: true }, activateAgreement)

    await user.click(screen.getByRole('button', { name: 'Activate agreement' }))

    expect(activateAgreement).toHaveBeenCalledWith({ agreementId: agreement.id })
  })
})
