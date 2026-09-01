import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PartnerAuthError } from './authService'
import type { PartnerAuthService } from './authService'
import type { AuthSessionState } from './authSession'
import { useAuthSession } from './authSession'
import { AuthPreview } from './AuthPreview'
import type { AuthScreen } from './preview'

vi.mock('./authSession', () => ({ useAuthSession: vi.fn() }))

const anonymousSession: AuthSessionState = {
  status: 'anonymous',
  session: null,
  user: null,
  recoveryMode: false,
  message: null,
}

const authenticatedUser = { id: 'partner-user' } as NonNullable<AuthSessionState['user']>
const authenticatedSupabaseSession = {
  access_token: 'partner-session',
  user: authenticatedUser,
} as Session

const authenticatedSession: AuthSessionState = {
  status: 'authenticated',
  session: authenticatedSupabaseSession,
  user: authenticatedUser,
  recoveryMode: true,
  message: null,
}

function service(overrides: Partial<PartnerAuthService> = {}): PartnerAuthService {
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

function renderAuth(
  screenName: AuthScreen,
  authService = service(),
  options: {
    workspace?: 'partner' | 'admin'
    inviteStatus?: 'idle' | 'verifying' | 'ready' | 'error'
    inviteError?: string
    activationStatus?: 'active' | 'pending' | 'none' | 'loading' | 'error'
    onActivationComplete?: (session: Session, activationStatus: 'active' | 'none') => void
    signupStatus?: 'idle' | 'verifying' | 'error'
    signupError?: string
  } = {},
) {
  const onNavigate = vi.fn()
  const onOpenDashboard = vi.fn()
  const renderView = () => (
    <AuthPreview
      screen={screenName}
      authService={authService}
      onNavigate={onNavigate}
      onOpenDashboard={onOpenDashboard}
      {...options}
    />
  )
  const view = render(renderView())
  return {
    ...view,
    authService,
    onNavigate,
    onOpenDashboard,
    rerenderAuth: () => view.rerender(renderView()),
  }
}

beforeEach(() => {
  vi.mocked(useAuthSession).mockReturnValue(anonymousSession)
})

describe('partner sign-in', () => {
  it('offers public partner registration without autofocus', () => {
    renderAuth('sign-in')
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create a partner account' })).toHaveAttribute(
      'href',
      '#auth/sign-up',
    )
    expect(screen.getByLabelText('Email address')).not.toHaveFocus()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('keeps public registration out of the provisioned-only Admin sign-in', () => {
    renderAuth('sign-in', service(), { workspace: 'admin' })
    expect(screen.getByText(/Admin accounts are provisioned/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /create a partner account/i }),
    ).not.toBeInTheDocument()
  })

  it('associates validation errors and focuses the first invalid field', async () => {
    const user = userEvent.setup()
    renderAuth('sign-in')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const email = screen.getByLabelText('Email address')
    expect(email).toHaveFocus()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAccessibleDescription('Enter your email address.')
    await user.type(email, 'partner@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByLabelText('Password')).toHaveFocus()
  })

  it('submits credentials to Supabase and shows a focused success state', async () => {
    const user = userEvent.setup()
    const authService = service()
    const { onOpenDashboard } = renderAuth('sign-in', authService)
    await user.type(screen.getByLabelText('Email address'), 'Partner@Example.com')
    await user.type(screen.getByLabelText('Password'), 'existing-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(authService.signIn).toHaveBeenCalledWith('Partner@Example.com', 'existing-password')
    const heading = await screen.findByRole('heading', { name: 'You’re signed in.' })
    expect(heading).toHaveFocus()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open partner dashboard' }))
    expect(onOpenDashboard).toHaveBeenCalledOnce()
  })

  it('announces pending work and prevents duplicate submissions', async () => {
    const user = userEvent.setup()
    let finish!: (result: { session: Session; activationStatus: 'active' }) => void
    const signIn = vi.fn(
      () =>
        new Promise<{ session: Session; activationStatus: 'active' }>((resolve) => {
          finish = resolve
        }),
    )
    renderAuth('sign-in', service({ signIn }))
    await user.type(screen.getByLabelText('Email address'), 'partner@example.com')
    await user.type(screen.getByLabelText('Password'), 'existing-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Signing in…' }).closest('form')).toHaveAttribute(
      'aria-busy',
      'true',
    )
    finish({ session: {} as Session, activationStatus: 'active' })
    expect(await screen.findByRole('heading', { name: 'You’re signed in.' })).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('shows a safe, focused service error and keeps the user on the form', async () => {
    const user = userEvent.setup()
    const signIn = vi
      .fn()
      .mockRejectedValue(
        new PartnerAuthError('sign-in', 'The email address or password is incorrect.'),
      )
    renderAuth('sign-in', service({ signIn }))
    await user.type(screen.getByLabelText('Email address'), 'partner@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The email address or password is incorrect.')
    expect(alert).toHaveFocus()
    expect(screen.getByLabelText('Password')).toHaveValue('wrong-password')
  })

  it('reveals a password without submitting the form', async () => {
    const user = userEvent.setup()
    const authService = service()
    renderAuth('sign-in', authService)
    await user.type(screen.getByLabelText('Password'), 'existing-password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(authService.signIn).not.toHaveBeenCalled()
  })
})

describe('public partner registration', () => {
  it('requires every field and focuses the first invalid control', async () => {
    const user = userEvent.setup()
    renderAuth('sign-up')

    await user.click(screen.getByRole('button', { name: 'Create partner account' }))
    expect(screen.getByLabelText('Full name')).toHaveFocus()
    expect(screen.getByLabelText('Full name')).toHaveAccessibleDescription('Enter your full name.')
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-invalid', 'true')
  })

  it('links the exact legal documents and submits accepted fixed-version registration data', async () => {
    const user = userEvent.setup()
    const authService = service()
    renderAuth('sign-up', authService)

    expect(screen.getByRole('link', { name: 'Terms and Conditions' })).toHaveAttribute(
      'href',
      'https://kissmyapps.dev/terms',
    )
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      'https://kissmyapps.dev/privacy',
    )
    await user.type(screen.getByLabelText('Full name'), 'Example Partner')
    await user.type(screen.getByLabelText('Email address'), 'Partner@Example.com')
    await user.type(screen.getByLabelText('Password'), 'secure passphrase')
    await user.type(screen.getByLabelText('Confirm password'), 'secure passphrase')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Create partner account' }))

    expect(authService.signUp).toHaveBeenCalledWith({
      fullName: 'Example Partner',
      email: 'Partner@Example.com',
      password: 'secure passphrase',
    })
    const heading = await screen.findByRole('heading', { name: 'Check your email.' })
    expect(heading).toHaveFocus()
    expect(screen.getByText(/If this address can be registered/i)).toBeInTheDocument()
    expect(screen.queryByText('Partner@Example.com')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('shows truthful callback verification and a safe expired-link recovery state', () => {
    const { rerender, onNavigate, authService, onOpenDashboard } = renderAuth(
      'sign-up',
      service(),
      { signupStatus: 'verifying' },
    )
    expect(screen.getByRole('heading', { name: 'Confirming your email…' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()

    rerender(
      <AuthPreview
        screen="sign-up"
        authService={authService}
        onNavigate={onNavigate}
        onOpenDashboard={onOpenDashboard}
        signupStatus="error"
        signupError="This confirmation link has expired or was already used."
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('expired or was already used')
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })
})

describe('password recovery and reset', () => {
  it('uses a non-enumerating recovery confirmation', async () => {
    const user = userEvent.setup()
    const authService = service()
    renderAuth('recover', authService)
    await user.type(screen.getByLabelText('Email address'), 'partner@example.com')
    await user.click(screen.getByRole('button', { name: 'Send recovery link' }))
    expect(authService.requestPasswordRecovery).toHaveBeenCalledWith('partner@example.com')
    expect(await screen.findByRole('heading', { name: 'Check your email.' })).toHaveFocus()
    expect(
      screen.getByText(/if that address belongs to an eligible partner account/i),
    ).toBeInTheDocument()
  })

  it('does not expose the reset form without an authenticated recovery session', () => {
    renderAuth('reset')
    expect(
      screen.getByRole('heading', { name: 'A recovery link is required.' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('does not treat an ordinary authenticated session as a recovery session', () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    renderAuth('reset')
    expect(
      screen.getByRole('heading', { name: 'A recovery link is required.' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('updates a password in an authenticated recovery session', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const user = userEvent.setup()
    const authService = service()
    renderAuth('reset', authService)
    await user.type(screen.getByLabelText('New password'), 'new secure passphrase')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(authService.updatePassword).toHaveBeenCalledWith('new secure passphrase')
    expect(await screen.findByRole('heading', { name: 'Your password is ready.' })).toHaveFocus()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('keeps an in-flight password update visible after the recovery session rotates', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    let finishUpdate!: (result: { session: Session; activationStatus: 'active' }) => void
    const updatePassword = vi.fn(
      () =>
        new Promise<{ session: Session; activationStatus: 'active' }>((resolve) => {
          finishUpdate = resolve
        }),
    )
    const user = userEvent.setup()
    const { rerenderAuth } = renderAuth('reset', service({ updatePassword }))
    await user.type(screen.getByLabelText('New password'), 'new secure passphrase')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    rerenderAuth()

    expect(screen.getByRole('button', { name: 'Updating password…' })).toBeDisabled()
    expect(
      screen.queryByRole('heading', { name: 'A recovery link is required.' }),
    ).not.toBeInTheDocument()

    finishUpdate({ session: authenticatedSupabaseSession, activationStatus: 'active' })
    expect(await screen.findByRole('heading', { name: 'Your password is ready.' })).toHaveFocus()
  })

  it('shows the password-update error after recovery session rotation', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    let failUpdate!: (error: unknown) => void
    const updatePassword = vi.fn(
      () =>
        new Promise<{ session: Session; activationStatus: 'active' }>((_, reject) => {
          failUpdate = reject
        }),
    )
    const user = userEvent.setup()
    const { rerenderAuth } = renderAuth('reset', service({ updatePassword }))
    await user.type(screen.getByLabelText('New password'), 'new secure passphrase')
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    rerenderAuth()
    failUpdate(
      new PartnerAuthError(
        'password-update',
        'Your password was saved, but we could not reopen your account. Sign in with the new password to continue.',
      ),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your password was saved, but we could not reopen your account.',
    )
    expect(
      screen.getByRole('heading', { name: 'Sign in with your new password.' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeEnabled()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'A recovery link is required.' }),
    ).not.toBeInTheDocument()
  })

  it('shows a safe configuration error and disables account requests', () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...anonymousSession,
      status: 'unconfigured',
      message: 'Partner sign-in is not configured yet.',
    })
    renderAuth('recover')
    expect(screen.getByRole('alert')).toHaveTextContent('Partner sign-in is not configured yet.')
    expect(screen.getByRole('button', { name: 'Send recovery link' })).toBeDisabled()
  })
})

describe('partner invitation setup', () => {
  it('verifies an invitation before exposing password fields', () => {
    renderAuth('invite', service(), { inviteStatus: 'verifying' })

    expect(screen.getByRole('heading', { name: 'Verifying your invitation…' })).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open partner dashboard/i })).not.toBeInTheDocument()
  })

  it('shows a safe recovery path for an expired or already-used invitation', async () => {
    const { onNavigate } = renderAuth('invite', service(), {
      inviteStatus: 'error',
      inviteError:
        'This invitation link has expired or was already used. Use password recovery or ask KissMyApps for a new invitation.',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('expired or was already used')
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use password recovery' }))
    expect(onNavigate).toHaveBeenCalledWith('recover')
  })

  it('requires a matching 12-character password and activates the verified invite', async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    const user = userEvent.setup()
    const activatedSession = {
      access_token: 'activated-session',
      user: { id: 'partner-user' },
    } as Session
    const authService = service({
      updatePassword: vi.fn().mockResolvedValue({
        session: activatedSession,
        activationStatus: 'active',
      }),
    })
    const onActivationComplete = vi.fn()
    const { onOpenDashboard } = renderAuth('invite', authService, {
      inviteStatus: 'ready',
      activationStatus: 'pending',
      onActivationComplete,
    })

    expect(
      screen.getByRole('heading', { level: 1, name: 'Create your password.' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open partner dashboard/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Back to sign in')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'different')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    expect(screen.getByLabelText('New password')).toHaveFocus()
    expect(authService.updatePassword).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('New password'))
    await user.type(screen.getByLabelText('New password'), 'new secure passphrase')
    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('Confirm new password'), 'new secure passphrase')
    await user.click(screen.getByRole('button', { name: 'Set password' }))

    expect(authService.updatePassword).toHaveBeenCalledWith('new secure passphrase')
    expect(onActivationComplete).toHaveBeenCalledWith(activatedSession, 'active')
    expect(
      await screen.findByRole('heading', { name: 'Your partner account is ready.' }),
    ).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Open partner dashboard' }))
    expect(onOpenDashboard).toHaveBeenCalledOnce()
  })
})

describe('auth accessibility', () => {
  it.each<AuthScreen>(['sign-in', 'sign-up', 'recover'])(
    'has no automated axe violations on %s',
    async (route) => {
      const { container } = renderAuth(route)
      expect((await axe.run(container)).violations).toEqual([])
    },
  )

  it('has no automated axe violations on an authenticated reset form', async () => {
    vi.mocked(useAuthSession).mockReturnValue(authenticatedSession)
    const { container } = renderAuth('reset')
    expect((await axe.run(container)).violations).toEqual([])
  })

  it('has no automated axe violations on a verified invite form', async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      ...authenticatedSession,
      recoveryMode: false,
    })
    const { container } = renderAuth('invite', service(), {
      inviteStatus: 'ready',
      activationStatus: 'pending',
    })
    expect((await axe.run(container)).violations).toEqual([])
  })
})
