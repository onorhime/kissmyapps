import type {
  AdminDataHealthProviderId,
  AdminDataHealthQueueId,
  AdminDataHealthStatus,
} from '../api'

export function formatAdminCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatAdminOperationalTimestamp(value: string | null): string {
  if (!value) return 'Not observed'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)
}

export function dataHealthStatusLabel(status: AdminDataHealthStatus): string {
  return {
    ready: 'Observed',
    attention: 'Attention',
    unobserved: 'Unobserved',
    disabled: 'Disabled',
  }[status]
}

export function providerLabel(provider: AdminDataHealthProviderId): string {
  return {
    click_tracker: 'Click tracker',
    funnel_events: 'Funnel events',
    stripe: 'Stripe events',
    singular: 'Singular',
  }[provider]
}

export function queueLabel(queue: AdminDataHealthQueueId): string {
  return {
    stripe_events: 'Stripe normalization',
    commercial_facts: 'Commercial facts',
    reporting_metrics: 'Reporting metrics',
    reconciliation: 'Reconciliation',
  }[queue]
}
