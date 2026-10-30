import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerDocument,
  type PartnerLink,
  type PartnerProduct,
  type PartnerProfile,
  type PartnerTrendPoint,
} from '../api'
import type { PortalPage } from '../data'
import { LivePartnerPortal } from './LivePartnerPortal'
import { PartnerLiveWorkspaceProvider } from './PartnerLiveWorkspace'

const profile: PartnerProfile = {
  email: 'partner@example.test',
  fullName: 'Partner Person',
  publicName: 'Partner Studio',
  legalName: 'Partner Studio Ltd',
  entityType: 'Company',
  countryCode: 'NG',
  timezone: 'Africa/Lagos',
  preferredCurrency: 'USD',
  website: null,
  category: null,
  audienceDescription: null,
  audienceCountries: [],
  channels: [],
  channelDetails: null,
  role: 'owner',
  status: 'active',
  notifications: {
    statements: true,
    payouts: true,
    verification: true,
    signatures: true,
    adjustments: true,
    inactiveLinks: true,
  },
}

const product: PartnerProduct = {
  id: 'product-demo',
  slug: 'demo-product',
  name: 'Demo product',
  status: 'active',
  trackingMode: 'tracking_only',
  agreementStatus: null,
  commercialModel: null,
  payoutCurrency: null,
  hasLiveFunnel: true,
  mainLinkId: 'main-link-demo',
  mainTrackingUrl: 'https://go.example.test/r/partner/main-code',
}

const existingLink: PartnerLink = {
  id: 'link-tiktok',
  name: 'TikTok bio',
  productId: product.id,
  productName: product.name,
  productSlug: product.slug,
  funnelId: 'funnel-demo',
  funnelName: 'Demo funnel',
  sourceId: 'source-tiktok',
  sourceName: 'TikTok',
  campaignId: 'campaign-launch',
  campaignName: 'Demo launch',
  sub1: 'profile-bio',
  sub2: '',
  sub3: '',
  status: 'active',
  trackingUrl: 'https://go.example.test/r/partner/tiktok-code',
  parentLinkId: product.mainLinkId,
  commercialEligible: false,
  clicks: 7,
  leads: null,
  installs: null,
  purchases: null,
  earningsMinor: null,
  currency: null,
  createdAt: '2026-09-01T12:00:00Z',
}

function result<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

function unavailable<T>(data: T, message: string): PartnerDataResult<T> {
  return {
    data,
    status: 'error',
    error: { code: 'temporarily_unavailable', message, retryable: true },
  }
}

function trendPoint(
  source: { key: string; label: string },
  bucketStart: string,
  metrics: Pick<
    PartnerTrendPoint['metrics'],
    'clicks' | 'funnelStarts' | 'paymentViews' | 'appStoreClicks'
  >,
): PartnerTrendPoint {
  return {
    bucketStart,
    bucketEnd: bucketStart,
    dimensionKey: source.key,
    dimensionLabel: source.label,
    reconciliationStage: 'preliminary',
    metrics: { ...emptyPartnerDashboardSummary().metrics, ...metrics },
  }
}

function gateway() {
  const createPartnerLink = vi.fn(async () =>
    result<PartnerLink | null>(
      {
        ...existingLink,
        id: 'link-instagram',
        name: 'Instagram bio',
        sourceId: 'source-instagram',
        sourceName: 'Instagram',
        campaignId: null,
        campaignName: null,
        sub1: 'profile-link',
        trackingUrl: 'https://go.example.test/r/partner/instagram-code',
        clicks: 0,
      },
      'ready',
    ),
  )
  const dataGateway: PartnerDataGateway = {
    getCurrentPartnerProfile: async () => result(profile, 'ready'),
    getProducts: async () => result([product], 'ready'),
    getLinkDirectory: async () =>
      result(
        {
          products: [product],
          funnels: [
            {
              id: 'funnel-demo',
              kind: 'funnel',
              productId: product.id,
              key: 'demo',
              name: 'Demo funnel',
              available: true,
            },
          ],
          sources: [
            {
              id: 'source-instagram',
              kind: 'source',
              productId: null,
              key: 'instagram',
              name: 'Instagram',
              available: true,
            },
            {
              id: 'source-tiktok',
              kind: 'source',
              productId: null,
              key: 'tiktok',
              name: 'TikTok',
              available: true,
            },
          ],
          campaigns: [
            {
              id: 'campaign-launch',
              kind: 'campaign',
              productId: product.id,
              key: 'demo-launch',
              name: 'Demo launch',
              available: true,
            },
          ],
        },
        'ready',
      ),
    getPartnerLinks: async () => result([existingLink], 'ready'),
    createPartnerLink,
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
  }
  return { dataGateway, createPartnerLink }
}

