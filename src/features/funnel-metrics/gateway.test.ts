import { describe, expect, it, vi } from 'vitest'
import { createFunnelMetricsGateway, FUNNEL_METRICS_RPCS } from './gateway'
import { funnelMetricTemplate } from './templates'
import { metricDefinitionToBackend } from './mappers'
import { validateMetricDefinitions } from './validation'
import { journeyPayload } from './journey.test-fixtures'
import type { FunnelMetricDefinition } from './types'

const filter = {
  productId: 'product-a',
  funnelId: 'funnel-a',
  from: '2026-10-01',
  to: '2026-10-14',
  timeZone: 'Africa/Lagos',
}
const config = () => ({
  product_id: 'product-a',
  funnel_id: 'funnel-a',
  draft: {
    revision: 3,
    template: 'sales',
    metrics: funnelMetricTemplate('sales').map(metricDefinitionToBackend),
  },
  versions: [],
})
const report = () => ({
  product_id: 'product-a',
  funnel_id: 'funnel-a',
  version: 1,
  published_at: '2026-10-01T00:00:00Z',
  effective_until: null,
  as_of: '2026-10-14T00:00:00Z',
  last_received_at: null,
  status: 'awaiting_data',
  metrics: [
    {
      key: 'known_zero',
      label: 'Known zero',
      type: 'event_count',
      value: 0,
      availability: 'available',
      last_received_at: null,
    },
    {
      key: 'unknown',
      label: 'Unknown',
      type: 'unique_people',
      value: null,
      availability: 'awaiting_data',
      last_received_at: null,
    },
    {
      key: 'conversion',
      label: 'Conversion',
      type: 'ratio',
      value: 25,
      availability: 'available',
      last_received_at: null,
    },
  ],
  commerce: {
    source: 'external_verified_ledger',
    availability: 'unconnected',
    commission_status: 'held',
    currencies: [],
    last_received_at: null,
  },
})
const transport = (data: unknown) => ({ rpc: vi.fn(async () => ({ data, error: null })) })

