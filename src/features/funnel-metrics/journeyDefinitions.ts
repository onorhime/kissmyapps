/** Product-owned reporting rules; these never authorize financial operations. */
export type JourneyTemplate = 'blank' | 'webinar' | 'sales' | 'custom'
export type JourneyStage = {
  key: string
  label: string
  source: 'event' | 'purchase'
  eventNames?: string[]
  stateValue?: string
  contextField?: 'context_id' | 'webinar_id' | 'intake_id' | 'assessment_attempt_id'
}
export type JourneySequence = { key: string; label: string; steps: string[] }
export type JourneyDefinition = {
  stages: JourneyStage[]
  rates: JourneySequence[]
  paths: JourneySequence[]
}
export type JourneyDefinitionConfiguration = {
  funnelId: string
  draft: { revision: number; template: JourneyTemplate; definition: JourneyDefinition }
  published: null | { version: number; publishedAt: string; definition: JourneyDefinition }
  versions: Array<{ version: number; publishedAt: string }>
}
export const JOURNEY_DEFINITION_LIMITS = {
  stages: 20,
  rates: 20,
  paths: 20,
  steps: 8,
  eventNames: 8,
  labelLength: 120,
  keyLength: 80,
} as const
const keyPattern = /^[a-z][a-z0-9_]{0,79}$/
const reservedEvents = new Set([
  'purchase_completed',
  'refund_status_updated',
  'payment_status_updated',
  'dispute_status_updated',
  'commission_status_updated',
  'payout_status_updated',
  'identity_linked',
])
const contextFields = ['context_id', 'webinar_id', 'intake_id', 'assessment_attempt_id']
const templates = ['blank', 'webinar', 'sales', 'custom']

export function validateJourneyDefinition(definition: JourneyDefinition): string[] {
  const errors: string[] = []
  const labelValid = (value: string) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 120
  const keys = new Set<string>()
  if (definition.stages.length > JOURNEY_DEFINITION_LIMITS.stages)
    errors.push('Use up to 20 journey stages.')
  for (const stage of definition.stages) {
    if (!keyPattern.test(stage.key) || keys.has(stage.key))
      errors.push('Each stage needs a unique lowercase key, up to 80 characters.')
    keys.add(stage.key)
    if (!labelValid(stage.label)) errors.push('Each stage needs a label of 1–120 characters.')
    if (stage.source === 'purchase') {
      if (
        stage.eventNames !== undefined ||
        stage.stateValue !== undefined ||
        stage.contextField !== undefined
      )
        errors.push('Purchase stages use verified payments only; remove event and state settings.')
    } else if (stage.source === 'event') {
      if (
        !stage.eventNames?.length ||
        stage.eventNames.length > JOURNEY_DEFINITION_LIMITS.eventNames ||
        new Set(stage.eventNames).size !== stage.eventNames.length ||
        stage.eventNames.some((name) => !keyPattern.test(name) || reservedEvents.has(name))
      )
        errors.push(
          'Event stages need 1–8 unique event keys. Financial and identity-link events are reserved.',
        )
      if (stage.stateValue !== undefined && !/^[a-z][a-z0-9_]{0,49}$/.test(stage.stateValue))
        errors.push('A state must be a lowercase key of up to 50 characters.')
      if (stage.contextField !== undefined && !contextFields.includes(stage.contextField))
        errors.push('Choose a supported context field.')
    } else errors.push('Choose an event or verified purchase as the stage source.')
  }
  for (const type of ['rates', 'paths'] as const) {
    const sequenceKeys = new Set<string>()
    if (definition[type].length > JOURNEY_DEFINITION_LIMITS[type])
      errors.push(`Use up to 20 ${type}.`)
    for (const sequence of definition[type]) {
      if (!keyPattern.test(sequence.key) || sequenceKeys.has(sequence.key))
        errors.push(
          `Each ${type === 'rates' ? 'conversion' : 'path'} needs a unique lowercase key.`,
        )
      sequenceKeys.add(sequence.key)
      if (!labelValid(sequence.label))
        errors.push('Each conversion or path needs a label of 1–120 characters.')
      if (
        sequence.steps.length < 2 ||
        sequence.steps.length > JOURNEY_DEFINITION_LIMITS.steps ||
        new Set(sequence.steps).size !== sequence.steps.length ||
        sequence.steps.some((step) => !keys.has(step))
      )
        errors.push(
          'Each conversion or path needs 2–8 different existing stages, in the required order.',
        )
    }
  }
  return [...new Set(errors)]
}

