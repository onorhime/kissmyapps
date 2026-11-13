import { formatMoney } from '../../../merchant/programs'
import { oneOf, record, text } from '../../marketplace/model'
import type { PartnerDataError, PartnerDataResult } from '../api/types'
import { absent, readEarnFrom } from '../links/earnFrom'
import type { EarnFrom } from '../links/earnFrom'

/**
 * A creator's results in one program: what the `partner_program_performance` database function
 * answers, read into shapes the page can trust, and the numbers and words the page makes from
 * them. Every reading of that answer lives in this file.
 */

export const PERFORMANCE_DAYS = [7, 30, 90] as const
export type PerformanceDays = (typeof PERFORMANCE_DAYS)[number]

/** What is asked for: one program by its slug (null: the first one) over so many days. */
export interface PerformanceQuery {
  slug: string | null
  days: PerformanceDays
}

export interface PerformanceProgram {
  program_id: string
  slug: string
  name: string
  currency: string
  /**
   * What the program pays for: sales, events such as a sign-up, or both. Left out by a
   * database from before events could be rewarded, which is a program that pays for sales.
   */
  earn_from?: EarnFrom
}

/**
 * Clicks, sales, rewarded events, and what the commission on those sales and the rewards for
 * those events are worth now.
 */
export interface PerformanceCounts {
  clicks: number
  sales: number
  /** Left out by a database from before events could be rewarded: none. */
  events?: number
  earnings_minor: number
}

export interface PerformanceDay extends PerformanceCounts {
  /** A calendar day in the creator's time zone, as `2026-10-14`. */
  day: string
}

export type ChannelKind = 'main' | 'channel' | 'custom' | 'none'

export interface PerformanceChannel extends PerformanceCounts {
  /** Null on the last row, which holds the sales that came through no link. */
  link_id: string | null
  kind: ChannelKind
  channel: string | null
  name: string
}

/** The program's money to date, not only in the days shown. */
export interface PerformanceMoney {
  pending_minor: number
  approved_minor: number
  /** In a payout that has been made and has not arrived yet. */
  paying_minor: number
  paid_minor: number
  /** When the earliest pending commission leaves its hold. */
  next_release_at: string | null
}

/** Commission that is set aside (held), the creator's (approved), or given back (reversed). */
export type SaleStatus = 'held' | 'approved' | 'reversed'

export interface LatestSale {
  /** A sale, or a reward for an event. Left out by an older database: every row is a sale. */
  kind?: 'sale' | 'reward'
  /** What the brand calls the reward: "Account created". Null for a sale. */
  reward_label?: string | null
  /** When the sale was paid, or when the rewarded event happened. */
  paid_at: string | null
  /** The link the sale came through. Null when it came through none. */
  link_name: string | null
  /** What the commission is worth now. */
  amount_minor: number
  status: SaleStatus
}

/** One of the program's rewards, with what it brought in the days shown. */
export interface PerformanceReward {
  key: string
  /** What the brand calls it: "Account created". */
  label: string
  /** What one such event earns. */
  amount_minor: number
  count: number
  earnings_minor: number
}

export interface ProgramPerformance {
  days: PerformanceDays
  timezone: string
  starts_on: string
  ends_on: string
  /** Every program the creator is or was a member of, for the picker. */
  programs: PerformanceProgram[]
  /** The program these numbers are about. Null when the creator has none. */
  program: PerformanceProgram | null
  totals: PerformanceCounts
  /** The same number of days just before the ones shown. */
  previous: PerformanceCounts
  /** One row per day, oldest first, quiet days included. */
  daily: PerformanceDay[]
  channels: PerformanceChannel[]
  money: PerformanceMoney | null
  latest: LatestSale[]
  /**
   * The program's rewards, none in a program that pays for sales. Left out, like the next one,
   * by a database from before events could be rewarded.
   */
  rewards?: PerformanceReward[]
  /** The brand's budget for rewards is used up for this month, so new events earn nothing. */
  budget_reached?: boolean
}

export type ProgramPerformanceResult = PartnerDataResult<ProgramPerformance | null>

export class PerformanceUnreadable extends Error {
  constructor() {
    super('The performance answer could not be read.')
    this.name = 'PerformanceUnreadable'
  }
}

// Reading the answer ------------------------------------------------------------------------

const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** `2026-10-14`, and a day that exists. */
function calendarDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null
}

/** A whole number. Postgres sends a number; a sum can arrive as a string of digits. */
function integer(value: unknown): number | null {
  const number =
    typeof value === 'string' && /^-?\d{1,15}$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null
  return number !== null && Number.isSafeInteger(number) ? number : null
}

/** A count of things: never negative. */
function count(value: unknown): number | null {
  const number = integer(value)
  return number !== null && number >= 0 ? number : null
}

const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null

