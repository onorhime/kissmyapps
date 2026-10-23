import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  FunnelMetricReport,
  FunnelMetricReportFilter,
  FunnelMetricsResult,
} from '../../funnel-metrics'
import type { PartnerLink, PartnerProduct, PartnerSupabaseClient } from '../api'
import { FunnelMetricsReport } from './FunnelMetricsReport'
import { createLoadingPartnerLiveSnapshot } from './loader'
import { mapFunnelJourney } from '../../funnel-metrics/journey'
import { journeyPayload } from '../../funnel-metrics/journey.test-fixtures'

const productId = '11111111-1111-4111-8111-111111111111'
const funnelA = '22222222-2222-4222-8222-222222222222'
const funnelB = '33333333-3333-4333-8333-333333333333'
const product: PartnerProduct = {
  id: productId,
  slug: 'generic-app',
  name: 'Generic App',
  status: 'active',
  trackingMode: 'commercial',
  agreementStatus: 'active',
  commercialModel: 'revenue_share',
  payoutCurrency: 'USD',
  hasLiveFunnel: true,
  mainLinkId: null,
  mainTrackingUrl: null,
}
const ownLink: PartnerLink = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'My newsletter',
  productId,
  productName: product.name,
  productSlug: product.slug,
  funnelId: funnelA,
  funnelName: 'Course signup',
  sourceId: null,
  sourceName: null,
  campaignId: null,
  campaignName: null,
  sub1: '',
  sub2: '',
  sub3: '',
  status: 'active',
  trackingUrl: 'https://example.test/track/own',
  parentLinkId: null,
  commercialEligible: true,
  clicks: 1,
  leads: null,
  installs: null,
  purchases: null,
  earningsMinor: null,
  currency: 'USD',
  createdAt: '2026-10-01T00:00:00Z',
}
const resource = <T,>(data: T) => ({ data, status: 'ready' as const, error: null })
function workspace(singleFunnel = false) {
  const snapshot = createLoadingPartnerLiveSnapshot(productId)
  return {
    selectedProductId: productId,
    sessionUserId: 'creator-one',
    client: null,
    reporting: {
      startsOn: '2026-10-01',
      endsOn: '2026-10-14',
      timezone: 'Africa/Lagos',
      grain: 'day' as const,
      breakdown: 'source' as const,
    },
    snapshot: {
      ...snapshot,
      resources: {
        ...snapshot.resources,
        products: resource([product]),
        linkDirectory: resource({
          products: [product],
          sources: [],
          campaigns: [],
          funnels: [
            {
              id: funnelA,
              productId,
              kind: 'funnel' as const,
              key: 'course',
              name: 'Course signup',
              available: true,
            },
            ...(!singleFunnel
              ? [
                  {
                    id: funnelB,
                    productId,
                    kind: 'funnel' as const,
                    key: 'download',
                    name: 'App download',
                    available: true,
                  },
                ]
              : []),
            {
              id: 'other-funnel',
              productId: 'other-product',
              kind: 'funnel' as const,
              key: 'foreign',
              name: 'Another product funnel',
              available: true,
            },
          ],
        }),
        links: resource([
          ownLink,
          { ...ownLink, id: 'other-link', name: 'Another funnel link', funnelId: funnelB },
          {
            ...ownLink,
            id: 'foreign-link',
            name: 'Another product link',
            productId: 'other-product',
          },
        ]),
      },
    },
  }
}
function report(id = funnelA): FunnelMetricReport {
  return {
    productId,
    funnelId: id,
    version: 2,
    status: 'connected',
    asOf: '2026-10-14T10:00:00Z',
    publishedAt: '2026-10-02T00:00:00Z',
    effectiveUntil: null,
    lastReceivedAt: '2026-10-14T09:00:00Z',
    warnings: [],
    externalCommerceStatus: 'unconnected',
    externalCommerceUpdatedAt: null,
    commissionStatus: 'held',
    metrics: [
      {
        key: 'registered',
        label: 'Confirmed registrations',
        kind: 'unique_people',
        value: 0,
        status: 'available',
        updatedAt: '2026-10-14T09:00:00Z',
      },
      {
        key: 'attended',
        label: 'Attendance',
        kind: 'unique_per_context',
        value: null,
        status: 'no_data',
        updatedAt: null,
      },
      {
        key: 'completion_rate',
        label: 'Completion rate',
        kind: 'ratio',
        value: 42.2,
        status: 'available',
        updatedAt: '2026-10-14T09:00:00Z',
      },
    ],
  }
}
const ready = (data: FunnelMetricReport): FunnelMetricsResult<FunnelMetricReport> => ({
  status: 'ready',
  data,
  error: null,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value: T) => resolve(value),
  }
}

