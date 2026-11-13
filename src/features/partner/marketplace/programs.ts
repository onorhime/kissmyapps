import {
  MarketplaceUnreadable,
  oneOf,
  readProgram,
  readProgramDetail,
  record,
  text,
  whole,
} from '../../marketplace/model'
import type {
  MarketplaceProgram,
  MarketplaceProgramDetail,
  MembershipStatus,
  ProgramListingStatus,
} from '../../marketplace/model'
import type { PartnerDataErrorCode, PartnerDataStatus } from '../api/types'
import { readPromoCode } from '../links/promoCode'
import type { PromoCode, PromoCodeShown } from '../links/promoCode'

/**
 * A creator's programs: what the `partner_marketplace` and `partner_program_*` database
 * functions answer, read into shapes the page can trust, and what each of their failures
 * means in words a creator can act on.
 */

export interface ProgramLink {
  url: string
  short_url: string | null
  /** The membership is active, the program is live and the link itself is switched on. */
  working: boolean
}

export interface ProgramMembership {
  id: string
  /** Needed to accept new terms or to leave. Null if the backend did not send it. */
  program_id: string | null
  program: MarketplaceProgram
  program_status: ProgramListingStatus
  status: MembershipStatus
  terms_version: number | null
  accepted_at: string | null
  needs_new_terms: boolean
  link: ProgramLink | null
  requested_at: string | null
  activated_at: string | null
  ended_at: string | null
  decision_note: string | null
  /** The creator's promo code in this program, when the membership answer carries one. */
  promo_code?: PromoCode
}

export interface PartnerMarketplace {
  /** False while the platform cannot issue links, so nothing can be joined yet. */
  tracking_ready: boolean
  programs: MarketplaceProgram[]
  memberships: ProgramMembership[]
}

export interface PartnerProgramView {
  program: MarketplaceProgramDetail
  membership: ProgramMembership | null
  /** The name the agreement will be accepted under. */
  accept_name: string | null
  /**
   * The creator's promo code in this program: null when there is none to show, and from a
   * database from before promo codes.
   */
  promo_code: PromoCode | null
}

export type PartnerProgramErrorCode =
  | PartnerDataErrorCode
  | 'program_not_found'
  | 'program_not_open'
  | 'terms_changed'
  | 'already_member'
  | 'membership_closed'
  | 'tracking_not_enabled'
  | 'not_a_member'
  | 'status_not_allowed'
  | 'name_missing'
  | 'invalid_request'

export type PartnerProgramError = Readonly<{
  code: PartnerProgramErrorCode
  message: string
  retryable: boolean
}>

/** The same envelope as `PartnerDataResult`, with the program failures added to its codes. */
export type PartnerProgramResult<T> = Readonly<{
  data: T
  status: PartnerDataStatus
  error: PartnerProgramError | null
}>

export type ProgramJoinInput = Readonly<{
  slug: string
  termsVersion: number
  agreementSha256: string
}>

export type ProgramTermsInput = Readonly<{
  programId: string
  termsVersion: number
  agreementSha256: string
}>

// Reading answers ---------------------------------------------------------------------------

const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null

/** A link is shown and copied, so it must be a plain https address. */
function webAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch {
    return null
  }
}

function readLink(value: unknown): ProgramLink | null {
  const row = record(value)
  const url = webAddress(row?.url)
  if (!row || !url) return null
  return { url, short_url: webAddress(row.short_url), working: row.working === true }
}

export function readMembership(value: unknown): ProgramMembership {
  const row = record(value)
  const program = readProgram(row?.program)
  const status = oneOf(row?.status, ['pending', 'active', 'declined', 'removed', 'left'] as const)
  const promoCode = readPromoCode(row?.promo_code)
  if (!row || typeof row.id !== 'string' || !program || !status || promoCode === null)
    throw new MarketplaceUnreadable()
  return {
    id: row.id,
    program_id: text(row.program_id),
    program,
    program_status: oneOf(row.program_status, ['live', 'paused', 'archived'] as const) ?? 'paused',
    status,
    terms_version: whole(row.terms_version),
    accepted_at: moment(row.accepted_at),
    needs_new_terms: row.needs_new_terms === true,
    link: readLink(row.link),
    requested_at: moment(row.requested_at),
    activated_at: moment(row.activated_at),
    ended_at: moment(row.ended_at),
    decision_note: text(row.decision_note),
    ...(promoCode === undefined ? {} : { promo_code: promoCode }),
  }
}

/** `{"membership": Membership}`: what joining, accepting terms and leaving answer. */
export function readMembershipAnswer(value: unknown): ProgramMembership {
  return readMembership(record(value)?.membership)
}

export function readPartnerMarketplace(value: unknown): PartnerMarketplace {
  const body = record(value)
  if (!body || !Array.isArray(body.programs) || !Array.isArray(body.memberships))
    throw new MarketplaceUnreadable()
  return {
    tracking_ready: body.tracking_ready !== false,
    programs: body.programs.flatMap((item) => {
      const program = readProgram(item)
      return program ? [program] : []
    }),
    memberships: body.memberships.map(readMembership),
  }
}

/**
 * `{"program", "membership", "accept_name", "promo_code"}`. The promo code is read beside the
 * membership, or inside it when that is where the answer puts it.
 */
export function readPartnerProgramView(value: unknown): PartnerProgramView {
  const body = record(value)
  if (!body) throw new MarketplaceUnreadable()
  const membership =
    body.membership === null || body.membership === undefined
      ? null
      : readMembership(body.membership)
  const promoCode = readPromoCode(body.promo_code)
  if (promoCode === null) throw new MarketplaceUnreadable()
  return {
    program: readProgramDetail(body.program),
    membership,
    accept_name: text(body.accept_name),
    promo_code: promoCode ?? membership?.promo_code ?? null,
  }
}

