import { requireSupabaseClient } from '../lib/supabase'
import { feePercent, formatAmount, formatShortDay } from './balance'
import { formatCount, plural } from './format'
import { ProgramError, readFailure } from './programs'
import type { ProgramStatus } from './programs'
import type { PillTone } from './ui/Primitives'

/**
 * The rewards creators earned for events in the workspace's affiliate program: the calls to the
 * `workspace_program_rewards` and `workspace_program_reward_reject` database functions, what
 * their errors mean to a business owner, and the arithmetic and wording the page is built from.
 * Every backend shape is read in this file only. Money arrives in minor units and is only ever
 * shown in normal units. Nothing about the person who did an event is part of what the database
 * sends here, and nothing about them is kept.
 */

/** How many rewards one request asks for. The database allows 1 to 100. */
export const PAGE_SIZE = 50
/** How many rewards one rejection can name. */
export const REJECT_MAX = 100
/** The longest note a rejection can carry. */
export const NOTE_MAX = 300

export type EarnFrom = 'sales' | 'events' | 'both'

export type AwardStatus =
  /** Earned, and still in its hold: the merchant can reject it. */
  | 'pending'
  /** Past the hold: the reward is the creator's. */
  | 'approved'
  /** The merchant took it back during the hold. */
  | 'rejected'
  /** The event earned nothing; `reason` says why. */
  | 'not_counted'
  /** A status this page has no words for yet: still an event, so it is still listed. */
  | 'other'

/** What the list can be narrowed to. */
export type StatusFilter = Exclude<AwardStatus, 'other'>

export type RejectReason = 'fake' | 'duplicate' | 'own_action' | 'low_quality' | 'other'

export interface RewardsProgram {
  id: string
  slug: string | null
  name: string | null
  status: Exclude<ProgramStatus, 'archived'>
  earn_from: EarnFrom
}

/** One calendar month (UTC) of the budget the merchant set for rewards. */
export interface RewardsBudget {
  /** "2026-11"; null when the answer did not say which month. */
  month: string | null
  /** Null while the merchant has set none: then no event earns. */
  budget_minor: number | null
  used_minor: number
  /** The most one creator can earn in a day; null when it was not sent. */
  daily_limit_minor: number | null
  /** The KissMyApps fee that comes on top of each reward; null when it was not sent. */
  fee_bps: number | null
}

/** One reward of the published terms, with this month's events that count. */
export interface Reward {
  key: string
  label: string
  amount_minor: number
  count: number
  /** Null when the sum could not be read: it is then not shown, never guessed. */
  amount_total_minor: number | null
}

/** One creator's last 30 days. */
export interface RewardCreator {
  member_id: string
  name: string
  clicks: number
  /** People with a counted award for the first-listed reward over the last 30 UTC days. */
  people: number
  /** How many of those people also counted for another reward. Null when there is one reward. */
  went_further: number | null
  /** Events that count, per reward key. */
  counts: Record<string, number>
  earned_minor: number | null
  pending_minor: number | null
  rejected: number
  not_counted: number
}

export interface Award {
  award_id: string
  occurred_at: string
  member_id: string | null
  creator_name: string | null
  /** The creator's link the person came through; null when the click is tied to no link. */
  link_name: string | null
  reward_key: string | null
  reward_label: string
  amount_minor: number
  status: AwardStatus
  /** Why it did not count; null otherwise. */
  reason: string | null
  hold_until: string | null
  reject_reason: RejectReason | null
  /** True for a pending reward when the reader may reject it. */
  can_reject: boolean
}

export interface RewardsState {
  can_manage: boolean
  /**
   * Null when the workspace has no program, or its terms pay for sales and it never had a
   * reward. A program that went back to sales is here, with earn_from 'sales'.
   */
  program: RewardsProgram | null
  currency: string
  budget: RewardsBudget | null
  rewards: Reward[]
  creators: RewardCreator[]
  awards: Award[]
  /** What to ask the next page with; null on the last page. */
  next_before: string | null
}

export interface Rejection {
  /** How many rewards were rejected; null when the answer did not say. */
  rejected: number | null
  /** The rewards and their fees that went back to the balance; null when it did not say. */
  returned_minor: number | null
}

