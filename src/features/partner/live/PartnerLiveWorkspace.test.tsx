import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerLink,
  type PartnerProfile,
} from '../api'
import { PartnerLiveWorkspaceProvider } from './PartnerLiveWorkspace'
import type { PartnerLiveReportingQuery } from './types'
import { usePartnerLiveWorkspace } from './usePartnerLiveWorkspace'

const reporting: PartnerLiveReportingQuery = {
  startsOn: '2026-08-01',
  endsOn: '2026-08-27',
  timezone: 'Africa/Lagos',
  grain: 'day',
  breakdown: 'date',
}

const notifications = {
  statements: true,
  payouts: true,
  verification: true,
  signatures: true,
  adjustments: true,
  inactiveLinks: true,
}

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
  notifications,
}

const product = {
  id: 'product-1',
  slug: 'first-product',
  name: 'First product',
  status: 'active' as const,
  trackingMode: 'commercial' as const,
  agreementStatus: 'active' as const,
  commercialModel: 'revenue_share' as const,
  payoutCurrency: 'USD',
  hasLiveFunnel: true,
  mainLinkId: 'main-link-1',
  mainTrackingUrl: 'https://go.example.test/r/first-product',
}

const pausedProduct = {
  ...product,
  id: 'product-paused',
  slug: 'paused-product',
  name: 'A paused product',
  status: 'paused' as const,
  hasLiveFunnel: false,
  mainTrackingUrl: null,
}

const link: PartnerLink = {
  id: 'link-1',
  name: 'Newsletter link',
  productId: product.id,
  productName: product.name,
  productSlug: product.slug,
  funnelId: 'funnel-1',
  funnelName: 'Main funnel',
  sourceId: null,
  sourceName: null,
  campaignId: null,
  campaignName: null,
  sub1: 'weekly',
  sub2: '',
  sub3: '',
  status: 'active',
  trackingUrl: 'https://go.example.test/r/trusted-link',
  parentLinkId: null,
  commercialEligible: true,
  clicks: 0,
  leads: 0,
  installs: null,
  purchases: 0,
  earningsMinor: 0,
  currency: 'USD',
  createdAt: '2026-08-27T10:00:00Z',
}

function dataResult<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

