import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbeddedPayoutSetup } from './EmbeddedPayoutSetup'
import {
  createConnectGateway,
  ConnectReauthenticationRequired,
  ConnectMfaRequired,
  type ConnectClient,
  mapConnectSession,
  type ConnectSession,
  type ConnectStatus,
} from './connect'
import { logoutEmbeddedConnectSessions, rememberEmbeddedConnectSession } from './embedded-connect'

const stripe = vi.hoisted(() => ({ initialize: vi.fn() }))
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: stripe.initialize }))

const session = (): ConnectSession => ({
  binding_id: 'test',
  connected_account_id: 'acct_creator',
  platform_account_id: 'acct_platform',
  livemode: false,
  publishable_key: 'pk_test_fixture',
  client_secret: 'fixture_initial_secret',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
})
const response = () => ({
  enabled: true,
  bindings: [
    {
      binding_id: 'test',
      platform_account_id: 'acct_platform',
      connected_account_id: 'acct_creator',
      livemode: false,
      details_submitted: false,
      transfers_enabled: false,
      payouts_enabled: false,
      allowed_countries: ['US'],
      allowed_transfer_currencies: [],
      eligibility_reason: null,
      status: 'needs_information',
      requirements_due: ['external_account'],
      disabled_reason: null,
      verified_at: null,
      eligibility: {
        source: 'stripe_country_specs',
        verified_at: new Date().toISOString(),
        platform_country: 'US',
        countries: [{ country: 'US', settlement_currencies: ['USD'] }],
      },
    },
  ],
  account_session: session(),
})
function fixture() {
  const callbacks: {
    fetch?: () => Promise<string>
    load?: () => void
    error?: () => void
    exit?: () => void
  } = {}
  const element = Object.assign(document.createElement('div'), {
    setOnLoaderStart: (fn: () => void) => {
      callbacks.load = fn
    },
    setOnLoadError: (fn: () => void) => {
      callbacks.error = fn
    },
    setOnExit: (fn: () => void) => {
      callbacks.exit = fn
    },
    setCollectionOptions: vi.fn(),
  })
  element.textContent = 'Provider secure form'
  const instance = { create: vi.fn(() => element), logout: vi.fn(async () => {}) }
  stripe.initialize.mockImplementation((input) => {
    callbacks.fetch = input.fetchClientSecret
    return instance
  })
  const gateway = {
    status: vi.fn(async () => response() as ConnectStatus),
    session: vi.fn(async () => ({ ...session(), client_secret: 'fixture_refreshed_secret' })),
  }
  return { callbacks, element, instance, gateway }
}
afterEach(async () => {
  await logoutEmbeddedConnectSessions()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('secure embedded payout setup', () => {
  it('finishes sign-out after two seconds when an old Stripe iframe never logs out', async () => {
    vi.useFakeTimers()
    try {
      const stalled = { logout: vi.fn(() => new Promise<void>(() => {})) }
      const complete = { logout: vi.fn(async () => {}) }
      rememberEmbeddedConnectSession(stalled)
      rememberEmbeddedConnectSession(complete)
      const finished = vi.fn()
      const cleanup = logoutEmbeddedConnectSessions().then(finished)
      await vi.advanceTimersByTimeAsync(1999)
      expect(finished).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await cleanup
      expect(finished).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      await logoutEmbeddedConnectSessions()
      expect(stalled.logout).toHaveBeenCalledOnce()
      expect(complete.logout).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('clears the cleanup timer immediately when Stripe logout succeeds or rejects', async () => {
    vi.useFakeTimers()
    try {
      rememberEmbeddedConnectSession({ logout: async () => {} })
      rememberEmbeddedConnectSession({
        logout: async () => {
          throw Error('iframe unavailable')
        },
      })
      await logoutEmbeddedConnectSessions()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('renders inline, refreshes expired sessions on demand, and reloads status through exit', async () => {
    const save = vi.fn()
    vi.stubGlobal('localStorage', { setItem: save })
    vi.stubGlobal('sessionStorage', { setItem: save })
    const f = fixture(),
      onExit = vi.fn()
    render(<EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={onExit} />)
    await screen.findByText('Provider secure form')
    expect(f.instance.create).toHaveBeenCalledWith('account-onboarding')
    expect(f.element.setCollectionOptions).toHaveBeenCalledWith({
      fields: 'currently_due',
      futureRequirements: 'omit',
    })
    await expect(f.callbacks.fetch!()).resolves.toBe('fixture_initial_secret')
    expect(f.gateway.session).not.toHaveBeenCalled()
    await expect(f.callbacks.fetch!()).resolves.toBe('fixture_refreshed_secret')
    expect(f.gateway.session).toHaveBeenCalledWith('test')
    act(() => f.callbacks.load!())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => f.callbacks.exit!())
    expect(onExit).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })
  it('does not consume an already expired initial session', async () => {
    const f = fixture()
    render(
      <EmbeddedPayoutSetup
        session={{ ...session(), expires_at: 1 }}
        gateway={f.gateway}
        onExit={vi.fn()}
      />,
    )
    await screen.findByText('Provider secure form')
    await expect(f.callbacks.fetch!()).resolves.toBe('fixture_refreshed_secret')
    expect(f.gateway.session).toHaveBeenCalledOnce()
  })
  it('rejects a refreshed session for a different creator and offers retry', async () => {
    const f = fixture()
    f.gateway.session.mockResolvedValueOnce({ ...session(), connected_account_id: 'acct_other' })
    render(<EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={vi.fn()} />)
    await screen.findByText('Provider secure form')
    await f.callbacks.fetch!()
    await act(async () => {
      await expect(f.callbacks.fetch!()).rejects.toThrow('could not be refreshed')
    })
    expect(screen.getByRole('alert')).toHaveTextContent('could not load')
    await userEvent.click(screen.getByRole('button', { name: 'Retry payout setup' }))
    await waitFor(() => expect(stripe.initialize).toHaveBeenCalledTimes(2))
    await expect(f.callbacks.fetch!()).resolves.toBe('fixture_refreshed_secret')
    expect(f.element.setCollectionOptions).toHaveBeenLastCalledWith({
      fields: 'currently_due',
      futureRequirements: 'omit',
    })
  })
  it('handles provider load failures without exposing raw provider errors', async () => {
    const f = fixture()
    render(<EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={vi.fn()} />)
    await screen.findByText('Provider secure form')
    act(() => f.callbacks.error!())
    expect(screen.getByRole('alert')).toHaveTextContent('Your submitted details are kept by Stripe')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('leaves Stripe visible to show its own error after the form has displayed', async () => {
    const f = fixture()
    render(<EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={vi.fn()} />)
    await screen.findByText('Provider secure form')
    act(() => f.callbacks.load!())
    act(() => f.callbacks.error!())
    expect(screen.getByRole('alert')).toBeVisible()
    expect(f.element).toBeVisible()
    expect(stripe.initialize).toHaveBeenCalledOnce()
  })
  it('keeps a slow iframe visible and recovers when Stripe eventually displays it', async () => {
    const f = fixture()
    vi.useFakeTimers()
    try {
      render(<EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={vi.fn()} />)
      await act(async () => {})
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(screen.getByRole('alert')).toHaveTextContent('taking longer')
      expect(f.element).toBeVisible()
      expect(stripe.initialize).toHaveBeenCalledOnce()
      act(() => f.callbacks.load!())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(f.element).toBeVisible()
      expect(f.instance.logout).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(stripe.initialize).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not hide a fresh retry on a stale provider error and accepts its later loader event', async () => {
    const first = fixture()
    render(<EmbeddedPayoutSetup session={session()} gateway={first.gateway} onExit={vi.fn()} />)
    await screen.findByText('Provider secure form')
    await first.callbacks.fetch!()
    act(() => first.callbacks.error!())
    const next = fixture()
    await userEvent.click(screen.getByRole('button', { name: 'Retry payout setup' }))
    await waitFor(() => expect(stripe.initialize).toHaveBeenCalledTimes(2))
    await expect(next.callbacks.fetch!()).resolves.toBe('fixture_refreshed_secret')
    // Stripe's custom-element bootstrap can report the first instance's failed
    // auth promise even though this element is connected to the fresh instance.
    act(() => next.callbacks.error!())
    expect(next.element).toBeVisible()
    act(() => next.callbacks.load!())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(next.element).toBeVisible()
    // Events queued by the removed attempt cannot alter the current attempt.
    act(() => {
      first.callbacks.error!()
      first.callbacks.load!()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(next.element).toBeVisible()
    expect(first.element.isConnected).toBe(false)
    expect(first.instance.logout).not.toHaveBeenCalled()
    expect(next.instance.logout).not.toHaveBeenCalled()
  })
  it('requests a fresh token when retrying before the SDK consumes the initial token', async () => {
    const first = fixture()
    render(<EmbeddedPayoutSetup session={session()} gateway={first.gateway} onExit={vi.fn()} />)
    await screen.findByText('Provider secure form')
    act(() => first.callbacks.error!())
    const next = fixture()
    await userEvent.click(screen.getByRole('button', { name: 'Retry payout setup' }))
    await waitFor(() => expect(stripe.initialize).toHaveBeenCalledTimes(2))
    await expect(next.callbacks.fetch!()).resolves.toBe('fixture_refreshed_secret')
    expect(first.gateway.session).toHaveBeenCalledOnce()
  })
  it('returns an expired authentication session to the inline identity confirmation', async () => {
    const f = fixture(),
      onReauthenticate = vi.fn()
    f.gateway.session.mockRejectedValueOnce(new ConnectReauthenticationRequired())
    render(
      <EmbeddedPayoutSetup
        session={session()}
        gateway={f.gateway}
        onExit={vi.fn()}
        onReauthenticate={onReauthenticate}
      />,
    )
    await screen.findByText('Provider secure form')
    await f.callbacks.fetch!()
    await expect(f.callbacks.fetch!()).rejects.toThrow('could not be refreshed')
    expect(onReauthenticate).toHaveBeenCalledOnce()
    expect(screen.queryByText(/secure window/)).not.toBeInTheDocument()
  })
  it('removes the form on navigation, blocks late refreshes, and invalidates sessions only at sign-out', async () => {
    const f = fixture()
    const view = render(
      <EmbeddedPayoutSetup session={session()} gateway={f.gateway} onExit={vi.fn()} />,
    )
    await screen.findByText('Provider secure form')
    view.unmount()
    expect(f.element.isConnected).toBe(false)
    expect(f.instance.logout).not.toHaveBeenCalled()
    await expect(f.callbacks.fetch!()).rejects.toThrow()
    expect(f.gateway.session).not.toHaveBeenCalled()
    await logoutEmbeddedConnectSessions()
    expect(f.instance.logout).toHaveBeenCalledOnce()
  })
})

describe('embedded session client contract', () => {
  it('recognizes only the server recent-auth rejection and retains no hosted flow', async () => {
    const invoke = vi.fn(async () => ({
      data: null,
      error: {
        context: new Response(JSON.stringify({ error: 'reauthentication_required' }), {
          status: 403,
        }),
      },
    }))
    const gateway = createConnectGateway({ functions: { invoke } })
    await expect(gateway.session('test')).rejects.toBeInstanceOf(ConnectReauthenticationRequired)
    expect('onboard' in gateway).toBe(false)
  })
  it('submits only the selected binding/country and keeps the secret out of status', async () => {
    const invoke = vi.fn(async () => ({ data: response(), error: null }))
    const gateway = createConnectGateway({ functions: { invoke } })
    expect((await gateway.session('test', 'US')).connected_account_id).toBe('acct_creator')
    expect(invoke).toHaveBeenCalledWith('creator-connect', {
      body: { action: 'session', binding_id: 'test', country: 'US' },
    })
    expect(JSON.stringify(await gateway.status())).not.toContain('fixture_initial_secret')
  })
  it('rejects wrong account/mode/platform/binding/public key and expired sessions', () => {
    for (const changed of [
      { connected_account_id: 'acct_other' },
      { platform_account_id: 'acct_other' },
      { binding_id: 'other' },
      { livemode: true },
      { publishable_key: 'pk_live_wrong' },
      { publishable_key: 'sk_test_private' },
      { expires_at: 1 },
      { client_secret: '' },
    ]) {
      expect(() =>
        mapConnectSession({ ...response(), account_session: { ...session(), ...changed } }, 'test'),
      ).toThrow()
    }
  })
})

function authFixture() {
  const user = { id: 'creator-one', email: 'creator@example.test' }
  const auth = {
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    signInWithPassword: vi.fn(async () => ({ data: { user, session: {} }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    mfa: {
      listFactors: vi.fn(async () => ({ data: { all: [] }, error: null })),
      challengeAndVerify: vi.fn(async () => ({ data: {}, error: null })),
    },
  }
  const invoke = vi.fn(async () => ({ data: response(), error: null }))
  const gateway = createConnectGateway({ auth, functions: { invoke } } as unknown as ConnectClient)
  return { auth, invoke, gateway }
}
describe('payout identity confirmation', () => {
  it('does not expose a session after the signed-in account changes during its request', async () => {
    const f = authFixture()
    f.auth.getUser
      .mockResolvedValueOnce({
        data: { user: { id: 'creator-one', email: 'creator@example.test' } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: { id: 'other-creator', email: 'other@example.test' } },
        error: null,
      })
    await expect(f.gateway.session('test')).rejects.toThrow('sign-in changed')
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
  it('reauthenticates only the current user with Supabase and sends no password to payout services', async () => {
    const f = authFixture()
    await f.gateway.reauthenticate!('example-password')
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'creator@example.test',
      password: 'example-password',
    })
    expect(f.auth.getUser).toHaveBeenCalledTimes(2)
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.auth.signOut).not.toHaveBeenCalled()
  })
  it('does not continue after a bad password', async () => {
    const f = authFixture()
    f.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'private provider error' },
    } as never)
    await expect(f.gateway.reauthenticate!('wrong-password')).rejects.toThrow(
      'password could not be verified',
    )
    expect(f.auth.getUser).toHaveBeenCalledOnce()
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it('signs out if password confirmation changes the authenticated identity', async () => {
    const f = authFixture()
    f.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: { id: 'other-creator', email: 'other@example.test' }, session: {} },
      error: null,
    })
    await expect(f.gateway.reauthenticate!('example-password')).rejects.toThrow('sign-in changed')
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(f.invoke).not.toHaveBeenCalled()
  })
  it('still signs out a changed identity when a previous Stripe logout never resolves', async () => {
    vi.useFakeTimers()
    try {
      const f = authFixture()
      rememberEmbeddedConnectSession({ logout: () => new Promise<void>(() => {}) })
      f.auth.signInWithPassword.mockResolvedValueOnce({
        data: { user: { id: 'other-creator', email: 'other@example.test' }, session: {} },
        error: null,
      })
      const failure = expect(f.gateway.reauthenticate!('example-password')).rejects.toThrow(
        'sign-in changed',
      )
      await vi.advanceTimersByTimeAsync(2000)
      await failure
      expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('requires a fresh enrolled TOTP challenge after password confirmation', async () => {
    const f = authFixture()
    f.auth.mfa.listFactors.mockResolvedValue({
      data: { all: [{ id: 'factor-one', status: 'verified', factor_type: 'totp' }] },
      error: null,
    } as never)
    await expect(f.gateway.reauthenticate!('example-password')).rejects.toBeInstanceOf(
      ConnectMfaRequired,
    )
    expect(f.invoke).not.toHaveBeenCalled()
    await f.gateway.verifyMfa!('123456')
    expect(f.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-one',
      code: '123456',
    })
    expect(f.auth.getUser).toHaveBeenCalledTimes(4)
  })
  it('rejects invalid MFA codes and unsupported verification factors', async () => {
    const f = authFixture()
    await expect(f.gateway.verifyMfa!('123')).rejects.toThrow('six-digit code')
    expect(f.auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
    f.auth.mfa.listFactors.mockResolvedValue({
      data: { all: [{ id: 'factor-one', status: 'verified', factor_type: 'phone' }] },
      error: null,
    } as never)
    await expect(f.gateway.verifyMfa!('123456')).rejects.toThrow('fresh sign-in')
    expect(f.auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
  })
  it('keeps failed TOTP verification blocked and signs out on an identity change during verification', async () => {
    const f = authFixture()
    f.auth.mfa.listFactors.mockResolvedValue({
      data: { all: [{ id: 'factor-one', status: 'verified', factor_type: 'totp' }] },
      error: null,
    } as never)
    f.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: null,
      error: { message: 'Wrong code' },
    } as never)
    await expect(f.gateway.verifyMfa!('123456')).rejects.toThrow('could not be confirmed')
    f.auth.getUser.mockResolvedValueOnce({
      data: { user: { id: 'other-creator', email: 'other@example.test' } },
      error: null,
    })
    await expect(f.gateway.verifyMfa!('123456')).rejects.toThrow('sign-in changed')
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
