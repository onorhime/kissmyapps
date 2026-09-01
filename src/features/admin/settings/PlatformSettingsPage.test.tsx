import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type { AdminContext, AdminDataResult, AdminGateway, AdminPlatformSettings } from '../api'
import { PlatformSettingsPage } from './PlatformSettingsPage'

const ownerContext: AdminContext = {
  userId: 'admin-owner',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const blockedSettings: AdminPlatformSettings = {
  tracking: { baseUrl: null, enabled: false, updatedAt: null },
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
}

const readySettings: AdminPlatformSettings = {
  ...blockedSettings,
  tracking: {
    baseUrl: 'https://go.kissmyapps.dev',
    enabled: false,
    updatedAt: '2026-09-01T10:00:00.000Z',
  },
  readiness: {
    canEnable: true,
    activeProductCount: 1,
    liveDefaultFunnelCount: 1,
    launchReadyAgreementCount: 1,
    verifiedActiveOfferCount: 1,
    enableReadyProductCount: 1,
  },
}

const mutationFailures: readonly Readonly<{
  name: string
  result: AdminDataResult<AdminPlatformSettings | null>
  message: RegExp
}>[] = [
  {
    name: 'authorization',
    result: {
      data: null,
      status: 'unauthorized',
      error: { code: 'not_authenticated', message: 'Sign in again.', retryable: false },
    },
    message: /sign in again, then refresh settings/i,
  },
  {
    name: 'deployment configuration',
    result: {
      data: null,
      status: 'unconfigured',
      error: { code: 'contract_unavailable', message: 'Unavailable.', retryable: false },
    },
    message: /refresh settings after the service is restored/i,
  },
  {
    name: 'temporary service',
    result: {
      data: null,
      status: 'error',
      error: {
        code: 'temporarily_unavailable',
        message: 'Platform settings are temporarily unavailable.',
        retryable: true,
      },
    },
    message: /temporarily unavailable.*refresh settings before retrying/i,
  },
]

function ready<T>(data: T): AdminDataResult<T | null> {
  return { data, status: 'ready', error: null }
}

function gatewayWith(
  settings: AdminPlatformSettings = blockedSettings,
  readResult: AdminDataResult<AdminPlatformSettings | null> = ready(settings),
): AdminGateway {
  return {
    getAdminContext: vi.fn(),
    getProducts: vi.fn(),
    createProduct: vi.fn(),
    getPlatformSettings: vi.fn(async () => readResult),
    configureTracking: vi.fn(async (input) =>
      ready({
        ...settings,
        tracking: {
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
      }),
    ),
  }
}

describe('Admin Platform Settings page', () => {
  it('shows a missing settings capability as unconfigured without invented values', async () => {
    const gateway: AdminGateway = {
      getAdminContext: vi.fn(),
      getProducts: vi.fn(),
      createProduct: vi.fn(),
    }
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    expect(
      await screen.findByRole('heading', { name: 'Settings are not configured' }),
    ).toBeVisible()
    expect(screen.getByText(/contract is not available/i)).toBeVisible()
    expect(screen.queryByText('go.kissmyapps.dev')).not.toBeInTheDocument()
  })

  it('does not reveal configuration after an unauthorized read', async () => {
    const gateway = gatewayWith(blockedSettings, {
      data: null,
      status: 'unauthorized',
      error: {
        code: 'not_authorized',
        message: 'This account does not have permission to read platform settings.',
        retryable: false,
      },
    })
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    expect(await screen.findByRole('heading', { name: 'Admin access required' })).toBeVisible()
    expect(screen.queryByText('Partner dashboard')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Required tracking origin')).not.toBeInTheDocument()
  })

  it('marks the default origin as an unsaved suggestion and saves it without enabling tracking', async () => {
    const gateway = gatewayWith()
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    const origin = await screen.findByLabelText('Required tracking origin')
    expect(origin).toHaveValue('https://go.kissmyapps.dev')
    expect(screen.getByText(/required value, shown as an unsaved suggestion/i)).toBeVisible()
    expect(screen.getByText('Not configured')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Save origin' }))
    await waitFor(() =>
      expect(gateway.configureTracking).toHaveBeenCalledWith({
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: false,
        expectedUpdatedAt: null,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Tracking origin saved. Collection remains disabled.',
    )
  })

  it('rejects any origin other than the canonical tracking host and focuses the field', async () => {
    const gateway = gatewayWith()
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    const origin = await screen.findByLabelText('Required tracking origin')
    await user.clear(origin)
    await user.type(origin, 'https://tracker.kissmyapps.dev')
    await user.click(screen.getByRole('button', { name: 'Save origin' }))

    expect(
      await screen.findByText(
        'Enter exactly https://go.kissmyapps.dev. Other HTTPS origins are not allowed.',
      ),
    ).toBeVisible()
    await waitFor(() => expect(origin).toHaveFocus())
    expect(gateway.configureTracking).not.toHaveBeenCalled()
  })

  it('requires a focused, cancellable confirmation before disabling tracking', async () => {
    const enabledSettings: AdminPlatformSettings = {
      ...readySettings,
      tracking: { ...readySettings.tracking, enabled: true },
    }
    const gateway = gatewayWith(enabledSettings)
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    const disable = await screen.findByRole('button', { name: 'Disable tracking' })
    await user.click(disable)
    expect(gateway.configureTracking).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: 'Confirm disable tracking' })
    await waitFor(() => expect(confirm).toHaveFocus())
    expect(screen.getByText(/new tracking redirects will fail closed/i)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(disable).toHaveFocus())
    expect(gateway.configureTracking).not.toHaveBeenCalled()

    await user.click(disable)
    await user.click(screen.getByRole('button', { name: 'Confirm disable tracking' }))
    await waitFor(() =>
      expect(gateway.configureTracking).toHaveBeenCalledWith({
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: false,
        expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Tracking disabled. Saved host configuration was retained.',
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Enable tracking' })).toHaveFocus(),
    )
  })

  it('does not expose an Enable control while server readiness is blocked', async () => {
    render(<PlatformSettingsPage context={ownerContext} gateway={gatewayWith()} />)

    expect(await screen.findByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    expect(screen.getByText('Enablement blocked')).toBeVisible()
    expect(screen.queryByRole('button', { name: /enable tracking/i })).not.toBeInTheDocument()
    expect(
      screen.getByText(/does not create products, funnels, offers, payment events/i),
    ).toBeVisible()
    expect(screen.getByText(/does not prove DNS resolution/i)).toBeVisible()
  })

  it('requires a separate, focused confirmation before enabling tracking', async () => {
    const gateway = gatewayWith(readySettings)
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    const enable = await screen.findByRole('button', { name: 'Enable tracking' })
    await user.click(enable)
    expect(gateway.configureTracking).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: 'Confirm enable tracking' })
    await waitFor(() => expect(confirm).toHaveFocus())
    expect(screen.getByText(/does not create traffic or payment data/i)).toBeVisible()

    await user.click(confirm)
    await waitFor(() =>
      expect(gateway.configureTracking).toHaveBeenCalledWith({
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: true,
        expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Disable tracking' })).toHaveFocus(),
    )
  })

  it.each(mutationFailures)(
    'keeps the readable page after a $name mutation failure',
    async ({ result, message }) => {
      const gateway = gatewayWith(readySettings)
      gateway.configureTracking = vi.fn(async () => result)
      const user = userEvent.setup()
      render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

      await user.click(await screen.findByRole('button', { name: 'Enable tracking' }))
      await user.click(screen.getByRole('button', { name: 'Confirm enable tracking' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByRole('heading', { name: 'Launch readiness' })).toBeVisible()
      expect(screen.getByText('Saved origin')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Refresh settings' })).toBeVisible()
    },
  )

  it('automatically refreshes a stale CAS failure while keeping settings visible', async () => {
    const gateway = gatewayWith(readySettings)
    const conflict: AdminDataResult<AdminPlatformSettings | null> = {
      data: null,
      status: 'error',
      error: {
        code: 'conflict',
        message: 'Raw stale-write detail.',
        retryable: false,
      },
    }
    gateway.configureTracking = vi.fn(async () => conflict)
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'Enable tracking' }))
    await user.click(screen.getByRole('button', { name: 'Confirm enable tracking' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /latest server state is being reloaded/i,
    )
    expect(screen.getByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    await waitFor(() => expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(2))
  })

  it('exposes an explicit refresh without hiding the ready page', async () => {
    const gateway = gatewayWith(readySettings)
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'Refresh settings' }))

    expect(screen.getByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    await waitFor(() => expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(2))
  })

  it('labels an enabled configuration with broken readiness as drift', async () => {
    const drifted: AdminPlatformSettings = {
      ...blockedSettings,
      tracking: {
        baseUrl: 'https://go.kissmyapps.dev',
        enabled: true,
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
    }
    render(<PlatformSettingsPage context={ownerContext} gateway={gatewayWith(drifted)} />)

    expect(await screen.findByText('Enabled with drift')).toBeVisible()
    expect(screen.getByText('Enable-ready product chains')).toBeVisible()
  })

  it.each(['operations', 'finance', 'analyst'] as const)(
    'gives the %s role a read-only settings surface',
    async (role) => {
      render(
        <PlatformSettingsPage
          context={{ ...ownerContext, role }}
          gateway={gatewayWith(readySettings)}
        />,
      )

      expect(await screen.findByText('Protected read only')).toBeVisible()
      expect(screen.getByText(/Only an Owner can change it/i)).toBeVisible()
      expect(screen.queryByLabelText('Required tracking origin')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /save origin/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /enable tracking/i })).not.toBeInTheDocument()
    },
  )

  it('contains read failures and retries safely', async () => {
    const gateway = gatewayWith(blockedSettings, {
      data: null,
      status: 'error',
      error: {
        code: 'temporarily_unavailable',
        message: 'Platform settings are temporarily unavailable.',
        retryable: true,
      },
    })
    const user = userEvent.setup()
    render(<PlatformSettingsPage context={ownerContext} gateway={gateway} />)

    expect(
      await screen.findByRole('heading', { name: 'Settings could not be loaded' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(2))
  })

  it('has no automated accessibility violations in the blocked Owner state', async () => {
    const { container } = render(
      <PlatformSettingsPage context={ownerContext} gateway={gatewayWith()} />,
    )

    await screen.findByRole('heading', { name: 'Launch readiness' })
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})