// Reading answers ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const unreadable = () => new ProgramError('response_unreadable')
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
/** Money is whole minor units or it is not money: nothing is rounded into shape here. */
const minor = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const PROGRAM_STATUSES: ReadonlyArray<RewardsProgram['status']> = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
]
const EARN_FROM: readonly EarnFrom[] = ['sales', 'events', 'both']
export const STATUS_FILTERS: readonly StatusFilter[] = [
  'pending',
  'approved',
  'rejected',
  'not_counted',
]
export const REJECT_REASONS: readonly RejectReason[] = [
  'fake',
  'duplicate',
  'own_action',
  'low_quality',
  'other',
]

function programFrom(value: unknown): RewardsProgram | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !row.id) throw unreadable()
  // An archived program is history: the workspace has no program to list rewards for.
  if (row.status === 'archived') return null
  const status = PROGRAM_STATUSES.find((item) => item === row.status)
  const earnFrom = EARN_FROM.find((item) => item === row.earn_from)
  if (!status || !earnFrom) throw unreadable()
  return { id: row.id, slug: text(row.slug), name: text(row.name), status, earn_from: earnFrom }
}

/** The month's budget, or null when what was used cannot be read: a bar is never half true. */
function budgetFrom(value: unknown): RewardsBudget | null {
  const row = record(value)
  const used = minor(row?.used_minor)
  if (!row || used === null) return null
  const fee = minor(row.fee_bps)
  return {
    month:
      typeof row.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ? row.month : null,
    budget_minor: minor(row.budget_minor),
    used_minor: used,
    daily_limit_minor: minor(row.daily_limit_minor),
    fee_bps: fee !== null && fee <= 10_000 ? fee : null,
  }
}

function rewardFrom(value: unknown): Reward | null {
  const row = record(value)
  const key = text(row?.key)
  const label = text(row?.label)
  const amount = minor(row?.amount_minor)
  if (!row || !key || !label || !amount) return null
  return {
    key,
    label,
    amount_minor: amount,
    count: count(row.count),
    amount_total_minor: minor(row.amount_total_minor),
  }
}

function creatorFrom(value: unknown): RewardCreator | null {
  const row = record(value)
  const name = text(row?.name)
  if (!row || typeof row.member_id !== 'string' || !row.member_id || !name) return null
  const counts: Record<string, number> = {}
  for (const item of list(row.counts)) {
    const key = text(record(item)?.key)
    if (key) counts[key] = count(record(item)?.count)
  }
  const further = row.went_further
  return {
    member_id: row.member_id,
    name,
    clicks: count(row.clicks),
    people: count(row.people),
    went_further: typeof further === 'number' && Number.isFinite(further) ? count(further) : null,
    counts,
    earned_minor: minor(row.earned_minor),
    pending_minor: minor(row.pending_minor),
    rejected: count(row.rejected),
    not_counted: count(row.not_counted),
  }
}

/** One reward as the database sends it, or null when the row cannot be trusted. */
function awardFrom(value: unknown): Award | null {
  const row = record(value)
  const amount = minor(row?.amount_minor)
  const occurred = moment(row?.occurred_at)
  if (!row || typeof row.award_id !== 'string' || !row.award_id || typeof row.status !== 'string')
    return null
  // A reward without its amount or its date is not shown as zero or as today.
  if (amount === null || occurred === null) return null
  const status = STATUS_FILTERS.find((item) => item === row.status) ?? 'other'
  return {
    award_id: row.award_id,
    occurred_at: occurred,
    member_id: text(row.member_id),
    creator_name: text(row.creator_name),
    // The database names a reward whose click is tied to no link "No link".
    link_name: text(row.link_name) === 'No link' ? null : text(row.link_name),
    reward_key: text(row.reward_key),
    reward_label: text(row.reward_label) ?? 'Reward',
    amount_minor: amount,
    status,
    reason: status === 'not_counted' ? text(row.reason) : null,
    hold_until: moment(row.hold_until),
    reject_reason: REJECT_REASONS.find((item) => item === row.reject_reason) ?? null,
    // Only a reward still in its hold can be taken back, whatever else the row says.
    can_reject: status === 'pending' && row.can_reject === true,
  }
}

