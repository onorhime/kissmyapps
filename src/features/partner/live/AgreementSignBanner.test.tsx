import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  PartnerDataError,
  PartnerDataGateway,
  PartnerDataResult,
  PartnerSignatureRequest,
} from '../api'
import { AgreementSignBanner } from './AgreementSignBanner'

const signatureRequest: PartnerSignatureRequest = {
  documentId: 'document-1',
  name: 'Partner agreement',
  version: 1,
  agreementId: 'agreement-1',
  productId: 'product-1',
  productName: 'Daily Planner',
  model: 'cpa',
  attributionWindowDays: 30,
  payoutFrequencyDays: 14,
  payoutCurrency: 'USD',
  minimumPayoutMinor: 10000,
  filePath: 'affiliate-1/agreements/agreement-1/terms.pdf',
  requestedAt: '2026-09-04T08:00:00.000Z',
}

function ready<T>(data: T): PartnerDataResult<T> {
  return { data, status: 'ready', error: null }
}

function baseGateway(overrides: Partial<PartnerDataGateway> = {}): PartnerDataGateway {
  return {
    getCurrentPartnerProfile: vi.fn(),
    getDashboardSummary: vi.fn(),
    getDashboardTrends: vi.fn(),
    getProducts: vi.fn(),
    getLinkDirectory: vi.fn(),
    getPartnerLinks: vi.fn(),
    createPartnerLink: vi.fn(),
    updatePartnerLink: vi.fn(),
    setPartnerLinkStatus: vi.fn(),
    getPayoutSummary: vi.fn(),
    getPayoutHistory: vi.fn(),
    getPayoutDetail: vi.fn(),
    getDocuments: vi.fn(),
    getAgreements: vi.fn(),
    updatePartnerProfile: vi.fn(),
    updatePartnerSettings: vi.fn(),
    ...overrides,
  } as unknown as PartnerDataGateway
}

describe('Partner agreement sign banner', () => {
  it('renders nothing when the gateway lacks the signing capability', () => {
    const { container } = render(<AgreementSignBanner gateway={baseGateway()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the signature queue is empty', async () => {
    const gateway = baseGateway({
      getSignatureQueue: vi.fn(async () => ready([])),
      signAgreement: vi.fn(),
    })
    const { container } = render(<AgreementSignBanner gateway={gateway} />)
    await waitFor(() => expect(gateway.getSignatureQueue).toHaveBeenCalledOnce())
    expect(container).toBeEmptyDOMElement()
  })

  it('surfaces the pending request, opens review, and signs with the legal name', async () => {
    const user = userEvent.setup()
    const signAgreement = vi.fn(async () =>
      ready({
        id: 'document-1',
        name: 'Partner agreement',
        type: 'partner_agreement',
        version: 1,
        status: 'awaiting_kissmyapps_signature' as const,
        createdAt: signatureRequest.requestedAt,
        effectiveAt: null,
        expiresAt: null,
        terminatedAt: null,
        partnerSignedAt: '2026-09-04T09:00:00.000Z',
        companySignedAt: null,
        supersedesDocumentId: null,
        supersededByDocumentId: null,
        downloadAvailable: true,
      }),
    )
    const getSignatureQueue = vi.fn(async () => ready([signatureRequest]))
    const gateway = baseGateway({
      getSignatureQueue,
      signAgreement,
      getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/signed')),
    })
    render(<AgreementSignBanner gateway={gateway} />)

    expect(
      await screen.findByText(/Review and sign the agreement for Daily Planner/i),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Review & sign' }))
    expect(screen.getByText('Daily Planner')).toBeVisible()
    expect(screen.getByRole('link', { name: /Open the agreement PDF/i })).toHaveAttribute(
      'href',
      'https://documents.example.test/signed',
    )

    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    expect(screen.getByText(/Enter your full legal name to sign/i)).toBeVisible()

    await user.type(screen.getByLabelText('Your full legal name'), 'Victory Onorhime')
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))

    await waitFor(() =>
      expect(signAgreement).toHaveBeenCalledWith({
        documentId: 'document-1',
        legalName: 'Victory Onorhime',
      }),
    )
    expect(await screen.findByText(/Signed as Victory Onorhime/i)).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: /Action required · partnership agreement/i }),
    ).not.toBeInTheDocument()
  })

  it('surfaces a safe conflict when the server rejects the signature', async () => {
    const user = userEvent.setup()
    const failure: PartnerDataError = {
      code: 'conflict',
      message: 'This agreement document is not awaiting the partner signature.',
      retryable: false,
    }
    const gateway = baseGateway({
      getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
      signAgreement: vi.fn(async () => ({ data: null, status: 'error' as const, error: failure })),
      getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/signed')),
    })
    render(<AgreementSignBanner gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'Review & sign' }))
    await user.type(screen.getByLabelText('Your full legal name'), 'Victory Onorhime')
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))

    expect(await screen.findByText(/not awaiting the partner signature/i)).toBeVisible()
  })
})
