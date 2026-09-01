import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
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

function renderPortal(dataGateway: PartnerDataGateway, page: PortalPage = 'links') {
  return render(
    <PartnerLiveWorkspaceProvider
      gateway={dataGateway}
      sessionUserId="user-1"
      reporting={{
        startsOn: '2026-08-01',
        endsOn: '2026-09-01',
        timezone: 'Africa/Lagos',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal page={page} />
    </PartnerLiveWorkspaceProvider>,
  )
}

describe('live partner links and sources', () => {
  it('shows only real server links, attribution dimensions and non-commercial scope', async () => {
    const user = userEvent.setup()
    const { dataGateway } = gateway()
    renderPortal(dataGateway)

    expect(await screen.findByDisplayValue(product.mainTrackingUrl!)).toBeVisible()
    expect(screen.getAllByText('Tracking-only demo').length).toBeGreaterThan(0)
    expect(screen.getByText(/Purchases, earnings and payouts are unavailable/)).toBeVisible()

    const row = screen.getByRole('row', { name: /TikTok bio/ })
    expect(within(row).getByText(/TikTok · Demo launch · Sub 1: profile-bio/)).toBeVisible()
    expect(within(row).getByText('7')).toBeVisible()
    expect(within(row).getByText('Demo · non-commercial')).toBeVisible()
    expect(within(row).getByDisplayValue(existingLink.trackingUrl)).toBeVisible()

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Copy main link' }))
    expect(writeText).toHaveBeenCalledWith(product.mainTrackingUrl)
    expect(screen.getByRole('status')).toHaveTextContent('Main link copied.')
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
    await user.type(screen.getByRole('textbox', { name: 'Sub 1' }), 'profile-link')
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
