import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../App'
import { explicitWorkspaceFromHash } from '../../../routing/workspace'
import type { PartnerAuthService } from '../../auth/authService'
import type { AuthSessionState } from '../../auth/authSession'
import { useAuthSession } from '../../auth/authSession'
import {
  emptyPartnerDashboardSummary,
  emptyPartnerPayoutSummary,
  type PartnerDataGateway,
  type PartnerDataResult,
  type PartnerProfile,
} from '../api'
import { readMembership, readPartnerMarketplace, readPartnerProgramView } from './programs'
import { peekWantedProgram, rememberWantedProgram } from './wantedProgram'

/**
 * The Marketplace page inside the partner dashboard: its place in the navigation, its two
 * addresses, and a signed-out visitor being taken to the program they wanted after they sign
 * in or register.
 */

vi.mock('../../auth/authSession', () => ({ useAuthSession: vi.fn() }))

const anonymousSession: AuthSessionState = {
  status: 'anonymous',
  session: null,
  user: null,
  recoveryMode: false,
  message: null,
}

const user_ = {
  id: 'partner-user',
  email: 'ana@example.com',
  user_metadata: { public_name: 'Ana Creator' },
} as unknown as NonNullable<AuthSessionState['user']>

const supabaseSession = { access_token: 'partner-session', user: user_ } as Session

const authenticatedSession: AuthSessionState = {
  status: 'authenticated',
  session: supabaseSession,
  user: user_,
  recoveryMode: false,
  message: null,
}

function authService(overrides: Partial<PartnerAuthService> = {}): PartnerAuthService {
  return {
    signIn: vi.fn().mockResolvedValue({ session: supabaseSession, activationStatus: 'active' }),
    signUp: vi.fn().mockResolvedValue(undefined),
    confirmSignUp: vi.fn().mockResolvedValue(supabaseSession),
    acceptInvite: vi.fn().mockResolvedValue(supabaseSession),
    requestPasswordRecovery: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi
      .fn()
      .mockResolvedValue({ session: supabaseSession, activationStatus: 'active' }),
    getPartnerActivationStatus: vi.fn().mockResolvedValue('active'),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const SHA = 'a'.repeat(64)

const card = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: null,
  brand_name: 'SpeakSix Ltd',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 1,
}

const membershipRow = {
  id: 'mem-1',
  program_id: 'prog-1',
  program: card,
  program_status: 'live',
  status: 'active',
  terms_version: 1,
  accepted_at: '2026-11-13T13:52:14.059098+00:00',
  needs_new_terms: false,
  link: {
    url: 'https://go.kissmyapps.dev/r/ana-creator/k3x9q2',
    short_url: 'https://go.kissmyapps.dev/speaksix/ana',
    working: true,
  },
  requested_at: '2026-11-13T13:52:14.059098+00:00',
  activated_at: '2026-11-13T13:52:14.059098+00:00',
  ended_at: null,
  decision_note: null,
}

const programView = {
  program: {
    ...card,
    id: 'prog-1',
    status: 'live',
    landing_url: 'https://speaksix.com/start',
    agreement: {
      title: 'SpeakSix Affiliate Agreement',
      brand_name: 'SpeakSix Ltd',
      program_name: 'SpeakSix',
      summary: [{ label: 'Commission', value: '30% of every payment for 12 months' }],
      sections: [{ heading: '1. Commission', paragraphs: ['You earn 30% of every payment.'] }],
      extra_terms: null,
    },
    agreement_sha256: SHA,
  },
  membership: null,
  accept_name: 'Ana Creator',
}

function result<T>(data: T, status: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status, error: null }
}