function portal(
  dataGateway: PartnerDataGateway,
  page: PortalPage = 'links',
  sessionUserId: string | null = 'user-1',
) {
  return (
    <PartnerLiveWorkspaceProvider
      gateway={dataGateway}
      client={null}
      sessionUserId={sessionUserId}
      reporting={{
        startsOn: '2026-08-01',
        endsOn: '2026-09-01',
        timezone: 'Africa/Lagos',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal page={page} />
    </PartnerLiveWorkspaceProvider>
  )
}

it('offers configured funnel reporting when a commercial product has no canonical finance activity yet', async () => {
  const { dataGateway } = gateway()
  dataGateway.getProducts = async () =>
    result([{ ...product, trackingMode: 'commercial' }], 'ready')
  render(portal(dataGateway, 'performance'))
  expect(
    await screen.findByRole('heading', { name: 'Configured funnel metrics' }),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Metrics funnel')).toHaveValue('funnel-demo')
  // Existing financial cards remain independently unavailable; custom reporting is not hidden.
  expect(screen.getByText('Financial totals are not available yet.')).toBeInTheDocument()
  expect(screen.queryByText('No verified activity yet')).not.toBeInTheDocument()
})

it('shows verified commercial traffic without turning unavailable financial totals into zero', async () => {
  const { dataGateway } = gateway()
  dataGateway.getProducts = async () =>
    result([{ ...product, trackingMode: 'commercial' }], 'ready')
  dataGateway.getDashboardSummary = async () =>
    result(
      {
        ...emptyPartnerDashboardSummary(),
        hasData: true,
        currency: 'USD',
        reconciliationStage: 'preliminary',
        metrics: {
          ...emptyPartnerDashboardSummary().metrics,
          clicks: 2,
          funnelStarts: 2,
          paymentViews: 2,
        },
      },
      'ready',
    )
  dataGateway.getDashboardTrends = async () =>
    result(
      [
        trendPoint({ key: 'tiktok', label: 'TikTok' }, '2026-08-30', {
          clicks: 1,
          funnelStarts: 1,
          paymentViews: 1,
          appStoreClicks: null,
        }),
        trendPoint({ key: 'tiktok', label: 'TikTok' }, '2026-08-31', {
          clicks: 1,
          funnelStarts: 1,
          paymentViews: 1,
          appStoreClicks: 0,
        }),
      ],
      'ready',
    )
  render(portal(dataGateway, 'performance'))
  const summary = await screen.findByRole('region', { name: 'Performance live summary' })
  const cards = summary.querySelector('.live-summary-grid') as HTMLElement
  expect(within(cards).getByText('2')).toBeVisible()
  expect(within(cards).getAllByText('—')).toHaveLength(3)
  const tiktok = screen.getByRole('row', { name: /TikTok/ })
  expect(within(tiktok).getAllByText('2')).toHaveLength(3)
  expect(within(tiktok).getByText('—')).toBeVisible()
  expect(within(summary).queryByText('$0.00')).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByText('How these numbers work'))
  expect(
    screen.getByText(/Verified traffic can appear before financial totals are complete/),
  ).toBeVisible()
  expect(screen.getByText('Financial totals are not available yet.')).toBeVisible()
})

it('separates confirmed zero revenue from active free subscriptions without claiming payout readiness', async () => {
  const { dataGateway } = gateway()
  dataGateway.getProducts = async () =>
    result([{ ...product, trackingMode: 'commercial' }], 'ready')
  dataGateway.getDashboardSummary = async () =>
    result(
      {
        ...emptyPartnerDashboardSummary(),
        hasData: true,
        currency: 'USD',
        reconciliationStage: 'preliminary',
        metrics: {
          ...emptyPartnerDashboardSummary().metrics,
          clicks: 5,
          purchases: 0,
          earningsMinor: 0,
          activeSubscriptions: 2,
        },
      },
      'ready',
    )
  render(portal(dataGateway, 'performance'))
  const summary = await screen.findByRole('region', { name: 'Performance live summary' })
  const cards = summary.querySelector('.live-summary-grid') as HTMLElement
  expect(within(cards).getByText('Recorded paid purchases').parentElement).toHaveTextContent('0')
  expect(within(cards).getByText('Recorded earnings').parentElement).toHaveTextContent('$0.00')
  expect(within(cards).getByText('Active / trial subscriptions').parentElement).toHaveTextContent(
    '2',
  )
  expect(within(cards).queryByText('—')).not.toBeInTheDocument()
  expect(screen.getByText('Recorded totals · preliminary.')).toBeVisible()
  await userEvent.setup().click(screen.getByText('How these numbers work'))
  expect(screen.getByText(/not money available for payout/)).toBeVisible()
  expect(screen.getByText(/a free checkout is not a paid purchase/)).toBeVisible()
  expect(screen.getByText(/Links & Sources shows all-time raw clicks/)).toBeVisible()
})

it('shows rates, a day-by-day chart, and the conversion path for the selected period', async () => {
  const user = userEvent.setup()
  const { dataGateway } = gateway()
  dataGateway.getProducts = async () =>
    result([{ ...product, trackingMode: 'commercial' }], 'ready')
  dataGateway.getDashboardSummary = async () =>
    result(
      {
        ...emptyPartnerDashboardSummary(),
        startsOn: '2026-08-30',
        endsOn: '2026-08-31',
        hasData: true,
        currency: 'USD',
        reconciliationStage: 'reconciled',
        metrics: {
          ...emptyPartnerDashboardSummary().metrics,
          clicks: 200,
          funnelStarts: 100,
          paymentViews: 40,
          purchases: 10,
          earningsMinor: 12500,
          activeSubscriptions: 8,
        },
      },
      'ready',
    )
  dataGateway.getDashboardTrends = async () =>
    result(
      [
        trendPoint({ key: 'tiktok', label: 'TikTok' }, '2026-08-30', {
          clicks: 150,
          funnelStarts: 80,
          paymentViews: 30,
          appStoreClicks: 0,
        }),
        trendPoint({ key: 'instagram', label: 'Instagram' }, '2026-08-31', {
          clicks: 50,
          funnelStarts: 20,
          paymentViews: 10,
          appStoreClicks: 0,
        }),
      ],
      'ready',
    )
  const onReportingDaysChange = vi.fn()
  render(
    <PartnerLiveWorkspaceProvider
      gateway={dataGateway}
      client={null}
      sessionUserId="user-1"
      reporting={{
        startsOn: '2026-08-30',
        endsOn: '2026-08-31',
        timezone: 'UTC',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal
        page="performance"
        reportingDays={30}
        onReportingDaysChange={onReportingDaysChange}
      />
    </PartnerLiveWorkspaceProvider>,
  )

  expect(await screen.findByText('5% of clicks became a purchase')).toBeVisible()
  expect(screen.getByText('$125.00')).toBeVisible()
  expect(screen.getByText('Recorded totals.')).toBeVisible()
  expect(
    screen.getByRole('img', { name: /Clicks per day from Aug 30 to Aug 31\. Total 200\./ }),
  ).toBeInTheDocument()
  const path = screen.getByRole('region', { name: 'Your conversion path' })
  expect(within(path).getByText('50% of previous')).toBeVisible()
  expect(within(path).getByText('25% of previous')).toBeVisible()
  expect(within(screen.getByRole('row', { name: /TikTok/ })).getByText('75%')).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Paid purchases' }))
  expect(screen.getByRole('button', { name: 'Paid purchases' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await user.click(screen.getByRole('button', { name: '7 days' }))
  expect(onReportingDaysChange).toHaveBeenCalledWith(7)
})

it('explains that link counts include bot-classified visits and are all-time', async () => {
  const { dataGateway } = gateway()
  render(portal(dataGateway))
  expect(await screen.findByRole('columnheader', { name: 'Raw clicks · all time' })).toBeVisible()
  expect(screen.getByText(/Raw clicks count all recorded visits/)).toBeVisible()
  const table = screen
    .getByRole('columnheader', { name: 'Raw clicks · all time' })
    .closest('table')!
  expect(table).toHaveAccessibleDescription(/Performance shows bot-filtered clicks/)
  expect(within(table).getByText('7')).toBeVisible()
})

function renderPortal(dataGateway: PartnerDataGateway, page: PortalPage = 'links') {
  return render(portal(dataGateway, page))
}

describe('product read failures versus empty configuration', () => {
  it.each(['links', 'performance', 'payouts'] as const)(
    'shows a retryable product failure on %s instead of claiming no configuration',
    async (page) => {
      const { dataGateway } = gateway()
      dataGateway.getProducts = vi.fn(async () => ({
        data: [],
        status: 'error' as const,
        error: {
          code: 'not_authorized' as const,
          message: 'Partner data is not available.',
          retryable: false,
        },
      }))
      renderPortal(dataGateway, page)
      expect(
        await screen.findByRole('heading', { name: 'Product data is unavailable' }),
      ).toBeVisible()
      expect(screen.getByRole('option', { name: 'Products unavailable' })).toBeInTheDocument()
      expect(screen.getByText('Agreement details unavailable')).toBeVisible()
      expect(screen.queryByText('No active products')).not.toBeInTheDocument()
      expect(screen.queryByText('No agreement configured')).not.toBeInTheDocument()
      expect(screen.queryByText('No verified activity yet')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Retry product data' })).toBeEnabled()
    },
  )

  it('recovers product and main-link data through a read-only retry', async () => {
    const user = userEvent.setup()
    const { dataGateway, createPartnerLink } = gateway()
    const readProducts = vi.fn().mockResolvedValue(unavailable([], 'Unavailable'))
    dataGateway.getProducts = readProducts
    renderPortal(dataGateway)
    await screen.findByRole('heading', { name: 'Product data is unavailable' })
    readProducts.mockResolvedValue(result([product], 'ready'))
    await user.click(screen.getByRole('button', { name: 'Retry product data' }))
    expect(await screen.findByRole('textbox', { name: 'Main tracking URL' })).toHaveValue(
      product.mainTrackingUrl,
    )
    expect(screen.queryByText('Agreement details unavailable')).not.toBeInTheDocument()
    expect(createPartnerLink).not.toHaveBeenCalled()
  })

  it('keeps a successful empty product response distinct from an error', async () => {
    const { dataGateway } = gateway()
    dataGateway.getProducts = async () => result([], 'empty')
    renderPortal(dataGateway)
    expect(
      await screen.findByRole('heading', { name: 'No products are connected yet' }),
    ).toBeVisible()
    expect(screen.getByRole('option', { name: 'No active products' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry product data' })).not.toBeInTheDocument()
  })
})

const signedDocument: PartnerDocument = {
  id: 'document-signed',
  productId: 'draft-product',
  name: 'BC Learn agreement',
  type: 'partner_agreement',
  version: 1,
  status: 'signed',
  createdAt: '2026-09-05T08:00:00Z',
  effectiveAt: null,
  expiresAt: null,
  terminatedAt: null,
  partnerSignedAt: '2026-09-05T09:53:18Z',
  companySignedAt: '2026-09-05T10:28:28Z',
  supersedesDocumentId: null,
  supersededByDocumentId: null,
  downloadAvailable: true,
}

describe('live account documents before launch', () => {
  function documentsGateway(documents = [signedDocument]) {
    const { dataGateway } = gateway()
    dataGateway.getProducts = async () => result([], 'empty')
    dataGateway.getLinkDirectory = async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty')
    dataGateway.getDocuments = vi.fn(async () =>
      result(documents, documents.length ? 'ready' : 'empty'),
    )
    return dataGateway
  }
  const pdfUrl =
    'https://project.supabase.co/storage/v1/object/sign/affiliate-private-documents/example/terms.pdf?token=test-only'
  async function openDocument(dataGateway: PartnerDataGateway) {
    const user = userEvent.setup()
    const view = renderPortal(dataGateway, 'profile')
    await user.click(
      await screen.findByRole('button', { name: 'View BC Learn agreement, version 1' }),
    )
    return { user, view }
  }

  it('renders saved signatures without products, funnels, activity, or a main link', async () => {
    const dataGateway = documentsGateway()
    renderPortal(dataGateway, 'profile')
    const card = await screen.findByRole('article', { name: 'BC Learn agreement, version 1' })
    expect(within(card).getByText('Signed by both parties')).toBeVisible()
    expect(within(card).getByText(/Sep 5, 2026, 10:53 AM/)).toBeVisible()
    expect(within(card).getByText(/Sep 5, 2026, 11:28 AM/)).toBeVisible()
    expect(screen.queryByText('No verified activity yet')).not.toBeInTheDocument()
    expect(screen.queryByText('No agreement configured')).not.toBeInTheDocument()
    expect(screen.getByText('1 document · All products')).toBeVisible()
    expect(dataGateway.getDocuments).toHaveBeenCalledWith()
  })

  it('keeps documents visible with a draft product and failed reporting data', async () => {
    const dataGateway = documentsGateway()
    dataGateway.getProducts = async () =>
      result([{ ...product, id: 'draft-product', status: 'draft', hasLiveFunnel: false }], 'ready')
    dataGateway.getDashboardSummary = async () =>
      unavailable(emptyPartnerDashboardSummary(), 'Metrics unavailable')
    renderPortal(dataGateway, 'profile')
    expect(await screen.findByRole('article', { name: /BC Learn agreement/ })).toBeVisible()
    expect(screen.queryByText('No live funnel is available yet')).not.toBeInTheDocument()
  })

  it('distinguishes a failed document read from an empty list and retries', async () => {
    const user = userEvent.setup()
    const dataGateway = documentsGateway()
    const getDocuments = vi
      .fn()
      .mockResolvedValueOnce(unavailable([], 'Documents could not be verified.'))
      .mockResolvedValue(result([signedDocument], 'ready'))
    dataGateway.getDocuments = getDocuments
    renderPortal(dataGateway, 'profile')
    expect(await screen.findByRole('heading', { name: 'Documents are unavailable' })).toBeVisible()
    expect(screen.queryByText('No documents shared yet')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh documents' }))
    expect(await screen.findByRole('article', { name: /BC Learn agreement/ })).toBeVisible()
  })

  it('shows a document-specific empty state without suggesting traffic is needed', async () => {
    renderPortal(documentsGateway([]), 'profile')
    expect(await screen.findByText('No documents shared yet')).toBeVisible()
    expect(screen.getByText(/No traffic or payments are required/)).toBeVisible()
  })

  it('preserves historical versions, filters status, and displays linked versions', async () => {
    const dataGateway = documentsGateway([
      signedDocument,
      {
        ...signedDocument,
        id: 'historical',
        name: 'Original agreement',
        version: 0,
        status: 'superseded',
        supersededByDocumentId: signedDocument.id,
      },
    ])
    const user = userEvent.setup()
    renderPortal(dataGateway, 'profile')
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Document status' }),
      'superseded',
    )
    expect(
      screen.queryByRole('article', { name: 'BC Learn agreement, version 1' }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View Original agreement, version 0' }))
    expect(
      within(screen.getByRole('dialog')).getByText('BC Learn agreement · Version 1'),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Document status' }), 'expired')
    expect(screen.getByText('No documents match this status')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Clear document filter' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('prepares a fresh private URL only after an explicit click and opens safely', async () => {
    const dataGateway = documentsGateway()
    const getDocumentUrl = vi.fn(async () => result(pdfUrl, 'ready'))
    dataGateway.getDocumentUrl = getDocumentUrl
    const { user } = await openDocument(dataGateway)
    expect(getDocumentUrl).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Prepare PDF link' }))
    const link = await screen.findByRole('link', { name: 'Open PDF' })
    expect(link).toHaveAttribute('href', pdfUrl)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(getDocumentUrl).toHaveBeenCalledExactlyOnceWith(signedDocument.id)
    expect(screen.queryByRole('button', { name: 'Sign the agreement' })).not.toBeInTheDocument()
  })

  it.each([
    { status: 'draft' as const, downloadAvailable: true },
    { status: 'signed' as const, downloadAvailable: false },
  ])('does not attempt downloads for an unavailable document', async (patch) => {
    const dataGateway = documentsGateway([{ ...signedDocument, ...patch }])
    const getDocumentUrl = vi.fn(async () => result(pdfUrl, 'ready'))
    dataGateway.getDocumentUrl = getDocumentUrl
    await openDocument(dataGateway)
    expect(screen.queryByRole('button', { name: 'Prepare PDF link' })).not.toBeInTheDocument()
    expect(getDocumentUrl).not.toHaveBeenCalled()
    expect(screen.getByText(/No downloadable file is available/)).toBeVisible()
  })

  it('reports an authorization/download failure without a stale URL or private error details', async () => {
    const dataGateway = documentsGateway()
    dataGateway.getDocumentUrl = vi.fn(async () => unavailable(null, 'secret/path/internal error'))
    const { user } = await openDocument(dataGateway)
    await user.click(screen.getByRole('button', { name: 'Prepare PDF link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The private PDF link could not be prepared',
    )
    expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument()
    expect(screen.queryByText(/secret\/path/)).not.toBeInTheDocument()
  })

  it('removes the PDF URL at expiry and requires a fresh authorized lookup', async () => {
    const dataGateway = documentsGateway()
    dataGateway.getDocumentUrl = vi.fn(async () => result(pdfUrl, 'ready'))
    await openDocument(dataGateway)
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Prepare PDF link' }))
      })
      expect(screen.getByRole('link', { name: 'Open PDF' })).toBeVisible()
      await act(async () => {
        vi.advanceTimersByTime(240_000)
      })
      expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('expired')
      expect(dataGateway.getDocumentUrl).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stalled download request and prevents duplicate clicks', async () => {
    const dataGateway = documentsGateway()
    dataGateway.getDocumentUrl = vi.fn(
      () => new Promise<PartnerDataResult<string | null>>(() => {}),
    )
    await openDocument(dataGateway)
    vi.useFakeTimers()
    try {
      const button = screen.getByRole('button', { name: 'Prepare PDF link' })
      fireEvent.click(button)
      fireEvent.click(button)
      expect(button).toBeDisabled()
      await act(async () => {
        vi.advanceTimersByTime(15_000)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('could not be prepared')
      expect(dataGateway.getDocumentUrl).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: 'Prepare PDF link' })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a late private URL when the dialog has closed', async () => {
    let resolve!: (value: PartnerDataResult<string | null>) => void
    const dataGateway = documentsGateway()
    dataGateway.getDocumentUrl = () =>
      new Promise((done) => {
        resolve = done
      })
    const { user } = await openDocument(dataGateway)
    await user.click(screen.getByRole('button', { name: 'Prepare PDF link' }))
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await act(async () => {
      resolve(result(pdfUrl, 'ready'))
    })
    await user.click(screen.getByRole('button', { name: 'View BC Learn agreement, version 1' }))
    expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prepare PDF link' })).toBeVisible()
  })

  it('drops documents and any open private link immediately on sign-out', async () => {
    const dataGateway = documentsGateway()
    dataGateway.getDocumentUrl = async () => result(pdfUrl, 'ready')
    const { user, view } = await openDocument(dataGateway)
    await user.click(screen.getByRole('button', { name: 'Prepare PDF link' }))
    expect(await screen.findByRole('link', { name: 'Open PDF' })).toBeVisible()
    view.rerender(portal(dataGateway, 'profile', null))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument()
  })
})

describe('live partner links and sources', () => {
  it('shows a separate TEST main link and derives test campaigns from that exact parent', async () => {
    const user = userEvent.setup()
    const { dataGateway, createPartnerLink } = gateway()
    const testProduct: PartnerProduct = {
      ...product,
      trackingMode: 'commercial',
      testMainLinkId: 'test-main-link',
      testMainTrackingUrl: 'https://go.example.test/demo-product/creator/test',
    }
    dataGateway.getProducts = async () => result([testProduct], 'ready')
    const directory = await dataGateway.getLinkDirectory()
    dataGateway.getLinkDirectory = async () =>
      result({ ...directory.data, products: [testProduct] }, 'ready')
    dataGateway.getPartnerLinks = async () =>
      result([{ ...existingLink, environment: 'test' }], 'ready')
    renderPortal(dataGateway)
    expect(await screen.findByDisplayValue(testProduct.testMainTrackingUrl!)).toBeVisible()
    expect(screen.getByDisplayValue(product.mainTrackingUrl!)).toBeVisible()
    expect(within(screen.getByRole('row', { name: /TikTok bio/ })).getByText('TEST')).toBeVisible()
    expect(screen.getByText(/activity appears under Test in funnel reporting/)).toBeVisible()

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Copy test main link' }))
    expect(writeText).toHaveBeenCalledWith(testProduct.testMainTrackingUrl)

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Campaign link environment' }),
      'test',
    )
    await user.click(screen.getByRole('button', { name: 'Create tracked link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link name' }), 'Instagram test')
    await user.type(screen.getByRole('textbox', { name: /Link placement \(Sub 1/ }), 'test_bio')
    await user.click(screen.getByRole('button', { name: 'Create test link' }))
    expect(createPartnerLink).toHaveBeenCalledWith(
      expect.objectContaining({ parentLinkId: 'test-main-link' }),
    )
  })

  it('allows a TEST campaign when only the TEST main link has been issued', async () => {
    const user = userEvent.setup()
    const { dataGateway } = gateway()
    const testProduct: PartnerProduct = {
      ...product,
      trackingMode: 'commercial',
      mainLinkId: null,
      mainTrackingUrl: null,
      testMainLinkId: 'test-main-only',
      testMainTrackingUrl: 'https://go.example.test/demo/creator/test',
    }
    dataGateway.getProducts = async () => result([testProduct], 'ready')
    const directory = await dataGateway.getLinkDirectory()
    dataGateway.getLinkDirectory = async () =>
      result({ ...directory.data, products: [testProduct] }, 'ready')
    renderPortal(dataGateway)
    await screen.findByDisplayValue(testProduct.testMainTrackingUrl!)
    expect(screen.getByRole('button', { name: 'Create tracked link' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Campaign link environment' })).toHaveValue('test')
    await user.click(screen.getByRole('button', { name: 'Create tracked link' }))
    expect(screen.getByRole('button', { name: 'Create test link' })).toBeVisible()
  })

  it('explains tracking labels, examples and optional fields without prefilling or creating a link', async () => {
    const user = userEvent.setup()
    const { dataGateway, createPartnerLink } = gateway()
    renderPortal(dataGateway)
    await user.click(await screen.findByRole('button', { name: 'Create tracked link' }))

    const placement = screen.getByRole('textbox', { name: 'Link placement (Sub 1 · required)' })
    const position = screen.getByRole('textbox', { name: 'Position (Sub 2 · optional)' })
    const content = screen.getByRole('textbox', { name: 'Content version (Sub 3 · optional)' })
    expect(placement).toBeRequired()
    expect(position).not.toBeRequired()
    expect(content).not.toBeRequired()
    for (const input of [placement, position, content]) {
      expect(input).toHaveValue('')
      expect(input).toHaveAccessibleDescription(/1–64 letters, numbers, hyphens or underscores/)
      expect(input).toHaveAccessibleDescription(/No spaces or personal data/)
    }
    expect(placement).toHaveAttribute('placeholder', 'e.g. profile_bio')
    expect(placement).toHaveAccessibleDescription(/Where will you share this link/)
    expect(position).toHaveAttribute('placeholder', 'e.g. link_1')
    expect(position).toHaveAccessibleDescription(/story_slide_2.*leave blank/)
    expect(content).toHaveAttribute('placeholder', 'e.g. video_01')
    expect(content).toHaveAccessibleDescription(/video_01 or creative_a, or leave blank/)
    expect(screen.getByText(/These are not IDs you need from TikTok or Instagram/)).toBeVisible()
    expect(screen.getByText(/sharing the same link keeps the same labels/)).toBeVisible()
    expect(screen.getByText(/and leave Position and Content version blank/)).toBeVisible()
    expect(createPartnerLink).not.toHaveBeenCalled()
  })

  it.each([
    ['Link placement (Sub 1 · required)', ''],
    ['Position (Sub 2 · optional)', 'invalid position'],
    ['Content version (Sub 3 · optional)', 'invalid/content'],
  ])('preserves validation and accessible guidance for %s', async (label, invalidValue) => {
    const user = userEvent.setup()
    const { dataGateway, createPartnerLink } = gateway()
    renderPortal(dataGateway)
    await user.click(await screen.findByRole('button', { name: 'Create tracked link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link name' }), 'TikTok test')
    const placement = screen.getByRole('textbox', { name: 'Link placement (Sub 1 · required)' })
    if (invalidValue) await user.type(placement, 'profile_bio')
    const invalidInput = screen.getByRole('textbox', { name: label })
    if (invalidValue) await user.type(invalidInput, invalidValue)
    await user.click(screen.getByRole('button', { name: 'Create live link' }))

    expect(invalidInput).toHaveFocus()
    expect(invalidInput).toHaveAttribute('aria-invalid', 'true')
    expect(invalidInput).toHaveAccessibleDescription(
      /1–64 letters, numbers, hyphens, or underscores/,
    )
    expect(invalidInput).toHaveAccessibleDescription(/No spaces or personal data/)
    expect(createPartnerLink).not.toHaveBeenCalled()
  })

  it('shows only real server links, attribution dimensions and non-commercial scope', async () => {
    const user = userEvent.setup()
    const { dataGateway } = gateway()
    renderPortal(dataGateway)

    expect(await screen.findByDisplayValue(product.mainTrackingUrl!)).toBeVisible()
    expect(screen.getAllByText('Tracking-only demo').length).toBeGreaterThan(0)
    expect(screen.getByText(/Purchases, earnings and payouts are unavailable/)).toBeVisible()

    const row = screen.getByRole('row', { name: /TikTok bio/ })
    expect(within(row).getByText(/TikTok · Demo launch · Placement: profile-bio/)).toBeVisible()
    expect(within(row).getByText('7')).toBeVisible()
    expect(within(row).getByText('Demo · non-commercial')).toBeVisible()
    expect(within(row).getByDisplayValue(existingLink.trackingUrl)).toBeVisible()

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Copy main link' }))
    expect(writeText).toHaveBeenCalledWith(product.mainTrackingUrl)
    expect(await screen.findByText('Main link copied.')).toBeVisible()
  })

  it('creates a derived source link with the exact current main parent', async () => {
    const user = userEvent.setup()
    const { dataGateway, createPartnerLink } = gateway()
    renderPortal(dataGateway)

    const createToggle = await screen.findByRole('button', { name: 'Create tracked link' })
    await user.click(createToggle)
    const nameInput = screen.getByRole('textbox', { name: 'Link name' })
    await waitFor(() => expect(nameInput).toHaveFocus())
    expect(createToggle).toHaveAttribute('aria-expanded', 'true')
    await user.type(nameInput, 'Instagram bio')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Traffic source' }),
      'source-instagram',
    )
    await user.type(screen.getByRole('textbox', { name: /Link placement \(Sub 1/ }), 'profile-link')
    await user.click(screen.getByRole('button', { name: 'Create live link' }))

    await waitFor(() => expect(createPartnerLink).toHaveBeenCalledOnce())
    expect(createPartnerLink).toHaveBeenCalledWith({
      name: 'Instagram bio',
      productId: product.id,
      funnelId: 'funnel-demo',
      sourceId: 'source-instagram',
      campaignId: null,
      sub1: 'profile-link',
      sub2: '',
      sub3: '',
      parentLinkId: product.mainLinkId,
    })
    expect(await screen.findByRole('row', { name: /Instagram bio/ })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Instagram bio created. Its server-issued URL is ready to copy.',
    )
    await waitFor(() => expect(createToggle).toHaveFocus())
    expect(createToggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps unavailable link resources distinct from a known empty history and retries', async () => {
    const user = userEvent.setup()
    const { dataGateway } = gateway()
    const getPartnerLinks = vi.fn(async () =>
      unavailable<PartnerLink[]>([], 'Link history could not be verified.'),
    )
    dataGateway.getPartnerLinks = getPartnerLinks
    renderPortal(dataGateway)

    expect(
      await screen.findByRole('heading', { name: 'Links and sources are temporarily unavailable' }),
    ).toBeVisible()
    expect(screen.getByText('Link history could not be verified.')).toBeVisible()
    expect(screen.queryByText(/0 server-issued variants/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No source links yet' })).not.toBeInTheDocument()
    expect(screen.queryByText(/current main link, live funnel/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry links and sources' }))
    await waitFor(() => expect(getPartnerLinks).toHaveBeenCalledTimes(2))
  })

  it('never presents demo purchases, earnings or payouts as zero-value commercial facts', async () => {
    const { dataGateway } = gateway()
    const getDashboardTrends = vi.fn(async () =>
      result(
        [
          trendPoint({ key: 'tiktok', label: 'TikTok' }, '2026-08-30', {
            clicks: 5,
            funnelStarts: 2,
            paymentViews: 1,
            appStoreClicks: 0,
          }),
          trendPoint({ key: 'tiktok', label: 'TikTok' }, '2026-08-31', {
            clicks: 4,
            funnelStarts: 1,
            paymentViews: 1,
            appStoreClicks: 1,
          }),
          trendPoint({ key: 'instagram', label: 'Instagram' }, '2026-08-31', {
            clicks: 3,
            funnelStarts: 1,
            paymentViews: 1,
            appStoreClicks: 1,
          }),
        ],
        'ready',
      ),
    )
    dataGateway.getDashboardTrends = getDashboardTrends
    dataGateway.getDashboardSummary = async () => {
      const summary = emptyPartnerDashboardSummary()
      return result(
        {
          ...summary,
          hasData: true,
          metrics: {
            ...summary.metrics,
            clicks: 12,
            funnelStarts: 4,
            paymentViews: 3,
            appStoreClicks: 2,
          },
        },
        'ready',
      )
    }

    const performance = renderPortal(dataGateway, 'performance')
    const summaryGrid = await waitFor(() => {
      const element = performance.container.querySelector('.live-demo-summary-grid')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(within(summaryGrid).getByText('12')).toBeVisible()
    expect(within(summaryGrid).getByText('4')).toBeVisible()
    expect(within(summaryGrid).getByText('3')).toBeVisible()
    expect(within(summaryGrid).getByText('2')).toBeVisible()
    const tiktok = screen.getByRole('row', { name: /TikTok/ })
    expect(within(tiktok).getByText('9')).toBeVisible()
    expect(within(tiktok).getByText('3')).toBeVisible()
    expect(within(tiktok).getByText('2')).toBeVisible()
    expect(within(tiktok).getByText('1')).toBeVisible()
    expect(getDashboardTrends).toHaveBeenCalledWith(
      expect.objectContaining({ breakdown: 'source' }),
    )
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    performance.unmount()

    renderPortal(dataGateway, 'payouts')
    expect(
      await screen.findByRole('heading', { name: 'Payouts are unavailable for demo traffic' }),
    ).toBeVisible()
    expect(
      screen.getByText(/can never qualify for purchases, earnings, statements or payouts/),
    ).toBeVisible()
  })
})

it.each(['victory', 'анна-иванова', '王小明'])(
  'shows and copies readable creator and campaign URLs for %s without raw IDs',
  async (handle) => {
    const user = userEvent.setup()
    const { dataGateway } = gateway()
    const mainUrl = `https://go.kissmyapps.dev/speaksix-marathon/${handle}`
    const campaignUrl = `${mainUrl}/tiktok`
    const prettyProduct = { ...product, mainTrackingUrl: mainUrl }
    dataGateway.getProducts = async () => result([prettyProduct], 'ready')
    const originalDirectory = dataGateway.getLinkDirectory
    dataGateway.getLinkDirectory = async () => {
      const response = await originalDirectory()
      return { ...response, data: { ...response.data, products: [prettyProduct] } }
    }
    dataGateway.getPartnerLinks = async () =>
      result([{ ...existingLink, trackingUrl: campaignUrl }], 'ready')
    renderPortal(dataGateway)
    expect(await screen.findByRole('textbox', { name: 'Main tracking URL' })).toHaveValue(mainUrl)
    expect(screen.getByDisplayValue(campaignUrl)).toBeVisible()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Copy main link' }))
    await user.click(screen.getByRole('button', { name: 'Copy TikTok bio tracking link' }))
    expect(writeText).toHaveBeenNthCalledWith(1, mainUrl)
    expect(writeText).toHaveBeenNthCalledWith(2, campaignUrl)
  },
)
