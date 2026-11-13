import { requireSupabaseClient } from '../lib/supabase'

/**
 * The workspace's Stripe connection: the calls to the `workspace-stripe-connect` function,
 * what its errors mean to a business owner, and the return trip from Stripe.
 */

const FUNCTION = 'workspace-stripe-connect'

export interface StripeConnection {
  status: string
  account_id: string
  business_name: string
  country: string | null
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  connected_at: string | null
}

export interface StripePayments {
  /** Payments KissMyApps has received from this Stripe account. */
  seen: number
  /** Those that carried a creator's tag. */
  tagged: number
  last_at: string | null
  last_tagged_at: string | null
}

export interface StripeStatus {
  enabled: boolean
  workspace_id: string
  can_manage: boolean
  connection: StripeConnection | null
  payments: StripePayments
}

/** What the person was doing when a request failed; it decides the way forward. */
export type ConnectStep = 'load' | 'start' | 'complete' | 'disconnect'

/**
 * How the person gets past a problem: run the same request again, press Connect Stripe
 * again, finish something in Stripe first, sign in again, or nothing they can do alone.
 */
export type Recovery = 'retry' | 'connect' | 'stripe' | 'sign-in' | 'none'

export interface ConnectProblem {
  code: string
  message: string
  recovery: Recovery
}

export class ConnectError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.status = status
  }
}

type Client = {
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): PromiseLike<{ data: unknown; error: { context?: unknown } | null }>
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const unreadable = () =>
  new ConnectError('response_unreadable', 'The connection response could not be read.')

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** Reads a Status answer, refusing one that cannot be trusted to draw the page. */
export function readStatus(value: unknown, workspaceId: string): StripeStatus {
  const body = record(value)
  if (!body || typeof body.enabled !== 'boolean') throw unreadable()
  const payments = record(body.payments) ?? {}
  const linked = record(body.connection)
  let connection: StripeConnection | null = null
  if (linked) {
    if (typeof linked.account_id !== 'string' || !/^acct_[A-Za-z0-9]+$/.test(linked.account_id))
      throw unreadable()
    connection = {
      status: typeof linked.status === 'string' ? linked.status : 'active',
      account_id: linked.account_id,
      business_name: typeof linked.business_name === 'string' ? linked.business_name.trim() : '',
      country: typeof linked.country === 'string' && linked.country ? linked.country : null,
      charges_enabled: linked.charges_enabled !== false,
      payouts_enabled: linked.payouts_enabled !== false,
      details_submitted: linked.details_submitted !== false,
      connected_at: moment(linked.connected_at),
    }
  }
  return {
    enabled: body.enabled,
    workspace_id: typeof body.workspace_id === 'string' ? body.workspace_id : workspaceId,
    can_manage: body.can_manage === true,
    connection,
    payments: {
      seen: count(payments.seen),
      tagged: count(payments.tagged),
      last_at: moment(payments.last_at),
      last_tagged_at: moment(payments.last_tagged_at),
    },
  }
}

/** Only Stripe's own authorisation page may be opened with the answer to `start`. */
export function readAuthorizationUrl(value: unknown): string {
  const body = record(value)
  try {
    const url = new URL(String(body?.authorization_url))
    if (
      url.protocol === 'https:' &&
      url.hostname === 'connect.stripe.com' &&
      url.pathname === '/oauth/authorize' &&
      !url.username &&
      !url.password
    )
      return url.toString()
  } catch {
    /* Refused below. */
  }
  throw unreadable()
}

async function request(body: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    const client = requireSupabaseClient() as unknown as Client
    response = await client.functions.invoke(FUNCTION, { body })
  } catch {
    throw new ConnectError(offlineCode(), 'The request did not reach KissMyApps.')
  }
  if (!response.error) return response.data
  const answer = response.error.context
  // Without an HTTP answer the request never arrived, or its answer never came back.
  if (!(answer instanceof Response))
    throw new ConnectError(offlineCode(), 'The request did not reach KissMyApps.')
  let failure: Record<string, unknown> = {}
  try {
    failure = record(await answer.clone().json()) ?? {}
  } catch {
    /* The status alone decides the message. */
  }
  // The repo's functions answer errors as { error: code, message, request_id }.
  throw new ConnectError(
    typeof failure.error === 'string' && failure.error ? failure.error : `http_${answer.status}`,
    typeof failure.message === 'string' ? failure.message : '',
    answer.status,
  )
}

function offlineCode(): 'offline' | 'unreachable' {
  return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable'
}