export function getJourneyTemplate(template: JourneyTemplate): JourneyDefinition {
  if (template === 'blank' || template === 'custom') return { stages: [], rates: [], paths: [] }
  const stages: JourneyStage[] = [
    {
      key: 'visitors',
      label: 'Landing visitors',
      source: 'event',
      eventNames: ['landing_page_viewed'],
    },
    {
      key: 'leads',
      label: 'Email leads',
      source: 'event',
      eventNames: ['lead_created', 'email_lead'],
    },
    { key: 'verified', label: 'Verified people', source: 'event', eventNames: ['email_verified'] },
    {
      key: 'checkout_started',
      label: 'Checkout started',
      source: 'event',
      eventNames: ['checkout_created', 'checkout_opened'],
    },
    {
      key: 'cancelled_checkout',
      label: 'Returned from cancelled checkout',
      source: 'event',
      eventNames: ['checkout_cancel_returned'],
    },
    { key: 'paid', label: 'Paying people', source: 'purchase' },
  ]
  const rates: JourneySequence[] = [
    {
      key: 'landing_to_signup',
      label: 'Landing page → email signup',
      steps: ['visitors', 'leads'],
    },
    { key: 'signup_to_purchase', label: 'Email signup → purchase', steps: ['leads', 'paid'] },
    {
      key: 'checkout_to_purchase',
      label: 'Checkout → purchase',
      steps: ['checkout_started', 'paid'],
    },
  ]
  if (template === 'sales')
    return {
      stages,
      rates,
      paths: [
        {
          key: 'signup_checkout_purchase',
          label: 'Signup → checkout → purchase',
          steps: ['leads', 'checkout_started', 'paid'],
        },
      ],
    }
  stages.push(
    {
      key: 'assessment_started',
      label: 'Assessment started',
      source: 'event',
      eventNames: ['assessment_started'],
      contextField: 'assessment_attempt_id',
    },
    {
      key: 'assessment_completed',
      label: 'Assessment completed',
      source: 'event',
      eventNames: ['assessment_completed'],
      contextField: 'assessment_attempt_id',
    },
    {
      key: 'availability_saved',
      label: 'Availability saved',
      source: 'event',
      eventNames: ['availability_saved'],
    },
    {
      key: 'invitation_requested',
      label: 'Webinar invitation requested',
      source: 'event',
      eventNames: ['webinar_invitation_requested', 'webinar_requested'],
    },
    {
      key: 'registered',
      label: 'Webinar registrations',
      source: 'event',
      eventNames: ['webinar_registered'],
      contextField: 'webinar_id',
    },
    {
      key: 'attended',
      label: 'Confirmed webinar attendees',
      source: 'event',
      eventNames: ['webinar_attendance_updated', 'webinar_attendance'],
      stateValue: 'attended',
      contextField: 'webinar_id',
    },
    {
      key: 'attendance_unknown',
      label: 'Reported attendance unknown',
      source: 'event',
      eventNames: ['webinar_attendance_updated', 'webinar_attendance'],
      stateValue: 'unknown',
      contextField: 'webinar_id',
    },
    {
      key: 'attendance_missed',
      label: 'Confirmed no-shows',
      source: 'event',
      eventNames: ['webinar_attendance_updated', 'webinar_attendance'],
      stateValue: 'missed',
      contextField: 'webinar_id',
    },
    {
      key: 'resources',
      label: 'Resource engagement',
      source: 'event',
      eventNames: ['resource_opened', 'resource_accessed', 'resource_served'],
    },
    {
      key: 'matching_pool',
      label: 'Matching pool joined',
      source: 'event',
      eventNames: ['matching_pool_entered'],
      contextField: 'intake_id',
    },
    {
      key: 'group_confirmed',
      label: 'Group confirmed',
      source: 'event',
      eventNames: ['group_confirmed'],
      contextField: 'intake_id',
    },
  )
  rates.push(
    {
      key: 'signup_to_registration',
      label: 'Email signup → webinar registration',
      steps: ['leads', 'registered'],
    },
    {
      key: 'registration_to_attendance',
      label: 'Webinar registration → attendance',
      steps: ['registered', 'attended'],
    },
    {
      key: 'assessment_completion',
      label: 'Assessment completion',
      steps: ['assessment_started', 'assessment_completed'],
    },
    {
      key: 'resource_engagement',
      label: 'Email signup → resource engagement',
      steps: ['leads', 'resources'],
    },
    {
      key: 'webinar_to_purchase',
      label: 'Webinar attendance → purchase',
      steps: ['attended', 'paid'],
    },
    {
      key: 'cancelled_to_invitation',
      label: 'Cancelled checkout → webinar invitation',
      steps: ['cancelled_checkout', 'invitation_requested'],
    },
  )
  return {
    stages,
    rates,
    paths: [
      {
        key: 'assessment_payment',
        label: 'Assessment → payment',
        steps: ['assessment_completed', 'paid'],
      },
      {
        key: 'webinar_assessment_payment',
        label: 'Webinar → assessment → payment',
        steps: ['attended', 'assessment_completed', 'paid'],
      },
      { key: 'webinar_payment', label: 'Webinar → payment', steps: ['attended', 'paid'] },
      {
        key: 'cancelled_webinar_payment',
        label: 'Cancelled checkout → invitation → registration → attendance → payment',
        steps: ['cancelled_checkout', 'invitation_requested', 'registered', 'attended', 'paid'],
      },
      {
        key: 'paid_matching',
        label: 'Payment → matching pool → group confirmed',
        steps: ['paid', 'matching_pool', 'group_confirmed'],
      },
    ],
  }
}

