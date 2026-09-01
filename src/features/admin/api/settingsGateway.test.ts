import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import { hasAdminSettingsGateway } from './types'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'

const settingsResponse = {
  tracking: {
    base_url: null,
    enabled: false,
    updated_at: null,
  },
  readiness: {
    can_enable: false,
    active_product_count: 0,
    live_default_funnel_count: 0,
    launch_ready_agreement_count: 0,
    verified_active_offer_count: 0,
    enable_ready_product_count: 0,
    commercial_enable_ready_product_count: 0,
    tracking_only_ready_product_count: 0,
  },
  expected_hosts: {
    partner: 'https://partners.kissmyapps.dev',
    admin: 'https://admin.kissmyapps.dev',
    tracking: 'https://go.kissmyapps.dev',
  },
}

function rpcClient(
  implementation: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => Promise<AdminBackendResponse>,
) {
  const rpc = vi.fn(implementation)
  return { value: { rpc } satisfies AdminSupabaseClient, rpc }
}

describe('admin settings RPC gateway', () => {
  it('publishes the settings RPC names and capability', () => {
    expect(ADMIN_RPCS).toMatchObject({
      platformSettings: 'get_admin_platform_settings',
      configureTracking: 'configure_admin_tracking',
    })
    expect(hasAdminSettingsGateway(createAdminGateway(null))).toBe(true)
  })

  it('returns a safe unconfigured state without a client', async () => {
    const gateway = createAdminGateway(null)

    await expect(gateway.getPlatformSettings?.()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured', retryable: false },
    })
    await expect(
      gateway.configureTracking?.({
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: false,
        expectedUpdatedAt: null,
      }),
    ).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured', retryable: false },
    })
  })

  it('maps the known-empty platform settings read', async () => {
    const client = rpcClient(async () => ({ data: settingsResponse, error: null, status: 200 }))

    const response = await createAdminGateway(client.value).getPlatformSettings?.()

    expect(client.rpc).toHaveBeenCalledWith('get_admin_platform_settings', undefined)
    expect(response).toEqual({
      data: {
        tracking: { baseUrl: null, enabled: false, updatedAt: null },
        readiness: {
          canEnable: false,
          activeProductCount: 0,
          liveDefaultFunnelCount: 0,
          launchReadyAgreementCount: 0,
          verifiedActiveOfferCount: 0,
          enableReadyProductCount: 0,
          commercialEnableReadyProductCount: 0,
          trackingOnlyReadyProductCount: 0,
        },
        expectedHosts: {
          partner: 'https://partners.kissmyapps.dev',
          admin: 'https://admin.kissmyapps.dev',
          tracking: 'https://go.kissmyapps.dev',
        },
      },
      status: 'ready',
      error: null,
    })
  })

  it('sends only the exact trimmed tracking mutation payload', async () => {
    const configured = {
      ...settingsResponse,
      tracking: {
        base_url: 'https://go.kissmyapps.dev',
        enabled: false,
        updated_at: '2026-09-01T12:00:00.000Z',
      },
    }
    const client = rpcClient(async () => ({ data: configured, error: null, status: 200 }))

    const response = await createAdminGateway(client.value).configureTracking?.({
      baseUrl: '  https://go.kissmyapps.dev  ',
      enabled: false,
      expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
    })

    expect(client.rpc).toHaveBeenCalledOnce()
    expect(client.rpc).toHaveBeenCalledWith('configure_admin_tracking', {
      p_input: {
        base_url: 'https://go.kissmyapps.dev',
        enabled: false,
        expected_updated_at: '2026-09-01T10:00:00.000Z',
      },
    })
    const args = client.rpc.mock.calls[0]?.[1] as { p_input?: Record<string, unknown> }
    expect(Object.keys(args.p_input ?? {})).toEqual(['base_url', 'enabled', 'expected_updated_at'])
    expect(response).toMatchObject({
      status: 'ready',
      data: { tracking: { baseUrl: 'https://go.kissmyapps.dev', enabled: false } },
    })
  })

  it('rejects an alternate HTTPS origin before making a settings request', async () => {
    const client = rpcClient(async () => ({ data: settingsResponse, error: null, status: 200 }))

    const response = await createAdminGateway(client.value).configureTracking?.({
      baseUrl: 'https://tracker.kissmyapps.dev',
      enabled: false,
      expectedUpdatedAt: null,
    })

    expect(client.rpc).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      data: null,
      status: 'error',
      error: {
        code: 'invalid_input',
        message: 'The tracking origin must be exactly https://go.kissmyapps.dev.',
        retryable: false,
      },
    })
  })

  it('maps authorization and validation failures without leaking backend details', async () => {
    const denied = rpcClient(async () => ({
      data: null,
      error: { code: '42501', message: 'raw platform_settings policy details', status: 403 },
      status: 403,
    }))
    const invalid = rpcClient(async () => ({
      data: null,
      error: { code: '22023', message: 'raw URL validation internals', status: 422 },
      status: 422,
    }))

    const deniedResponse = await createAdminGateway(denied.value).getPlatformSettings?.()
    const invalidResponse = await createAdminGateway(invalid.value).configureTracking?.({
      baseUrl: 'https://go.kissmyapps.dev',
      enabled: true,
      expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
    })

    expect(deniedResponse).toMatchObject({
      data: null,
      status: 'unauthorized',
      error: { code: 'not_authorized', retryable: false },
    })
    expect(deniedResponse?.error?.message).not.toContain('platform_settings')
    expect(invalidResponse).toMatchObject({
      data: null,
      status: 'error',
      error: {
        code: 'invalid_input',
        message: 'Enter the expected production HTTPS tracking origin.',
        retryable: false,
      },
    })
    expect(invalidResponse?.error?.message).not.toContain('validation internals')
  })

  it('maps a stale expected_updated_at serialization failure to a safe conflict', async () => {
    const stale = rpcClient(async () => ({
      data: null,
      error: { code: '40001', message: 'raw current timestamp and row details' },
      status: 400,
    }))

    const response = await createAdminGateway(stale.value).configureTracking?.({
      baseUrl: 'https://go.kissmyapps.dev',
      enabled: false,
      expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
    })

    expect(response).toMatchObject({
      data: null,
      status: 'error',
      error: {
        code: 'conflict',
        message: 'Platform settings changed in another session. Refresh settings and try again.',
        retryable: false,
      },
    })
    expect(response?.error?.message).not.toContain('timestamp')
  })

  it('returns safe failures for thrown requests and malformed settings', async () => {
    const thrown = rpcClient(async () => {
      throw new Error('network topology and credentials')
    })
    const malformed = rpcClient(async () => ({
      data: {
        ...settingsResponse,
        readiness: { ...settingsResponse.readiness, can_enable: 'yes' },
      },
      error: null,
      status: 200,
    }))

    await expect(createAdminGateway(thrown.value).getPlatformSettings?.()).resolves.toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'temporarily_unavailable', retryable: true },
    })
    await expect(
      createAdminGateway(malformed.value).getPlatformSettings?.(),
    ).resolves.toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'invalid_response', retryable: false },
    })
  })
})
