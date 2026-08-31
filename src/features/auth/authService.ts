import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseConfigurationIssue, requireSupabaseClient } from '../../lib/supabase'

export type AuthOperation =
  | 'sign-in'
  | 'sign-up'
  | 'signup-confirmation'
  | 'invite'
  | 'recovery'
  | 'password-update'
  | 'activation'
  | 'sign-out'

export type PartnerActivationStatus = 'active' | 'pending' | 'none'

export type PartnerSessionResult = Readonly<{
  session: Session
  activationStatus: Exclude<PartnerActivationStatus, 'pending'>
}>

export type PartnerSignUpInput = Readonly<{
  fullName: string
  email: string
  password: string
}>

export const publicPartnerRegistration = {
  flow: 'public_partner_v1',
  termsVersion: '2026-07-13',
  termsUrl: 'https://kissmyapps.dev/terms',
  privacyVersion: '2026-07-13',
  privacyUrl: 'https://kissmyapps.dev/privacy',
  emailRedirectTo: 'https://partners.kissmyapps.dev/',
} as const

export class PartnerAuthError extends Error {
  readonly operation: AuthOperation

  constructor(operation: AuthOperation, message: string) {
    super(message)
    this.name = 'PartnerAuthError'
    this.operation = operation
  }
}

export interface PartnerAuthService {
  signIn(email: string, password: string): Promise<PartnerSessionResult>
  signUp(input: PartnerSignUpInput): Promise<void>
  confirmSignUp(tokenHash: string): Promise<Session>
  acceptInvite(tokenHash: string): Promise<Session>
  requestPasswordRecovery(email: string): Promise<void>
  updatePassword(password: string): Promise<PartnerSessionResult>
  getPartnerActivationStatus(): Promise<PartnerActivationStatus>
  signOut(): Promise<void>
}

type AuthFailure = {
  code?: string
  message?: string
  status?: number
}

function safeAuthMessage(operation: AuthOperation, error: AuthFailure) {
  const code = error.code?.toLowerCase()
  const message = error.message?.toLowerCase() ?? ''

  if (operation === 'sign-in') {
    if (code === 'invalid_credentials' || message.includes('invalid login credentials')) {
      return 'The email address or password is incorrect.'
    }
    if (code === 'email_not_confirmed' || message.includes('email not confirmed')) {
      return 'Confirm your email address before signing in.'
    }
  }

  if (
    (operation === 'invite' || operation === 'signup-confirmation') &&
    (code === 'otp_expired' ||
      code === 'invalid_token' ||
      message.includes('expired') ||
      message.includes('invalid'))
  ) {
    if (operation === 'signup-confirmation') {
      return 'This confirmation link has expired or was already used. Start a new registration, or sign in if your email is already confirmed.'
    }
    return 'This invitation link has expired or was already used. Use password recovery or ask KissMyApps for a new invitation.'
  }

  if (
    code === 'over_request_rate_limit' ||
    error.status === 429 ||
    message.includes('rate limit')
  ) {
    return 'Too many attempts were made. Wait a little while, then try again.'
  }

  if (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('timeout')
  ) {
    return 'We could not reach the account service. Check your connection and try again.'
  }

  if (operation === 'recovery') {
    return 'We could not start password recovery. Please wait a moment and try again.'
  }
  if (operation === 'sign-up') {
    return 'We could not submit this registration request. Please wait a moment and try again.'
  }
  if (operation === 'signup-confirmation') {
    return 'We could not confirm this email address. Start a new registration, or sign in if your email is already confirmed.'
  }
  if (operation === 'invite') {
    return 'We could not verify this invitation. Use password recovery or ask KissMyApps for a new invitation.'
  }
  if (operation === 'password-update') {
    return 'We could not finish securing your account. If your password was already saved, sign in with it to continue.'
  }
  if (operation === 'activation') {
    return 'Your account is signed in, but this partner workspace is not available yet. Contact KissMyApps for help.'
  }
  if (operation === 'sign-out') {
    return 'We could not sign you out. Please try again.'
  }
  return 'We could not sign you in. Please try again.'
}

function configurationError(operation: AuthOperation) {
  return new PartnerAuthError(
    operation,
    getSupabaseConfigurationIssue() ?? 'Partner sign-in is unavailable.',
  )
}

function operationError(operation: AuthOperation, error: AuthFailure) {
  return new PartnerAuthError(operation, safeAuthMessage(operation, error))
}

export function passwordRecoveryRedirectUrl(location: Location = window.location) {
  const redirect = new URL(location.pathname, location.origin)
  redirect.hash = 'auth/reset'
  return redirect.toString()
}

