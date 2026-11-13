import {
  categoryLabels,
  commissionHeadline,
  formatMoney,
  initials,
  readAgreement,
} from '../../merchant/programs'
import type {
  AgreementDoc,
  ApprovalMode,
  Category,
  CommissionDuration,
  CommissionType,
} from '../../merchant/programs'
import { isProgramSlug } from './routing'

/**
 * What a creator reads about a program, on the public marketplace and inside the partner
 * dashboard. The shapes are the backend's (`ProgramCard`, `ProgramDetail`); every answer is
 * read here before a component sees it, so a page never draws from a malformed row.
 */

export type MembershipStatus = 'pending' | 'active' | 'declined' | 'removed' | 'left'
export type ProgramListingStatus = 'live' | 'paused' | 'archived'

/** What creators earn from: a commission on sales, a fixed amount per event, or both. */
export type EarnFrom = 'sales' | 'events' | 'both'

/** One thing a program pays for besides sales: what creators read and what it pays. */
export interface ProgramReward {
  /** The event's name on the merchant's site. It tells rewards apart; creators read `label`. */
  key: string
  label: string
  amount_minor: number
}

export interface MarketplaceProgram {
  slug: string
  name: string
  category: Category | null
  tagline: string | null
  logo_path: string | null
  brand_name: string | null
  commission_type: CommissionType | null
  commission_rate_bps: number | null
  commission_fixed_minor: number | null
  currency: string
  commission_duration: CommissionDuration | null
  commission_months: number | null
  attribution_window_days: number
  hold_days: number
  minimum_payout_minor: number
  approval_mode: ApprovalMode
  terms_version: number | null
  /** `sales` for a program from before programs could pay for events. */
  earn_from: EarnFrom
  /** In the merchant's order. Empty when the program pays for sales only. */
  rewards: ProgramReward[]
  /** Set only on the signed-in creator's list: where they stand with this program. */
  membership_status: MembershipStatus | null
}

export interface MarketplaceProgramDetail extends MarketplaceProgram {
  /** The program's id. Only the signed-in answer carries it. */
  id: string | null
  status: ProgramListingStatus
  landing_url: string | null
  agreement: AgreementDoc
  agreement_sha256: string
}

export class MarketplaceUnreadable extends Error {
  constructor() {
    super('The marketplace answer could not be read.')
    this.name = 'MarketplaceUnreadable'
  }
}

const MEMBERSHIP_STATUSES = ['pending', 'active', 'declined', 'removed', 'left'] as const
const COMMISSION_TYPES = ['percent', 'fixed'] as const
const EARN_FROM = ['sales', 'events', 'both'] as const
const REWARD_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/

export const MAXIMUM_REWARDS = 5
const MAXIMUM_REWARD_LABEL = 40
const MAXIMUM_REWARD_MINOR = 100_000_000

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value : null
export const whole = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null
}

/** The rewards of a card, or null when the list or any reward in it is not well formed. */
function readRewards(value: unknown): ProgramReward[] | null {
  if (!Array.isArray(value) || value.length > MAXIMUM_REWARDS) return null
  const rewards: ProgramReward[] = []
  for (const item of value) {
    const row = record(item)
    const label = typeof row?.label === 'string' ? row.label.trim() : ''
    const amount = row?.amount_minor
    if (
      !row ||
      typeof row.key !== 'string' ||
      !REWARD_KEY.test(row.key) ||
      rewards.some((reward) => reward.key === row.key) ||
      label === '' ||
      [...label].length > MAXIMUM_REWARD_LABEL ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > MAXIMUM_REWARD_MINOR
    )
      return null
    rewards.push({ key: row.key, label, amount_minor: amount })
  }
  return rewards
}

/**
 * What the card says creators earn from. An answer from before programs could pay for events
 * has neither key and pays for sales. With the keys, the card must be whole: a commission
 * unless it pays for events only, and at least one reward unless it pays for sales only.
 */
function readEarnFrom(
  row: Record<string, unknown>,
): Pick<MarketplaceProgram, 'earn_from' | 'rewards'> | null {
  if (row.earn_from == null && row.rewards == null) return { earn_from: 'sales', rewards: [] }
  const earnFrom = oneOf(row.earn_from, EARN_FROM)
  const rewards = readRewards(row.rewards)
  if (!earnFrom || !rewards) return null
  const hasCommission = oneOf(row.commission_type, COMMISSION_TYPES) !== null
  if (earnFrom === 'events' ? row.commission_type !== null : !hasCommission) return null
  if ((earnFrom === 'sales') !== (rewards.length === 0)) return null
  return { earn_from: earnFrom, rewards }
}

/**
 * One card. Null when the row has no usable slug or name, or when what it pays for cannot be
 * trusted, so a list can leave it out.
 */
export function readProgram(value: unknown): MarketplaceProgram | null {
  const row = record(value)
  const name = text(row?.name)
  if (!row || !isProgramSlug(row.slug) || !name) return null
  const pays = readEarnFrom(row)
  if (!pays) return null
  return {
    slug: row.slug,
    name,
    category: oneOf(row.category, Object.keys(categoryLabels) as Category[]),
    tagline: text(row.tagline),
    logo_path: text(row.logo_path),
    brand_name: text(row.brand_name),
    commission_type: oneOf(row.commission_type, COMMISSION_TYPES),
    commission_rate_bps: whole(row.commission_rate_bps),
    commission_fixed_minor: whole(row.commission_fixed_minor),
    currency: text(row.currency) ?? 'USD',
    commission_duration: oneOf(row.commission_duration, [
      'first_payment',
      'months',
      'lifetime',
    ] as const),
    commission_months: whole(row.commission_months),
    attribution_window_days: whole(row.attribution_window_days) ?? 30,
    hold_days: whole(row.hold_days) ?? 30,
    minimum_payout_minor: whole(row.minimum_payout_minor) ?? 0,
    approval_mode: row.approval_mode === 'manual' ? 'manual' : 'automatic',
    terms_version: whole(row.terms_version),
    ...pays,
    membership_status: oneOf(row.membership_status, MEMBERSHIP_STATUSES),
  }
}

