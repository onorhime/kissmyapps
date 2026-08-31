import { describe, expect, it } from 'vitest'
import {
  authScreenFromHash,
  inviteCallbackClearedUrl,
  inviteCallbackFromSearch,
  signupCallbackClearedUrl,
  signupCallbackFromSearch,
  validateEmail,
  validateReset,
  validateSignIn,
  validateSignUp,
} from './preview'

describe('auth routes and validation', () => {
  it.each(['#auth/sign-in', '#auth/sign-up', '#auth/recover', '#auth/reset', '#auth/invite'])(
    'recognizes the explicit %s account route',
    (hash) => expect(authScreenFromHash(hash)).toBe(hash.split('/')[1]),
  )

  it('keeps dashboard navigation separate and unknown auth routes on sign-in', () => {
    expect(authScreenFromHash('#profile/security')).toBeNull()
    expect(authScreenFromHash('#auth/https://example.invalid')).toBe('sign-in')
    expect(authScreenFromHash('#auth')).toBe('sign-in')
  })

  it('accepts only the custom email-confirmation callback and scrubs its token', () => {
    expect(
      signupCallbackFromSearch('?auth_action=signup&type=email&token_hash=confirmation-secret'),
    ).toEqual({ tokenHash: 'confirmation-secret' })
    expect(
      signupCallbackFromSearch('?auth_action=signup&type=signup&token_hash=confirmation-secret'),
    ).toBeNull()
    expect(signupCallbackFromSearch('?type=email&token_hash=confirmation-secret')).toBeNull()

    const location = {
      pathname: '/partners',
      search: '?campaign=qa&auth_action=signup&type=email&token_hash=confirmation-secret',
    }
    const success = signupCallbackClearedUrl(location, 'performance')
    const retry = signupCallbackClearedUrl(location, 'sign-up')
    expect(success).toBe('/partners?campaign=qa#performance')
    expect(retry).toBe('/partners?campaign=qa#auth/sign-up')
    expect(success).not.toContain('confirmation-secret')
    expect(retry).not.toContain('confirmation-secret')
  })

  it('accepts only a complete invite callback and never includes the token in the cleared URL', () => {
    expect(
      inviteCallbackFromSearch('?auth_action=invite&type=invite&token_hash=one-time-secret'),
    ).toEqual({ tokenHash: 'one-time-secret' })
    expect(inviteCallbackFromSearch('?type=invite&token_hash=one-time-secret')).toBeNull()
    expect(
      inviteCallbackFromSearch('?auth_action=invite&type=recovery&token_hash=secret'),
    ).toBeNull()
    expect(inviteCallbackFromSearch('?auth_action=invite&type=invite')).toBeNull()

    const cleared = inviteCallbackClearedUrl({
      pathname: '/partners',
      search: '?campaign=qa&auth_action=invite&type=invite&token_hash=one-time-secret',
    })
    expect(cleared).toBe('/partners?campaign=qa#auth/invite')
    expect(cleared).not.toContain('one-time-secret')
  })

  it('validates real partner email addresses without account enumeration', () => {
    expect(validateEmail('')).toBe('Enter your email address.')
    expect(validateEmail('not-an-email')).toContain('complete email address')
    expect(validateEmail(' Partner@Example.com ')).toBeUndefined()
  })

  it('does not apply new-password strength rules to an existing password', () => {
    expect(validateSignIn('partner@example.com', 'x')).toEqual({})
    expect(validateSignIn('partner@example.com', '')).toHaveProperty('password')
  })

  it('requires a 12-character matching replacement password', () => {
    expect(validateReset('short', 'short')).toHaveProperty('password')
    expect(validateReset('secure passphrase', '')).toHaveProperty('confirmation')
    expect(validateReset('secure passphrase', 'different passphrase')).toHaveProperty(
      'confirmation',
    )
    expect(validateReset('secure passphrase', 'secure passphrase')).toEqual({})
  })

  it('requires public registration identity, credentials, age, and legal acceptance', () => {
    expect(
      validateSignUp({
        fullName: '',
        email: 'invalid',
        password: 'short',
        confirmation: 'different',
        acceptedTerms: false,
      }),
    ).toEqual(
      expect.objectContaining({
        fullName: expect.any(String),
        email: expect.any(String),
        password: expect.any(String),
        confirmation: expect.any(String),
        terms: expect.any(String),
      }),
    )

    expect(
      validateSignUp({
        fullName: ' Example Partner ',
        email: ' Partner@Example.com ',
        password: 'secure passphrase',
        confirmation: 'secure passphrase',
        acceptedTerms: true,
      }),
    ).toEqual({})
  })
})