describe('creator configured funnel reports', () => {
  it('keeps test/live, reporting-window and currency choices explicit without mutating commercial terms', async () => {
    const getReport = vi.fn(async (_filter: FunnelMetricReportFilter) => ready(report()))
    render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
    await screen.findByText('42.2%')
    expect(screen.getByLabelText('Metrics environment')).toHaveValue('live')
    expect(screen.getByLabelText('Metrics conversion window')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('Metrics environment'), { target: { value: 'test' } })
    fireEvent.change(screen.getByLabelText('Metrics conversion window'), {
      target: { value: '45' },
    })
    fireEvent.change(screen.getByLabelText('Metrics earnings currency'), {
      target: { value: 'usd' },
    })
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ environment: 'test', conversionWindowDays: 45, currency: 'USD' }),
      ),
    )
    expect(getReport.mock.calls.at(-1)?.[0]).not.toHaveProperty('commissionRate')
    fireEvent.change(screen.getByLabelText('Metrics conversion window'), { target: { value: '0' } })
    expect(screen.getByRole('alert')).toHaveTextContent('between 1 and 365 days')
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
  })
  it('uses the authenticated report RPC and maps real response fields in production composition', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        product_id: productId,
        funnel_id: funnelA,
        version: 1,
        status: 'connected',
        published_at: '2026-10-01T00:00:00Z',
        effective_until: null,
        as_of: '2026-10-14T10:00:00Z',
        last_received_at: '2026-10-14T09:00:00Z',
        metrics: [
          {
            key: 'reached',
            label: 'Custom reached audience',
            type: 'unique_people',
            value: 7,
            availability: 'available',
            last_received_at: '2026-10-14T09:00:00Z',
          },
        ],
        commerce: {
          source: 'external_verified_ledger',
          availability: 'unconnected',
          commission_status: 'held',
          currencies: [],
          last_received_at: null,
        },
      },
      error: null,
    }))
    const client: PartnerSupabaseClient = {
      rpc,
      from: () => {
        throw new Error('The report must use the scoped RPC, not a table read.')
      },
    }
    render(<FunnelMetricsReport workspace={{ ...workspace(true), client }} />)
    const card = await screen.findByRole('article', { name: 'Custom reached audience' })
    expect(within(card).getByText('7', { exact: true })).toBeInTheDocument()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_partner_funnel_metrics_report', {
      p_input: {
        product_id: productId,
        funnel_id: funnelA,
        date_from: '2026-10-01',
        date_to: '2026-10-14',
        time_zone: 'Africa/Lagos',
        environment: 'live',
      },
    })
  })

  it('requires one authorized funnel and uses dynamic labels, display order and precise zero states', async () => {
    const user = userEvent.setup()
    const getReport = vi.fn(async (filter: FunnelMetricReportFilter) =>
      ready(report(filter.funnelId)),
    )
    render(<FunnelMetricsReport workspace={workspace()} gateway={{ getReport }} />)
    expect(screen.getByText(/Choose one funnel/)).toBeInTheDocument()
    expect(getReport).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: 'Another product funnel' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Metrics funnel'), funnelA)
    await screen.findByRole('article', { name: 'Confirmed registrations' })
    expect(
      within(screen.getByRole('article', { name: 'Confirmed registrations' })).getByText('0', {
        exact: true,
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('article', { name: 'Attendance' })).getByText('—', { exact: true }),
    ).toBeInTheDocument()
    expect(screen.getByText('42.2%')).toBeInTheDocument()
    expect(screen.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Confirmed registrations',
      'Attendance',
      'Completion rate',
    ])
    expect(screen.getByText('Published definition: version 2')).toBeInTheDocument()
    expect(
      screen.getByText(/Results attributed to your creator links for Generic App/),
    ).toBeInTheDocument()
    expect(getReport).toHaveBeenLastCalledWith({
      productId,
      funnelId: funnelA,
      from: '2026-10-01',
      to: '2026-10-14',
      timeZone: 'Africa/Lagos',
      environment: 'live',
    })
    expect(JSON.stringify(getReport.mock.calls)).not.toContain('affiliate_id')
  })

  it('scopes link and inclusive date filters and resets the link when changing funnels', async () => {
    const user = userEvent.setup()
    const getReport = vi.fn(async (filter: FunnelMetricReportFilter) =>
      ready(report(filter.funnelId)),
    )
    render(<FunnelMetricsReport workspace={workspace()} gateway={{ getReport }} />)
    await user.selectOptions(screen.getByLabelText('Metrics funnel'), funnelA)
    await screen.findByText('42.2%')
    expect(screen.queryByRole('option', { name: 'Another funnel link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Another product link' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Metrics creator link'), ownLink.id)
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ linkId: ownLink.id })),
    )
    fireEvent.change(screen.getByLabelText('Metrics start date'), {
      target: { value: '2026-10-05' },
    })
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-10-05', to: '2026-10-14', linkId: ownLink.id }),
      ),
    )
    await user.selectOptions(screen.getByLabelText('Metrics funnel'), funnelB)
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith({
        productId,
        funnelId: funnelB,
        from: '2026-10-05',
        to: '2026-10-14',
        timeZone: 'Africa/Lagos',
        environment: 'live',
      }),
    )
    const before = getReport.mock.calls.length
    fireEvent.change(screen.getByLabelText('Metrics start date'), {
      target: { value: '2026-11-01' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('start date must be on or before')
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
    expect(getReport).toHaveBeenCalledTimes(before)
  })

  it('never displays late responses from a previous funnel or signed-in account', async () => {
    const user = userEvent.setup()
    const first = deferred<FunnelMetricsResult<FunnelMetricReport>>()
    const second = deferred<FunnelMetricsResult<FunnelMetricReport>>()
    const getReport = vi.fn((filter: FunnelMetricReportFilter) =>
      filter.funnelId === funnelA ? first.promise : second.promise,
    )
    const current = workspace()
    const view = render(<FunnelMetricsReport workspace={current} gateway={{ getReport }} />)
    await user.selectOptions(screen.getByLabelText('Metrics funnel'), funnelA)
    expect(screen.getByText('Loading your funnel results')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Metrics funnel'), funnelB)
    await act(async () => {
      first.resolve(ready(report()))
    })
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
    view.rerender(
      <FunnelMetricsReport
        workspace={{ ...current, sessionUserId: null }}
        gateway={{ getReport }}
      />,
    )
    await act(async () => {
      second.resolve(ready(report(funnelB)))
    })
    expect(screen.getByText('Sign in to see your attributed funnel results.')).toBeInTheDocument()
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
  })

  it('clears results and selects only the new product scope on product changes', async () => {
    const getReport = vi.fn(async (filter: FunnelMetricReportFilter) =>
      ready({ ...report(filter.funnelId), productId: filter.productId }),
    )
    const gateway = { getReport }
    const original = workspace(true)
    const view = render(<FunnelMetricsReport workspace={original} gateway={gateway} />)
    await screen.findByText('42.2%')
    const otherId = '55555555-5555-4555-8555-555555555555'
    const other = {
      ...original,
      selectedProductId: otherId,
      snapshot: {
        ...original.snapshot,
        resources: {
          ...original.snapshot.resources,
          products: resource([{ ...product, id: otherId, name: 'Second product' }]),
          linkDirectory: resource({
            ...original.snapshot.resources.linkDirectory.data,
            funnels: [
              {
                id: funnelB,
                productId: otherId,
                kind: 'funnel' as const,
                key: 'second',
                name: 'Second funnel',
                available: true,
              },
            ],
          }),
        },
      },
    }
    view.rerender(<FunnelMetricsReport workspace={other} gateway={gateway} />)
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ productId: otherId, funnelId: funnelB }),
      ),
    )
    expect(screen.queryByRole('option', { name: 'My newsletter' })).not.toBeInTheDocument()
  })

  it('distinguishes missing integration, unpublished definitions and a failed read', async () => {
    const user = userEvent.setup()
    const getReport = vi
      .fn<() => Promise<FunnelMetricsResult<FunnelMetricReport>>>()
      .mockResolvedValueOnce({
        status: 'unconfigured',
        data: null,
        error: {
          code: 'unconfigured',
          message: 'Reporting migration is not installed.',
          retryable: false,
        },
      })
      .mockResolvedValueOnce({
        status: 'error',
        data: null,
        error: { code: 'unavailable', message: 'Connection interrupted.', retryable: true },
      })
      .mockResolvedValueOnce(
        ready({
          ...report(),
          version: null,
          status: 'unpublished',
          metrics: [],
          publishedAt: null,
        }),
      )
    render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
    await screen.findByText('Funnel reporting is not available yet')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh metrics' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted.')
    await user.click(screen.getByRole('button', { name: 'Refresh metrics' }))
    await screen.findByText('No metrics published for this funnel')
    expect(screen.queryByText('0', { exact: true })).not.toBeInTheDocument()
  })

  it('rejects mismatched report scopes rather than exposing another product’s results', async () => {
    const getReport = vi.fn(async () => ready({ ...report(), productId: 'another-product' }))
    render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'did not match the selected product and funnel',
    )
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
  })

  it('does not widen a selected link filter when its directory becomes unavailable', async () => {
    const user = userEvent.setup()
    const getReport = vi.fn(async (_filter: FunnelMetricReportFilter) => ready(report()))
    const gateway = { getReport }
    const initial = workspace(true)
    const view = render(<FunnelMetricsReport workspace={initial} gateway={gateway} />)
    await screen.findByText('42.2%')
    await user.selectOptions(screen.getByLabelText('Metrics creator link'), ownLink.id)
    await waitFor(() =>
      expect(getReport).toHaveBeenLastCalledWith(expect.objectContaining({ linkId: ownLink.id })),
    )
    const before = getReport.mock.calls.length
    view.rerender(
      <FunnelMetricsReport
        workspace={{
          ...initial,
          snapshot: {
            ...initial.snapshot,
            resources: {
              ...initial.snapshot.resources,
              links: { ...initial.snapshot.resources.links, status: 'unavailable' },
            },
          },
        }}
        gateway={gateway}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Results have not been widened to all links',
    )
    expect(screen.queryByText('42.2%')).not.toBeInTheDocument()
    expect(getReport).toHaveBeenCalledTimes(before)
  })

  it('uses canonical cohort commerce instead of displaying conflicting legacy refund totals', async () => {
    const payload = journeyPayload()
    payload.environment = 'live'
    const getReport = vi.fn(async () =>
      ready({
        ...report(),
        journey: mapFunnelJourney(payload),
        externalCommerceStatus: 'available',
        externalCommerce: [
          {
            currency: 'USD',
            livemode: true,
            purchases: 10,
            refunds: 0,
            grossCents: 169000,
            refundCents: 0,
            netCents: 169000,
          },
        ],
      }),
    )
    render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
    const canonical = await screen.findByRole('region', { name: 'USD cohort revenue and earnings' })
    expect(
      within(canonical).getByText('Orders with a successful refund').nextElementSibling,
    ).toHaveTextContent('1')
    expect(
      screen.queryByRole('heading', { name: 'Verified external sales' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Published period metrics' })).toBeInTheDocument()
  })

  it('keeps verified external sales by currency and directs creators to separate commission status', async () => {
    const getReport = vi.fn(async () =>
      ready({
        ...report(),
        externalCommerceStatus: 'available',
        externalCommerceUpdatedAt: '2026-10-14T09:00:00Z',
        externalCommerce: [
          {
            currency: 'USD',
            livemode: true,
            purchases: 2,
            refunds: 1,
            grossCents: 35800,
            refundCents: 17900,
            netCents: 17900,
          },
          {
            currency: 'EUR',
            livemode: true,
            purchases: 1,
            refunds: 0,
            grossCents: 15000,
            refundCents: 0,
            netCents: 15000,
          },
          {
            currency: 'USD',
            livemode: false,
            purchases: 1,
            refunds: 0,
            grossCents: 10000,
            refundCents: 0,
            netCents: 10000,
          },
        ],
      }),
    )
    render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
    const table = await screen.findByRole('table', {
      name: 'Your attributed external sales, separated by currency and payment mode',
    })
    expect(within(table).getByText('$358.00')).toBeInTheDocument()
    expect(within(table).getAllByText('€150.00', { selector: 'td' })).toHaveLength(2)
    expect(within(table).getAllByText('Live')).toHaveLength(2)
    expect(within(table).getByText('Test')).toBeInTheDocument()
    expect(screen.getByText(/Sales totals are not creator/)).toBeInTheDocument()
    expect(screen.getByText(/Open Payouts to see calculated commissions/)).toBeInTheDocument()
    expect(screen.getByText(/Currencies are not added together/)).toBeInTheDocument()
  })
})
it('creator filters carry channel and context without widening creator scope', async () => {
  const getReport = vi.fn(async (_filter: FunnelMetricReportFilter) => ready(report()))
  render(<FunnelMetricsReport workspace={workspace(true)} gateway={{ getReport }} />)
  await waitFor(() => expect(getReport).toHaveBeenCalled())
  fireEvent.change(screen.getByLabelText('Metrics channel'), { target: { value: 'creator' } })
  fireEvent.change(screen.getByLabelText('Metrics entry option'), { target: { value: 'book' } })
  fireEvent.change(screen.getByLabelText('Metrics webinar id'), { target: { value: 'event1' } })
  fireEvent.change(screen.getByLabelText('Metrics intake id'), { target: { value: 'intake1' } })
  await waitFor(() =>
    expect(getReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: 'creator',
        entryVariant: 'book',
        webinarId: 'event1',
        intakeId: 'intake1',
        productId,
        funnelId: funnelA,
      }),
    ),
  )
  expect(getReport.mock.calls.at(-1)?.[0]).not.toHaveProperty('affiliateId')
})