export function createPartnerAuthService(client?: SupabaseClient | null): PartnerAuthService {
  function configuredClient(operation: AuthOperation) {
    if (client === null) throw configurationError(operation)
    if (client) return client
    try {
      return requireSupabaseClient()
    } catch {
      throw configurationError(operation)
    }
  }

  async function activatePartner(authClient: SupabaseClient) {
    const { data, error } = await authClient.rpc('complete_partner_activation')
    if (error) throw operationError('activation', error)
    if (data !== true) {
      throw new PartnerAuthError(
        'activation',
        'Your account is signed in, but this partner workspace is not available yet. Contact KissMyApps for help.',
      )
    }
  }

  async function readPartnerActivationStatus(authClient: SupabaseClient) {
    const { data, error } = await authClient.rpc('current_partner_activation_status')
    if (error) throw operationError('activation', error)
    if (data === 'active' || data === 'pending' || data === 'none') return data
    throw new PartnerAuthError(
      'activation',
      'Your account is signed in, but this partner workspace is not available yet. Contact KissMyApps for help.',
    )
  }

  async function activatePartnerWhenPresent(authClient: SupabaseClient) {
    const status = await readPartnerActivationStatus(authClient)
    if (status === 'none') return status
    await activatePartner(authClient)
    return 'active' as const
  }

  async function activateOrClearSession<T>(authClient: SupabaseClient, activate: () => Promise<T>) {
    try {
      return await activate()
    } catch (error) {
      await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined)
      throw error
    }
  }

  return {
    async signIn(email, password) {
      const authClient = configuredClient('sign-in')
      const { data, error } = await authClient.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      })
      if (error) throw operationError('sign-in', error)
      if (!data.session) {
        throw new PartnerAuthError('sign-in', 'We could not start your session. Please try again.')
      }
      const activationStatus = await activateOrClearSession(authClient, () =>
        activatePartnerWhenPresent(authClient),
      )
      return { session: data.session, activationStatus }
    },

    async signUp({ fullName, email, password }) {
      const { error } = await configuredClient('sign-up').auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: publicPartnerRegistration.emailRedirectTo,
          data: {
            registration_flow: publicPartnerRegistration.flow,
            full_name: fullName.trim(),
            terms_version: publicPartnerRegistration.termsVersion,
            terms_url: publicPartnerRegistration.termsUrl,
            privacy_version: publicPartnerRegistration.privacyVersion,
            privacy_url: publicPartnerRegistration.privacyUrl,
            age_confirmed: true,
          },
        },
      })
      if (error) throw operationError('sign-up', error)
    },

    async confirmSignUp(tokenHash) {
      const authClient = configuredClient('signup-confirmation')
      const { data, error } = await authClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'email',
      })
      if (error) throw operationError('signup-confirmation', error)
      if (!data.session) {
        throw new PartnerAuthError(
          'signup-confirmation',
          'We could not confirm this email address. Start a new registration, or sign in if your email is already confirmed.',
        )
      }
      await activateOrClearSession(authClient, () => activatePartner(authClient))
      return data.session
    },

    async acceptInvite(tokenHash) {
      const { data, error } = await configuredClient('invite').auth.verifyOtp({
        token_hash: tokenHash,
        type: 'invite',
      })
      if (error) throw operationError('invite', error)
      if (!data.session) {
        throw new PartnerAuthError(
          'invite',
          'We could not verify this invitation. Use password recovery or ask KissMyApps for a new invitation.',
        )
      }
      return data.session
    },

    async requestPasswordRecovery(email) {
      const { error } = await configuredClient('recovery').auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: passwordRecoveryRedirectUrl() },
      )
      if (error) throw operationError('recovery', error)
    },

    async updatePassword(password) {
      const authClient = configuredClient('password-update')
      const { data, error } = await authClient.auth.updateUser({ password })
      if (error) throw operationError('password-update', error)
      const email = data.user?.email
      if (!email) {
        throw new PartnerAuthError(
          'password-update',
          'Your password was saved, but we could not reopen your account. Sign in with the new password to continue.',
        )
      }

      const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) throw operationError('password-update', signInError)
      if (!signInData.session) {
        throw new PartnerAuthError(
          'password-update',
          'Your password was saved, but we could not reopen your account. Sign in with the new password to continue.',
        )
      }
      const activationStatus = await activateOrClearSession(authClient, () =>
        activatePartnerWhenPresent(authClient),
      )
      return { session: signInData.session, activationStatus }
    },

    async getPartnerActivationStatus() {
      return readPartnerActivationStatus(configuredClient('activation'))
    },

    async signOut() {
      const { error } = await configuredClient('sign-out').auth.signOut()
      if (error) throw operationError('sign-out', error)
    },
  }
}

export const partnerAuth = createPartnerAuthService()

export function authErrorMessage(error: unknown) {
  return error instanceof PartnerAuthError
    ? error.message
    : 'The account service returned an unexpected response. Please try again.'
}
