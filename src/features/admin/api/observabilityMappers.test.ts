import { describe, expect, it } from 'vitest'
import { mapAdminAttributionOverview, mapAdminDataHealth } from './observabilityMappers'

const attributionResponse = {
  generated_at: '2026-09-01T12:00:00.000Z',
  window: {
    starts_at: '2026-08-02T12:00:00.000Z',
    ends_at: '2026-09-01T12:00:00.000Z',
  },
  filters: { product_id: null, source_id: null },
  readiness: {
    tracking_enabled: true,
    base_url_configured: true,
    active_product_count: 1,
    live_funnel_count: 1,
    active_link_count: 2,
    last_click_at: '2026-09-01T10:00:00.000Z',
    last_event_at: '2026-09-01T10:01:00.000Z',
    last_conversion_at: '2026-09-01T10:02:00.000Z',
  },
  summary: {
    clicks: 14,
    bot_clicks: 2,
    acquisitions: 5,
    resolved_acquisitions: 3,
    rejected_acquisitions: 1,
    events: 9,
    trusted_events: 7,
    commercial_eligible_events: 4,
    qualified_conversions: 3,
  },
  breakdown: [
    {
      product_id: 'product-1',
      product_name: 'Daily Planner',
      source_id: 'source-1',
      source_name: 'TikTok',
      clicks: 14,
      acquisitions: 5,
      qualified_conversions: 3,
    },
  ],
  event_types: [
    {
      event_name: 'purchase.completed',
      event_count: 4,
      commercial_eligible_count: 4,
      last_occurred_at: '2026-09-01T10:01:00.000Z',
    },
  ],
  recent_acquisitions: {
    items: [
      {
        product_name: 'Daily Planner',
        partner_name: 'Victory Media',
        source_name: 'TikTok',
        campaign_name: 'Launch',
        funnel_name: 'Main funnel',
        attribution_method: 'deterministic_web',
        status: 'resolved',
        click_country: 'NG',
        install_country: 'NG',
        created_at: '2026-09-01T10:00:30.000Z',
        resolved_at: '2026-09-01T10:02:00.000Z',
        account_id: 'must-not-cross-the-mapper',
      },
    ],
    total_count: 1,
  },
  sources: [{ id: 'source-1', name: 'TikTok' }],
  provider_payload: 'must-not-cross-the-mapper',
}

const dataHealthResponse = {
  generated_at: '2026-09-01T12:00:00.000Z',
  overall_status: 'attention',
  catalog: {
    tracking_enabled: true,
    base_url_configured: true,
    active_product_count: 1,
    live_funnel_count: 1,
    active_link_count: 2,
    verified_active_offer_count: 1,
    launch_ready_agreement_count: 1,
  },
  providers: [
    {
      id: 'click_tracker',
      status: 'ready',
      observed_count: 12,
      verified_count: 10,
      failed_count: 2,
      last_observed_at: '2026-09-01T10:00:00.000Z',
    },
    {
      id: 'funnel_events',
      status: 'ready',
      observed_count: 6,
      verified_count: 6,
      failed_count: 0,
      last_observed_at: '2026-09-01T10:01:00.000Z',
    },
    {
      id: 'stripe',
      status: 'attention',
      observed_count: 4,
      verified_count: 3,
      failed_count: 1,
      last_observed_at: '2026-09-01T10:02:00.000Z',
    },
    {
      id: 'singular',
      status: 'unobserved',
      observed_count: 0,
      verified_count: 0,
      failed_count: 0,
      last_observed_at: null,
    },
  ],
  queues: [
    {
      id: 'stripe_events',
      status: 'attention',
      pending_count: 1,
      processing_count: 0,
      processed_count: 2,
      failed_count: 1,
      retry_ready_count: 1,
      stale_lease_count: 0,
      oldest_pending_at: '2026-09-01T09:00:00.000Z',
      last_processed_at: '2026-09-01T10:03:00.000Z',
    },
    {
      id: 'commercial_facts',
      status: 'unobserved',
      pending_count: 0,
      processing_count: 0,
      processed_count: 0,
      failed_count: 0,
      retry_ready_count: 0,
      stale_lease_count: 0,
      oldest_pending_at: null,
      last_processed_at: null,
    },
    {
      id: 'reporting_metrics',
      status: 'ready',
      pending_count: 0,
      processing_count: 0,
      processed_count: 2,
      failed_count: 0,
      retry_ready_count: 0,
      stale_lease_count: 0,
      oldest_pending_at: null,
      last_processed_at: '2026-09-01T10:04:00.000Z',
    },
    {
      id: 'reconciliation',
      status: 'unobserved',
      pending_count: 0,
      processing_count: 0,
      processed_count: 0,
      failed_count: 0,
      retry_ready_count: 0,
      stale_lease_count: 0,
      oldest_pending_at: null,
      last_processed_at: null,
    },
  ],
  metrics: {
    row_count: 2,
    partial_count: 2,
    reconciled_count: 0,
    finalized_count: 0,
    latest_metric_date: '2026-09-01',
    latest_calculated_at: '2026-09-01T10:04:00.000Z',
  },
  reconciliation: {
    run_count: 1,
    open_exception_count: 1,
    recent_runs: [
      {
        provider: 'stripe',
        status: 'failed',
        scheduled_for: '2026-09-01T08:00:00.000Z',
        started_at: '2026-09-01T08:01:00.000Z',
        completed_at: '2026-09-01T08:02:00.000Z',
        exception_count: 1,
        details: 'must-not-cross-the-mapper',
      },
    ],
  },
  processing_error: 'must-not-cross-the-mapper',
}

