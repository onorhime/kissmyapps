import { requireSupabaseClient } from '../lib/supabase'
import { ProgramError, readFailure } from './programs'
import type { ApprovalMode, ProgramStatus } from './programs'

/**
 * The creators of the workspace's affiliate program: the calls to the two
 * `workspace_program_creator*` database functions, what their errors mean to a business
 * owner, and the small pieces of wording the page is built from. Every backend shape is
 * read in this file only. A creator's email is never part of what the database sends here.
 */

/** Where anyone can read the program and join it. */
export const MARKETPLACE_ORIGIN = 'https://kissmyapps.dev'

export type CreatorStatus = 'pending' | 'active' | 'declined' | 'removed' | 'left'
export type CreatorAction = 'approve' | 'decline' | 'remove'

export const NOTE_MAX = 500

export interface Creator {
  member_id: string
  status: CreatorStatus
  name: string
  handle: string
  country_code: string | null
  channels: string[]
  website_url: string | null
  requested_at: string | null
  activated_at: string | null
  ended_at: string | null
  decision_note: string | null
  terms_version: number | null
  needs_new_terms: boolean
  clicks: number
  sales: number
  last_click_at: string | null
  /** What this creator's sales came to. Null when the database does not send money yet. */
  sales_amount_minor: number | null
  /** What those sales are worth to the creator now, and the part of it still in its hold. */
  commission_minor: number | null
  pending_minor: number | null
}

/** Every creator of the program added up, those who have ended included. */
export interface CreatorTotals {
  clicks: number
  sales: number
  sales_amount_minor: number
  commission_minor: number
  pending_minor: number
}

export interface CreatorsProgram {
  id: string
  slug: string | null
  name: string | null
  status: Exclude<ProgramStatus, 'archived'>
  approval_mode: ApprovalMode
  marketplace_listed: boolean
}

export interface CreatorCounts {
  pending: number
  active: number
  ended: number
}

export interface CreatorsState {
  can_manage: boolean
  program: CreatorsProgram | null
  counts: CreatorCounts
  creators: Creator[]
  /** The currency the program's money is in. Null without a program, or when it was not sent. */
  currency: string | null
  /** Null when the database does not send money yet: the page is then drawn without it. */
  totals: CreatorTotals | null
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
const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
/** Money is whole minor units or it is not money: an amount that cannot be read is not shown. */
const minor = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null

const CREATOR_STATUSES: readonly CreatorStatus[] = [
  'pending',
  'active',
  'declined',
  'removed',
  'left',
]
const PROGRAM_STATUSES: ReadonlyArray<CreatorsProgram['status']> = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
]

/** One creator as the database sends it, or null when the row cannot be trusted. */
function creatorFrom(value: unknown): Creator | null {
  const row = record(value)
  const status = CREATOR_STATUSES.find((item) => item === row?.status)
  const name = text(row?.name)
  if (!row || typeof row.member_id !== 'string' || !row.member_id || !status || !name) return null
  return {
    member_id: row.member_id,
    status,
    name,
    handle: text(row.handle) ?? '',
    country_code:
      typeof row.country_code === 'string' && /^[A-Za-z]{2}$/.test(row.country_code)
        ? row.country_code.toUpperCase()
        : null,
    channels: (Array.isArray(row.channels) ? row.channels : []).flatMap((item) => text(item) ?? []),
    website_url: text(row.website_url),
    requested_at: moment(row.requested_at),
    activated_at: moment(row.activated_at),
    ended_at: moment(row.ended_at),
    decision_note: text(row.decision_note),
    terms_version:
      typeof row.terms_version === 'number' && Number.isFinite(row.terms_version)
        ? Math.round(row.terms_version)
        : null,
    needs_new_terms: row.needs_new_terms === true,
    clicks: count(row.clicks),
    sales: count(row.sales),
    last_click_at: moment(row.last_click_at),
    sales_amount_minor: minor(row.sales_amount_minor),
    commission_minor: minor(row.commission_minor),
    pending_minor: minor(row.pending_minor),
  }
}

/** The totals line, or null when any of it is missing: a sum is never shown half read. */
function totalsFrom(value: unknown): CreatorTotals | null {
  const row = record(value)
  const amount = minor(row?.sales_amount_minor)
  const commission = minor(row?.commission_minor)
  const pending = minor(row?.pending_minor)
  if (!row || amount === null || commission === null || pending === null) return null
  return {
    clicks: count(row.clicks),
    sales: count(row.sales),
    sales_amount_minor: amount,
    commission_minor: commission,
    pending_minor: pending,
  }
}

function programFrom(value: unknown): CreatorsProgram | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row || typeof row.id !== 'string') throw unreadable()
  // An archived program is history: the workspace has no program to show creators for.
  if (row.status === 'archived') return null
  const status = PROGRAM_STATUSES.find((item) => item === row.status)
  if (!status) throw unreadable()
  return {
    id: row.id,
    slug: text(row.slug),
    name: text(row.name),
    status,
    approval_mode: row.approval_mode === 'manual' ? 'manual' : 'automatic',
    marketplace_listed: row.marketplace_listed !== false,
  }
}

