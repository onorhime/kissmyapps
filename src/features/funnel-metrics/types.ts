/** Product-neutral reporting definitions. Database validation and report RPCs are authoritative. */
export type FunnelMetricTemplateKey = 'blank' | 'sales' | 'subscription' | 'webinar'
export type FunnelMetricKind =
  | 'event_count'
  | 'unique_people'
  | 'unique_per_context'
  | 'current_state'
  | 'live_presence'
  | 'ratio'
export type FunnelMetricDefinition = {
  key: string
  label: string
  description: string
  kind: FunnelMetricKind
  eventKey: string
  visible: boolean
  order: number
  config: {
    stateValue?: string
    numeratorKey?: string
    denominatorKey?: string
  }
}
export type FunnelMetricDraft = {
  revision: number
  template: FunnelMetricTemplateKey
  metrics: FunnelMetricDefinition[]
  updatedAt: string | null
}
export type FunnelMetricPublishedVersion = {
  version: number
  publishedAt: string
  metrics: FunnelMetricDefinition[]
}
export type FunnelMetricConfiguration = {
  productId: string
  funnelId: string
  draft: FunnelMetricDraft
  published: FunnelMetricPublishedVersion | null
  versions: Array<{ version: number; publishedAt: string }>
  eventKeys: string[]
}
export type FunnelMetricValue = {
  key: string
  label: string
  kind: FunnelMetricKind
  value: number | null
  numerator?: number
  denominator?: number
  status: 'available' | 'no_data' | 'unconfigured' | 'insufficient_data'
  updatedAt: string | null
}
export type FunnelMetricReport = {
  productId: string
  funnelId: string
  version: number | null
  status: 'unpublished' | 'awaiting_data' | 'connected'
  publishedAt: string | null
  effectiveUntil: string | null
  lastReceivedAt: string | null
  externalCommerceStatus: 'unconnected' | 'available'
  commissionStatus: 'held'
  externalCommerceUpdatedAt: string | null
  asOf: string | null
  metrics: FunnelMetricValue[]
  warnings: string[]
  journey?: import('./journey').FunnelJourneyReport
  externalCommerce?: Array<{
    currency: string
    livemode: boolean
    purchases: number
    refunds: number
    grossCents: number
    refundCents: number
    netCents: number
  }>
}
/** Inclusive local calendar dates in timeZone. Never interpreted as browser UTC dates. */
export type FunnelMetricReportFilter = {
  productId: string
  funnelId: string
  from: string
  to: string
  timeZone: string
  linkId?: string
  channel?: string
  entryVariant?: string
  webinarId?: string
  intakeId?: string
  contextId?: string
  version?: number
  journeyVersion?: number
  environment?: 'test' | 'live'
  conversionWindowDays?: number
  currency?: string
}
export type FunnelMetricEventValidation = {
  valid: boolean
  matchedMetricKeys: string[]
  errors: string[]
  warnings: string[]
}
export type FunnelMetricsError = {
  code:
    | 'unconfigured'
    | 'unauthorized'
    | 'invalid_input'
    | 'conflict'
    | 'unavailable'
    | 'invalid_response'
  message: string
  retryable: boolean
}
export type FunnelMetricsResult<T> = {
  data: T | null
  status: 'ready' | 'unconfigured' | 'unauthorized' | 'error'
  error: FunnelMetricsError | null
}
export type FunnelMetricsRpcClient = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { code?: string; message?: string; details?: string; hint?: string } | null
  }>
}
export type FunnelMetricsGateway = {
  getJourneyDefinition?(
    funnelId: string,
  ): Promise<FunnelMetricsResult<import('./journeyDefinitions').JourneyDefinitionConfiguration>>
  saveJourneyDefinition?(input: {
    funnelId: string
    expectedRevision: number
    template: import('./journeyDefinitions').JourneyTemplate
    definition: import('./journeyDefinitions').JourneyDefinition
  }): Promise<FunnelMetricsResult<import('./journeyDefinitions').JourneyDefinitionConfiguration>>
  publishJourneyDefinition?(input: {
    funnelId: string
    expectedRevision: number
  }): Promise<FunnelMetricsResult<import('./journeyDefinitions').JourneyDefinitionConfiguration>>
  getJourneyConfiguration?(
    funnelId: string,
  ): Promise<FunnelMetricsResult<FunnelJourneyConfiguration | null>>
  saveJourneyConfiguration?(input: {
    funnelId: string
    environment: 'test' | 'live'
    conversionWindowDays: number
    expectedUpdatedAt?: string
  }): Promise<FunnelMetricsResult<FunnelJourneyConfiguration>>
  getConfiguration(
    productId: string,
    funnelId: string,
  ): Promise<FunnelMetricsResult<FunnelMetricConfiguration>>
  saveDraft(input: {
    productId: string
    funnelId: string
    expectedRevision: number
    template: FunnelMetricTemplateKey
    metrics: FunnelMetricDefinition[]
  }): Promise<FunnelMetricsResult<FunnelMetricConfiguration>>
  publish(input: {
    productId: string
    funnelId: string
    expectedRevision: number
  }): Promise<FunnelMetricsResult<FunnelMetricConfiguration>>
  validateEvent(input: {
    productId: string
    funnelId: string
    event: unknown
  }): Promise<FunnelMetricsResult<FunnelMetricEventValidation>>
  preview(input: {
    productId: string
    funnelId: string
    metrics: FunnelMetricDefinition[]
    sampleEvents: unknown[]
  }): Promise<FunnelMetricsResult<FunnelMetricReport>>
  getAdminReport(filter: FunnelMetricReportFilter): Promise<FunnelMetricsResult<FunnelMetricReport>>
  getReport(filter: FunnelMetricReportFilter): Promise<FunnelMetricsResult<FunnelMetricReport>>
}
export type FunnelJourneyConfiguration = {
  funnelId: string
  environment: 'test' | 'live'
  conversionWindowDays: number
  updatedAt: string
}
