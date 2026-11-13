import { formatMoney } from '../../../merchant/programs'
import { singleAdminRow } from '../api/mappers'
import type { AdminMoneyByCurrency } from '../api/programMoney'
import type { AdminDataError } from '../api/types'

/**
 * Program payouts in the admin app: who can be paid and how much, what is on its way and what
 * was paid, as `get_admin_program_payouts`, `perform_admin_program_payout` and
 * `configure_admin_program_payouts` answer them. Every reading of those answers, every input
 * sent to them and every sentence about a refusal lives here.
 */

// What the database answers -----------------------------------------------------------------

export const PAYOUT_BLOCKERS = [
  'payouts_off',
  'platform_not_ready',
  'payout_open',
  'no_account',
  'account_not_ready',
  'below_minimum',
] as const

/** Why a creator cannot be paid now. `other` is a reason this app does not know yet. */
export type AdminPayoutBlocker = (typeof PAYOUT_BLOCKERS)[number] | 'other'

export const PAYOUT_ACCOUNT_STATUSES = ['not_connected', 'pending', 'ready', 'restricted'] as const
export type AdminPayoutAccountStatus = (typeof PAYOUT_ACCOUNT_STATUSES)[number]

export type AdminPayoutProgram = Readonly<{
  programId: string
  name: string
  amountMinor: number
}>

/** One creator in one currency: amounts in different currencies are never added together. */
export type AdminPayoutCreator = Readonly<{
  affiliateId: string
  name: string
  currency: string
  payableMinor: number
  programs: readonly AdminPayoutProgram[]
  accountStatus: AdminPayoutAccountStatus
  accountCountry: string | null
  /** Null when the creator can be paid now. */
  blocker: AdminPayoutBlocker | null
}>

export type AdminOpenPayout = Readonly<{
  id: string
  affiliateId: string
  name: string
  currency: string
  amountMinor: number
  status: 'approved' | 'processing'
  attempts: number
  failureCode: string | null
  createdAt: string
  nextAttemptAt: string | null
  canCancel: boolean
}>

export type AdminClosedPayout = Readonly<{
  id: string
  affiliateId: string
  name: string
  currency: string
  amountMinor: number
  status: 'paid' | 'failed' | 'canceled'
  failureCode: string | null
  createdAt: string
  closedAt: string | null
  transferId: string | null
}>

export type AdminProgramPayouts = Readonly<{
  enabled: boolean
  /** Program money, which payouts need, is on. */
  moneyEnabled: boolean
  minPayoutMinor: number
  /** The settings version a change must name. */
  updatedAt: string | null
  /** Null until a program has a balance. */
  platform: Readonly<{ accountId: string; registered: boolean; enabled: boolean }> | null
  creators: readonly AdminPayoutCreator[]
  open: readonly AdminOpenPayout[]
  recent: readonly AdminClosedPayout[]
  totals: Readonly<{
    readyMinorByCurrency: AdminMoneyByCurrency
    readyCount: number
    waitingMinorByCurrency: AdminMoneyByCurrency
    paidMinorByCurrency: AdminMoneyByCurrency
  }>
}>

// What is sent ------------------------------------------------------------------------------

/**
 * Paying names the amount on screen, so the database refuses when it is no longer that amount.
 */
export type AdminProgramPayoutAction =
  | Readonly<{ action: 'pay'; affiliateId: string; currency: string; expectedAmountMinor: number }>
  | Readonly<{
      action: 'pay_ready'
      currency: string
      expectedCount: number
      expectedTotalMinor: number
    }>
  | Readonly<{ action: 'cancel'; payoutId: string }>

export type AdminProgramPayoutSettings = Readonly<{
  enabled: boolean
  minPayoutMinor: number
  expectedUpdatedAt: string | null
}>

/** The limits the database enforces. */
export const PROGRAM_MIN_PAYOUT_MINOR_MIN = 100
export const PROGRAM_MIN_PAYOUT_MINOR_MAX = 100_000_000

const isCurrency = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value)
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** The input for `perform_admin_program_payout`, or null when it must not be sent. */
export function programPayoutActionInput(
  input: AdminProgramPayoutAction,
): Record<string, unknown> | null {
  if (input.action === 'pay') {
    if (!isId(input.affiliateId) || !isCurrency(input.currency)) return null
    if (!isAmount(input.expectedAmountMinor)) return null
    return {
      action: 'pay',
      affiliate_id: input.affiliateId,
      currency: input.currency,
      expected_amount_minor: input.expectedAmountMinor,
    }
  }
  if (input.action === 'pay_ready') {
    if (!isCurrency(input.currency) || !isAmount(input.expectedTotalMinor)) return null
    if (!isAmount(input.expectedCount)) return null
    return {
      action: 'pay_ready',
      currency: input.currency,
      expected_count: input.expectedCount,
      expected_total_minor: input.expectedTotalMinor,
    }
  }
  if (input.action === 'cancel') {
    return isId(input.payoutId) ? { action: 'cancel', payout_id: input.payoutId } : null
  }
  return null
}

