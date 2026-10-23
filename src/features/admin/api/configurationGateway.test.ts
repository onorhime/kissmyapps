import { describe, expect, it, vi } from 'vitest'
import { mapAdminBillingOffer, mapAdminMainLink } from './configurationMappers'
import { ADMIN_EDGE_FUNCTIONS, ADMIN_RPCS, createAdminGateway } from './gateway'
import type { AdminBackendResponse, AdminEdgeFunctionResponse, AdminSupabaseClient } from './types'

const product = {
  id: 'product-1',
  slug: 'daily-planner',
  name: 'Daily Planner',
  status: 'draft',
  created_at: '2026-08-28T10:00:00.000Z',
  updated_at: '2026-08-28T10:00:00.000Z',
}

function client(response: AdminBackendResponse) {
  const rpc = vi.fn(async (_functionName: string, _args?: Record<string, unknown>) => response)
  return { value: { rpc } satisfies AdminSupabaseClient, rpc }
}

function clientWithFunctions(response: AdminEdgeFunctionResponse) {
  const rpc = vi.fn(async () => ({ data: null, error: null, status: 200 }))
  const invoke = vi.fn(async () => response)
  return {
    value: { rpc, functions: { invoke } } satisfies AdminSupabaseClient,
    rpc,
    invoke,
  }
}

