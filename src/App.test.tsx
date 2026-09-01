import { StrictMode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { PartnerAuthService } from './features/auth/authService'
import type { AuthSessionState } from './features/auth/authSession'
import { useAuthSession } from './features/auth/authSession'
import type { AdminGateway } from './features/admin'
import { money } from './features/partner/data'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerProfile,
} from './features/partner/api'
import {
  aggregateReport,
  defaultReportingFilters,
  filterReportingRecords,
} from './features/partner/reporting'

vi.mock('./features/auth/authSession', () => ({ useAuthSession: vi.fn() }))

const anonymousSession: AuthSessionState = {
  status: 'anonymous',
  session: null,
  user: null,
  recoveryMode: false,
  message: null,
}

const authenticatedUser = {
  id: 'partner-user',
  email: 'partner@example.com',
  user_metadata: { public_name: 'North Star Media' },
} as unknown as NonNullable<AuthSessionState['user']>

const authenticatedSupabaseSession = {
  access_token: 'partner-session',
  user: authenticatedUser,
} as Session

const authenticatedSession: AuthSessionState = {
  status: 'authenticated',
  session: authenticatedSupabaseSession,
  user: authenticatedUser,
  recoveryMode: false,
  message: null,
}

function authService(overrides: Partial<PartnerAuthService> = {}): PartnerAuthService {
  return {
    signIn: vi.fn().mockResolvedValue({
      session: authenticatedSupabaseSession,
      activationStatus: 'active',
    }),
    signUp: vi.fn().mockResolvedValue(undefined),
    confirmSignUp: vi.fn().mockResolvedValue(authenticatedSupabaseSession),
    acceptInvite: vi.fn().mockResolvedValue(authenticatedSupabaseSession),
    requestPasswordRecovery: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({
      session: authenticatedSupabaseSession,
      activationStatus: 'active',
    }),
    getPartnerActivationStatus: vi.fn().mockResolvedValue('active'),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function partnerResult<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

function emptyLiveGateway(): PartnerDataGateway {
  const profile: PartnerProfile = {
    email: 'partner@example.com',
    fullName: 'North Star Owner',
    publicName: 'North Star Media',
    legalName: 'North Star Media Ltd',
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
    role: 'owner',
    status: 'active',
    notifications: {
      statements: true,
      payouts: true,
      verification: true,
      signatures: true,
      adjustments: true,
      inactiveLinks: true,
    },
  }

  return {
    getCurrentPartnerProfile: async () => partnerResult(profile, 'ready'),
    getDashboardSummary: async () => partnerResult(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => partnerResult([], 'empty'),
    getProducts: async () => partnerResult([], 'empty'),
    getLinkDirectory: async () =>
      partnerResult({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => partnerResult([], 'empty'),
    createPartnerLink: async () => partnerResult(null, 'empty'),
    updatePartnerLink: async () => partnerResult(null, 'empty'),
    setPartnerLinkStatus: async () => partnerResult(null, 'empty'),
    getPayoutSummary: async () => partnerResult(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => partnerResult([], 'empty'),
    getPayoutDetail: async () => partnerResult(null, 'empty'),
    getDocuments: async () => partnerResult([], 'empty'),
    getAgreements: async () => partnerResult([], 'empty'),
    updatePartnerProfile: async () => partnerResult(null, 'empty'),
    updatePartnerSettings: async () => partnerResult(null, 'empty'),
  }
}

function emptyAdminGateway(): AdminGateway {
  return {
    getAdminContext: async () => ({
      data: {
        userId: 'partner-user',
        email: 'partner@example.com',
        fullName: 'North Star Owner',
        role: 'operations',
        active: true,
      },
      status: 'ready',
      error: null,
    }),
    getProducts: async () => ({ data: [], status: 'empty', error: null }),
    createProduct: async () => ({ data: null, status: 'empty', error: null }),
    getAffiliateSummary: async () => ({
      data: {
        totalCount: 0,
        draftCount: 0,
        invitedCount: 0,
        activeCount: 0,
        pausedCount: 0,
        terminatedCount: 0,
        pendingConfirmationCount: 0,
        pendingActivationCount: 0,
      },
      status: 'ready',
      error: null,
    }),
    getAffiliateDirectory: async () => ({
      data: { items: [], totalCount: 0 },
      status: 'empty',
      error: null,
    }),
    getAffiliateDetail: async () => ({ data: null, status: 'empty', error: null }),
    setAffiliateStatus: async () => ({ data: null, status: 'empty', error: null }),
    terminateAffiliate: async () => ({ data: null, status: 'empty', error: null }),
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  vi.mocked(useAuthSession).mockReturnValue(anonymousSession)
})

function openPage(page: string) {
  window.history.replaceState(null, '', `/#${page}`)
  return render(<App />)
}

function navigation() {
  return within(screen.getByRole('navigation', { name: 'Partner navigation' }))
}

describe('live partner session shell', () => {
  it('opens the protected admin overview by default on the admin production hostname', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
    })

    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={service}
        adminGateway={emptyAdminGateway()}
      />,
    )

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(document.title).toBe('Admin overview · KissMyApps Admin')
  })

  it('uses admin sign-in by default for an anonymous visitor on the admin hostname', async () => {
    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={authService()}
      />,
    )

    expect(screen.getByText('YOUR ADMIN WORKSPACE')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Admin account access' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
    expect(document.title).toBe('Sign in · KissMyApps Admin')
  })

  it('opens public registration only in the Partner workspace', async () => {
    window.history.replaceState(null, '', '/#auth/sign-up')

    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={authService()}
      />,
    )

    expect(
      screen.getByRole('heading', { level: 1, name: 'Create your partner account.' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create partner account' })).toBeInTheDocument()
    expect(document.title).toBe('Create partner account · KissMyApps Partners')
  })

  it('keeps the Admin hostname provisioned-only when a signup hash is requested', async () => {
    window.history.replaceState(null, '', '/#auth/sign-up')

    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={authService()}
      />,
    )

    expect(screen.getByText('YOUR ADMIN WORKSPACE')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create partner account' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
    expect(document.title).toBe('Sign in · KissMyApps Admin')
  })

  it('keeps the Admin shell authoritative and canonicalizes a Partner hash', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const partnerGateway = emptyLiveGateway()
    const getPartnerSummary = vi.spyOn(partnerGateway, 'getDashboardSummary')
    window.history.replaceState(null, '', '/#payouts')

    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={authService()}
        partnerGateway={partnerGateway}
        adminGateway={emptyAdminGateway()}
      />,
    )

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Partner navigation' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#admin/overview'))
    expect(getPartnerSummary).not.toHaveBeenCalled()
    expect(document.title).toBe('Admin overview · KissMyApps Admin')
  })

  it('keeps the Partner shell authoritative and canonicalizes an Admin hash', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const adminGateway = emptyAdminGateway()
    const getAdminContext = vi.spyOn(adminGateway, 'getAdminContext')
    window.history.replaceState(null, '', '/#admin/products')

    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={authService()}
        partnerGateway={emptyLiveGateway()}
        adminGateway={adminGateway}
      />,
    )

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Partner navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#performance'))
    expect(getAdminContext).not.toHaveBeenCalled()
    expect(document.title).toBe('Performance · KissMyApps Partners')
  })

  it('does not switch shells when a cross-workspace hash is entered at runtime', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={authService()}
        adminGateway={emptyAdminGateway()}
      />,
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()

    window.location.hash = 'performance'

    await waitFor(() => expect(window.location.hash).toBe('#admin/overview'))
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Partner navigation' })).not.toBeInTheDocument()
  })

  it('does not switch the Partner host to Admin when an Admin hash is entered at runtime', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const adminGateway = emptyAdminGateway()
    const getAdminContext = vi.spyOn(adminGateway, 'getAdminContext')
    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={authService()}
        partnerGateway={emptyLiveGateway()}
        adminGateway={adminGateway}
      />,
    )
    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()

    window.location.hash = 'admin/products'

    await waitFor(() => expect(window.location.hash).toBe('#performance'))
    expect(screen.getByRole('navigation', { name: 'Partner navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument()
    expect(getAdminContext).not.toHaveBeenCalled()
  })

  it('switches from Admin to the canonical Partner origin', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const externalNavigate = vi.fn()
    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={authService()}
        adminGateway={emptyAdminGateway()}
        externalNavigate={externalNavigate}
      />,
    )
    await screen.findByRole('heading', { level: 1, name: 'Overview' })

    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to Partner' }))

    expect(externalNavigate).toHaveBeenCalledWith(
      'https://partners.kissmyapps.dev/#performance',
      'assign',
    )
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
  })

  it('moves a Partner signup callback off the Admin host before consuming it', () => {
    const service = authService()
    const externalNavigate = vi.fn()
    window.history.replaceState(
      null,
      '',
      '/?auth_action=signup&type=email&token_hash=one-time-secret',
    )

    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={service}
        externalNavigate={externalNavigate}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Opening secure Partner confirmation…')
    expect(externalNavigate).toHaveBeenCalledWith(
      'https://partners.kissmyapps.dev/?auth_action=signup&type=email&token_hash=one-time-secret',
      'replace',
    )
    expect(service.confirmSignUp).not.toHaveBeenCalled()
  })

  it('keeps the Admin hostname authoritative even when UI preview is enabled', () => {
    render(<App previewMode workspaceHostname="admin.kissmyapps.dev" />)

    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Partner navigation' })).not.toBeInTheDocument()
  })

  it('keeps preview-enabled Admin workspace switching on the canonical Partner origin', async () => {
    const externalNavigate = vi.fn()
    render(
      <App
        previewMode
        workspaceHostname="admin.kissmyapps.dev"
        externalNavigate={externalNavigate}
      />,
    )

    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Switch to Partner' })[0])

    expect(externalNavigate).toHaveBeenCalledWith(
      'https://partners.kissmyapps.dev/#performance',
      'assign',
    )
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Partner navigation' })).not.toBeInTheDocument()
  })

  it.each(['anonymous', 'unconfigured', 'error'] as const)(
    'protects dashboard routes when the session is %s',
    async (status) => {
      vi.mocked(useAuthSession).mockReturnValue({
        ...anonymousSession,
        status,
        message: status === 'anonymous' ? null : 'Safe account status message.',
      })
      window.history.replaceState(null, '', '/#payouts')

      render(<App previewMode={false} authService={authService()} />)

      expect(screen.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeInTheDocument()
      await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
      expect(screen.queryByRole('heading', { level: 1, name: 'Payouts.' })).not.toBeInTheDocument()
    },
  )

  it('shows a non-preview loading state while checking the initial session', () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...anonymousSession,
      status: 'loading',
    })

    render(<App previewMode={false} authService={authService()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Checking your partner session')
    expect(screen.queryByText('UI preview')).not.toBeInTheDocument()
  })

  it('shows authenticated identity and a truthful unconfigured live state without preview fixtures', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)

    render(<App previewMode={false} authService={authService()} />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Performance.' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Partner data is not available')).toBeInTheDocument()
    expect(screen.getByText('The partner data connection is not configured.')).toBeInTheDocument()
    expect(screen.getByText('No active products')).toBeInTheDocument()
    expect(screen.getByText('North Star Media')).toBeInTheDocument()
    expect(screen.getByText('partner@example.com')).toBeInTheDocument()
    expect(screen.queryByText('UI preview')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Sample data only. Not connected to Supabase.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Example product (sample)')).not.toBeInTheDocument()
    expect(document.title).toBe('Performance · KissMyApps Partners')
  })

  it('renders the authenticated real zero-product state through the partner gateway', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)

    render(
      <App previewMode={false} authService={authService()} partnerGateway={emptyLiveGateway()} />,
    )

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    expect(screen.getAllByText('North Star Media')).not.toHaveLength(0)
    expect(screen.getByText(/dashboard is ready/i)).toBeInTheDocument()
    expect(screen.queryByText('Example product (sample)')).not.toBeInTheDocument()
    expect(screen.queryByText(/Sample data only/)).not.toBeInTheDocument()
  })

  it('routes an authenticated admin-only account to the protected product catalog', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
    })
    window.history.replaceState(null, '', '/#admin/products')

    render(<App previewMode={false} authService={service} adminGateway={emptyAdminGateway()} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Products' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Admin navigation' })).toBeInTheDocument()
    expect(screen.getByText('No products have been created')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Create your password.' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Performance.' })).not.toBeInTheDocument()
    expect(document.title).toBe('Admin products · KissMyApps Admin')
  })

  it('opens the protected Funnels & Links route directly with its canonical title and active navigation', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
    })
    window.history.replaceState(null, '', '/#admin/funnels-links')

    render(
      <App
        previewMode={false}
        workspaceHostname="admin.kissmyapps.dev"
        authService={service}
        adminGateway={emptyAdminGateway()}
      />,
    )

    const adminNavigation = screen.getByRole('navigation', { name: 'Admin navigation' })
    expect(
      within(adminNavigation).getByRole('button', { name: 'Funnels & Links' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByText('Funnels & Links', { selector: '.admin-breadcrumb strong' }),
    ).toBeVisible()
    expect(window.location.hash).toBe('#admin/funnels-links')
    await waitFor(() => expect(document.title).toBe('Admin funnels & links · KissMyApps Admin'))
  })

  it.each([
    ['attribution', 'Attribution', 'Admin attribution · KissMyApps Admin'],
    ['data-health', 'Data Health', 'Admin data health · KissMyApps Admin'],
    ['settings', 'Settings', 'Admin settings · KissMyApps Admin'],
  ] as const)(
    'opens the protected %s route directly with its canonical title and active navigation',
    async (route, label, title) => {
      vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
      const service = authService({
        getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
      })
      window.history.replaceState(null, '', `/#admin/${route}`)

      render(
        <App
          previewMode={false}
          workspaceHostname="admin.kissmyapps.dev"
          authService={service}
          adminGateway={emptyAdminGateway()}
        />,
      )

      const adminNavigation = screen.getByRole('navigation', { name: 'Admin navigation' })
      expect(within(adminNavigation).getByRole('button', { name: label })).toHaveAttribute(
        'aria-current',
        'page',
      )
      expect(screen.getByText(label, { selector: '.admin-breadcrumb strong' })).toBeVisible()
      expect(window.location.hash).toBe(`#admin/${route}`)
      await waitFor(() => expect(document.title).toBe(title))
    },
  )

  it.each(['attribution', 'data-health', 'settings'] as const)(
    'keeps the Partner host authoritative over the %s Admin route',
    async (route) => {
      vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
      const adminGateway = emptyAdminGateway()
      const getAdminContext = vi.spyOn(adminGateway, 'getAdminContext')
      window.history.replaceState(null, '', `/#admin/${route}`)

      render(
        <App
          previewMode={false}
          workspaceHostname="partners.kissmyapps.dev"
          authService={authService()}
          partnerGateway={emptyLiveGateway()}
          adminGateway={adminGateway}
        />,
      )

      expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
      await waitFor(() => expect(window.location.hash).toBe('#performance'))
      expect(screen.getByRole('navigation', { name: 'Partner navigation' })).toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument()
      expect(getAdminContext).not.toHaveBeenCalled()
    },
  )

  it('keeps the Partner host authoritative over the Funnels & Links Admin route', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const adminGateway = emptyAdminGateway()
    const getAdminContext = vi.spyOn(adminGateway, 'getAdminContext')
    window.history.replaceState(null, '', '/#admin/funnels-links')

    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={authService()}
        partnerGateway={emptyLiveGateway()}
        adminGateway={adminGateway}
      />,
    )

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#performance'))
    expect(screen.getByRole('navigation', { name: 'Partner navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin navigation' })).not.toBeInTheDocument()
    expect(getAdminContext).not.toHaveBeenCalled()
    expect(document.title).toBe('Performance · KissMyApps Partners')
  })

  it('preserves the explicit product-configuration deep route through admin authentication', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
    })
    window.history.replaceState(null, '', '/#admin/products/product%2Fone/configuration')

    render(<App previewMode={false} authService={service} adminGateway={emptyAdminGateway()} />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Production setup' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Configuration contracts are not available' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#admin/products/product%2Fone/configuration')
    expect(document.title).toBe('Product configuration · KissMyApps Admin')
  })

  it('preserves an Affiliate detail deep route and returns to the directory when it closes', async () => {
    const user = userEvent.setup()
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('none'),
    })
    window.history.replaceState(null, '', '/#admin/affiliates/partner%2Fone')

    render(<App previewMode={false} authService={service} adminGateway={emptyAdminGateway()} />)

    const detailDialog = await screen.findByRole('dialog', { name: 'Affiliate details' })
    expect(window.location.hash).toBe('#admin/affiliates/partner%2Fone')
    expect(document.title).toBe('Affiliate details · KissMyApps Admin')

    await user.click(within(detailDialog).getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(window.location.hash).toBe('#admin/affiliates'))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Affiliate directory' }),
    ).toBeVisible()
    expect(
      within(screen.getByRole('navigation', { name: 'Admin navigation' })).getByRole('button', {
        name: 'Affiliates',
      }),
    ).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
    expect(document.title).toBe('Admin affiliates · KissMyApps Admin')
  })

  it('preserves an admin destination while asking an anonymous user to sign in', async () => {
    window.history.replaceState(null, '', '/#admin/products')

    render(<App previewMode={false} authService={authService()} />)

    expect(screen.getByText('YOUR ADMIN WORKSPACE')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Admin account access' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
    expect(document.title).toBe('Sign in · KissMyApps Admin')
  })

  it('preserves the password-reset route for a recovery session', () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: true,
    })
    window.history.replaceState(null, '', '/#auth/reset')

    render(<App previewMode={false} authService={authService()} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Choose a new password.' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#auth/reset')
    expect(document.title).toBe('Reset password · KissMyApps Partners')
  })

  it('opens Partner Performance after a password reset without requiring a refresh', async () => {
    const user = userEvent.setup()
    const recoverySession = {
      access_token: 'recovery-session',
      user: authenticatedUser,
    } as Session
    const signedInSession = {
      access_token: 'signed-in-session',
      user: authenticatedUser,
    } as Session
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      session: recoverySession,
      recoveryMode: true,
    })
    const service = authService({
      updatePassword: vi.fn(async () => ({
        session: signedInSession,
        activationStatus: 'active' as const,
      })),
    })
    window.history.replaceState(null, '', '/#auth/reset')

    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={service}
        partnerGateway={emptyLiveGateway()}
      />,
    )

    await user.type(screen.getByLabelText('New password'), 'new secure passphrase')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByRole('heading', { name: 'Your password is ready.' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Open partner dashboard' }))

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    expect(window.location.hash).toBe('#performance')
  })

  it('verifies an invite token hash, clears it from the URL, and requires password setup', async () => {
    const invitedSession = {
      ...authenticatedSession,
      recoveryMode: false,
    }
    const service = authService({
      acceptInvite: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(invitedSession)
        return invitedSession.session as Session
      }),
      getPartnerActivationStatus: vi.fn().mockResolvedValue('pending'),
    })
    window.history.replaceState(
      null,
      '',
      '/?campaign=qa&auth_action=invite&type=invite&token_hash=one-time-secret',
    )

    render(<App previewMode={false} authService={service} />)

    expect(service.acceptInvite).toHaveBeenCalledWith('one-time-secret')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Create your password.' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#auth/invite'))
    expect(window.location.search).toBe('?campaign=qa')
    expect(window.location.href).not.toContain('one-time-secret')
    expect(await screen.findByLabelText('New password')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open partner dashboard/i })).not.toBeInTheDocument()
  })

  it('confirms public signup, scrubs the one-time token, and opens Partner Performance', async () => {
    const confirmedSession = {
      ...authenticatedSession,
      recoveryMode: false,
    }
    const service = authService({
      confirmSignUp: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(confirmedSession)
        return confirmedSession.session as Session
      }),
    })
    window.history.replaceState(
      null,
      '',
      '/?campaign=qa&auth_action=signup&type=email&token_hash=confirmation-secret',
    )

    render(
      <App
        previewMode={false}
        workspaceHostname="partners.kissmyapps.dev"
        authService={service}
        partnerGateway={emptyLiveGateway()}
      />,
    )

    expect(service.confirmSignUp).toHaveBeenCalledWith('confirmation-secret')
    expect(screen.getByRole('heading', { name: 'Confirming your email…' })).toBeInTheDocument()
    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#performance'))
    expect(window.location.search).toBe('?campaign=qa')
    expect(window.location.href).not.toContain('confirmation-secret')
    expect(document.title).toBe('Performance · KissMyApps Partners')
  })

  it('verifies a public signup token only once under React Strict Mode', async () => {
    const confirmedSession = {
      ...authenticatedSession,
      recoveryMode: false,
    }
    const service = authService({
      confirmSignUp: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(confirmedSession)
        return confirmedSession.session as Session
      }),
    })
    window.history.replaceState(
      null,
      '',
      '/?auth_action=signup&type=email&token_hash=single-use-confirmation',
    )

    render(
      <StrictMode>
        <App previewMode={false} authService={service} partnerGateway={emptyLiveGateway()} />
      </StrictMode>,
    )

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    expect(service.confirmSignUp).toHaveBeenCalledOnce()
    expect(window.location.href).not.toContain('single-use-confirmation')
  })

  it('scrubs a rejected signup token and keeps a safe retry path', async () => {
    const service = authService({
      confirmSignUp: vi
        .fn()
        .mockRejectedValue(new Error('expired signup token with internal provider details')),
    })
    window.history.replaceState(
      null,
      '',
      '/?auth_action=signup&type=email&token_hash=rejected-confirmation',
    )

    render(<App previewMode={false} authService={service} />)

    expect(
      await screen.findByRole('heading', { name: 'This confirmation link can’t be used.' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The account service returned an unexpected response. Please try again.',
    )
    expect(window.location.hash).toBe('#auth/sign-up')
    expect(window.location.href).not.toContain('rejected-confirmation')
    expect(screen.queryByText(/internal provider/i)).not.toBeInTheDocument()
  })

  it('verifies an invite only once when React replays effects in Strict Mode', async () => {
    const invitedSession = {
      ...authenticatedSession,
      recoveryMode: false,
    }
    const service = authService({
      acceptInvite: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(invitedSession)
        return invitedSession.session as Session
      }),
      getPartnerActivationStatus: vi.fn().mockResolvedValue('pending'),
    })
    window.history.replaceState(
      null,
      '',
      '/?auth_action=invite&type=invite&token_hash=single-use-secret',
    )

    render(
      <StrictMode>
        <App previewMode={false} authService={service} />
      </StrictMode>,
    )

    expect(await screen.findByLabelText('New password')).toBeInTheDocument()
    expect(service.acceptInvite).toHaveBeenCalledOnce()
    expect(window.location.href).not.toContain('single-use-secret')
  })

  it('forces a pending invited member away from a stale sign-in route', async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    const service = authService({
      getPartnerActivationStatus: vi.fn().mockResolvedValue('pending'),
    })
    window.history.replaceState(null, '', '/#auth/sign-in')

    render(<App previewMode={false} authService={service} />)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Create your password.' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'You’re signed in.' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open partner dashboard/i })).not.toBeInTheDocument()
  })

  it('opens Partner Performance immediately after password setup rotates the session', async () => {
    const user = userEvent.setup()
    const sessionA = {
      access_token: 'pending-session',
      user: authenticatedUser,
    } as Session
    const sessionB = {
      access_token: 'activated-session',
      user: { ...authenticatedUser },
    } as Session
    const pendingState: AuthSessionState = {
      ...authenticatedSession,
      session: sessionA,
      user: sessionA.user,
      recoveryMode: false,
    }
    const activatedState: AuthSessionState = {
      ...authenticatedSession,
      session: sessionB,
      user: sessionB.user,
      recoveryMode: false,
    }
    const statusAfterRotation = new Promise<'active'>(() => undefined)
    const service = authService({
      getPartnerActivationStatus: vi
        .fn()
        .mockResolvedValueOnce('pending')
        .mockReturnValue(statusAfterRotation),
      updatePassword: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(activatedState)
        return { session: sessionB, activationStatus: 'active' as const }
      }),
    })
    vi.mocked(useAuthSession).mockReturnValue(pendingState)
    window.history.replaceState(null, '', '/#auth/invite')

    render(<App previewMode={false} authService={service} partnerGateway={emptyLiveGateway()} />)

    await user.type(await screen.findByLabelText('New password'), 'new secure passphrase')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Set password' }))

    expect(
      await screen.findByRole('heading', { name: 'Your partner account is ready.' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open partner dashboard' }))

    expect(await screen.findByText('No products are connected yet')).toBeInTheDocument()
    expect(window.location.hash).toBe('#performance')
  })

  it('disables sign-out while pending and returns to sign-in after success', async () => {
    const user = userEvent.setup()
    let finishSignOut!: () => void
    const pendingSignOut = new Promise<void>((resolve) => {
      finishSignOut = resolve
    })
    const service = authService({
      signOut: vi.fn(async () => {
        await pendingSignOut
        vi.mocked(useAuthSession).mockReturnValue(anonymousSession)
      }),
    })
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    render(<App previewMode={false} authService={service} />)

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(screen.getByRole('button', { name: 'Signing out' })).toBeDisabled()
    finishSignOut()

    await waitFor(() => expect(service.signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeInTheDocument()
  })

  it('sanitizes unexpected sign-out failures and keeps the dashboard open', async () => {
    const user = userEvent.setup()
    const service = authService({
      signOut: vi.fn().mockRejectedValue(new Error('service-role secret leaked by provider')),
    })
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    render(<App previewMode={false} authService={service} />)

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    const safeError = await screen.findByText(
      'The account service returned an unexpected response. Please try again.',
    )
    expect(safeError.closest('[role="alert"]')).toBeInTheDocument()
    expect(screen.queryByText(/service-role secret/i)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
  })
})

describe('partner workspace preview', () => {
  it('labels sample data and exposes the four partner areas', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(screen.getByText('Sample data only. Not connected to Supabase.')).toBeInTheDocument()
    expect(navigation().getAllByRole('link')).toHaveLength(4)
    expect(navigation().getByRole('link', { name: 'Performance' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('rowheader', { name: 'Direct / untagged' })).toBeInTheDocument()
    expect(screen.getByText('Before payout adjustments')).toBeInTheDocument()
  })

  it('supports an empty account without inventing a product, funnel, or live link', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Empty account' }))
    expect(screen.getByText('Your story starts with a click')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export report' })).toBeDisabled()
    await user.click(navigation().getByRole('link', { name: 'Links & Sources' }))
    expect(screen.getByText('Your first link is ahead of you')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create sample link' })).toBeDisabled()
    expect(screen.queryByText('Example product · Sample funnel')).not.toBeInTheDocument()
    await user.click(navigation().getByRole('link', { name: 'Payouts' }))
    expect(screen.getByText('Your first cycle is ahead')).toBeInTheDocument()
    expect(screen.queryByText('•••• 4821')).not.toBeInTheDocument()
  })

  it('changes reporting periods and filters without changing payout scope', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reporting period' }), '14')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Traffic source' }),
      'Social media',
    )
    const expected = money(
      aggregateReport(
        filterReportingRecords({
          ...defaultReportingFilters,
          period: '14',
          source: 'Social media',
        }),
      ).earningsMinor!,
    )
    expect(
      within(screen.getByRole('region', { name: 'Performance summary' })).getByText(expected),
    ).toBeInTheDocument()
    expect(screen.getByText('Aug 13 – Aug 26, 2026')).toBeInTheDocument()
    expect(screen.getAllByRole('rowheader')).toHaveLength(2) // One source plus full-selection totals.
    expect(screen.getByText('Current period · All sources')).toBeInTheDocument()
  })

  it('distinguishes no filter matches from an empty account and can reset', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    await user.type(screen.getByRole('textbox', { name: 'Sub ID' }), 'does-not-exist')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(screen.getByText('No activity matches these filters')).toBeInTheDocument()
    expect(screen.getByText('No matching results')).toBeInTheDocument()
    expect(screen.queryByText('Your story starts with a click')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export report' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Clear report filters' }))
    expect(screen.getAllByRole('rowheader')).toHaveLength(6)
  })

  it('groups reports by date and paginates the complete result', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Report breakdown' }), 'date')
    await user.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.getAllByRole('rowheader')).toHaveLength(8)
    expect(screen.getByRole('rowheader', { name: 'Jul 28' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next report rows' }))
    expect(screen.getByRole('rowheader', { name: 'Aug 4' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(screen.getAllByRole('rowheader')).toHaveLength(3)
    expect(screen.getByRole('rowheader', { name: 'Aug 2026' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next report rows' })).toBeDisabled()
  })

  it('keeps unavailable data distinct from zero and retries only the preview', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<App />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Preview data state' }), 'error')
    expect(screen.getByText('This report is temporarily unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Performance summary' })).not.toBeInTheDocument()
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry preview' }))
    expect(screen.getByRole('region', { name: 'Performance summary' })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('announces loading and exposes missing attribution metrics as dashes', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preview data state' }),
      'loading',
    )
    expect(screen.getByRole('status', { name: 'Loading performance preview' })).toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Preview data state' }),
      'partial',
    )
    await user.click(screen.getByText('Explore more metrics'))
    expect(
      screen.getByText('Some attribution data is unavailable in this preview.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Confirmed installs' })).toHaveTextContent('—')
    expect(screen.getByRole('article', { name: 'App activations' })).toHaveTextContent('—')
  })

  it('keeps skip-link navigation on the current page and focuses main', async () => {
    const user = userEvent.setup()
    openPage('payouts')
    await user.click(screen.getByRole('link', { name: 'Skip to content' }))
    expect(window.location.hash).toBe('#payouts')
    expect(screen.getByRole('main')).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Payouts.', level: 1 })).toBeInTheDocument()
  })

  it('closes dialogs with Escape and restores focus to the opener', async () => {
    const user = userEvent.setup()
    render(<App />)
    const opener = screen.getByRole('button', { name: 'Filters' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Refine your report' })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('moves focus into main after navigation from the mobile menu', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const mobileNavigation = within(
      screen.getByRole('navigation', { name: 'Mobile partner navigation' }),
    )
    await user.click(mobileNavigation.getByRole('link', { name: 'Links & Sources' }))
    expect(screen.getByRole('heading', { name: 'Links & Sources.', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('restores focus to visible main content if the dialog opener becomes hidden', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sidebar = screen.getByRole('complementary', { name: 'Partner workspace sidebar' })
    await user.click(screen.getByRole('button', { name: 'Partner guide' }))
    sidebar.style.display = 'none'
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
  })
})

describe('payouts preview', () => {
  it('filters history and shows a truthful sample statement', async () => {
    const user = userEvent.setup()
    openPage('payouts')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payout status' }), 'paid')
    expect(screen.getAllByRole('rowheader')).toHaveLength(5)
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 3' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('SAMPLE STATEMENT')).toBeInTheDocument()
    expect(within(dialog).getByText(/No transfer occurred/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Download sample CSV' })).toBeEnabled()
  })

  it('does not issue a statement for open earnings', async () => {
    const user = userEvent.setup()
    openPage('payouts')
    await user.click(screen.getByRole('button', { name: 'View payout for Aug 17' }))
    expect(screen.getByRole('button', { name: 'Download sample CSV' })).toBeDisabled()
    expect(screen.getByText('Not issued')).toBeInTheDocument()
  })

  it('opens payout preferences from the payment-destination action', async () => {
    const user = userEvent.setup()
    openPage('payouts')
    await user.click(screen.getByRole('button', { name: 'View payout preferences' }))
    expect(screen.getByRole('button', { name: 'Payout preferences' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('textbox', { name: 'Account holder' })).toHaveAttribute('readonly')
    expect(window.location.hash).toBe('#profile/payment')
    expect(
      screen.getByText('A first crypto payout also requires a test transfer.'),
    ).toBeInTheDocument()
  })
})

describe('links preview', () => {
  it('searches links and copies only a reserved non-live URL', async () => {
    const user = userEvent.setup()
    const copySpy = vi.spyOn(navigator.clipboard, 'writeText')
    openPage('links')
    await user.type(screen.getByRole('textbox', { name: 'Search links' }), 'newsletter')
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Copy sample Weekly newsletter link' }))
    expect(copySpy).toHaveBeenCalledWith(
      'https://go.example.invalid/r/preview-partner/newsletter?campaign=Example+launch&funnel=Example+funnel+A&sub1=placement-3',
    )
    expect(
      screen.getByText('Sample link copied. This .invalid URL is not live.'),
    ).toBeInTheDocument()
  })

  it('offers a selectable URL when clipboard access fails', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Copy sample Social bio link' }))
    expect(await screen.findByRole('dialog', { name: 'Social bio' })).toHaveAccessibleDescription(
      'Clipboard is unavailable. Select and copy the sample URL from link details.',
    )
    expect(screen.getByRole('textbox', { name: 'Sample tracked URL' })).toHaveValue(
      'https://go.example.invalid/r/preview-partner/social-media?campaign=Example+launch&funnel=Example+funnel+A&sub1=placement-1',
    )
    expect(screen.getByText(/Clipboard is unavailable/)).toBeInTheDocument()
  })

  it('validates, adds, and pauses a link only in memory', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Create sample link' }))
    await user.type(screen.getByRole('textbox', { name: 'Link name' }), 'Example placement')
    const subId = screen.getByRole('textbox', { name: /^Sub ID/ })
    await user.type(subId, 'invalid value')
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Use 1–64 letters')
    expect(subId).toHaveFocus()
    expect(subId).toHaveAttribute('aria-invalid', 'true')
    await user.clear(subId)
    await user.type(subId, 'placement-test')
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    expect(screen.getByRole('rowheader', { name: /Example placement/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View Example placement link details' }))
    await user.click(screen.getByRole('button', { name: 'Pause sample link' }))
    expect(screen.getByRole('button', { name: 'Activate sample link' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(navigation().getByRole('link', { name: 'Payouts' }))
    await user.click(navigation().getByRole('link', { name: 'Links & Sources' }))
    const row = screen.getByRole('rowheader', { name: /Example placement/ }).closest('tr')!
    expect(within(row).getByText('Paused')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('profile preview', () => {
  it('saves normalized profile changes for this session without leaving a dirty form', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    openPage('profile')
    const name = screen.getByRole('textbox', { name: 'Full name' })
    await user.clear(name)
    await user.type(name, '  Example Person  ')
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(name).toHaveValue('Example Person')
    expect(screen.getByText('No unsaved preview changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save preview changes' })).toBeDisabled()
    expect(screen.getByText(/No account changes were saved/)).toBeInTheDocument()
    await user.click(navigation().getByRole('link', { name: 'Payouts' }))
    await user.click(navigation().getByRole('link', { name: 'Profile & Documents' }))
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Example Person')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('discards unsaved changes and rejects whitespace-only names', async () => {
    const user = userEvent.setup()
    openPage('profile')
    const name = screen.getByRole('textbox', { name: 'Full name' })
    await user.clear(name)
    await user.type(name, '   ')
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name and public partner name.')
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Enter a name and public partner name.')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(name).toHaveValue('Preview partner')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('previews document metadata without real signatures or uploads', async () => {
    const user = userEvent.setup()
    openPage('profile/documents')
    expect(screen.getByRole('button', { name: 'Documents' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Document status' }), 'Signed')
    await user.click(screen.getByRole('button', { name: 'Preview Partner agreement v1' }))
    expect(screen.getByRole('dialog', { name: 'Partner agreement · v1' })).toBeInTheDocument()
    expect(screen.getByText(/No agreement has been issued or signed/)).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Empty account' }))
    expect(screen.getByText('A fresh start. No paperwork yet.')).toBeInTheDocument()
  })

  it('does not collect passwords or pretend to create authenticated sessions', () => {
    openPage('profile/security')
    expect(screen.getByRole('button', { name: 'No authenticated session' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Available after connection' })).toBeDisabled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText(/This UI preview is not an authentication system/)).toBeInTheDocument()
  })
})

describe('automated accessibility structure (jsdom, not visual QA)', () => {
  it.each([
    'performance',
    'payouts',
    'links',
    'profile',
    'profile/payment',
    'profile/documents',
    'profile/security',
  ])('has no detected structural violations on %s', async (page) => {
    const { container } = openPage(page)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(
      results.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
    ).toEqual([])
  })
})
