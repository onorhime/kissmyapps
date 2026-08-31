import { supabase } from '../../../lib/supabase'
import { PARTNER_COLUMNS, PARTNER_RPCS, PARTNER_VIEWS } from './contract'
import {
  mapPartnerAgreement,
  mapPartnerDashboardSummary,
  mapPartnerDocument,
  mapPartnerLink,
  mapPartnerLinkOption,
  mapPartnerPayout,
  mapPartnerPayoutDetail,
  mapPartnerPayoutSummary,
  mapPartnerProduct,
  mapPartnerProfile,
  mapPartnerTrendPoint,
  mapRows,
  mapSingleRow,
} from './mappers'
import type {
  PartnerAgreement,
  PartnerDashboardQuery,
  PartnerDashboardSummary,
  PartnerDataError,
  PartnerDataResult,
  PartnerDocument,
  PartnerLink,
  PartnerLinkCreate,
  PartnerLinkDirectory,
  PartnerLinkStatus,
  PartnerLinkUpdate,
  PartnerPayout,
  PartnerPayoutDetail,
  PartnerPayoutSummary,
  PartnerProduct,
  PartnerProfile,
  PartnerProfileUpdate,
  PartnerSettingsUpdate,
  PartnerTrendPoint,
  PartnerTrendQuery,
} from './types'

type BackendError = Readonly<{
  code?: string
  message?: string
  status?: number
}>

type BackendResponse = Readonly<{
  data: unknown
  error: BackendError | null
  status?: number
}>

export interface PartnerQueryBuilder extends PromiseLike<BackendResponse> {
  select(columns: string): PartnerQueryBuilder
  eq(column: string, value: string): PartnerQueryBuilder
  order(column: string, options?: { ascending?: boolean }): PartnerQueryBuilder
  maybeSingle(): PartnerQueryBuilder
}

/** A deliberately tiny subset of Supabase used by this browser gateway. */
export interface PartnerSupabaseClient {
  from(relation: string): PartnerQueryBuilder
  rpc(functionName: string, args?: Record<string, unknown>): PromiseLike<BackendResponse>
}

export interface PartnerDataGateway {
  getCurrentPartnerProfile(): Promise<PartnerDataResult<PartnerProfile | null>>
  getDashboardSummary(
    query: PartnerDashboardQuery,
  ): Promise<PartnerDataResult<PartnerDashboardSummary>>
  getDashboardTrends(query: PartnerTrendQuery): Promise<PartnerDataResult<PartnerTrendPoint[]>>
  getProducts(): Promise<PartnerDataResult<PartnerProduct[]>>
  getLinkDirectory(): Promise<PartnerDataResult<PartnerLinkDirectory>>
  getPartnerLinks(productId?: string | null): Promise<PartnerDataResult<PartnerLink[]>>
  createPartnerLink(input: PartnerLinkCreate): Promise<PartnerDataResult<PartnerLink | null>>
  updatePartnerLink(
    linkId: string,
    patch: PartnerLinkUpdate,
  ): Promise<PartnerDataResult<PartnerLink | null>>
  setPartnerLinkStatus(
    linkId: string,
    status: PartnerLinkStatus,
  ): Promise<PartnerDataResult<PartnerLink | null>>
  getPayoutSummary(productId?: string | null): Promise<PartnerDataResult<PartnerPayoutSummary>>
  getPayoutHistory(productId?: string | null): Promise<PartnerDataResult<PartnerPayout[]>>
  getPayoutDetail(payoutId: string): Promise<PartnerDataResult<PartnerPayoutDetail | null>>
  getDocuments(productId?: string | null): Promise<PartnerDataResult<PartnerDocument[]>>
  getAgreements(productId?: string | null): Promise<PartnerDataResult<PartnerAgreement[]>>
  updatePartnerProfile(
    profile: PartnerProfileUpdate,
  ): Promise<PartnerDataResult<PartnerProfile | null>>
  updatePartnerSettings(
    settings: PartnerSettingsUpdate,
  ): Promise<PartnerDataResult<PartnerProfile | null>>
}

const emptyMetrics = () => ({
  clicks: null,
  visitors: null,
  funnelStarts: null,
  paymentViews: null,
  appStoreClicks: null,
  leads: null,
  trials: null,
  installs: null,
  purchases: null,
  activations: null,
  renewals: null,
  cancellations: null,
  refunds: null,
  disputes: null,
  grossCollectedMinor: null,
  eligibleRevenueMinor: null,
  earningsMinor: null,
  activeSubscriptions: null,
})

