export const ADMIN_ROLES = ['owner', 'operations', 'finance', 'analyst', 'support'] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export type AdminDataStatus = 'ready' | 'empty' | 'unauthorized' | 'unconfigured' | 'error'

export type AdminDataErrorCode =
  | 'not_configured'
  | 'not_authenticated'
  | 'not_authorized'
  | 'conflict'
  | 'invalid_input'
  | 'invalid_reference'
  | 'invalid_state'
  | 'contract_unavailable'
  | 'temporarily_unavailable'
  | 'invalid_response'
  | 'unknown'

export type AdminDataError = Readonly<{
  code: AdminDataErrorCode
  message: string
  retryable: boolean
}>

export type AdminDataResult<T> = Readonly<{
  data: T
  status: AdminDataStatus
  error: AdminDataError | null
}>

export type AdminContext = Readonly<{
  userId: string
  email: string
  fullName: string | null
  role: AdminRole
  active: boolean
}>

export const ADMIN_PRODUCT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const

export type AdminProductStatus = (typeof ADMIN_PRODUCT_STATUSES)[number]

export type AdminProduct = Readonly<{
  id: string
  name: string
  slug: string
  status: AdminProductStatus
  createdAt: string
  updatedAt: string
}>

/** Product creation is deliberately draft-only and has no funnel fields. */
export type AdminProductCreate = Readonly<{
  name: string
  slug: string
}>

export const ADMIN_AFFILIATE_STATUSES = [
  'draft',
  'invited',
  'active',
  'paused',
  'terminated',
] as const

export type AdminAffiliateStatus = (typeof ADMIN_AFFILIATE_STATUSES)[number]

export type AdminAffiliate = Readonly<{
  id: string
  publicName: string
  slug: string
  status: AdminAffiliateStatus
  preferredCurrency: string | null
}>

export const ADMIN_AFFILIATE_REGISTRATION_KINDS = ['public', 'invited', 'legacy'] as const

export type AdminAffiliateRegistrationKind = (typeof ADMIN_AFFILIATE_REGISTRATION_KINDS)[number]

export const ADMIN_AFFILIATE_EMAIL_CONFIRMATION_STATUSES = [
  'confirmed',
  'pending',
  'unknown',
] as const

export type AdminAffiliateEmailConfirmationStatus =
  (typeof ADMIN_AFFILIATE_EMAIL_CONFIRMATION_STATUSES)[number]

export const ADMIN_AFFILIATE_ACTIVATION_STATUSES = [
  'active',
  'pending',
  'disabled',
  'missing',
] as const

export type AdminAffiliateActivationStatus = (typeof ADMIN_AFFILIATE_ACTIVATION_STATUSES)[number]

export const ADMIN_AFFILIATE_DIRECTORY_SORTS = ['newest', 'oldest', 'name'] as const

export type AdminAffiliateDirectorySort = (typeof ADMIN_AFFILIATE_DIRECTORY_SORTS)[number]

export type AdminAffiliateDirectoryRecord = Readonly<{
  id: string
  publicName: string
  legalName: string | null
  slug: string
  status: AdminAffiliateStatus
  entityType: 'individual' | 'company' | null
  countryCode: string | null
  reportingTimezone: string
  preferredCurrency: string
  websiteUrl: string | null
  category: string | null
  audienceDescription: string | null
  audienceCountries: readonly string[]
  channels: readonly string[]
  channelDetails: string | null
  primaryUserId: string | null
  primaryUserRole: 'owner' | 'finance' | 'analyst' | 'member' | null
  primaryFullName: string | null
  primaryEmail: string | null
  registrationKind: AdminAffiliateRegistrationKind
  registeredAt: string
  emailConfirmationStatus: AdminAffiliateEmailConfirmationStatus
  emailConfirmedAt: string | null
  activationStatus: AdminAffiliateActivationStatus
  membershipActive: boolean
  activationPending: boolean
  activatedAt: string | null
  memberCount: number
  activeMemberCount: number
  termsVersion: string | null
  termsUrl: string | null
  privacyVersion: string | null
  privacyUrl: string | null
  ageConfirmed: boolean | null
  legalAcceptedAt: string | null
  productCount: number
  agreementCount: number
  activeAgreementCount: number
  blockingAgreementCount: number
  blockingDocumentCount: number
  linkCount: number
  activeLinkCount: number
  unsettledPayoutCount: number
  createdAt: string
  updatedAt: string
}>