describe('admin configuration RPC gateway', () => {
  it('publishes every required server RPC name', () => {
    expect(ADMIN_RPCS).toMatchObject({
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
      setProductTrackingMode: 'set_admin_product_tracking_mode',
      issueMainLink: 'issue_admin_main_link',
      createBillingOffer: 'create_admin_billing_offer',
      updateBillingOffer: 'update_admin_billing_offer',
      setBillingOfferStatus: 'set_admin_billing_offer_status',
    })
    expect(ADMIN_EDGE_FUNCTIONS).toEqual({
      verifyBillingOfferPrice: 'stripe-price-verifier',
      verifyManagedBillingOfferPrice: 'managed-price-verifier',
    })
  })

  it('sends an exact timestamp-guarded product tracking-mode mutation', async () => {
    const responseProduct = {
      ...product,
      tracking_mode: 'tracking_only',
      tracking_only_approved_at: '2026-09-01T12:00:00.000Z',
      updated_at: '2026-09-01T12:00:00.000Z',
    }
    const rpcClient = client({ data: responseProduct, error: null, status: 200 })
    const gateway = createAdminGateway(rpcClient.value)

    const result = await gateway.setProductTrackingMode?.({
      productId: product.id,
      mode: 'tracking_only',
      expectedUpdatedAt: product.updated_at,
    })

    expect(rpcClient.rpc).toHaveBeenCalledWith('set_admin_product_tracking_mode', {
      p_input: {
        product_id: product.id,
        mode: 'tracking_only',
        expected_updated_at: product.updated_at,
      },
    })
    expect(result).toMatchObject({
      status: 'ready',
      data: {
        trackingMode: 'tracking_only',
        trackingOnlyApprovedAt: '2026-09-01T12:00:00.000Z',
      },
    })
  })

  it('maps a known-empty production configuration as ready', async () => {
    const rpcClient = client({
      data: {
        product,
        tracking: { enabled: false, base_url: null },
        readiness: {
          has_live_default_funnel: false,
          has_active_agreement: false,
          has_active_billing_offer: false,
          tracking_ready: false,
          tracking_only_ready: false,
          tracking_only_can_issue_links: false,
        },
        funnels: [],
        campaigns: [],
        agreements: [],
        billing_offers: [],
        main_links: [],
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).getProductConfiguration?.('product-1')

    expect(rpcClient.rpc).toHaveBeenCalledWith('get_admin_product_configuration', {
      p_product_id: 'product-1',
    })
    expect(result).toMatchObject({
      status: 'ready',
      data: {
        tracking: { enabled: false, baseUrl: null },
        readiness: {
          trackingReady: false,
          hasActiveBillingOffer: false,
          managedPaymentCheckoutEnabled: false,
        },
        funnels: [],
        agreements: [],
      },
    })
  })

  it('maps managed one-time checkout opt-in separately from subscription launch readiness', async () => {
    const rpcClient = client({
      data: {
        product,
        tracking: { enabled: false, base_url: null },
        readiness: {
          has_live_default_funnel: false,
          has_active_agreement: false,
          has_active_billing_offer: false,
          tracking_ready: false,
          tracking_only_ready: false,
          tracking_only_can_issue_links: false,
          managed_payment_checkout_enabled: true,
        },
        funnels: [],
        campaigns: [],
        agreements: [],
        billing_offers: [],
        main_links: [],
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).getProductConfiguration?.('product-1')

    expect(result).toMatchObject({
      status: 'ready',
      data: {
        readiness: {
          managedPaymentCheckoutEnabled: true,
          hasActiveBillingOffer: false,
          trackingReady: false,
        },
      },
    })
  })

  it('maps an explicitly configured funnel when its protected destination is redacted', async () => {
    const rpcClient = client({
      data: {
        product,
        tracking: { enabled: false, base_url: null },
        readiness: {
          has_live_default_funnel: false,
          has_active_agreement: false,
          has_active_billing_offer: false,
          tracking_ready: false,
          tracking_only_ready: false,
          tracking_only_can_issue_links: false,
        },
        funnels: [
          {
            id: 'funnel-1',
            product_id: product.id,
            key: 'checkout',
            name: 'Checkout',
            destination_configured: true,
            is_default: true,
            status: 'draft',
            created_at: product.created_at,
            updated_at: product.updated_at,
          },
        ],
        campaigns: [],
        agreements: [],
        billing_offers: [],
        main_links: [],
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).getProductConfiguration?.('product-1')

    expect(result).toMatchObject({
      status: 'ready',
      data: {
        funnels: [{ destinationConfigured: true, destinationUrl: null }],
      },
    })
  })

  it('maps signed-agreement and verified-billing launch gates from the server contract', async () => {
    const rpcClient = client({
      data: {
        product: { ...product, status: 'active' },
        tracking: { enabled: true, base_url: 'https://go.example.test' },
        readiness: {
          has_live_default_funnel: true,
          has_active_agreement: true,
          has_active_billing_offer: true,
          tracking_ready: true,
          tracking_only_ready: false,
          tracking_only_can_issue_links: false,
        },
        funnels: [],
        campaigns: [],
        agreements: [
          {
            id: 'agreement-1',
            affiliate_id: 'affiliate-1',
            product_id: product.id,
            version: 1,
            model: 'cpa',
            status: 'active',
            attribution_window_days: 30,
            renewal_duration_days: null,
            payout_frequency_days: 14,
            payout_currency: 'USD',
            minimum_payout_minor: 10000,
            starts_at: product.created_at,
            ends_at: null,
            created_at: product.created_at,
            updated_at: product.updated_at,
            partner_name: 'Creator Studio',
            partner_slug: 'creator-studio',
            has_signed_document: true,
            launch_ready: true,
            commission_rules: [
              {
                id: 'rule-1',
                agreement_id: 'agreement-1',
                name: 'Paid purchase',
                version: 1,
                status: 'active',
                model: 'cpa',
                trigger_event: 'purchase.completed',
                fixed_amount_minor: 2500,
                rate_basis_points: null,
                currency: 'USD',
                validation_window_hours: 72,
                created_at: product.created_at,
                updated_at: product.updated_at,
              },
            ],
          },
        ],
        billing_offers: [
          {
            id: 'offer-1',
            product_id: product.id,
            key: 'monthly',
            version: 1,
            name: 'Monthly subscription',
            billing_mode: 'subscription',
            stripe_price_id: 'price_abcdefgh1234',
            currency: 'USD',
            unit_amount_minor: 1999,
            success_url_template:
              'https://app.example.test/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'https://app.example.test/checkout',
            status: 'active',
            stripe_price_verified: true,
            stripe_livemode_verified_at: product.updated_at,
            created_at: product.created_at,
            updated_at: product.updated_at,
          },
        ],
        main_links: [
          {
            id: 'link-1',
            affiliate_id: 'affiliate-1',
            partner_name: 'Creator Studio',
            product_id: product.id,
            funnel_id: 'funnel-1',
            name: 'Daily Planner · Main',
            public_code: 'abcdefghijklmnop',
            tracking_url: 'https://go.example.test/r/partner/abcdefghijklmnop',
            status: 'active',
            created_at: product.created_at,
          },
        ],
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).getProductConfiguration?.('product-1')

    expect(result).toMatchObject({
      status: 'ready',
      data: {
        readiness: { hasActiveBillingOffer: true },
        agreements: [{ hasSignedDocument: true, launchReady: true }],
        billingOffers: [
          {
            status: 'active',
            billingMode: 'subscription',
            stripePriceVerified: true,
          },
        ],
        mainLinks: [{ partnerName: 'Creator Studio' }],
      },
    })
  })

  it('sends status changes as one exact JSON payload', async () => {
    const rpcClient = client({
      data: {
        id: 'funnel-1',
        product_id: 'product-1',
        key: 'checkout',
        name: 'Checkout',
        destination_url: 'https://example.test/checkout',
        is_default: true,
        status: 'live',
        created_at: '2026-08-28T10:00:00.000Z',
        updated_at: '2026-08-28T10:00:00.000Z',
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).setFunnelStatus?.({
      funnelId: 'funnel-1',
      status: 'live',
    })

    expect(rpcClient.rpc).toHaveBeenCalledWith('set_admin_funnel_status', {
      p_input: { funnel_id: 'funnel-1', status: 'live' },
    })
    expect(result?.data).toMatchObject({
      destinationConfigured: true,
      destinationUrl: 'https://example.test/checkout',
    })
  })

  it('issues a canonical main link without funnel, destination, or tracking dimensions', async () => {
    const rpcClient = client({
      data: {
        id: 'link-1',
        affiliate_id: 'affiliate-1',
        partner_name: 'Creator Studio',
        product_id: 'product-1',
        funnel_id: 'funnel-1',
        name: 'Daily Planner · Main',
        public_code: 'abcdefghijklmnop',
        tracking_url: 'https://go.example.test/r/partner/abcdefghijklmnop',
        status: 'active',
        created_at: '2026-08-28T10:00:00.000Z',
      },
      error: null,
      status: 200,
    })

    const result = await createAdminGateway(rpcClient.value).issueMainLink?.({
      affiliateId: 'affiliate-1',
      productId: 'product-1',
    })

    const payload = rpcClient.rpc.mock.calls[0]?.[1] as { p_input: Record<string, unknown> }
    expect(payload).toEqual({
      p_input: { affiliate_id: 'affiliate-1', product_id: 'product-1', environment: 'live' },
    })
    expect(Object.keys(payload.p_input)).toEqual(['affiliate_id', 'product_id', 'environment'])
    expect(result?.data).toMatchObject({ partnerName: 'Creator Studio' })
  })

  it('sends the selected TEST environment and preserves the server-owned readable test URL', async () => {
    const rpcClient = client({
      data: {
        id: 'test-link-1',
        affiliate_id: 'affiliate-1',
        product_id: 'product-1',
        funnel_id: 'funnel-1',
        environment: 'test',
        status: 'active',
        tracking_url: 'https://go.example.test/r/partner/server-code',
        short_url: 'https://go.example.test/product/creator/test',
        created_at: '2026-10-22T10:00:00.000Z',
      },
      error: null,
      status: 200,
    })
    const result = await createAdminGateway(rpcClient.value).issueMainLink?.({
      affiliateId: 'affiliate-1',
      productId: 'product-1',
      environment: 'test',
    })
    expect(rpcClient.rpc).toHaveBeenCalledExactlyOnceWith('issue_admin_main_link', {
      p_input: { affiliate_id: 'affiliate-1', product_id: 'product-1', environment: 'test' },
    })
    expect(result?.data).toMatchObject({
      environment: 'test',
      trackingUrl: 'https://go.example.test/product/creator/test',
    })
  })

  it('sanitizes lifecycle failures instead of returning database wording', async () => {
    const rpcClient = client({
      data: null,
      error: { code: 'P0001', message: 'raw table, status, and policy details' },
      status: 400,
    })

    const result = await createAdminGateway(rpcClient.value).activateProduct?.({
      productId: 'product-1',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'invalid_state',
        message: 'Complete every production activation check first.',
        retryable: false,
      },
    })
    expect(result?.error?.message).not.toContain('raw table')
  })

  it('sends only browser-safe billing configuration fields', async () => {
    const rpcClient = client({
      data: {
        id: 'offer-1',
        product_id: 'product-1',
        key: 'monthly',
        version: 1,
        name: 'Monthly',
        billing_mode: 'subscription',
        stripe_price_id: 'price_abcdefgh1234',
        currency: 'USD',
        unit_amount_minor: 1999,
        success_url_template: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.kissmyapps.dev/checkout',
        status: 'draft',
        stripe_price_verified: false,
        stripe_livemode_verified_at: null,
        created_at: '2026-08-28T10:00:00.000Z',
        updated_at: '2026-08-28T10:00:00.000Z',
      },
      error: null,
      status: 200,
    })

    await createAdminGateway(rpcClient.value).createBillingOffer?.({
      productId: 'product-1',
      key: 'monthly',
      name: 'Monthly',
      billingMode: 'subscription',
      stripePriceId: 'price_abcdefgh1234',
      currency: 'usd',
      unitAmountMinor: 1999,
      successUrlTemplate: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.kissmyapps.dev/checkout',
    })

    const payload = rpcClient.rpc.mock.calls[0]?.[1] as { p_input: Record<string, unknown> }
    expect(payload).toEqual({
      p_input: {
        product_id: 'product-1',
        key: 'monthly',
        name: 'Monthly',
        billing_mode: 'subscription',
        stripe_price_id: 'price_abcdefgh1234',
        currency: 'USD',
        unit_amount_minor: 1999,
        success_url_template: 'https://app.kissmyapps.dev/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.kissmyapps.dev/checkout',
      },
    })
    expect(JSON.stringify(payload)).not.toMatch(/secret|livemode|verified|commission|earnings/i)
  })

  it('invokes live Price verification with only the billing-offer ID', async () => {
    const rpcClient = clientWithFunctions({
      data: {
        verified: true,
        billing_offer_id: '11111111-1111-4111-8111-111111111111',
        request_id: 'request-1',
      },
      error: null,
    })

    const result = await createAdminGateway(rpcClient.value).verifyBillingOfferPrice?.({
      billingOfferId: '11111111-1111-4111-8111-111111111111',
    })

    expect(rpcClient.invoke).toHaveBeenCalledWith('stripe-price-verifier', {
      body: { billing_offer_id: '11111111-1111-4111-8111-111111111111' },
    })
    expect(rpcClient.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({
      data: {
        verified: true,
        billingOfferId: '11111111-1111-4111-8111-111111111111',
        requestId: 'request-1',
      },
      status: 'ready',
      error: null,
    })
    expect(JSON.stringify(rpcClient.invoke.mock.calls[0])).not.toMatch(
      /stripe_price_id|currency|amount|livemode|secret/i,
    )
  })

  it('sanitizes verifier failures without exposing Edge or Stripe details', async () => {
    const rpcClient = clientWithFunctions({
      data: null,
      error: {
        message: 'raw Stripe mismatch with sk_live_sensitive and amount 1',
        context: { status: 400 },
      },
    })

    const result = await createAdminGateway(rpcClient.value).verifyBillingOfferPrice?.({
      billingOfferId: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'invalid_state', retryable: false },
    })
    expect(result?.error?.message).not.toMatch(/sk_live|amount 1|raw Stripe/i)
  })
})

it('sends and reads the canonical rule refund policy without a second settlement rate', async () => {
  const rpcClient = client({
    data: {
      id: 'rule-1',
      agreement_id: 'agreement-1',
      name: 'Signed share',
      version: 1,
      status: 'draft',
      model: 'revenue_share',
      trigger_event: 'purchase.completed',
      fixed_amount_minor: null,
      rate_basis_points: 1500,
      currency: null,
      validation_window_hours: 72,
      refund_cutoff_days: 30,
      commission_basis_policy: 'subtotal_ex_tax_shipping',
      created_at: product.created_at,
      updated_at: product.updated_at,
    },
    error: null,
    status: 200,
  })
  const result = await createAdminGateway(rpcClient.value).createCommissionRule?.({
    agreementId: 'agreement-1',
    name: 'Signed share',
    model: 'revenue_share',
    triggerEvent: 'purchase.completed',
    fixedAmountMinor: null,
    rateBasisPoints: 1500,
    currency: null,
    validationWindowHours: 72,
    refundCutoffDays: 30,
    commissionBasisPolicy: 'subtotal_ex_tax_shipping',
  })
  expect(rpcClient.rpc).toHaveBeenCalledWith('create_admin_commission_rule', {
    p_input: {
      agreement_id: 'agreement-1',
      name: 'Signed share',
      model: 'revenue_share',
      trigger_event: 'purchase.completed',
      fixed_amount_minor: null,
      rate_basis_points: 1500,
      currency: null,
      validation_window_hours: 72,
      refund_cutoff_days: 30,
      commission_basis_policy: 'subtotal_ex_tax_shipping',
    },
  })
  expect(result?.data).toMatchObject({
    refundCutoffDays: 30,
    commissionBasisPolicy: 'subtotal_ex_tax_shipping',
    validationWindowHours: 72,
  })
})
it('creates eligibility only as an explicit new canonical commission rule', async () => {
  const row = {
    id: 'rule-new',
    agreement_id: 'agreement-draft',
    name: 'First fulfilled purchase',
    version: 1,
    status: 'draft',
    model: 'revenue_share',
    trigger_event: 'purchase.completed',
    fixed_amount_minor: null,
    rate_basis_points: 2500,
    currency: null,
    validation_window_hours: 72,
    refund_cutoff_days: 30,
    commission_basis_policy: 'subtotal_ex_tax_shipping',
    policy_version: 3,
    first_purchase_only: true,
    fulfilment_required: true,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
  const c = client({ data: row, error: null, status: 200 })
  const result = await createAdminGateway(c.value).createCommissionRule?.({
    agreementId: 'agreement-draft',
    name: row.name,
    model: 'revenue_share',
    triggerEvent: 'purchase.completed',
    fixedAmountMinor: null,
    rateBasisPoints: 2500,
    currency: null,
    validationWindowHours: 72,
    refundCutoffDays: 30,
    commissionBasisPolicy: 'subtotal_ex_tax_shipping',
    firstPurchaseOnly: true,
    fulfilmentRequired: true,
  })
  expect(c.rpc).toHaveBeenCalledWith('create_admin_commission_rule', {
    p_input: expect.objectContaining({
      first_purchase_only: true,
      fulfilment_required: true,
      rate_basis_points: 2500,
      validation_window_hours: 72,
      refund_cutoff_days: 30,
    }),
  })
  expect(result?.data).toMatchObject({
    firstPurchaseOnly: true,
    fulfilmentRequired: true,
    validationWindowHours: 72,
    refundCutoffDays: 30,
  })
})

it('routes managed Price verification to the scoped verifier and validates its account and mode receipt', async () => {
  const receipt = {
    verified: true,
    billing_offer_id: 'offer-1',
    request_id: 'request-1',
    binding_id: 'marathon-test',
    stripe_price_id: 'price_ManagedFixture',
    account_id: 'acct_fixture',
    livemode: false,
  }
  const rpcClient = clientWithFunctions({ data: receipt, error: null })
  const request = {
    billingOfferId: 'offer-1',
    managed: { bindingId: 'marathon-test', stripePriceId: 'price_ManagedFixture' },
  }
  const response = await createAdminGateway(rpcClient.value).verifyBillingOfferPrice?.(request)
  expect(rpcClient.invoke).toHaveBeenCalledWith('managed-price-verifier', {
    body: {
      billing_offer_id: 'offer-1',
      binding_id: 'marathon-test',
      stripe_price_id: 'price_ManagedFixture',
    },
  })
  expect(response?.data?.managed).toEqual({
    bindingId: 'marathon-test',
    stripePriceId: 'price_ManagedFixture',
    accountId: 'acct_fixture',
    livemode: false,
  })
  const wrong = clientWithFunctions({ data: { ...receipt, binding_id: 'other' }, error: null })
  expect(
    (await createAdminGateway(wrong.value).verifyBillingOfferPrice?.(request))?.data,
  ).toBeNull()
})

describe('server-controlled one-time link readiness', () => {
  const offer = {
    id: 'offer-1',
    product_id: product.id,
    key: 'marathon',
    version: 1,
    name: 'Marathon',
    billing_mode: 'payment',
    stripe_price_id: 'price_MarathonCommercial',
    currency: 'USD',
    unit_amount_minor: 16900,
    success_url_template: 'https://marathon.speaksix.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://marathon.speaksix.com',
    status: 'active',
    stripe_price_verified: false,
    stripe_livemode_verified_at: null,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }

  it('requires an explicit server-ready flag and tolerates older mutation responses', () => {
    expect(mapAdminBillingOffer({ ...offer, main_link_ready: true }).mainLinkReady).toBe(true)
    expect(mapAdminBillingOffer({ ...offer, main_link_ready: false }).mainLinkReady).toBe(false)
    expect(mapAdminBillingOffer(offer).mainLinkReady).toBe(false)
  })

  it.each([null, 'true', 1])('rejects a malformed readiness flag: %s', (value) => {
    expect(() => mapAdminBillingOffer({ ...offer, main_link_ready: value })).toThrow()
  })
})

describe('readable admin creator links', () => {
  const link = {
    id: 'link-1',
    affiliate_id: 'affiliate-1',
    product_id: 'product-1',
    partner_name: 'Victory',
    funnel_id: 'funnel-1',
    name: 'Marathon',
    public_code: 'abcdefghijklmnop',
    tracking_url: 'https://go.example.test/r/partner/abcdefghijklmnop',
    status: 'active',
    created_at: '2026-10-18T10:00:00Z',
  }

  it('displays the server alias without changing attribution identity', () => {
    expect(
      mapAdminMainLink({
        ...link,
        short_url: 'https://go.kissmyapps.dev/speaksix-marathon/victory',
      }),
    ).toMatchObject({
      id: link.id,
      publicCode: link.public_code,
      trackingUrl: 'https://go.kissmyapps.dev/speaksix-marathon/victory',
    })
  })

  it('keeps the legacy link if an alias is unavailable', () => {
    expect(mapAdminMainLink(link).trackingUrl).toBe(link.tracking_url)
    expect(mapAdminMainLink({ ...link, short_url: null }).trackingUrl).toBe(link.tracking_url)
  })
})