/** The input for `configure_admin_program_payouts`, or the sentence that says why not. */
export function programPayoutSettingsInput(
  input: AdminProgramPayoutSettings,
): Readonly<{ input: Record<string, unknown> }> | Readonly<{ refused: string }> {
  if (typeof input.enabled !== 'boolean') return { refused: PAYOUT_REQUEST_REFUSED }
  if (
    !Number.isInteger(input.minPayoutMinor) ||
    input.minPayoutMinor < PROGRAM_MIN_PAYOUT_MINOR_MIN ||
    input.minPayoutMinor > PROGRAM_MIN_PAYOUT_MINOR_MAX
  ) {
    return { refused: MIN_PAYOUT_RANGE }
  }
  if (
    typeof input.expectedUpdatedAt !== 'string' ||
    !input.expectedUpdatedAt.trim() ||
    Number.isNaN(Date.parse(input.expectedUpdatedAt))
  ) {
    return { refused: 'Refresh this page before changing payout settings.' }
  }
  return {
    input: {
      enabled: input.enabled,
      min_payout_minor: input.minPayoutMinor,
      expected_updated_at: input.expectedUpdatedAt,
    },
  }
}

// Reading the answers -----------------------------------------------------------------------

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

const FUNCTIONS = [
  'get_admin_program_payouts',
  'perform_admin_program_payout',
  'configure_admin_program_payouts',
]

function root(value: unknown): Record<string, unknown> {
  const outer = object(singleAdminRow(value), 'program payouts response')
  for (const functionName of FUNCTIONS) {
    if (Object.hasOwn(outer, functionName)) return object(outer[functionName], functionName)
  }
  return outer
}

/** A whole number. Postgres sends a number; a large sum can arrive as a string of digits. */
function integer(value: unknown, key: string): number {
  const number =
    typeof value === 'string' && /^-?\d{1,15}$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${key}.`)
  return number
}

function amount(value: unknown, key: string): number {
  const number = integer(value, key)
  if (number < 0) throw new Error(`Invalid ${key}.`)
  return number
}

function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}.`)
  return value
}

/** A name is shown as it is; one that is missing is shown as "Unnamed creator". */
function name(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value: unknown, key: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error(`Invalid ${key}.`)
  return value
}

function optionalTime(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${key}.`)
  }
  return value
}

function time(value: unknown, key: string): string {
  const read = optionalTime(value, key)
  if (read === null) throw new Error(`Invalid ${key}.`)
  return read
}

function currency(value: unknown): string {
  if (!isCurrency(value)) throw new Error('Invalid currency.')
  return value
}

function list(value: unknown, key: string): unknown[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Invalid ${key}.`)
  return value
}

function byCurrency(value: unknown, key: string): AdminMoneyByCurrency {
  // No money in any currency may arrive as an empty object or as null.
  if (value === null || value === undefined) return {}
  const amounts: Record<string, number> = {}
  for (const [code, minor] of Object.entries(object(value, key))) {
    if (!isCurrency(code)) throw new Error(`Invalid ${key}.`)
    amounts[code] = amount(minor, key)
  }
  return amounts
}

function blocker(value: unknown): AdminPayoutBlocker | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Invalid blocker.')
  // A reason this app does not know still blocks: it must never read as "can be paid".
  return (PAYOUT_BLOCKERS as readonly string[]).includes(value)
    ? (value as AdminPayoutBlocker)
    : 'other'
}

function accountStatus(value: unknown): AdminPayoutAccountStatus {
  return (PAYOUT_ACCOUNT_STATUSES as readonly unknown[]).includes(value)
    ? (value as AdminPayoutAccountStatus)
    : 'not_connected'
}

function creator(value: unknown): AdminPayoutCreator {
  const row = object(value, 'creator')
  return {
    affiliateId: text(row.affiliate_id, 'affiliate_id'),
    name: name(row.name),
    currency: currency(row.currency),
    payableMinor: amount(row.payable_minor, 'payable_minor'),
    programs: list(row.programs, 'programs').map((entry) => {
      const program = object(entry, 'program')
      return {
        programId: text(program.program_id, 'program_id'),
        name: name(program.name),
        amountMinor: amount(program.amount_minor, 'amount_minor'),
      }
    }),
    accountStatus: accountStatus(row.account_status),
    accountCountry: optionalText(row.account_country, 'account_country'),
    blocker: blocker(row.blocker),
  }
}