function readProgram(value: unknown): PerformanceProgram {
  const row = record(value)
  const programId = text(row?.program_id)
  const slug = text(row?.slug)
  const name = text(row?.name)
  const currency = currencyCode(row?.currency)
  const earnFrom = absent(row?.earn_from) ? undefined : readEarnFrom(row.earn_from)
  if (!programId || !slug || !name || !currency || earnFrom === null)
    throw new PerformanceUnreadable()
  // Only an answer that says what the program pays for has the key.
  return {
    program_id: programId,
    slug,
    name,
    currency,
    ...(earnFrom === undefined ? {} : { earn_from: earnFrom }),
  }
}

/** A row of numbers must be whole: a missing one is refused, never shown as zero. */
function readCounts(value: unknown): PerformanceCounts {
  const row = record(value)
  const clicks = count(row?.clicks)
  const sales = count(row?.sales)
  const events = absent(row?.events) ? undefined : count(row.events)
  const earnings = integer(row?.earnings_minor)
  if (clicks === null || sales === null || events === null || earnings === null)
    throw new PerformanceUnreadable()
  // Only an answer that counts events has the key, so an older one reads as it always has.
  return { clicks, sales, ...(events === undefined ? {} : { events }), earnings_minor: earnings }
}

function readDay(value: unknown): PerformanceDay {
  const day = calendarDay(record(value)?.day)
  if (!day) throw new PerformanceUnreadable()
  return { day, ...readCounts(value) }
}

function readChannel(value: unknown): PerformanceChannel {
  const row = record(value)
  const kind = oneOf(row?.kind, ['main', 'channel', 'custom', 'none'] as const)
  const name = text(row?.name)
  const linkId = text(row?.link_id)
  // Only the row for sales that came through no link is without a link.
  if (!row || !kind || !name || (kind === 'none') !== (linkId === null))
    throw new PerformanceUnreadable()
  return { link_id: linkId, kind, channel: text(row.channel), name, ...readCounts(row) }
}

function readMoney(value: unknown): PerformanceMoney | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  const pending = integer(row?.pending_minor)
  const approved = integer(row?.approved_minor)
  const paying = integer(row?.paying_minor)
  const paid = integer(row?.paid_minor)
  if (!row || pending === null || approved === null || paying === null || paid === null)
    throw new PerformanceUnreadable()
  return {
    pending_minor: pending,
    approved_minor: approved,
    paying_minor: paying,
    paid_minor: paid,
    next_release_at: moment(row.next_release_at),
  }
}

/**
 * Null for a status or a kind the page has no words for, so the list leaves that row out. An
 * answer from before events could be rewarded names no kind: every row of it is a sale.
 */
function readLatest(value: unknown): LatestSale | null {
  const row = record(value)
  const status = oneOf(row?.status, ['held', 'approved', 'reversed'] as const)
  const kind = absent(row?.kind) ? undefined : oneOf(row.kind, ['sale', 'reward'] as const)
  if (!row || !status || kind === null) return null
  const amount = integer(row.amount_minor)
  if (amount === null) throw new PerformanceUnreadable()
  return {
    ...(kind === undefined
      ? {}
      : {
          kind,
          reward_label: kind === 'reward' ? (text(row.reward_label)?.trim() ?? null) : null,
        }),
    paid_at: moment(row.paid_at),
    link_name: text(row.link_name),
    amount_minor: amount,
    status,
  }
}

/** A reward's row must be whole: what it is called, what it pays and what it brought. */
function readReward(value: unknown): PerformanceReward {
  const row = record(value)
  const key = text(row?.key)
  const label = text(row?.label)?.trim()
  const amount = count(row?.amount_minor)
  const events = count(row?.count)
  const earnings = integer(row?.earnings_minor)
  if (!key || !label || !amount || events === null || earnings === null)
    throw new PerformanceUnreadable()
  return { key, label, amount_minor: amount, count: events, earnings_minor: earnings }
}

function readRewards(value: unknown): PerformanceReward[] {
  if (!Array.isArray(value)) throw new PerformanceUnreadable()
  return value.map(readReward)
}

const DAY_MS = 86_400_000
const dayTime = (day: string) => Date.parse(`${day}T00:00:00Z`)

/**
 * The answer exactly as `partner_program_performance` sends it. With a program it must hold one
 * row for every day asked for, in order and without a gap, from the first day to the last:
 * anything else would draw a chart that is not the days it says it is.
 */