export type AdminAffiliateDirectorySummary = Readonly<{
  totalCount: number
  draftCount: number
  invitedCount: number
  activeCount: number
  pausedCount: number
  terminatedCount: number
  pendingConfirmationCount: number
  pendingActivationCount: number
}>

export type AdminAffiliateDirectoryPage = Readonly<{
  items: readonly AdminAffiliateDirectoryRecord[]
  totalCount: number
}>

export type AdminAffiliateDirectoryInput = Readonly<{
  query?: string | null
  status?: AdminAffiliateStatus | null
  confirmationStatus?: AdminAffiliateEmailConfirmationStatus | null
  activationStatus?: AdminAffiliateActivationStatus | null
  sort?: AdminAffiliateDirectorySort
  limit?: number
  offset?: number
}>

export type AdminAffiliateStatusChange = Readonly<{
  id: string
  status: Extract<AdminAffiliateStatus, 'active' | 'paused' | 'terminated'>
  updatedAt: string
}>

export type AdminAffiliateStatusUpdate = Readonly<{
  affiliateId: string
  status: Extract<AdminAffiliateStatus, 'active' | 'paused'>
  reason: string
}>

export type AdminAffiliateTermination = Readonly<{
  affiliateId: string
  reason: string
  confirmation: string
}>

export const ADMIN_FUNNEL_STATUSES = ['draft', 'live', 'paused', 'archived'] as const

export type AdminFunnelStatus = (typeof ADMIN_FUNNEL_STATUSES)[number]

export type AdminFunnel = Readonly<{
  id: string
  productId: string
  key: string
  name: string
  destinationUrl: string | null
  isDefault: boolean
  status: AdminFunnelStatus
  createdAt: string
  updatedAt: string
}>

export type AdminFunnelCreate = Readonly<{
  productId: string
  key: string
  name: string
  destinationUrl: string
  isDefault: boolean
}>

/** Funnel keys stay immutable after creation; only the label and protected destination may change. */
export type AdminFunnelUpdate = Readonly<{
  funnelId: string
  name: string
  destinationUrl: string
  isDefault: boolean
}>

export type AdminFunnelStatusUpdate = Readonly<{
  funnelId: string
  status: AdminFunnelStatus
}>

export type AdminSource = Readonly<{
  id: string
  key: string
  name: string
  active: boolean
  createdAt: string
  updatedAt: string
}>

export type AdminSourceCreate = Readonly<{
  key: string
  name: string
}>

export const ADMIN_CAMPAIGN_STATUSES = ['draft', 'active', 'completed', 'archived'] as const

export type AdminCampaignStatus = (typeof ADMIN_CAMPAIGN_STATUSES)[number]

export type AdminCampaign = Readonly<{
  id: string
  productId: string
  key: string
  name: string
  startsAt: string | null
  endsAt: string | null
  status: AdminCampaignStatus
  createdAt: string
  updatedAt: string
}>

export type AdminCampaignCreate = Readonly<{
  productId: string
  key: string
  name: string
  startsAt: string | null
  endsAt: string | null
}>

export type AdminCampaignStatusUpdate = Readonly<{
  campaignId: string
  status: AdminCampaignStatus
}>

export const ADMIN_AGREEMENT_STATUSES = [
  'draft',
  'awaiting_signature',
  'active',
  'superseded',
  'expired',
  'terminated',
] as const

export type AdminAgreementStatus = (typeof ADMIN_AGREEMENT_STATUSES)[number]

export const ADMIN_COMMISSION_MODELS = ['cpl', 'cpa', 'revenue_share', 'hybrid'] as const

export type AdminCommissionModel = (typeof ADMIN_COMMISSION_MODELS)[number]

export const ADMIN_COMMISSION_RULE_STATUSES = ['draft', 'active', 'superseded'] as const

export type AdminCommissionRuleStatus = (typeof ADMIN_COMMISSION_RULE_STATUSES)[number]

export type AdminCommissionRule = Readonly<{
  id: string
  agreementId: string
  name: string
  version: number
  status: AdminCommissionRuleStatus
  model: AdminCommissionModel
  triggerEvent: string
  fixedAmountMinor: number | null
  rateBasisPoints: number | null
  currency: string | null
  validationWindowHours: number
  createdAt: string
  updatedAt: string
}>

