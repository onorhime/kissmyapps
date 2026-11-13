import { formatMoney } from '../../../merchant/programs'
import { oneOf, record, text } from '../../marketplace/model'
import type { PartnerDataError, PartnerDataResult } from '../api/types'

/**
 * A creator's program earnings: what the `partner_program_earnings` database function answers,
 * read into shapes the page can trust, and the words the page uses for them. Every reading of
 * that answer lives in this file.
 */

/** Commission that is set aside (held), the creator's (approved), or given back (reversed). */
export type CommissionStatus = 'held' | 'approved' | 'reversed'

export interface ProgramEarningsRow {
  program_id: string
  slug: string | null
  name: string
  currency: string
  /** Set aside from the brand's balance and still inside the hold. */
  pending_minor: number
  /** Past the hold, the creator's, and not paid out yet. */
  approved_minor: number
  paid_minor: number
  /** Sales with commission that is pending or approved. */
  sales: number
  /** When the earliest pending commission leaves its hold. */
  next_release_at: string | null
}

export interface RecentCommission {
  id: string
  program_id: string | null
  program_name: string
  status: CommissionStatus
  /** What the commission is worth now. */
  amount_minor: number
  /** What it was worth when the sale happened, before any refund. */
  earned_minor: number
  currency: string
  sale_amount_minor: number | null
  paid_at: string | null
  hold_until: string | null
  approved_at: string | null
}

export interface ProgramEarnings {
  programs: ProgramEarningsRow[]
  recent: RecentCommission[]
}

export type ProgramEarningsResult = PartnerDataResult<ProgramEarnings | null>

export class EarningsUnreadable extends Error {
  constructor() {
    super('The earnings answer could not be read.')
    this.name = 'EarningsUnreadable'
  }
}

// Reading the answer ------------------------------------------------------------------------

const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** An amount in minor units. Postgres sends a number; a sum can arrive as a string of digits. */
function minor(value: unknown): number | null {
  const number =
    typeof value === 'string' && /^-?\d{1,15}$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null
  return number !== null && Number.isSafeInteger(number) ? number : null
}

const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null

/** A row of money must be whole: a missing amount is refused, never shown as zero. */
function readProgramRow(value: unknown): ProgramEarningsRow {
  const row = record(value)
  const programId = text(row?.program_id)
  const name = text(row?.name)
  const currency = currencyCode(row?.currency)
  const pending = minor(row?.pending_minor)
  const approved = minor(row?.approved_minor)
  if (!row || !programId || !name || !currency || pending === null || approved === null)
    throw new EarningsUnreadable()
  return {
    program_id: programId,
    slug: text(row.slug),
    name,
    currency,
    pending_minor: pending,
    approved_minor: approved,
    paid_minor: minor(row.paid_minor) ?? 0,
    sales: Math.max(0, minor(row.sales) ?? 0),
    next_release_at: moment(row.next_release_at),
  }
}

/** Null for a status the page has no words for, so the list leaves that row out. */
function readCommission(value: unknown): RecentCommission | null {
  const row = record(value)
  const status = oneOf(row?.status, ['held', 'approved', 'reversed'] as const)
  if (!row || !status) return null
  const id = text(row.id)
  const currency = currencyCode(row.currency)
  const amount = minor(row.amount_minor)
  if (!id || !currency || amount === null) throw new EarningsUnreadable()
  return {
    id,
    program_id: text(row.program_id),
    program_name: text(row.program_name) ?? 'Program',
    status,
    amount_minor: amount,
    earned_minor: minor(row.earned_minor) ?? amount,
    currency,
    sale_amount_minor: minor(row.sale_amount_minor),
    paid_at: moment(row.paid_at),
    hold_until: moment(row.hold_until),
    approved_at: moment(row.approved_at),
  }
}

/** `{"programs": [...], "recent": [...]}` exactly as `partner_program_earnings` sends it. */
export function readProgramEarnings(value: unknown): ProgramEarnings {
  const body = record(value)
  if (!body || !Array.isArray(body.programs) || !Array.isArray(body.recent))
    throw new EarningsUnreadable()
  return {
    programs: body.programs.map(readProgramRow),
    recent: body.recent.flatMap((item) => {
      const commission = readCommission(item)
      return commission ? [commission] : []
    }),
  }
}

