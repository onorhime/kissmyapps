import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  PartnerDataError,
  PartnerDataGateway,
  PartnerDataResult,
  PartnerDocument,
  PartnerSignatureReceipt,
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

const signatureReceipt: PartnerSignatureReceipt = {
  documentId: 'document-1',
  agreementId: 'agreement-1',
  version: 1,
  status: 'awaiting_kissmyapps_signature',
  signerName: 'Victory Onorhime',
  signerUserId: 'user-1',
  signedAt: '2026-09-05T09:53:18Z',
  acknowledgedAt: '2026-09-05T09:53:18Z',
}

const pendingDocument: PartnerDocument = {
  productId: 'product-1',
  id: 'document-1',
  name: 'Partner agreement',
  type: 'Partnership Agreement',
  version: 1,
  status: 'awaiting_partner_signature',
  createdAt: '2026-09-04T08:00:00Z',
  effectiveAt: null,
  expiresAt: null,
  terminatedAt: null,
  partnerSignedAt: null,
  companySignedAt: null,
  supersedesDocumentId: null,
  supersededByDocumentId: null,
  downloadAvailable: true,
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
    getDocuments: vi.fn(async () => ready([pendingDocument])),
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
    const signAgreement = vi.fn(async () => ready(signatureReceipt))
    const onCompleted = vi.fn()
    const getSignatureQueue = vi.fn(async () => ready([signatureRequest]))
    const gateway = baseGateway({
      getSignatureQueue,
      signAgreement,
      getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/signed')),
    })
    render(<AgreementSignBanner gateway={gateway} onCompleted={onCompleted} />)

    expect(
      await screen.findByText(/Review and sign the agreement for Daily Planner/i),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Review & sign' }))
    expect(screen.getByText('Daily Planner')).toBeVisible()
    expect(screen.getByRole('link', { name: /Open the agreement PDF/i })).toHaveAttribute(
      'href',
      'https://documents.example.test/signed',
    )
    await user.click(screen.getByRole('checkbox', { name: /I have read the agreement PDF/i }))

    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    expect(screen.getByText(/Enter your full legal name to sign/i)).toBeVisible()

    await user.type(screen.getByLabelText('Your full legal name'), 'Victory Onorhime')
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))

    await waitFor(() =>
      expect(signAgreement).toHaveBeenCalledWith({
        documentId: 'document-1',
        legalName: 'Victory Onorhime',
        acknowledged: true,
      }),
    )
    expect(await screen.findByText(/Signed as Victory Onorhime/i)).toBeVisible()
    expect(onCompleted).toHaveBeenCalledTimes(1)
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
    await user.click(screen.getByRole('checkbox', { name: /I have read the agreement PDF/i }))
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))

    expect(await screen.findByText(/not awaiting the partner signature/i)).toBeVisible()
  })

  async function prepareSignature(overrides: Partial<PartnerDataGateway>) {
    const user = userEvent.setup()
    const gateway = baseGateway({
      getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
      signAgreement: vi.fn(async () => ready(signatureReceipt)),
      getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/signed')),
      ...overrides,
    })
    render(<AgreementSignBanner gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'Review & sign' }))
    await user.type(screen.getByLabelText('Your full legal name'), 'Victory Onorhime')
    await user.click(screen.getByRole('checkbox', { name: /I have read/ }))
    return { user, gateway }
  }

  it.each(['conflict', 'lost response', 'invalid response'])(
    'recovers a committed signature after %s without signing twice',
    async (scenario) => {
      const sign = vi.fn(async () => {
        if (scenario === 'lost response') throw new Error('connection lost after commit')
        return {
          status: 'error' as const,
          data: null,
          error: {
            code: scenario === 'conflict' ? ('conflict' as const) : ('invalid_response' as const),
            message: 'Could not sign.',
            retryable: false,
          },
        }
      })
      const getDocuments = vi.fn(async () =>
        ready([
          {
            ...pendingDocument,
            status: 'awaiting_kissmyapps_signature' as const,
            partnerSignedAt: signatureReceipt.signedAt,
          },
        ]),
      )
      const { user } = await prepareSignature({ signAgreement: sign, getDocuments })
      await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
      expect(await screen.findByRole('status')).toHaveTextContent(
        'The partner signature is recorded',
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Review & sign' })).not.toBeInTheDocument()
      expect(sign).toHaveBeenCalledTimes(1)
      expect(getDocuments).toHaveBeenCalledWith('product-1')
      // The directory proves state, not which owner signed. Never attribute its
      // evidence to the currently entered name after recovering a response.
      expect(screen.getByRole('status')).not.toHaveTextContent('Signed as Victory')
    },
  )

  it('recovers a countersigned document without still asking the admin to sign', async () => {
    const { user } = await prepareSignature({
      signAgreement: vi.fn(async () => {
        throw new Error('lost response')
      }),
      getDocuments: vi.fn(async () =>
        ready([
          {
            ...pendingDocument,
            status: 'active' as const,
            partnerSignedAt: signatureReceipt.signedAt,
            companySignedAt: '2026-09-05T10:00:00Z',
          },
        ]),
      ),
    })
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'already been signed by both parties',
    )
  })

  it.each(
    [
      [],
      [{ ...pendingDocument, id: 'another-document', partnerSignedAt: signatureReceipt.signedAt }],
      [
        {
          ...pendingDocument,
          status: 'terminated' as const,
          partnerSignedAt: signatureReceipt.signedAt,
        },
      ],
      [
        {
          ...pendingDocument,
          status: 'awaiting_kissmyapps_signature' as const,
          partnerSignedAt: null,
        },
      ],
    ].map((documents) => ({ documents })),
  )('does not invent success from a missing or changed document', async ({ documents }) => {
    const { user, gateway } = await prepareSignature({
      signAgreement: vi.fn(async () => {
        throw new Error('lost response')
      }),
      getDocuments: vi.fn(async () => ready(documents)),
    })
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'couldn’t confirm the signature status',
    )
    expect(screen.getByRole('button', { name: 'Check signature status' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Sign the agreement' })).not.toBeInTheDocument()
    expect(gateway.signAgreement).toHaveBeenCalledTimes(1)
  })

  it('checks an uncertain outcome without re-submitting the signature, then allows retry only after an unsigned read', async () => {
    const getDocuments = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ready([pendingDocument]))
    const sign = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ready(signatureReceipt))
    const { user } = await prepareSignature({ getDocuments, signAgreement: sign })
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    await user.click(await screen.findByRole('button', { name: 'Check signature status' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No signature is recorded yet')
    expect(sign).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Sign the agreement' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Signed as Victory Onorhime')
    expect(sign).toHaveBeenCalledTimes(2)
  })

  it('submits only once for rapid repeated clicks and locks the entered signer while pending', async () => {
    let resolve!: (value: PartnerDataResult<PartnerSignatureReceipt>) => void
    const sign = vi.fn(
      () =>
        new Promise<PartnerDataResult<PartnerSignatureReceipt>>((done) => {
          resolve = done
        }),
    )
    await prepareSignature({ signAgreement: sign })
    const button = screen.getByRole('button', { name: 'Sign the agreement' })
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Your full legal name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => {
      resolve(ready(signatureReceipt))
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Signed as Victory Onorhime')
  })

  it('times out a stalled signature-status read without allowing another signature', async () => {
    const sign = vi.fn(async () => {
      throw new Error('lost response')
    })
    await prepareSignature({
      signAgreement: sign,
      getDocuments: vi.fn(() => new Promise<PartnerDataResult<PartnerDocument[]>>(() => {})),
    })
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign the agreement' }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_001)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('couldn’t confirm the signature status')
      expect(screen.getByRole('button', { name: 'Check signature status' })).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Sign the agreement' })).not.toBeInTheDocument()
      expect(sign).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks signing when the PDF fails and provides a working retry', async () => {
    const user = userEvent.setup()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ready('https://documents.example.test/reloaded'))
    const sign = vi.fn()
    render(
      <AgreementSignBanner
        gateway={baseGateway({
          getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
          getAgreementDocumentUrl: load,
          signAgreement: sign,
        })}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Review & sign' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF could not be opened')
    expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reload document' }))
    expect(await screen.findByRole('link', { name: /Open the agreement PDF/i })).toHaveAttribute(
      'href',
      'https://documents.example.test/reloaded',
    )
    expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeDisabled()
    expect(sign).not.toHaveBeenCalled()
  })

  it('ignores a late PDF response after closing and reopening review', async () => {
    const user = userEvent.setup()
    let resolveOld!: (result: PartnerDataResult<string>) => void
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValueOnce(ready('https://documents.example.test/current'))
    render(
      <AgreementSignBanner
        gateway={baseGateway({
          getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
          getAgreementDocumentUrl: load,
          signAgreement: vi.fn(),
        })}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Review & sign' }))
    expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review & sign' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Review & sign' }))
    await screen.findByRole('link', { name: /Open the agreement PDF/i })
    resolveOld(ready('https://documents.example.test/stale'))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Open the agreement PDF/i })).toHaveAttribute(
        'href',
        'https://documents.example.test/current',
      ),
    )
  })

  it('expires a ready PDF and requires retrieval and acknowledgement again', async () => {
    vi.useFakeTimers()
    const gateway = baseGateway({
      getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
      getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/current')),
      signAgreement: vi.fn(),
    })
    const view = render(<AgreementSignBanner gateway={gateway} />)
    try {
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Review & sign' }))
      await act(async () => {})
      fireEvent.click(screen.getByRole('checkbox', { name: /I have read/ }))
      expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeEnabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(240_001)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('link has expired')
      expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeDisabled()
      expect(screen.getByRole('checkbox', { name: /I have read/ })).not.toBeChecked()
      expect(gateway.signAgreement).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it('times out a stalled PDF request instead of leaving an endless preparation state', async () => {
    vi.useFakeTimers()
    const view = render(
      <AgreementSignBanner
        gateway={baseGateway({
          getSignatureQueue: vi.fn(async () => ready([signatureRequest])),
          getAgreementDocumentUrl: vi.fn(
            () => new Promise<PartnerDataResult<string | null>>(() => {}),
          ),
          signAgreement: vi.fn(),
        })}
      />,
    )
    try {
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Review & sign' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_001)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('request timed out')
      expect(screen.getByRole('button', { name: 'Sign the agreement' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Reload document' })).toBeEnabled()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})

it('shows the frozen v2 refund and basis policy before asking for a signature', async () => {
  const user = userEvent.setup()
  const request: PartnerSignatureRequest = {
    ...signatureRequest,
    termsSha256: 'a'.repeat(64),
    rules: [
      {
        name: 'Signed revenue share',
        model: 'revenue_share',
        triggerEvent: 'purchase.completed',
        fixedAmountMinor: null,
        rateBasisPoints: 1500,
        currency: null,
        policyVersion: 2,
        validationWindowHours: 72,
        refundCutoffDays: 30,
        commissionBasisPolicy: 'net_after_fees',
        externalRefundCalculation: 'proportional_commission',
      },
    ],
  }
  render(
    <AgreementSignBanner
      gateway={baseGateway({
        getSignatureQueue: vi.fn(async () => ready([request])),
        signAgreement: vi.fn(),
        getAgreementDocumentUrl: vi.fn(async () => ready('https://documents.example.test/signed')),
      })}
    />,
  )
  await user.click(await screen.findByRole('button', { name: 'Review & sign' }))
  expect(screen.getByText(/Ordinary refund cutoff: 30 days from purchase/)).toBeVisible()
  expect(screen.getByText(/Basis: net after payment fees/)).toBeVisible()
  expect(screen.getByText(/refunds adjust commission proportionally/)).toBeVisible()
  expect(screen.getByText(/Signed terms fingerprint/)).toHaveTextContent('a'.repeat(64))
})
