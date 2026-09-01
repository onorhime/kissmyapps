import { describe, expect, it, vi } from 'vitest'
import {
  mapAdminAffiliateDirectoryPage,
  mapAdminAffiliateDirectoryRecord,
  mapAdminAffiliateDirectorySummary,
  mapAdminAffiliateStatusChange,
} from './affiliateMappers'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import { hasAdminAffiliateManagementGateway } from './types'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'

const directoryRow = {
  id: '30000000-0000-0000-0000-000000000001',
  public_name: 'Victory King',
  legal_name: 'Victory King Media Ltd',
  slug: 'partner-victory',
  status: 'active',
  entity_type: 'company',
  country_code: 'NG',
  reporting_timezone: 'Africa/Lagos',
  preferred_currency: 'USD',
  website_url: 'https://example.test',
  category: 'Creator',
  audience_description: 'Mobile-first audience',
  audience_countries: ['NG', 'GB'],
  channels: ['TikTok', 'YouTube'],
  channel_details: '@victory',
  primary_user_id: '10000000-0000-0000-0000-000000000001',
  primary_user_role: 'owner',
  primary_full_name: 'Victory King',
  primary_email: 'victory@example.test',
  registration_kind: 'public',
  registered_at: '2026-09-01T00:01:00.000Z',
  email_confirmation_status: 'confirmed',
  email_confirmed_at: '2026-09-01T00:02:00.000Z',
  activation_status: 'active',
  membership_active: true,
  activation_pending: false,
  activated_at: '2026-09-01T00:03:00.000Z',
  member_count: '1',
  active_member_count: 1,
  terms_version: '2026-07-13',
  terms_url: 'https://kissmyapps.dev/terms',
  privacy_version: '2026-07-13',
  privacy_url: 'https://kissmyapps.dev/privacy',
  age_confirmed: true,
  legal_accepted_at: '2026-09-01T00:01:00.000Z',
  product_count: 2,
  agreement_count: 3,
  active_agreement_count: 1,
  blocking_agreement_count: 2,
  blocking_document_count: 1,
  link_count: 4,
  active_link_count: 2,
  unsettled_payout_count: 0,
  created_at: '2026-09-01T00:01:00.000Z',
  updated_at: '2026-09-01T00:03:00.000Z',
}

const summaryRow = {
  total_count: 5,
  draft_count: 0,
  invited_count: 1,
  active_count: 2,
  paused_count: 1,
  terminated_count: 1,
  pending_confirmation_count: 1,
  pending_activation_count: 1,
}

function client(response: AdminBackendResponse) {
  const rpc = vi.fn(async (_functionName: string, _args?: Record<string, unknown>) => response)
  return { value: { rpc } satisfies AdminSupabaseClient, rpc }
}