/** Reads a `workspace_program_rewards` answer, refusing one that cannot draw the page. */
export function readRewards(value: unknown): RewardsState {
  const body = record(value)
  if (!body) throw unreadable()
  const program = programFrom(body.program)
  // Without a program there is nothing to list, whatever else is sent. A program that went
  // back to sales keeps its program and its rewards: held ones can still be rejected.
  if (!program)
    return {
      can_manage: body.can_manage === true,
      program,
      currency: 'USD',
      budget: null,
      rewards: [],
      creators: [],
      awards: [],
      next_before: null,
    }
  if (typeof body.can_manage !== 'boolean' || !Array.isArray(body.awards)) throw unreadable()
  const canManage = body.can_manage
  return {
    can_manage: canManage,
    program,
    currency: currencyCode(body.currency) ?? 'USD',
    budget: budgetFrom(body.budget),
    rewards: list(body.rewards).flatMap((item) => rewardFrom(item) ?? []),
    creators: list(body.creators).flatMap((item) => creatorFrom(item) ?? []),
    awards: body.awards.flatMap((item) => {
      const row = awardFrom(item)
      // The answer as a whole decides who may reject; a row never grants it alone.
      return row ? { ...row, can_reject: row.can_reject && canManage } : []
    }),
    next_before: moment(body.next_before),
  }
}

/**
 * Reads a `workspace_program_reward_reject` answer. By the time there is an answer the rewards
 * are rejected, so a figure that cannot be read is left out instead of failing the action.
 */
export function readRejection(value: unknown): Rejection {
  const body = record(value)
  const rejected = body?.rejected
  return {
    rejected:
      typeof rejected === 'number' && Number.isSafeInteger(rejected) && rejected >= 0
        ? rejected
        : null,
    returned_minor: minor(body?.returned_minor),
  }
}

// The calls ---------------------------------------------------------------------------------

type Client = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { message?: string; details?: string | null; code?: string } | null
  }>
}

/** What PostgREST and Postgres answer when a function is not in the database yet. */
const MISSING_FUNCTION = ['PGRST202', '42883']

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    response = await (requireSupabaseClient() as unknown as Client).rpc(name, args)
  } catch {
    throw new ProgramError(
      typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable',
    )
  }
  if (response.error) {
    // A database from before rewards existed: nothing is broken, there is nothing to show yet.
    if (MISSING_FUNCTION.includes(response.error.code ?? ''))
      throw new ProgramError('rewards_unavailable')
    throw readFailure(response.error)
  }
  return response.data
}

export interface RewardsQuery {
  /** `next_before` of the page before this one; left out for the first page. */
  before?: string | null
  /** The one creator whose rewards to list; left out for everyone's. */
  memberId?: string | null
  /** The one status to list; left out for all of them. */
  status?: StatusFilter | null
}

export interface RejectInput {
  awardIds: string[]
  reason: RejectReason
  note?: string
}

export const rewards = {
  list: async (workspaceId: string, query: RewardsQuery = {}) =>
    readRewards(
      await call('workspace_program_rewards', {
        p_workspace_id: workspaceId,
        p_input: {
          limit: PAGE_SIZE,
          before: query.before ?? null,
          member_id: query.memberId ?? null,
          status: query.status ?? null,
        },
      }),
    ),
  /** Takes pending rewards back. All of them, or none: the database refuses the whole list. */
  reject: async (workspaceId: string, input: RejectInput) =>
    readRejection(
      await call('workspace_program_reward_reject', {
        p_workspace_id: workspaceId,
        p_input: {
          award_ids: input.awardIds,
          reason: input.reason,
          note: input.note?.trim() ? input.note.trim() : null,
        },
      }),
    ),
}

// The page's own arithmetic -----------------------------------------------------------------

/** The list with its next page added. A reward already on the page is not listed twice. */
export function withNextPage(state: RewardsState, next: RewardsState): RewardsState {
  const seen = new Set(state.awards.map((award) => award.award_id))
  return {
    ...state,
    awards: [...state.awards, ...next.awards.filter((award) => !seen.has(award.award_id))],
    // A page that brought nothing new ends the list, so "Show more" can never loop.
    next_before: next.next_before === state.next_before ? null : next.next_before,
  }
}

/**
 * The list after a rejection, before the database has been read again: those rewards are
 * rejected, and leave a list that is narrowed to another status.
 */
export function withRejected(
  state: RewardsState,
  awardIds: string[],
  reason: RejectReason,
  filter: StatusFilter | null,
): RewardsState {
  const gone = new Set(awardIds)
  const awards = state.awards.map((award) =>
    gone.has(award.award_id)
      ? { ...award, status: 'rejected' as const, reject_reason: reason, can_reject: false }
      : award,
  )
  return {
    ...state,
    awards:
      filter && filter !== 'rejected'
        ? awards.filter((award) => !gone.has(award.award_id))
        : awards,
  }
}

/** The figures above the list as the database has them now, around a list that stays as it is. */
export function withFreshFigures(state: RewardsState, fresh: RewardsState): RewardsState {
  if (!fresh.program) return state
  return { ...state, budget: fresh.budget, rewards: fresh.rewards, creators: fresh.creators }
}

