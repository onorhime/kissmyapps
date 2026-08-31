import { supabase } from '../../../lib/supabase'
import {
  mapAdminAffiliate,
  mapAdminAgreement,
  mapAdminBillingOffer,
  mapAdminCampaign,
  mapAdminCommissionRule,
  mapAdminFunnel,
  mapAdminMainLink,
  mapAdminProductConfiguration,
  mapAdminSource,
} from './configurationMappers'
import { mapAdminContext, mapAdminProduct, mapAdminRows, singleAdminRow } from './mappers'
import type {
  AdminAffiliate,
  AdminAgreement,
  AdminBackendResponse,
  AdminBillingOffer,
  AdminBillingOfferVerification,
  AdminEdgeFunctionResponse,
  AdminCampaign,
  AdminCommissionRule,
  AdminContext,
  AdminDataError,
  AdminDataResult,
  AdminFunnel,
  AdminGateway,
  AdminMainLink,
  AdminProduct,
  AdminProductConfiguration,
  AdminSource,
  AdminSupabaseClient,
} from './types'

export const ADMIN_RPCS = Object.freeze({
  context: 'get_admin_context',
  products: 'get_admin_products',
  createProduct: 'create_admin_product',
  productConfiguration: 'get_admin_product_configuration',
  affiliates: 'get_admin_affiliates',
  sources: 'get_admin_sources',
  createFunnel: 'create_admin_funnel',
  updateFunnel: 'update_admin_funnel',
  setFunnelStatus: 'set_admin_funnel_status',
  createSource: 'create_admin_source',
  createCampaign: 'create_admin_campaign',
  setCampaignStatus: 'set_admin_campaign_status',
  createAgreement: 'create_admin_agreement',
  createCommissionRule: 'create_admin_commission_rule',
  setCommissionRuleStatus: 'set_admin_commission_rule_status',
  activateAgreement: 'activate_admin_agreement',
  activateProduct: 'activate_admin_product',
  issueMainLink: 'issue_admin_main_link',
  createBillingOffer: 'create_admin_billing_offer',
  updateBillingOffer: 'update_admin_billing_offer',
  setBillingOfferStatus: 'set_admin_billing_offer_status',
})

export const ADMIN_EDGE_FUNCTIONS = Object.freeze({
  verifyBillingOfferPrice: 'stripe-price-verifier',
})

type Empty<T> = () => T

function result<T>(
  data: T,
  status: AdminDataResult<T>['status'],
  error: AdminDataError | null = null,
): AdminDataResult<T> {
  return { data, status, error }
}

function notConfigured<T>(empty: Empty<T>): AdminDataResult<T> {
  return result(empty(), 'unconfigured', {
    code: 'not_configured',
    message: 'The admin data connection is not configured.',
    retryable: false,
  })
}

function invalidResponse<T>(empty: Empty<T>): AdminDataResult<T> {
  return result(empty(), 'error', {
    code: 'invalid_response',
    message: 'The admin data service returned an invalid response.',
    retryable: false,
  })
}

function temporaryFailure<T>(empty: Empty<T>): AdminDataResult<T> {
  return result(empty(), 'error', {
    code: 'temporarily_unavailable',
    message: 'Admin data is temporarily unavailable.',
    retryable: true,
  })
}

function edgeStatus(response: AdminEdgeFunctionResponse): number | undefined {
  if (typeof response.error?.status === 'number') return response.error.status
  const context = response.error?.context
  if (context && typeof context === 'object' && 'status' in context) {
    const status = (context as { status?: unknown }).status
    if (typeof status === 'number') return status
  }
  return undefined
}

function edgeFailure<T>(response: AdminEdgeFunctionResponse, empty: Empty<T>): AdminDataResult<T> {
  const status = edgeStatus(response)
  if (status === 401) return unauthorized(empty, false)
  if (status === 403) return unauthorized(empty, true)
  if (status === 400 || status === 409 || status === 422) {
    return result(empty(), 'error', {
      code: 'invalid_state',
      message:
        'The live Stripe Price could not be verified. Check the draft Price ID, mode, currency, and exact amount.',
      retryable: false,
    })
  }
  if (status === 404) {
    return result(empty(), 'error', {
      code: 'contract_unavailable',
      message: 'Live Stripe Price verification is not available yet.',
      retryable: false,
    })
  }
  if (status === 0 || (status !== undefined && status >= 500)) {
    return result(empty(), 'error', {
      code: 'temporarily_unavailable',
      message: 'Live Stripe Price verification is temporarily unavailable.',
      retryable: true,
    })
  }
  return result(empty(), 'error', {
    code: 'unknown',
    message: 'The live Stripe Price could not be verified.',
    retryable: true,
  })
}