describe('Admin affiliate-management mappers', () => {
  it('maps the complete protected directory record without dropping lifecycle evidence', () => {
    expect(mapAdminAffiliateDirectoryRecord(directoryRow)).toEqual({
      id: directoryRow.id,
      publicName: 'Victory King',
      legalName: 'Victory King Media Ltd',
      slug: 'partner-victory',
      status: 'active',
      entityType: 'company',
      countryCode: 'NG',
      reportingTimezone: 'Africa/Lagos',
      preferredCurrency: 'USD',
      websiteUrl: 'https://example.test',
      category: 'Creator',
      audienceDescription: 'Mobile-first audience',
      audienceCountries: ['NG', 'GB'],
      channels: ['TikTok', 'YouTube'],
      channelDetails: '@victory',
      primaryUserId: directoryRow.primary_user_id,
      primaryUserRole: 'owner',
      primaryFullName: 'Victory King',
      primaryEmail: 'victory@example.test',
      registrationKind: 'public',
      registeredAt: directoryRow.registered_at,
      emailConfirmationStatus: 'confirmed',
      emailConfirmedAt: directoryRow.email_confirmed_at,
      activationStatus: 'active',
      membershipActive: true,
      activationPending: false,
      activatedAt: directoryRow.activated_at,
      memberCount: 1,
      activeMemberCount: 1,
      termsVersion: '2026-07-13',
      termsUrl: 'https://kissmyapps.dev/terms',
      privacyVersion: '2026-07-13',
      privacyUrl: 'https://kissmyapps.dev/privacy',
      ageConfirmed: true,
      legalAcceptedAt: directoryRow.legal_accepted_at,
      productCount: 2,
      agreementCount: 3,
      activeAgreementCount: 1,
      blockingAgreementCount: 2,
      blockingDocumentCount: 1,
      linkCount: 4,
      activeLinkCount: 2,
      unsettledPayoutCount: 0,
      createdAt: directoryRow.created_at,
      updatedAt: directoryRow.updated_at,
    })
  })

  it.each([
    ['unknown workspace status', { status: 'enabled' }],
    ['invalid timestamp', { registered_at: 'not-a-date' }],
    ['negative count', { link_count: -1 }],
    ['non-boolean evidence', { age_confirmed: 'yes' }],
    ['malformed collection', { channels: 'TikTok' }],
    ['inconsistent active counts', { active_link_count: 5 }],
    ['blocking agreement count below active count', { blocking_agreement_count: 0 }],
    ['blocking agreement count above total count', { blocking_agreement_count: 4 }],
    ['negative blocking document count', { blocking_document_count: -1 }],
    ['confirmed email without timestamp', { email_confirmed_at: null }],
    ['partial legal evidence', { privacy_url: null }],
  ])('rejects %s', (_label, patch) => {
    expect(() => mapAdminAffiliateDirectoryRecord({ ...directoryRow, ...patch })).toThrow()
  })

  it('maps and validates page and summary totals', () => {
    expect(
      mapAdminAffiliateDirectoryPage({ items: [directoryRow], total_count: '1' }),
    ).toMatchObject({ totalCount: 1, items: [{ publicName: 'Victory King' }] })
    expect(mapAdminAffiliateDirectorySummary(summaryRow)).toEqual({
      totalCount: 5,
      draftCount: 0,
      invitedCount: 1,
      activeCount: 2,
      pausedCount: 1,
      terminatedCount: 1,
      pendingConfirmationCount: 1,
      pendingActivationCount: 1,
    })
    expect(() =>
      mapAdminAffiliateDirectoryPage({ items: [directoryRow], total_count: 0 }),
    ).toThrow()
    expect(() => mapAdminAffiliateDirectorySummary({ ...summaryRow, total_count: 6 })).toThrow()
  })

  it('accepts only server-supported lifecycle mutation responses', () => {
    expect(
      mapAdminAffiliateStatusChange({
        id: directoryRow.id,
        status: 'paused',
        updated_at: directoryRow.updated_at,
      }),
    ).toEqual({ id: directoryRow.id, status: 'paused', updatedAt: directoryRow.updated_at })
    expect(() =>
      mapAdminAffiliateStatusChange({
        id: directoryRow.id,
        status: 'invited',
        updated_at: directoryRow.updated_at,
      }),
    ).toThrow()
  })
})

