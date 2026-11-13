import { render, screen, waitFor, within } from '@testing-library/react'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../App'
import type { PartnerAuthService } from '../../auth/authService'
import type { AuthSessionState } from '../../auth/authSession'
import { useAuthSession } from '../../auth/authSession'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerProduct,
  type PartnerProfile,
} from '../api'
import { LivePartnerPortal } from '../live/LivePartnerPortal'
import { PartnerLiveWorkspaceProvider } from '../live/PartnerLiveWorkspace'
import type { PartnerLiveWorkspaceSnapshot } from '../live/types'
import { isLegacyProduct, legacyLinksKnown } from './legacyLinks'
import { linksBackendFixture as backend } from './links.fixture'
import { readProgramLinks } from './links'

/**
 * Where the program links sit on the Links page: on top, alone for a creator with no older
 * product, and above the older product links for a creator who has one. And what the page is
 * called in the navigation in each case.
 */

vi.mock('../../auth/authSession', () => ({ useAuthSession: vi.fn() }))

const profile: PartnerProfile = {
  email: 'ada@example.test',
  fullName: 'Ada Creator',
  publicName: 'Ada Creator',
  legalName: 'Ada Creator',
  entityType: 'Individual',
  countryCode: 'PT',
  timezone: 'Europe/Lisbon',
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

/** A product from before programs: the creator has their own agreement and main link for it. */
const olderProduct: PartnerProduct = {
  id: 'product-older',
  slug: 'older-product',
  name: 'Older product',
  status: 'active',
  trackingMode: 'commercial',
  agreementStatus: 'active',
  commercialModel: null,
  payoutCurrency: 'USD',
  hasLiveFunnel: true,
  mainLinkId: 'main-link-older',
  mainTrackingUrl: 'https://go.example.test/r/ada/older',
}

/** A program's own product as the product list gives it: no agreement, no main link. */
const programProduct: PartnerProduct = {
  id: 'product-speaksix',
  slug: 'speaksix',
  name: 'SpeakSix',
  status: 'active',
  trackingMode: 'commercial',
  agreementStatus: null,
  commercialModel: null,
  payoutCurrency: null,
  hasLiveFunnel: true,
  mainLinkId: null,
  mainTrackingUrl: null,
}

function result<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

function gatewayWith(products: PartnerProduct[], programLinks = true) {
  const getProgramLinks = vi.fn(async () => ({
    data: readProgramLinks(backend.partner_program_links),
    status: 'ready' as const,
    error: null,
  }))
  const gateway: PartnerDataGateway = {
    getCurrentPartnerProfile: async () => result(profile, 'ready'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    getProducts: async () => result(products, products.length ? 'ready' : 'empty'),
    getLinkDirectory: async () =>
      result({ products, funnels: [], sources: [], campaigns: [] }, 'ready'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    ...(programLinks ? { getProgramLinks } : {}),
  }
  return { gateway, getProgramLinks }
}

function renderLinks(gateway: PartnerDataGateway, onLegacyLinksChange?: (shown: boolean) => void) {
  return render(
    <PartnerLiveWorkspaceProvider
      gateway={gateway}
      client={null}
      sessionUserId="user-1"
      reporting={{
        startsOn: '2026-10-14',
        endsOn: '2026-11-13',
        timezone: 'Europe/Lisbon',
        grain: 'day',
        breakdown: 'source',
      }}
    >
      <LivePartnerPortal page="links" onLegacyLinksChange={onLegacyLinksChange} />
    </PartnerLiveWorkspaceProvider>,
  )
}

const headings = () =>
  screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)

describe('which products are older product links', () => {
  it('counts a product with its own agreement, a tracking-only one, or one with a main link', () => {
    expect(isLegacyProduct(olderProduct)).toBe(true)
    expect(isLegacyProduct({ ...programProduct, agreementStatus: 'awaiting_signature' })).toBe(true)
    expect(isLegacyProduct({ ...programProduct, trackingMode: 'tracking_only' })).toBe(true)
    expect(
      isLegacyProduct({ ...programProduct, mainTrackingUrl: 'https://go.example.test/r/a/b' }),
    ).toBe(true)
    expect(
      isLegacyProduct({ ...programProduct, testMainTrackingUrl: 'https://go.example.test/r/a/c' }),
    ).toBe(true)
  })

  it('does not count a program’s own product', () => {
    expect(isLegacyProduct(programProduct)).toBe(false)
  })

  it('is not known while products are read, and stays with the older page when they fail', () => {
    const snapshot = (
      status: PartnerLiveWorkspaceSnapshot['status'],
      productsStatus: PartnerLiveWorkspaceSnapshot['resources']['products']['status'],
      products: PartnerProduct[] = [],
    ) =>
      ({
        status,
        resources: { products: { data: products, status: productsStatus, error: null } },
      }) as unknown as Pick<PartnerLiveWorkspaceSnapshot, 'status' | 'resources'>

    expect(legacyLinksKnown(snapshot('loading', 'loading'))).toBeNull()
    expect(legacyLinksKnown(snapshot('ready', 'empty'))).toBe(false)
    expect(legacyLinksKnown(snapshot('ready', 'ready', [programProduct]))).toBe(false)
    expect(legacyLinksKnown(snapshot('ready', 'ready', [programProduct, olderProduct]))).toBe(true)
    expect(legacyLinksKnown(snapshot('error', 'error'))).toBe(true)
  })
})

describe('the Links page in the live dashboard', () => {
  it('is the program links alone for a creator with no older product', async () => {
    const { gateway, getProgramLinks } = gatewayWith([])
    const onChange = vi.fn()
    renderLinks(gateway, onChange)

    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    expect(headings()).toEqual(['Links.'])
    expect(
      screen.queryByRole('region', { name: 'Product and partnership context' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Links & Sources/)).not.toBeInTheDocument()
    expect(getProgramLinks).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(false)
    expect(onChange).not.toHaveBeenCalledWith(true)
  })

  it('is the program links alone when the only product is a program’s own', async () => {
    const { gateway } = gatewayWith([programProduct])
    const onChange = vi.fn()
    renderLinks(gateway, onChange)

    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(headings()).toEqual(['Links.'])
    expect(
      screen.queryByRole('region', { name: 'Product and partnership context' }),
    ).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalledWith(true)
  })

  it('puts the program links above the older product links for a creator who has both', async () => {
    const { gateway, getProgramLinks } = gatewayWith([olderProduct])
    const onChange = vi.fn()
    const { container } = renderLinks(gateway, onChange)

    const older = await screen.findByRole('region', { name: 'Product and partnership context' })
    const programs = await screen.findByRole('table', { name: 'Results by channel' })
    expect(headings()).toEqual(['Program links.', 'Links & Sources.'])
    // Program links first, the older page after them.
    expect(programs.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('.pl-page')).toBeInTheDocument()
    expect(within(older).getByRole('option', { name: /Older product/ })).toBeInTheDocument()
    expect(getProgramLinks).toHaveBeenCalledOnce()
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true))
  })

  it('leaves the older page as it was on a database from before program links', async () => {
    const { gateway } = gatewayWith([olderProduct], false)
    const { container } = renderLinks(gateway)

    const older = await screen.findByRole('region', { name: 'Product and partnership context' })
    expect(await within(older).findByRole('option', { name: /Older product/ })).toBeInTheDocument()
    expect(headings()).toEqual(['Links & Sources.'])
    expect(container.querySelector('.pl-page')).not.toBeInTheDocument()
    expect(screen.queryByText('Links are not available yet.')).not.toBeInTheDocument()
  })

  it('says links are not available yet when there is neither', async () => {
    const { gateway } = gatewayWith([], false)
    renderLinks(gateway)

    expect(await screen.findByText('Links are not available yet.')).toBeInTheDocument()
    expect(headings()).toEqual(['Links.'])
  })

  it('keeps the older page, with its own failure, when products could not be read', async () => {
    const { gateway } = gatewayWith([])
    gateway.getProducts = async () => ({
      data: [],
      status: 'error',
      error: {
        code: 'temporarily_unavailable',
        message: 'Products could not be read.',
        retryable: true,
      },
    })
    const onChange = vi.fn()
    renderLinks(gateway, onChange)

    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true))
    expect(headings()).toContain('Program links.')
    expect(screen.getByRole('heading', { name: 'Product data is unavailable' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry product data' })).toBeEnabled()
  })

  it('reads no program links on another page', async () => {
    const { gateway, getProgramLinks } = gatewayWith([olderProduct])
    render(
      <PartnerLiveWorkspaceProvider
        gateway={gateway}
        client={null}
        sessionUserId="user-1"
        reporting={{
          startsOn: '2026-10-14',
          endsOn: '2026-11-13',
          timezone: 'Europe/Lisbon',
          grain: 'day',
          breakdown: 'source',
        }}
      >
        <LivePartnerPortal page="payouts" />
      </PartnerLiveWorkspaceProvider>,
    )
    await screen.findByRole('heading', { level: 1 })
    expect(getProgramLinks).not.toHaveBeenCalled()
    expect(screen.queryByText('Program links.')).not.toBeInTheDocument()
  })
})

describe('what the Links page is called in the navigation', () => {
  const user = {
    id: 'partner-user',
    email: 'ada@example.test',
    user_metadata: { public_name: 'Ada Creator' },
  } as unknown as NonNullable<AuthSessionState['user']>
  const session = { user } as unknown as Session
  const authenticated: AuthSessionState = {
    status: 'authenticated',
    session,
    user,
    recoveryMode: false,
    message: null,
  }

  /** The dashboard only asks whether the account is active; nothing else is called here. */
  function authService(): PartnerAuthService {
    const calls = new Map<string, ReturnType<typeof vi.fn>>()
    return new Proxy({} as PartnerAuthService, {
      get(_target, name) {
        if (typeof name !== 'string' || name === 'then') return undefined
        if (!calls.has(name))
          calls.set(
            name,
            vi.fn().mockResolvedValue(name === 'getPartnerActivationStatus' ? 'active' : undefined),
          )
        return calls.get(name)
      },
    })
  }

  function openLinks(gateway: PartnerDataGateway) {
    window.history.replaceState(null, '', '/#links')
    return render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={authService()}
        partnerGateway={gateway}
      />,
    )
  }

  const linksEntry = () =>
    within(screen.getByRole('navigation', { name: 'Partner navigation' }))
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === '#links')!

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(useAuthSession).mockReturnValue(authenticated)
  })

  it('is "Links" for a creator with program links only', async () => {
    const { gateway } = gatewayWith([programProduct])
    const { container } = openLinks(gateway)

    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    expect(linksEntry()).toHaveTextContent(/^Links$/)
    expect(linksEntry()).toHaveAttribute('aria-current', 'page')
    expect(container.querySelector('.breadcrumb strong')).toHaveTextContent(/^Links$/)
    expect(headings()).toEqual(['Links.'])
  })

  it('is "Links & Sources" while the older product links are on the page', async () => {
    const { gateway } = gatewayWith([olderProduct])
    const { container } = openLinks(gateway)

    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    await waitFor(() => expect(linksEntry()).toHaveTextContent(/^Links & Sources$/))
    expect(container.querySelector('.breadcrumb strong')).toHaveTextContent(/^Links & Sources$/)
    expect(headings()).toEqual(['Program links.', 'Links & Sources.'])
  })
})
