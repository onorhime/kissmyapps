import { supabase } from '../../../lib/supabase'
import { PARTNER_COLUMNS, PARTNER_RPCS, PARTNER_VIEWS } from './contract'
import {
  mapPartnerAgreement,
  mapPartnerDashboardSummary,
  mapPartnerDocument,
  mapPartnerDocumentDownload,
  mapPartnerLink,
  mapPartnerLinkOption,
  mapPartnerPayout,
  mapPartnerPayoutDetail,
  mapPartnerPayoutSummary,
  mapPartnerProduct,
  mapPartnerProfile,
  mapPartnerSignatureReceipt,
  mapPartnerSignatureQueue,
  mapPartnerTrendPoint,
  mapRows,
  mapSingleRow,
} from './mappers'
import {
  programError,
  programFailure,
  readMembershipAnswer,
  readPartnerMarketplace,
  readPartnerProgramView,
} from '../marketplace/programs'
import { readProgramEarnings } from '../earnings/earnings'
import type { ProgramEarnings } from '../earnings/earnings'
import { readProgramPerformance } from '../performance/performance'
import type { PerformanceQuery, ProgramPerformance } from '../performance/performance'
import { linkError, linkFailure, readLinkProgram, readProgramLinks } from '../links/links'
import type {
  LinkProgram,
  ProgramLinkCreateInput,
  ProgramLinks,
  ProgramLinksResult,
} from '../links/links'
import type {
  PartnerMarketplace,
  PartnerProgramError,
  PartnerProgramResult,
  PartnerProgramView,
  ProgramJoinInput,
  ProgramMembership,
  ProgramTermsInput,
} from '../marketplace/programs'
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
  PartnerSignatureReceipt,
  PartnerSignatureRequest,
  PartnerTrendPoint,
  PartnerTrendQuery,
} from './types'

type BackendError = Readonly<{
  code?: string
  message?: string
  /** PostgREST passes the DETAIL of a raised exception here. */
  details?: string
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
  functions?: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): PromiseLike<{
      data: unknown
      error: { message?: string } | null
    }>
  }
  from(relation: string): PartnerQueryBuilder
  rpc(functionName: string, args?: Record<string, unknown>): PromiseLike<BackendResponse>
  storage?: {
    from(bucket: string): {
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<{
        data: { signedUrl: string } | null
        error: { message: string } | null
      }>
    }
  }
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
  getDocumentUrl?: (documentId: string) => Promise<PartnerDataResult<string | null>>
  getAgreements(productId?: string | null): Promise<PartnerDataResult<PartnerAgreement[]>>
  updatePartnerProfile(
    profile: PartnerProfileUpdate,
  ): Promise<PartnerDataResult<PartnerProfile | null>>
  updatePartnerSettings(
    settings: PartnerSettingsUpdate,
  ): Promise<PartnerDataResult<PartnerProfile | null>>
  /** Optional: agreement-signing capability may be absent in older deployments. */
  getSignatureQueue?: () => Promise<PartnerDataResult<readonly PartnerSignatureRequest[]>>
  signAgreement?: (input: {
    documentId: string
    legalName: string
    acknowledged: true
  }) => Promise<PartnerDataResult<PartnerSignatureReceipt | null>>
  getAgreementDocumentUrl?: (input: {
    filePath: string
  }) => Promise<PartnerDataResult<string | null>>
  /** Optional: the program marketplace may be absent in older deployments. */
  getMarketplace?: () => Promise<PartnerProgramResult<PartnerMarketplace | null>>
  getProgram?: (slug: string) => Promise<PartnerProgramResult<PartnerProgramView | null>>
  /** The click-accept: sends the version and hash of the agreement that was on screen. */
  joinProgram?: (input: ProgramJoinInput) => Promise<PartnerProgramResult<ProgramMembership | null>>
  acceptProgramTerms?: (
    input: ProgramTermsInput,
  ) => Promise<PartnerProgramResult<ProgramMembership | null>>
  leaveProgram?: (programId: string) => Promise<PartnerProgramResult<ProgramMembership | null>>
  /** Optional: program money may be absent in older deployments. */
  getProgramEarnings?: () => Promise<PartnerDataResult<ProgramEarnings | null>>
  /** Optional: program results may be absent in older deployments. */
  getProgramPerformance?: (
    query: PerformanceQuery,
  ) => Promise<PartnerDataResult<ProgramPerformance | null>>
  /** Optional: program links may be absent in older deployments. */
  getProgramLinks?: () => Promise<ProgramLinksResult<ProgramLinks | null>>
  /** Adding and removing a custom link answer with the program as it is afterwards. */
  createProgramLink?: (
    input: ProgramLinkCreateInput,
  ) => Promise<ProgramLinksResult<LinkProgram | null>>
  removeProgramLink?: (linkId: string) => Promise<ProgramLinksResult<LinkProgram | null>>
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