function mapBillingOfferVerification(
  value: unknown,
  expectedBillingOfferId: string,
): AdminBillingOfferVerification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid verification response.')
  }
  const row = value as Record<string, unknown>
  if (
    row.verified !== true ||
    row.billing_offer_id !== expectedBillingOfferId ||
    typeof row.request_id !== 'string' ||
    !row.request_id.trim() ||
    row.request_id.length > 200
  ) {
    throw new Error('Invalid verification response.')
  }
  return {
    verified: true,
    billingOfferId: expectedBillingOfferId,
    requestId: row.request_id,
  }
}

function unauthorized<T>(empty: Empty<T>, authenticated: boolean): AdminDataResult<T> {
  return result(empty(), 'unauthorized', {
    code: authenticated ? 'not_authorized' : 'not_authenticated',
    message: authenticated
      ? 'This account does not have permission to use the admin workspace.'
      : 'Sign in with an authorized administrator account.',
    retryable: false,
  })
}

type FailureMessages = Readonly<{
  conflict?: string
  invalidInput?: string
  invalidReference?: string
  invalidState?: string
}>

function backendFailure<T>(
  response: AdminBackendResponse,
  empty: Empty<T>,
  messages: FailureMessages = {},
): AdminDataResult<T> {
  const code = response.error?.code ?? ''
  const status = response.error?.status ?? response.status

  if (status === 401 || code === '28000' || code === 'PGRST301') return unauthorized(empty, false)
  if (status === 403 || code === '42501') return unauthorized(empty, true)
  if (status === 409 || code === '23505') {
    return result(empty(), 'error', {
      code: 'conflict',
      message: messages.conflict ?? 'A record with those details already exists.',
      retryable: false,
    })
  }
  if (code === '22023' || status === 422) {
    return result(empty(), 'error', {
      code: 'invalid_input',
      message: messages.invalidInput ?? 'Check the form details and try again.',
      retryable: false,
    })
  }
  if (code === '23503' || code === 'P0002') {
    return result(empty(), 'error', {
      code: 'invalid_reference',
      message: messages.invalidReference ?? 'A selected record is no longer available.',
      retryable: false,
    })
  }
  if (code === '55000' || code === 'P0001') {
    return result(empty(), 'error', {
      code: 'invalid_state',
      message: messages.invalidState ?? 'This action is not available in the current state.',
      retryable: false,
    })
  }
  if (status === 404 || ['42P01', '42883', 'PGRST202', 'PGRST204'].includes(code)) {
    return result(empty(), 'error', {
      code: 'contract_unavailable',
      message: 'The admin data service is not available yet.',
      retryable: false,
    })
  }
  if (status === 0 || (status !== undefined && status >= 500)) return temporaryFailure(empty)
  return result(empty(), 'error', {
    code: 'unknown',
    message: 'Admin data could not be loaded.',
    retryable: true,
  })
}

async function mappedMutation<T>(
  client: AdminSupabaseClient,
  functionName: string,
  input: Record<string, unknown>,
  mapper: (value: unknown) => T,
  messages: FailureMessages = {},
): Promise<AdminDataResult<T | null>> {
  const called = await call(client, functionName, { p_input: input })
  if (!called.ok) return temporaryFailure<T | null>(() => null)
  const response = called.response
  if (response.error) return backendFailure(response, () => null, messages)
  try {
    const row = singleAdminRow(response.data)
    if (!row) return invalidResponse<T | null>(() => null)
    return result<T | null>(mapper(row), 'ready')
  } catch {
    return invalidResponse<T | null>(() => null)
  }
}

