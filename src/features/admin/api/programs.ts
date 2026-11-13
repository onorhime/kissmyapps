/**
 * Affiliate programs waiting for KissMyApps review, as the admin review functions return
 * them. Every backend shape this screen depends on is mapped here, so a change to the
 * functions is a change to this file only.
 */

export const ADMIN_PROGRAM_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
  'archived',
] as const
export type AdminProgramStatus = (typeof ADMIN_PROGRAM_STATUSES)[number]

export const ADMIN_PROGRAM_PAUSE_REASONS = ['merchant', 'stripe_disconnected', 'admin'] as const
export type AdminProgramPauseReason = (typeof ADMIN_PROGRAM_PAUSE_REASONS)[number]

export const ADMIN_PROGRAM_EARN_FROM = ['sales', 'events', 'both'] as const
/** What creators earn from: a commission on sales, an amount per event, or both. */
export type AdminProgramEarnFrom = (typeof ADMIN_PROGRAM_EARN_FROM)[number]

/**
 * One event a program pays for. A part the merchant has not filled in, or that cannot be
 * read, is null, so the reviewer sees the gap instead of a shorter list.
 */
export type AdminProgramReward = Readonly<{
  /** The event's name in the merchant's analytics. */
  key: string | null
  /** The words creators read. */
  label: string | null
  amountMinor: number | null
}>

export type AdminProgramCommissionType = 'percent' | 'fixed'
export type AdminProgramCommissionDuration = 'first_payment' | 'months' | 'lifetime'

/**
 * The agreement KissMyApps generated from the program's terms. `extraTerms` is the brand's
 * own text, exactly as typed: it belongs directly after the last section, whose heading
 * already introduces it.
 */
export type AdminProgramAgreement = Readonly<{
  title: string
  brandName: string | null
  programName: string | null
  summary: readonly Readonly<{ label: string; value: string }>[]
  sections: readonly Readonly<{ heading: string; paragraphs: readonly string[] }>[]
  extraTerms: string | null
}>

export type AdminProgramReview = Readonly<{
  id: string
  status: AdminProgramStatus
  pauseReason: AdminProgramPauseReason | null
  reviewNote: string | null
  name: string
  category: string | null
  tagline: string | null
  /** Public address of the logo, or null when the program has none. */
  logoUrl: string | null
  landingUrl: string | null
  commissionType: AdminProgramCommissionType | null
  commissionRateBps: number | null
  commissionFixedMinor: number | null
  currency: string
  commissionDuration: AdminProgramCommissionDuration | null
  commissionMonths: number | null
  /** `sales` for an answer from before programs could pay for events. */
  earnFrom: AdminProgramEarnFrom
  /** In the merchant's order. Empty for an answer from before programs could pay for events. */
  rewards: readonly AdminProgramReward[]
  /** What rewards may add up to in a calendar month, in the program's currency. */
  rewardBudgetMinor: number | null
  marketplaceListed: boolean | null
  extraTerms: string | null
  workspaceId: string | null
  workspaceName: string | null
  brandName: string | null
  stripeAccountId: string | null
  stripeCountry: string | null
  submittedAt: string | null
  /** When KissMyApps last approved it or sent it back. Null while it waits for a first review. */
  reviewedAt: string | null
  /**
   * The published agreement for a live or paused program, the generated one otherwise. Null
   * when the program is too incomplete to generate one.
   */
  agreement: AdminProgramAgreement | null
}>

export type AdminProgramReviews = Readonly<{
  /** Waiting for a first review, oldest first. */
  waiting: readonly AdminProgramReview[]
  /** Reviewed lately: live, paused or sent back for changes. */
  reviewed: readonly AdminProgramReview[]
}>

export type AdminProgramDecision = 'approve' | 'request_changes'

export type AdminProgramReviewInput = Readonly<{
  programId: string
  decision: AdminProgramDecision
  /** Required for request_changes: 5 to 1000 characters, shown to the merchant. */
  note?: string | null
}>

export type AdminProgramStatusInput = Readonly<{
  programId: string
  status: 'paused' | 'live'
  /** Optional: 5 to 1000 characters when given. A pause note is shown to the merchant. */
  note?: string | null
}>

export type AdminProgramStatusResult = Readonly<{
  programId: string
  status: AdminProgramStatus
  /** Why the program is paused, when it is. */
  pauseReason: AdminProgramPauseReason | null
}>