const bucket = (status: CreatorStatus): keyof CreatorCounts =>
  status === 'pending' ? 'pending' : status === 'active' ? 'active' : 'ended'

function countRows(creators: Creator[]): CreatorCounts {
  const counts: CreatorCounts = { pending: 0, active: 0, ended: 0 }
  for (const creator of creators) counts[bucket(creator.status)] += 1
  return counts
}

/** Reads a `workspace_program_creators` answer, refusing one that cannot draw the page. */
export function readCreators(value: unknown): CreatorsState {
  const body = record(value)
  if (!body || typeof body.can_manage !== 'boolean' || !Array.isArray(body.creators))
    throw unreadable()
  const creators = body.creators.flatMap((item) => creatorFrom(item) ?? [])
  const sent = record(body.counts)
  const listed = countRows(creators)
  const program = programFrom(body.program)
  return {
    can_manage: body.can_manage,
    program,
    // The list is capped; the counts are not. A count is never below what is on the page.
    counts: {
      pending: Math.max(count(sent?.pending), listed.pending),
      active: Math.max(count(sent?.active), listed.active),
      ended: Math.max(count(sent?.ended), listed.ended),
    },
    creators,
    currency: program ? currencyCode(body.currency) : null,
    // A database from before these figures existed sends none: the page then shows no money.
    totals: program ? totalsFrom(body.totals) : null,
  }
}

/** Reads a `workspace_program_creator_decide` answer: the creator as they now stand. */
export function readDecision(value: unknown): Creator {
  const creator = creatorFrom(record(value)?.creator)
  if (!creator) throw unreadable()
  return creator
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

export const creators = {
  list: async (workspaceId: string) =>
    readCreators(await call('workspace_program_creators', { p_workspace_id: workspaceId })),
  decide: async (workspaceId: string, memberId: string, action: CreatorAction, note?: string) =>
    readDecision(
      await call('workspace_program_creator_decide', {
        p_workspace_id: workspaceId,
        p_input: {
          member_id: memberId,
          action,
          ...(note?.trim() ? { note: note.trim() } : {}),
        },
      }),
    ),
}

// The page's own arithmetic -----------------------------------------------------------------

/** The page after a decision: the creator in their new place, the counts moved with them. */
export function withDecision(state: CreatorsState, decided: Creator): CreatorsState {
  const before = state.creators.find((item) => item.member_id === decided.member_id)
  const counts = { ...state.counts }
  if (before) counts[bucket(before.status)] = Math.max(0, counts[bucket(before.status)] - 1)
  counts[bucket(decided.status)] += 1
  // A decision moves no money: an answer that leaves the figures out keeps the ones on the page.
  const moved: Creator = {
    ...decided,
    sales_amount_minor: decided.sales_amount_minor ?? before?.sales_amount_minor ?? null,
    commission_minor: decided.commission_minor ?? before?.commission_minor ?? null,
    pending_minor: decided.pending_minor ?? before?.pending_minor ?? null,
  }
  return {
    ...state,
    counts,
    // Whoever was just decided on leads their new list, where the eye is.
    creators: [moved, ...state.creators.filter((item) => item.member_id !== decided.member_id)],
  }
}

export interface CreatorGroups {
  pending: Creator[]
  active: Creator[]
  ended: Creator[]
}

/** The three lists the page shows, each in the order the database sent. */
export function groupCreators(list: Creator[]): CreatorGroups {
  const groups: CreatorGroups = { pending: [], active: [], ended: [] }
  for (const creator of list) groups[bucket(creator.status)].push(creator)
  return groups
}

/** The currency the money on the page is in, once the database sends money at all. */
export function moneyCurrency(state: Pick<CreatorsState, 'currency' | 'totals'>): string | null {
  return state.totals ? (state.currency ?? 'USD') : null
}

/**
 * The totals count every creator, the table only those promoting now. When the two differ,
 * the totals line says who else is in it.
 */
export function totalsNote(
  state: Pick<CreatorsState, 'totals' | 'counts'>,
  active: Creator[],
): string | null {
  const totals = state.totals
  if (!totals) return null
  const sum = (pick: (creator: Creator) => number | null) =>
    active.reduce((all, creator) => all + (pick(creator) ?? 0), 0)
  const same =
    sum((creator) => creator.clicks) === totals.clicks &&
    sum((creator) => creator.sales) === totals.sales &&
    sum((creator) => creator.sales_amount_minor) === totals.sales_amount_minor &&
    sum((creator) => creator.commission_minor) === totals.commission_minor
  if (same) return null
  return state.counts.ended > 0 ? 'Includes ended creators' : 'All creators'
}

// The words on the page ---------------------------------------------------------------------

/** https://kissmyapps.dev/marketplace/speaksix: the address a merchant sends to creators. */
export function inviteLink(slug: string): string {
  return `${MARKETPLACE_ORIGIN}/marketplace/${encodeURIComponent(slug)}`
}

/** The one line under the invite link: who can find the program, and who lets creators in. */
export function inviteSummary(
  program: Pick<CreatorsProgram, 'marketplace_listed' | 'approval_mode'>,
): string[] {
  return [
    program.marketplace_listed ? 'Listed in the marketplace' : 'Not listed in the marketplace',
    program.approval_mode === 'automatic'
      ? 'Creators are approved automatically'
      : 'You approve each creator',
  ]
}

const channelNames: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  x: 'X',
  twitter: 'X',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  twitch: 'Twitch',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  newsletter: 'Newsletter',
  email: 'Email',
  blog: 'Blog',
  website: 'Website',
  podcast: 'Podcast',
  discord: 'Discord',
  reddit: 'Reddit',
  pinterest: 'Pinterest',
  snapchat: 'Snapchat',
}

