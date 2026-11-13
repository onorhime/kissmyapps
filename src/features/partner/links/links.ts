import { formatMoney } from '../../../merchant/programs'
import { oneOf, record, text } from '../../marketplace/model'
import type { PartnerDataErrorCode, PartnerDataStatus } from '../api/types'
import { absent, creditedFor, readEarnFrom } from './earnFrom'
import type { EarnFrom } from './earnFrom'

/**
 * A creator's program links: what the `partner_program_links`, `partner_program_link_create`
 * and `partner_program_link_remove` database functions answer, read into shapes the page can
 * trust, and the words the page uses for them and for each of their failures. Every reading of
 * those answers lives in this file.
 */

/** The one link a member always has, a ready-made channel link, or one the creator added. */
export type LinkKind = 'main' | 'channel' | 'custom'

/** Why a program's links open the page without crediting the creator. */
export type PausedReason = 'program_paused' | 'balance_empty'

export interface ProgramLink {
  link_id: string
  kind: LinkKind
  /** The channel's key (`tiktok`) on a channel link, otherwise null. */
  channel: string | null
  name: string
  /** The address to hand out: always a plain https address. */
  url: string
  created_at: string | null
  /** Clicks, sales and earnings over the answer's `stats_days`. */
  clicks: number
  sales: number
  /** Rewarded events. Left out by a database from before events could be rewarded: none. */
  events?: number
  earnings_minor: number
  /** A custom link that nobody has clicked yet, so removing it breaks nothing. */
  removable: boolean
}

export interface LinkProgram {
  program_id: string
  slug: string
  name: string
  currency: string
  /**
   * What the program pays for: sales, events such as a sign-up, or both. Left out by a
   * database from before events could be rewarded, which is a program that pays for sales.
   */
  earn_from?: EarnFrom
  /** False while the links open the page without crediting the creator. */
  working: boolean
  paused_reason: PausedReason | null
  /** How many custom links the creator has in this program. */
  custom_links: number
  /** The main link first, then the channels, then the custom links from the oldest. */
  links: ProgramLink[]
}

export interface LinkChannel {
  key: string
  name: string
}

export interface ProgramLinks {
  /** The number of days the counts cover. */
  stats_days: number
  max_custom_links: number
  channels: LinkChannel[]
  programs: LinkProgram[]
}

export type ProgramLinksErrorCode =
  | PartnerDataErrorCode
  | 'invalid_input'
  | 'invalid_name'
  | 'name_taken'
  | 'too_many_links'
  | 'not_member'
  | 'link_in_use'
  | 'not_removable'
  | 'link_not_found'

export type ProgramLinksError = Readonly<{
  code: ProgramLinksErrorCode
  message: string
  retryable: boolean
}>

/** The same envelope as `PartnerDataResult`, with the link failures added to its codes. */
export type ProgramLinksResult<T> = Readonly<{
  data: T
  status: PartnerDataStatus
  error: ProgramLinksError | null
}>

export type ProgramLinkCreateInput = Readonly<{ slug: string; name: string }>

export class LinksUnreadable extends Error {
  constructor() {
    super('The links answer could not be read.')
    this.name = 'LinksUnreadable'
  }
}

/** The longest name a custom link can have, counted in characters. */
export const LINK_NAME_MAX = 40

// Reading the answers -----------------------------------------------------------------------

const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** A count or an amount in minor units: never negative. Postgres may send a sum as digits. */
function count(value: unknown): number | null {
  const number =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : null
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null
}

const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null