describe('admin observability mappers', () => {
  it('maps attribution aggregates and drops unknown sensitive response fields', () => {
    const mapped = mapAdminAttributionOverview(attributionResponse)

    expect(mapped).toMatchObject({
      summary: { clicks: 14, qualifiedConversions: 3 },
      breakdown: [{ productName: 'Daily Planner', sourceName: 'TikTok' }],
      recentAcquisitions: { items: [{ partnerName: 'Victory Media' }], totalCount: 1 },
    })
    expect(JSON.stringify(mapped)).not.toContain('must-not-cross-the-mapper')
    expect(JSON.stringify(mapped)).not.toContain('account_id')
  })

  it('accepts the one-row PostgREST wrapper for attribution', () => {
    expect(
      mapAdminAttributionOverview([{ get_admin_attribution_overview: attributionResponse }])
        .generatedAt,
    ).toBe('2026-09-01T12:00:00.000Z')
  })

  it('rejects internally inconsistent attribution totals', () => {
    expect(() =>
      mapAdminAttributionOverview({
        ...attributionResponse,
        summary: { ...attributionResponse.summary, resolved_acquisitions: 5 },
      }),
    ).toThrow('Invalid attribution summary totals')
  })

  it('maps all required Data Health dimensions without raw operational fields', () => {
    const mapped = mapAdminDataHealth(dataHealthResponse)

    expect(mapped).toMatchObject({
      overallStatus: 'attention',
      providers: [
        { id: 'click_tracker', status: 'ready' },
        { id: 'funnel_events', status: 'ready' },
        { id: 'stripe', status: 'attention' },
        { id: 'singular', status: 'unobserved' },
      ],
      metrics: { rowCount: 2, partialCount: 2 },
    })
    expect(mapped.queues[0]).toMatchObject({ id: 'stripe_events', failedCount: 1 })
    expect(JSON.stringify(mapped)).not.toContain('must-not-cross-the-mapper')
    expect(JSON.stringify(mapped)).not.toContain('processing_error')
  })

  it('accepts finalized reporting rows as a separate terminal stage', () => {
    const mapped = mapAdminDataHealth({
      ...dataHealthResponse,
      metrics: {
        ...dataHealthResponse.metrics,
        row_count: 3,
        partial_count: 0,
        reconciled_count: 1,
        finalized_count: 2,
      },
    })

    expect(mapped.metrics).toMatchObject({
      rowCount: 3,
      reconciledCount: 1,
      finalizedCount: 2,
    })
  })

  it('rejects missing or duplicate Data Health dimensions', () => {
    expect(() =>
      mapAdminDataHealth({
        ...dataHealthResponse,
        providers: dataHealthResponse.providers.slice(0, 3),
      }),
    ).toThrow('Invalid observability dimensions')
  })

  it('rejects unsafe numeric values', () => {
    expect(() =>
      mapAdminDataHealth({
        ...dataHealthResponse,
        metrics: { ...dataHealthResponse.metrics, row_count: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow('Invalid row_count')
  })
})