/** The page once the database has said this person may not reject after all. */
export function withoutRejecting(state: RewardsState): RewardsState {
  return {
    ...state,
    can_manage: false,
    awards: state.awards.map((award) => ({ ...award, can_reject: false })),
  }
}

/** The KissMyApps fee on one reward, worked out the way the database does: rounded down. */
export function feeOn(amountMinor: number, feeBps: number): number {
  return Math.floor((amountMinor * feeBps) / 10_000)
}

export interface GoingBack {
  count: number
  rewards_minor: number
  /** Null when the fee is not known: the confirmation then says so instead of guessing. */
  fee_minor: number | null
  total_minor: number | null
}

/** What rejecting these rewards gives back to the balance: each reward, and the fee on it. */
export function goingBack(
  awards: Array<Pick<Award, 'amount_minor'>>,
  feeBps: number | null,
): GoingBack {
  const amount = awards.reduce((sum, award) => sum + award.amount_minor, 0)
  const fee =
    feeBps === null
      ? null
      : awards.reduce((sum, award) => sum + feeOn(award.amount_minor, feeBps), 0)
  return {
    count: awards.length,
    rewards_minor: amount,
    fee_minor: fee,
    total_minor: fee === null ? null : amount + fee,
  }
}

export type BudgetLevel = 'fine' | 'nearly' | 'used_up'

export interface BudgetStanding {
  /** How much of the budget is used, 0 to 1. */
  share: number
  left_minor: number
  level: BudgetLevel
}

/** From this share of the budget on, the page says it is nearly used. */
const NEARLY = 0.8

/**
 * Where the month stands. It is used up once the smallest reward no longer fits, which is when
 * events stop earning. Null while no budget is set.
 */
export function budgetStanding(
  budget: Pick<RewardsBudget, 'budget_minor' | 'used_minor'>,
  rewardList: Array<Pick<Reward, 'amount_minor'>>,
): BudgetStanding | null {
  const whole = budget.budget_minor
  if (!whole) return null
  const left = Math.max(0, whole - budget.used_minor)
  const smallest = rewardList.length ? Math.min(...rewardList.map((item) => item.amount_minor)) : 1
  const share = Math.min(1, budget.used_minor / whole)
  return {
    share,
    left_minor: left,
    level: left < smallest ? 'used_up' : share >= NEARLY ? 'nearly' : 'fine',
  }
}

/** Fewer first rewards than this say too little about a creator to single them out. */
const STANDS_OUT_FROM = 20
/** A creator stands out when under this share of the others' rate went further. */
const FAR_BELOW = 0.25

/**
 * Whether a creator's row deserves a second look: many people earned the first reward through
 * them and none went on to another, or far fewer did than with the other creators together.
 * It is a pointer for the merchant, never a verdict.
 */
export function standsOut(creator: RewardCreator, everyone: RewardCreator[]): boolean {
  if (creator.went_further === null || creator.people < STANDS_OUT_FROM) return false
  if (creator.went_further === 0) return true
  const others = everyone.filter(
    (item) => item.member_id !== creator.member_id && item.went_further !== null,
  )
  const people = others.reduce((sum, item) => sum + item.people, 0)
  const further = others.reduce((sum, item) => sum + (item.went_further ?? 0), 0)
  // Too few people elsewhere, and there is nothing to compare with.
  if (people < STANDS_OUT_FROM || further === 0) return false
  return creator.went_further / creator.people < (further / people) * FAR_BELOW
}

/** Rows that stand out first, the rest in the order the database sent. */
export function creatorsInOrder(everyone: RewardCreator[]): RewardCreator[] {
  const marked = everyone.filter((creator) => standsOut(creator, everyone))
  return [...marked, ...everyone.filter((creator) => !marked.includes(creator))]
}

// The words on the page ---------------------------------------------------------------------

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' })

/** "2026-11" → "November". Null when the month was not sent. */
export function monthName(month: string | null): string | null {
  if (!month) return null
  const [year, index] = month.split('-').map(Number)
  return monthFormat.format(Date.UTC(year, index - 1, 1))
}

/** "$176.00 of $500.00 used": the one line the budget is read from. */
export function budgetLine(
  budget: Pick<RewardsBudget, 'budget_minor' | 'used_minor'>,
  currency: string,
): string {
  return budget.budget_minor === null
    ? `${formatAmount(budget.used_minor, currency)} used`
    : `${formatAmount(budget.used_minor, currency)} of ${formatAmount(budget.budget_minor, currency)} used`
}