export function journeyDefinitionToBackend(definition: JourneyDefinition) {
  return {
    stages: definition.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      source: stage.source,
      ...(stage.eventNames !== undefined ? { event_names: stage.eventNames } : {}),
      ...(stage.stateValue !== undefined ? { state_value: stage.stateValue } : {}),
      ...(stage.contextField !== undefined ? { context_field: stage.contextField } : {}),
    })),
    rates: definition.rates.map((row) => ({ ...row, steps: [...row.steps] })),
    paths: definition.paths.map((row) => ({ ...row, steps: [...row.steps] })),
  }
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw Error('Invalid journey definition object.')
  return v as Record<string, unknown>
}
const text = (v: unknown): string => {
  if (typeof v !== 'string') throw Error('Invalid journey definition text.')
  return v
}
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw Error('Invalid journey definition list.')
  return v
}
const integer = (v: unknown, min: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
    throw Error('Invalid journey definition revision.')
  return v
}
const date = (v: unknown): string => {
  const s = text(v)
  if (!Number.isFinite(Date.parse(s))) throw Error('Invalid journey publication date.')
  return s
}
export function mapJourneyDefinition(value: unknown): JourneyDefinition {
  const row = object(value)
  const sequence = (value: unknown): JourneySequence => {
    const r = object(value)
    return { key: text(r.key), label: text(r.label), steps: list(r.steps).map(text) }
  }
  const def: JourneyDefinition = {
    stages: list(row.stages).map((item) => {
      const r = object(item)
      return {
        key: text(r.key),
        label: text(r.label),
        source: text(r.source) as JourneyStage['source'],
        ...(r.event_names !== undefined ? { eventNames: list(r.event_names).map(text) } : {}),
        ...(r.state_value !== undefined ? { stateValue: text(r.state_value) } : {}),
        ...(r.context_field !== undefined
          ? { contextField: text(r.context_field) as JourneyStage['contextField'] }
          : {}),
      }
    }),
    rates: list(row.rates).map(sequence),
    paths: list(row.paths).map(sequence),
  }
  if (validateJourneyDefinition(def).length) throw Error('Invalid journey definition.')
  return def
}
export function mapJourneyDefinitionConfiguration(
  value: unknown,
  funnelId: string,
): JourneyDefinitionConfiguration {
  const row = object(value),
    draft = object(row.draft)
  if (row.funnel_id !== funnelId || !templates.includes(text(draft.template)))
    throw Error('Invalid journey definition scope.')
  const pub = row.published === null ? null : object(row.published)
  return {
    funnelId,
    draft: {
      revision: integer(draft.revision, 0),
      template: draft.template as JourneyTemplate,
      definition: mapJourneyDefinition(draft.definition),
    },
    published: pub
      ? {
          version: integer(pub.version, 1),
          publishedAt: date(pub.published_at),
          definition: mapJourneyDefinition(pub.definition),
        }
      : null,
    versions: list(row.versions).map((v) => {
      const r = object(v)
      return { version: integer(r.version, 1), publishedAt: date(r.published_at) }
    }),
  }
}