export type AdminAgreement = Readonly<{
  id: string
  affiliateId: string
  productId: string
  version: number
  model: AdminCommissionModel
  status: AdminAgreementStatus
  attributionWindowDays: number
  renewalDurationDays: number | null
  payoutFrequencyDays: number
  payoutCurrency: string
  minimumPayoutMinor: number
  startsAt: string | null
  endsAt: string | null
  createdAt: string
  updatedAt: string
  commissionRules: readonly AdminCommissionRule[]
  partnerName: string | null
  partnerSlug: string | null
  hasSignedDocument: boolean
  launchReady: boolean
}>

export type AdminAgreementCreate = Readonly<{
  productId: string
  affiliateId: string
  model: AdminCommissionModel
  attributionWindowDays: number
  renewalDurationDays: number | null
  payoutFrequencyDays: number
  payoutCurrency: string
  minimumPayoutMinor: number
}>

export type AdminCommissionRuleCreate = Readonly<{
  agreementId: string
  name: string
  model: AdminCommissionModel
  triggerEvent: string
  fixedAmountMinor: number | null
  rateBasisPoints: number | null
  currency: string | null
  validationWindowHours: number
}>

export type AdminCommissionRuleStatusUpdate = Readonly<{
  commissionRuleId: string
  status: AdminCommissionRuleStatus
}>

export type AdminAgreementActivation = Readonly<{
  agreementId: string
}>

export type AdminProductActivation = Readonly<{
  productId: string
}>

export type AdminMainLink = Readonly<{
  id: string
  affiliateId: string
  productId: string
  funnelId: string
  name: string | null
  publicCode: string | null
  trackingUrl: string
  status: 'active' | 'paused' | 'archived'
  createdAt: string
}>

/** A canonical main link has no source, campaign, sub-ID, or client-provided destination. */
export type AdminMainLinkIssue = Readonly<{
  affiliateId: string
  productId: string
}>

export const ADMIN_BILLING_MODES = ['payment', 'subscription'] as const

export type AdminBillingMode = (typeof ADMIN_BILLING_MODES)[number]

export const ADMIN_BILLING_OFFER_STATUSES = ['draft', 'active', 'paused', 'archived'] as const

export type AdminBillingOfferStatus = (typeof ADMIN_BILLING_OFFER_STATUSES)[number]

export type AdminBillingOffer = Readonly<{
  id: string
  productId: string
  key: string
  version: number
  name: string
  billingMode: AdminBillingMode
  stripePriceId: string | null
  currency: string | null
  unitAmountMinor: number | null
  successUrlTemplate: string | null
  cancelUrl: string | null
  status: AdminBillingOfferStatus
  stripePriceVerified: boolean
  stripeLivemodeVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}>

/** Browser-safe offer terms. Stripe credentials and provider verification facts never belong here. */
export type AdminBillingOfferCreate = Readonly<{
  productId: string
  key: string
  name: string
  billingMode: AdminBillingMode
  stripePriceId: string | null
  currency: string | null
  unitAmountMinor: number | null
  successUrlTemplate: string | null
  cancelUrl: string | null
}>

export type AdminBillingOfferUpdate = Readonly<{
  billingOfferId: string
  name: string
  billingMode: AdminBillingMode
  stripePriceId: string | null
  currency: string | null
  unitAmountMinor: number | null
  successUrlTemplate: string | null
  cancelUrl: string | null
}>

export type AdminBillingOfferStatusUpdate = Readonly<{
  billingOfferId: string
  status: 'active' | 'paused' | 'archived'
}>

export type AdminBillingOfferVerificationRequest = Readonly<{
  billingOfferId: string
}>

export type AdminBillingOfferVerification = Readonly<{
  verified: true
  billingOfferId: string
  requestId: string
}>

export const ADMIN_READINESS_BLOCKERS = [
  'tracking_not_configured',
  'tracking_disabled',
  'default_funnel_missing',
  'default_funnel_not_live',
  'product_status_not_activatable',
  'product_not_active',
  'eligible_partner_missing',
  'active_agreement_missing',
  'active_commission_rule_missing',
  'active_billing_offer_missing',
  'launch_ready_agreement_missing',
  'server_readiness_unavailable',
] as const