/** A creator with no products yet, and a marketplace with one program in it. */
function liveGateway(memberships: unknown[] = []) {
  const profile: PartnerProfile = {
    email: 'ana@example.com',
    fullName: 'Ana Creator',
    publicName: 'Ana Creator',
    legalName: 'Ana Creator',
    entityType: 'Individual',
    countryCode: 'PT',
    timezone: 'Europe/Lisbon',
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
  const getMarketplace = vi.fn(async () => ({
    data: readPartnerMarketplace({ tracking_ready: true, programs: [card], memberships }),
    status: 'ready' as const,
    error: null,
  }))
  const getProgram = vi.fn(async (slug: string) => {
    void slug
    return { data: readPartnerProgramView(programView), status: 'ready' as const, error: null }
  })
  const joinProgram = vi.fn(async () => ({
    data: readMembership(membershipRow),
    status: 'ready' as const,
    error: null,
  }))
  const gateway: PartnerDataGateway = {
    getCurrentPartnerProfile: async () => result(profile, 'ready'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    getProducts: async () => result([], 'empty'),
    getLinkDirectory: async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    getMarketplace,
    getProgram,
    joinProgram,
  }
  return { gateway, getMarketplace, getProgram, joinProgram }
}

function navigation() {
  return within(screen.getByRole('navigation', { name: 'Partner navigation' }))
}

function openDashboard(address: string, gateway: PartnerDataGateway, service = authService()) {
  window.history.replaceState(null, '', address)
  return render(
    <App
      previewMode={false}
      workspaceHostname="partners.kissmyapps.dev"
      authService={service}
      partnerGateway={gateway}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.mocked(useAuthSession).mockReturnValue(anonymousSession)
})

describe('Marketplace in the partner dashboard', () => {
  it('is a partner address, with or without a program', () => {
    expect(explicitWorkspaceFromHash('#marketplace')).toBe('partner')
    expect(explicitWorkspaceFromHash('#marketplace/speaksix')).toBe('partner')
  })

  it('has its own entry in the navigation, between links and the profile', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { gateway } = liveGateway()
    openDashboard('/#performance', gateway)

    await screen.findByRole('heading', { level: 1, name: 'Performance.' })
    expect(
      navigation()
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Performance', '#performance'],
      ['Payouts', '#payouts'],
      ['Links & Sources', '#links'],
      ['Marketplace', '#marketplace'],
      ['Profile & Documents', '#profile'],
    ])
  })

  it('opens the list at #marketplace for a creator with no products yet', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { gateway, getMarketplace } = liveGateway([membershipRow])
    const { container } = openDashboard('/#marketplace', gateway)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Marketplace.' }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Your programs' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View program: SpeakSix' })).toHaveAttribute(
      'href',
      '#marketplace/speaksix',
    )
    expect(navigation().getByRole('link', { name: 'Marketplace' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(document.title).toBe('Marketplace · KissMyApps Partners')
    expect(getMarketplace).toHaveBeenCalled()
    expect(screen.queryByText('No products are connected yet')).not.toBeInTheDocument()

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map(({ id }) => id)).toEqual([])
  })

  it('opens one program at #marketplace/<slug> and names it in the title', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { gateway, getProgram } = liveGateway()
    const { container } = openDashboard('/#marketplace/speaksix', gateway)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(getProgram).toHaveBeenCalledWith('speaksix')
    await waitFor(() => expect(document.title).toBe('SpeakSix · KissMyApps Partners'))
    expect(navigation().getByRole('link', { name: 'Marketplace' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(window.location.hash).toBe('#marketplace/speaksix')

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map(({ id }) => id)).toEqual([])
  })

  it('moves between a program and the list as the address changes', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const user = userEvent.setup()
    const { gateway } = liveGateway()
    openDashboard('/#marketplace', gateway)

    await user.click(await screen.findByRole('link', { name: 'View program: SpeakSix' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#marketplace/speaksix')

    await user.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Marketplace',
      }),
    )
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Marketplace.' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Marketplace · KissMyApps Partners'))
  })

  it('treats a malformed program address as the list', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { gateway, getProgram } = liveGateway()
    openDashboard('/#marketplace/Not%20A%20Slug', gateway)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Marketplace.' }),
    ).toBeInTheDocument()
    expect(getProgram).not.toHaveBeenCalled()
  })

  it('is not part of the design preview, which has sample data only', () => {
    window.history.replaceState(null, '', '/#marketplace/speaksix')
    render(<App />)

    expect(screen.getByRole('heading', { level: 1, name: 'Performance.' })).toBeInTheDocument()
    expect(navigation().queryByRole('link', { name: 'Marketplace' })).not.toBeInTheDocument()
    expect(peekWantedProgram()).toBeNull()
  })
})

