import { supabase } from '../../lib/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logoutEmbeddedConnectSessions } from './embedded-connect'

export type ConnectBinding = {
  binding_id: string
  platform_account_id: string
  livemode: boolean
  allowed_countries: string[]
  eligibility: {
    source: 'stripe_country_specs'
    verified_at: string
    platform_country: string
    countries: { country: string; settlement_currencies: string[] }[]
  }
  allowed_transfer_currencies: string[]
  eligibility_reason: string | null
  connected_account_id: string | null
  status: 'not_connected' | 'needs_information' | 'pending_verification' | 'ready'
  details_submitted: boolean
  transfers_enabled: boolean
  payouts_enabled: boolean
  requirements_due: string[]
  disabled_reason: string | null
  verified_at: string | null
}
export type ConnectStatus = {
  enabled: boolean
  bindings: ConnectBinding[]
}
export type ConnectClient = {
  auth?: Pick<SupabaseClient['auth'], 'getUser' | 'signInWithPassword' | 'signOut' | 'mfa'>
  functions?: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): PromiseLike<{
      data: unknown
      error: { message?: string; context?: unknown } | null
    }>
  }
}
export type ConnectGateway = {
  status(): Promise<ConnectStatus>
  session(bindingId: string, country?: string): Promise<ConnectSession>
  reauthenticate?(password: string): Promise<void>
  verifyMfa?(code: string): Promise<void>
}
export type ConnectSession = {
  binding_id: string
  platform_account_id: string
  connected_account_id: string
  livemode: boolean
  publishable_key: string
  client_secret: string
  expires_at: number
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid payout connection response.')
  return value as Record<string, unknown>
}
export class ConnectReauthenticationRequired extends Error {
  constructor() {
    super('Confirm your KissMyApps password to continue setting up payouts.')
    this.name = 'ConnectReauthenticationRequired'
  }
}
export class ConnectMfaRequired extends Error {
  constructor() {
    super('Enter a fresh code from your authenticator app to continue setting up payouts.')
    this.name = 'ConnectMfaRequired'
  }
}
export function mapConnectStatus(value: unknown): ConnectStatus {
  const source = object(value)
  if (typeof source.enabled !== 'boolean' || !Array.isArray(source.bindings))
    throw Error('Invalid payout connection response.')
  const bindings = source.bindings.map((item): ConnectBinding => {
    const row = object(item)
    for (const key of ['binding_id', 'platform_account_id']) {
      if (typeof row[key] !== 'string' || !row[key]) throw Error('Incomplete payout connection.')
    }
    for (const key of ['livemode', 'details_submitted', 'transfers_enabled', 'payouts_enabled']) {
      if (typeof row[key] !== 'boolean') throw Error('Incomplete payout connection.')
    }
    for (const key of ['connected_account_id', 'disabled_reason', 'verified_at']) {
      if (row[key] !== null && typeof row[key] !== 'string')
        throw Error('Incomplete payout connection.')
    }
    if (
      !['not_connected', 'needs_information', 'pending_verification', 'ready'].includes(
        String(row.status),
      ) ||
      !Array.isArray(row.allowed_countries) ||
      row.allowed_countries.some((x) => typeof x !== 'string' || !/^[A-Z]{2}$/.test(x)) ||
      !Array.isArray(row.requirements_due) ||
      row.requirements_due.some((x) => typeof x !== 'string')
    )
      throw Error('Invalid payout requirements.')
    const eligibility = object(row.eligibility)
    if (
      eligibility.source !== 'stripe_country_specs' ||
      typeof eligibility.verified_at !== 'string' ||
      !Number.isFinite(Date.parse(eligibility.verified_at)) ||
      typeof eligibility.platform_country !== 'string' ||
      !/^[A-Z]{2}$/.test(eligibility.platform_country) ||
      !Array.isArray(eligibility.countries)
    )
      throw Error('Payout eligibility could not be verified.')
    const countryCodes: string[] = []
    for (const value of eligibility.countries) {
      const country = object(value)
      if (
        typeof country.country !== 'string' ||
        !/^[A-Z]{2}$/.test(country.country) ||
        !Array.isArray(country.settlement_currencies) ||
        country.settlement_currencies.some(
          (currency) => typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency),
        )
      )
        throw Error('Payout country eligibility is incomplete.')
      countryCodes.push(country.country)
    }
    if (
      new Set(countryCodes).size !== countryCodes.length ||
      row.allowed_countries.some((country) => !countryCodes.includes(country as string)) ||
      !Array.isArray(row.allowed_transfer_currencies) ||
      row.allowed_transfer_currencies.some(
        (currency) => typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency),
      ) ||
      (row.eligibility_reason !== null && typeof row.eligibility_reason !== 'string')
    )
      throw Error('Payout eligibility is inconsistent.')
    return row as unknown as ConnectBinding
  })
  if (new Set(bindings.map((item) => item.binding_id)).size !== bindings.length)
    throw Error('Duplicate payout connections.')
  return {
    enabled: source.enabled,
    bindings,
  }
}

