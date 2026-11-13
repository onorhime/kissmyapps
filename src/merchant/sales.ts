import { requireSupabaseClient } from '../lib/supabase'
import { formatAmount, formatShortDay } from './balance'
import { ProgramError, readFailure } from './programs'
import type { ProgramStatus } from './programs'
import type { PillTone } from './ui/Primitives'

/**
 * The sales creators sent to the workspace's affiliate program: the call to the
 * `workspace_program_sales` database function, what its errors mean to a business owner, and
 * the wording the page is built from. Every backend shape is read in this file only. Money
 * arrives in minor units and is only ever shown in normal units. Nothing about the buyer is
 * part of what the database sends here.
 */

/** How many sales one request asks for. The database allows 1 to 100. */
export const PAGE_SIZE = 50

export type SaleStatus =
  /** Commission is set aside and still in its hold. */
  | 'pending'
  /** Past the hold: the commission is the creator's. */
  | 'approved'
  /** The commission went back to the balance. */
  | 'returned'
  /** The sale earned nothing; `reason` says why. */
  | 'not_earned'
  /** Recorded before commissions were worked out for the program. */
  | 'not_judged'
  /** A status this page has no words for yet: still a sale, so it is still listed. */
  | 'other'

export interface Sale {
  sale_id: string
  paid_at: string
  amount_minor: number
  refunded_minor: number
  /** What the buyer paid in, when it is not the program's currency; null when it was not sent. */
  currency: string | null
  member_id: string | null
  creator_name: string | null
  /** The creator's link the buyer came through; null when the sale is tied to no link. */
  link_name: string | null
  match_source: string | null
  status: SaleStatus
  reason: string | null
  /** What the commission and the fee on it are worth now. Null when none was worked out. */
  commission_minor: number | null
  fee_minor: number | null
  hold_until: string | null
}

export interface SalesProgram {
  id: string
  slug: string | null
  name: string | null
  status: Exclude<ProgramStatus, 'archived'>
}

/** The last `days` days: sales that earned a commission, across every creator. */
export interface SalesSummary {
  days: number
  sales: number
  sales_amount_minor: number
  commission_minor: number
  fee_minor: number
}

export interface SalesState {
  program: SalesProgram | null
  currency: string
  /** Null when the answer carried no summary that can be trusted. */
  summary: SalesSummary | null
  sales: Sale[]
  /** What to ask the next page with; null on the last page. */
  next_before: string | null
}

// Reading answers ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const unreadable = () => new ProgramError('response_unreadable')
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
/** Money is whole minor units or it is not money: nothing is rounded into shape here. */
const minor = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null

const PROGRAM_STATUSES: ReadonlyArray<SalesProgram['status']> = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
]
const SALE_STATUSES: ReadonlyArray<Exclude<SaleStatus, 'other'>> = [
  'pending',
  'approved',
  'returned',
  'not_earned',
  'not_judged',
]

function programFrom(value: unknown): SalesProgram | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !row.id) throw unreadable()
  // An archived program is history: the workspace has no program to list sales for.
  if (row.status === 'archived') return null
  const status = PROGRAM_STATUSES.find((item) => item === row.status)
  if (!status) throw unreadable()
  return { id: row.id, slug: text(row.slug), name: text(row.name), status }
}

/** One sale as the database sends it, or null when the row cannot be trusted. */
function saleFrom(value: unknown): Sale | null {
  const row = record(value)
  const amount = minor(row?.amount_minor)
  const paid = moment(row?.paid_at)
  if (!row || typeof row.sale_id !== 'string' || !row.sale_id || typeof row.status !== 'string')
    return null
  // A sale without its amount or its date is not shown as zero or as today.
  if (amount === null || paid === null) return null
  return {
    sale_id: row.sale_id,
    paid_at: paid,
    amount_minor: amount,
    refunded_minor: minor(row.refunded_minor) ?? 0,
    currency: currencyCode(row.currency),
    member_id: text(row.member_id),
    creator_name: text(row.creator_name),
    // The database names a sale that is tied to no link "No link".
    link_name: text(row.link_name) === 'No link' ? null : text(row.link_name),
    match_source: text(row.match_source),
    status: SALE_STATUSES.find((item) => item === row.status) ?? 'other',
    reason: text(row.reason),
    commission_minor: minor(row.commission_minor),
    fee_minor: minor(row.fee_minor),
    hold_until: moment(row.hold_until),
  }
}