/** A link is shown and copied, so it must be a plain https address with no sign-in part. */
function webAddress(value: unknown): string | null {
  if (typeof value !== 'string' || /\s/.test(value)) return null
  try {
    const url = new URL(value)
    const host = value.slice('https://'.length).split(/[/?#]/)[0]
    return url.protocol === 'https:' && !host.includes('@') ? value : null
  } catch {
    return null
  }
}

/** A link's row must be whole: a missing count is refused, never shown as zero. */
function readLink(value: unknown): ProgramLink {
  const row = record(value)
  const linkId = text(row?.link_id)
  const kind = oneOf(row?.kind, ['main', 'channel', 'custom'] as const)
  const name = text(row?.name)
  const url = webAddress(row?.url)
  const clicks = count(row?.clicks)
  const sales = count(row?.sales)
  const events = absent(row?.events) ? undefined : count(row.events)
  const earnings = count(row?.earnings_minor)
  const channel = kind === 'channel' ? text(row?.channel) : null
  if (
    !row ||
    !linkId ||
    !kind ||
    !name ||
    !url ||
    clicks === null ||
    sales === null ||
    events === null ||
    earnings === null ||
    (kind === 'channel' && !channel)
  )
    throw new LinksUnreadable()
  return {
    link_id: linkId,
    kind,
    channel,
    name: name.trim(),
    url,
    created_at: moment(row.created_at),
    clicks,
    sales,
    // Only an answer that counts events has the key, so an older one reads as it always has.
    ...(events === undefined ? {} : { events }),
    earnings_minor: earnings,
    // Only a link the creator made can go, whatever the answer says about the others.
    removable: kind === 'custom' && row.removable === true,
  }
}

/**
 * One program with its links, exactly as an entry of `programs[]` and as the answer of
 * `partner_program_link_create` and `partner_program_link_remove`. A member always has exactly
 * one main link, so an answer without it is refused.
 */
export function readLinkProgram(value: unknown): LinkProgram {
  const row = record(value)
  const programId = text(row?.program_id)
  const slug = text(row?.slug)
  const name = text(row?.name)
  const currency = currencyCode(row?.currency)
  const earnFrom = absent(row?.earn_from) ? undefined : readEarnFrom(row.earn_from)
  if (
    !row ||
    !programId ||
    !slug ||
    !name ||
    !currency ||
    earnFrom === null ||
    typeof row.working !== 'boolean' ||
    !Array.isArray(row.links)
  )
    throw new LinksUnreadable()
  const links = row.links.map(readLink)
  if (links.filter((link) => link.kind === 'main').length !== 1) throw new LinksUnreadable()
  const customLinks = links.filter((link) => link.kind === 'custom').length
  return {
    program_id: programId,
    slug,
    name: name.trim(),
    currency,
    ...(earnFrom === undefined ? {} : { earn_from: earnFrom }),
    working: row.working,
    paused_reason: row.working
      ? null
      : oneOf(row.paused_reason, ['program_paused', 'balance_empty'] as const),
    // Never fewer than the custom links that are on the page.
    custom_links: Math.max(count(row.custom_links) ?? 0, customLinks),
    links,
  }
}

function readChannel(value: unknown): LinkChannel {
  const row = record(value)
  const key = text(row?.key)
  const name = text(row?.name)
  if (!key || !name) throw new LinksUnreadable()
  return { key, name }
}

/** `{"stats_days", "max_custom_links", "channels", "programs"}` as `partner_program_links` sends it. */
export function readProgramLinks(value: unknown): ProgramLinks {
  const body = record(value)
  const statsDays = count(body?.stats_days)
  const maxCustomLinks = count(body?.max_custom_links)
  if (
    !body ||
    !statsDays ||
    maxCustomLinks === null ||
    !Array.isArray(body.channels) ||
    !Array.isArray(body.programs)
  )
    throw new LinksUnreadable()
  return {
    stats_days: statsDays,
    max_custom_links: maxCustomLinks,
    channels: body.channels.map(readChannel),
    programs: body.programs.map(readLinkProgram),
  }
}

// What there is to show ---------------------------------------------------------------------

export function mainLink(program: LinkProgram): ProgramLink {
  return program.links.find((link) => link.kind === 'main') ?? program.links[0]
}

/** The channel and custom links: every address a creator copies besides the main one. */
export function otherLinks(program: LinkProgram): ProgramLink[] {
  return program.links.filter((link) => link.kind !== 'main')
}

/** How many more custom links the program takes. Never below zero. */
export function customLinksLeft(program: LinkProgram, maxCustomLinks: number): number {
  return Math.max(0, maxCustomLinks - program.custom_links)
}

/** The answer with one program replaced by what a change returned. */
export function withProgram(links: ProgramLinks, program: LinkProgram): ProgramLinks {
  return {
    ...links,
    programs: links.programs.map((existing) =>
      existing.program_id === program.program_id ? program : existing,
    ),
  }
}

/** The link that is in `after` and was not in `before`: the one that was just added. */
export function addedLink(before: LinkProgram, after: LinkProgram): ProgramLink | null {
  const known = new Set(before.links.map((link) => link.link_id))
  return after.links.find((link) => !known.has(link.link_id)) ?? null
}

// Words -------------------------------------------------------------------------------------

/** "go.kissmyapps.dev/speaksix/ada": the address as it is read, without the scheme. */
export function displayAddress(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '')
}

/** "Live", or in one short sentence why sales are not credited right now. */
export function linkStatusLine(
  program: Pick<LinkProgram, 'working' | 'paused_reason' | 'earn_from'>,
): string {
  if (program.working) return 'Live'
  const what = creditedFor(program.earn_from)
  if (program.paused_reason === 'program_paused')
    return `Paused by the brand: ${what} are not credited right now.`
  if (program.paused_reason === 'balance_empty')
    return `Paused: the brand’s balance is empty, so ${what} are not credited right now.`
  return `Paused: ${what} are not credited right now.`
}

const wholeNumber = new Intl.NumberFormat('en-US')

/** "1,840" */
export function formatCount(value: number): string {
  return wholeNumber.format(value)
}

/**
 * Sales per click as "2.5%" (events per click in a program that pays for events only). With no
 * clicks there is no rate, and a dash says so.
 */
export function conversionRate(clicks: number, sales: number): string {
  if (clicks <= 0) return '—'
  return `${((sales / clicks) * 100).toFixed(1)}%`
}

export function linkEarnings(link: ProgramLink, currency: string): string {
  return formatMoney(link.earnings_minor, currency)
}

/** "3 of 20 custom links used" */
export function customLinksUsed(program: LinkProgram, maxCustomLinks: number): string {
  return `${Math.min(program.custom_links, maxCustomLinks)} of ${maxCustomLinks} custom links used`
}

/**
 * What is wrong with a name before it is sent, or null. The database checks again: a name is
 * 1 to 40 characters and no other link of the program has it, whatever its capitals.
 */
export function linkNameProblem(name: string, program: LinkProgram): string | null {
  // The database joins runs of spaces into one before it compares and counts.
  const trimmed = name.trim().replace(/\s+/g, ' ')
  const length = [...trimmed].length
  if (length === 0) return 'Give the link a name.'
  if (length > LINK_NAME_MAX) return linkMessages.invalid_name.message
  const wanted = trimmed.toLowerCase()
  if (program.links.some((link) => link.name.toLowerCase() === wanted))
    return linkMessages.name_taken.message
  return null
}

// What each failure means -------------------------------------------------------------------

const linkMessages: Record<
  Exclude<ProgramLinksErrorCode, PartnerDataErrorCode>,
  { message: string; retryable: boolean }
> = {
  invalid_input: {
    message: 'That could not be sent. Reload the page and try again.',
    retryable: false,
  },
  invalid_name: { message: `Use a name of 1 to ${LINK_NAME_MAX} characters.`, retryable: false },
  name_taken: {
    message: 'You already have a link with that name. Pick another name.',
    retryable: false,
  },
  too_many_links: {
    message: 'This program has all the custom links it can have.',
    retryable: false,
  },
  not_member: { message: 'You are no longer a member of this program.', retryable: false },
  link_in_use: { message: 'This link has been opened, so it stays.', retryable: false },
  not_removable: { message: 'This link cannot be removed.', retryable: false },
  link_not_found: { message: 'This link is no longer there.', retryable: false },
}

/** Words for the gateway's own failures, where the ones it carries are about "partner data". */
const accessMessages: Partial<Record<PartnerDataErrorCode, string>> = {
  not_authenticated: 'Your session has expired. Sign in again to continue.',
  not_authorized: 'Your creator account is not active, so links are not available to it.',
  contract_unavailable: 'Links are not available yet.',
  not_configured: 'Links are not available yet.',
  temporarily_unavailable: 'That did not go through. Check your connection and try again.',
  invalid_response: 'The answer could not be read. Try again.',
  unknown: 'That did not go through. Try again.',
}

type BackendFailure = Readonly<{ code?: string; details?: string | null }>

/**
 * The database raises link failures as 22023 with a stable code in DETAIL (42501 for someone
 * who is not a member, P0002 for a link that is not theirs). Returns null when the failure is
 * not one of those, so the caller falls back to the gateway's general mapping.
 */
export function linkFailure(failure: BackendFailure): ProgramLinksError | null {
  const detail = typeof failure.details === 'string' ? failure.details.trim() : ''
  let code: keyof typeof linkMessages | null = null
  if (Object.hasOwn(linkMessages, detail)) code = detail as keyof typeof linkMessages
  else if (/^invalid_[a-z0-9_]{1,56}$/.test(detail)) code = 'invalid_input'
  else if (failure.code === 'P0002') code = 'link_not_found'
  return code ? { code, ...linkMessages[code] } : null
}

export function linkError(code: ProgramLinksErrorCode): ProgramLinksError {
  if (Object.hasOwn(linkMessages, code))
    return { code, ...linkMessages[code as keyof typeof linkMessages] }
  return {
    code,
    message: accessMessages[code as PartnerDataErrorCode] ?? accessMessages.unknown!,
    retryable: code === 'temporarily_unavailable' || code === 'unknown',
  }
}

/**
 * The sentence shown for a failure: never the database's own words. Reading is refused (42501)
 * to someone with no active creator account; adding and removing are also refused to a role on
 * the account that can read links but not change them.
 */
export function linkErrorMessage(
  error: ProgramLinksError | null,
  step: 'load' | 'change' = 'load',
): string {
  if (!error) return accessMessages.unknown!
  if (Object.hasOwn(linkMessages, error.code))
    return linkMessages[error.code as keyof typeof linkMessages].message
  if (error.code === 'not_authorized' && step === 'change')
    return 'Your role on this creator account cannot change links.'
  return accessMessages[error.code as PartnerDataErrorCode] ?? accessMessages.unknown!
}

/**
 * Program links do not exist for this account or this deployment: the function is missing on a
 * database that has not been migrated yet, the connection is not set up, or the account is not
 * an active creator account.
 */
export function linksUnavailable(error: ProgramLinksError | null): boolean {
  return ['contract_unavailable', 'not_configured', 'not_authorized'].includes(error?.code ?? '')
}

/** After these the page no longer matches the database, so it is read again. */
export function staleAfter(error: ProgramLinksError | null): boolean {
  return [
    'name_taken',
    'too_many_links',
    'not_member',
    'link_in_use',
    'not_removable',
    'link_not_found',
  ].includes(error?.code ?? '')
}
