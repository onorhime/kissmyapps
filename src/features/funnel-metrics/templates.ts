import type { FunnelMetricDefinition, FunnelMetricTemplateKey } from './types'
const metric = (
  key: string,
  label: string,
  eventKey: string,
  kind: FunnelMetricDefinition['kind'] = 'unique_people',
): FunnelMetricDefinition => ({
  key,
  label,
  eventKey,
  kind,
  description: '',
  visible: true,
  order: 0,
  config: {},
})
export function funnelMetricTemplate(template: FunnelMetricTemplateKey): FunnelMetricDefinition[] {
  const templates: Record<FunnelMetricTemplateKey, FunnelMetricDefinition[]> = {
    blank: [],
    sales: [
      metric('registered_leads', 'Registered leads', 'lead_registered'),
      metric('checkout_started', 'People starting checkout', 'checkout_started'),
      {
        ...metric('lead_to_checkout', 'Lead to checkout', '', 'ratio'),
        config: { numeratorKey: 'checkout_started', denominatorKey: 'registered_leads' },
      },
    ],
    subscription: [
      metric('trial_started', 'Trials started', 'trial_started'),
      metric('subscription_started', 'Subscription starts', 'subscription_started'),
      {
        ...metric(
          'active_subscribers',
          'Active subscriber state',
          'subscription_state',
          'current_state',
        ),
        config: { stateValue: 'active' },
      },
    ],
    webinar: [
      metric(
        'webinar_registrations',
        'Webinar registrations',
        'webinar_registered',
        'unique_per_context',
      ),
      {
        ...metric(
          'webinar_attendees',
          'Confirmed webinar attendees',
          'webinar_attendance_updated',
          'current_state',
        ),
        config: { stateValue: 'attended' },
      },
      metric('assessment_completed', 'Completed assessments', 'assessment_completed'),
    ],
  }
  return templates[template].map((item, order) => ({ ...item, config: { ...item.config }, order }))
}
export function newFunnelMetric(metrics: FunnelMetricDefinition[]): FunnelMetricDefinition {
  let suffix = metrics.length + 1
  while (metrics.some((item) => item.key === `metric_${suffix}`)) suffix++
  return { ...metric(`metric_${suffix}`, '', ''), order: metrics.length }
}
