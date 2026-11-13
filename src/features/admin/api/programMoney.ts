import { bpsToPercent, formatMoney, minorToDollars } from '../../../merchant/programs'
import { singleAdminRow } from './mappers'
import type { AdminDataError } from './types'

/**
 * Program money on the admin Settings page: the platform switch, the KissMyApps fee, the
 * minimum first deposit and the totals, as `get_admin_program_money` and
 * `configure_admin_program_money` answer them. Every reading of those answers lives here.
 */

/** Amounts in minor units, one per currency: `{"USD": 823600}`. */
export type AdminMoneyByCurrency = Readonly<Record<string, number>>

export type AdminProgramMoneyTotals = Readonly<{
  programsWithBalance: number
  /** In merchants' balances and not set aside. */
  availableMinorByCurrency: AdminMoneyByCurrency
  /** Set aside for commission inside its hold, and the fee on it. */
  reservedMinorByCurrency: AdminMoneyByCurrency
  /** Approved commission that has not been paid out. */
  owedToCreatorsMinorByCurrency: AdminMoneyByCurrency
}>

export type AdminProgramMoney = Readonly<{
  enabled: boolean
  feeBps: number
  minDepositMinor: number
  /** The version the next change must name. Null when the answer does not carry one. */
  updatedAt: string | null
  /** Null when an answer left the totals out, as a change may. */
  totals: AdminProgramMoneyTotals | null
}>

export type AdminProgramMoneyUpdate = Readonly<{
  enabled: boolean
  feeBps: number
  minDepositMinor: number
  expectedUpdatedAt: string | null
}>

/** The limits the database enforces on the two numbers. */
export const PROGRAM_FEE_BPS_MAX = 5000
export const PROGRAM_MIN_DEPOSIT_MINOR_MIN = 100
export const PROGRAM_MIN_DEPOSIT_MINOR_MAX = 100_000_000

// Reading the answers -----------------------------------------------------------------------

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

function root(value: unknown): Record<string, unknown> {
  const outer = object(singleAdminRow(value), 'program money response')
  for (const functionName of ['get_admin_program_money', 'configure_admin_program_money']) {
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

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error('Invalid updated_at.')
  }
  return value
}

function byCurrency(value: unknown, key: string): AdminMoneyByCurrency {
  // No balance in any currency may arrive as an empty object or as null.
  if (value === null || value === undefined) return {}
  const amounts: Record<string, number> = {}
  for (const [currency, amount] of Object.entries(object(value, key))) {
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid ${key}.`)
    amounts[currency] = integer(amount, key)
  }
  return amounts
}

function totals(row: Record<string, unknown>): AdminProgramMoneyTotals | null {
  const keys = [
    'programs_with_balance',
    'available_minor_by_currency',
    'reserved_minor_by_currency',
    'owed_to_creators_minor_by_currency',
  ]
  // Either the answer carries them, directly or under "totals", or it leaves them all out.
  const source = Object.hasOwn(row, 'totals') ? object(row.totals, 'totals') : row
  if (!keys.some((key) => Object.hasOwn(source, key))) return null
  const programs = integer(source.programs_with_balance, 'programs_with_balance')
  if (programs < 0) throw new Error('Invalid programs_with_balance.')
  return {
    programsWithBalance: programs,
    availableMinorByCurrency: byCurrency(
      source.available_minor_by_currency,
      'available_minor_by_currency',
    ),
    reservedMinorByCurrency: byCurrency(
      source.reserved_minor_by_currency,
      'reserved_minor_by_currency',
    ),
    owedToCreatorsMinorByCurrency: byCurrency(
      source.owed_to_creators_minor_by_currency,
      'owed_to_creators_minor_by_currency',
    ),
  }
}

export function mapAdminProgramMoney(value: unknown): AdminProgramMoney {
  const row = root(value)
  if (typeof row.enabled !== 'boolean') throw new Error('Invalid enabled.')
  const feeBps = integer(row.fee_bps, 'fee_bps')
  const minDepositMinor = integer(row.min_deposit_minor, 'min_deposit_minor')
  if (feeBps < 0 || feeBps > 10_000 || minDepositMinor < 0) {
    throw new Error('Invalid program money settings.')
  }
  return {
    enabled: row.enabled,
    feeBps,
    minDepositMinor,
    updatedAt: timestamp(row.updated_at),
    totals: totals(row),
  }
}

// What a refused change means ---------------------------------------------------------------

export const PROGRAM_MONEY_CHANGED =
  'Platform settings changed in another session. The latest settings were loaded: check them and try again.'

/**
 * The reason `configure_admin_program_money` names in the error's DETAIL, in words. Null when
 * it names none of these, so the caller falls back to the mapping by error code.
 */
export function programMoneyRefusal(detail: string | null | undefined): AdminDataError | null {
  switch (detail?.trim()) {
    case 'invalid_fee_bps':
      return {
        code: 'invalid_input',
        message: 'The fee must be between 0% and 50%.',
        retryable: false,
      }
    case 'invalid_min_deposit_minor':
      return {
        code: 'invalid_input',
        message: 'The minimum first deposit must be between 1.00 and 1,000,000.00.',
        retryable: false,
      }
    case 'settings_changed':
    case 'stale_settings':
      return { code: 'conflict', message: PROGRAM_MONEY_CHANGED, retryable: false }
    default:
      return null
  }
}

// Numbers as people type and read them ------------------------------------------------------

const tidy = (value: string) => value.replace(/[\s,]/g, '')

/** "10" → 1000, "12.5%" → 1250, "0" → 0. Null when it is not a percentage from 0 to 50. */
export function feePercentToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?%?$/.exec(tidy(value))
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps <= PROGRAM_FEE_BPS_MAX ? bps : null
}

/** "50" → 5000, "$1,250.50" → 125050. Null when it is outside 1.00 to 1,000,000.00. */
export function depositToMinor(value: string): number | null {
  const match = /^[$€£]?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(tidy(value))
  if (!match) return null
  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return amount >= PROGRAM_MIN_DEPOSIT_MINOR_MIN && amount <= PROGRAM_MIN_DEPOSIT_MINOR_MAX
    ? amount
    : null
}

/** 1000 → "10", 1250 → "12.5": the fee as it is typed. */
export const feeField = (bps: number) => bpsToPercent(bps)

/** 5000 → "50.00": the minimum first deposit as it is typed. */
export const depositField = (minor: number) => minorToDollars(minor)

/** 1000 → "10%" */
export const feeLabel = (bps: number) => `${bpsToPercent(bps)}%`

/** 5000 → "50.00", grouped: the same number applies in whatever currency a program uses. */
export function depositLabel(minor: number): string {
  return (minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * One amount per currency, US dollars first: ["$8,236.00", "410.00 EUR"]. Empty when there
 * is no money in any currency.
 */
export function moneyByCurrency(amounts: AdminMoneyByCurrency): string[] {
  return Object.entries(amounts)
    .sort(([a], [b]) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)))
    .map(([currency, minor]) => formatMoney(minor, currency))
}