describe('arriving signed out to join a program', () => {
  it('asks for sign-in, keeps the program, and opens it afterwards', async () => {
    const user = userEvent.setup()
    const { gateway, getProgram } = liveGateway()
    const service = authService({
      signIn: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
        return { session: supabaseSession, activationStatus: 'active' as const }
      }),
    })
    openDashboard('/#marketplace/speaksix', gateway, service)

    await waitFor(() => expect(window.location.hash).toBe('#auth/sign-in'))
    expect(peekWantedProgram()).toBe('speaksix')
    expect(getProgram).not.toHaveBeenCalled()

    await user.type(await screen.findByLabelText('Email address'), 'ana@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-phrase')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await user.click(await screen.findByRole('button', { name: 'Open partner dashboard' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#marketplace/speaksix')
    expect(getProgram).toHaveBeenCalledWith('speaksix')
    // It is handed over once: the next sign-in opens the dashboard as usual.
    expect(peekWantedProgram()).toBeNull()
  })

  it('remembers the program named by the public page’s links and takes it out of the address', async () => {
    const { gateway } = liveGateway()
    openDashboard('/?campaign=qa&program=speaksix#auth/sign-up', gateway)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Create your partner account.' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(window.location.search).toBe('?campaign=qa'))
    expect(window.location.hash).toBe('#auth/sign-up')
    expect(peekWantedProgram()).toBe('speaksix')
  })

  it('ignores a program in the address that is not a slug', async () => {
    const { gateway } = liveGateway()
    openDashboard('/?program=..%2Fadmin#auth/sign-in', gateway)

    await screen.findByLabelText('Email address')
    expect(peekWantedProgram()).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('opens the program after a new creator confirms their email', async () => {
    rememberWantedProgram('speaksix')
    const { gateway, getProgram } = liveGateway()
    const service = authService({
      confirmSignUp: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
        return supabaseSession
      }),
    })
    openDashboard('/?auth_action=signup&type=email&token_hash=confirmation-value', gateway, service)

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#marketplace/speaksix')
    expect(window.location.href).not.toContain('confirmation-value')
    expect(getProgram).toHaveBeenCalledWith('speaksix')
    expect(peekWantedProgram()).toBeNull()
  })

  it('still opens Performance after sign-in when no program was wanted', async () => {
    const user = userEvent.setup()
    const { gateway } = liveGateway()
    const service = authService({
      signIn: vi.fn(async () => {
        vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
        return { session: supabaseSession, activationStatus: 'active' as const }
      }),
    })
    openDashboard('/#auth/sign-in', gateway, service)

    await user.type(await screen.findByLabelText('Email address'), 'ana@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-phrase')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await user.click(await screen.findByRole('button', { name: 'Open partner dashboard' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Performance.' }),
    ).toBeInTheDocument()
    expect(window.location.hash).toBe('#performance')
  })

  it('forgets the wanted program once a signed-in creator is on it', async () => {
    rememberWantedProgram('speaksix')
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { gateway } = liveGateway()
    openDashboard('/#marketplace/speaksix', gateway)

    await screen.findByRole('heading', { level: 1, name: 'Join SpeakSix' })
    await waitFor(() => expect(peekWantedProgram()).toBeNull())
  })

  it('joins from inside the dashboard and shows the link', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const user = userEvent.setup()
    const { gateway, joinProgram } = liveGateway()
    openDashboard('/#marketplace/speaksix', gateway)

    await user.click(
      await screen.findByRole('checkbox', { name: 'I have read and agree to this agreement' }),
    )
    await user.click(screen.getByRole('button', { name: 'Accept and get my link' }))

    expect(joinProgram).toHaveBeenCalledExactlyOnceWith({
      slug: 'speaksix',
      termsVersion: 1,
      agreementSha256: SHA,
    })
    expect(await screen.findByText('You joined SpeakSix.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
