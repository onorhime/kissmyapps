import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminAttributionOverview,
  AdminDataHealth,
  AdminDataResult,
  AdminGateway,
  AdminProduct,
} from '../api'
import { AttributionPage } from './AttributionPage'
import { DataHealthPage } from './DataHealthPage'

const product: AdminProduct = {
  id: 'product-1',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'draft',
  trackingMode: 'commercial',
  trackingOnlyApprovedAt: null,
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
}

const attribution: AdminAttributionOverview = {
  generatedAt: '2026-09-01T12:00:00.000Z',
  window: {
    startsAt: '2026-08-02T12:00:00.000Z',
    endsAt: '2026-09-01T12:00:00.000Z',
  },
  filters: { productId: null, sourceId: null },
  readiness: {
    trackingEnabled: false,
    baseUrlConfigured: false,
    activeProductCount: 0,
    liveFunnelCount: 0,
    activeLinkCount: 0,
    lastClickAt: null,
    lastEventAt: null,
    lastConversionAt: null,
  },
  summary: {
    clicks: 0,
    botClicks: 0,
    acquisitions: 0,
    resolvedAcquisitions: 0,
    rejectedAcquisitions: 0,
    events: 0,
    trustedEvents: 0,
    commercialEligibleEvents: 0,
    qualifiedConversions: 0,
  },
  breakdown: [],
  eventTypes: [],
  recentAcquisitions: { items: [], totalCount: 0 },
  sources: [{ id: 'source-1', name: 'TikTok' }],
}

const dataHealth: AdminDataHealth = {
  generatedAt: '2026-09-01T12:00:00.000Z',
  overallStatus: 'disabled',
  catalog: {
    trackingEnabled: false,
    baseUrlConfigured: false,
    activeProductCount: 0,
    liveFunnelCount: 0,
    activeLinkCount: 0,
    verifiedActiveOfferCount: 0,
    launchReadyAgreementCount: 0,
  },
  providers: [
    {
      id: 'click_tracker',
      status: 'disabled',
      observedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      lastObservedAt: null,
    },
    {
      id: 'funnel_events',
      status: 'disabled',
      observedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      lastObservedAt: null,
    },
    {
      id: 'stripe',
      status: 'unobserved',
      observedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      lastObservedAt: null,
    },
    {
      id: 'singular',
      status: 'unobserved',
      observedCount: 0,
      verifiedCount: 0,
      failedCount: 0,
      lastObservedAt: null,
    },
  ],
  queues: ['stripe_events', 'commercial_facts', 'reporting_metrics', 'reconciliation'].map(
    (id) => ({
      id: id as AdminDataHealth['queues'][number]['id'],
      status: 'unobserved' as const,
      pendingCount: 0,
      processingCount: 0,
      processedCount: 0,
      failedCount: 0,
      retryReadyCount: 0,
      staleLeaseCount: 0,
      oldestPendingAt: null,
      lastProcessedAt: null,
    }),
  ),
  metrics: {
    rowCount: 0,
    partialCount: 0,
    reconciledCount: 0,
    finalizedCount: 0,
    latestMetricDate: null,
    latestCalculatedAt: null,
  },
  reconciliation: { runCount: 0, openExceptionCount: 0, recentRuns: [] },
}

function ready<T>(data: T): AdminDataResult<T | null> {
  return { data, status: 'ready', error: null }
}

function gatewayWith(
  attributionResult: AdminDataResult<AdminAttributionOverview | null> = ready(attribution),
  healthResult: AdminDataResult<AdminDataHealth | null> = ready(dataHealth),
): AdminGateway {
  return {
    getAdminContext: vi.fn(),
    getProducts: vi.fn(),
    createProduct: vi.fn(),
    getAttributionOverview: vi.fn(async () => attributionResult),
    getDataHealth: vi.fn(async () => healthResult),
  }
}

describe('Admin observability pages', () => {
  it('shows Attribution as a truthful zero-data state and keeps filters server-side', async () => {
    const gateway = gatewayWith()
    const onOpenFunnelsLinks = vi.fn()
    render(
      <AttributionPage
        products={[product]}
        gateway={gateway}
        onOpenFunnelsLinks={onOpenFunnelsLinks}
      />,
    )

    expect(
      await screen.findByRole('heading', { name: 'No attribution evidence yet' }),
    ).toBeVisible()
    expect(screen.getByText(/real zero-data state/i)).toBeVisible()
    expect(screen.getByText(/Tracking is disabled/i)).toBeVisible()
    expect(gateway.getAttributionOverview).toHaveBeenCalledWith(
      expect.objectContaining({ productId: null, sourceId: null, limit: 25, offset: 0 }),
    )

    await userEvent.setup().selectOptions(screen.getByLabelText('Product'), product.id)
    await waitFor(() =>
      expect(gateway.getAttributionOverview).toHaveBeenLastCalledWith(
        expect.objectContaining({ productId: product.id }),
      ),
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Funnels & Links' }))
    expect(onOpenFunnelsLinks).toHaveBeenCalledOnce()
  })

  it('shows an unavailable contract without inventing attribution values', async () => {
    render(
      <AttributionPage
        products={[]}
        gateway={{ getAdminContext: vi.fn(), getProducts: vi.fn(), createProduct: vi.fn() }}
        onOpenFunnelsLinks={vi.fn()}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Attribution is unavailable' })).toBeVisible()
    expect(screen.getByText(/not available in this deployment/i)).toBeVisible()
    expect(screen.queryByText('No attribution evidence yet')).toBeNull()
  })

  it('renders Data Health zeroes as disabled or unobserved and states proof limits', async () => {
    const gateway = gatewayWith()
    render(<DataHealthPage gateway={gateway} onOpenFunnelsLinks={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Collection evidence' })).toBeVisible()
    expect(screen.getByText('Overall database evidence')).toBeVisible()
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unobserved').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Durable queues' })).toBeVisible()
    expect(screen.getByText('What this page cannot prove')).toBeVisible()
    expect(screen.getByText(/cannot confirm Edge Function deployment/i)).toBeVisible()
    expect(gateway.getDataHealth).toHaveBeenCalledOnce()
  })

  it('contains raw failures and retries Data Health safely', async () => {
    const gateway = gatewayWith(undefined, {
      data: null,
      status: 'error',
      error: {
        code: 'temporarily_unavailable',
        message: 'Operational reporting is temporarily unavailable.',
        retryable: true,
      },
    })
    render(<DataHealthPage gateway={gateway} onOpenFunnelsLinks={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Data Health is unavailable' })).toBeVisible()
    expect(screen.queryByText(/raw queue/i)).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(gateway.getDataHealth).toHaveBeenCalledTimes(2))
  })

  it.each(['attribution', 'data-health'] as const)(
    'has no automated accessibility violations in the %s zero state',
    async (page) => {
      const gateway = gatewayWith()
      const { container } = render(
        page === 'attribution' ? (
          <AttributionPage products={[product]} gateway={gateway} onOpenFunnelsLinks={vi.fn()} />
        ) : (
          <DataHealthPage gateway={gateway} onOpenFunnelsLinks={vi.fn()} />
        ),
      )

      await screen.findByRole('heading', {
        name: page === 'attribution' ? 'No attribution evidence yet' : 'Collection evidence',
      })
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(results.violations).toEqual([])
    },
  )
})
