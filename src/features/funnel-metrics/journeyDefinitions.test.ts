import { describe, expect, it, vi } from 'vitest'
import { createFunnelMetricsGateway } from './gateway'
import {
  getJourneyTemplate,
  journeyDefinitionToBackend,
  mapJourneyDefinitionConfiguration,
  validateJourneyDefinition,
} from './journeyDefinitions'
import { mapFunnelJourney } from './journey'
import { journeyPayload } from './journey.test-fixtures'

const config = (funnel = 'funnel-a') => ({
  funnel_id: funnel,
  draft: {
    revision: 0,
    template: 'sales',
    definition: journeyDefinitionToBackend(getJourneyTemplate('sales')),
  },
  published: null,
  versions: [],
})

describe('product-neutral journey definitions', () => {
  it('keeps a generic sales funnel free of webinar/assessment defaults and returns independent templates', () => {
    for (const name of ['sales', 'webinar', 'blank', 'custom'] as const)
      expect(validateJourneyDefinition(getJourneyTemplate(name))).toEqual([])
    expect(JSON.stringify(getJourneyTemplate('sales'))).not.toMatch(/webinar|assessment|matching/)
    getJourneyTemplate('sales').stages.pop()
    expect(getJourneyTemplate('sales').stages).toHaveLength(6)
  })
  it('prevents forged financial stages, broken paths and ambiguous identifiers', () => {
    const def = getJourneyTemplate('sales')
    def.stages[0].eventNames = ['purchase_completed']
    def.stages[1].key = def.stages[0].key
    def.rates[0].steps = ['missing', 'paid']
    expect(validateJourneyDefinition(def)).toHaveLength(3)
    def.stages[5].stateValue = 'paid'
    expect(validateJourneyDefinition(def).join(' ')).toContain('verified payments only')
  })
  it('maps versioned definitions without accepting a different funnel or invalid version', () => {
    const data = config()
    expect(mapJourneyDefinitionConfiguration(data, 'funnel-a').draft.definition).toEqual(
      getJourneyTemplate('sales'),
    )
    expect(() => mapJourneyDefinitionConfiguration(data, 'funnel-b')).toThrow()
    expect(() =>
      mapJourneyDefinitionConfiguration(
        { ...data, draft: { ...data.draft, revision: -1 } },
        'funnel-a',
      ),
    ).toThrow()
  })
  it('saves and publishes journey rules with optimistic revision and no payment settings', async () => {
    const client = { rpc: vi.fn(async () => ({ data: config(), error: null })) }
    const gateway = createFunnelMetricsGateway(client)
    expect((await gateway.getJourneyDefinition!('funnel-a')).status).toBe('ready')
    expect(
      (
        await gateway.saveJourneyDefinition!({
          funnelId: 'funnel-a',
          expectedRevision: 0,
          template: 'sales',
          definition: getJourneyTemplate('sales'),
        })
      ).status,
    ).toBe('ready')
    expect(client.rpc).toHaveBeenLastCalledWith('save_admin_funnel_journey_definition', {
      p_input: {
        funnel_id: 'funnel-a',
        expected_revision: 0,
        template: 'sales',
        definition: journeyDefinitionToBackend(getJourneyTemplate('sales')),
      },
    })
    await gateway.publishJourneyDefinition!({ funnelId: 'funnel-a', expectedRevision: 0 })
    expect(client.rpc).toHaveBeenLastCalledWith('publish_admin_funnel_journey_definition', {
      p_input: { funnel_id: 'funnel-a', expected_revision: 0 },
    })
  })
  it('retains actionable conflicts and refuses an invalid definition without a request', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '40001' } }))
    const gateway = createFunnelMetricsGateway({ rpc })
    expect(
      (
        await gateway.saveJourneyDefinition!({
          funnelId: 'funnel-a',
          expectedRevision: 0,
          template: 'sales',
          definition: getJourneyTemplate('sales'),
        })
      ).error?.code,
    ).toBe('conflict')
    const def = getJourneyTemplate('sales')
    def.paths[0].steps = ['missing', 'paid']
    expect(
      (
        await gateway.saveJourneyDefinition!({
          funnelId: 'funnel-a',
          expectedRevision: 0,
          template: 'sales',
          definition: def,
        })
      ).error?.code,
    ).toBe('invalid_input')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('maps configured stage labels and enforces coherent conversion counts without reusing hidden stages', () => {
    const raw = {
      ...journeyPayload(),
      definition_version: 2,
      definition_published_at: '2026-10-22T16:00:00Z',
      definition_template: 'custom',
      configured_stages: [{ key: 'project', label: 'First project created', people: 4 }],
      configured_rates: [
        {
          key: 'activation',
          label: 'Trial → first project',
          numerator: 4,
          denominator: 10,
          value: 40,
          status: 'available',
        },
      ],
      configured_paths: [{ key: 'activated', label: 'Activated trial', people: 4 }],
    }
    expect(mapFunnelJourney(raw).configuredStages).toEqual([
      { key: 'project', label: 'First project created', people: 4 },
    ])
    expect(() =>
      mapFunnelJourney({
        ...raw,
        configured_rates: [{ ...raw.configured_rates[0], numerator: 11 }],
      }),
    ).toThrow()
    expect(() =>
      mapFunnelJourney({ ...raw, definition_version: null, definition_published_at: null }),
    ).toThrow()
  })
})