/** The summary, or null when any of its money is missing: a sum is never shown half read. */
function summaryFrom(value: unknown): SalesSummary | null {
  const row = record(value)
  const count = minor(row?.sales)
  const amount = minor(row?.sales_amount_minor)
  const commission = minor(row?.commission_minor)
  const fee = minor(row?.fee_minor)
  if (!row || count === null || amount === null || commission === null || fee === null) return null
  const days = minor(row.days)
  return {
    days: days !== null && days >= 1 && days <= 366 ? days : 30,
    sales: count,
    sales_amount_minor: amount,
    commission_minor: commission,
    fee_minor: fee,
  }
}

/** Reads a `workspace_program_sales` answer, refusing one that cannot draw the page. */
export function readSales(value: unknown): SalesState {
  const body = record(value)
  if (!body || !Array.isArray(body.sales)) throw unreadable()
  const program = programFrom(body.program)
  // Without a program there is nothing to list, whatever else the answer carries.
  if (!program)
    return { program: null, currency: 'USD', summary: null, sales: [], next_before: null }
  return {
    program,
    currency: currencyCode(body.currency) ?? 'USD',
    summary: summaryFrom(body.summary),
    sales: body.sales.flatMap((item) => saleFrom(item) ?? []),
    next_before: moment(body.next_before),
  }
}

// The call ----------------------------------------------------------------------------------

type Client = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { message?: string; details?: string | null; code?: string } | null
  }>
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    response = await (requireSupabaseClient() as unknown as Client).rpc(name, args)
  } catch {
    throw new ProgramError(
      typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable',
    )
  }
  if (response.error) throw readFailure(response.error)
  return response.data
}

export interface SalesQuery {
  /** `next_before` of the page before this one; left out for the first page. */
  before?: string | null
  /** The one creator whose sales to list; left out for everyone's. */
  memberId?: string | null
}

export const sales = {
  list: async (workspaceId: string, query: SalesQuery = {}) =>
    readSales(
      await call('workspace_program_sales', {
        p_workspace_id: workspaceId,
        p_input: {
          limit: PAGE_SIZE,
          before: query.before ?? null,
          member_id: query.memberId ?? null,
        },
      }),
    ),
}

// The page's own arithmetic -----------------------------------------------------------------

/** The list with its next page added. A sale already on the page is not listed twice. */
export function withNextPage(state: SalesState, next: SalesState): SalesState {
  const seen = new Set(state.sales.map((sale) => sale.sale_id))
  return {
    ...state,
    sales: [...state.sales, ...next.sales.filter((sale) => !seen.has(sale.sale_id))],
    // A page that brought nothing new ends the list, so "Show more" can never loop.
    next_before: next.next_before === state.next_before ? null : next.next_before,
  }
}

// The words on the page ---------------------------------------------------------------------

/** Why a sale earned nothing, in the words the Balance page uses for the same things. */
const notEarnedReasons: Record<string, string> = {
  balance_empty: 'Your balance could not cover it',
  program_paused: 'Your program was paused',
  not_a_member: 'The creator was not in your program',
  outside_duration: 'After the commission period',
  currency_mismatch: 'Paid in another currency',
  zero_amount: 'The commission came to zero',
  refunded: 'The sale was refunded',
  no_creator: 'No creator was credited',
  // A program that pays creators for events only.
  sales_not_rewarded: 'Your program pays for events, not sales',
}

export interface SaleStatusWords {
  label: string
  tone: PillTone
  /** One short line under the label for a sale that went another way; null otherwise. */
  detail: string | null
}