export function readProgramPerformance(value: unknown): ProgramPerformance {
  const body = record(value)
  const days = PERFORMANCE_DAYS.find((option) => option === body?.days)
  const timezone = text(body?.timezone)
  const startsOn = calendarDay(body?.starts_on)
  const endsOn = calendarDay(body?.ends_on)
  if (
    !body ||
    !days ||
    !timezone ||
    !startsOn ||
    !endsOn ||
    !Array.isArray(body.programs) ||
    !Array.isArray(body.daily) ||
    !Array.isArray(body.channels) ||
    !Array.isArray(body.latest)
  )
    throw new PerformanceUnreadable()
  if (dayTime(endsOn) - dayTime(startsOn) !== (days - 1) * DAY_MS) throw new PerformanceUnreadable()
  if (!absent(body.budget_reached) && typeof body.budget_reached !== 'boolean')
    throw new PerformanceUnreadable()

  const program =
    body.program === null || body.program === undefined ? null : readProgram(body.program)
  const daily = body.daily.map(readDay)
  const inOrder = daily.every(
    (row, index) => dayTime(row.day) === dayTime(startsOn) + index * DAY_MS,
  )
  if (program ? daily.length !== days || !inOrder : daily.length !== 0)
    throw new PerformanceUnreadable()

  return {
    days,
    timezone,
    starts_on: startsOn,
    ends_on: endsOn,
    programs: body.programs.map(readProgram),
    program,
    totals: readCounts(body.totals),
    previous: readCounts(body.previous),
    daily,
    channels: body.channels.map(readChannel),
    money: program ? readMoney(body.money) : null,
    latest: body.latest.flatMap((item) => {
      const sale = readLatest(item)
      return sale ? [sale] : []
    }),
    // Only an answer from a database that rewards events has these two.
    ...(absent(body.rewards) ? {} : { rewards: program ? readRewards(body.rewards) : [] }),
    ...(absent(body.budget_reached)
      ? {}
      : { budget_reached: program !== null && body.budget_reached === true }),
  }
}

/**
 * Nothing to show rather than an error: the function is missing on a database that has not
 * been migrated yet, the connection is not set up, or the account is not an active creator
 * account (which the rest of the dashboard already says).
 */
export function nothingToShow(result: ProgramPerformanceResult): boolean {
  if (result.status === 'unconfigured') return true
  return ['contract_unavailable', 'not_configured', 'not_authorized'].includes(
    result.error?.code ?? '',
  )
}

// Rates -------------------------------------------------------------------------------------

/** What stands in for a rate that cannot be worked out: there were no clicks to divide by. */
export const NO_RATE = '—'

/** Sales for every click, from 0 up. Null with no clicks. */
export function conversionRate(sales: number, clicks: number): number | null {
  return clicks > 0 ? sales / clicks : null
}

/** "2.4%". A dash with no clicks, never 0% and never NaN. */
export function conversionText(sales: number, clicks: number): string {
  const rate = conversionRate(sales, clicks)
  return rate === null ? NO_RATE : `${(rate * 100).toFixed(1)}%`
}

/** Earnings for every click in minor units, to the nearest one. Null with no clicks. */
export function earningsPerClickMinor(earningsMinor: number, clicks: number): number | null {
  return clicks > 0 ? Math.round(earningsMinor / clicks) : null
}

/** "$0.14". A dash with no clicks. */
export function earningsPerClickText(
  earningsMinor: number,
  clicks: number,
  currency: string,
): string {
  const perClick = earningsPerClickMinor(earningsMinor, clicks)
  return perClick === null ? NO_RATE : formatMoney(perClick, currency)
}

// Change against the days before --------------------------------------------------------------

export interface Change {
  direction: 'up' | 'down' | 'same'
  /** How far it moved, never negative. */
  difference: number
}

/**
 * How a number moved against the same number of days before. It is the difference, not a
 * percentage, so a first sale after nothing reads "+1" and not "+∞%". Null when there was
 * nothing in either, because "no change from nothing" says nothing.
 */
export function changeAgainst(current: number, previous: number): Change | null {
  if (current === 0 && previous === 0) return null
  const difference = current - previous
  return {
    direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'same',
    difference: Math.abs(difference),
  }
}

const countFormat = new Intl.NumberFormat('en-US')

export function countText(value: number): string {
  return countFormat.format(value)
}

/** The moved part of a change line: "+412", "−$12.00". Null when nothing moved. */
export function changeAmount(change: Change, amount: (value: number) => string): string | null {
  if (change.direction === 'same') return null
  return `${change.direction === 'up' ? '+' : '−'}${amount(change.difference)}`
}

/** The rest of the line: "vs prior 30 days", or the whole of it when nothing moved. */
export function changeRest(change: Change, days: PerformanceDays): string {
  return change.direction === 'same' ? `Same as prior ${days} days` : `vs prior ${days} days`
}

// What there is to show ---------------------------------------------------------------------

/** True for a row with nothing in it in the days shown. */
export function isQuiet(row: PerformanceCounts): boolean {
  return row.clicks === 0 && row.sales === 0 && !row.events && row.earnings_minor === 0
}