export const emptyPartnerDashboardSummary = (): PartnerDashboardSummary => ({
  startsOn: null,
  endsOn: null,
  timezone: 'UTC',
  currency: null,
  hasData: false,
  reconciliationStage: null,
  reconciledThrough: null,
  metrics: emptyMetrics(),
})

export const emptyPartnerPayoutSummary = (): PartnerPayoutSummary => ({
  currency: null,
  openMinor: null,
  approvedMinor: null,
  scheduledMinor: null,
  paidMinor: null,
  carriedForwardMinor: null,
  nextExpectedPaymentAt: null,
})

const emptyLinkDirectory = (): PartnerLinkDirectory => ({
  products: [],
  funnels: [],
  sources: [],
  campaigns: [],
})

function dataResult<T>(
  data: T,
  status: PartnerDataResult<T>['status'],
  error: PartnerDataError | null = null,
): PartnerDataResult<T> {
  return { data, status, error }
}

function unconfigured<T>(empty: () => T): PartnerDataResult<T> {
  return dataResult(empty(), 'unconfigured', {
    code: 'not_configured',
    message: 'The partner data connection is not configured.',
    retryable: false,
  })
}

function invalidResponse<T>(empty: () => T): PartnerDataResult<T> {
  return dataResult(empty(), 'error', {
    code: 'invalid_response',
    message: 'Partner data is temporarily unavailable.',
    retryable: false,
  })
}

function backendFailure<T>(error: BackendError, status: number | undefined, empty: () => T) {
  const code = error.code ?? ''
  const httpStatus = error.status ?? status
  let mapped: PartnerDataError

  if (httpStatus === 401 || code === 'PGRST301') {
    mapped = {
      code: 'not_authenticated',
      message: 'Sign in to access partner data.',
      retryable: false,
    }
  } else if (httpStatus === 403 || code === '42501') {
    mapped = {
      code: 'not_authorized',
      message: 'This partner account cannot access that data.',
      retryable: false,
    }
  } else if (code === '23505' || httpStatus === 409) {
    mapped = {
      code: 'conflict',
      message: 'That partner record already exists or conflicts with another record.',
      retryable: false,
    }
  } else if (code === 'PGRST116') {
    mapped = { code: 'not_found', message: 'The partner record was not found.', retryable: false }
  } else if (
    ['42P01', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code) ||
    httpStatus === 404
  ) {
    mapped = {
      code: 'contract_unavailable',
      message: 'The partner data service is not available yet.',
      retryable: false,
    }
  } else if (httpStatus === 0 || (httpStatus !== undefined && httpStatus >= 500)) {
    mapped = {
      code: 'temporarily_unavailable',
      message: 'Partner data is temporarily unavailable.',
      retryable: true,
    }
  } else {
    mapped = {
      code: 'unknown',
      message: 'Partner data could not be loaded.',
      retryable: true,
    }
  }

  return dataResult(empty(), 'error', mapped)
}

function thrownFailure<T>(empty: () => T): PartnerDataResult<T> {
  return dataResult(empty(), 'error', {
    code: 'temporarily_unavailable',
    message: 'Partner data is temporarily unavailable.',
    retryable: true,
  })
}

async function readRows<T>(
  request: () => PromiseLike<BackendResponse>,
  mapper: (row: unknown) => T,
  empty: () => T[],
): Promise<PartnerDataResult<T[]>> {
  try {
    const response = await request()
    if (response.error) return backendFailure(response.error, response.status, empty)
    try {
      const data = mapRows(response.data ?? [], mapper)
      return dataResult(data, data.length ? 'ready' : 'empty')
    } catch {
      return invalidResponse(empty)
    }
  } catch {
    return thrownFailure(empty)
  }
}

async function readSingle<T>(
  request: () => PromiseLike<BackendResponse>,
  mapper: (row: unknown) => T,
  empty: () => T | null,
): Promise<PartnerDataResult<T | null>> {
  try {
    const response = await request()
    if (response.error) return backendFailure(response.error, response.status, empty)
    try {
      const data = mapSingleRow(response.data, mapper)
      return dataResult(data, data ? 'ready' : 'empty')
    } catch {
      return invalidResponse(empty)
    }
  } catch {
    return thrownFailure(empty)
  }
}

function dashboardArgs(query: PartnerDashboardQuery): Record<string, unknown> {
  return {
    p_product_id: query.productId ?? null,
    p_starts_on: query.startsOn,
    p_ends_on: query.endsOn,
    p_timezone: query.timezone,
    p_source_id: query.sourceId ?? null,
    p_campaign_id: query.campaignId ?? null,
    p_funnel_id: query.funnelId ?? null,
    p_country_code: query.countryCode ?? null,
    p_sub_id: query.subId ?? null,
  }
}