describe('funnel metrics gateway', () => {
  it('selects an immutable journey version independently from the custom-card version', async () => {
    const journey = {
      ...journeyPayload(),
      definition_version: 3,
      definition_template: 'custom',
      definition_published_at: '2026-10-22T16:00:00Z',
      configured_stages: [{ key: 'project', label: 'Project created', people: 4 }],
      configured_rates: [],
      configured_paths: [],
    }
    const client = transport({ ...report(), journey })
    const gateway = createFunnelMetricsGateway(client)
    expect(
      (await gateway.getReport({ ...filter, version: 1, journeyVersion: 3 })).data?.journey
        ?.definitionVersion,
    ).toBe(3)
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.report, {
      p_input: expect.objectContaining({ version: 1, journey_version: 3 }),
    })
    expect((await gateway.getReport({ ...filter, journeyVersion: 2 })).error?.code).toBe(
      'invalid_response',
    )
    expect((await gateway.getReport({ ...filter, journeyVersion: -1 })).error?.code).toBe(
      'invalid_input',
    )
    expect(client.rpc).toHaveBeenCalledTimes(2)
  })
  it('passes explicit journey scope and preserves zero-denominator rates and fractional EPC', async () => {
    const client = transport({ ...report(), journey: journeyPayload() })
    const result = await createFunnelMetricsGateway(client).getReport({
      ...filter,
      environment: 'test',
      conversionWindowDays: 30,
      currency: 'USD',
    })
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.report, {
      p_input: expect.objectContaining({
        environment: 'test',
        conversion_window_days: 30,
        currency: 'USD',
      }),
    })
    expect(result.data?.journey?.rates[1]).toMatchObject({
      value: null,
      denominator: 0,
      status: 'zero_denominator',
    })
    expect(result.data?.journey?.commerce[0].approvedEpcMinor).toBe(50.7)
  })
  it('rejects mismatched journey environment, currency and invalid denominator instead of displaying incorrect earnings', async () => {
    const source = { ...report(), journey: journeyPayload() }
    expect(
      (
        await createFunnelMetricsGateway(transport(source)).getReport({
          ...filter,
          environment: 'live',
        })
      ).error?.code,
    ).toBe('invalid_response')
    expect(
      (
        await createFunnelMetricsGateway(transport(source)).getReport({
          ...filter,
          currency: 'EUR',
        })
      ).error?.code,
    ).toBe('invalid_response')
    source.journey.rates[0].denominator = 0
    expect(
      (await createFunnelMetricsGateway(transport(source)).getReport(filter)).error?.code,
    ).toBe('invalid_response')
  })
  it('preserves the different click denominator when more than one lead shares a click', async () => {
    const source = { ...report(), journey: journeyPayload() }
    source.journey.rates = [
      {
        key: 'click_to_signup',
        label: 'Creator click → email signup',
        numerator: 2,
        denominator: 1,
        value: 200,
        status: 'available',
      },
    ]
    expect(
      (await createFunnelMetricsGateway(transport(source)).getReport(filter)).data?.journey
        ?.rates[0].value,
    ).toBe(200)
    source.journey.rates[0].key = 'signup_to_purchase'
    expect(
      (await createFunnelMetricsGateway(transport(source)).getReport(filter)).error?.code,
    ).toBe('invalid_response')
  })
  it('reads unconfigured click classification and uses an optimistic timestamp when saving settings', async () => {
    expect(
      (await createFunnelMetricsGateway(transport(null)).getJourneyConfiguration!('funnel-a'))
        .status,
    ).toBe('ready')
    const client = transport({
      funnel_id: 'funnel-a',
      environment: 'test',
      conversion_window_days: 45,
      updated_at: '2026-10-22T10:00:00Z',
    })
    await createFunnelMetricsGateway(client).saveJourneyConfiguration!({
      funnelId: 'funnel-a',
      environment: 'test',
      conversionWindowDays: 45,
      expectedUpdatedAt: '2026-10-20T10:00:00Z',
    })
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.saveJourneyConfiguration, {
      p_input: {
        funnel_id: 'funnel-a',
        environment: 'test',
        conversion_window_days: 45,
        expected_updated_at: '2026-10-20T10:00:00Z',
      },
    })
  })
  it('roundtrips six counting types, hidden definitions and ordered ratio dependencies', async () => {
    const metrics: FunnelMetricDefinition[] = [
      ...funnelMetricTemplate('webinar'),
      {
        ...funnelMetricTemplate('sales')[2],
        key: 'custom_ratio',
        order: 3,
        config: { numeratorKey: 'webinar_attendees', denominatorKey: 'webinar_registrations' },
      },
      {
        ...funnelMetricTemplate('sales')[0],
        key: 'live_viewers',
        label: 'Live viewers',
        eventKey: 'webinar_presence',
        kind: 'live_presence',
        order: 4,
      },
      {
        ...funnelMetricTemplate('sales')[0],
        key: 'resource_opens',
        label: 'Resource opens',
        eventKey: 'resource_opened',
        kind: 'event_count',
        order: 5,
      },
    ]
    metrics[0].visible = false
    const source = config()
    source.draft.metrics = metrics.map(metricDefinitionToBackend)
    const client = transport(source),
      gateway = createFunnelMetricsGateway(client)
    const result = await gateway.saveDraft({
      ...filter,
      expectedRevision: 3,
      metrics,
      template: 'webinar',
    })
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.save, {
      p_input: {
        funnel_id: 'funnel-a',
        expected_revision: 3,
        template: 'webinar',
        metrics: metrics.map(metricDefinitionToBackend),
      },
    })
    expect(result.data?.draft.metrics[0]).toMatchObject({
      visible: false,
      kind: 'unique_per_context',
    })
    expect(result.data?.draft.metrics[1]).toMatchObject({
      kind: 'current_state',
      eventKey: 'webinar_attendance_updated',
      config: { stateValue: 'attended' },
    })
    expect(result.data?.draft.metrics[4].kind).toBe('live_presence')
    expect(result.data?.draft.metrics[5].kind).toBe('event_count')
  })
  it('rejects cross-product and cross-funnel responses instead of showing another report', async () => {
    const wrong = report()
    wrong.product_id = 'product-b'
    expect((await createFunnelMetricsGateway(transport(wrong)).getReport(filter)).error?.code).toBe(
      'invalid_response',
    )
    const wrongConfig = config()
    wrongConfig.funnel_id = 'funnel-b'
    expect(
      (
        await createFunnelMetricsGateway(transport(wrongConfig)).getConfiguration(
          'product-a',
          'funnel-a',
        )
      ).data,
    ).toBeNull()
  })
  it('preserves unavailable values, known zero and percentage units', async () => {
    const result = await createFunnelMetricsGateway(transport(report())).getReport(filter)
    expect(result.data?.metrics.map((item) => [item.value, item.status])).toEqual([
      [0, 'available'],
      [null, 'no_data'],
      [25, 'available'],
    ])
    expect(result.data?.externalCommerceStatus).toBe('unconnected')
  })
  it('preserves verified commerce test/live separation and fails closed if mode is missing', async () => {
    const source = report() as ReturnType<typeof report> & { commerce: { currencies: unknown[] } }
    const currency = {
      currency: 'USD',
      livemode: false,
      purchases: 1,
      refunds: 0,
      gross_minor: 2500,
      refunded_minor: 0,
      net_minor: 2500,
    }
    source.commerce.currencies.push(currency)
    const result = await createFunnelMetricsGateway(transport(source)).getReport(filter)
    expect(result.data?.externalCommerce?.[0]).toMatchObject({ livemode: false, grossCents: 2500 })
    delete (currency as Partial<typeof currency>).livemode
    expect(
      (await createFunnelMetricsGateway(transport(source)).getReport(filter)).error?.code,
    ).toBe('invalid_response')
  })
  it('sends inclusive calendar dates, time zone, link and version without an affiliate override', async () => {
    const client = transport(report())
    await createFunnelMetricsGateway(client).getReport({ ...filter, linkId: 'link-a', version: 2 })
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.report, {
      p_input: {
        product_id: 'product-a',
        funnel_id: 'funnel-a',
        date_from: filter.from,
        date_to: filter.to,
        time_zone: filter.timeZone,
        link_id: 'link-a',
        version: 2,
      },
    })
  })
  it('does not call the server for impossible dates or invalid ratio dependencies', async () => {
    const client = transport(config()),
      gateway = createFunnelMetricsGateway(client)
    expect((await gateway.getReport({ ...filter, from: '2026-02-30' })).error?.code).toBe(
      'invalid_input',
    )
    const metrics = funnelMetricTemplate('sales').reverse()
    expect(
      (await gateway.saveDraft({ ...filter, expectedRevision: 1, template: 'sales', metrics }))
        .error?.code,
    ).toBe('invalid_input')
    expect(client.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['40001', 'conflict'],
    ['42501', 'unauthorized'],
    ['PGRST202', 'unconfigured'],
    ['22023', 'invalid_input'],
  ])('maps %s without exposing backend detail', async (code, expected) => {
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: { code, message: 'internal SQL details' } })),
    }
    const result = await createFunnelMetricsGateway(client).getConfiguration(
      'product-a',
      'funnel-a',
    )
    expect(result.error?.code).toBe(expected)
    expect(result.error?.message).not.toContain('internal SQL')
  })
  it('treats missing setup and network failures separately', async () => {
    expect((await createFunnelMetricsGateway(null).getReport(filter)).status).toBe('unconfigured')
    expect(
      (
        await createFunnelMetricsGateway({ rpc: () => Promise.reject(Error('offline')) }).getReport(
          filter,
        )
      ).error,
    ).toMatchObject({ code: 'unavailable', retryable: true })
  })
  it('uses sample-only RPC and never reports it as a connected product', async () => {
    const client = transport({ preview: true, metrics: report().metrics })
    const result = await createFunnelMetricsGateway(client).preview({
      ...filter,
      metrics: funnelMetricTemplate('sales'),
      sampleEvents: [],
    })
    expect(client.rpc).toHaveBeenCalledWith(FUNNEL_METRICS_RPCS.preview, expect.any(Object))
    expect(result.data).toMatchObject({
      status: 'unpublished',
      version: null,
      externalCommerceStatus: 'unconnected',
    })
    expect(result.data?.warnings[0]).toContain('Sample preview')
  })
})