// What each failure means -------------------------------------------------------------------

const programMessages: Record<
  Exclude<PartnerProgramErrorCode, PartnerDataErrorCode>,
  { message: string; retryable: boolean }
> = {
  program_not_found: { message: 'This program could not be found.', retryable: false },
  program_not_open: {
    message: 'This program is not taking new creators right now.',
    retryable: false,
  },
  terms_changed: {
    message:
      'The terms changed while this page was open. This is the latest agreement. Read it and accept again.',
    retryable: false,
  },
  already_member: { message: 'You have already joined this program.', retryable: false },
  membership_closed: {
    message: 'Your membership of this program was closed, so you cannot join it again from here.',
    retryable: false,
  },
  tracking_not_enabled: {
    message: 'Links are not available yet. Try again later.',
    retryable: true,
  },
  not_a_member: { message: 'You are not a member of this program.', retryable: false },
  status_not_allowed: {
    message: 'That is not possible while your membership is in this state.',
    retryable: false,
  },
  name_missing: {
    message: 'Add your name in your profile first. It is the name the agreement is accepted under.',
    retryable: false,
  },
  invalid_request: {
    message: 'That could not be sent. Reload the page and try again.',
    retryable: false,
  },
}

/** Words for the gateway's own failures, where the ones it carries are about "partner data". */
const accessMessages: Partial<Record<PartnerDataErrorCode, string>> = {
  not_authenticated: 'Your session has expired. Sign in again to continue.',
  not_authorized: 'Your creator account is not active, so programs are not available to it.',
  contract_unavailable: 'The marketplace is not available yet.',
  not_configured: 'The marketplace is not available yet.',
  temporarily_unavailable: 'That did not go through. Check your connection and try again.',
  invalid_response: 'The answer could not be read. Try again.',
  unknown: 'That did not go through. Try again.',
}

type BackendFailure = Readonly<{ code?: string; details?: string | null }>

/**
 * The database raises program failures as 22023 with a stable code in DETAIL (P0002 and 40001
 * for the two named ones). Returns null when the failure is not one of those, so the caller
 * falls back to the gateway's general mapping.
 */
export function programFailure(failure: BackendFailure): PartnerProgramError | null {
  const detail = typeof failure.details === 'string' ? failure.details.trim() : ''
  const errcode = failure.code ?? ''
  let code: keyof typeof programMessages | null = null
  if (detail === 'invalid_accept_name') code = 'name_missing'
  else if (Object.hasOwn(programMessages, detail)) code = detail as keyof typeof programMessages
  else if (/^invalid_[a-z0-9_]{1,56}$/.test(detail)) code = 'invalid_request'
  else if (errcode === '40001') code = 'terms_changed'
  else if (errcode === 'P0002') code = 'program_not_found'
  return code ? { code, ...programMessages[code] } : null
}

export function programError(code: PartnerProgramErrorCode, message?: string): PartnerProgramError {
  if (Object.hasOwn(programMessages, code)) {
    const known = programMessages[code as keyof typeof programMessages]
    return { code, message: message ?? known.message, retryable: known.retryable }
  }
  return {
    code,
    message: message ?? accessMessages[code as PartnerDataErrorCode] ?? 'Try again.',
    retryable: code === 'temporarily_unavailable' || code === 'unknown',
  }
}

/**
 * The sentence shown for a failure: the program's own words, or plain ones for access.
 * Reading is refused (42501) to someone with no active creator account; joining, accepting
 * terms and leaving are also refused to anyone but the account's owner.
 */
export function programErrorMessage(
  error: PartnerProgramError | null,
  step: 'load' | 'change' = 'load',
): string {
  if (!error) return accessMessages.unknown!
  if (Object.hasOwn(programMessages, error.code)) return error.message
  if (error.code === 'not_authorized' && step === 'change')
    return 'Only the owner of this creator account can do this.'
  return accessMessages[error.code as PartnerDataErrorCode] ?? error.message
}

// Where a creator stands --------------------------------------------------------------------

export type StandingTone = 'good' | 'waiting' | 'quiet'

/** The one or two words on a program's card or a membership's corner. */
export function membershipStanding(
  status: MembershipStatus,
  programStatus: ProgramListingStatus = 'live',
  needsNewTerms = false,
): { label: string; tone: StandingTone } {
  if (programStatus === 'archived') return { label: 'Ended', tone: 'quiet' }
  if (status === 'pending') return { label: 'Waiting', tone: 'waiting' }
  if (status === 'declined') return { label: 'Declined', tone: 'quiet' }
  if (status === 'removed') return { label: 'Removed', tone: 'quiet' }
  if (status === 'left') return { label: 'Left', tone: 'quiet' }
  if (programStatus === 'paused') return { label: 'Paused', tone: 'waiting' }
  if (needsNewTerms) return { label: 'New terms', tone: 'waiting' }
  return { label: 'Active', tone: 'good' }
}

/** The address to hand out: the short one when there is one. */
export function shareableLink(link: ProgramLink): string {
  return link.short_url ?? link.url
}

/**
 * The code an active member sees on a program's page. A program with a buyer discount gives
 * every active member a code as they join, so with no code in the answer (it was just joined
 * and the answer of joining does not say) the code is being made.
 */
export function promoCodeShown(
  program: Pick<MarketplaceProgram, 'buyer_discount_bps'>,
  promoCode: PromoCode | null,
): PromoCodeShown | null {
  if (promoCode) return promoCode
  return program.buyer_discount_bps
    ? { status: 'pending', discount_bps: program.buyer_discount_bps }
    : null
}

export function brandOf(program: MarketplaceProgram): string {
  return program.brand_name ?? program.name
}
