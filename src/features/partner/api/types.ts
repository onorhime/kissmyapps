export type PartnerDataStatus = 'ready' | 'empty' | 'unconfigured' | 'error'

export type PartnerDataErrorCode =
  | 'not_configured'
  | 'not_authenticated'
  | 'not_authorized'
  | 'not_found'
  | 'conflict'
  | 'contract_unavailable'
  | 'temporarily_unavailable'
  | 'invalid_response'
  | 'unknown'

export type PartnerDataError = Readonly<{
  code: PartnerDataErrorCode
  message: string
  retryable: boolean
}>

/**
 * Every gateway read returns a safe value, even when Supabase is unavailable.
 * The UI must still inspect `status`; an empty fallback is not proof of a known zero.
 */
export type PartnerDataResult<T> = Readonly<{
  data: T
  status: PartnerDataStatus
  error: PartnerDataError | null
}>

export type PartnerRole = 'owner' | 'finance' | 'analyst' | 'member'
export type PartnerStatus = 'draft' | 'invited' | 'active' | 'paused' | 'terminated'

export type NotificationPreferences = Readonly<{
  statements: boolean
  payouts: boolean
  verification: boolean
  signatures: boolean
  adjustments: boolean
  inactiveLinks: boolean
}>

export type PartnerProfile = Readonly<{
  email: string
  fullName: string
  publicName: string
  legalName: string
  entityType: 'Individual' | 'Company' | null
  countryCode: string | null
  timezone: string
  preferredCurrency: string
  website: string | null
  category: string | null
  audienceDescription: string | null
  audienceCountries: readonly string[]
  channels: readonly string[]
  channelDetails: string | null
  role: PartnerRole
  status: PartnerStatus
  notifications: NotificationPreferences
}>

export type PartnerProfileUpdate = Readonly<{
  fullName: string
  publicName: string
  legalName: string
  entityType: 'Individual' | 'Company'
  countryCode: string
  timezone: string
  preferredCurrency: string
  website: string | null
  category: string | null
  audienceDescription: string | null
  audienceCountries: readonly string[]
  channels: readonly string[]
  channelDetails: string | null
}>

export type PartnerSettingsUpdate = Readonly<{
  notifications: NotificationPreferences
}>

export type PartnerProductStatus = 'draft' | 'active' | 'paused' | 'archived'
export type PartnerAgreementStatus =
  'draft' | 'awaiting_signature' | 'active' | 'superseded' | 'expired' | 'terminated'

export type PartnerProduct = Readonly<{
  id: string
  slug: string
  name: string
  status: PartnerProductStatus
  agreementStatus: PartnerAgreementStatus | null
  commercialModel: PartnerCommissionModel | null
  payoutCurrency: string | null
  hasLiveFunnel: boolean
  mainTrackingUrl: string | null
}>

export type PartnerLinkOptionKind = 'funnel' | 'source' | 'campaign'
export type PartnerLinkOption = Readonly<{
  id: string
  kind: PartnerLinkOptionKind
  productId: string | null
  key: string
  name: string
  available: boolean
}>

export type PartnerLinkDirectory = Readonly<{
  products: readonly PartnerProduct[]
  funnels: readonly PartnerLinkOption[]
  sources: readonly PartnerLinkOption[]
  campaigns: readonly PartnerLinkOption[]
}>

export type PartnerLinkStatus = 'active' | 'paused' | 'archived'

export type PartnerLink = Readonly<{
  id: string
  name: string
  productId: string
  productName: string
  productSlug: string
  funnelId: string
  funnelName: string
  sourceId: string | null
  sourceName: string | null
  campaignId: string | null
  campaignName: string | null
  sub1: string
  sub2: string
  sub3: string
  status: PartnerLinkStatus
  trackingUrl: string
  parentLinkId: string | null
  clicks: number
  leads: number
  installs: number | null
  purchases: number
  earningsMinor: number
  currency: string
  createdAt: string
}>

export type PartnerLinkCreate = Readonly<{
  name: string
  productId: string
  funnelId: string
  sourceId: string | null
  campaignId: string | null
  sub1: string
  sub2: string
  sub3: string
  parentLinkId?: string | null
}>

export type PartnerLinkUpdate = Readonly<{
  name: string
}>

