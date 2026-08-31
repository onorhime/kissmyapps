import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  PartnerAuthError,
  createPartnerAuthService,
  passwordRecoveryRedirectUrl,
  publicPartnerRegistration,
} from './authService'

function clientWith(auth: Record<string, unknown>) {
  const { rpc, ...authMethods } = auth
  return { auth: authMethods, rpc } as unknown as SupabaseClient
}

describe('Supabase auth service', () => {
  it('normalizes email for password sign-in and returns the session', async () => {
    const session = { access_token: 'redacted' } as Session
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: 'pending', error: null })
      .mockResolvedValueOnce({ data: true, error: null })
    const service = createPartnerAuthService(clientWith({ signInWithPassword, rpc }))

    await expect(service.signIn(' Partner@Example.COM ', 'existing-password')).resolves.toEqual({
      session,
      activationStatus: 'active',
    })
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'partner@example.com',
      password: 'existing-password',
    })
    expect(rpc).toHaveBeenNthCalledWith(1, 'current_partner_activation_status')
    expect(rpc).toHaveBeenNthCalledWith(2, 'complete_partner_activation')
  })

  it('allows an admin-only account to sign in without a partner membership', async () => {
    const session = { access_token: 'redacted' } as Session
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: 'none', error: null })
    const service = createPartnerAuthService(clientWith({ signInWithPassword, rpc }))

    await expect(service.signIn('admin@example.com', 'existing-password')).resolves.toEqual({
      session,
      activationStatus: 'none',
    })
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith('current_partner_activation_status')
  })

  it('verifies a one-time invite token hash without using the implicit callback flow', async () => {
    const session = { access_token: 'redacted' } as Session
    const verifyOtp = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const service = createPartnerAuthService(clientWith({ verifyOtp }))

    await expect(service.acceptInvite('one-time-token-hash')).resolves.toBe(session)
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: 'one-time-token-hash',
      type: 'invite',
    })
  })

  it('submits a public partner signup with fixed legal evidence and no privileged metadata', async () => {
    const signUp = vi.fn().mockResolvedValue({ data: { user: {} }, error: null })
    const service = createPartnerAuthService(clientWith({ signUp }))

    await expect(
      service.signUp({
        fullName: ' Example Partner ',
        email: ' Partner@Example.COM ',
        password: 'secure passphrase',
      }),
    ).resolves.toBeUndefined()
    expect(signUp).toHaveBeenCalledWith({
      email: 'partner@example.com',
      password: 'secure passphrase',
      options: {
        emailRedirectTo: 'https://partners.kissmyapps.dev/',
        data: {
          registration_flow: 'public_partner_v1',
          full_name: 'Example Partner',
          terms_version: '2026-07-13',
          terms_url: 'https://kissmyapps.dev/terms',
          privacy_version: '2026-07-13',
          privacy_url: 'https://kissmyapps.dev/privacy',
          age_confirmed: true,
        },
      },
    })
    expect(publicPartnerRegistration).not.toHaveProperty('role')
  })

  it('confirms a custom signup token and activates the resulting partner session', async () => {
    const session = { access_token: 'confirmed-session' } as Session
    const verifyOtp = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const service = createPartnerAuthService(clientWith({ verifyOtp, rpc }))

    await expect(service.confirmSignUp('confirmation-token-hash')).resolves.toBe(session)
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: 'confirmation-token-hash',
      type: 'email',
    })
    expect(rpc).toHaveBeenCalledWith('complete_partner_activation')
  })

  it('clears a confirmed session locally when partner activation fails', async () => {
    const session = { access_token: 'unactivated-session' } as Session
    const verifyOtp = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'raw activation details' },
    })
    const signOut = vi.fn().mockResolvedValue({ error: null })
    const service = createPartnerAuthService(clientWith({ verifyOtp, rpc, signOut }))

    await expect(service.confirmSignUp('confirmation-token-hash')).rejects.toMatchObject({
      name: 'PartnerAuthError',
      message:
        'Your account is signed in, but this partner workspace is not available yet. Contact KissMyApps for help.',
    })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('clears a password session locally when sign-in activation fails', async () => {
    const session = { access_token: 'unactivated-password-session' } as Session
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: 'pending', error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'raw activation details' },
      })
    const signOut = vi.fn().mockResolvedValue({ error: null })
    const service = createPartnerAuthService(clientWith({ signInWithPassword, rpc, signOut }))

    await expect(service.signIn('partner@example.com', 'existing-password')).rejects.toMatchObject({
      name: 'PartnerAuthError',
      message:
        'Your account is signed in, but this partner workspace is not available yet. Contact KissMyApps for help.',
    })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('uses a same-origin reset route and normalizes the recovery email', async () => {
    window.history.replaceState(null, '', '/partners?from=test#auth/recover')
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null })
    const service = createPartnerAuthService(clientWith({ resetPasswordForEmail }))

    await service.requestPasswordRecovery(' Partner@Example.com ')
    expect(resetPasswordForEmail).toHaveBeenCalledWith('partner@example.com', {
      redirectTo: `${window.location.origin}/partners#auth/reset`,
    })
    expect(passwordRecoveryRedirectUrl()).toBe(`${window.location.origin}/partners#auth/reset`)
  })

  it('updates the password, proves it with password sign-in, and activates the partner', async () => {
    const session = { access_token: 'password-session' } as Session
    const updateUser = vi.fn().mockResolvedValue({
      data: { user: { email: 'partner@example.com' } },
      error: null,
    })
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: 'pending', error: null })
      .mockResolvedValueOnce({ data: true, error: null })
    const service = createPartnerAuthService(clientWith({ updateUser, signInWithPassword, rpc }))
    await expect(service.updatePassword('new secure passphrase')).resolves.toEqual({
      session,
      activationStatus: 'active',
    })
    expect(updateUser).toHaveBeenCalledWith({ password: 'new secure passphrase' })
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'partner@example.com',
      password: 'new secure passphrase',
    })
    expect(rpc).toHaveBeenNthCalledWith(1, 'current_partner_activation_status')
    expect(rpc).toHaveBeenNthCalledWith(2, 'complete_partner_activation')
  })

  it('reads only the allowlisted partner activation states', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'pending', error: null })
    const service = createPartnerAuthService(clientWith({ rpc }))

    await expect(service.getPartnerActivationStatus()).resolves.toBe('pending')
    expect(rpc).toHaveBeenCalledWith('current_partner_activation_status')
  })

  it('maps provider failures to safe messages without leaking details', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { code: 'internal_error', message: 'database host secret.internal failed' },
    })
    const service = createPartnerAuthService(clientWith({ signInWithPassword }))

    await expect(service.signIn('partner@example.com', 'password')).rejects.toMatchObject({
      name: 'PartnerAuthError',
      message: 'We could not sign you in. Please try again.',
    })
    await expect(service.signIn('partner@example.com', 'password')).rejects.not.toThrow(
      /secret\.internal/,
    )
  })

  it('maps expired invitation failures without exposing provider details', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({
      data: { session: null },
      error: { code: 'otp_expired', message: 'token secret.internal expired' },
    })
    const service = createPartnerAuthService(clientWith({ verifyOtp }))

    await expect(service.acceptInvite('secret-token')).rejects.toMatchObject({
      name: 'PartnerAuthError',
      message:
        'This invitation link has expired or was already used. Use password recovery or ask KissMyApps for a new invitation.',
    })
    await expect(service.acceptInvite('secret-token')).rejects.not.toThrow(/secret\.internal/)
  })

  it('fails safely when the browser has no Supabase configuration', async () => {
    const service = createPartnerAuthService(null)
    await expect(service.signIn('partner@example.com', 'password')).rejects.toBeInstanceOf(
      PartnerAuthError,
    )
  })
})