function openPayout(value: unknown): AdminOpenPayout {
  const row = object(value, 'open payout')
  if (row.status !== 'approved' && row.status !== 'processing') throw new Error('Invalid status.')
  return {
    id: text(row.id, 'id'),
    affiliateId: text(row.affiliate_id, 'affiliate_id'),
    name: name(row.name),
    currency: currency(row.currency),
    amountMinor: amount(row.amount_minor, 'amount_minor'),
    status: row.status,
    attempts: amount(row.attempts ?? 0, 'attempts'),
    failureCode: optionalText(row.failure_code, 'failure_code'),
    createdAt: time(row.created_at, 'created_at'),
    nextAttemptAt: optionalTime(row.next_attempt_at, 'next_attempt_at'),
    // Only an explicit yes offers Cancel.
    canCancel: row.can_cancel === true,
  }
}

function closedPayout(value: unknown): AdminClosedPayout {
  const row = object(value, 'recent payout')
  if (row.status !== 'paid' && row.status !== 'failed' && row.status !== 'canceled') {
    throw new Error('Invalid status.')
  }
  return {
    id: text(row.id, 'id'),
    affiliateId: text(row.affiliate_id, 'affiliate_id'),
    name: name(row.name),
    currency: currency(row.currency),
    amountMinor: amount(row.amount_minor, 'amount_minor'),
    status: row.status,
    failureCode: optionalText(row.failure_code, 'failure_code'),
    createdAt: time(row.created_at, 'created_at'),
    closedAt: optionalTime(row.closed_at, 'closed_at'),
    transferId: optionalText(row.transfer_id, 'transfer_id'),
  }
}

function platform(value: unknown): AdminProgramPayouts['platform'] {
  if (value === null || value === undefined) return null
  const row = object(value, 'platform')
  return {
    accountId: text(row.account_id, 'account_id'),
    registered: row.registered === true,
    enabled: row.enabled === true,
  }
}

export function mapAdminProgramPayouts(value: unknown): AdminProgramPayouts {
  const row = root(value)
  if (typeof row.enabled !== 'boolean') throw new Error('Invalid enabled.')
  if (typeof row.money_enabled !== 'boolean') throw new Error('Invalid money_enabled.')
  const totals = object(row.totals, 'totals')
  return {
    enabled: row.enabled,
    moneyEnabled: row.money_enabled,
    minPayoutMinor: amount(row.min_payout_minor, 'min_payout_minor'),
    updatedAt: optionalTime(row.updated_at, 'updated_at'),
    platform: platform(row.platform),
    creators: list(row.creators, 'creators').map(creator),
    open: list(row.open, 'open').map(openPayout),
    recent: list(row.recent, 'recent').map(closedPayout),
    totals: {
      readyMinorByCurrency: byCurrency(totals.ready_minor_by_currency, 'ready_minor_by_currency'),
      readyCount: amount(totals.ready_count ?? 0, 'ready_count'),
      waitingMinorByCurrency: byCurrency(
        totals.waiting_minor_by_currency,
        'waiting_minor_by_currency',
      ),
      paidMinorByCurrency: byCurrency(totals.paid_minor_by_currency, 'paid_minor_by_currency'),
    },
  }
}

// What a refusal means ----------------------------------------------------------------------

export const PAYOUT_AMOUNT_CHANGED =
  'The amounts changed since this list was loaded, so nothing was sent. Check the new amounts and pay again.'
export const PAYOUT_NOT_PAYABLE =
  'This creator cannot be paid right now, so nothing was sent. The list shows why.'
export const PAYOUT_NOT_CANCELABLE =
  'This payout has already started sending, so it cannot be canceled.'
export const PAYOUT_SETTINGS_CHANGED =
  'Payout settings changed in another session. The latest were loaded: check them and try again.'
export const PAYOUT_MONEY_OFF = 'Switch on program money in Settings first. Payouts need it.'
export const PAYOUT_NO_PLATFORM = 'Payouts can be switched on once a program has a balance.'
export const PAYOUT_REQUEST_REFUSED = 'That request was not accepted. Nothing was changed.'
export const PAYOUT_LIST_CHANGED =
  'This list changed since it was loaded, so nothing was done. It has been reloaded.'