export const PROGRAM_NOTE_MIN = 5
export const PROGRAM_NOTE_MAX = 1000
export const PROGRAM_LOGO_BUCKET = 'program-logos'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object.')
  }
  return value as Record<string, unknown>
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${key}.`)
  return value
}

/** A display field: missing or of the wrong type reads as not set, never as a failure. */
function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function wholeNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null
}

/** Missing reads as a sales program. A value this screen does not know is never guessed. */
function mapEarnFrom(value: unknown): AdminProgramEarnFrom {
  if (value === undefined || value === null) return 'sales'
  const earnFrom = oneOf(value, ADMIN_PROGRAM_EARN_FROM)
  if (!earnFrom) throw new Error('Invalid earn_from.')
  return earnFrom
}

/** Missing reads as no rewards. Every reward in the answer is kept, whole or not. */
function mapRewards(value: unknown): AdminProgramReward[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid rewards.')
  return value.map((item) => {
    const row = record(item)
    const amount = wholeNumber(row, 'amount_minor')
    return { key: text(row, 'key'), label: text(row, 'label'), amountMinor: amount || null }
  })
}

/**
 * The public address of a logo in the program-logos bucket. The path is
 * `<workspace id>/<file>`; anything else is treated as no logo.
 */
export function programLogoUrl(path: string | null, storageBaseUrl: string | null): string | null {
  if (!path || !storageBaseUrl) return null
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/i.test(path) || path.includes('..')) {
    return null
  }
  let base: URL
  try {
    base = new URL(storageBaseUrl)
  } catch {
    return null
  }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1')
    return null
  return `${base.origin}/storage/v1/object/public/${PROGRAM_LOGO_BUCKET}/${path}`
}

function mapAgreement(value: unknown): AdminProgramAgreement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const title = text(row, 'title')
  if (!title) return null
  const summary = (Array.isArray(row.summary) ? row.summary : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const label = text(item as Record<string, unknown>, 'label')
    const itemValue = text(item as Record<string, unknown>, 'value')
    return label && itemValue ? [{ label, value: itemValue }] : []
  })
  const sections = (Array.isArray(row.sections) ? row.sections : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const heading = text(item as Record<string, unknown>, 'heading')
    const raw = (item as Record<string, unknown>).paragraphs
    const paragraphs = (Array.isArray(raw) ? raw : []).filter(
      (paragraph): paragraph is string => typeof paragraph === 'string' && !!paragraph.trim(),
    )
    return heading ? [{ heading, paragraphs }] : []
  })
  return {
    title,
    brandName: text(row, 'brand_name'),
    programName: text(row, 'program_name'),
    summary,
    sections,
    // The brand's words stay as typed, line breaks included.
    extraTerms:
      typeof row.extra_terms === 'string' && row.extra_terms.trim() ? row.extra_terms : null,
  }
}

export function mapAdminProgramReview(
  value: unknown,
  storageBaseUrl: string | null = null,
): AdminProgramReview {
  const row = record(value)
  const status = oneOf(row.status, ADMIN_PROGRAM_STATUSES)
  if (!status) throw new Error('Invalid status.')
  return {
    id: requiredText(row, 'id'),
    status,
    pauseReason: oneOf(row.pause_reason, ADMIN_PROGRAM_PAUSE_REASONS),
    reviewNote: text(row, 'review_note'),
    name: text(row, 'name') ?? text(row, 'slug') ?? 'Unnamed program',
    category: text(row, 'category'),
    tagline: text(row, 'tagline'),
    logoUrl: programLogoUrl(text(row, 'logo_path'), storageBaseUrl),
    landingUrl: text(row, 'landing_url'),
    commissionType: oneOf(row.commission_type, ['percent', 'fixed'] as const),
    commissionRateBps: wholeNumber(row, 'commission_rate_bps'),
    commissionFixedMinor: wholeNumber(row, 'commission_fixed_minor'),
    currency: (text(row, 'currency') ?? 'USD').toUpperCase(),
    commissionDuration: oneOf(row.commission_duration, [
      'first_payment',
      'months',
      'lifetime',
    ] as const),
    commissionMonths: wholeNumber(row, 'commission_months'),
    earnFrom: mapEarnFrom(row.earn_from),
    rewards: mapRewards(row.rewards),
    rewardBudgetMinor: wholeNumber(row, 'reward_budget_minor') || null,
    marketplaceListed: typeof row.marketplace_listed === 'boolean' ? row.marketplace_listed : null,
    extraTerms: text(row, 'extra_terms'),
    workspaceId: text(row, 'workspace_id'),
    workspaceName: text(row, 'workspace_name'),
    brandName: text(row, 'brand_name'),
    stripeAccountId: text(row, 'stripe_account_id'),
    stripeCountry: text(row, 'stripe_country')?.toUpperCase() ?? null,
    submittedAt: text(row, 'submitted_at'),
    reviewedAt: text(row, 'reviewed_at'),
    agreement: mapAgreement(row.agreement),
  }
}

/** `{"programs": [...]}`: the queue first, then the recently reviewed. */
export function mapAdminProgramReviews(
  value: unknown,
  storageBaseUrl: string | null = null,
): AdminProgramReviews {
  const programs = record(value).programs
  if (!Array.isArray(programs)) throw new Error('Expected a list of programs.')
  const mapped = programs.map((program) => mapAdminProgramReview(program, storageBaseUrl))
  return {
    waiting: mapped.filter((program) => program.status === 'in_review'),
    reviewed: mapped.filter((program) =>
      ['live', 'paused', 'changes_requested'].includes(program.status),
    ),
  }
}

/** `{"program_id", "status"}`, checked against the program that was sent. */
export function mapAdminProgramStatusResult(
  value: unknown,
  programId: string,
  expected: readonly AdminProgramStatus[],
): AdminProgramStatusResult {
  const row = record(Array.isArray(value) && value.length === 1 ? value[0] : value)
  const status = oneOf(row.status, ADMIN_PROGRAM_STATUSES)
  if (row.program_id !== programId || !status || !expected.includes(status)) {
    throw new Error('Unexpected program result.')
  }
  return { programId, status, pauseReason: oneOf(row.pause_reason, ADMIN_PROGRAM_PAUSE_REASONS) }
}

/**
 * `{"program_id", "status", "pause_reason"}` after a pause or a lifted pause. A pause leaves
 * the program paused. A lifted pause leaves it live, or still paused when the workspace's
 * Stripe account was disconnected meanwhile: the returned state is the truth, not the request.
 */
export function mapAdminProgramStatusChange(
  value: unknown,
  programId: string,
  requested: 'paused' | 'live',
): AdminProgramStatusResult {
  const result = mapAdminProgramStatusResult(
    value,
    programId,
    requested === 'paused' ? ['paused'] : ['live', 'paused'],
  )
  const stillPaused = requested === 'live' && result.status === 'paused'
  if (stillPaused && result.pauseReason !== 'stripe_disconnected') {
    throw new Error('Unexpected program result.')
  }
  return result
}