/** The channels worth a row, in the order they came, and how many links were left out. */
export function channelRows(channels: readonly PerformanceChannel[]): {
  rows: PerformanceChannel[]
  quiet: number
} {
  return {
    rows: channels.filter((channel) => !isQuiet(channel)),
    quiet: channels.filter((channel) => channel.kind !== 'none' && isQuiet(channel)).length,
  }
}

/** "clicks or sales", "clicks or events", "clicks, sales or events": what a link can bring. */
export function clicksOr(earnFrom: EarnFrom = 'sales'): string {
  if (earnFrom === 'events') return 'clicks or events'
  return earnFrom === 'both' ? 'clicks, sales or events' : 'clicks or sales'
}

/** "6 other links had no clicks or sales in these 30 days." With none shown: "Your 7 links had …". */
export function quietLinksLine(
  quiet: number,
  shown: number,
  days: PerformanceDays,
  earnFrom: EarnFrom = 'sales',
): string | null {
  if (quiet <= 0) return null
  const links = quiet === 1 ? 'link' : 'links'
  const subject =
    shown > 0 ? `${quiet} other ${links}` : quiet === 1 ? 'Your link' : `Your ${quiet} links`
  return `${subject} had no ${clicksOr(earnFrom)} in these ${days} days.`
}

// What a program pays for ---------------------------------------------------------------------

/** "Latest sales", "Latest rewards", "Latest sales and rewards". */
export function latestTitle(earnFrom: EarnFrom): string {
  if (earnFrom === 'events') return 'Latest rewards'
  return earnFrom === 'both' ? 'Latest sales and rewards' : 'Latest sales'
}

/** What the list says while it is empty. */
export function latestEmpty(earnFrom: EarnFrom): string {
  if (earnFrom === 'events') return 'No rewards yet.'
  return earnFrom === 'both' ? 'No sales or rewards yet.' : 'No sales yet.'
}

/** "TikTok", or "TikTok · Account created" for a reward: where it came from and what for. */
export function latestWhat(item: Pick<LatestSale, 'kind' | 'link_name' | 'reward_label'>): string {
  const link = item.link_name ?? 'No link'
  if (item.kind !== 'reward') return link
  return `${link} · ${item.reward_label ?? 'Reward'}`
}

// Words -------------------------------------------------------------------------------------

const dayOfMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const longDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
const longDayYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const weekday = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

/** The moment a calendar day stands for on a chart: its midnight, taken as UTC. */
export function dayAsTime(day: string): number {
  return dayTime(day)
}

/** "14 Oct", for an axis. Takes a calendar day or the time `dayAsTime` made of it. */
export function axisDay(day: string | number): string {
  return dayOfMonth.format(typeof day === 'number' ? day : dayTime(day))
}

/** "Wed 14 Oct", for the value read off the chart. */
export function tooltipDay(day: string | number): string {
  return weekday.format(typeof day === 'number' ? day : dayTime(day)).replace(',', '')
}

/** "14 October to 12 November 2026", with the first year only when it differs. */
export function periodLine(startsOn: string, endsOn: string): string {
  const from = dayTime(startsOn)
  const to = dayTime(endsOn)
  const sameYear = startsOn.slice(0, 4) === endsOn.slice(0, 4)
  return `${(sameYear ? longDay : longDayYear).format(from)} to ${longDayYear.format(to)}`
}

/** An axis label for money: "$0", "$0.50", "$25", "$1.5K", "25 EUR". */
export function axisMoney(minor: number, currency: string): string {
  const major = minor / 100
  const amount =
    Math.abs(major) >= 1000
      ? `${Number((major / 1000).toFixed(1))}K`
      : Number.isInteger(major)
        ? String(major)
        : major.toFixed(2)
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}

/**
 * A sale's standing in a word, and how its pill is drawn. A reward that was given back was
 * rejected by the brand, not refunded.
 */
export function saleStatus(
  status: SaleStatus,
  kind: 'sale' | 'reward' = 'sale',
): {
  label: string
  tone: 'good' | 'waiting' | 'quiet'
} {
  if (status === 'approved') return { label: 'Approved', tone: 'good' }
  if (status === 'reversed')
    return { label: kind === 'reward' ? 'Rejected' : 'Returned', tone: 'quiet' }
  return { label: 'Pending', tone: 'waiting' }
}

/** The sentence after "Performance did not load". Never the database's own words. */
export function performanceErrorMessage(error: PartnerDataError | null): string {
  switch (error?.code) {
    case 'not_authenticated':
      return 'Your session has expired. Sign in again to see your results.'
    case 'invalid_response':
      return 'The answer could not be read. Try again.'
    case 'temporarily_unavailable':
      return 'Check your connection and try again.'
    default:
      return 'Try again in a moment.'
  }
}