describe('Admin affiliate-management RPC gateway', () => {
  it('publishes the exact protected RPC names and capability', () => {
    expect(ADMIN_RPCS).toMatchObject({
      affiliateSummary: 'get_admin_affiliate_summary',
      affiliateDirectory: 'get_admin_affiliate_directory',
      affiliateDetail: 'get_admin_affiliate_detail',
      setAffiliateStatus: 'set_admin_affiliate_status',
      terminateAffiliate: 'terminate_admin_affiliate',
    })
    expect(hasAdminAffiliateManagementGateway(createAdminGateway(null))).toBe(true)
  })

  it('maps summary and sends one normalized directory filter object', async () => {
    const summaryClient = client({ data: summaryRow, error: null, status: 200 })
    const summary = await createAdminGateway(summaryClient.value).getAffiliateSummary?.()
    expect(summaryClient.rpc).toHaveBeenCalledWith('get_admin_affiliate_summary', undefined)
    expect(summary).toMatchObject({ status: 'ready', data: { totalCount: 5, activeCount: 2 } })

    const directoryClient = client({
      data: { items: [directoryRow], total_count: 1 },
      error: null,
      status: 200,
    })
    const directory = await createAdminGateway(directoryClient.value).getAffiliateDirectory?.({
      query: '  Victory  ',
      status: 'active',
      confirmationStatus: 'confirmed',
      activationStatus: 'active',
      sort: 'name',
      limit: 20,
      offset: 40,
    })

    expect(directoryClient.rpc).toHaveBeenCalledWith('get_admin_affiliate_directory', {
      p_input: {
        query: 'Victory',
        status: 'active',
        confirmation_status: 'confirmed',
        activation_status: 'active',
        sort: 'name',
        limit: 20,
        offset: 40,
      },
    })
    expect(directory).toMatchObject({
      status: 'ready',
      data: { totalCount: 1, items: [{ primaryEmail: 'victory@example.test' }] },
    })
  })

  it('uses safe server defaults and distinguishes an empty filtered page', async () => {
    const rpcClient = client({
      data: { items: [], total_count: 0 },
      error: null,
      status: 200,
    })
    const response = await createAdminGateway(rpcClient.value).getAffiliateDirectory?.({})

    expect(rpcClient.rpc).toHaveBeenCalledWith('get_admin_affiliate_directory', {
      p_input: {
        query: null,
        status: null,
        confirmation_status: null,
        activation_status: null,
        sort: 'newest',
        limit: 25,
        offset: 0,
      },
    })
    expect(response).toEqual({
      data: { items: [], totalCount: 0 },
      status: 'empty',
      error: null,
    })
  })

  it('loads one partner by its exact protected identifier', async () => {
    const rpcClient = client({ data: directoryRow, error: null, status: 200 })
    const result = await createAdminGateway(rpcClient.value).getAffiliateDetail?.(
      ` ${directoryRow.id} `,
    )

    expect(rpcClient.rpc).toHaveBeenCalledWith('get_admin_affiliate_detail', {
      p_affiliate_id: directoryRow.id,
    })
    expect(result).toMatchObject({ status: 'ready', data: { id: directoryRow.id } })
  })

  it('sends only the exact audited pause/reactivate and termination payloads', async () => {
    const changed = {
      id: directoryRow.id,
      status: 'paused',
      updated_at: directoryRow.updated_at,
    }
    const pauseClient = client({ data: changed, error: null, status: 200 })
    await createAdminGateway(pauseClient.value).setAffiliateStatus?.({
      affiliateId: ` ${directoryRow.id} `,
      status: 'paused',
      reason: '  Repeated policy violation  ',
    })
    expect(pauseClient.rpc).toHaveBeenCalledWith('set_admin_affiliate_status', {
      p_input: {
        affiliate_id: directoryRow.id,
        status: 'paused',
        reason: 'Repeated policy violation',
      },
    })

    const terminationClient = client({
      data: { ...changed, status: 'terminated' },
      error: null,
      status: 200,
    })
    await createAdminGateway(terminationClient.value).terminateAffiliate?.({
      affiliateId: directoryRow.id,
      reason: '  Agreement ended permanently  ',
      confirmation: '  partner-victory  ',
    })
    expect(terminationClient.rpc).toHaveBeenCalledWith('terminate_admin_affiliate', {
      p_input: {
        affiliate_id: directoryRow.id,
        reason: 'Agreement ended permanently',
        confirmation: 'partner-victory',
      },
    })
  })

  it('sanitizes lifecycle failures instead of exposing database details', async () => {
    const rpcClient = client({
      data: null,
      error: { code: '55000', message: 'raw agreements, payout, and user details' },
      status: 400,
    })
    const result = await createAdminGateway(rpcClient.value).terminateAffiliate?.({
      affiliateId: directoryRow.id,
      reason: 'Agreement ended permanently',
      confirmation: 'partner-victory',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'invalid_state',
        message:
          'Resolve active or awaiting-signature agreements, current legal documents, and unsettled payout obligations before terminating this partner.',
        retryable: false,
      },
    })
    expect(result?.error?.message).not.toMatch(/raw|user details/i)
  })
})