export const stripeConnect = {
  status: async (workspaceId: string) =>
    readStatus(await request({ action: 'status', workspace_id: workspaceId }), workspaceId),
  /** The Stripe page to send the browser to. */
  start: async (workspaceId: string) =>
    readAuthorizationUrl(await request({ action: 'start', workspace_id: workspaceId })),
  /** One use only: the state is spent by the first call, so this is never sent twice. */
  complete: async (state: string, code: string, workspaceId: string) =>
    readStatus(await request({ action: 'complete', state, code }), workspaceId),
  disconnect: async (workspaceId: string) =>
    readStatus(await request({ action: 'disconnect', workspace_id: workspaceId }), workspaceId),
}

/** Leaving for Stripe goes through here, so tests can watch it without leaving the page. */
export const browser = {
  leaveFor(url: string) {
    window.location.assign(url)
  },
}

// What each failure means, in words a business owner can act on ----------------------------

const NOT_AVAILABLE: Omit<ConnectProblem, 'code'> = {
  message: 'Connecting Stripe is not available yet.',
  recovery: 'none',
}
const NOT_FOR_REAL_PAYMENTS: Omit<ConnectProblem, 'code'> = {
  message:
    'That Stripe account is not set up for real payments. Choose the account your customers pay into and connect again.',
  recovery: 'connect',
}

export const problemMessages: Record<string, Omit<ConnectProblem, 'code'>> = {
  console_connect_disabled: NOT_AVAILABLE,
  merchant_provider_disabled: NOT_AVAILABLE,
  not_a_member: {
    message: 'You are no longer a member of this workspace. Ask its owner to add you again.',
    recovery: 'none',
  },
  owner_or_admin_required: {
    message: 'Only an owner or admin can change the Stripe connection. Ask one of them to do this.',
    recovery: 'none',
  },
  stripe_account_in_use: {
    message:
      'That Stripe account is already connected to another KissMyApps workspace. Disconnect it there, or connect a different Stripe account.',
    recovery: 'connect',
  },
  stripe_account_not_ready: {
    message:
      'That Stripe account cannot take payments yet. Finish setting it up in Stripe, then connect again.',
    recovery: 'stripe',
  },
  stripe_not_live: NOT_FOR_REAL_PAYMENTS,
  merchant_scope_mismatch: NOT_FOR_REAL_PAYMENTS,
  connection_in_use: {
    message:
      'Stripe cannot be disconnected while products are still sold through it. Ask KissMyApps to move those products first.',
    recovery: 'none',
  },
  state_invalid: {
    message: 'That connection attempt expired or was already used. Connect Stripe again.',
    recovery: 'connect',
  },
  merchant_provider_unavailable: {
    message: 'Stripe did not respond, so nothing was connected. Connect again in a minute.',
    recovery: 'connect',
  },
  merchant_connection_rejected: {
    message:
      'Stripe would not approve that account. Connect again and choose a Stripe account your business owns.',
    recovery: 'connect',
  },
  merchant_account_ineligible: {
    message:
      'That Stripe account is managed by another platform, so it cannot be connected here. Choose one your business owns directly.',
    recovery: 'connect',
  },
  unauthorized: {
    message: 'Your session has expired. Sign in again to continue.',
    recovery: 'sign-in',
  },
  origin_rejected: {
    message:
      'Stripe can only be connected from merchant.kissmyapps.dev. Open the console there and try again.',
    recovery: 'none',
  },
  rate_limited: {
    message: 'Too many attempts. Wait a minute, then try again.',
    recovery: 'retry',
  },
  offline: {
    message: 'You are offline. Reconnect to the internet and try again.',
    recovery: 'retry',
  },
  unreachable: {
    message: 'KissMyApps could not be reached. Check your connection and try again.',
    recovery: 'retry',
  },
  unavailable: {
    message: 'KissMyApps is briefly unavailable. Try again in a minute.',
    recovery: 'retry',
  },
}

/** When the failure is one we have no words for: what did not happen, and what to do. */
export const fallbackMessages: Record<ConnectStep, Omit<ConnectProblem, 'code'>> = {
  load: { message: 'Your Stripe connection could not be loaded. Try again.', recovery: 'retry' },
  start: { message: 'Stripe could not be opened. Try again.', recovery: 'retry' },
  complete: {
    message:
      'The connection could not be confirmed, so nothing was connected. Connect Stripe again.',
    recovery: 'connect',
  },
  disconnect: { message: 'Stripe could not be disconnected. Try again.', recovery: 'retry' },
}

