import type {
  FunnelMetricConfiguration,
  FunnelMetricDefinition,
  FunnelMetricEventValidation,
  FunnelMetricReport,
  FunnelMetricReportFilter,
  FunnelMetricTemplateKey,
  FunnelMetricValue,
} from './types'
import { FUNNEL_METRIC_KINDS } from './validation'
import { mapFunnelJourney } from './journey'
type Row = Record<string, unknown>
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid metrics response.')
  return value as Row
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('Invalid metrics text.')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid metrics number.')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Error('Invalid metric boolean.')
  return value
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value)
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw Error('Invalid metrics collection.')
  return value.map(row)
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw Error('Invalid metrics collection.')
  return value.map(text)
}
function kind(value: unknown): FunnelMetricDefinition['kind'] {
  if (!FUNNEL_METRIC_KINDS.includes(value as FunnelMetricDefinition['kind']))
    throw Error('Invalid metric kind.')
  return value as FunnelMetricDefinition['kind']
}
function template(value: unknown): FunnelMetricTemplateKey {
  if (!['blank', 'sales', 'subscription', 'webinar'].includes(String(value)))
    throw Error('Invalid starter template.')
  return value as FunnelMetricTemplateKey
}
export function metricDefinitionToBackend(metric: FunnelMetricDefinition) {
  return {
    key: metric.key.trim(),
    label: metric.label.trim(),
    type: metric.kind,
    visible: metric.visible,
    ...(metric.kind === 'ratio'
      ? { numerator_key: metric.config.numeratorKey, denominator_key: metric.config.denominatorKey }
      : { event_name: metric.eventKey.trim() }),
    ...(metric.kind === 'current_state' ? { state_value: metric.config.stateValue?.trim() } : {}),
  }
}
export function mapMetricDefinition(value: unknown, order: number): FunnelMetricDefinition {
  const source = row(value),
    type = kind(source.type)
  if (source.visible !== undefined && typeof source.visible !== 'boolean')
    throw Error('Invalid metric visibility.')
  return {
    key: text(source.key),
    label: text(source.label),
    description: '',
    kind: type,
    eventKey: type === 'ratio' ? '' : text(source.event_name),
    visible: source.visible !== false,
    order,
    config: {
      ...(type === 'ratio'
        ? { numeratorKey: text(source.numerator_key), denominatorKey: text(source.denominator_key) }
        : {}),
      ...(type === 'current_state' ? { stateValue: text(source.state_value) } : {}),
    },
  }
}
export function mapMetricConfiguration(value: unknown): FunnelMetricConfiguration {
  const source = row(value),
    draft = row(source.draft)
  const versions = rows(source.versions).sort((a, b) => number(b.version) - number(a.version))
  const published = versions.find((version) => !version.archived_at)
  const metrics = rows(draft.metrics).map(mapMetricDefinition)
  return {
    productId: text(source.product_id),
    funnelId: text(source.funnel_id),
    draft: {
      revision: number(draft.revision),
      template: template(draft.template ?? 'blank'),
      metrics,
      updatedAt: nullableText(draft.updated_at),
    },
    published: published
      ? {
          version: number(published.version),
          publishedAt: text(published.published_at),
          metrics: rows(published.metrics).map(mapMetricDefinition),
        }
      : null,
    versions: versions.map((version) => ({
      version: number(version.version),
      publishedAt: text(version.published_at),
    })),
    eventKeys: [...new Set(metrics.map((metric) => metric.eventKey).filter(Boolean))],
  }
}
function mapValue(source: Row): FunnelMetricValue {
  const availability = text(source.availability)
  if (!['available', 'awaiting_data', 'zero_denominator'].includes(availability))
    throw Error('Invalid metric availability.')
  return {
    key: text(source.key),
    label: text(source.label),
    kind: kind(source.type),
    value: source.value === null ? null : number(source.value),
    status:
      availability === 'available'
        ? 'available'
        : availability === 'zero_denominator'
          ? 'insufficient_data'
          : 'no_data',
    updatedAt: nullableText(source.last_received_at),
  }
}
export function mapMetricReport(value: unknown): FunnelMetricReport {
  const source = row(value),
    commerce = row(source.commerce)
  const status = text(source.status)
  if (
    !['unpublished', 'awaiting_data', 'connected'].includes(status) ||
    commerce.source !== 'external_verified_ledger' ||
    !['unconnected', 'available'].includes(String(commerce.availability)) ||
    commerce.commission_status !== 'held'
  )
    throw Error('Invalid report connection status.')
  return {
    productId: text(source.product_id),
    funnelId: text(source.funnel_id),
    version: source.version === null ? null : number(source.version),
    status: status as FunnelMetricReport['status'],
    publishedAt: nullableText(source.published_at),
    effectiveUntil: nullableText(source.effective_until),
    lastReceivedAt: nullableText(source.last_received_at),
    asOf: nullableText(source.as_of),
    metrics: rows(source.metrics).map(mapValue),
    warnings: Array.isArray(source.warnings) ? strings(source.warnings) : [],
    ...(source.journey == null ? {} : { journey: mapFunnelJourney(source.journey) }),
    externalCommerceStatus: commerce.availability as FunnelMetricReport['externalCommerceStatus'],
    commissionStatus: 'held',
    externalCommerceUpdatedAt: nullableText(commerce.last_received_at),
    externalCommerce: rows(commerce.currencies).map((currency) => ({
      currency: text(currency.currency),
      livemode: boolean(currency.livemode),
      purchases: number(currency.purchases),
      refunds: number(currency.refunds),
      grossCents: number(currency.gross_minor),
      refundCents: number(currency.refunded_minor),
      netCents: number(currency.net_minor),
    })),
  }
}
export function mapMetricPreview(
  value: unknown,
  productId: string,
  funnelId: string,
): FunnelMetricReport {
  const source = row(value)
  if (source.preview !== true) throw Error('Expected a sample-only preview.')
  return {
    productId,
    funnelId,
    version: null,
    status: 'unpublished',
    publishedAt: null,
    effectiveUntil: null,
    lastReceivedAt: null,
    asOf: null,
    metrics: rows(source.metrics).map(mapValue),
    warnings: ['Sample preview only. No events were recorded.'],
    externalCommerceStatus: 'unconnected',
    commissionStatus: 'held',
    externalCommerceUpdatedAt: null,
  }
}
export function mapEventValidation(value: unknown): FunnelMetricEventValidation {
  const source = row(value)
  if (typeof source.valid !== 'boolean') throw Error('Invalid event validation response.')
  return {
    valid: source.valid,
    errors: strings(source.errors),
    warnings: Array.isArray(source.warnings) ? strings(source.warnings) : [],
    matchedMetricKeys: Array.isArray(source.matched_metric_keys)
      ? strings(source.matched_metric_keys)
      : [],
  }
}
export function reportFilterToBackend(input: FunnelMetricReportFilter) {
  return {
    product_id: input.productId,
    funnel_id: input.funnelId,
    date_from: input.from,
    date_to: input.to,
    time_zone: input.timeZone,
    ...(input.linkId ? { link_id: input.linkId } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.journeyVersion ? { journey_version: input.journeyVersion } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.entryVariant ? { entry_variant: input.entryVariant } : {}),
    ...(input.webinarId ? { webinar_id: input.webinarId } : {}),
    ...(input.intakeId ? { intake_id: input.intakeId } : {}),
    ...(input.contextId ? { context_id: input.contextId } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.conversionWindowDays !== undefined
      ? { conversion_window_days: input.conversionWindowDays }
      : {}),
    ...(input.currency ? { currency: input.currency } : {}),
  }
}
