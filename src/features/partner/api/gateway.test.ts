import { describe, expect, it } from 'vitest'
import { PARTNER_COLUMNS, PARTNER_RPCS, PARTNER_VIEWS } from './contract'
import { createPartnerDataGateway } from './gateway'
import type { PartnerQueryBuilder, PartnerSupabaseClient } from './gateway'

type TestResponse = {
  data: unknown
  error: { code?: string; message?: string; status?: number } | null
  status?: number
}

type RecordedCall = {
  target: string
  operation: string
  args: readonly unknown[]
}

function ok(data: unknown): TestResponse {
  return { data, error: null, status: 200 }
}

function builder(target: string, response: TestResponse, calls: RecordedCall[]) {
  const query = {
    select(columns: string) {
      calls.push({ target, operation: 'select', args: [columns] })
      return query
    },
    eq(column: string, value: string) {
      calls.push({ target, operation: 'eq', args: [column, value] })
      return query
    },
    order(column: string, options?: { ascending?: boolean }) {
      calls.push({ target, operation: 'order', args: [column, options] })
      return query
    },
    maybeSingle() {
      calls.push({ target, operation: 'maybeSingle', args: [] })
      return query
    },
    then(
      onfulfilled?: ((value: TestResponse) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) {
      return Promise.resolve(response).then(onfulfilled, onrejected)
    },
  }
  return query as unknown as PartnerQueryBuilder
}

function mockClient({
  views = {},
  rpcs = {},
}: {
  views?: Record<string, TestResponse>
  rpcs?: Record<string, TestResponse>
}) {
  const calls: RecordedCall[] = []
  const client: PartnerSupabaseClient = {
    from(relation) {
      calls.push({ target: relation, operation: 'from', args: [] })
      return builder(relation, views[relation] ?? ok([]), calls)
    },
    rpc(functionName, args) {
      calls.push({ target: functionName, operation: 'rpc', args: [args] })
      return Promise.resolve(rpcs[functionName] ?? ok([]))
    },
  }
  return { client, calls }
}

const notifications = {
  statements: true,
  payouts: true,
  verification: true,
  signatures: false,
  adjustments: true,
  inactive_links: false,
}

const profileRow = {
  email: 'partner@example.test',
  full_name: 'Partner Person',
  public_name: 'Partner Studio',
  legal_name: 'Partner Studio Ltd',
  entity_type: 'Company',
  country_code: 'NG',
  timezone: 'Africa/Lagos',
  preferred_currency: 'USD',
  website: 'https://partner.example.test',
  category: 'Technology',
  audience_description: 'A technology audience.',
  audience_countries: ['Nigeria'],
  channels: ['Newsletter'],
  channel_details: 'Weekly newsletter',
  role: 'owner',
  status: 'active',
  notifications,
}

const productRow = {
  id: 'product-1',
  slug: 'first-product',
  name: 'First product',
  status: 'active',
  agreement_status: 'active',
  commercial_model: 'revenue_share',
  payout_currency: 'USD',
  has_live_funnel: true,
  main_tracking_url: 'https://go.example.test/r/trusted-main',
}

const linkRow = {
  id: 'link-1',
  name: 'Newsletter link',
  product_id: 'product-1',
  product_name: 'First product',
  product_slug: 'first-product',
  funnel_id: 'funnel-1',
  funnel_name: 'Main funnel',
  source_id: 'source-1',
  source_name: 'Newsletter',
  campaign_id: null,
  campaign_name: null,
  sub1: 'weekly',
  sub2: '',
  sub3: '',
  status: 'active',
  tracking_url: 'https://go.example.test/r/trusted-link',
  parent_link_id: null,
  clicks: 0,
  leads: 0,
  installs: null,
  purchases: 0,
  earnings_minor: 0,
  currency: 'USD',
  created_at: '2026-08-27T10:00:00Z',
}

const payoutRow = {
  id: 'payout-1',
  product_name: 'First product',
  period_starts_at: '2026-08-01T00:00:00Z',
  period_ends_at: '2026-08-14T23:59:59Z',
  expected_payment_at: null,
  status: 'open',
  eligible_net_minor: 0,
  earnings_minor: 0,
  adjustments_minor: 0,
  final_payout_minor: 0,
  currency: 'USD',
  statement_number: null,
  statement_available: false,
  payment_method: null,
  payment_reference: null,
  paid_at: null,
}

describe('partner Supabase data gateway', () => {
  it('returns explicit unconfigured zero states without making a request', async () => {
    const gateway = createPartnerDataGateway(null)

    await expect(gateway.getCurrentPartnerProfile()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured' },
    })
    await expect(gateway.getProducts()).resolves.toMatchObject({
      data: [],
      status: 'unconfigured',
    })
    const summary = await gateway.getDashboardSummary({
      startsOn: '2026-08-01',
      endsOn: '2026-08-27',
      timezone: 'UTC',
    })
    expect(summary).toMatchObject({ status: 'unconfigured', data: { hasData: false } })
    expect(summary.data.metrics.earningsMinor).toBeNull()
  })

  it('keeps a configured account with no products distinct from an error', async () => {
    const { client } = mockClient({
      views: {
        [PARTNER_VIEWS.products]: ok([]),
        [PARTNER_VIEWS.linkOptions]: ok([]),
      },
    })
    const result = await createPartnerDataGateway(client).getLinkDirectory()

    expect(result).toEqual({
      data: { products: [], funnels: [], sources: [], campaigns: [] },
      status: 'empty',
      error: null,
    })
  })

  it('maps the current profile and never requests unallowlisted columns', async () => {
    const { client, calls } = mockClient({
      views: { [PARTNER_VIEWS.profile]: ok(profileRow) },
    })
    const result = await createPartnerDataGateway(client).getCurrentPartnerProfile()

    expect(result).toMatchObject({
      status: 'ready',
      data: {
        email: 'partner@example.test',
        publicName: 'Partner Studio',
        role: 'owner',
        notifications: { inactiveLinks: false },
      },
    })
    expect(calls).toContainEqual({
      target: PARTNER_VIEWS.profile,
      operation: 'select',
      args: [PARTNER_COLUMNS.profile],
    })
    const selectedColumns = Object.values(PARTNER_COLUMNS).join(',')
    expect(selectedColumns).not.toMatch(
      /internal_note|source_key|file_path|funnel_url|provider_payload|customer_id/,
    )
  })

  it('maps authorization errors to safe UI messages without leaking backend details', async () => {
    const { client } = mockClient({
      views: {
        [PARTNER_VIEWS.profile]: {
          data: null,
          error: { code: '42501', message: 'secret policy and relation details' },
          status: 403,
        },
      },
    })
    const result = await createPartnerDataGateway(client).getCurrentPartnerProfile()

    expect(result).toEqual({
      data: null,
      status: 'error',
      error: {
        code: 'not_authorized',
        message: 'This partner account cannot access that data.',
        retryable: false,
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret policy')
  })

  it('rejects malformed backend rows instead of presenting invented data', async () => {
    const { client } = mockClient({
      views: { [PARTNER_VIEWS.products]: ok([{ ...productRow, has_live_funnel: 'yes' }]) },
    })
    const result = await createPartnerDataGateway(client).getProducts()

    expect(result).toEqual({
      data: [],
      status: 'error',
      error: {
        code: 'invalid_response',
        message: 'Partner data is temporarily unavailable.',
        retryable: false,
      },
    })
  })

  it('maps products, options and trusted links while preserving unavailable installs', async () => {
    const { client, calls } = mockClient({
      views: {
        [PARTNER_VIEWS.products]: ok([productRow]),
        [PARTNER_VIEWS.linkOptions]: ok([
          {
            id: 'funnel-1',
            kind: 'funnel',
            product_id: 'product-1',
            key: 'main',
            name: 'Main funnel',
            available: true,
          },
          {
            id: 'source-1',
            kind: 'source',
            product_id: null,
            key: 'newsletter',
            name: 'Newsletter',
            available: true,
          },
        ]),
        [PARTNER_VIEWS.links]: ok([linkRow]),
      },
    })
    const gateway = createPartnerDataGateway(client)

    await expect(gateway.getLinkDirectory()).resolves.toMatchObject({
      status: 'ready',
      data: {
        products: [{ id: 'product-1', mainTrackingUrl: productRow.main_tracking_url }],
        funnels: [{ id: 'funnel-1' }],
        sources: [{ id: 'source-1' }],
        campaigns: [],
      },
    })
    await expect(gateway.getPartnerLinks('product-1')).resolves.toMatchObject({
      status: 'ready',
      data: [{ trackingUrl: linkRow.tracking_url, installs: null }],
    })
    expect(calls).toContainEqual({
      target: PARTNER_VIEWS.links,
      operation: 'eq',
      args: ['product_id', 'product-1'],
    })
  })

  it('calls tenant-derived link RPCs with allowlisted JSON payloads', async () => {
    const { client, calls } = mockClient({
      rpcs: {
        [PARTNER_RPCS.createLink]: ok(linkRow),
        [PARTNER_RPCS.updateLink]: ok({ ...linkRow, name: 'Updated' }),
        [PARTNER_RPCS.setLinkStatus]: ok({ ...linkRow, status: 'archived' }),
      },
    })
    const gateway = createPartnerDataGateway(client)
    await gateway.createPartnerLink({
      name: 'Newsletter link',
      productId: 'product-1',
      funnelId: 'funnel-1',
      sourceId: 'source-1',
      campaignId: null,
      sub1: 'weekly',
      sub2: '',
      sub3: '',
    })
    await gateway.updatePartnerLink('link-1', { name: 'Updated' })
    await gateway.setPartnerLinkStatus('link-1', 'archived')

    expect(calls.filter((call) => call.operation === 'rpc')).toEqual([
      {
        target: PARTNER_RPCS.createLink,
        operation: 'rpc',
        args: [
          {
            p_input: {
              name: 'Newsletter link',
              product_id: 'product-1',
              funnel_id: 'funnel-1',
              source_id: 'source-1',
              campaign_id: null,
              sub1: 'weekly',
              sub2: '',
              sub3: '',
              parent_link_id: null,
            },
          },
        ],
      },
      {
        target: PARTNER_RPCS.updateLink,
        operation: 'rpc',
        args: [{ p_link_id: 'link-1', p_patch: { name: 'Updated' } }],
      },
      {
        target: PARTNER_RPCS.setLinkStatus,
        operation: 'rpc',
        args: [{ p_link_id: 'link-1', p_status: 'archived' }],
      },
    ])
    expect(JSON.stringify(calls)).not.toContain('affiliate_id')
  })

  it('maps reporting, payouts, documents, agreements and profile updates', async () => {
    const metricRow = {
      clicks: 0,
      visitors: null,
      funnel_starts: 0,
      payment_views: 0,
      app_store_clicks: 0,
      leads: 0,
      trials: 0,
      installs: null,
      purchases: 0,
      activations: 0,
      renewals: 0,
      cancellations: 0,
      refunds: 0,
      disputes: 0,
      gross_collected_minor: 0,
      eligible_revenue_minor: 0,
      earnings_minor: 0,
      active_subscriptions: 0,
    }
    const { client } = mockClient({
      views: {
        [PARTNER_VIEWS.payoutSummary]: ok({
          currency: 'USD',
          open_minor: 0,
          approved_minor: 0,
          scheduled_minor: 0,
          paid_minor: 0,
          carried_forward_minor: 0,
          next_expected_payment_at: null,
        }),
        [PARTNER_VIEWS.payoutHistory]: ok([payoutRow]),
        [PARTNER_VIEWS.documents]: ok([
          {
            id: 'document-1',
            name: 'Partner agreement',
            document_type: 'Partnership Agreement',
            version: 1,
            status: 'active',
            created_at: '2026-08-01T00:00:00Z',
            effective_at: '2026-08-02T00:00:00Z',
            expires_at: null,
            terminated_at: null,
            partner_signed_at: '2026-08-01T10:00:00Z',
            company_signed_at: '2026-08-01T11:00:00Z',
            supersedes_document_id: null,
            superseded_by_document_id: null,
            download_available: true,
          },
        ]),
        [PARTNER_VIEWS.agreements]: ok([
          {
            product_id: 'product-1',
            product_name: 'First product',
            version: 1,
            status: 'active',
            model: 'revenue_share',
            starts_at: '2026-08-01T00:00:00Z',
            ends_at: null,
            attribution_window_days: 30,
            renewal_duration_days: null,
            payout_frequency_days: 14,
            payout_currency: 'USD',
            minimum_payout_minor: 10000,
            rules: [
              {
                name: 'Revenue share',
                model: 'revenue_share',
                trigger_event: 'purchase',
                fixed_amount_minor: null,
                rate_basis_points: 3000,
                currency: 'USD',
              },
            ],
          },
        ]),
      },
      rpcs: {
        [PARTNER_RPCS.dashboardSummary]: ok({
          starts_on: '2026-08-01',
          ends_on: '2026-08-27',
          timezone: 'UTC',
          currency: 'USD',
          has_data: false,
          reconciliation_stage: null,
          reconciled_through: null,
          ...metricRow,
        }),
        [PARTNER_RPCS.dashboardTrends]: ok([
          {
            bucket_start: '2026-08-01',
            bucket_end: '2026-08-01',
            dimension_key: '2026-08-01',
            dimension_label: 'Aug 1',
            reconciliation_stage: null,
            ...metricRow,
          },
        ]),
        [PARTNER_RPCS.payoutDetail]: ok({
          ...payoutRow,
          agreement_version: 1,
          agreement_label: 'Partner agreement v1',
          commercial_model: 'revenue_share',
          minimum_payout_minor: 10000,
          payout_frequency_days: 14,
          calculation: [
            { key: 'gross', label: 'Gross verified payments', amount_minor: 0, note: 'None yet.' },
          ],
          history: [
            { occurred_at: '2026-08-01T00:00:00Z', label: 'Period opened', amount_minor: null },
          ],
        }),
        [PARTNER_RPCS.updateProfile]: ok(profileRow),
        [PARTNER_RPCS.updateSettings]: ok(profileRow),
      },
    })
    const gateway = createPartnerDataGateway(client)
    const query = {
      productId: 'product-1',
      startsOn: '2026-08-01',
      endsOn: '2026-08-27',
      timezone: 'UTC',
    }

    await expect(gateway.getDashboardSummary(query)).resolves.toMatchObject({
      status: 'ready',
      data: { hasData: false, metrics: { visitors: null, clicks: 0 } },
    })
    await expect(
      gateway.getDashboardTrends({ ...query, grain: 'day', breakdown: 'date' }),
    ).resolves.toMatchObject({ data: [{ dimensionKey: '2026-08-01' }] })
    await expect(gateway.getPayoutSummary('product-1')).resolves.toMatchObject({
      data: { currency: 'USD', openMinor: 0 },
    })
    await expect(gateway.getPayoutHistory()).resolves.toMatchObject({
      data: [{ id: 'payout-1', statementAvailable: false }],
    })
    await expect(gateway.getPayoutDetail('payout-1')).resolves.toMatchObject({
      data: { agreementVersion: 1, calculation: [{ key: 'gross' }] },
    })
    await expect(gateway.getDocuments()).resolves.toMatchObject({
      data: [{ id: 'document-1', downloadAvailable: true }],
    })
    await expect(gateway.getAgreements()).resolves.toMatchObject({
      data: [{ version: 1, rules: [{ rateBasisPoints: 3000 }] }],
    })
    await expect(
      gateway.updatePartnerProfile({
        fullName: 'Partner Person',
        publicName: 'Partner Studio',
        legalName: 'Partner Studio Ltd',
        entityType: 'Company',
        countryCode: 'NG',
        timezone: 'Africa/Lagos',
        preferredCurrency: 'USD',
        website: null,
        category: null,
        audienceDescription: null,
        audienceCountries: [],
        channels: [],
        channelDetails: null,
      }),
    ).resolves.toMatchObject({ data: { publicName: 'Partner Studio' } })
    await expect(
      gateway.updatePartnerSettings({
        notifications: {
          statements: true,
          payouts: true,
          verification: true,
          signatures: false,
          adjustments: true,
          inactiveLinks: false,
        },
      }),
    ).resolves.toMatchObject({ data: { notifications: { inactiveLinks: false } } })
  })

  it('does not query or combine payout money without a selected product', async () => {
    const { client, calls } = mockClient({
      views: {
        [PARTNER_VIEWS.payoutSummary]: ok([
          { currency: 'USD', open_minor: 100 },
          { currency: 'EUR', open_minor: 200 },
        ]),
      },
    })

    await expect(createPartnerDataGateway(client).getPayoutSummary(null)).resolves.toEqual({
      data: {
        currency: null,
        openMinor: null,
        approvedMinor: null,
        scheduledMinor: null,
        paidMinor: null,
        carriedForwardMinor: null,
        nextExpectedPaymentAt: null,
      },
      status: 'empty',
      error: null,
    })
    expect(calls).toEqual([])
  })

  it('does not query or combine reporting money without a selected product', async () => {
    const { client, calls } = mockClient({
      rpcs: {
        [PARTNER_RPCS.dashboardSummary]: ok({ earnings_minor: 300 }),
        [PARTNER_RPCS.dashboardTrends]: ok([{ earnings_minor: 300 }]),
      },
    })
    const gateway = createPartnerDataGateway(client)
    const query = { startsOn: '2026-08-01', endsOn: '2026-08-27', timezone: 'UTC' }

    await expect(gateway.getDashboardSummary(query)).resolves.toMatchObject({
      status: 'empty',
      data: { currency: null, hasData: false, metrics: { earningsMinor: null } },
    })
    await expect(
      gateway.getDashboardTrends({ ...query, grain: 'day', breakdown: 'date' }),
    ).resolves.toEqual({ data: [], status: 'empty', error: null })
    expect(calls).toEqual([])
  })
})