function profilePayload(profile: PartnerProfileUpdate) {
  return {
    full_name: profile.fullName,
    public_name: profile.publicName,
    legal_name: profile.legalName,
    entity_type: profile.entityType,
    country_code: profile.countryCode,
    timezone: profile.timezone,
    preferred_currency: profile.preferredCurrency,
    website: profile.website,
    category: profile.category,
    audience_description: profile.audienceDescription,
    audience_countries: [...profile.audienceCountries],
    channels: [...profile.channels],
    channel_details: profile.channelDetails,
  }
}

function notificationPayload(settings: PartnerSettingsUpdate) {
  return {
    statements: settings.notifications.statements,
    payouts: settings.notifications.payouts,
    verification: settings.notifications.verification,
    signatures: settings.notifications.signatures,
    adjustments: settings.notifications.adjustments,
    inactive_links: settings.notifications.inactiveLinks,
  }
}

function linkCreatePayload(input: PartnerLinkCreate) {
  return {
    name: input.name,
    product_id: input.productId,
    funnel_id: input.funnelId,
    source_id: input.sourceId,
    campaign_id: input.campaignId,
    sub1: input.sub1,
    sub2: input.sub2,
    sub3: input.sub3,
    parent_link_id: input.parentLinkId ?? null,
  }
}

function linkUpdatePayload(patch: PartnerLinkUpdate) {
  return { name: patch.name }
}