async function mappedCollection<T>(
  client: AdminSupabaseClient,
  functionName: string,
  mapper: (value: unknown) => T,
): Promise<AdminDataResult<T[]>> {
  const called = await call(client, functionName)
  if (!called.ok) return temporaryFailure<T[]>(() => [])
  const response = called.response
  if (response.error) return backendFailure(response, () => [])
  try {
    const values = mapAdminRows(response.data ?? [], mapper)
    return result(values, values.length ? 'ready' : 'empty')
  } catch {
    return invalidResponse<T[]>(() => [])
  }
}

async function call(
  client: AdminSupabaseClient,
  functionName: string,
  args?: Record<string, unknown>,
): Promise<Readonly<{ ok: true; response: AdminBackendResponse }> | Readonly<{ ok: false }>> {
  try {
    return { ok: true, response: await client.rpc(functionName, args) }
  } catch {
    return { ok: false }
  }
}

export function createAdminGateway(
  client: AdminSupabaseClient | null = supabase as unknown as AdminSupabaseClient | null,
): AdminGateway {
  return {
    async getAdminContext() {
      if (!client) return notConfigured<AdminContext | null>(() => null)
      const called = await call(client, ADMIN_RPCS.context)
      if (!called.ok) return temporaryFailure<AdminContext | null>(() => null)
      const response = called.response
      if (response.error) return backendFailure(response, () => null)
      try {
        const row = singleAdminRow(response.data)
        if (!row) return unauthorized<AdminContext | null>(() => null, true)
        const context = mapAdminContext(row)
        return context.active
          ? result<AdminContext | null>(context, 'ready')
          : unauthorized<AdminContext | null>(() => null, true)
      } catch {
        return invalidResponse<AdminContext | null>(() => null)
      }
    },

    async getProducts() {
      if (!client) return notConfigured<AdminProduct[]>(() => [])
      const called = await call(client, ADMIN_RPCS.products)
      if (!called.ok) return temporaryFailure<AdminProduct[]>(() => [])
      const response = called.response
      if (response.error) return backendFailure(response, () => [])
      try {
        const products = mapAdminRows(response.data ?? [], mapAdminProduct)
        return result(products, products.length ? 'ready' : 'empty')
      } catch {
        return invalidResponse<AdminProduct[]>(() => [])
      }
    },

    async createProduct(input) {
      if (!client) return notConfigured<AdminProduct | null>(() => null)
      const called = await call(client, ADMIN_RPCS.createProduct, {
        p_input: {
          name: input.name.trim(),
          slug: input.slug.trim().toLowerCase(),
        },
      })
      if (!called.ok) return temporaryFailure<AdminProduct | null>(() => null)
      const response = called.response
      if (response.error) {
        return backendFailure(response, () => null, {
          conflict: 'A product with that slug already exists.',
          invalidInput: 'Check the product name and slug and try again.',
        })
      }
      try {
        const row = singleAdminRow(response.data)
        if (!row) return invalidResponse<AdminProduct | null>(() => null)
        const product = mapAdminProduct(row)
        // A browser create operation must never be able to activate a product.
        if (product.status !== 'draft') return invalidResponse<AdminProduct | null>(() => null)
        return result<AdminProduct | null>(product, 'ready')
      } catch {
        return invalidResponse<AdminProduct | null>(() => null)
      }
    },

    async getProductConfiguration(productId) {
      if (!client) return notConfigured<AdminProductConfiguration | null>(() => null)
      const called = await call(client, ADMIN_RPCS.productConfiguration, {
        p_product_id: productId,
      })
      if (!called.ok) return temporaryFailure<AdminProductConfiguration | null>(() => null)
      const response = called.response
      if (response.error) {
        return backendFailure(response, () => null, {
          invalidReference: 'That product is no longer available.',
        })
      }
      try {
        return result<AdminProductConfiguration | null>(
          mapAdminProductConfiguration(response.data),
          'ready',
        )
      } catch {
        return invalidResponse<AdminProductConfiguration | null>(() => null)
      }
    },

    async getAffiliates() {
      if (!client) return notConfigured<AdminAffiliate[]>(() => [])
      return mappedCollection(client, ADMIN_RPCS.affiliates, mapAdminAffiliate)
    },

    async getSources() {
      if (!client) return notConfigured<AdminSource[]>(() => [])
      return mappedCollection(client, ADMIN_RPCS.sources, mapAdminSource)
    },

    async createFunnel(input) {
      if (!client) return notConfigured<AdminFunnel | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createFunnel,
        {
          product_id: input.productId,
          key: input.key.trim().toLowerCase(),
          name: input.name.trim(),
          destination_url: input.destinationUrl.trim(),
          is_default: input.isDefault,
        },
        mapAdminFunnel,
        {
          conflict: 'That funnel key or default funnel is already in use.',
          invalidInput: 'Check the funnel name, key, and HTTPS destination.',
        },
      )
    },

    async updateFunnel(input) {
      if (!client) return notConfigured<AdminFunnel | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.updateFunnel,
        {
          funnel_id: input.funnelId,
          name: input.name.trim(),
          destination_url: input.destinationUrl.trim(),
          is_default: input.isDefault,
        },
        mapAdminFunnel,
        {
          conflict: 'Another funnel is already the product default.',
          invalidInput: 'Check the funnel name and HTTPS destination.',
          invalidState: 'Pause this funnel before changing its routing configuration.',
        },
      )
    },

    async setFunnelStatus(input) {
      if (!client) return notConfigured<AdminFunnel | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.setFunnelStatus,
        { funnel_id: input.funnelId, status: input.status },
        mapAdminFunnel,
        { invalidState: 'The funnel cannot move to that status yet.' },
      )
    },

    async createSource(input) {
      if (!client) return notConfigured<AdminSource | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createSource,
        { key: input.key.trim().toLowerCase(), name: input.name.trim() },
        mapAdminSource,
        {
          conflict: 'A source with that key already exists.',
          invalidInput: 'Check the source name and key.',
        },
      )
    },

    async createCampaign(input) {
      if (!client) return notConfigured<AdminCampaign | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createCampaign,
        {
          product_id: input.productId,
          key: input.key.trim().toLowerCase(),
          name: input.name.trim(),
          starts_at: input.startsAt,
          ends_at: input.endsAt,
        },
        mapAdminCampaign,
        {
          conflict: 'A campaign with that key already exists for this product.',
          invalidInput: 'Check the campaign details and date range.',
        },
      )
    },

    async setCampaignStatus(input) {
      if (!client) return notConfigured<AdminCampaign | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.setCampaignStatus,
        { campaign_id: input.campaignId, status: input.status },
        mapAdminCampaign,
        { invalidState: 'The campaign cannot move to that status yet.' },
      )
    },

    async createAgreement(input) {
      if (!client) return notConfigured<AdminAgreement | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createAgreement,
        {
          product_id: input.productId,
          affiliate_id: input.affiliateId,
          model: input.model,
          attribution_window_days: input.attributionWindowDays,
          renewal_duration_days: input.renewalDurationDays,
          payout_frequency_days: input.payoutFrequencyDays,
          payout_currency: input.payoutCurrency.trim().toUpperCase(),
          minimum_payout_minor: input.minimumPayoutMinor,
        },
        mapAdminAgreement,
        {
          conflict: 'An agreement version with those details already exists.',
          invalidInput: 'Check the agreement terms and selected partner.',
          invalidReference: 'The selected partner or product is no longer available.',
        },
      )
    },

    async createCommissionRule(input) {
      if (!client) return notConfigured<AdminCommissionRule | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createCommissionRule,
        {
          agreement_id: input.agreementId,
          name: input.name.trim(),
          model: input.model,
          trigger_event: input.triggerEvent.trim().toLowerCase(),
          fixed_amount_minor: input.fixedAmountMinor,
          rate_basis_points: input.rateBasisPoints,
          currency: input.currency?.trim().toUpperCase() ?? null,
          validation_window_hours: input.validationWindowHours,
        },
        mapAdminCommissionRule,
        {
          conflict: 'That commission rule version already exists.',
          invalidInput: 'Check the commission model, value, currency, and trigger event.',
          invalidReference: 'The selected agreement is no longer available.',
        },
      )
    },

    async setCommissionRuleStatus(input) {
      if (!client) return notConfigured<AdminCommissionRule | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.setCommissionRuleStatus,
        { commission_rule_id: input.commissionRuleId, status: input.status },
        mapAdminCommissionRule,
        { invalidState: 'The commission rule cannot move to that status yet.' },
      )
    },

    async activateAgreement(input) {
      if (!client) return notConfigured<AdminAgreement | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.activateAgreement,
        { agreement_id: input.agreementId },
        mapAdminAgreement,
        { invalidState: 'Activate at least one compatible commission rule first.' },
      )
    },

    async activateProduct(input) {
      if (!client) return notConfigured<AdminProduct | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.activateProduct,
        { product_id: input.productId },
        mapAdminProduct,
        { invalidState: 'Complete every production activation check first.' },
      )
    },

    async issueMainLink(input) {
      if (!client) return notConfigured<AdminMainLink | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.issueMainLink,
        { affiliate_id: input.affiliateId, product_id: input.productId },
        mapAdminMainLink,
        {
          conflict: 'This partner already has a canonical main link for the product.',
          invalidState: 'The product, default funnel, partner terms, and tracking must be active.',
        },
      )
    },

    async createBillingOffer(input) {
      if (!client) return notConfigured<AdminBillingOffer | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.createBillingOffer,
        {
          product_id: input.productId,
          key: input.key.trim().toLowerCase(),
          name: input.name.trim(),
          billing_mode: input.billingMode,
          stripe_price_id: input.stripePriceId?.trim() || null,
          currency: input.currency?.trim().toUpperCase() || null,
          unit_amount_minor: input.unitAmountMinor,
          success_url_template: input.successUrlTemplate?.trim() || null,
          cancel_url: input.cancelUrl?.trim() || null,
        },
        mapAdminBillingOffer,
        {
          conflict: 'That billing-offer version already exists.',
          invalidInput: 'Check the offer terms, exact minor-unit amount, and production URLs.',
          invalidReference: 'The selected product is no longer available.',
        },
      )
    },

    async updateBillingOffer(input) {
      if (!client) return notConfigured<AdminBillingOffer | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.updateBillingOffer,
        {
          billing_offer_id: input.billingOfferId,
          name: input.name.trim(),
          billing_mode: input.billingMode,
          stripe_price_id: input.stripePriceId?.trim() || null,
          currency: input.currency?.trim().toUpperCase() || null,
          unit_amount_minor: input.unitAmountMinor,
          success_url_template: input.successUrlTemplate?.trim() || null,
          cancel_url: input.cancelUrl?.trim() || null,
        },
        mapAdminBillingOffer,
        {
          invalidInput: 'Check the offer terms, exact minor-unit amount, and production URLs.',
          invalidReference: 'That billing offer is no longer available.',
          invalidState: 'Only draft billing-offer terms can be edited.',
        },
      )
    },

    async setBillingOfferStatus(input) {
      if (!client) return notConfigured<AdminBillingOffer | null>(() => null)
      return mappedMutation(
        client,
        ADMIN_RPCS.setBillingOfferStatus,
        { billing_offer_id: input.billingOfferId, status: input.status },
        mapAdminBillingOffer,
        {
          conflict: 'Another version of this billing offer is already active.',
          invalidReference: 'That billing offer is no longer available.',
          invalidState:
            'Activation requires an active product and an exact, live-verified subscription Price.',
        },
      )
    },

    async verifyBillingOfferPrice(input) {
      if (!client) return notConfigured<AdminBillingOfferVerification | null>(() => null)
      if (!client.functions) {
        return result<AdminBillingOfferVerification | null>(null, 'unconfigured', {
          code: 'contract_unavailable',
          message: 'Live Stripe Price verification is not available yet.',
          retryable: false,
        })
      }
      let response: AdminEdgeFunctionResponse
      try {
        response = await client.functions.invoke(ADMIN_EDGE_FUNCTIONS.verifyBillingOfferPrice, {
          body: { billing_offer_id: input.billingOfferId },
        })
      } catch {
        return result<AdminBillingOfferVerification | null>(null, 'error', {
          code: 'temporarily_unavailable',
          message: 'Live Stripe Price verification is temporarily unavailable.',
          retryable: true,
        })
      }
      if (response.error) {
        return edgeFailure<AdminBillingOfferVerification | null>(response, () => null)
      }
      try {
        return result<AdminBillingOfferVerification | null>(
          mapBillingOfferVerification(response.data, input.billingOfferId),
          'ready',
        )
      } catch {
        return invalidResponse<AdminBillingOfferVerification | null>(() => null)
      }
    },
  }
}

export const adminGateway = createAdminGateway()