function liveGateway() {
  const getProducts = vi.fn(async () => dataResult([pausedProduct, product], 'ready'))
  const createPartnerLink = vi.fn(async () => dataResult<PartnerLink | null>(link, 'ready'))
  const updatePartnerLink = vi.fn(async (_linkId: string) =>
    dataResult<PartnerLink | null>({ ...link, name: 'Updated link' }, 'ready'),
  )
  const setPartnerLinkStatus = vi.fn(async (_linkId: string, status: PartnerLink['status']) =>
    dataResult<PartnerLink | null>({ ...link, name: 'Updated link', status }, 'ready'),
  )
  const updatePartnerProfile = vi.fn(async () =>
    dataResult<PartnerProfile | null>({ ...profile, publicName: 'Updated Studio' }, 'ready'),
  )
  const updatePartnerSettings = vi.fn(async () =>
    dataResult<PartnerProfile | null>(
      {
        ...profile,
        publicName: 'Updated Studio',
        notifications: { ...notifications, payouts: false },
      },
      'ready',
    ),
  )
  const getPayoutDetail = vi.fn(async () => dataResult(null, 'empty'))
  const getPayoutSummary = vi.fn(async (_productId?: string | null) =>
    dataResult(emptyPartnerPayoutSummary(), 'empty'),
  )
  const gateway: PartnerDataGateway = {
    getCurrentPartnerProfile: async () => dataResult(profile, 'ready'),
    getDashboardSummary: async () => dataResult(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => dataResult([], 'empty'),
    getProducts,
    getLinkDirectory: async () =>
      dataResult(
        {
          products: [pausedProduct, product],
          funnels: [
            {
              id: 'funnel-1',
              kind: 'funnel',
              productId: product.id,
              key: 'main',
              name: 'Main funnel',
              available: true,
            },
          ],
          sources: [],
          campaigns: [],
        },
        'ready',
      ),
    getPartnerLinks: async () => dataResult([], 'empty'),
    createPartnerLink,
    updatePartnerLink,
    setPartnerLinkStatus,
    getPayoutSummary,
    getPayoutHistory: async () => dataResult([], 'empty'),
    getPayoutDetail,
    getDocuments: async () => dataResult([], 'empty'),
    getAgreements: async () => dataResult([], 'empty'),
    updatePartnerProfile,
    updatePartnerSettings,
  }
  return {
    gateway,
    getProducts,
    createPartnerLink,
    updatePartnerLink,
    setPartnerLinkStatus,
    updatePartnerProfile,
    updatePartnerSettings,
    getPayoutDetail,
    getPayoutSummary,
  }
}

function wrapper(gateway: PartnerDataGateway, sessionUserId: string | null = 'user-1') {
  return function LiveWorkspaceTestProvider({ children }: { children: ReactNode }) {
    return (
      <PartnerLiveWorkspaceProvider
        client={null}
        gateway={gateway}
        sessionUserId={sessionUserId}
        reporting={reporting}
      >
        {children}
      </PartnerLiveWorkspaceProvider>
    )
  }
}

describe('PartnerLiveWorkspaceProvider', () => {
  it('does not call partner data endpoints without an authenticated session', async () => {
    const testGateway = liveGateway()
    const { result } = renderHook(() => usePartnerLiveWorkspace(), {
      wrapper: wrapper(testGateway.gateway, null),
    })

    expect(result.current.snapshot.status).toBe('error')
    expect(result.current.snapshot.errors).toEqual([
      {
        code: 'not_authenticated',
        message: 'Sign in to access partner data.',
        retryable: false,
      },
    ])
    await act(async () => Promise.resolve())
    expect(testGateway.getProducts).not.toHaveBeenCalled()
  })

  it('represents a missing client as unconfigured without attempting network access', () => {
    const MissingClientProvider = ({ children }: { children: ReactNode }) => (
      <PartnerLiveWorkspaceProvider client={null} sessionUserId="user-1" reporting={reporting}>
        {children}
      </PartnerLiveWorkspaceProvider>
    )
    const { result } = renderHook(() => usePartnerLiveWorkspace(), {
      wrapper: MissingClientProvider,
    })

    expect(result.current.snapshot.status).toBe('unconfigured')
    expect(result.current.snapshot.errors[0]?.code).toBe('not_configured')
  })

  it('loads, selects the first eligible real product, and refreshes that scope', async () => {
    const testGateway = liveGateway()
    const { result } = renderHook(() => usePartnerLiveWorkspace(), {
      wrapper: wrapper(testGateway.gateway),
    })

    expect(result.current.snapshot.status).toBe('loading')
    await waitFor(() => {
      expect(result.current.selectedProductId).toBe(product.id)
      expect(result.current.snapshot.status).toBe('ready')
    })
    expect(result.current.snapshot.resources.products.data).toEqual([pausedProduct, product])
    expect(testGateway.getPayoutSummary).toHaveBeenCalledWith(product.id)
    expect(testGateway.getPayoutSummary).not.toHaveBeenCalledWith(null)
    expect(result.current.snapshot.availability.funnels).toBe('available')

    const callCount = testGateway.getProducts.mock.calls.length
    act(() => result.current.actions.refresh())
    await waitFor(() =>
      expect(testGateway.getProducts.mock.calls.length).toBeGreaterThan(callCount),
    )
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
  })

  it('resets selection, mutations, and visible data when the authenticated user changes', async () => {
    const testGateway = liveGateway()
    const Probe = () => {
      const value = usePartnerLiveWorkspace()
      return (
        <div>
          <span data-testid="session-workspace-status">{value.snapshot.status}</span>
          <span data-testid="session-product">{value.selectedProductId ?? 'none'}</span>
          <span data-testid="session-mutation">{value.mutation.status}</span>
          <span data-testid="session-profile">
            {value.snapshot.resources.profile.data?.publicName ?? 'none'}
          </span>
          <button onClick={() => void value.actions.loadPayoutDetail('payout-1')}>Mutate</button>
        </div>
      )
    }
    const portal = (sessionUserId: string) => (
      <PartnerLiveWorkspaceProvider
        client={null}
        gateway={testGateway.gateway}
        sessionUserId={sessionUserId}
        reporting={reporting}
      >
        <Probe />
      </PartnerLiveWorkspaceProvider>
    )
    const view = render(portal('user-1'))
    await waitFor(() =>
      expect(screen.getByTestId('session-workspace-status')).toHaveTextContent('ready'),
    )
    expect(screen.getByTestId('session-product')).toHaveTextContent(product.id)

    fireEvent.click(screen.getByRole('button', { name: 'Mutate' }))
    await waitFor(() =>
      expect(screen.getByTestId('session-mutation')).toHaveTextContent('complete'),
    )

    view.rerender(portal('user-2'))
    expect(screen.getByTestId('session-product')).toHaveTextContent('none')
    expect(screen.getByTestId('session-mutation')).toHaveTextContent('idle')
    expect(screen.getByTestId('session-workspace-status')).toHaveTextContent('loading')
    expect(screen.getByTestId('session-profile')).toHaveTextContent('none')

    await waitFor(() => expect(screen.getByTestId('session-product')).toHaveTextContent(product.id))
    await waitFor(() =>
      expect(screen.getByTestId('session-workspace-status')).toHaveTextContent('ready'),
    )
  })

  it('applies trusted mutation responses without manufacturing missing metrics', async () => {
    const testGateway = liveGateway()
    const { result } = renderHook(() => usePartnerLiveWorkspace(), {
      wrapper: wrapper(testGateway.gateway),
    })
    await waitFor(() => expect(result.current.selectedProductId).toBe(product.id))
    await waitFor(() => expect(result.current.snapshot.status).toBe('ready'))

    await act(async () => {
      await result.current.actions.createLink({
        name: link.name,
        productId: product.id,
        funnelId: link.funnelId,
        sourceId: null,
        campaignId: null,
        sub1: link.sub1,
        sub2: '',
        sub3: '',
      })
    })
    expect(result.current.snapshot.resources.links.data).toEqual([link])
    expect(result.current.snapshot.resources.links.data[0]?.installs).toBeNull()

    await act(async () => {
      await result.current.actions.updateLink(link.id, { name: 'Updated link' })
      await result.current.actions.setLinkStatus(link.id, 'paused')
    })
    expect(result.current.snapshot.resources.links.data[0]).toMatchObject({
      name: 'Updated link',
      status: 'paused',
      installs: null,
    })

    await act(async () => {
      await result.current.actions.updateProfile({
        fullName: profile.fullName,
        publicName: 'Updated Studio',
        legalName: profile.legalName,
        entityType: 'Company',
        countryCode: 'NG',
        timezone: profile.timezone,
        preferredCurrency: profile.preferredCurrency,
        website: null,
        category: null,
        audienceDescription: null,
        audienceCountries: [],
        channels: [],
        channelDetails: null,
      })
      await result.current.actions.updateSettings({
        notifications: { ...notifications, payouts: false },
      })
    })
    expect(result.current.snapshot.resources.profile.data).toMatchObject({
      publicName: 'Updated Studio',
      notifications: { payouts: false },
    })

    let payoutResult: Awaited<ReturnType<typeof result.current.actions.loadPayoutDetail>> | null =
      null
    await act(async () => {
      payoutResult = await result.current.actions.loadPayoutDetail('payout-1')
    })
    expect(payoutResult).toEqual({ detail: null, status: 'empty', error: null })
    expect(testGateway.createPartnerLink).toHaveBeenCalledOnce()
    expect(testGateway.updatePartnerLink).toHaveBeenCalledOnce()
    expect(testGateway.setPartnerLinkStatus).toHaveBeenCalledOnce()
    expect(testGateway.updatePartnerProfile).toHaveBeenCalledOnce()
    expect(testGateway.updatePartnerSettings).toHaveBeenCalledOnce()
    expect(testGateway.getPayoutDetail).toHaveBeenCalledOnce()
    expect(result.current.mutation).toMatchObject({
      status: 'complete',
      operation: 'load-payout-detail',
    })
  })
})