export const returnMessages = {
  declined: 'You cancelled on Stripe, so nothing was connected.',
  failed: 'Stripe did not finish the connection, so nothing was connected. Connect again.',
  disconnected: 'Stripe is disconnected. KissMyApps no longer sees your sales.',
}

export function describeProblem(problem: unknown, step: ConnectStep): ConnectProblem {
  const code = problem instanceof ConnectError ? problem.code : 'unknown'
  const status = problem instanceof ConnectError ? problem.status : undefined
  const known =
    problemMessages[code] ??
    (status === 401
      ? problemMessages.unauthorized
      : status === 429
        ? problemMessages.rate_limited
        : status === 503
          ? problemMessages.unavailable
          : undefined)
  if (!known) return { code, ...fallbackMessages[step] }
  // Completing spends its one-use state, so it is never run again: the way on is Connect.
  if (step === 'complete' && known.recovery === 'retry')
    return { code, ...fallbackMessages.complete }
  return { code, ...known }
}

/** Whether a failed `complete` may still have connected the account on the server. */
export function outcomeUnknown(problem: unknown): boolean {
  if (!(problem instanceof ConnectError)) return true
  return problem.status === undefined || problem.status >= 500
}

// The return trip from Stripe ---------------------------------------------------------------

export type StripeReturn =
  { kind: 'approved'; state: string; code: string } | { kind: 'declined' } | { kind: 'failed' }

const STATE = /^[A-Za-z0-9_-]{16,256}$/
const CODE = /^[A-Za-z0-9_-]{1,512}$/

/**
 * Reads Stripe's answer from a query string and returns the query without it. Stripe always
 * echoes our `state`; Supabase Auth's own returns (`?code=` alone, or an error with
 * `error_code`) carry none, so they are left for it.
 */
export function readStripeReturn(search: string): { result: StripeReturn; search: string } | null {
  const params = new URLSearchParams(search)
  const state = params.get('state')
  if (!state || !STATE.test(state) || params.has('error_code')) return null
  const code = params.get('code')
  const error = params.get('error')
  let result: StripeReturn
  if (error) result = error === 'access_denied' ? { kind: 'declined' } : { kind: 'failed' }
  else if (code && CODE.test(code)) result = { kind: 'approved', state, code }
  else return null
  for (const name of ['code', 'state', 'scope', 'error', 'error_description']) params.delete(name)
  const rest = params.toString()
  return { result, search: rest ? `?${rest}` : '' }
}

// Held in memory only: the code is spent within seconds and never needs to outlive the page.
let waiting: StripeReturn | null = null

/**
 * Called once as the console starts. Takes Stripe's answer out of the address bar (and so
 * out of history and referrers), keeps every other parameter, and opens Connections.
 */
export function captureStripeReturn(): boolean {
  const found = readStripeReturn(window.location.search)
  if (!found) return false
  waiting = found.result
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${found.search}#connections`,
  )
  return true
}

/** Whether an answer from Stripe is still waiting for the Connections page. */
export function hasStripeReturn(): boolean {
  return waiting !== null
}

/** The waiting answer, left in place: what the page shows before it claims it. */
export function peekStripeReturn(): StripeReturn | null {
  return waiting
}

/** Hands the answer over exactly once, so the code can only be sent once. */
export function claimStripeReturn(): StripeReturn | null {
  const claimed = waiting
  waiting = null
  return claimed
}

// Small pieces of the page's wording --------------------------------------------------------

/** acct_1Q2w3E4r5T6y → the last four, enough to tell two accounts apart. */
export function accountEnding(accountId: string): string {
  return accountId.slice(-4)
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
const shortDayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const clockFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 13 Nov 2026 */
export function formatDay(time: string): string {
  return dayFormat.format(Date.parse(time))
}

/** Today, 09:42 · Yesterday, 18:05 · 3 Nov, 14:20 · 3 Nov 2025 — in the reader's own time. */
export function formatWhen(time: string, now: number): string {
  const at = new Date(Date.parse(time))
  const today = new Date(now)
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(today) - startOfDay(at)) / 86_400_000)
  const clock = clockFormat.format(at)
  if (days <= 0) return `Today, ${clock}`
  if (days === 1) return `Yesterday, ${clock}`
  if (at.getFullYear() === today.getFullYear()) return `${shortDayFormat.format(at)}, ${clock}`
  return dayFormat.format(at)
}