// What there is to show ---------------------------------------------------------------------

/** True when the creator has earned anything through a program, now or before. */
export function hasEarnings(earnings: ProgramEarnings | null): earnings is ProgramEarnings {
  if (!earnings) return false
  return (
    earnings.recent.length > 0 ||
    earnings.programs.some(
      (row) =>
        row.pending_minor !== 0 ||
        row.approved_minor !== 0 ||
        row.paid_minor !== 0 ||
        row.sales > 0,
    )
  )
}

/**
 * A creator with no programs behind them is shown nothing rather than an error: the function
 * is missing on a database that has not been migrated yet, the connection is not set up, or
 * the account is not an active creator account (which the rest of the page already says).
 */
export function nothingToShow(result: ProgramEarningsResult): boolean {
  if (result.status === 'unconfigured') return true
  return ['contract_unavailable', 'not_configured', 'not_authorized'].includes(
    result.error?.code ?? '',
  )
}

/** The earnings of one program, found by its id or, failing that, its slug. */
export function earningsOfProgram(
  earnings: ProgramEarnings | null,
  program: { id: string | null; slug: string },
): ProgramEarningsRow | null {
  if (!earnings) return null
  return (
    earnings.programs.find((row) => program.id !== null && row.program_id === program.id) ??
    earnings.programs.find((row) => row.slug !== null && row.slug === program.slug) ??
    null
  )
}

/** "Pending $44.10 · Approved $14.70", or null when there is nothing in either. */
export function earningsLine(row: ProgramEarningsRow | null): string | null {
  if (!row || (row.pending_minor <= 0 && row.approved_minor <= 0)) return null
  return `Pending ${formatMoney(row.pending_minor, row.currency)} · Approved ${formatMoney(row.approved_minor, row.currency)}`
}

export function salesCount(sales: number): string {
  return sales === 1 ? '1 sale' : `${sales.toLocaleString('en-US')} sales`
}

// Words -------------------------------------------------------------------------------------

const dayAndMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/** "14 Dec", with the year only when it is not this one: "3 Jan 2027". */
export function shortDay(time: string, now: Date = new Date()): string {
  const date = new Date(time)
  return (date.getFullYear() === now.getFullYear() ? dayAndMonth : dayMonthYear).format(date)
}

/** A commission's standing in words: "Pending until 14 Dec", "Approved". */
export function commissionStatusLine(
  commission: Pick<RecentCommission, 'status' | 'hold_until'>,
  now: Date = new Date(),
): string {
  if (commission.status === 'approved') return 'Approved'
  if (commission.status === 'reversed') return 'Returned to the brand after a refund'
  // Past its hold and still pending: it is approved on the next pass, or the sale is disputed.
  if (!commission.hold_until || Date.parse(commission.hold_until) <= now.getTime()) return 'Pending'
  return `Pending until ${shortDay(commission.hold_until, now)}`
}

/**
 * The amount on a commission's row: what it is worth now, or what was given back. `was` is the
 * first amount when a partial refund has since reduced it.
 */
export function commissionAmount(commission: RecentCommission): {
  amount: string
  was: string | null
} {
  if (commission.status === 'reversed')
    return { amount: formatMoney(commission.earned_minor, commission.currency), was: null }
  return {
    amount: formatMoney(commission.amount_minor, commission.currency),
    was:
      commission.earned_minor > commission.amount_minor
        ? formatMoney(commission.earned_minor, commission.currency)
        : null,
  }
}

/** The sentence under "Program earnings did not load". Never the database's own words. */
export function earningsErrorMessage(error: PartnerDataError | null): string {
  switch (error?.code) {
    case 'not_authenticated':
      return 'Your session has expired. Sign in again to see your earnings.'
    case 'invalid_response':
      return 'The answer could not be read. Try again.'
    case 'temporarily_unavailable':
      return 'That did not go through. Check your connection and try again.'
    default:
      return 'That did not go through. Try again.'
  }
}
