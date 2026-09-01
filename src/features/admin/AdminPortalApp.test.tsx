import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminAffiliateDirectoryPage,
  AdminAffiliateDirectorySummary,
  AdminContext,
  AdminDataResult,
  AdminGateway,
  AdminProduct,
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
    onSignOut: vi.fn(),
    onSwitchToPartner: vi.fn(),
    ...overrides,
  }
  return { ...render(<AdminPortalApp {...props} />), props }
}

describe('Admin portal shell', () => {
  it('shows the complete P2 navigation with Overview, Products, and Affiliates enabled', async () => {
    const { props } = renderPortal()
    await screen.findByRole('heading', { name: 'Overview' })
    const navigation = screen.getByRole('navigation', { name: 'Admin navigation' })

    expect(within(navigation).getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(navigation).getByRole('button', { name: 'Products' })).toBeEnabled()
    expect(within(navigation).getByRole('button', { name: 'Affiliates' })).toBeEnabled()
    expect(within(navigation).getAllByText('Upcoming')).toHaveLength(7)
    expect(
      within(navigation).getByText('Funnels & Links').closest('[aria-disabled="true"]'),
    ).not.toBeNull()
    expect(
      within(navigation).queryByRole('button', { name: 'Funnels & Links' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Kissmyapps')).toBeVisible()
    expect(screen.getByText('Admin', { selector: '.brand-context' })).toBeVisible()

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Products' }))
    expect(props.onNavigate).toHaveBeenCalledWith('products')

    await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Affiliates' }))
    expect(props.onNavigate).toHaveBeenCalledWith('affiliates')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Menu' }))
    expect(
      within(screen.getByRole('navigation', { name: 'Mobile admin navigation' })).getByRole(
        'button',
        { name: 'Switch to Partner' },
      ),
    ).toBeEnabled()
  })

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

    expect(screen.getByText('No affiliates yet')).toBeVisible()
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
