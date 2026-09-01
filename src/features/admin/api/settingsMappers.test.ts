import { describe, expect, it } from 'vitest'
import { mapAdminPlatformSettings } from './settingsMappers'

const emptySettings = {
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
  },
  expected_hosts: {
    partner: 'https://partners.kissmyapps.dev',
    admin: 'https://admin.kissmyapps.dev',
    tracking: 'https://go.kissmyapps.dev',
  },
}

describe('admin settings mapper', () => {
  it('maps a known-empty platform state without inventing readiness', () => {
    expect(mapAdminPlatformSettings(emptySettings)).toEqual({
      tracking: {
        baseUrl: null,
        enabled: false,
        updatedAt: null,
      },
      readiness: {
        canEnable: false,
        activeProductCount: 0,
        liveDefaultFunnelCount: 0,
        launchReadyAgreementCount: 0,
        verifiedActiveOfferCount: 0,
        enableReadyProductCount: 0,
      },
      expectedHosts: {
        partner: 'https://partners.kissmyapps.dev',
        admin: 'https://admin.kissmyapps.dev',
        tracking: 'https://go.kissmyapps.dev',
      },
    })
  })

  it('maps wrapped settings responses with a configured tracking origin', () => {
    expect(
      mapAdminPlatformSettings({
        configure_admin_tracking: {
          ...emptySettings,
          tracking: {
            base_url: 'https://go.kissmyapps.dev',
            enabled: true,
            updated_at: '2026-09-01T12:00:00.000Z',
          },
          readiness: {
            can_enable: true,
            active_product_count: 1,
            live_default_funnel_count: 1,
            launch_ready_agreement_count: 1,
            verified_active_offer_count: 1,
            enable_ready_product_count: 1,
            active_main_link_count: 0,
          },
        },
      }),
    ).toMatchObject({
      tracking: {
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: true,
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      readiness: { canEnable: true, activeProductCount: 1 },
    })
  })

  it.each([
    [
      'non-boolean enabled',
      { ...emptySettings, tracking: { ...emptySettings.tracking, enabled: 1 } },
    ],
    [
      'non-origin tracking URL',
      {
        ...emptySettings,
        tracking: { ...emptySettings.tracking, base_url: 'https://go.kissmyapps.dev/path' },
      },
    ],
    [
      'invalid timestamp',
      { ...emptySettings, tracking: { ...emptySettings.tracking, updated_at: 'not-a-date' } },
    ],
    [
      'negative count',
      {
        ...emptySettings,
        readiness: { ...emptySettings.readiness, active_product_count: -1 },
      },
    ],
    [
      'string count',
      {
        ...emptySettings,
        readiness: { ...emptySettings.readiness, active_product_count: '0' },
      },
    ],
    [
      'non-HTTPS expected host',
      {
        ...emptySettings,
        expected_hosts: { ...emptySettings.expected_hosts, tracking: 'http://go.kissmyapps.dev' },
      },
    ],
  ])('rejects %s instead of weakening the settings contract', (_label, response) => {
    expect(() => mapAdminPlatformSettings(response)).toThrow()
  })

  it('rejects missing and ambiguous settings rows', () => {
    expect(() => mapAdminPlatformSettings(null)).toThrow()
    expect(() => mapAdminPlatformSettings([emptySettings, emptySettings])).toThrow()
  })
})