export type PartnerMetricValues = Readonly<{
  clicks: number | null
  visitors: number | null
  funnelStarts: number | null
  paymentViews: number | null
  appStoreClicks: number | null
  leads: number | null
  trials: number | null
  installs: number | null
  purchases: number | null
  activations: number | null
  renewals: number | null
  cancellations: number | null
  refunds: number | null
  disputes: number | null
  grossCollectedMinor: number | null
  eligibleRevenueMinor: number | null
  earningsMinor: number | null
  activeSubscriptions: number | null
}>

export type PartnerReconciliationStage = 'preliminary' | 'reconciled' | 'finalized'

export type PartnerDashboardQuery = Readonly<{
  productId?: string | null
  startsOn: string
  endsOn: string
  timezone: string
  sourceId?: string | null
  campaignId?: string | null
  funnelId?: string | null
  countryCode?: string | null
  subId?: string | null
}>

export type PartnerTrendQuery = PartnerDashboardQuery &
  Readonly<{
    grain: 'day' | 'week' | 'month'
    breakdown: 'date' | 'source' | 'country' | 'campaign' | 'funnel' | 'subId'
  }>

export type PartnerDashboardSummary = Readonly<{
  startsOn: string | null
  endsOn: string | null
  timezone: string
  currency: string | null
  hasData: boolean
  reconciliationStage: PartnerReconciliationStage | null
  reconciledThrough: string | null
  metrics: PartnerMetricValues
}>

export type PartnerTrendPoint = Readonly<{
  bucketStart: string
  bucketEnd: string
  dimensionKey: string
  dimensionLabel: string
  reconciliationStage: PartnerReconciliationStage | null
  metrics: PartnerMetricValues
}>

export type PartnerPayoutStatus =
  'open' | 'review' | 'approved' | 'scheduled' | 'paid' | 'on_hold' | 'failed' | 'carried_forward'

export type PartnerPayoutSummary = Readonly<{
  currency: string | null
  openMinor: number | null
  approvedMinor: number | null
  scheduledMinor: number | null
  paidMinor: number | null
  carriedForwardMinor: number | null
  nextExpectedPaymentAt: string | null
}>

export type PartnerPayout = Readonly<{
  id: string
  productName: string
  periodStartsAt: string
  periodEndsAt: string
  expectedPaymentAt: string | null
  status: PartnerPayoutStatus
  eligibleNetMinor: number
  earningsMinor: number
  adjustmentsMinor: number
  finalPayoutMinor: number
  currency: string
  statementNumber: string | null
  statementAvailable: boolean
  paymentMethod: 'bank' | 'crypto' | null
  paymentReference: string | null
  paidAt: string | null
}>

export type PartnerPayoutCalculationLine = Readonly<{
  key: string
  label: string
  amountMinor: number
  note: string
}>

export type PartnerPayoutHistoryEntry = Readonly<{
  occurredAt: string
  label: string
  amountMinor: number | null
}>

export type PartnerPayoutDetail = PartnerPayout &
  Readonly<{
    agreementVersion: number
    agreementLabel: string
    commercialModel: PartnerCommissionModel
    minimumPayoutMinor: number
    payoutFrequencyDays: number
    calculation: readonly PartnerPayoutCalculationLine[]
    history: readonly PartnerPayoutHistoryEntry[]
  }>

export type PartnerCommissionModel = 'cpl' | 'cpa' | 'revenue_share' | 'hybrid'

export type PartnerCommissionRule = Readonly<{
  name: string
  model: PartnerCommissionModel
  triggerEvent: string
  fixedAmountMinor: number | null
  rateBasisPoints: number | null
  currency: string | null
}>

export type PartnerAgreement = Readonly<{
  productId: string
  productName: string
  version: number
  status: PartnerAgreementStatus
  model: PartnerCommissionModel
  startsAt: string | null
  endsAt: string | null
  attributionWindowDays: number
  renewalDurationDays: number | null
  payoutFrequencyDays: number
  payoutCurrency: string
  minimumPayoutMinor: number
  rules: readonly PartnerCommissionRule[]
}>

export type PartnerDocumentStatus =
  | 'draft'
  | 'awaiting_partner_signature'
  | 'awaiting_kissmyapps_signature'
  | 'signed'
  | 'active'
  | 'superseded'
  | 'expired'
  | 'terminated'

export type PartnerDocument = Readonly<{
  id: string
  name: string
  type: string
  version: number
  status: PartnerDocumentStatus
  createdAt: string
  effectiveAt: string | null
  expiresAt: string | null
  terminatedAt: string | null
  partnerSignedAt: string | null
  companySignedAt: string | null
  supersedesDocumentId: string | null
  supersededByDocumentId: string | null
  downloadAvailable: boolean
}>
