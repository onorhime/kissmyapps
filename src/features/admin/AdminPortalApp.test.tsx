import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminGateway } from './api'
import type {
  AdminAffiliateDirectoryPage,
  AdminAffiliateDirectorySummary,
  AdminContext,
  AdminDataResult,
  AdminGateway,
  AdminProduct,
  AdminProductConfiguration,
} from './api'
import { AdminPortalApp } from './AdminPortalApp'

const context: AdminContext = {
  userId: 'admin-1',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const emptyProducts: AdminDataResult<AdminProduct[]> = {
  data: [],
  status: 'empty',
  error: null,
}

const product: AdminProduct = {
  id: 'product-planner',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'draft',
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
}

const productConfiguration: AdminProductConfiguration = {
  product,
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
  billingOffers: [],
  mainLinks: [],
}

function gatewayWith(
  contextResult: AdminDataResult<AdminContext | null> = {
    data: context,
    status: 'ready',
    error: null,
  },
  productsResult: AdminDataResult<AdminProduct[]> = emptyProducts,
): AdminGateway {
  return {
    getAdminContext: vi.fn(async () => contextResult),
    getProducts: vi.fn(async () => productsResult),
    createProduct: vi.fn(async (): Promise<AdminDataResult<AdminProduct | null>> => ({
      data: null,
      status: 'error',
      error: {
        code: 'temporarily_unavailable',
        message: 'Admin data is temporarily unavailable.',
        retryable: true,
      },
    })),
  }
}

function affiliateGatewayWith(): AdminGateway {
  const gateway = gatewayWith()
  const summary: AdminAffiliateDirectorySummary = {
    totalCount: 0,
    draftCount: 0,
    invitedCount: 0,
    activeCount: 0,
    pausedCount: 0,
    terminatedCount: 0,
    pendingConfirmationCount: 0,
    pendingActivationCount: 0,
  }
  const directory: AdminAffiliateDirectoryPage = { items: [], totalCount: 0 }
  const summaryResult: AdminDataResult<AdminAffiliateDirectorySummary | null> = {
    data: summary,
    status: 'ready',
    error: null,
  }
  const directoryResult: AdminDataResult<AdminAffiliateDirectoryPage | null> = {
    data: directory,
    status: 'empty',
    error: null,
  }
  return {
    ...gateway,
    getAffiliateSummary: vi.fn(async () => summaryResult),
    getAffiliateDirectory: vi.fn(async () => directoryResult),
    getAffiliateDetail: vi.fn(),
    setAffiliateStatus: vi.fn(),
    terminateAffiliate: vi.fn(),
  }
}

function renderPortal(overrides: Partial<React.ComponentProps<typeof AdminPortalApp>> = {}) {
  const props: React.ComponentProps<typeof AdminPortalApp> = {
    route: 'overview',
    sessionUserId: 'admin-1',
    gateway: gatewayWith(),
    identity: { name: 'Fallback Admin', email: 'fallback@example.test' },
    onNavigate: vi.fn(),
    onOpenProductConfiguration: vi.fn(),
    onSignOut: vi.fn(),
    onSwitchToPartner: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdminPortalApp {...props} />), props }
}