describe('metric definition rules', () => {
  it('maps the webinar starter to confirmed attendance without promising live presence', () => {
    const metrics = funnelMetricTemplate('webinar')
    expect(metrics).toHaveLength(3)
    expect(metricDefinitionToBackend(metrics[1])).toMatchObject({
      event_name: 'webinar_attendance_updated',
      type: 'current_state',
      state_value: 'attended',
    })
    expect(metrics.some((metric) => metric.kind === 'live_presence')).toBe(false)
    expect(metrics.some((metric) => metric.kind === 'ratio')).toBe(false)
    expect(validateMetricDefinitions(metrics, false)).toEqual([])
  })
  it('accepts a preceding state count in ratios but rejects missing states and forward dependencies', () => {
    const metrics = funnelMetricTemplate('webinar')
    metrics.push({
      key: 'custom_ratio',
      label: 'Custom ratio',
      eventKey: '',
      kind: 'ratio',
      description: '',
      visible: true,
      order: 3,
      config: { numeratorKey: 'webinar_registrations', denominatorKey: 'webinar_attendees' },
    })
    expect(validateMetricDefinitions(metrics, false)).toEqual([])
    expect(validateMetricDefinitions([metrics[3], ...metrics.slice(0, 3)])).toContain(
      'Metric 1: choose two count metrics above this percentage.',
    )
    metrics[1].config = {}
    expect(validateMetricDefinitions(metrics)).toContain(
      'Metric 2: enter the state value to count.',
    )
  })
  it('all four templates use the same valid engine and independent mutable drafts', () => {
    for (const template of ['blank', 'sales', 'subscription', 'webinar'] as const)
      expect(validateMetricDefinitions(funnelMetricTemplate(template))).toEqual([])
    const first = funnelMetricTemplate('sales')
    first[0].label = 'Changed'
    expect(funnelMetricTemplate('sales')[0].label).toBe('Registered leads')
  })
  it('matches backend key bounds and rejects duplicate/too-many metrics', () => {
    const metric = funnelMetricTemplate('sales')[0]
    expect(validateMetricDefinitions([{ ...metric, key: 'a', eventKey: 'b' }])).toEqual([])
    expect(validateMetricDefinitions([{ ...metric, key: 'x'.repeat(51) }])).not.toEqual([])
    expect(validateMetricDefinitions([{ ...metric, eventKey: 'x'.repeat(81) }])).not.toEqual([])
    expect(validateMetricDefinitions([metric, metric])).toContain(
      'Metric 2: choose a unique metric key.',
    )
    expect(
      validateMetricDefinitions(
        Array.from({ length: 25 }, (_, i) => ({ ...metric, key: `metric_${i}` })),
      )[0],
    ).toContain('24')
  })
})
it('passes only named context filters and rejects personal dimension values before requesting', async () => {
  const client = transport(report()),
    gateway = createFunnelMetricsGateway(client)
  await gateway.getReport({
    ...filter,
    channel: 'creator',
    entryVariant: 'book',
    webinarId: 'event1',
    intakeId: 'intake1',
    contextId: 'group1',
  })
  expect(client.rpc).toHaveBeenLastCalledWith('get_partner_funnel_metrics_report', {
    p_input: {
      product_id: filter.productId,
      funnel_id: filter.funnelId,
      date_from: filter.from,
      date_to: filter.to,
      time_zone: filter.timeZone,
      channel: 'creator',
      entry_variant: 'book',
      webinar_id: 'event1',
      intake_id: 'intake1',
      context_id: 'group1',
    },
  })
  client.rpc.mockClear()
  expect((await gateway.getReport({ ...filter, channel: 'person@example.com' })).status).toBe(
    'error',
  )
  expect(client.rpc).not.toHaveBeenCalled()
})
