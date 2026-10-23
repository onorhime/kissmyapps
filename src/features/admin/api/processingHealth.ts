import { singleAdminRow } from './mappers'

export const PROCESSING_ALERT_LABELS = {
  managed_checkout_issue:
    'Managed checkout delivery or reconciliation needs attention. Inspect its schedule and callback queue.',
  scheduler_paused: 'Processing is paused. An operator must inspect it before resuming.',
  heartbeat_stale: 'The scheduler heartbeat is missing or more than three minutes old.',
  cycle_stale: 'No complete processing cycle has been recorded in the last ten minutes.',
  recent_worker_issue: 'A worker reported a failure, retry or deferred job within the last hour.',
  jobs_failed: 'Some jobs exhausted their retries and need operator review.',
  leases_expired: 'Some job leases expired. Inspect the worker before any recovery.',
  jobs_stalled: 'Unfinished jobs have been waiting for more than ten minutes.',
} as const
export type ProcessingAlert = keyof typeof PROCESSING_ALERT_LABELS
const workers = ['stripe-worker', 'commercial-worker', 'metrics-worker'] as const
type Worker = (typeof workers)[number]
export type AdminProcessingHealth = Readonly<{
  generatedAt: string
  attentionRequired: boolean
  reasons: readonly ProcessingAlert[]
  enabled: boolean
  currentWorker: Worker
  lastTickAt: string | null
  lastCycleAt: string | null
  externalAlertsConfigured: boolean
  notifications: Readonly<{
    lastCheckedAt: string | null
    pending: number
    failed: number
    lastAcceptedAt: string | null
  }> | null
  managedCheckout: Readonly<{
    enabled: boolean
    attentionRequired: boolean
    pausedReason: string | null
    lastTickAt: string | null
    lastSuccessAt: string | null
    pending: number
    leased: number
    retrying: number
    expiredLeases: number
  }> | null
  queues: readonly Readonly<{
    worker: 'stripe' | 'commercial' | 'metrics'
    pending: number
    processing: number
    failed: number
    expiredLeases: number
    oldestUnfinishedAt: string | null
  }>[]
  lastIncident: Readonly<{
    runId: string
    worker: Worker
    outcome: 'failed' | 'degraded'
    dispatchedAt: string
    finishedAt: string | null
    errorCode: string | null
    dispatchHttpStatus: number | null
    diagnosticCode: string | null
    upstreamHttpStatus: number | null
    durationMs: number | null
  }> | null
}>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid health object')
  return value as Record<string, unknown>
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Error('Invalid health flag')
  return value
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > maximum) {
    throw Error('Invalid health count')
  }
  return n
}
function timestamp(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw Error('Invalid health timestamp')
  }
  return value
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw Error('Invalid health state')
  return value as T
}
function code(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value))
    throw Error('Invalid diagnostic code')
  return value
}
function http(value: unknown): number | null {
  if (value === null) return null
  const n = count(value, 599)
  if (n < 100) throw Error('Invalid HTTP status')
  return n
}

