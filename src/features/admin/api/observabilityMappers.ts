import { singleAdminRow } from './mappers'
import {
  ADMIN_DATA_HEALTH_PROVIDER_IDS,
  ADMIN_DATA_HEALTH_QUEUE_IDS,
  ADMIN_DATA_HEALTH_STATUSES,
  type AdminAttributionOverview,
  type AdminDataHealth,
  type AdminAgreementOperationsHealth,
} from './types'

const attributionMethods = ['deterministic_web', 'singular', 'manual'] as const
const acquisitionStatuses = ['open', 'resolved', 'rejected'] as const
const reconciliationStatuses = ['queued', 'running', 'passed', 'failed'] as const
const providers = ['stripe', 'singular', 'click_tracker'] as const

function record(value: unknown, label = 'object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label}.`)
  }
  return value as Record<string, unknown>
}

function rpcRoot(value: unknown, functionName: string): Record<string, unknown> {
  const row = record(singleAdminRow(value), 'RPC response')
  return Object.hasOwn(row, functionName) ? record(row[functionName], functionName) : row
}

function array(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key]
  if (!Array.isArray(value)) throw new Error(`Invalid ${key}.`)
  return value
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}.`)
  return value
}

function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Invalid ${key}.`)
  return value.trim() || null
}

function timestamp(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key)
  if (Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${key}.`)
  return value
}

function nullableTimestamp(row: Record<string, unknown>, key: string): string | null {
  const value = nullableString(row, key)
  if (value !== null && Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${key}.`)
  return value
}

function nullableDate(row: Record<string, unknown>, key: string): string | null {
  const value = nullableString(row, key)
  if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid ${key}.`)
  return value
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
  return value
}

function nonNegativeInteger(row: Record<string, unknown>, key: string): number {
  const raw = row[key]
  const value =
    typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number'
        ? raw
        : Number.NaN
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}.`)
  return value
}