/** What is left of the month, in a few words. */
export function budgetLeft(standing: BudgetStanding, currency: string): string {
  return standing.level === 'used_up'
    ? 'Used up'
    : `${formatAmount(standing.left_minor, currency)} left`
}

/** The quiet line under the bar: the fee on top, and the most one creator can earn in a day. */
export function budgetNotes(
  budget: Pick<RewardsBudget, 'fee_bps' | 'daily_limit_minor'>,
  currency: string,
): string[] {
  const fee = feePercent(budget.fee_bps)
  return [
    fee && budget.fee_bps ? `The ${fee} KissMyApps fee comes on top.` : null,
    budget.daily_limit_minor
      ? `One creator can earn up to ${formatAmount(budget.daily_limit_minor, currency)} a day.`
      : null,
  ].flatMap((line) => line ?? [])
}

/** What a used-up budget means, and the two ways it ends. */
export const USED_UP_LINE =
  'New events earn nothing until next month, or until you raise the budget.'

/** "9 of 25": of the people with the first reward, how many earned another. */
export function wentFurther(
  creator: Pick<RewardCreator, 'people' | 'went_further'>,
): string | null {
  // Nobody earned the first reward, so there is no one who could have gone further.
  return creator.went_further === null || creator.people === 0
    ? null
    : `${formatCount(creator.went_further)} of ${formatCount(creator.people)}`
}

/** The short sentence beside a row that stands out. */
export function standsOutLine(creator: Pick<RewardCreator, 'people' | 'went_further'>): string {
  return creator.went_further
    ? `Only ${formatCount(creator.went_further)} of ${formatCount(creator.people)} went further`
    : `None of ${formatCount(creator.people)} went further`
}

export const statusNames: Record<StatusFilter, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  not_counted: 'Not counted',
}

/** "No pending rewards": what an empty list says when it is narrowed to one status. */
export const emptyNames: Record<StatusFilter, string> = {
  pending: 'No pending rewards',
  approved: 'No approved rewards',
  rejected: 'No rejected rewards',
  not_counted: 'No rewards that were not counted',
}

/** Why an event earned nothing, in the words the Sales page uses for the same things. */
const notCountedReasons: Record<string, string> = {
  not_a_member: 'The creator was not in your program',
  not_in_terms: 'Not in the terms the creator accepted',
  already_rewarded: 'This person already earned it',
  own_action: 'The creator’s own action',
  budget_reached: 'Your monthly budget was used up',
  daily_limit: 'The creator reached the daily limit',
  balance_empty: 'Your balance could not cover it',
  program_paused: 'Your program was paused',
  currency_mismatch: 'Your balance is in another currency',
}

/** The reasons the merchant can do something about. */
const ACTIONABLE = ['balance_empty', 'program_paused', 'budget_reached']

export const rejectReasonNames: Record<RejectReason, string> = {
  fake: 'Fake',
  duplicate: 'Duplicate',
  own_action: 'Creator’s own',
  low_quality: 'Low quality',
  other: 'Other',
}

/** The reason under "Rejected". "Other" says nothing more than the word above it. */
const rejectedDetails: Record<RejectReason, string | null> = {
  fake: 'Fake',
  duplicate: 'Duplicate',
  own_action: 'The creator’s own action',
  low_quality: 'Low quality',
  other: null,
}

export interface AwardStatusWords {
  label: string
  tone: PillTone
  /** One short line under the label for a reward that went another way; null otherwise. */
  detail: string | null
}

/** What became of a reward, in a word and, for an exception, one short line. */
export function awardStatus(
  award: Pick<Award, 'status' | 'reason' | 'hold_until' | 'reject_reason'>,
): AwardStatusWords {
  switch (award.status) {
    case 'pending':
      // The usual case stays on one line: the day the hold ends is part of the word.
      return {
        label: award.hold_until ? `Pending until ${formatShortDay(award.hold_until)}` : 'Pending',
        tone: 'info',
        detail: null,
      }
    case 'approved':
      return { label: 'Approved', tone: 'positive', detail: null }
    case 'rejected':
      return {
        label: 'Rejected',
        tone: 'neutral',
        detail: award.reject_reason ? rejectedDetails[award.reject_reason] : null,
      }
    case 'not_counted':
      return {
        label: 'Not counted',
        tone: ACTIONABLE.includes(award.reason ?? '') ? 'warning' : 'neutral',
        detail: notCountedReasons[award.reason ?? ''] ?? null,
      }
    case 'other':
      return { label: 'Recorded', tone: 'neutral', detail: null }
  }
}