/** What became of the commission on a sale, in a word and, for an exception, one short line. */
export function saleStatus(
  sale: Pick<Sale, 'status' | 'reason' | 'hold_until' | 'refunded_minor'>,
): SaleStatusWords {
  switch (sale.status) {
    case 'pending':
      // The usual case stays on one line: the day the hold ends is part of the word.
      return {
        label: sale.hold_until ? `Pending until ${formatShortDay(sale.hold_until)}` : 'Pending',
        tone: 'info',
        detail: null,
      }
    case 'approved':
      return { label: 'Approved', tone: 'positive', detail: null }
    case 'returned':
      return {
        label: 'Returned',
        tone: 'neutral',
        detail: sale.refunded_minor > 0 ? 'The sale was refunded' : 'Back in your balance',
      }
    case 'not_earned': {
      // The two reasons the merchant can do something about stand out from the rest.
      const actionable = sale.reason === 'balance_empty' || sale.reason === 'program_paused'
      return {
        label: 'No commission',
        tone: actionable ? 'warning' : 'neutral',
        detail: notEarnedReasons[sale.reason ?? ''] ?? null,
      }
    }
    case 'not_judged':
      return { label: 'No commission', tone: 'neutral', detail: 'From before commissions started' }
    case 'other':
      return { label: 'Recorded', tone: 'neutral', detail: null }
  }
}

/** Whether a sale has a commission figure to show: one was worked out, whatever became of it. */
export function hasCommission(sale: Pick<Sale, 'status' | 'commission_minor'>): boolean {
  return (
    sale.commission_minor !== null &&
    (sale.status === 'pending' || sale.status === 'approved' || sale.status === 'returned')
  )
}

/** "$10.00 refunded" under the amount of a sale that was partly or wholly refunded. */
export function refundLine(sale: Pick<Sale, 'refunded_minor'>, currency: string): string | null {
  return sale.refunded_minor > 0 ? `${formatAmount(sale.refunded_minor, currency)} refunded` : null
}

/** What the summary counts, in one sentence. */
export function summaryLine(summary: Pick<SalesSummary, 'days'>, filtered: boolean): string {
  const span = summary.days === 1 ? 'the last day' : `the last ${summary.days} days`
  return filtered
    ? `Sales from all creators in ${span} that earned a commission.`
    : `Sales in ${span} that earned a commission.`
}

// What each failure means, in words a business owner can act on ----------------------------

/** What the person was doing when a request failed. */
export type SalesStep = 'load' | 'more'

/** How the person gets past a problem: try again, sign in again, or nothing they can do alone. */
export type SalesRecovery = 'retry' | 'sign-in' | 'none'

export interface SalesProblem {
  code: string
  message: string
  recovery: SalesRecovery
}

export const problemMessages: Record<string, Omit<SalesProblem, 'code'>> = {
  // The only input a person can get wrong is the creator named in the address.
  invalid_input: {
    message: 'That creator could not be found. Remove the filter to see every sale.',
    recovery: 'none',
  },
  not_allowed: {
    message: 'You do not have access to these sales. Ask an owner of the workspace.',
    recovery: 'none',
  },
  not_found: {
    message: 'You are no longer a member of this workspace. Ask its owner to add you again.',
    recovery: 'none',
  },
  unauthorized: {
    message: 'Your session has expired. Sign in again to continue.',
    recovery: 'sign-in',
  },
  offline: {
    message: 'You are offline. Reconnect to the internet and try again.',
    recovery: 'retry',
  },
  unreachable: {
    message: 'KissMyApps could not be reached. Check your connection and try again.',
    recovery: 'retry',
  },
}

/** When the failure is one we have no words for: what did not happen, and what to do. */
export const fallbackMessages: Record<SalesStep, string> = {
  load: 'Your sales could not be loaded. Try again.',
  more: 'More sales could not be loaded. Try again.',
}

export function describeProblem(problem: unknown, step: SalesStep): SalesProblem {
  const code = problem instanceof ProgramError ? problem.code : 'unknown'
  const known = problemMessages[code]
  if (known) return { code, ...known }
  return { code, message: fallbackMessages[step], recovery: 'retry' }
}
