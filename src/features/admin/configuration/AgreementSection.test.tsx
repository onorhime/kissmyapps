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
      refundCutoffDays: null,
      commissionBasisPolicy: 'net_after_fees',
      createdAt,
      updatedAt: createdAt,
    },
  ],
  partnerName: affiliate.publicName,
  partnerSlug: affiliate.slug,
  hasSignedDocument: false,
  launchReady: false,
  document: null,
}

function configuration(currentAgreement: AdminAgreement): AdminProductConfiguration {
  return {
    product: {
      id: 'product-1',
      name: 'Daily Planner',
      slug: 'daily-planner',
      status: 'active',
      trackingMode: 'commercial',
      trackingOnlyApprovedAt: null,
      createdAt,
      updatedAt: createdAt,
    },
    tracking: { enabled: true, baseUrl: 'https://go.example.test' },
    readiness: {
      hasLiveDefaultFunnel: true,
      hasActiveAgreement: false,
      hasActiveBillingOffer: true,
      trackingReady: true,
      trackingOnlyReady: false,
      trackingOnlyCanIssueLinks: false,
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

describe('Admin agreement document signing', () => {
  const awaitingPartnerDocument = {
    id: 'document-1',
    name: 'Partner agreement',
    version: 1,
    status: 'awaiting_partner_signature' as const,
    partnerSignerName: null,
    partnerSignedAt: null,
    companySignedAt: null,
    filePath: null,
    createdAt: createdAt,
  }

  it('offers upload and send-for-signature when no document exists', async () => {
    const user = userEvent.setup()
    const uploadAgreementDocument = vi.fn(async () => ({
      data: awaitingPartnerDocument,
      status: 'ready' as const,
      error: null,
    }))
    render(
      <AgreementSection
        configuration={configuration(agreement)}
        affiliates={[affiliate]}
        gateway={{ uploadAgreementDocument } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    expect(screen.getByText(/Upload the signed-terms PDF/i)).toBeVisible()

    await user.upload(
      screen.getByLabelText(/Agreement PDF for version 1/i),
      new File(['pdf'], 'terms.pdf', { type: 'application/pdf' }),
    )
    await user.click(screen.getByRole('button', { name: /Send for partner signature/i }))

    expect(uploadAgreementDocument).toHaveBeenCalledWith({
      agreementId: agreement.id,
      affiliateId: agreement.affiliateId,
      file: expect.objectContaining({ type: 'application/pdf' }),
    })
  })

  it('shows the countersign action only after the partner signed', async () => {
    const user = userEvent.setup()
    const countersignAgreementDocument = vi.fn(async () => ({
      data: { ...awaitingPartnerDocument, status: 'signed' as const },
      status: 'ready' as const,
      error: null,
    }))
    render(
      <AgreementSection
        configuration={configuration({
          ...agreement,
          document: {
            ...awaitingPartnerDocument,
            status: 'awaiting_kissmyapps_signature',
            partnerSignerName: 'Victory Onorhime',
            partnerSignedAt: '2026-09-04T09:00:00.000Z',
          },
        })}
        affiliates={[affiliate]}
        gateway={{ countersignAgreementDocument } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )

    expect(screen.getByText(/Waiting for the KissMyApps countersignature/i)).toBeVisible()
    expect(screen.getByText(/Partner signed as Victory Onorhime/i)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /Countersign for KissMyApps/i }))

    expect(countersignAgreementDocument).toHaveBeenCalledWith({ documentId: 'document-1' })
  })

  it('keeps signed documents immutable without further actions', () => {
    render(
      <AgreementSection
        configuration={configuration({
          ...agreement,
          hasSignedDocument: true,
          document: {
            ...awaitingPartnerDocument,
            status: 'signed',
            partnerSignerName: 'Victory Onorhime',
            partnerSignedAt: '2026-09-04T09:00:00.000Z',
            companySignedAt: '2026-09-04T10:00:00.000Z',
          },
        })}
        affiliates={[affiliate]}
        gateway={{} as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async () => false}
      />,
    )

    expect(screen.getByText(/KissMyApps countersigned/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Revoke/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Countersign/i })).not.toBeInTheDocument()
  })
})

describe('Canonical commission policy settings', () => {
  it('creates one rule with explicit cutoff/basis and the selected agreement currency', async () => {
    const user = userEvent.setup()
    const createCommissionRule = vi.fn(async () => ({
      data: agreement.commissionRules[0],
      status: 'ready',
      error: null,
    }))
    render(
      <AgreementSection
        configuration={configuration({ ...agreement, status: 'draft', payoutCurrency: 'JPY' })}
        affiliates={[affiliate]}
        gateway={{ createCommissionRule } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )
    await user.selectOptions(screen.getByLabelText('Agreement'), 'agreement-1')
    await user.type(screen.getByLabelText('Rule name'), 'Creator purchase')
    await user.type(screen.getByLabelText('Fixed amount (JPY)'), '250')
    await user.type(screen.getByLabelText(/Ordinary refund cutoff/), '30')
    await user.selectOptions(screen.getByLabelText('Commission basis'), 'subtotal_ex_tax_shipping')
    await user.click(screen.getByRole('button', { name: 'Create draft rule' }))
    expect(createCommissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        agreementId: 'agreement-1',
        fixedAmountMinor: 250,
        currency: 'JPY',
        refundCutoffDays: 30,
        commissionBasisPolicy: 'subtotal_ex_tax_shipping',
        validationWindowHours: 72,
      }),
    )
  })
  it('keeps blank refund cutoff unlimited and rejects malformed cutoffs before saving', async () => {
    const user = userEvent.setup()
    const createCommissionRule = vi.fn(async () => ({
      data: agreement.commissionRules[0],
      status: 'ready',
      error: null,
    }))
    render(
      <AgreementSection
        configuration={configuration({ ...agreement, status: 'draft', model: 'revenue_share' })}
        affiliates={[affiliate]}
        gateway={{ createCommissionRule } as unknown as AdminConfigurationGateway}
        canManage
        pendingKey={null}
        runAction={async (_key, operation) => Boolean((await operation()).data)}
      />,
    )
    await user.selectOptions(screen.getByLabelText('Agreement'), 'agreement-1')
    await user.type(screen.getByLabelText('Rule name'), 'Creator purchase')
    await user.type(screen.getByLabelText('Revenue share (%)'), '15')
    await user.type(screen.getByLabelText(/Ordinary refund cutoff/), '-1')
    await user.click(screen.getByRole('button', { name: 'Create draft rule' }))
    expect(createCommissionRule).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText(/Ordinary refund cutoff/))
    await user.click(screen.getByRole('button', { name: 'Create draft rule' }))
    expect(createCommissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        rateBasisPoints: 1500,
        refundCutoffDays: null,
        commissionBasisPolicy: 'net_after_fees',
        validationWindowHours: 72,
      }),
    )
  })
})