export function mapConnectSession(value: unknown, bindingId: string): ConnectSession {
  const source = object(value)
  const status = mapConnectStatus(source)
  const session = object(source.account_session)
  const binding = status.bindings.find((item) => item.binding_id === bindingId)
  if (
    !status.enabled ||
    !binding ||
    session.binding_id !== bindingId ||
    session.platform_account_id !== binding.platform_account_id ||
    session.connected_account_id !== binding.connected_account_id ||
    !/^acct_[A-Za-z0-9]+$/.test(String(session.connected_account_id)) ||
    session.livemode !== binding.livemode ||
    typeof session.publishable_key !== 'string' ||
    !new RegExp(`^pk_${binding.livemode ? 'live' : 'test'}_[A-Za-z0-9]+$`).test(
      session.publishable_key,
    ) ||
    typeof session.client_secret !== 'string' ||
    !session.client_secret.trim() ||
    typeof session.expires_at !== 'number' ||
    !Number.isSafeInteger(session.expires_at) ||
    session.expires_at <= Math.floor(Date.now() / 1000)
  )
    throw Error('The secure payout setup session could not be verified. Please try again.')
  return session as ConnectSession
}

export function createConnectGateway(client: ConnectClient | null = supabase): ConnectGateway {
  let confirmationUserId: string | null = null
  async function identityChanged(): Promise<never> {
    confirmationUserId = null
    await logoutEmbeddedConnectSessions()
    await client?.auth?.signOut({ scope: 'local' }).catch(() => undefined)
    throw Error('Your sign-in changed. Sign in to the original account before setting up payouts.')
  }
  async function request(body: Record<string, unknown>): Promise<unknown> {
    if (!client?.functions) return { enabled: false, bindings: [] }
    let requestUserId: string | null = null
    if (body.action === 'session' && client.auth) {
      const current = await client.auth.getUser()
      if (current.error || !current.data.user)
        throw Error('Sign in again before setting up payouts.')
      requestUserId = current.data.user.id
      if (confirmationUserId && confirmationUserId !== requestUserId) await identityChanged()
    }
    const response = await client.functions.invoke('creator-connect', { body })
    if (requestUserId && client.auth) {
      const current = await client.auth.getUser()
      if (current.error || current.data.user?.id !== requestUserId) await identityChanged()
    }
    if (response.error) {
      const context = response.error.context
      if (context instanceof Response && context.status === 403) {
        const failure: unknown = await context
          .clone()
          .json()
          .catch(() => null)
        if (failure && typeof failure === 'object' && 'error' in failure) {
          if (failure.error === 'reauthentication_required' || failure.error === 'mfa_required') {
            confirmationUserId = requestUserId
            throw failure.error === 'mfa_required'
              ? new ConnectMfaRequired()
              : new ConnectReauthenticationRequired()
          }
        }
      }
      throw Error(
        'Payout setup could not be loaded. Please retry or ask your administrator to check the connection.',
      )
    }
    return response.data
  }
  return {
    status: async () => mapConnectStatus(await request({ action: 'status' })),
    reauthenticate: async (password) => {
      const auth = client?.auth
      if (!auth) throw Error('Sign in again to confirm your identity, then reopen payout setup.')
      const before = await auth.getUser()
      const user = before.data.user
      if (before.error || !user?.id || !user.email)
        throw Error('Sign in again before setting up payouts.')
      if (confirmationUserId && confirmationUserId !== user.id) await identityChanged()
      confirmationUserId = user.id
      const result = await auth.signInWithPassword({ email: user.email, password })
      if (result.error) throw Error('Your password could not be verified. Please try again.')
      const after = await auth.getUser()
      if (
        !result.data.session ||
        result.data.user?.id !== user.id ||
        after.error ||
        after.data.user?.id !== user.id
      ) {
        await identityChanged()
      }
      const factors = await auth.mfa.listFactors()
      if (factors.error)
        throw Error('Your account security could not be verified. Please sign in again.')
      if (factors.data.all.some((factor) => factor.status === 'verified')) {
        if (
          !factors.data.all.some(
            (factor) => factor.status === 'verified' && factor.factor_type === 'totp',
          )
        )
          throw Error(
            'Complete a fresh sign-in with your verification method, then reopen payout setup.',
          )
        throw new ConnectMfaRequired()
      }
    },
    verifyMfa: async (code) => {
      const auth = client?.auth
      if (!auth) throw Error('Sign in again with your verification code, then reopen payout setup.')
      if (!/^\d{6}$/.test(code))
        throw Error('Enter the six-digit code from your authenticator app.')
      const before = await auth.getUser()
      const user = before.data.user
      if (before.error || !user?.id) throw Error('Sign in again before setting up payouts.')
      if (confirmationUserId && confirmationUserId !== user.id) await identityChanged()
      confirmationUserId = user.id
      const factors = await auth.mfa.listFactors()
      if (factors.error)
        throw Error('Your account security could not be verified. Please sign in again.')
      const factor = factors.data.all.find(
        (item) => item.status === 'verified' && item.factor_type === 'totp',
      )
      if (!factor)
        throw Error(
          'Complete a fresh sign-in with your verification method, then reopen payout setup.',
        )
      const result = await auth.mfa.challengeAndVerify({ factorId: factor.id, code })
      if (result.error)
        throw Error('The verification code could not be confirmed. Please try a fresh code.')
      const after = await auth.getUser()
      if (after.error || after.data.user?.id !== user.id) await identityChanged()
    },
    session: async (bindingId, country) =>
      mapConnectSession(
        await request({
          action: 'session',
          binding_id: bindingId,
          ...(country ? { country } : {}),
        }),
        bindingId,
      ),
  }
}