/** Whether a reward's amount is money that is set aside or the creator's: pending or approved. */
export function earns(award: Pick<Award, 'status'>): boolean {
  return award.status === 'pending' || award.status === 'approved'
}

/** "Reject 3 rewards?" */
export function rejectTitle(howMany: number): string {
  return `Reject ${plural(howMany, 'reward')}?`
}

/** What the confirmation says before anything is sent: how much goes back, and what it is. */
export function confirmLine(back: GoingBack, currency: string): string {
  const amount = formatAmount(back.rewards_minor, currency)
  const end = back.count === 1 ? 'The creator does not earn it.' : 'The creators do not earn them.'
  if (back.fee_minor === null || back.total_minor === null)
    return `${amount} and the KissMyApps fee on it go back to your balance. ${end}`
  if (back.fee_minor === 0) return `${amount} goes back to your balance. ${end}`
  return `${formatAmount(back.total_minor, currency)} goes back to your balance: ${amount} in rewards and ${formatAmount(back.fee_minor, currency)} in fees. ${end}`
}

/** What the page says once the rewards are rejected. */
export function doneLine(howMany: number, returnedMinor: number | null, currency: string): string {
  const said = `${plural(howMany, 'reward')} rejected.`
  return returnedMinor === null
    ? `${said} The money is back in your balance.`
    : `${said} ${formatAmount(returnedMinor, currency)} is back in your balance.`
}

/** What is wrong with a note, or null when it can be sent. An empty note is fine. */
export function checkNote(note: string): string | null {
  return note.trim().length > NOTE_MAX ? noteMessage : null
}

const noteMessage = `Keep the note under ${NOTE_MAX} characters.`
export const reasonMessage = 'Choose a reason.'

// What each failure means, in words a business owner can act on ----------------------------

/** What the person was doing when a request failed. */
export type RewardsStep = 'load' | 'more' | 'reject'

/**
 * How the person gets past a problem: try the same thing again, sign in again, or nothing they
 * can do alone. `reload` means the page has read the latest list.
 */
export type RewardsRecovery = 'retry' | 'reload' | 'sign-in' | 'none'

export interface RewardsProblem {
  code: string
  message: string
  recovery: RewardsRecovery
  /** Set when the problem is with one field of the rejection. */
  field?: 'reason' | 'note'
}

/** The code this file gives a database that does not have the rewards functions yet. */
export const UNAVAILABLE = 'rewards_unavailable'

export const problemMessages: Record<string, Omit<RewardsProblem, 'code'>> = {
  [UNAVAILABLE]: { message: 'Rewards are not available yet.', recovery: 'none' },
  // Reading: the only input a person can get wrong is the creator named in the address.
  invalid_input: {
    message: 'That creator could not be found. Remove the filter to see every reward.',
    recovery: 'none',
  },
  not_allowed: {
    message: 'You do not have access to these rewards. Ask an owner of the workspace.',
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

/** What the same codes mean when they answer a rejection. */
export const rejectMessages: Record<string, Omit<RewardsProblem, 'code'>> = {
  not_rejectable: {
    message:
      'Some of these rewards could no longer be rejected, so none were. You are now seeing the latest list.',
    recovery: 'reload',
  },
  invalid_input: {
    message:
      'That could not be sent as it is, so nothing was rejected. Check the note and try again.',
    recovery: 'none',
  },
  not_allowed: {
    message: 'Only an owner or admin can reject rewards. Ask one of them to do this.',
    recovery: 'none',
  },
}

/** When the failure is one we have no words for: what did not happen, and what to do. */
export const fallbackMessages: Record<RewardsStep, string> = {
  load: 'Your rewards could not be loaded. Try again.',
  more: 'More rewards could not be loaded. Try again.',
  reject: 'Nothing was rejected. Try again.',
}

/** Said when a rejection was refused and the list could not be read again either. */
export const STALE_LINE =
  'Some of these rewards could no longer be rejected, so none were. The list could not be read again.'

export function describeProblem(problem: unknown, step: RewardsStep): RewardsProblem {
  const code = problem instanceof ProgramError ? problem.code : 'unknown'
  const known = (step === 'reject' ? rejectMessages[code] : undefined) ?? problemMessages[code]
  if (known) return { code, ...known }
  return { code, message: fallbackMessages[step], recovery: 'retry' }
}