export function mapAdminProcessingHealth(value: unknown): AdminProcessingHealth {
  let row = object(singleAdminRow(value))
  if (Object.hasOwn(row, 'get_admin_processing_health'))
    row = object(row.get_admin_processing_health)
  if (!Array.isArray(row.reasons) || !Array.isArray(row.queues))
    throw Error('Incomplete health data')
  const reasons = row.reasons.map((reason) =>
    choice(reason, Object.keys(PROCESSING_ALERT_LABELS) as ProcessingAlert[]),
  )
  if (new Set(reasons).size !== reasons.length) throw Error('Duplicate alert reason')
  const attentionRequired = boolean(row.attention_required)
  if (attentionRequired !== reasons.length > 0) throw Error('Inconsistent attention state')
  const queues = row.queues.map((value) => {
    const q = object(value)
    return {
      worker: choice(q.worker, ['stripe', 'commercial', 'metrics'] as const),
      pending: count(q.pending),
      processing: count(q.processing),
      failed: count(q.failed),
      expiredLeases: count(q.expired_leases),
      oldestUnfinishedAt: timestamp(q.oldest_unfinished_at),
    }
  })
  if (queues.length !== 3 || new Set(queues.map((q) => q.worker)).size !== 3)
    throw Error('Missing worker queue')
  if (queues.some((q) => q.expiredLeases > q.processing)) throw Error('Invalid lease count')
  const enabled = boolean(row.enabled)
  const generatedAt = timestamp(row.generated_at, false)!
  const lastTickAt = timestamp(row.last_tick_at)
  const lastCycleAt = timestamp(row.last_cycle_at)
  const generatedMs = Date.parse(generatedAt)
  if ((!enabled || queues.some((q) => q.failed > 0 || q.expiredLeases > 0)) && !attentionRequired) {
    throw Error('Unsafe healthy state')
  }
  if (
    !attentionRequired &&
    (!lastTickAt ||
      !lastCycleAt ||
      generatedMs - Date.parse(lastTickAt) > 180_000 ||
      generatedMs - Date.parse(lastCycleAt) > 600_000 ||
      queues.some(
        (q) => q.oldestUnfinishedAt && generatedMs - Date.parse(q.oldestUnfinishedAt) > 600_000,
      ))
  )
    throw Error('Missing freshness warning')
  let lastIncident: AdminProcessingHealth['lastIncident'] = null
  if (row.last_incident !== null) {
    const i = object(row.last_incident)
    if (
      typeof i.run_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(i.run_id)
    )
      throw Error('Invalid incident ID')
    lastIncident = {
      runId: i.run_id,
      worker: choice(i.worker, workers),
      outcome: choice(i.outcome, ['failed', 'degraded']),
      dispatchedAt: timestamp(i.dispatched_at, false)!,
      finishedAt: timestamp(i.finished_at),
      errorCode: code(i.error_code),
      diagnosticCode: code(i.diagnostic_code),
      dispatchHttpStatus: http(i.dispatch_http_status),
      upstreamHttpStatus: http(i.upstream_http_status),
      durationMs: i.duration_ms === null ? null : count(i.duration_ms, 180000),
    }
  }
  const externalAlertsConfigured = boolean(row.external_alerts_configured)
  let notifications: AdminProcessingHealth['notifications'] = null
  if (row.notifications !== undefined) {
    const n = object(row.notifications)
    if (boolean(n.enabled) !== externalAlertsConfigured)
      throw Error('Inconsistent alert configuration')
    notifications = {
      lastCheckedAt: timestamp(n.last_checked_at),
      pending: count(n.pending),
      failed: count(n.failed),
      lastAcceptedAt: timestamp(n.last_accepted_at),
    }
  } else if (externalAlertsConfigured) throw Error('Missing notification health')
  let managedCheckout: AdminProcessingHealth['managedCheckout'] = null
  if (row.managed_checkout !== undefined) {
    const m = object(row.managed_checkout)
    const s = object(m.schedule)
    const c = object(m.callbacks)
    managedCheckout = {
      enabled: boolean(s.enabled),
      attentionRequired: boolean(m.attention_required),
      pausedReason: code(s.paused_reason),
      lastTickAt: timestamp(s.last_tick_at),
      lastSuccessAt: timestamp(s.last_success_at),
      pending: count(c.pending),
      leased: count(c.leased),
      retrying: count(c.retrying),
      expiredLeases: count(c.expired_leases),
    }
    if (managedCheckout.attentionRequired !== reasons.includes('managed_checkout_issue'))
      throw Error('Inconsistent managed checkout attention state')
    if (managedCheckout.expiredLeases > managedCheckout.leased)
      throw Error('Invalid managed checkout lease count')
  }
  return {
    managedCheckout,
    generatedAt,
    attentionRequired,
    reasons,
    enabled,
    currentWorker: choice(row.current_worker, workers),
    lastTickAt,
    lastCycleAt,
    externalAlertsConfigured,
    notifications,
    queues,
    lastIncident,
  }
}