export type AdminReadinessBlockerCode = (typeof ADMIN_READINESS_BLOCKERS)[number]

export type AdminActionReadiness = Readonly<{
  allowed: boolean
  blockers: readonly AdminReadinessBlockerCode[]
}>

export type AdminMainLinkReadiness = AdminActionReadiness &
  Readonly<{
    eligibleAffiliateIds: readonly string[]
  }>

export type AdminProductConfiguration = Readonly<{
  product: AdminProduct
  tracking: Readonly<{
    enabled: boolean
    baseUrl: string | null
  }>
  readiness: Readonly<{
    hasLiveDefaultFunnel: boolean
    hasActiveAgreement: boolean
    hasActiveBillingOffer: boolean
    trackingReady: boolean
  }>
  funnels: readonly AdminFunnel[]
  campaigns: readonly AdminCampaign[]
  agreements: readonly AdminAgreement[]
  billingOffers: readonly AdminBillingOffer[]
  mainLinks: readonly AdminMainLink[]
}>

export interface AdminGateway {
  getAdminContext(): Promise<AdminDataResult<AdminContext | null>>
  getProducts(): Promise<AdminDataResult<AdminProduct[]>>
  createProduct(input: AdminProductCreate): Promise<AdminDataResult<AdminProduct | null>>
  getProductConfiguration?: AdminConfigurationGateway['getProductConfiguration']
  getAffiliates?: AdminConfigurationGateway['getAffiliates']
  getSources?: AdminConfigurationGateway['getSources']
  createFunnel?: AdminConfigurationGateway['createFunnel']
  updateFunnel?: AdminConfigurationGateway['updateFunnel']
  setFunnelStatus?: AdminConfigurationGateway['setFunnelStatus']
  createSource?: AdminConfigurationGateway['createSource']
  createCampaign?: AdminConfigurationGateway['createCampaign']
  setCampaignStatus?: AdminConfigurationGateway['setCampaignStatus']
  createAgreement?: AdminConfigurationGateway['createAgreement']
  createCommissionRule?: AdminConfigurationGateway['createCommissionRule']
  setCommissionRuleStatus?: AdminConfigurationGateway['setCommissionRuleStatus']
  activateAgreement?: AdminConfigurationGateway['activateAgreement']
  activateProduct?: AdminConfigurationGateway['activateProduct']
  issueMainLink?: AdminConfigurationGateway['issueMainLink']
  createBillingOffer?: AdminConfigurationGateway['createBillingOffer']
  updateBillingOffer?: AdminConfigurationGateway['updateBillingOffer']
  setBillingOfferStatus?: AdminConfigurationGateway['setBillingOfferStatus']
  verifyBillingOfferPrice?: AdminConfigurationGateway['verifyBillingOfferPrice']
  getAffiliateSummary?: AdminAffiliateManagementGateway['getAffiliateSummary']
  getAffiliateDirectory?: AdminAffiliateManagementGateway['getAffiliateDirectory']
  getAffiliateDetail?: AdminAffiliateManagementGateway['getAffiliateDetail']
  setAffiliateStatus?: AdminAffiliateManagementGateway['setAffiliateStatus']
  terminateAffiliate?: AdminAffiliateManagementGateway['terminateAffiliate']
}

/** Capability required only by the protected Admin affiliate-management routes. */
export interface AdminAffiliateManagementGateway {
  getAffiliateSummary(): Promise<AdminDataResult<AdminAffiliateDirectorySummary | null>>
  getAffiliateDirectory(
    input: AdminAffiliateDirectoryInput,
  ): Promise<AdminDataResult<AdminAffiliateDirectoryPage | null>>
  getAffiliateDetail(
    affiliateId: string,
  ): Promise<AdminDataResult<AdminAffiliateDirectoryRecord | null>>
  setAffiliateStatus(
    input: AdminAffiliateStatusUpdate,
  ): Promise<AdminDataResult<AdminAffiliateStatusChange | null>>
  terminateAffiliate(
    input: AdminAffiliateTermination,
  ): Promise<AdminDataResult<AdminAffiliateStatusChange | null>>
}

const affiliateManagementGatewayMethods = [
  'getAffiliateSummary',
  'getAffiliateDirectory',
  'getAffiliateDetail',
  'setAffiliateStatus',
  'terminateAffiliate',
] as const