/** `{"programs": [...]}`. A row that cannot be read is left out; a body that cannot is refused. */
export function readProgramList(value: unknown): MarketplaceProgram[] {
  const body = record(value)
  if (!body || !Array.isArray(body.programs)) throw new MarketplaceUnreadable()
  return body.programs.flatMap((item) => {
    const program = readProgram(item)
    return program ? [program] : []
  })
}

/** One program with its agreement. Refused unless the agreement and its hash are whole. */
export function readProgramDetail(value: unknown): MarketplaceProgramDetail {
  const row = record(value)
  const card = readProgram(row)
  if (!row || !card) throw new MarketplaceUnreadable()
  let agreement
  try {
    agreement = readAgreement({
      agreement: row.agreement,
      sha256: row.agreement_sha256,
      complete: true,
    })
  } catch {
    throw new MarketplaceUnreadable()
  }
  if (!agreement.agreement || !agreement.sha256 || card.terms_version === null)
    throw new MarketplaceUnreadable()
  return {
    ...card,
    id: text(row.id),
    status: oneOf(row.status, ['live', 'paused', 'archived'] as const) ?? 'paused',
    landing_url: text(row.landing_url),
    agreement: agreement.agreement,
    agreement_sha256: agreement.sha256,
  }
}

// The words on a card ----------------------------------------------------------------------

export function categoryLabel(category: string | null): string | null {
  return category && category in categoryLabels ? categoryLabels[category as Category] : null
}

/** "$2.00 per Account created": one reward as a creator reads it. */
export function programRewardLine(reward: ProgramReward, currency: string): string {
  return `${formatMoney(reward.amount_minor, currency)} per ${reward.label}`
}

/** How many rewards the headline names before it counts the rest. */
const HEADLINE_REWARDS = 2

function rewardsHeadline(rewards: readonly ProgramReward[], currency: string): string | null {
  if (rewards.length === 0) return null
  const named = rewards
    .slice(0, HEADLINE_REWARDS)
    .map((reward) => programRewardLine(reward, currency))
    .join(', ')
  const more = rewards.length - HEADLINE_REWARDS
  return more > 0 ? `${named} and ${more} more ${more === 1 ? 'reward' : 'rewards'}` : named
}

/**
 * What a program pays, in one line, the same wherever a program is shown.
 * Sales: "30% of every payment for 12 months". Events: "$2.00 per Account created", the
 * first two rewards named and the rest counted. Both: the commission, "plus" the rewards.
 */
export function programHeadline(program: MarketplaceProgram): string | null {
  const commission = program.earn_from === 'events' ? null : commissionHeadline(program)
  const rewards =
    program.earn_from === 'sales' ? null : rewardsHeadline(program.rewards, program.currency)
  return commission && rewards ? `${commission}, plus ${rewards}` : (commission ?? rewards)
}

/**
 * The class to add after a headline's own. A headline that names rewards runs to two or three
 * lines, so its lines are evened out; a sales headline keeps the class it always had.
 */
export function programHeadlineClass(program: MarketplaceProgram): string {
  return program.earn_from === 'sales' ? '' : ' mkt-headline-rewards'
}

/** "30-day attribution · 30-day hold": the small line under the commission. */
export function programTermsLine(program: MarketplaceProgram): string {
  const hold = program.hold_days === 0 ? 'No hold' : `${program.hold_days}-day hold`
  return `${program.attribution_window_days}-day attribution · ${hold}`
}

export function programInitials(name: string): string {
  return initials(name) || name.trim().slice(0, 2).toUpperCase()
}

/** The categories that have at least one program, in the console's order. */
export function categoriesPresent(programs: readonly MarketplaceProgram[]): Category[] {
  const present = new Set(programs.map((program) => program.category))
  return (Object.keys(categoryLabels) as Category[]).filter((key) => present.has(key))
}

/** The browser-side filter: one category, and words found in the name or the tagline. */
export function filterPrograms(
  programs: readonly MarketplaceProgram[],
  category: Category | null,
  query: string,
): MarketplaceProgram[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return programs.filter((program) => {
    if (category && program.category !== category) return false
    const haystack = `${program.name} ${program.tagline ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** "1. Who this agreement is between" → the number and the words, drawn in two columns. */
export function sectionParts(heading: string): { number: string | null; title: string } {
  const match = /^(\d{1,2})\.\s+(.+)$/.exec(heading.trim())
  return match ? { number: match[1], title: match[2] } : { number: null, title: heading.trim() }
}

const LOGO_BUCKET_PATH = '/storage/v1/object/public/program-logos/'

/** Where a program's logo is served from. Null when there is no logo or no project address. */
export function programLogoUrl(baseUrl: string | null, logoPath: string | null): string | null {
  if (!baseUrl || !logoPath || logoPath.includes('..')) return null
  const path = logoPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return path ? `${baseUrl.replace(/\/+$/, '')}${LOGO_BUCKET_PATH}${path}` : null
}

/** The Supabase project address the app was built with, or null when there is none. */
export function projectBaseUrl(): string | null {
  const raw = import.meta.env.VITE_SUPABASE_URL?.trim()
  if (!raw || raw.includes('your-project-ref')) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      ? raw.replace(/\/+$/, '')
      : null
  } catch {
    return null
  }
}
