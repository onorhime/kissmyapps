import { supabase } from '../../lib/supabase'
import type {
  FunnelMetricConfiguration,
  FunnelJourneyConfiguration,
  FunnelMetricReport,
  FunnelMetricReportFilter,
  FunnelMetricsError,
  FunnelMetricsGateway,
  FunnelMetricsResult,
  FunnelMetricsRpcClient,
} from './types'
import {
  mapEventValidation,
  mapMetricConfiguration,
  mapMetricPreview,
  mapMetricReport,
  metricDefinitionToBackend,
  reportFilterToBackend,
} from './mappers'
import { validateMetricDefinitions, validateMetricReportFilter } from './validation'
import {
  journeyDefinitionToBackend,
  mapJourneyDefinitionConfiguration,
  validateJourneyDefinition,
} from './journeyDefinitions'
export const FUNNEL_METRICS_RPCS = Object.freeze({
  configuration: 'get_admin_funnel_metrics_config',
  save: 'save_admin_funnel_metrics_draft',
  publish: 'publish_admin_funnel_metrics',
  validate: 'validate_admin_funnel_metric_event',
  preview: 'preview_admin_funnel_metrics',
  adminReport: 'get_admin_funnel_metrics_report',
  report: 'get_partner_funnel_metrics_report',
  journeyConfiguration: 'get_admin_funnel_journey_configuration',
  saveJourneyConfiguration: 'configure_admin_funnel_journey',
  journeyDefinition: 'get_admin_funnel_journey_definition',
  saveJourneyDefinition: 'save_admin_funnel_journey_definition',
  publishJourneyDefinition: 'publish_admin_funnel_journey_definition',
})
const failure = <T>(
  code: FunnelMetricsError['code'],
  message: string,
  retryable = false,
): FunnelMetricsResult<T> => ({
  data: null,
  status:
    code === 'unconfigured' ? 'unconfigured' : code === 'unauthorized' ? 'unauthorized' : 'error',
  error: { code, message, retryable },
})
export function createFunnelMetricsGateway(
  client: FunnelMetricsRpcClient | null = supabase as unknown as FunnelMetricsRpcClient | null,
): FunnelMetricsGateway {
  async function request<T>(
    name: string,
    args: Record<string, unknown>,
    map: (value: unknown) => T,
  ): Promise<FunnelMetricsResult<T>> {
    if (!client)
      return failure('unconfigured', 'Funnel reporting is not connected in this environment.')
    try {
      const response = await client.rpc(name, args)
      if (response.error) {
        const code = response.error.code || ''
        if (['40001', '23505'].includes(code))
          return failure(
            'conflict',
            'This reporting draft changed in another tab. Reload it before saving or publishing.',
          )
        if (['42501', 'PGRST301'].includes(code))
          return failure(
            'unauthorized',
            'Your account does not have access to this funnel’s reporting.',
          )
        if (['42883', 'PGRST202'].includes(code))
          return failure(
            'unconfigured',
            'The reporting service is not installed in this environment yet.',
          )
        if (['22023', '23514'].includes(code))
          return failure(
            'invalid_input',
            'Check the metric definitions and sample event fields, then try again.',
          )
        return failure(
          'unavailable',
          'Funnel reporting could not be loaded. Please try again.',
          true,
        )
      }
      try {
        return { data: map(response.data), status: 'ready', error: null }
      } catch {
        return failure(
          'invalid_response',
          'The reporting response was incomplete. Reload before making changes.',
          true,
        )
      }
    } catch {
      return failure(
        'unavailable',
        'The reporting request could not reach the server. Your edits are still here.',
        true,
      )
    }
  }
  function configurationScope(productId: string, funnelId: string) {
    return (value: unknown) => {
      const mapped = mapMetricConfiguration(value)
      if (mapped.productId !== productId || mapped.funnelId !== funnelId)
        throw Error('Scope mismatch.')
      return mapped
    }
  }
  async function report(
    filter: FunnelMetricReportFilter,
    admin: boolean,
  ): Promise<FunnelMetricsResult<FunnelMetricReport>> {
    const invalid = validateMetricReportFilter(filter)
    if (invalid) return failure('invalid_input', invalid)
    return request(
      admin ? FUNNEL_METRICS_RPCS.adminReport : FUNNEL_METRICS_RPCS.report,
      { p_input: reportFilterToBackend(filter) },
      (value) => {
        const mapped = mapMetricReport(value)
        if (mapped.productId !== filter.productId || mapped.funnelId !== filter.funnelId)
          throw Error('Scope mismatch.')
        if (
          mapped.journey &&
          ((filter.environment && mapped.journey.environment !== filter.environment) ||
            (filter.conversionWindowDays !== undefined &&
              mapped.journey.conversionWindowDays !== filter.conversionWindowDays) ||
            (filter.currency &&
              mapped.journey.commerce.some((item) => item.currency !== filter.currency)) ||
            (filter.journeyVersion !== undefined &&
              mapped.journey.definitionVersion !== filter.journeyVersion))
        )
          throw Error('Journey scope mismatch.')
        return mapped
      },
    )
  }
  return {
    getJourneyDefinition: (funnelId) =>
      request(FUNNEL_METRICS_RPCS.journeyDefinition, { p_funnel_id: funnelId }, (value) =>
        mapJourneyDefinitionConfiguration(value, funnelId),
      ),
    saveJourneyDefinition: (input) => {
      const invalid = validateJourneyDefinition(input.definition)
      if (
        invalid.length ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 ||
        !['blank', 'webinar', 'sales', 'custom'].includes(input.template)
      )
        return Promise.resolve(
          failure(
            'invalid_input',
            invalid.join(' ') || 'Reload the journey definition before saving.',
          ),
        )
      return request(
        FUNNEL_METRICS_RPCS.saveJourneyDefinition,
        {
          p_input: {
            funnel_id: input.funnelId,
            expected_revision: input.expectedRevision,
            template: input.template,
            definition: journeyDefinitionToBackend(input.definition),
          },
        },
        (value) => mapJourneyDefinitionConfiguration(value, input.funnelId),
      )
    },
    publishJourneyDefinition: (input) => {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        return Promise.resolve(
          failure('invalid_input', 'Reload the journey definition before publishing.'),
        )
      return request(
        FUNNEL_METRICS_RPCS.publishJourneyDefinition,
        { p_input: { funnel_id: input.funnelId, expected_revision: input.expectedRevision } },
        (value) => mapJourneyDefinitionConfiguration(value, input.funnelId),
      )
    },
    getJourneyConfiguration: (funnelId) =>
      request(FUNNEL_METRICS_RPCS.journeyConfiguration, { p_funnel_id: funnelId }, (value) =>
        value === null ? null : mapJourneyConfiguration(value, funnelId),
      ),
    saveJourneyConfiguration: (input) => {
      if (
        !['test', 'live'].includes(input.environment) ||
        !Number.isInteger(input.conversionWindowDays) ||
        input.conversionWindowDays < 1 ||
        input.conversionWindowDays > 365
      )
        return Promise.resolve(
          failure(
            'invalid_input',
            'Choose an explicit environment and a reporting window from 1 to 365 days.',
          ),
        )
      return request(
        FUNNEL_METRICS_RPCS.saveJourneyConfiguration,
        {
          p_input: {
            funnel_id: input.funnelId,
            environment: input.environment,
            conversion_window_days: input.conversionWindowDays,
            ...(input.expectedUpdatedAt ? { expected_updated_at: input.expectedUpdatedAt } : {}),
          },
        },
        (value) => {
          const mapped = mapJourneyConfiguration(value, input.funnelId)
          if (
            mapped.environment !== input.environment ||
            mapped.conversionWindowDays !== input.conversionWindowDays
          )
            throw Error('Journey configuration mismatch.')
          return mapped
        },
      )
    },
    getConfiguration: (productId, funnelId) =>
      request(
        FUNNEL_METRICS_RPCS.configuration,
        { p_funnel_id: funnelId },
        configurationScope(productId, funnelId),
      ),
    saveDraft: (input) => {
      const invalid = validateMetricDefinitions(input.metrics)
      if (invalid.length)
        return Promise.resolve(
          failure<FunnelMetricConfiguration>('invalid_input', invalid.join(' ')),
        )
      return request(
        FUNNEL_METRICS_RPCS.save,
        {
          p_input: {
            funnel_id: input.funnelId,
            expected_revision: input.expectedRevision,
            template: input.template,
            metrics: input.metrics.map(metricDefinitionToBackend),
          },
        },
        configurationScope(input.productId, input.funnelId),
      )
    },
    publish: (input) =>
      request(
        FUNNEL_METRICS_RPCS.publish,
        { p_funnel_id: input.funnelId, p_expected_revision: input.expectedRevision },
        configurationScope(input.productId, input.funnelId),
      ),
    validateEvent: (input) =>
      request(
        FUNNEL_METRICS_RPCS.validate,
        { p_input: { funnel_id: input.funnelId, event: input.event } },
        mapEventValidation,
      ),
    preview: (input) => {
      const invalid = validateMetricDefinitions(input.metrics, false)
      if (invalid.length || input.sampleEvents.length > 100)
        return Promise.resolve(
          failure('invalid_input', invalid[0] || 'Use up to 100 sample events.'),
        )
      return request(
        FUNNEL_METRICS_RPCS.preview,
        {
          p_input: {
            funnel_id: input.funnelId,
            metrics: input.metrics.map(metricDefinitionToBackend),
            sample_events: input.sampleEvents,
          },
        },
        (value) => mapMetricPreview(value, input.productId, input.funnelId),
      )
    },
    getAdminReport: (filter) => report(filter, true),
    getReport: (filter) => report(filter, false),
  }
}
export const funnelMetricsGateway = createFunnelMetricsGateway()

function mapJourneyConfiguration(value: unknown, funnelId: string): FunnelJourneyConfiguration {
  if (!value || typeof value !== 'object') throw Error('Invalid journey configuration.')
  const item = value as Record<string, unknown>
  if (
    item.funnel_id !== funnelId ||
    !['test', 'live'].includes(String(item.environment)) ||
    typeof item.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(item.updated_at)) ||
    typeof item.conversion_window_days !== 'number' ||
    !Number.isInteger(item.conversion_window_days) ||
    item.conversion_window_days < 1 ||
    item.conversion_window_days > 365
  )
    throw Error('Invalid journey configuration scope.')
  return {
    funnelId,
    environment: item.environment as 'test' | 'live',
    conversionWindowDays: item.conversion_window_days,
    updatedAt: item.updated_at,
  }
}
