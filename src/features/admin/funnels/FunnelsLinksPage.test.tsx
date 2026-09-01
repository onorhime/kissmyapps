import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminContext,
  AdminDataResult,
  AdminFunnel,
  AdminGateway,
  AdminMainLink,
  AdminProduct,
  AdminProductConfiguration,
} from '../api'
import { FunnelsLinksPage } from './FunnelsLinksPage'

const owner: AdminContext = {
  userId: 'admin-owner',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const planner: AdminProduct = {
  id: 'product-planner',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'active',
  trackingMode: 'commercial',
  trackingOnlyApprovedAt: null,
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-30T10:00:00.000Z',
}

const scanner: AdminProduct = {
  id: 'product-scanner',
  name: 'Scan PDF',
  slug: 'scan-pdf',
  status: 'draft',
  trackingMode: 'commercial',
  trackingOnlyApprovedAt: null,
  createdAt: '2026-08-29T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
}

function ready<T>(data: T): AdminDataResult<T> {
  return { data, status: 'ready', error: null }
}

function unavailable(
  message = 'raw provider host and stack details',
): AdminDataResult<AdminProductConfiguration | null> {
  return {
    data: null,
    status: 'error',
    error: {
      code: 'temporarily_unavailable',
      message,
      retryable: true,
    },
  }
}

function funnel(product: AdminProduct, overrides: Partial<AdminFunnel> = {}): AdminFunnel {
  return {
    id: `${product.id}-funnel-primary`,
    productId: product.id,
    key: 'primary',
    name: 'Primary checkout',
    destinationConfigured: true,
    destinationUrl: 'https://checkout.example.com/start?secret=provider-value#private',
    isDefault: true,
    status: 'live',
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    ...overrides,
  }
}

function mainLink(
  product: AdminProduct,
  funnelId: string,
  overrides: Partial<AdminMainLink> = {},
): AdminMainLink {
  return {
    id: `${product.id}-link-main`,
    affiliateId: 'affiliate-creator',
    productId: product.id,
    funnelId,
    name: `${product.name} · Main`,
    publicCode: 'public-code',
    trackingUrl: `https://go.example.com/r/creator/${product.slug}`,
    status: 'active',
    createdAt: product.updatedAt,
    partnerName: 'Creator Studio',
    ...overrides,
  }
}

function configuration(
  product: AdminProduct,
  overrides: Partial<AdminProductConfiguration> = {},
): AdminProductConfiguration {
  return {
    product,
    tracking: { enabled: false, baseUrl: null },
    readiness: {
      hasLiveDefaultFunnel: false,
      hasActiveAgreement: false,
      hasActiveBillingOffer: false,
      trackingReady: false,
      trackingOnlyReady: false,
      trackingOnlyCanIssueLinks: false,
    },
    funnels: [],
    campaigns: [],
    agreements: [],
    billingOffers: [],
    mainLinks: [],
    ...overrides,
  }
}

function gatewayWith(
  getProductConfiguration?: NonNullable<AdminGateway['getProductConfiguration']>,
): AdminGateway {
  const gateway: AdminGateway = {
    getAdminContext: vi.fn(async () => ready(owner)),
    getProducts: vi.fn(async () => ready([])),
    createProduct: vi.fn(),
  }
  if (getProductConfiguration) gateway.getProductConfiguration = getProductConfiguration
  return gateway
}

function renderPage({
  context = owner,
  products = [planner],
  gateway,
  onOpenProducts = vi.fn(),
  onOpenProductConfiguration = vi.fn(),
}: Partial<React.ComponentProps<typeof FunnelsLinksPage>> & { gateway: AdminGateway }) {
  const props: React.ComponentProps<typeof FunnelsLinksPage> = {
    context,
    products,
    gateway,
    onOpenProducts,
    onOpenProductConfiguration,
  }
  return { ...render(<FunnelsLinksPage {...props} />), props }
}

describe('Funnels and Links page', () => {
  it('does not request configuration without products and opens the product catalog', async () => {
    const user = userEvent.setup()
    const reader = vi.fn(async () => ready(configuration(planner)))
    const onOpenProducts = vi.fn()
    renderPage({ gateway: gatewayWith(reader), products: [], onOpenProducts })

    expect(screen.getByRole('heading', { name: 'No products yet' })).toBeVisible()
    expect(reader).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Open Products' }))
    expect(onOpenProducts).toHaveBeenCalledOnce()
  })

  it('uses only the read capability, fans out exact product IDs in parallel, and aggregates totals', async () => {
    let resolvePlanner!: (result: AdminDataResult<AdminProductConfiguration | null>) => void
    let resolveScanner!: (result: AdminDataResult<AdminProductConfiguration | null>) => void
    const plannerPromise = new Promise<AdminDataResult<AdminProductConfiguration | null>>(
      (resolve) => {
        resolvePlanner = resolve
      },
    )
    const scannerPromise = new Promise<AdminDataResult<AdminProductConfiguration | null>>(
      (resolve) => {
        resolveScanner = resolve
      },
    )
    const reader = vi.fn((productId: string) =>
      productId === planner.id ? plannerPromise : scannerPromise,
    )
    const gateway = gatewayWith(reader)
    const plannerDefault = funnel(planner)
    const plannerAlternative = funnel(planner, {
      id: 'product-planner-funnel-alternative',
      key: 'alternative',
      name: 'Alternative checkout',
      isDefault: false,
      status: 'draft',
    })
    const scannerFunnel = funnel(scanner, {
      destinationConfigured: false,
      destinationUrl: null,
      status: 'draft',
    })
    const plannerConfiguration = configuration(planner, {
      tracking: { enabled: true, baseUrl: 'https://go.example.com' },
      readiness: {
        hasLiveDefaultFunnel: true,
        hasActiveAgreement: false,
        hasActiveBillingOffer: false,
        trackingReady: true,
        trackingOnlyReady: false,
        trackingOnlyCanIssueLinks: false,
      },
      funnels: [plannerDefault, plannerAlternative],
      mainLinks: [
        mainLink(planner, plannerDefault.id),
        mainLink(planner, plannerDefault.id, {
          id: 'product-planner-link-paused',
          status: 'paused',
          partnerName: 'Editorial Lab',
        }),
      ],
    })
    const scannerConfiguration = configuration(scanner, { funnels: [scannerFunnel] })

    renderPage({ gateway, products: [planner, scanner] })

    await waitFor(() => expect(reader).toHaveBeenCalledTimes(2))
    expect(reader).toHaveBeenNthCalledWith(1, planner.id)
    expect(reader).toHaveBeenNthCalledWith(2, scanner.id)

    await act(async () => {
      resolvePlanner(ready(plannerConfiguration))
      resolveScanner(ready(scannerConfiguration))
    })

    expect(await screen.findByRole('heading', { name: 'Product routing overview' })).toBeVisible()
    const summary = screen.getByLabelText('Funnels and links summary')
    expect(
      within(within(summary).getByText('Products').closest('article')!).getByText('2'),
    ).toBeVisible()
    expect(
      within(within(summary).getByText('Funnels').closest('article')!).getByText('3'),
    ).toBeVisible()
    expect(
      within(within(summary).getByText('Live defaults').closest('article')!).getByText('1'),
    ).toBeVisible()
    expect(
      within(within(summary).getByText('Main links').closest('article')!).getByText('2'),
    ).toBeVisible()
    expect(gateway.getAffiliates).toBeUndefined()
    expect(gateway.createFunnel).toBeUndefined()
  })

  it('keeps successful rows visible on partial failure, hides raw errors, and retries', async () => {
    const plannerConfiguration = configuration(planner)
    let scannerAttempt = 0
    const reader = vi.fn(async (productId: string) => {
      if (productId === planner.id) return ready(plannerConfiguration)
      scannerAttempt += 1
      return scannerAttempt === 1 ? unavailable() : ready(configuration(scanner))
    })
    renderPage({ gateway: gatewayWith(reader), products: [planner, scanner] })

    expect(await screen.findByText('Some product configuration is unavailable')).toBeVisible()
    const overview = screen.getByRole('region', { name: 'Product routing table' })
    expect(within(overview).getByText('Daily Planner')).toBeVisible()
    expect(within(overview).getByText('Scan PDF')).toBeVisible()
    expect(within(overview).getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByText(/raw provider host/i)).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(
        screen.queryByText('Some product configuration is unavailable'),
      ).not.toBeInTheDocument(),
    )
    expect(reader).toHaveBeenCalledTimes(4)
    expect(reader.mock.calls.map(([id]) => id)).toEqual([
      planner.id,
      scanner.id,
      planner.id,
      scanner.id,
    ])
  })

  it.each(['owner', 'operations'] as const)(
    'shows only the sanitized HTTPS origin and path to %s',
    async (role) => {
      const configuredFunnel = funnel(planner)
      renderPage({
        context: { ...owner, role },
        gateway: gatewayWith(async () =>
          ready(
            configuration(planner, {
              funnels: [configuredFunnel],
            }),
          ),
        ),
      })

      await screen.findByRole('heading', { name: 'Product routing overview' })
      expect(screen.getAllByText('https://checkout.example.com/start').length).toBeGreaterThan(0)
      expect(screen.queryByText(/provider-value/)).not.toBeInTheDocument()
      expect(screen.queryByText(/#private/)).not.toBeInTheDocument()
    },
  )

  it.each(['finance', 'analyst'] as const)(
    'masks destinations as configured or missing for the %s role',
    async (role) => {
      renderPage({
        context: { ...owner, role },
        gateway: gatewayWith(async () =>
          ready(
            configuration(planner, {
              funnels: [
                funnel(planner, {
                  destinationConfigured: true,
                  destinationUrl: null,
                }),
              ],
            }),
          ),
        ),
      })

      await screen.findByRole('heading', { name: 'Product routing overview' })
      expect(screen.getAllByText('Configured').length).toBeGreaterThan(0)
      expect(screen.queryByText(/checkout\.example\.com/)).not.toBeInTheDocument()
      expect(screen.queryByText(/provider-value/)).not.toBeInTheDocument()
    },
  )

  it('shows truthful empty funnel and main-link directories for configured products', async () => {
    renderPage({
      gateway: gatewayWith(async () => ready(configuration(planner))),
    })

    expect(await screen.findByRole('heading', { name: 'No funnels configured' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No main links issued' })).toBeVisible()
    expect(screen.getByText('Default funnel missing')).toBeVisible()
  })

  it('renders safe unconfigured and total-failure states without provider details', async () => {
    const { unmount } = renderPage({ gateway: gatewayWith() })
    expect(
      await screen.findByRole('heading', { name: 'Funnels & Links are not configured' }),
    ).toBeVisible()
    unmount()

    renderPage({ gateway: gatewayWith(async () => unavailable('database.internal:5432 secret')) })
    expect(
      await screen.findByRole('heading', { name: 'Funnels & Links could not be loaded' }),
    ).toBeVisible()
    expect(screen.queryByText(/database\.internal|5432|secret/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('opens configuration with the exact product ID', async () => {
    const onOpenProductConfiguration = vi.fn()
    renderPage({
      gateway: gatewayWith(async () => ready(configuration(planner))),
      onOpenProductConfiguration,
    })
    await screen.findByRole('heading', { name: 'Product routing overview' })

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: `Open configuration for ${planner.name}` }))
    expect(onOpenProductConfiguration).toHaveBeenCalledWith(planner.id)
  })

  it('copies a server-returned main link without opening it and contains the feedback', async () => {
    const configuredFunnel = funnel(planner)
    const link = mainLink(planner, configuredFunnel.id)
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderPage({
      gateway: gatewayWith(async () =>
        ready(
          configuration(planner, {
            funnels: [configuredFunnel],
            mainLinks: [link],
          }),
        ),
      ),
    })
    const copyButton = await screen.findByRole('button', {
      name: 'Copy main link for Creator Studio',
    })
    expect(screen.queryByRole('link')).not.toBeInTheDocument()

    await user.click(copyButton)

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(link.trackingUrl)
    const row = copyButton.closest('.admin-routing-link-row')!
    expect(within(row as HTMLElement).getByRole('status')).toHaveTextContent('Link copied.')
  })

  it('has no automated accessibility violations with populated routing data', async () => {
    const configuredFunnel = funnel(planner)
    const { container } = renderPage({
      gateway: gatewayWith(async () =>
        ready(
          configuration(planner, {
            tracking: { enabled: true, baseUrl: 'https://go.example.com' },
            readiness: {
              hasLiveDefaultFunnel: true,
              hasActiveAgreement: false,
              hasActiveBillingOffer: false,
              trackingReady: true,
              trackingOnlyReady: false,
              trackingOnlyCanIssueLinks: false,
            },
            funnels: [configuredFunnel],
            mainLinks: [mainLink(planner, configuredFunnel.id)],
          }),
        ),
      ),
    })
    await screen.findByRole('heading', { name: 'Product routing overview' })

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})