export function hasAdminAffiliateManagementGateway(
  gateway: AdminGateway,
): gateway is AdminGateway & AdminAffiliateManagementGateway {
  return affiliateManagementGatewayMethods.every((method) => typeof gateway[method] === 'function')
}

/** Capability required only by the nested product-configuration route. */
export interface AdminConfigurationGateway {
  getProductConfiguration(
    productId: string,
  ): Promise<AdminDataResult<AdminProductConfiguration | null>>
  getAffiliates(): Promise<AdminDataResult<AdminAffiliate[]>>
  getSources(): Promise<AdminDataResult<AdminSource[]>>
  createFunnel(input: AdminFunnelCreate): Promise<AdminDataResult<AdminFunnel | null>>
  updateFunnel(input: AdminFunnelUpdate): Promise<AdminDataResult<AdminFunnel | null>>
  setFunnelStatus(input: AdminFunnelStatusUpdate): Promise<AdminDataResult<AdminFunnel | null>>
  createSource(input: AdminSourceCreate): Promise<AdminDataResult<AdminSource | null>>
  createCampaign(input: AdminCampaignCreate): Promise<AdminDataResult<AdminCampaign | null>>
  setCampaignStatus(
    input: AdminCampaignStatusUpdate,
  ): Promise<AdminDataResult<AdminCampaign | null>>
  createAgreement(input: AdminAgreementCreate): Promise<AdminDataResult<AdminAgreement | null>>
  createCommissionRule(
    input: AdminCommissionRuleCreate,
  ): Promise<AdminDataResult<AdminCommissionRule | null>>
  setCommissionRuleStatus(
    input: AdminCommissionRuleStatusUpdate,
  ): Promise<AdminDataResult<AdminCommissionRule | null>>
  activateAgreement(
    input: AdminAgreementActivation,
  ): Promise<AdminDataResult<AdminAgreement | null>>
  activateProduct(input: AdminProductActivation): Promise<AdminDataResult<AdminProduct | null>>
  issueMainLink(input: AdminMainLinkIssue): Promise<AdminDataResult<AdminMainLink | null>>
  createBillingOffer(
    input: AdminBillingOfferCreate,
  ): Promise<AdminDataResult<AdminBillingOffer | null>>
  updateBillingOffer(
    input: AdminBillingOfferUpdate,
  ): Promise<AdminDataResult<AdminBillingOffer | null>>
  setBillingOfferStatus(
    input: AdminBillingOfferStatusUpdate,
  ): Promise<AdminDataResult<AdminBillingOffer | null>>
  verifyBillingOfferPrice(
    input: AdminBillingOfferVerificationRequest,
  ): Promise<AdminDataResult<AdminBillingOfferVerification | null>>
}

const configurationGatewayMethods = [
  'getProductConfiguration',
  'getAffiliates',
  'getSources',
  'createFunnel',
  'updateFunnel',
  'setFunnelStatus',
  'createSource',
  'createCampaign',
  'setCampaignStatus',
  'createAgreement',
  'createCommissionRule',
  'setCommissionRuleStatus',
  'activateAgreement',
  'activateProduct',
  'issueMainLink',
  'createBillingOffer',
  'updateBillingOffer',
  'setBillingOfferStatus',
  'verifyBillingOfferPrice',
] as const

export function hasAdminConfigurationGateway(
  gateway: AdminGateway,
): gateway is AdminGateway & AdminConfigurationGateway {
  return configurationGatewayMethods.every((method) => typeof gateway[method] === 'function')
}

export type AdminBackendResponse = Readonly<{
  data: unknown
  error: Readonly<{
    code?: string
    message?: string
    status?: number
  }> | null
  status?: number
}>

export type AdminEdgeFunctionResponse = Readonly<{
  data: unknown
  error: Readonly<{
    name?: string
    message?: string
    status?: number
    context?: unknown
  }> | null
}>

export interface AdminEdgeFunctionsClient {
  invoke(
    functionName: string,
    options: Readonly<{ body: Record<string, unknown> }>,
  ): PromiseLike<AdminEdgeFunctionResponse>
}

/** The admin browser surface receives only constrained RPC and Edge Function methods. */
export interface AdminSupabaseClient {
  rpc(functionName: string, args?: Record<string, unknown>): PromiseLike<AdminBackendResponse>
  functions?: AdminEdgeFunctionsClient
}