/** tiktok → TikTok; a channel written out by the creator is shown as they wrote it. */
export function channelLabel(channel: string): string {
  const known = channelNames[channel.trim().toLowerCase()]
  if (known) return known
  const words = channel.trim().replace(/_/g, ' ')
  return /^[a-z]/.test(words) ? words[0].toUpperCase() + words.slice(1) : words
}

const CHANNELS_SHOWN = 3

/** "TikTok, Instagram" or "TikTok, Instagram, YouTube +2"; null when the creator named none. */
export function channelList(channels: string[]): string | null {
  const labels = [...new Set(channels.map(channelLabel))]
  if (!labels.length) return null
  const more = labels.length - CHANNELS_SHOWN
  return `${labels.slice(0, CHANNELS_SHOWN).join(', ')}${more > 0 ? ` +${more}` : ''}`
}

/** A creator's website as a link that is safe to open, or null when it is not a web address. */
export function websiteLink(value: string | null): { href: string; label: string } | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    const path = url.pathname.replace(/\/$/, '')
    return { href: url.href, label: `${url.host.replace(/^www\./, '')}${path}` }
  } catch {
    return null
  }
}

/** How a creator who is no longer in the program got there. */
export const endedLabels: Record<Exclude<CreatorStatus, 'pending' | 'active'>, string> = {
  declined: 'Declined',
  removed: 'Removed',
  left: 'Left',
}

/** A creator who left chose to; only the merchant's own decisions can be taken back. */
export function canApproveAgain(creator: Pick<Creator, 'status'>): boolean {
  return creator.status === 'declined' || creator.status === 'removed'
}

/** What is wrong with a note, or null when it can be sent. An empty note is fine. */
export function checkNote(note: string): string | null {
  return note.trim().length > NOTE_MAX ? noteMessage : null
}

const noteMessage = 'Keep the note under 500 characters.'

// What each failure means, in words a business owner can act on ----------------------------

/** What the person was doing when a request failed. */
export type CreatorStep = 'load' | CreatorAction

/**
 * How the person gets past a problem: try the same thing again, sign in again, or nothing
 * they can do alone. `reload` means the page has fetched the latest list.
 */
export type CreatorRecovery = 'retry' | 'reload' | 'sign-in' | 'none'

export interface CreatorProblem {
  code: string
  message: string
  recovery: CreatorRecovery
  /** Set when the problem is with the note that was typed. */
  field?: 'note'
}

export const problemMessages: Record<string, Omit<CreatorProblem, 'code'>> = {
  program_not_found: {
    message: 'This program could not be found. You are now seeing what is saved.',
    recovery: 'reload',
  },
  program_not_open: {
    message: 'Creators can only be approved while your program is live.',
    recovery: 'reload',
  },
  tracking_not_enabled: {
    message: 'Creator links are not available yet, so nobody can be approved right now.',
    recovery: 'none',
  },
  not_a_member: {
    message: 'That creator is no longer in this program. You are now seeing the latest list.',
    recovery: 'reload',
  },
  status_not_allowed: {
    message: 'That cannot be done for this creator right now. You are now seeing the latest list.',
    recovery: 'reload',
  },
  invalid_note: { message: noteMessage, recovery: 'none', field: 'note' },
  not_allowed: {
    message: 'Only an owner or admin can approve or remove creators. Ask one of them to do this.',
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
export const fallbackMessages: Record<CreatorStep, string> = {
  load: 'Your creators could not be loaded. Try again.',
  approve: 'The creator was not approved. Try again.',
  decline: 'The request was not declined. Try again.',
  remove: 'The creator was not removed. Try again.',
}

export function describeProblem(problem: unknown, step: CreatorStep): CreatorProblem {
  const code = problem instanceof ProgramError ? problem.code : 'unknown'
  const known = problemMessages[code]
  if (known) return { code, ...known }
  return { code, message: fallbackMessages[step], recovery: 'retry' }
}