const MIN_PAYOUT_RANGE = 'The smallest payout must be between 1.00 and 1,000,000.00.'

export const BLOCKER_WORDS: Readonly<Record<AdminPayoutBlocker, string>> = Object.freeze({
  no_account: 'No payout account yet',
  account_not_ready: 'Payout account needs attention',
  below_minimum: 'Below the smallest payout',
  payout_open: 'A payout is on its way',
  payouts_off: 'Payouts are switched off',
  platform_not_ready: 'Platform is not set up for payouts',
  other: 'Cannot be paid yet',
})

const refusal = (code: AdminDataError['code'], message: string): AdminDataError => ({
  code,
  message,
  retryable: false,
})

/**
 * The reason a payout function names in the error's DETAIL, in words. Null when it names none
 * of these, so the caller falls back to the mapping by error code. `not_payable` carries the
 * blocker in its message, and that blocker is said in the same words the list uses.
 */
export function programPayoutRefusal(
  detail: string | null | undefined,
  message?: string | null,
): AdminDataError | null {
  switch (detail?.trim()) {
    case 'amount_changed':
      return refusal('conflict', PAYOUT_AMOUNT_CHANGED)
    case 'not_payable': {
      const named = PAYOUT_BLOCKERS.find((code) => message?.includes(code))
      return refusal(
        'invalid_state',
        named
          ? `This creator cannot be paid right now, so nothing was sent: ${BLOCKER_WORDS[named].toLowerCase()}.`
          : PAYOUT_NOT_PAYABLE,
      )
    }
    case 'not_cancelable':
      return refusal('invalid_state', PAYOUT_NOT_CANCELABLE)
    case 'settings_changed':
      return refusal('conflict', PAYOUT_SETTINGS_CHANGED)
    case 'money_disabled':
      return refusal('invalid_state', PAYOUT_MONEY_OFF)
    case 'no_platform':
      return refusal('invalid_state', PAYOUT_NO_PLATFORM)
    case 'invalid_min_payout_minor':
      return refusal('invalid_input', MIN_PAYOUT_RANGE)
    case 'invalid_enabled':
    case 'invalid_expected_updated_at':
    case 'invalid_input':
      return refusal('invalid_input', PAYOUT_REQUEST_REFUSED)
    default:
      return null
  }
}

/** The sentences for a refusal that names no reason, by error code. */
export const PROGRAM_PAYOUT_FAILURES = Object.freeze({
  conflict: PAYOUT_LIST_CHANGED,
  invalidInput: PAYOUT_REQUEST_REFUSED,
  invalidReference: PAYOUT_LIST_CHANGED,
  invalidState: PAYOUT_LIST_CHANGED,
})

// Words and numbers as people read them -----------------------------------------------------

export const creatorName = (value: string) => value || 'Unnamed creator'

export const payoutMoney = (minor: number, code: string) => formatMoney(minor, code)

/**
 * Why Stripe did not take a transfer, in a few plain words. The worker records a short code;
 * the codes are grouped by what an admin can do about them.
 */
export function payoutFailureWords(code: string | null): string | null {
  if (!code) return null
  const value = code.toLowerCase()
  if (/balance|insufficient/.test(value)) return 'Platform balance too low'
  if (/currenc/.test(value)) return 'Account cannot receive this currency'
  if (/country|cross_border|route/.test(value)) return 'Account country cannot be paid'
  if (/not_found|missing/.test(value)) return 'Stripe has no record of the transfer'
  if (/account|destination|recipient|restricted|not_ready|capabilit/.test(value)) {
    return 'Payout account could not receive it'
  }
  if (/unavailable|timeout|unknown|network|rate_limit/.test(value)) return 'Stripe did not answer'
  return 'Stripe refused the transfer'
}

/** Where a payout that has not finished stands. */
export function openPayoutWords(payout: AdminOpenPayout): string {
  if (payout.status === 'approved') return 'Queued'
  if (payout.attempts <= 1 && !payout.failureCode) return 'Sending'
  const reason = payoutFailureWords(payout.failureCode)
  return reason
    ? `Trying again: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
    : 'Trying again'
}

/** "14 Nov", with the year when it is not this one. Dates are read in UTC. */
export function payoutDate(value: string | null, now: Date = new Date()): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(date.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
  })
}

/** The currencies in a list, US dollars first. */
export function currenciesOf(rows: readonly Readonly<{ currency: string }>[]): string[] {
  return [...new Set(rows.map((row) => row.currency))].sort((a, b) =>
    a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b),
  )
}