describe('Admin portal shell', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the complete navigation with routing and observability enabled', async () => {
    const { props } = renderPortal()
    await screen.findByRole('heading', { name: 'Overview' })
    const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })

    expect(within(navigation).getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(navigation).getByRole('button', { name: 'Products' })).toBeEnabled()
    expect(within(navigation).getByRole('button', { name: 'Affiliates' })).toBeEnabled()
    expect(within(navigation).getByRole('button', { name: 'Funnels & Links' })).toBeEnabled()
    expect(within(navigation).getByRole('button', { name: 'Attribution' })).toBeEnabled()
    expect(within(navigation).getByRole('button', { name: 'Data Health' })).toBeEnabled()
    expect(within(navigation).getAllByText('Upcoming')).toHaveLength(4)
    expect(screen.getByText('Kissmyapps')).toBeVisible()
    expect(screen.getByText('Admin', { selector: '.brand-context' })).toBeVisible()

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Products' }))
    expect(props.onNavigate).toHaveBeenCalledWith('products')

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Affiliates' }))
    expect(props.onNavigate).toHaveBeenCalledWith('affiliates')

    await userEvent
      .setup()
      .click(within(navigation).getByRole('button', { name: 'Funnels & Links' }))
    expect(props.onNavigate).toHaveBeenCalledWith('funnels-links')

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Attribution' }))
    expect(props.onNavigate).toHaveBeenCalledWith('attribution')

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Data Health' }))
    expect(props.onNavigate).toHaveBeenCalledWith('data-health')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Menu' }))
    const mobileNavigation = screen.getByRole('navigation', { name: 'Mobile admin navigation' })
    expect(within(mobileNavigation).getByRole('button', { name: 'Funnels & Links' })).toBeEnabled()
    expect(within(mobileNavigation).getByRole('button', { name: 'Attribution' })).toBeEnabled()
    expect(within(mobileNavigation).getByRole('button', { name: 'Data Health' })).toBeEnabled()
    expect(
      within(mobileNavigation).getByRole('button', { name: 'Switch to Partner' }),
    ).toBeEnabled()
  })

  it.each([
    ['attribution', 'Attribution'],
    ['data-health', 'Data Health'],
  ] as const)('marks %s active in desktop and mobile navigation', async (route, label) => {
    renderPortal({ route })

    const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })
    expect(within(navigation).getByRole('button', { name: label })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByText(label, { selector: '.admin-breadcrumb strong' })).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Menu' }))
    expect(
      within(screen.getByRole('navigation', { name: 'Mobile admin navigation' })).getByRole(
        'button',
        { name: label },
      ),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('marks Funnels & Links active in desktop and mobile navigation', async () => {
    renderPortal({ route: 'funnels-links' })

    const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })
    expect(within(navigation).getByRole('button', { name: 'Funnels & Links' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      screen.getByText('Funnels & Links', { selector: '.admin-breadcrumb strong' }),
    ).toBeVisible()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Menu' }))
    expect(
      within(screen.getByRole('navigation', { name: 'Mobile admin navigation' })).getByRole(
        'button',
        { name: 'Funnels & Links' },
      ),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('uses the imported default gateway for a non-empty Funnels & Links route', async () => {
    const contextReader = vi.spyOn(adminGateway, 'getAdminContext').mockResolvedValue({
      data: context,
      status: 'ready',
      error: null,
    })
    const productsReader = vi.spyOn(adminGateway, 'getProducts').mockResolvedValue({
      data: [product],
      status: 'ready',
      error: null,
    })
    const configurationReader = vi
      .spyOn(adminGateway, 'getProductConfiguration')
      .mockResolvedValue({ data: productConfiguration, status: 'ready', error: null })

    renderPortal({ route: 'funnels-links', gateway: undefined })

    expect(await screen.findByRole('heading', { name: 'Product routing overview' })).toBeVisible()
    expect(screen.getAllByText('Daily Planner').length).toBeGreaterThan(0)
    expect(contextReader).toHaveBeenCalledOnce()
    expect(productsReader).toHaveBeenCalledOnce()
    expect(configurationReader).toHaveBeenCalledOnce()
    expect(configurationReader).toHaveBeenCalledWith(product.id)
  })

  it('restricts Funnels & Links for support without reading product configuration', async () => {
    const supportContext: AdminContext = { ...context, role: 'support' }
    const gateway = gatewayWith(
      { data: supportContext, status: 'ready', error: null },
      { data: [product], status: 'ready', error: null },
    )
    const configurationReader = vi.fn(async () => ({
      data: productConfiguration,
      status: 'ready' as const,
      error: null,
    }))
    gateway.getProductConfiguration = configurationReader
    const { props } = renderPortal({ route: 'funnels-links', gateway })

    expect(
      await screen.findByRole('heading', { name: 'Funnels & Links access restricted' }),
    ).toBeVisible()
    expect(
      screen.getByText(/Support accounts cannot access protected product routing/i),
    ).toBeVisible()
    expect(configurationReader).not.toHaveBeenCalled()

    const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })
    expect(within(navigation).queryByRole('button', { name: 'Funnels & Links' })).toBeNull()
    const desktopRestrictedLabel = within(navigation).getByText('Funnels & Links')
    expect(desktopRestrictedLabel.closest('[aria-disabled="true"]')).toHaveTextContent('Restricted')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Menu' }))
    const mobileNavigation = screen.getByRole('navigation', { name: 'Mobile admin navigation' })
    expect(within(mobileNavigation).queryByRole('button', { name: 'Funnels & Links' })).toBeNull()
    expect(
      within(mobileNavigation)
        .getByText(/Funnels & Links/)
        .closest('[aria-disabled="true"]'),
    ).toHaveTextContent('Restricted')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Overview' }))
    expect(props.onNavigate).toHaveBeenCalledWith('overview')
  })

  it.each([
    ['attribution', 'getAttributionOverview'],
    ['data-health', 'getDataHealth'],
  ] as const)(
    'restricts %s for support without reading aggregate evidence',
    async (route, method) => {
      const supportContext: AdminContext = { ...context, role: 'support' }
      const reader = vi.fn()
      const gateway = {
        ...gatewayWith(
          { data: supportContext, status: 'ready', error: null },
          { data: [product], status: 'ready', error: null },
        ),
        getAttributionOverview: method === 'getAttributionOverview' ? reader : vi.fn(),
        getDataHealth: method === 'getDataHealth' ? reader : vi.fn(),
      }

      renderPortal({ route, gateway })

      expect(
        await screen.findByRole('heading', { name: 'Operational reporting access restricted' }),
      ).toBeVisible()
      expect(reader).not.toHaveBeenCalled()
      const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })
      const label = route === 'attribution' ? 'Attribution' : 'Data Health'
      expect(within(navigation).queryByRole('button', { name: label })).toBeNull()
      expect(
        within(navigation).getByText(label).closest('[aria-disabled="true"]'),
      ).toHaveTextContent('Restricted')
    },
  )

  it('does not call admin data while unauthenticated', () => {
    const gateway = gatewayWith()
    renderPortal({ gateway, sessionUserId: null })

    expect(screen.getByRole('heading', { name: 'Admin sign-in required' })).toBeVisible()
    expect(gateway.getAdminContext).not.toHaveBeenCalled()
    expect(gateway.getProducts).not.toHaveBeenCalled()
  })

  it('shows loading and then a protected unauthorized state without requesting products', async () => {
    let resolveContext: ((result: AdminDataResult<AdminContext | null>) => void) | undefined
    const contextPromise = new Promise<AdminDataResult<AdminContext | null>>((resolve) => {
      resolveContext = resolve
    })
    const gateway: AdminGateway = {
      getAdminContext: vi.fn(() => contextPromise),
      getProducts: vi.fn(async () => emptyProducts),
      createProduct: vi.fn(),
    }
    renderPortal({ gateway })

    expect(screen.getByRole('heading', { name: 'Checking admin access' })).toBeVisible()
    resolveContext?.({
      data: null,
      status: 'unauthorized',
      error: {
        code: 'not_authorized',
        message: 'This account does not have permission to use the admin workspace.',
        retryable: false,
      },
    })

    expect(await screen.findByRole('heading', { name: 'Admin access required' })).toBeVisible()
    expect(gateway.getProducts).not.toHaveBeenCalled()
  })

  it.each([
    {
      status: 'unconfigured' as const,
      code: 'not_configured' as const,
      heading: 'Admin data is not configured',
      message: 'The admin data connection is not configured.',
    },
    {
      status: 'error' as const,
      code: 'temporarily_unavailable' as const,
      heading: 'Admin data is unavailable',
      message: 'Admin data is temporarily unavailable.',
    },
  ])('renders the $status contract state safely', async ({ status, code, heading, message }) => {
    renderPortal({
      gateway: gatewayWith({
        data: null,
        status,
        error: { code, message, retryable: status === 'error' },
      }),
    })

    expect(await screen.findByRole('heading', { name: heading })).toBeVisible()
    expect(screen.getByText(message)).toBeVisible()
  })

  it('contains callback failures and supports switching to the Partner workspace', async () => {
    const user = userEvent.setup()
    const onSwitchToPartner = vi.fn(async () => {
      throw new Error('raw routing and account internals')
    })
    const onSignOut = vi.fn(async () => {
      throw new Error('raw auth provider internals')
    })
    renderPortal({ onSwitchToPartner, onSignOut })
    await screen.findByRole('heading', { name: 'Overview' })

    await user.click(screen.getByRole('button', { name: 'Switch to Partner' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not switch workspaces. Please try again.',
    )
    expect(screen.queryByText(/raw routing/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'We could not sign you out. Please try again.',
      ),
    )
    expect(screen.queryByText(/raw auth/i)).not.toBeInTheDocument()
  })

  it('renders the empty Products route with no automated accessibility violations', async () => {
    const { container } = renderPortal({ route: 'products' })
    await screen.findByRole('heading', { name: 'Products', level: 1 })

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })

  it('renders the protected empty Affiliate directory route accessibly', async () => {
    const { container } = renderPortal({ route: 'affiliates', gateway: affiliateGatewayWith() })
    await screen.findByRole('heading', { name: 'Affiliate directory', level: 1 })

    expect(await screen.findByText('No affiliates yet')).toBeVisible()
    expect(
      within(screen.getByRole('navigation', { name: 'Admin navigation' })).getByRole('button', {
        name: 'Affiliates',
      }),
    ).toHaveAttribute('aria-current', 'page')
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})
