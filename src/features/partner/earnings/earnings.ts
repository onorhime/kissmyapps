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
  /** In a payout that has been made and has not arrived yet. */
  paying_minor: number
  /** In payouts that arrived. */
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

/** A payout as the database stores it: made, being sent, arrived, or given back. */
export type PayoutStatus = 'approved' | 'processing' | 'paid' | 'failed' | 'canceled'

export interface ProgramPayout {
  id: string
  amount_minor: number
  currency: string
  status: PayoutStatus
  created_at: string | null
  paid_at: string | null
}

/** What can be paid out and from how much. `enabled` is false while payouts are switched off. */
export interface PayoutTerms {
  enabled: boolean
  min_payout_minor: number
  /** The account the creator's payout account belongs to. Null with no program on one. */
  platform_account_id: string | null
  /** Approved earnings per currency, added up over the creator's programs. */
  payable: { currency: string; amount_minor: number }[]
}

export interface ProgramEarnings {
  programs: ProgramEarningsRow[]
  recent: RecentCommission[]
  /** The latest payouts, newest first. Left out by a database from before payouts. */
  payouts?: ProgramPayout[]
  /** Left out by a database from before payouts, which is read as payouts being off. */
  payout?: PayoutTerms
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
    paying_minor: minor(row.paying_minor) ?? 0,
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

/** Null for a status the page has no words for, so the list leaves that payout out. */
function readPayout(value: unknown): ProgramPayout | null {
  const row = record(value)
  const status = oneOf(row?.status, [
    'approved',
    'processing',
    'paid',
    'failed',
    'canceled',
  ] as const)
  if (!row || !status) return null
  const id = text(row.id)
  const currency = currencyCode(row.currency)
  const amount = minor(row.amount_minor)
  if (!id || !currency || amount === null) throw new EarningsUnreadable()
  return {
    id,
    amount_minor: amount,
    currency,
    status,
    created_at: moment(row.created_at),
    paid_at: moment(row.paid_at),
  }
}

/** Payouts are on only when the answer says so and names the smallest payout. */
function readPayoutTerms(value: unknown): PayoutTerms | undefined {
  const body = record(value)
  if (!body) return undefined
  const smallest = minor(body.min_payout_minor)
  const account = text(body.platform_account_id)
  return {
    enabled: body.enabled === true && smallest !== null && smallest > 0,
    min_payout_minor: smallest !== null && smallest > 0 ? smallest : 0,
    platform_account_id: account && /^acct_[A-Za-z0-9]+$/.test(account) ? account : null,
    payable: (Array.isArray(body.payable) ? body.payable : []).flatMap((item) => {
      const row = record(item)
      const currency = currencyCode(row?.currency)
      const amount = minor(row?.amount_minor)
      return currency && amount !== null ? [{ currency, amount_minor: amount }] : []
    }),
  }
}

/**
 * `{"programs": [...], "recent": [...], "payouts": [...], "payout": {...}}` exactly as
 * `partner_program_earnings` sends it. A database from before payouts sends the first two only.
 */
export function readProgramEarnings(value: unknown): ProgramEarnings {
  const body = record(value)
  if (!body || !Array.isArray(body.programs) || !Array.isArray(body.recent))
    throw new EarningsUnreadable()
  const earnings: ProgramEarnings = {
    programs: body.programs.map(readProgramRow),
    recent: body.recent.flatMap((item) => {
      const commission = readCommission(item)
      return commission ? [commission] : []
    }),
  }
  if (Array.isArray(body.payouts))
    earnings.payouts = body.payouts.flatMap((item) => {
      const payout = readPayout(item)
      return payout ? [payout] : []
    })
  const terms = readPayoutTerms(body.payout)
  if (terms) earnings.payout = terms
  return earnings
}

// What there is to show ---------------------------------------------------------------------

/** True when a program has money or sales to show. */
export function programHasEarnings(row: ProgramEarningsRow): boolean {
  return (
    row.pending_minor !== 0 ||
    row.approved_minor !== 0 ||
    row.paying_minor !== 0 ||
    row.paid_minor !== 0 ||
    row.sales > 0
  )
}

/** True when the creator has earned anything through a program, now or before. */
export function hasEarnings(earnings: ProgramEarnings | null): earnings is ProgramEarnings {
  if (!earnings) return false
  return (
    earnings.recent.length > 0 ||
    (earnings.payouts?.length ?? 0) > 0 ||
    earnings.programs.some(programHasEarnings)
  )
}

/**
 * The payout terms when payouts are on for this creator: switched on, and the creator has a
 * program whose money can be paid out. Null otherwise, and the page then shows no payout
 * account, no payouts and no word about when a payout happens.
 */
export function payoutsOn(
  earnings: ProgramEarnings | null,
): (PayoutTerms & { platform_account_id: string }) | null {
  const terms = earnings?.payout
  if (!terms?.enabled || !terms.platform_account_id) return null
  return { ...terms, platform_account_id: terms.platform_account_id }
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

const PAYOUT_SENT: readonly PayoutStatus[] = ['approved', 'processing']

/** A payout's standing in words: "On its way", "Paid 14 Nov". */
export function payoutStatusLine(
  payout: Pick<ProgramPayout, 'status' | 'paid_at'>,
  now: Date = new Date(),
): string {
  if (PAYOUT_SENT.includes(payout.status)) return 'On its way'
  if (payout.status === 'paid')
    return payout.paid_at ? `Paid ${shortDay(payout.paid_at, now)}` : 'Paid'
  return 'Not sent: back in your approved earnings'
}

/** How a payout's row is drawn: on its way, arrived, or given back. */
export function payoutTone(status: PayoutStatus): 'sent' | 'paid' | 'returned' {
  if (PAYOUT_SENT.includes(status)) return 'sent'
  return status === 'paid' ? 'paid' : 'returned'
}

/** "$25.00", "$25.00 or 25.00 EUR", "$25.00, 25.00 EUR or 25.00 GBP". */
function anyOf(amounts: string[]): string {
  if (amounts.length <= 1) return amounts.join('')
  return `${amounts.slice(0, -1).join(', ')} or ${amounts[amounts.length - 1]}`
}

/** The currencies the creator earns in, in the order of their programs. */
function earningCurrencies(earnings: ProgramEarnings): string[] {
  return [
    ...new Set([
      ...earnings.programs.filter(programHasEarnings).map((row) => row.currency),
      ...(earnings.payout?.payable ?? []).map((sum) => sum.currency),
    ]),
  ]
}

/**
 * "KissMyApps pays out approved earnings of $25.00 or more." The smallest payout is one number
 * that holds in each currency, so each currency the creator earns in is named. Null when
 * payouts are off or there is no currency to say it in. It promises no date: a payout is made
 * by a person.
 */
export function payoutRuleLine(earnings: ProgramEarnings): string | null {
  const terms = payoutsOn(earnings)
  const currencies = earningCurrencies(earnings)
  if (!terms || currencies.length === 0) return null
  const smallest = anyOf(
    currencies.map((currency) => formatMoney(terms.min_payout_minor, currency)),
  )
  return `KissMyApps pays out approved earnings of ${smallest} or more.`
}

/**
 * What is waiting for a payout account, for the sentence beside "Set up payouts": the sums that
 * have reached the smallest payout, as "$44.10" or "$44.10 and 30.00 EUR". Null when none has.
 */
export function payableNow(terms: PayoutTerms): string | null {
  const ready = terms.payable.filter(
    (sum) => sum.amount_minor > 0 && sum.amount_minor >= terms.min_payout_minor,
  )
  if (ready.length === 0) return null
  return ready.map((sum) => formatMoney(sum.amount_minor, sum.currency)).join(' and ')
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