export function mapAdminAgreementOperationsHealth(value: unknown): AdminAgreementOperationsHealth {
  const row = rpcRoot(value, 'get_admin_agreement_email_health')
  return {
    pending: nonNegativeInteger(row, 'pending'),
    processing: nonNegativeInteger(row, 'processing'),
    failed: nonNegativeInteger(row, 'failed'),
    sent: nonNegativeInteger(row, 'sent'),
    oldestPendingAt: nullableTimestamp(row, 'oldest_pending_at'),
    cleanupPending: nonNegativeInteger(row, 'cleanup_pending'),
    cleanupProcessing: nonNegativeInteger(row, 'cleanup_processing'),
    cleanupFailed: nonNegativeInteger(row, 'cleanup_failed'),
    cleanupDone: nonNegativeInteger(row, 'cleanup_done'),
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${key}.`)
  }
  return value as T
}

function mapAttributionReadiness(value: unknown): AdminAttributionOverview['readiness'] {
  const row = record(value, 'readiness')
  return {
    trackingEnabled: boolean(row, 'tracking_enabled'),
    baseUrlConfigured: boolean(row, 'base_url_configured'),
    activeProductCount: nonNegativeInteger(row, 'active_product_count'),
    liveFunnelCount: nonNegativeInteger(row, 'live_funnel_count'),
    activeLinkCount: nonNegativeInteger(row, 'active_link_count'),
    lastClickAt: nullableTimestamp(row, 'last_click_at'),
    lastEventAt: nullableTimestamp(row, 'last_event_at'),
    lastConversionAt: nullableTimestamp(row, 'last_conversion_at'),
  }
}

function mapAttributionSummary(value: unknown): AdminAttributionOverview['summary'] {
  const row = record(value, 'summary')
  const summary = {
    clicks: nonNegativeInteger(row, 'clicks'),
    botClicks: nonNegativeInteger(row, 'bot_clicks'),
    acquisitions: nonNegativeInteger(row, 'acquisitions'),
    resolvedAcquisitions: nonNegativeInteger(row, 'resolved_acquisitions'),
    rejectedAcquisitions: nonNegativeInteger(row, 'rejected_acquisitions'),
    events: nonNegativeInteger(row, 'events'),
    trustedEvents: nonNegativeInteger(row, 'trusted_events'),
    commercialEligibleEvents: nonNegativeInteger(row, 'commercial_eligible_events'),
    qualifiedConversions: nonNegativeInteger(row, 'qualified_conversions'),
  }
  if (
    summary.resolvedAcquisitions + summary.rejectedAcquisitions > summary.acquisitions ||
    summary.trustedEvents > summary.events ||
    summary.commercialEligibleEvents > summary.trustedEvents
  ) {
    throw new Error('Invalid attribution summary totals.')
  }
  return summary
}

export function mapAdminAttributionOverview(value: unknown): AdminAttributionOverview {
  const row = rpcRoot(value, 'get_admin_attribution_overview')
  const window = record(row.window, 'window')
  const filters = record(row.filters, 'filters')
  const recent = record(row.recent_acquisitions, 'recent_acquisitions')
  const startsAt = timestamp(window, 'starts_at')
  const endsAt = timestamp(window, 'ends_at')
  if (Date.parse(startsAt) >= Date.parse(endsAt)) throw new Error('Invalid attribution window.')

  const recentItems = array(recent, 'items').map((value) => {
    const item = record(value, 'recent acquisition')
    const clickCountry = nullableString(item, 'click_country')
    const installCountry = nullableString(item, 'install_country')
    if (
      (clickCountry !== null && !/^[A-Z]{2}$/.test(clickCountry)) ||
      (installCountry !== null && !/^[A-Z]{2}$/.test(installCountry))
    ) {
      throw new Error('Invalid acquisition country.')
    }
    const mapped = {
      productName: requiredString(item, 'product_name'),
      partnerName: nullableString(item, 'partner_name'),
      sourceName: requiredString(item, 'source_name'),
      campaignName: nullableString(item, 'campaign_name'),
      funnelName: nullableString(item, 'funnel_name'),
      attributionMethod: enumValue(
        item.attribution_method,
        attributionMethods,
        'attribution_method',
      ),
      status: enumValue(item.status, acquisitionStatuses, 'status'),
      clickCountry,
      installCountry,
      createdAt: timestamp(item, 'created_at'),
      resolvedAt: nullableTimestamp(item, 'resolved_at'),
    }
    if (mapped.status === 'resolved' && mapped.resolvedAt === null) {
      throw new Error('Invalid acquisition resolution state.')
    }
    return mapped
  })
  const totalCount = nonNegativeInteger(recent, 'total_count')
  if (totalCount < recentItems.length) throw new Error('Invalid recent acquisition count.')

  return {
    generatedAt: timestamp(row, 'generated_at'),
    window: { startsAt, endsAt },
    filters: {
      productId: nullableString(filters, 'product_id'),
      sourceId: nullableString(filters, 'source_id'),
    },
    readiness: mapAttributionReadiness(row.readiness),
    summary: mapAttributionSummary(row.summary),
    breakdown: array(row, 'breakdown').map((value) => {
      const item = record(value, 'breakdown item')
      return {
        productId: requiredString(item, 'product_id'),
        productName: requiredString(item, 'product_name'),
        sourceId: nullableString(item, 'source_id'),
        sourceName: requiredString(item, 'source_name'),
        clicks: nonNegativeInteger(item, 'clicks'),
        acquisitions: nonNegativeInteger(item, 'acquisitions'),
        qualifiedConversions: nonNegativeInteger(item, 'qualified_conversions'),
      }
    }),
    eventTypes: array(row, 'event_types').map((value) => {
      const item = record(value, 'event type')
      const eventCount = nonNegativeInteger(item, 'event_count')
      const commercialEligibleCount = nonNegativeInteger(item, 'commercial_eligible_count')
      if (commercialEligibleCount > eventCount) throw new Error('Invalid event type count.')
      return {
        eventName: requiredString(item, 'event_name'),
        eventCount,
        commercialEligibleCount,
        lastOccurredAt: timestamp(item, 'last_occurred_at'),
      }
    }),
    recentAcquisitions: { items: recentItems, totalCount },
    sources: array(row, 'sources').map((value) => {
      const item = record(value, 'source')
      return { id: requiredString(item, 'id'), name: requiredString(item, 'name') }
    }),
  }
}

export function mapAdminDataHealth(value: unknown): AdminDataHealth {
  const row = rpcRoot(value, 'get_admin_data_health')
  const catalog = record(row.catalog, 'catalog')
  const metrics = record(row.metrics, 'metrics')
  const reconciliation = record(row.reconciliation, 'reconciliation')
  const providersMapped = array(row, 'providers').map((value) => {
    const item = record(value, 'provider')
    const observedCount = nonNegativeInteger(item, 'observed_count')
    const verifiedCount = nonNegativeInteger(item, 'verified_count')
    const failedCount = nonNegativeInteger(item, 'failed_count')
    if (verifiedCount > observedCount || failedCount > observedCount) {
      throw new Error('Invalid provider counts.')
    }
    return {
      id: enumValue(item.id, ADMIN_DATA_HEALTH_PROVIDER_IDS, 'provider id'),
      status: enumValue(item.status, ADMIN_DATA_HEALTH_STATUSES, 'provider status'),
      observedCount,
      verifiedCount,
      failedCount,
      lastObservedAt: nullableTimestamp(item, 'last_observed_at'),
    }
  })
  const queuesMapped = array(row, 'queues').map((value) => {
    const item = record(value, 'queue')
    const mapped = {
      id: enumValue(item.id, ADMIN_DATA_HEALTH_QUEUE_IDS, 'queue id'),
      status: enumValue(item.status, ADMIN_DATA_HEALTH_STATUSES, 'queue status'),
      pendingCount: nonNegativeInteger(item, 'pending_count'),
      processingCount: nonNegativeInteger(item, 'processing_count'),
      processedCount: nonNegativeInteger(item, 'processed_count'),
      failedCount: nonNegativeInteger(item, 'failed_count'),
      retryReadyCount: nonNegativeInteger(item, 'retry_ready_count'),
      staleLeaseCount: nonNegativeInteger(item, 'stale_lease_count'),
      oldestPendingAt: nullableTimestamp(item, 'oldest_pending_at'),
      lastProcessedAt: nullableTimestamp(item, 'last_processed_at'),
    }
    if (
      mapped.retryReadyCount > mapped.pendingCount + mapped.failedCount ||
      mapped.staleLeaseCount > mapped.processingCount
    ) {
      throw new Error('Invalid queue counts.')
    }
    return mapped
  })
  if (
    providersMapped.length !== ADMIN_DATA_HEALTH_PROVIDER_IDS.length ||
    queuesMapped.length !== ADMIN_DATA_HEALTH_QUEUE_IDS.length ||
    new Set(providersMapped.map((item) => item.id)).size !==
      ADMIN_DATA_HEALTH_PROVIDER_IDS.length ||
    new Set(queuesMapped.map((item) => item.id)).size !== ADMIN_DATA_HEALTH_QUEUE_IDS.length
  ) {
    throw new Error('Invalid observability dimensions.')
  }

  const mappedMetrics = {
    rowCount: nonNegativeInteger(metrics, 'row_count'),
    partialCount: nonNegativeInteger(metrics, 'partial_count'),
    reconciledCount: nonNegativeInteger(metrics, 'reconciled_count'),
    finalizedCount: nonNegativeInteger(metrics, 'finalized_count'),
    latestMetricDate: nullableDate(metrics, 'latest_metric_date'),
    latestCalculatedAt: nullableTimestamp(metrics, 'latest_calculated_at'),
  }
  if (
    mappedMetrics.partialCount > mappedMetrics.rowCount ||
    mappedMetrics.reconciledCount > mappedMetrics.rowCount ||
    mappedMetrics.finalizedCount > mappedMetrics.rowCount ||
    mappedMetrics.partialCount + mappedMetrics.reconciledCount + mappedMetrics.finalizedCount >
      mappedMetrics.rowCount
  ) {
    throw new Error('Invalid metric counts.')
  }

  return {
    generatedAt: timestamp(row, 'generated_at'),
    overallStatus: enumValue(row.overall_status, ADMIN_DATA_HEALTH_STATUSES, 'overall_status'),
    catalog: {
      trackingEnabled: boolean(catalog, 'tracking_enabled'),
      baseUrlConfigured: boolean(catalog, 'base_url_configured'),
      activeProductCount: nonNegativeInteger(catalog, 'active_product_count'),
      liveFunnelCount: nonNegativeInteger(catalog, 'live_funnel_count'),
      activeLinkCount: nonNegativeInteger(catalog, 'active_link_count'),
      verifiedActiveOfferCount: nonNegativeInteger(catalog, 'verified_active_offer_count'),
      launchReadyAgreementCount: nonNegativeInteger(catalog, 'launch_ready_agreement_count'),
    },
    providers: providersMapped,
    queues: queuesMapped,
    metrics: mappedMetrics,
    reconciliation: {
      runCount: nonNegativeInteger(reconciliation, 'run_count'),
      openExceptionCount: nonNegativeInteger(reconciliation, 'open_exception_count'),
      recentRuns: array(reconciliation, 'recent_runs').map((value) => {
        const item = record(value, 'reconciliation run')
        return {
          provider: enumValue(item.provider, providers, 'provider'),
          status: enumValue(item.status, reconciliationStatuses, 'status'),
          scheduledFor: timestamp(item, 'scheduled_for'),
          startedAt: nullableTimestamp(item, 'started_at'),
          completedAt: nullableTimestamp(item, 'completed_at'),
          exceptionCount: nonNegativeInteger(item, 'exception_count'),
        }
      }),
    },
  }
}