export function createPartnerDataGateway(
  client: PartnerSupabaseClient | null = supabase as unknown as PartnerSupabaseClient | null,
): PartnerDataGateway {
  const noClientSingle = <T>() => unconfigured<T | null>(() => null)
  const noClientRows = <T>() => unconfigured<T[]>(() => [])

  return {
    async getCurrentPartnerProfile() {
      if (!client) return noClientSingle<PartnerProfile>()
      return readSingle(
        () => client.from(PARTNER_VIEWS.profile).select(PARTNER_COLUMNS.profile).maybeSingle(),
        mapPartnerProfile,
        () => null,
      )
    },

    async getDashboardSummary(query) {
      if (!client) return unconfigured(emptyPartnerDashboardSummary)
      // Reporting money is product-scoped. Until a product is selected there
      // is no safe currency context in which to combine minor-unit values.
      if (!query.productId) return dataResult(emptyPartnerDashboardSummary(), 'empty')
      const result = await readSingle(
        () => client.rpc(PARTNER_RPCS.dashboardSummary, dashboardArgs(query)),
        mapPartnerDashboardSummary,
        () => null,
      )
      if (result.data) return dataResult(result.data, result.status, result.error)
      return dataResult(emptyPartnerDashboardSummary(), result.status, result.error)
    },

    async getDashboardTrends(query) {
      if (!client) return noClientRows<PartnerTrendPoint>()
      if (!query.productId) return dataResult([], 'empty')
      return readRows(
        () =>
          client.rpc(PARTNER_RPCS.dashboardTrends, {
            ...dashboardArgs(query),
            p_grain: query.grain,
            p_breakdown: query.breakdown,
          }),
        mapPartnerTrendPoint,
        () => [],
      )
    },

    async getProducts() {
      if (!client) return noClientRows<PartnerProduct>()
      return readRows(
        () =>
          client
            .from(PARTNER_VIEWS.products)
            .select(PARTNER_COLUMNS.products)
            .order('name', { ascending: true }),
        mapPartnerProduct,
        () => [],
      )
    },

    async getLinkDirectory() {
      if (!client) return unconfigured(emptyLinkDirectory)
      const [products, options] = await Promise.all([
        readRows(
          () =>
            client
              .from(PARTNER_VIEWS.products)
              .select(PARTNER_COLUMNS.products)
              .order('name', { ascending: true }),
          mapPartnerProduct,
          () => [],
        ),
        readRows(
          () =>
            client
              .from(PARTNER_VIEWS.linkOptions)
              .select(PARTNER_COLUMNS.linkOptions)
              .order('name', { ascending: true }),
          mapPartnerLinkOption,
          () => [],
        ),
      ])
      const error = products.error ?? options.error
      if (error) return dataResult(emptyLinkDirectory(), 'error', error)
      const data: PartnerLinkDirectory = {
        products: products.data,
        funnels: options.data.filter((option) => option.kind === 'funnel'),
        sources: options.data.filter((option) => option.kind === 'source'),
        campaigns: options.data.filter((option) => option.kind === 'campaign'),
      }
      const hasDirectoryData =
        data.products.length + data.funnels.length + data.sources.length + data.campaigns.length > 0
      return dataResult(data, hasDirectoryData ? 'ready' : 'empty')
    },

    async getPartnerLinks(productId) {
      if (!client) return noClientRows<PartnerLink>()
      return readRows(
        () => {
          let request = client
            .from(PARTNER_VIEWS.links)
            .select(PARTNER_COLUMNS.links)
            .order('created_at', { ascending: false })
          if (productId) request = request.eq('product_id', productId)
          return request
        },
        mapPartnerLink,
        () => [],
      )
    },

    async createPartnerLink(input) {
      if (!client) return noClientSingle<PartnerLink>()
      return readSingle(
        () => client.rpc(PARTNER_RPCS.createLink, { p_input: linkCreatePayload(input) }),
        mapPartnerLink,
        () => null,
      )
    },

    async updatePartnerLink(linkId, patch) {
      if (!client) return noClientSingle<PartnerLink>()
      return readSingle(
        () =>
          client.rpc(PARTNER_RPCS.updateLink, {
            p_link_id: linkId,
            p_patch: linkUpdatePayload(patch),
          }),
        mapPartnerLink,
        () => null,
      )
    },

    async setPartnerLinkStatus(linkId, status) {
      if (!client) return noClientSingle<PartnerLink>()
      return readSingle(
        () => client.rpc(PARTNER_RPCS.setLinkStatus, { p_link_id: linkId, p_status: status }),
        mapPartnerLink,
        () => null,
      )
    },

    async getPayoutSummary(productId) {
      if (!client) return unconfigured(emptyPartnerPayoutSummary)
      // Payout summaries are intentionally product-scoped. An unfiltered view
      // can contain one row per product and currency, and combining those rows
      // in the browser would create a misleading cross-currency balance.
      if (!productId) return dataResult(emptyPartnerPayoutSummary(), 'empty')
      const result = await readSingle(
        () => {
          const request = client
            .from(PARTNER_VIEWS.payoutSummary)
            .select(PARTNER_COLUMNS.payoutSummary)
          return request.eq('product_id', productId).maybeSingle()
        },
        mapPartnerPayoutSummary,
        () => null,
      )
      if (result.data) return dataResult(result.data, result.status, result.error)
      return dataResult(emptyPartnerPayoutSummary(), result.status, result.error)
    },

    async getPayoutHistory(productId) {
      if (!client) return noClientRows<PartnerPayout>()
      return readRows(
        () => {
          let request = client
            .from(PARTNER_VIEWS.payoutHistory)
            .select(PARTNER_COLUMNS.payoutHistory)
            .order('period_starts_at', { ascending: false })
          if (productId) request = request.eq('product_id', productId)
          return request
        },
        mapPartnerPayout,
        () => [],
      )
    },

    async getPayoutDetail(payoutId) {
      if (!client) return noClientSingle<PartnerPayoutDetail>()
      return readSingle(
        () => client.rpc(PARTNER_RPCS.payoutDetail, { p_payout_id: payoutId }),
        mapPartnerPayoutDetail,
        () => null,
      )
    },

    async getDocuments(productId) {
      if (!client) return noClientRows<PartnerDocument>()
      return readRows(
        () => {
          let request = client
            .from(PARTNER_VIEWS.documents)
            .select(PARTNER_COLUMNS.documents)
            .order('created_at', { ascending: false })
          if (productId) request = request.eq('product_id', productId)
          return request
        },
        mapPartnerDocument,
        () => [],
      )
    },

    async getAgreements(productId) {
      if (!client) return noClientRows<PartnerAgreement>()
      return readRows(
        () => {
          let request = client
            .from(PARTNER_VIEWS.agreements)
            .select(PARTNER_COLUMNS.agreements)
            .order('version', { ascending: false })
          if (productId) request = request.eq('product_id', productId)
          return request
        },
        mapPartnerAgreement,
        () => [],
      )
    },

    async updatePartnerProfile(profile) {
      if (!client) return noClientSingle<PartnerProfile>()
      return readSingle(
        () => client.rpc(PARTNER_RPCS.updateProfile, { p_profile: profilePayload(profile) }),
        mapPartnerProfile,
        () => null,
      )
    },

    async updatePartnerSettings(settings) {
      if (!client) return noClientSingle<PartnerProfile>()
      return readSingle(
        () =>
          client.rpc(PARTNER_RPCS.updateSettings, {
            p_settings: { notifications: notificationPayload(settings) },
          }),
        mapPartnerProfile,
        () => null,
      )
    },
  }
}

export const partnerDataGateway = createPartnerDataGateway()