/**
 * One call to a program function. Its failures carry a stable code in DETAIL, which is kept;
 * anything else falls back to the general mapping above.
 */
async function programCall<T>(
  client: PartnerSupabaseClient | null,
  functionName: string,
  args: Record<string, unknown> | undefined,
  read: (data: unknown) => T,
): Promise<PartnerProgramResult<T | null>> {
  const failed = (error: PartnerProgramError): PartnerProgramResult<T | null> => ({
    data: null,
    status: 'error',
    error,
  })
  if (!client) return { data: null, status: 'unconfigured', error: programError('not_configured') }
  try {
    const response = await client.rpc(functionName, args)
    if (response.error) {
      const known = programFailure(response.error)
      if (known) return failed(known)
      const general = backendFailure(response.error, response.status, () => null).error
      return failed(programError(general?.code ?? 'unknown'))
    }
    try {
      return { data: read(response.data), status: 'ready', error: null }
    } catch {
      return failed(programError('invalid_response'))
    }
  } catch {
    return failed(programError('temporarily_unavailable'))
  }
}

/** One call to a program link function: its own DETAIL codes first, then the general mapping. */
async function linkCall<T>(
  client: PartnerSupabaseClient | null,
  functionName: string,
  args: Record<string, unknown> | undefined,
  read: (data: unknown) => T,
): Promise<ProgramLinksResult<T | null>> {
  const failed = (error: ProgramLinksResult<null>['error']): ProgramLinksResult<T | null> => ({
    data: null,
    status: 'error',
    error,
  })
  if (!client) return { data: null, status: 'unconfigured', error: linkError('not_configured') }
  try {
    const response = await client.rpc(functionName, args)
    if (response.error) {
      const general = backendFailure(response.error, response.status, () => null).error
      return failed(linkFailure(response.error) ?? linkError(general?.code ?? 'unknown'))
    }
    try {
      return { data: read(response.data), status: 'ready', error: null }
    } catch {
      return failed(linkError('invalid_response'))
    }
  } catch {
    return failed(linkError('temporarily_unavailable'))
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

    async getDocumentUrl(documentId) {
      if (!client?.storage) return unconfigured(() => null)
      try {
        const response = await client.rpc(PARTNER_RPCS.documentDownload, {
          p_document_id: documentId,
        })
        if (response.error) return backendFailure(response.error, response.status, () => null)
        let download
        try {
          download = mapSingleRow(response.data, mapPartnerDocumentDownload)
          if (!download || download.documentId !== documentId) throw new Error('Document mismatch')
        } catch {
          return invalidResponse(() => null)
        }
        // The resolver and Storage each check the current account. No public
        // bucket or client-supplied object path is used for document downloads.
        const signed = await client.storage
          .from(download.bucket)
          .createSignedUrl(download.filePath, 300)
        if (signed.error || !signed.data?.signedUrl) return thrownFailure(() => null)
        try {
          const url = new URL(signed.data.signedUrl)
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            decodeURIComponent(url.pathname) !==
              `/storage/v1/object/sign/${download.bucket}/${download.filePath}` ||
            !url.searchParams.get('token')
          )
            throw new Error('Invalid private URL')
        } catch {
          return invalidResponse(() => null)
        }
        return dataResult(signed.data.signedUrl, 'ready')
      } catch {
        return thrownFailure(() => null)
      }
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

    async getSignatureQueue() {
      if (!client) return unconfigured((): readonly PartnerSignatureRequest[] => [])
      try {
        const response = await client.rpc(PARTNER_RPCS.signatureQueue)
        if (response.error) {
          return backendFailure(response.error, response.status, () => [])
        }
        const queue = mapPartnerSignatureQueue(response.data)
        return dataResult(queue, queue.length ? 'ready' : 'empty')
      } catch {
        return thrownFailure((): readonly PartnerSignatureRequest[] => [])
      }
    },

    async signAgreement(input) {
      if (!client) return noClientSingle<PartnerSignatureReceipt>()
      try {
        const response = await client.rpc(PARTNER_RPCS.signAgreement, {
          p_input: {
            document_id: input.documentId,
            legal_name: input.legalName.trim(),
            acknowledged: input.acknowledged,
          },
        })
        if (response.error) {
          const code = response.error.code ?? ''
          if (code === 'P0001' || code === '55000') {
            return dataResult(null, 'error', {
              code: 'conflict',
              message:
                'This agreement has changed. Check its current signature status before trying again.',
              retryable: false,
            })
          }
          if (code === '22023') {
            return dataResult(null, 'error', {
              code: 'conflict',
              message: 'Enter your full legal name exactly as it should appear on the agreement.',
              retryable: false,
            })
          }
          return backendFailure(response.error, response.status, () => null)
        }
        try {
          // The RPC returns the committed documents row. The directory mapper
          // requires view-only aliases/download flags and cannot parse this row.
          const receipt = mapSingleRow(response.data, mapPartnerSignatureReceipt)
          if (
            !receipt ||
            receipt.documentId !== input.documentId ||
            receipt.signerName !== input.legalName.trim()
          )
            throw new Error('signature receipt does not match the request')
          return dataResult(receipt, 'ready')
        } catch {
          return invalidResponse(() => null)
        }
      } catch {
        return thrownFailure(() => null)
      }
    },

    async getMarketplace() {
      return programCall(client, PARTNER_RPCS.marketplace, undefined, readPartnerMarketplace)
    },

    async getProgram(slug) {
      return programCall(
        client,
        PARTNER_RPCS.programDetail,
        { p_slug: slug },
        readPartnerProgramView,
      )
    },

    async joinProgram(input) {
      return programCall(
        client,
        PARTNER_RPCS.programJoin,
        {
          p_input: {
            slug: input.slug,
            terms_version: input.termsVersion,
            agreement_sha256: input.agreementSha256,
          },
        },
        readMembershipAnswer,
      )
    },

    async acceptProgramTerms(input) {
      return programCall(
        client,
        PARTNER_RPCS.programAcceptTerms,
        {
          p_input: {
            program_id: input.programId,
            terms_version: input.termsVersion,
            agreement_sha256: input.agreementSha256,
          },
        },
        readMembershipAnswer,
      )
    },

    async leaveProgram(programId) {
      return programCall(
        client,
        PARTNER_RPCS.programLeave,
        { p_input: { program_id: programId } },
        readMembershipAnswer,
      )
    },

    async getProgramEarnings() {
      if (!client) return noClientSingle<ProgramEarnings>()
      try {
        const response = await client.rpc(PARTNER_RPCS.programEarnings)
        if (response.error) return backendFailure(response.error, response.status, () => null)
        try {
          const earnings = readProgramEarnings(response.data)
          return dataResult(
            earnings,
            earnings.programs.length + earnings.recent.length > 0 ? 'ready' : 'empty',
          )
        } catch {
          return invalidResponse(() => null)
        }
      } catch {
        return thrownFailure(() => null)
      }
    },

    async getProgramPerformance(query) {
      if (!client) return noClientSingle<ProgramPerformance>()
      try {
        const response = await client.rpc(PARTNER_RPCS.programPerformance, {
          p_input: { slug: query.slug, days: query.days },
        })
        if (response.error) {
          // A slug that is not the creator's: the page goes back to their first program.
          if (response.error.code === 'P0002')
            return dataResult(null, 'error', {
              code: 'not_found',
              message: 'That program was not found.',
              retryable: false,
            })
          return backendFailure(response.error, response.status, () => null)
        }
        try {
          const performance = readProgramPerformance(response.data)
          return dataResult(performance, performance.program ? 'ready' : 'empty')
        } catch {
          return invalidResponse(() => null)
        }
      } catch {
        return thrownFailure(() => null)
      }
    },

    async getProgramLinks() {
      return linkCall(client, PARTNER_RPCS.programLinks, undefined, readProgramLinks)
    },

    async createProgramLink(input) {
      return linkCall(
        client,
        PARTNER_RPCS.programLinkCreate,
        { p_input: { slug: input.slug, name: input.name } },
        readLinkProgram,
      )
    },

    async removeProgramLink(linkId) {
      return linkCall(
        client,
        PARTNER_RPCS.programLinkRemove,
        { p_input: { link_id: linkId } },
        readLinkProgram,
      )
    },

    async getAgreementDocumentUrl(input) {
      if (!supabase) {
        return unconfigured(() => null)
      }
      try {
        const signed = await supabase.storage
          .from('affiliate-private-documents')
          .createSignedUrl(input.filePath, 300)
        if (signed.error || !signed.data?.signedUrl) {
          return dataResult(null, 'error', {
            code: 'temporarily_unavailable',
            message: 'The agreement document could not be opened. Try again.',
            retryable: true,
          })
        }
        return dataResult(signed.data.signedUrl, 'ready')
      } catch {
        return thrownFailure(() => null)
      }
    },
  }
}

export const partnerDataGateway = createPartnerDataGateway()
