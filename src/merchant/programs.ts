import { requireSupabaseClient } from '../lib/supabase'
import { formatAgo } from './format'

/**
 * The workspace's affiliate program: the calls to the `workspace_program_*` database functions,
 * what their errors mean to a business owner, and the small conversions between what the form
 * shows (30, 20.00) and what the database stores. Every backend shape is read in this file only.
 */

export const LOGO_BUCKET = 'program-logos'
export const LOGO_MAX_BYTES = 2 * 1024 * 1024
const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export type ProgramStatus =
  'draft' | 'in_review' | 'changes_requested' | 'live' | 'paused' | 'archived'
export type PauseReason = 'merchant' | 'stripe_disconnected' | 'admin' | 'balance_empty'
export type CommissionType = 'percent' | 'fixed'
export type CommissionDuration = 'first_payment' | 'months' | 'lifetime'
export type ApprovalMode = 'automatic' | 'manual'
/** What creators are paid for: a share of sales, a fixed reward per event, or both. */
export type EarnFrom = 'sales' | 'events' | 'both'

/** One event the program pays for: its name, the words creators read, and the amount. */
export interface Reward {
  key: string
  label: string
  amount_minor: number
}

export const MAX_REWARDS = 5
const REWARD_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/
const REWARD_LABEL_MAX = 40
const REWARD_MAX_MINOR = 100_000_000
const BUDGET_MIN_MINOR = 100

/** The keys the database accepts for a category, with the words shown for each. */
export const categoryLabels = {
  education: 'Education',
  productivity: 'Productivity',
  health_fitness: 'Health and fitness',
  lifestyle: 'Lifestyle',
  finance: 'Finance',
  entertainment: 'Entertainment',
  games: 'Games',
  social: 'Social',
  utilities: 'Utilities',
  business: 'Business',
  shopping: 'Shopping',
  travel: 'Travel',
  food_drink: 'Food and drink',
  developer_tools: 'Developer tools',
  other: 'Other',
} as const
export type Category = keyof typeof categoryLabels

export const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const

export interface Program {
  id: string
  revision: number
  status: ProgramStatus
  pause_reason: PauseReason | null
  review_note: string | null
  slug: string | null
  name: string | null
  category: Category | null
  tagline: string | null
  logo_path: string | null
  landing_url: string | null
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
  marketplace_listed: boolean
  extra_terms: string | null
  agreement_read: boolean
  has_unpublished_changes: boolean
  live_terms_version: number | null
  submitted_at: string | null
  first_published_at: string | null
  updated_at: string | null
  /**
   * The next three are missing in an answer from before programs could pay for events.
   * Missing means what it meant then: the program pays for sales and has no rewards.
   */
  earn_from?: EarnFrom
  rewards?: Reward[]
  reward_budget_minor?: number | null
  /**
   * The smart link the landing page is, when it is one of the workspace's apps' links; null for
   * a web page. Missing in an answer from before programs could send people to an app.
   */
  app_link?: ProgramAppLink | null
}

export interface Checklist {
  stripe_connected: boolean
  details: boolean
  landing_page: boolean
  commission: boolean
  agreement_read: boolean
}

export interface ProgramState {
  can_manage: boolean
  stripe_connected: boolean
  brand_name: string | null
  program: Program | null
  checklist: Checklist
  can_submit: boolean
  /** Whether this workspace can pay for events. Missing in an answer from before it could. */
  events_available?: boolean
  /**
   * Whether the workspace has smart links of an app a program can send people to. Missing in an
   * answer from before programs could send people to an app.
   */
  app_links_available?: boolean
}

/** An event KissMyApps has already received from the business's site or app. */
export interface RewardEvent {
  name: string
  description: string | null
  first_seen: string | null
  last_seen: string | null
  /** The words KissMyApps suggests creators read for it. Missing in an older answer. */
  suggested_label?: string | null
}

export interface AgreementDoc {
  title: string
  brand_name: string
  program_name: string
  summary: Array<{ label: string; value: string }>
  sections: Array<{ heading: string; paragraphs: string[] }>
  extra_terms: string | null
}

export interface Agreement {
  agreement: AgreementDoc | null
  sha256: string | null
  complete: boolean
}

export interface Tracking {
  connected: boolean
  payments_seen: number
  tagged_payments: number
  sales: number
  matched_sales: number
  last_sale_at: string | null
  last_matched_at: string | null
  last_match_source: string | null
  sdk_click_seen_at: string | null
}

/** What the database takes when saving: any of these, null to clear one. */
export interface ProgramInput {
  name?: string | null
  category?: Category | null
  tagline?: string | null
  logo_path?: string | null
  landing_url?: string | null
  commission_type?: CommissionType | null
  commission_rate_bps?: number | null
  commission_fixed_minor?: number | null
  currency?: string
  commission_duration?: CommissionDuration | null
  commission_months?: number | null
  attribution_window_days?: number
  hold_days?: number
  minimum_payout_minor?: number
  approval_mode?: ApprovalMode
  marketplace_listed?: boolean
  extra_terms?: string | null
  earn_from?: EarnFrom
  /** The whole list, replacing what was saved. */
  rewards?: Reward[]
  reward_budget_minor?: number | null
}

export class ProgramError extends Error {
  readonly code: string

  constructor(code: string, message = '') {
    super(message || code)
    this.name = 'ProgramError'
    this.code = code
  }
}

// Reading answers ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const unreadable = () => new ProgramError('response_unreadable')
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
const whole = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
const count = (value: unknown) => Math.max(0, whole(value) ?? 0)
const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null
}

const STATUSES = ['draft', 'in_review', 'changes_requested', 'live', 'paused', 'archived'] as const
const EARN_FROM = ['sales', 'events', 'both'] as const

const wholeAmount = (value: unknown, low: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= REWARD_MAX_MINOR

/** One reward exactly as the database stores it, or null when it is not one. */
function readReward(value: unknown): Reward | null {
  const row = record(value)
  if (!row || typeof row.key !== 'string' || typeof row.label !== 'string') return null
  const label = row.label.trim()
  if (!REWARD_KEY.test(row.key) || !label || label.length > REWARD_LABEL_MAX) return null
  if (!wholeAmount(row.amount_minor, 1)) return null
  return { key: row.key, label, amount_minor: row.amount_minor as number }
}

/**
 * What the program pays for, when the answer says. Money depends on these, so a value that is
 * there but cannot be read refuses the whole answer; none of them there is an older answer.
 */
function readEarning(
  row: Record<string, unknown>,
): Pick<Program, 'earn_from' | 'rewards' | 'reward_budget_minor'> {
  const read: Pick<Program, 'earn_from' | 'rewards' | 'reward_budget_minor'> = {}
  if (row.earn_from !== undefined) {
    const earnFrom = oneOf(row.earn_from, EARN_FROM)
    if (!earnFrom) throw unreadable()
    read.earn_from = earnFrom
  }
  if (row.rewards !== undefined) {
    if (!Array.isArray(row.rewards) || row.rewards.length > MAX_REWARDS) throw unreadable()
    read.rewards = row.rewards.map((item) => {
      const reward = readReward(item)
      if (!reward) throw unreadable()
      return reward
    })
  }
  if (row.reward_budget_minor !== undefined) {
    const budget = row.reward_budget_minor
    if (budget !== null && !wholeAmount(budget, BUDGET_MIN_MINOR)) throw unreadable()
    read.reward_budget_minor = budget as number | null
  }
  return read
}

function readProgram(value: unknown): Program | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  const status = oneOf(row?.status, STATUSES)
  const revision = whole(row?.revision)
  if (!row || typeof row.id !== 'string' || !status || revision === null) throw unreadable()
  // An archived program is history; the workspace starts again from an empty form.
  if (status === 'archived') return null
  return {
    id: row.id,
    revision,
    status,
    pause_reason: oneOf(row.pause_reason, [
      'merchant',
      'stripe_disconnected',
      'admin',
      'balance_empty',
    ] as const),
    review_note: text(row.review_note),
    slug: text(row.slug),
    name: text(row.name),
    category: oneOf(row.category, Object.keys(categoryLabels) as Category[]),
    tagline: text(row.tagline),
    logo_path: text(row.logo_path),
    landing_url: text(row.landing_url),
    commission_type: oneOf(row.commission_type, ['percent', 'fixed'] as const),
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
    minimum_payout_minor: whole(row.minimum_payout_minor) ?? 2000,
    approval_mode: row.approval_mode === 'manual' ? 'manual' : 'automatic',
    marketplace_listed: row.marketplace_listed !== false,
    extra_terms: text(row.extra_terms),
    agreement_read: row.agreement_read === true,
    has_unpublished_changes: row.has_unpublished_changes === true,
    live_terms_version: whole(row.live_terms_version),
    submitted_at: moment(row.submitted_at),
    first_published_at: moment(row.first_published_at),
    updated_at: moment(row.updated_at),
    ...readEarning(row),
    ...readProgramAppLink(row),
  }
}

/** Reads a ProgramState answer, refusing one that cannot be trusted to draw the page. */
export function readState(value: unknown): ProgramState {
  const body = record(value)
  if (!body || typeof body.can_manage !== 'boolean') throw unreadable()
  const list = record(body.checklist) ?? {}
  return {
    can_manage: body.can_manage,
    stripe_connected: body.stripe_connected === true,
    brand_name: text(body.brand_name),
    program: readProgram(body.program),
    checklist: {
      stripe_connected: list.stripe_connected === true,
      details: list.details === true,
      landing_page: list.landing_page === true,
      commission: list.commission === true,
      agreement_read: list.agreement_read === true,
    },
    can_submit: body.can_submit === true,
    ...(body.events_available === undefined
      ? {}
      : { events_available: body.events_available === true }),
    ...(body.app_links_available === undefined
      ? {}
      : { app_links_available: body.app_links_available === true }),
  }
}

/** Reads the events a reward can be tied to. A name that could not be saved as one is left out. */
export function readRewardEvents(value: unknown): RewardEvent[] {
  const body = record(value)
  if (!body || !Array.isArray(body.events)) throw unreadable()
  const seen = new Set<string>()
  return body.events.flatMap((item) => {
    const row = record(item)
    if (!row || typeof row.name !== 'string' || !REWARD_KEY.test(row.name)) return []
    if (seen.has(row.name)) return []
    seen.add(row.name)
    return [
      {
        name: row.name,
        description: text(row.description),
        first_seen: moment(row.first_seen),
        last_seen: moment(row.last_seen),
        ...(row.suggested_label === undefined
          ? {}
          : { suggested_label: readSuggestedLabel(row.suggested_label) }),
      },
    ]
  })
}

export function readAgreement(value: unknown): Agreement {
  const body = record(value)
  if (!body) throw unreadable()
  const doc = record(body.agreement)
  const sha256 = typeof body.sha256 === 'string' && /^[a-f0-9]{64}$/.test(body.sha256)
  if (body.complete !== true || !doc || !sha256)
    return { agreement: null, sha256: null, complete: false }
  if (typeof doc.title !== 'string' || !Array.isArray(doc.sections)) throw unreadable()
  return {
    complete: true,
    sha256: body.sha256 as string,
    agreement: {
      title: doc.title,
      brand_name: text(doc.brand_name) ?? '',
      program_name: text(doc.program_name) ?? '',
      summary: (Array.isArray(doc.summary) ? doc.summary : []).flatMap((item) => {
        const row = record(item)
        return row && typeof row.label === 'string' && typeof row.value === 'string'
          ? [{ label: row.label, value: row.value }]
          : []
      }),
      sections: doc.sections.flatMap((item) => {
        const row = record(item)
        return row && typeof row.heading === 'string'
          ? [
              {
                heading: row.heading,
                paragraphs: (Array.isArray(row.paragraphs) ? row.paragraphs : []).filter(
                  (line): line is string => typeof line === 'string',
                ),
              },
            ]
          : []
      }),
      extra_terms: text(doc.extra_terms),
    },
  }
}

export function readTracking(value: unknown): Tracking {
  const body = record(value)
  if (!body) throw unreadable()
  return {
    connected: body.connected === true,
    payments_seen: count(body.payments_seen),
    tagged_payments: count(body.tagged_payments),
    sales: count(body.sales),
    matched_sales: count(body.matched_sales),
    last_sale_at: moment(body.last_sale_at),
    last_matched_at: moment(body.last_matched_at),
    last_match_source: text(body.last_match_source),
    sdk_click_seen_at: moment(body.sdk_click_seen_at),
  }
}

// The calls ---------------------------------------------------------------------------------

type RpcFailure = { message?: string; details?: string | null; code?: string }
type Client = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcFailure | null }>
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        file: File,
        options: { contentType: string; upsert: boolean; cacheControl: string },
      ): PromiseLike<{ data: unknown; error: { message?: string } | null }>
      getPublicUrl(path: string): { data: { publicUrl: string } }
    }
  }
}

function offlineCode(): 'offline' | 'unreachable' {
  return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable'
}

/** Postgres error classes that mean something on their own, when no DETAIL code came with them. */
const byErrcode: Record<string, string> = {
  '40001': 'program_changed',
  '42501': 'not_allowed',
  '28000': 'unauthorized',
  P0002: 'not_found',
  PGRST301: 'unauthorized',
  PGRST303: 'unauthorized',
}

/** The database raises its failures with a stable code in DETAIL; that code is what we keep. */
export function readFailure(failure: RpcFailure): ProgramError {
  const detail = typeof failure.details === 'string' ? failure.details.trim() : ''
  if (/^[a-z][a-z0-9_]{2,63}$/.test(detail)) return new ProgramError(detail, failure.message)
  const known = byErrcode[failure.code ?? '']
  if (known) return new ProgramError(known, failure.message)
  // supabase-js reports a request that never got an answer as an error with no code.
  if (!failure.code && /fetch|network|load failed/i.test(failure.message ?? ''))
    return new ProgramError(offlineCode(), failure.message)
  return new ProgramError('unknown', failure.message)
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    response = await (requireSupabaseClient() as unknown as Client).rpc(name, args)
  } catch {
    throw new ProgramError(offlineCode())
  }
  if (response.error) throw readFailure(response.error)
  return response.data
}

const randomName = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

/** Why a file cannot be a logo, or null when it can. Checked before anything is uploaded. */
export function checkLogoFile(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES[file.type]) return 'Choose a PNG, JPG or WebP image.'
  if (file.size > LOGO_MAX_BYTES) return 'That image is larger than 2 MB. Choose a smaller one.'
  if (file.size === 0) return 'That file is empty. Choose another image.'
  return null
}

export const programs = {
  get: async (workspaceId: string) =>
    readState(await call('workspace_program_get', { p_workspace_id: workspaceId })),
  save: async (workspaceId: string, input: ProgramInput & { revision?: number }) =>
    readState(
      await call('workspace_program_save', { p_workspace_id: workspaceId, p_input: input }),
    ),
  agreement: async (workspaceId: string) =>
    readAgreement(await call('workspace_program_agreement', { p_workspace_id: workspaceId })),
  markAgreementRead: async (workspaceId: string, sha256: string) =>
    readState(
      await call('workspace_program_mark_agreement_read', {
        p_workspace_id: workspaceId,
        p_sha256: sha256,
      }),
    ),
  submit: async (workspaceId: string, revision: number) =>
    readState(
      await call('workspace_program_submit', { p_workspace_id: workspaceId, p_revision: revision }),
    ),
  setStatus: async (workspaceId: string, status: 'paused' | 'live', revision: number) =>
    readState(
      await call('workspace_program_set_status', {
        p_workspace_id: workspaceId,
        p_status: status,
        p_revision: revision,
      }),
    ),
  tracking: async (workspaceId: string) =>
    readTracking(await call('workspace_program_tracking', { p_workspace_id: workspaceId })),
  rewardEvents: async (workspaceId: string) =>
    readRewardEvents(
      await call('workspace_program_reward_events', { p_workspace_id: workspaceId }),
    ),
  appLinks: async (workspaceId: string) =>
    readAppLinks(await call('workspace_program_app_links', { p_workspace_id: workspaceId })),
  /** Puts the image in the workspace's folder and returns its path, ready to be saved. */
  uploadLogo: async (workspaceId: string, file: File) => {
    const refusal = checkLogoFile(file)
    if (refusal) throw new ProgramError('logo_rejected', refusal)
    const path = `${workspaceId}/${randomName()}.${LOGO_TYPES[file.type]}`
    let answer
    try {
      answer = await (requireSupabaseClient() as unknown as Client).storage
        .from(LOGO_BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' })
    } catch {
      throw new ProgramError(offlineCode())
    }
    if (answer.error) throw new ProgramError('logo_upload_failed', answer.error.message)
    return path
  },
  logoUrl: (path: string) =>
    (requireSupabaseClient() as unknown as Client).storage.from(LOGO_BUCKET).getPublicUrl(path).data
      .publicUrl,
}

// Numbers as people type them ---------------------------------------------------------------

const tidy = (value: string) => value.replace(/[\s,]/g, '')

/** "30" → 3000, "12.5" → 1250. Null when it is not a percentage from 0.01 to 100. */
export function percentToBps(value: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?%?$/.exec(tidy(value))
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps >= 1 && bps <= 10_000 ? bps : null
}

/** 3000 → "30", 1250 → "12.5" */
export function bpsToPercent(bps: number): string {
  return String(bps / 100)
}

/** "20" → 2000, "$1,250.50" → 125050. Null when it is not an amount of money. */
export function dollarsToMinor(value: string): number | null {
  const match = /^[$€£]?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(tidy(value))
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** 2000 → "20.00", for a field. */
export function minorToDollars(minor: number): string {
  return (minor / 100).toFixed(2)
}

const amountFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 2000 → "$20.00" in US dollars, "20.00 EUR" elsewhere: the same wording the agreement uses. */
export function formatMoney(minor: number, currency: string): string {
  const amount = amountFormat.format(minor / 100)
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}

function days(value: string, low: number, high: number): number | null {
  const trimmed = value.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const number = Number(trimmed)
  return number >= low && number <= high ? number : null
}

// The form ----------------------------------------------------------------------------------

/** What the form holds while it is being edited: text as typed, nothing converted yet. */
export interface ProgramDraft {
  name: string
  category: Category | ''
  tagline: string
  logoPath: string | null
  landingUrl: string
  commissionType: CommissionType
  /** Both amounts are kept, so switching type and back loses nothing. */
  percent: string
  fixed: string
  duration: CommissionDuration
  months: string
  attributionDays: string
  holdDays: string
  minimumPayout: string
  approvalMode: ApprovalMode
  marketplaceListed: boolean
  currency: string
  extraTerms: string
  /**
   * The next three are only in a form that asks what creators earn from (see asksEarnFrom).
   * Left out, the program pays for sales, as every program did before it could pay for events.
   */
  earnFrom?: EarnFrom
  /** Never empty: a list with nothing in it holds one blank row, ready to be filled in. */
  rewards?: RewardRow[]
  budget?: string
}

/** A reward as it is typed: the amount in normal money, nothing converted yet. */
export interface RewardRow {
  key: string
  label: string
  amount: string
}

export type RewardPart = 'key' | 'label' | 'amount'
/** Where a mistake in one reward is shown: the row it is in, and which of its three fields. */
export type RewardField = `reward:${number}:${RewardPart}`
export const rewardField = (index: number, part: RewardPart): RewardField =>
  `reward:${index}:${part}`

type NamedField =
  | 'name'
  | 'category'
  | 'tagline'
  | 'logo'
  | 'landingUrl'
  | 'amount'
  | 'months'
  | 'attributionDays'
  | 'holdDays'
  | 'minimumPayout'
  | 'currency'
  | 'extraTerms'
  | 'earnFrom'
  | 'rewards'
  | 'budget'
export type DraftField = NamedField | RewardField
export type DraftErrors = Partial<Record<DraftField, string>>

/** The fields kept behind "More options". */
export const optionFields: DraftField[] = [
  'months',
  'attributionDays',
  'holdDays',
  'minimumPayout',
  'currency',
  'extraTerms',
]

/**
 * Whether the form asks what creators earn from: when the workspace can pay for events, and
 * for a program that already does, so its form never shows a commission it does not pay.
 */
export function asksEarnFrom(
  state: Pick<ProgramState, 'events_available' | 'program'> | undefined,
): boolean {
  return state?.events_available === true || (state?.program?.earn_from ?? 'sales') !== 'sales'
}

export const blankReward = (): RewardRow => ({ key: '', label: '', amount: '' })

const isBlank = (row: RewardRow) => !row.key.trim() && !row.label.trim() && !row.amount.trim()

/**
 * The form for a saved program, or the defaults a new one starts with. `earning` adds the
 * question of what creators earn from, with the rewards and their budget.
 */
export function draftFromProgram(program: Program | null, earning = false): ProgramDraft {
  const rewards = (program?.rewards ?? []).map((reward) => ({
    key: reward.key,
    label: reward.label,
    amount: minorToDollars(reward.amount_minor),
  }))
  return {
    ...draftWithoutEarning(program),
    ...(earning
      ? {
          earnFrom: program?.earn_from ?? 'sales',
          rewards: rewards.length ? rewards : [blankReward()],
          budget: program?.reward_budget_minor ? minorToDollars(program.reward_budget_minor) : '',
        }
      : {}),
  }
}

function draftWithoutEarning(program: Program | null): ProgramDraft {
  return {
    name: program?.name ?? '',
    category: program?.category ?? '',
    tagline: program?.tagline ?? '',
    logoPath: program?.logo_path ?? null,
    landingUrl: program?.landing_url ?? '',
    commissionType: program?.commission_type ?? 'percent',
    percent: program?.commission_rate_bps ? bpsToPercent(program.commission_rate_bps) : '',
    fixed: program?.commission_fixed_minor ? minorToDollars(program.commission_fixed_minor) : '',
    duration: program?.commission_duration ?? 'months',
    months: String(program?.commission_months ?? 12),
    attributionDays: String(program?.attribution_window_days ?? 30),
    holdDays: String(program?.hold_days ?? 30),
    minimumPayout: minorToDollars(program?.minimum_payout_minor ?? 2000),
    approvalMode: program?.approval_mode ?? 'automatic',
    marketplaceListed: program?.marketplace_listed ?? true,
    currency: program?.currency ?? 'USD',
    extraTerms: program?.extra_terms ?? '',
  }
}

export const fieldMessages: Record<NamedField, string> = {
  name: 'Enter a name up to 120 characters.',
  category: 'Choose a category.',
  tagline: 'Enter a description up to 160 characters.',
  logo: 'That logo could not be used. Upload a PNG, JPG or WebP up to 2 MB.',
  landingUrl: 'Enter a public web address that starts with https://',
  amount: 'Enter a percentage up to 100, like 30.',
  months: 'Enter a number of months from 1 to 36.',
  attributionDays: 'Enter a number of days from 1 to 365.',
  holdDays: 'Enter a number of days from 0 to 90.',
  minimumPayout: 'Enter an amount like 20.00, or 0 for no minimum.',
  currency: 'Choose a currency from the list.',
  extraTerms: 'Keep extra terms under 4,000 characters.',
  earnFrom: 'Choose Sales, Events or Both.',
  rewards: 'Check the rewards. Each needs its own event, its own words for creators and an amount.',
  budget: 'Enter a monthly budget of at least 1.00 that covers your largest reward.',
}
const FIXED_AMOUNT = 'Enter an amount like 20.00.'

/** What is wrong with a reward or the budget, said at the field. */
export const rewardMessages = {
  none: 'Add at least one reward.',
  tooMany: 'A program can have up to five rewards. Remove one.',
  keyMissing: 'Add the event this reward is for.',
  keyInvalid: 'An event name starts with a letter and uses only letters, numbers and _ . : -',
  keyRepeated: 'This event already has a reward.',
  labelMissing: 'Say what creators read, like Account created.',
  labelLong: 'Keep this to 40 characters.',
  labelRepeated: 'Two rewards cannot read the same.',
  amount: 'Enter an amount like 2.00.',
  amountLarge: 'Enter an amount up to 1,000,000.00.',
  budgetMissing: 'Enter a monthly budget.',
  budgetRange: 'Enter an amount from 1.00 to 1,000,000.00.',
  eventsUnavailable: 'Paying for events is not available right now. Choose Sales, or contact us.',
} as const

/** The budget has to pay for at least one of the largest reward. */
export const budgetBelowReward = (largestMinor: number, currency: string) =>
  `The budget must cover your largest reward, ${formatMoney(largestMinor, currency)}.`

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username
  } catch {
    return false
  }
}

function commissionAmount(draft: ProgramDraft): number | null {
  if (draft.commissionType === 'percent') return percentToBps(draft.percent)
  const minor = dollarsToMinor(draft.fixed)
  return minor !== null && minor >= 1 && minor <= 100_000_000 ? minor : null
}

const rewardAmount = (value: string) => {
  const minor = dollarsToMinor(value)
  return minor !== null && minor >= 1 && minor <= REWARD_MAX_MINOR ? minor : null
}

/** "signup_completed" → "Signup completed": a first guess at what creators read. */
export function labelFromEvent(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.:-]+/g, ' ')
    .trim()
    .toLowerCase()
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, REWARD_LABEL_MAX).trim()
}

/** Names the event of a reward. The words follow it until the person writes their own. */
export function withRewardKey(row: RewardRow, key: string): RewardRow {
  const untouched = !row.label.trim() || row.label === labelFromEvent(row.key)
  return { ...row, key, label: untouched ? labelFromEvent(key) : row.label }
}

/** The rewards as the database takes them: every row that is filled in and reads right. */
export function rewardsFromRows(rows: RewardRow[]): Reward[] {
  return rows.flatMap((row) => {
    const key = row.key.trim()
    const label = row.label.trim()
    const amount = rewardAmount(row.amount)
    return REWARD_KEY.test(key) && label && label.length <= REWARD_LABEL_MAX && amount !== null
      ? [{ key, label, amount_minor: amount }]
      : []
  })
}

/**
 * What is wrong with the rewards, by the rules the database checks: five at most, each with
 * an event of its own, words of its own and an amount. A row with nothing in it is not a
 * reward. `required` is for a program creators can already see, which needs at least one.
 */
export function validateRewards(rows: RewardRow[], required = false): DraftErrors {
  const errors: DraftErrors = {}
  const keys = new Set<string>()
  const labels = new Set<string>()
  let filled = 0
  rows.forEach((row, index) => {
    if (isBlank(row)) return
    filled += 1
    const key = row.key.trim()
    const label = row.label.trim()
    if (!key) errors[rewardField(index, 'key')] = rewardMessages.keyMissing
    else if (!REWARD_KEY.test(key)) errors[rewardField(index, 'key')] = rewardMessages.keyInvalid
    else if (keys.has(key)) errors[rewardField(index, 'key')] = rewardMessages.keyRepeated
    keys.add(key)
    if (!label) errors[rewardField(index, 'label')] = rewardMessages.labelMissing
    else if (label.length > REWARD_LABEL_MAX)
      errors[rewardField(index, 'label')] = rewardMessages.labelLong
    else if (labels.has(label.toLowerCase()))
      errors[rewardField(index, 'label')] = rewardMessages.labelRepeated
    labels.add(label.toLowerCase())
    if (rewardAmount(row.amount) === null) {
      const typed = dollarsToMinor(row.amount)
      errors[rewardField(index, 'amount')] =
        typed !== null && typed > REWARD_MAX_MINOR
          ? rewardMessages.amountLarge
          : rewardMessages.amount
    }
  })
  if (filled > MAX_REWARDS) errors.rewards = rewardMessages.tooMany
  else if (required && filled === 0) errors.rewards = rewardMessages.none
  return errors
}

/** What is wrong with the monthly budget, or null. It may be empty until the program is published. */
export function validateBudget(
  budget: string,
  rows: RewardRow[],
  currency: string,
  required = false,
): string | null {
  if (!budget.trim()) return required ? rewardMessages.budgetMissing : null
  const minor = dollarsToMinor(budget)
  if (minor === null || minor < BUDGET_MIN_MINOR || minor > REWARD_MAX_MINOR)
    return rewardMessages.budgetRange
  const largest = Math.max(0, ...rows.map((row) => rewardAmount(row.amount) ?? 0))
  return minor < largest ? budgetBelowReward(largest, currency) : null
}

/**
 * What is wrong with what has been typed. A draft may be unfinished, so an empty field is
 * not a mistake; the options always hold a value, so those must be valid. A program that
 * creators can already see (`published`) cannot have its main fields emptied.
 */
export function validateDraft(draft: ProgramDraft, published = false): DraftErrors {
  const errors: DraftErrors = {}
  const name = draft.name.trim()
  const tagline = draft.tagline.trim()
  const landing = draft.landingUrl.trim()
  if (name.length > 120 || (published && !name)) errors.name = fieldMessages.name
  if (published && !draft.category) errors.category = fieldMessages.category
  if (tagline.length > 160 || (published && !tagline)) errors.tagline = fieldMessages.tagline
  if (landing ? !httpsUrl(landing) : published) errors.landingUrl = fieldMessages.landingUrl
  const earnFrom = draft.earnFrom ?? 'sales'
  // Only what the program pays for is checked: the rest is not on the page and is not sent.
  if (earnFrom !== 'events') {
    const typed = draft.commissionType === 'percent' ? draft.percent : draft.fixed
    if (typed.trim() ? commissionAmount(draft) === null : published)
      errors.amount = draft.commissionType === 'percent' ? fieldMessages.amount : FIXED_AMOUNT
    if (draft.duration === 'months' && days(draft.months, 1, 36) === null)
      errors.months = fieldMessages.months
  }
  if (earnFrom !== 'sales') {
    const rows = draft.rewards ?? []
    Object.assign(errors, validateRewards(rows, published))
    const budget = validateBudget(draft.budget ?? '', rows, draft.currency, published)
    if (budget) errors.budget = budget
  }
  if (days(draft.attributionDays, 1, 365) === null)
    errors.attributionDays = fieldMessages.attributionDays
  if (days(draft.holdDays, 0, 90) === null) errors.holdDays = fieldMessages.holdDays
  const minimum = dollarsToMinor(draft.minimumPayout)
  if (minimum === null || minimum > 100_000_000) errors.minimumPayout = fieldMessages.minimumPayout
  if (draft.extraTerms.trim().length > 4000) errors.extraTerms = fieldMessages.extraTerms
  return errors
}

/** The three checklist items the form itself can answer, before anything is saved. */
export function draftProgress(
  draft: ProgramDraft,
): Pick<Checklist, 'details' | 'landing_page' | 'commission'> {
  const earnFrom = draft.earnFrom ?? 'sales'
  const rows = draft.rewards ?? []
  const commission =
    commissionAmount(draft) !== null &&
    (draft.duration !== 'months' || days(draft.months, 1, 36) !== null)
  // Events need at least one reward, nothing wrong in the list, and a budget.
  const rewards =
    earnFrom !== 'sales' &&
    rewardsFromRows(rows).length > 0 &&
    Object.keys(validateRewards(rows)).length === 0 &&
    validateBudget(draft.budget ?? '', rows, draft.currency, true) === null
  return {
    details: Boolean(draft.name.trim() && draft.category && draft.tagline.trim()),
    landing_page: httpsUrl(draft.landingUrl),
    commission:
      earnFrom === 'sales' ? commission : earnFrom === 'events' ? rewards : commission && rewards,
  }
}

type EarningKey = 'earn_from' | 'rewards' | 'reward_budget_minor'
/** Everything the form holds; what creators earn from only when the form asks it. */
export type DraftInput = Required<Omit<ProgramInput, EarningKey>> & Pick<ProgramInput, EarningKey>

/** The form as the database takes it. Call only for a draft that passes validateDraft. */
export function inputFromDraft(draft: ProgramDraft): DraftInput {
  const amount = commissionAmount(draft)
  const budget = dollarsToMinor(draft.budget ?? '')
  return {
    name: draft.name.trim() || null,
    category: draft.category || null,
    tagline: draft.tagline.trim() || null,
    logo_path: draft.logoPath,
    landing_url: draft.landingUrl.trim() || null,
    // The type and its amount are saved together or not at all.
    commission_type: amount === null ? null : draft.commissionType,
    commission_rate_bps: draft.commissionType === 'percent' ? amount : null,
    commission_fixed_minor: draft.commissionType === 'fixed' ? amount : null,
    currency: draft.currency,
    commission_duration: draft.duration,
    commission_months: draft.duration === 'months' ? days(draft.months, 1, 36) : null,
    attribution_window_days: days(draft.attributionDays, 1, 365) ?? 30,
    hold_days: days(draft.holdDays, 0, 90) ?? 30,
    minimum_payout_minor: dollarsToMinor(draft.minimumPayout) ?? 2000,
    approval_mode: draft.approvalMode,
    marketplace_listed: draft.marketplaceListed,
    extra_terms: draft.extraTerms.trim() || null,
    ...(draft.earnFrom === undefined
      ? {}
      : {
          earn_from: draft.earnFrom,
          rewards: rewardsFromRows(draft.rewards ?? []),
          reward_budget_minor:
            budget !== null && budget >= BUDGET_MIN_MINOR && budget <= REWARD_MAX_MINOR
              ? budget
              : null,
        }),
  }
}

/** Fields the database checks against each other, so one never travels without the rest. */
const sentTogether = [
  ['commission_type', 'commission_rate_bps', 'commission_fixed_minor'],
  ['commission_duration', 'commission_months'],
]

/** What a program pays for does not use the other half of the form, which stays as it was saved. */
const unusedKeys: Record<EarnFrom, string[]> = {
  sales: ['rewards', 'reward_budget_minor'],
  events: sentTogether.flat(),
  both: [],
}

/** What a program has before anything is saved, where that is not simply nothing. */
const unsaved: Record<string, unknown> = { earn_from: 'sales', rewards: [] }

const sameValue = (a: unknown, b: unknown) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b))

/**
 * Only what differs from the saved program is sent, with its revision; a new program sends
 * everything it has a value for.
 */
export function changedInput(
  draft: ProgramDraft,
  program: Program | null,
): ProgramInput & { revision?: number } {
  const next = inputFromDraft(draft) as Record<string, unknown>
  for (const key of unusedKeys[draft.earnFrom ?? 'sales']) delete next[key]
  const saved = program as unknown as Record<string, unknown> | null
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(next)) {
    // A program saved before it could pay for events pays for sales and has no rewards.
    const before = saved?.[key] ?? unsaved[key] ?? null
    if (!sameValue(next[key], before)) changed[key] = next[key]
  }
  for (const group of sentTogether) {
    if (group.some((key) => key in changed)) for (const key of group) changed[key] = next[key]
  }
  return program ? { ...changed, revision: program.revision } : changed
}

/** The agreement can be written once it knows the name, the landing page and the commission. */
export function agreementReady(draft: ProgramDraft): boolean {
  const progress = draftProgress(draft)
  return Boolean(draft.name.trim()) && progress.landing_page && progress.commission
}

/** Whether saving would change what creators agree to, so the agreement must be read again. */
export function changesAgreement(draft: ProgramDraft, program: Program | null): boolean {
  const changed = changedInput(draft, program)
  return [
    'name',
    'landing_url',
    'commission_type',
    'commission_rate_bps',
    'commission_fixed_minor',
    'currency',
    'commission_duration',
    'commission_months',
    'attribution_window_days',
    'hold_days',
    'minimum_payout_minor',
    'approval_mode',
    'extra_terms',
    // The budget is not here: it is the business's own limit, not something creators agree to.
    'earn_from',
    'rewards',
  ].some((key) => key in changed)
}

// The words on the page ---------------------------------------------------------------------

export interface CommissionTerms {
  commission_type: CommissionType | null
  commission_rate_bps: number | null
  commission_fixed_minor: number | null
  currency: string
  commission_duration: CommissionDuration | null
  commission_months: number | null
}

/** "30% of every payment for 12 months": what a creator reads on the card. Null until set. */
export function commissionHeadline(terms: CommissionTerms): string | null {
  const { commission_type: type, commission_duration: duration } = terms
  if (!type || !duration) return null
  let amount: string
  if (type === 'percent') {
    if (!terms.commission_rate_bps) return null
    amount = `${bpsToPercent(terms.commission_rate_bps)}%`
  } else {
    if (!terms.commission_fixed_minor) return null
    amount = formatMoney(terms.commission_fixed_minor, terms.currency)
  }
  const join = type === 'percent' ? 'of' : 'on'
  if (duration === 'first_payment') return `${amount} ${join} the first payment`
  if (duration === 'lifetime') return `${amount} ${join} every payment`
  const months = terms.commission_months
  if (!months) return null
  return `${amount} ${join} every payment for ${months} ${months === 1 ? 'month' : 'months'}`
}

const EXAMPLE_SALE_MINOR = 5000

/** One worked example under the commission fields. Null until an amount is typed. */
export function commissionExample(terms: CommissionTerms): string | null {
  if (terms.commission_type === 'percent' && terms.commission_rate_bps) {
    const earned = Math.round((EXAMPLE_SALE_MINOR * terms.commission_rate_bps) / 10_000)
    return `On a ${formatMoney(EXAMPLE_SALE_MINOR, terms.currency)} sale a creator earns ${formatMoney(earned, terms.currency)}.`
  }
  if (terms.commission_type === 'fixed' && terms.commission_fixed_minor)
    return `A creator earns ${formatMoney(terms.commission_fixed_minor, terms.currency)} on a sale of any size.`
  return null
}

/** The commission as the form currently has it, for the preview and the example. */
export function draftTerms(draft: ProgramDraft): CommissionTerms {
  const input = inputFromDraft(draft)
  return {
    commission_type: input.commission_type,
    commission_rate_bps: input.commission_rate_bps,
    commission_fixed_minor: input.commission_fixed_minor,
    currency: input.currency,
    commission_duration: input.commission_duration,
    commission_months: input.commission_months,
  }
}

/** What a program pays: its commission, and its rewards when it pays for events. */
export interface EarnTerms extends CommissionTerms {
  earn_from: EarnFrom
  rewards: Reward[]
}

/** "$2.00 per Account created": one reward as a creator reads it. */
export function rewardLine(reward: Reward, currency: string): string {
  return `${formatMoney(reward.amount_minor, currency)} per ${reward.label}`
}

/**
 * The one line that says what a creator earns, worded as the database words it for the card
 * and the agreement: the commission for sales ("30% of every payment"), every reward for
 * events ("$2.00 per Account created, $5.00 per Trial started"), and for both the commission
 * with "plus rewards". Null until there is something to say.
 */
export function earnHeadline(terms: EarnTerms): string | null {
  if (terms.earn_from === 'sales') return commissionHeadline(terms)
  const rewards = terms.rewards
  if (terms.earn_from === 'events')
    return rewards.length
      ? rewards.map((reward) => rewardLine(reward, terms.currency)).join(', ')
      : null
  const commission = commissionHeadline(terms)
  if (!commission) return null
  // A program that pays for both always has a reward once it is complete; until then the
  // line does not promise one.
  return rewards.length ? `${commission}, plus rewards` : commission
}

/** What the form currently says creators earn, for the preview. */
export function draftEarning(draft: ProgramDraft): EarnTerms {
  const earnFrom = draft.earnFrom ?? 'sales'
  const terms = draftTerms(draft)
  return {
    ...terms,
    // A program that pays for events only has no commission, whatever was typed before.
    ...(earnFrom === 'events'
      ? {
          commission_type: null,
          commission_rate_bps: null,
          commission_fixed_minor: null,
          commission_duration: null,
          commission_months: null,
        }
      : {}),
    earn_from: earnFrom,
    rewards: earnFrom === 'sales' ? [] : rewardsFromRows(draft.rewards ?? []),
  }
}

/** The checklist step for what creators earn, in the words of what the program pays for. */
export const earningStep: Record<EarnFrom, { done: string; todo: string; blank: string }> = {
  sales: { done: 'Commission set', todo: 'Set a commission', blank: 'Your commission' },
  events: { done: 'Rewards set', todo: 'Set rewards and a budget', blank: 'Your rewards' },
  both: {
    done: 'Commission and rewards set',
    todo: 'Set a commission, rewards and a budget',
    blank: 'Your commission and rewards',
  },
}

/** One line under the question, saying what the chosen answer means. */
export const earnFromAbout: Record<EarnFrom, string> = {
  sales: "A commission on each sale that comes through a creator's link.",
  events:
    'A fixed reward when someone a creator sent does something on your site, like signing up.',
  both: 'A commission on each sale, and a fixed reward for each event you list.',
}

/** The one line "More options" shows while closed. */
export function optionsSummary(draft: ProgramDraft): string[] {
  const input = inputFromDraft(draft)
  return [
    `${input.attribution_window_days}-day attribution`,
    input.hold_days === 0 ? 'No hold' : `${input.hold_days}-day hold`,
    input.minimum_payout_minor === 0
      ? 'No minimum payout'
      : `${formatMoney(input.minimum_payout_minor, input.currency)} minimum payout`,
    input.approval_mode === 'automatic'
      ? 'Creators approved automatically'
      : 'You approve each creator',
    input.marketplace_listed ? 'Listed in the marketplace' : 'Not listed in the marketplace',
    ...(input.currency === 'USD' ? [] : [`Paid in ${input.currency}`]),
    ...(input.extra_terms ? ['Extra terms added'] : []),
  ]
}

export type TrackingTone = 'off' | 'waiting' | 'warning' | 'on'

const counted = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count.toLocaleString('en-US')} ${many}`

/**
 * Where sale tracking stands, in one line. `sales` is the true number of sales once there is
 * one; until then the payments Stripe has reported stand in for it.
 */
export function trackingLine(
  tracking: Tracking,
  now: number,
): { tone: TrackingTone; text: string } {
  if (!tracking.connected) return { tone: 'off', text: 'Connect Stripe to start tracking sales.' }
  const seen =
    tracking.sales > 0
      ? counted(tracking.sales, 'sale', 'sales')
      : counted(tracking.payments_seen, 'payment', 'payments')
  if (tracking.sales === 0 && tracking.payments_seen === 0)
    return { tone: 'waiting', text: 'Waiting for your first payment.' }
  if (tracking.matched_sales === 0 && tracking.tagged_payments === 0)
    return { tone: 'warning', text: `${seen} seen, none tagged yet.` }
  if (tracking.last_matched_at)
    return {
      tone: 'on',
      text: `Last tagged sale ${formatAgo(tracking.last_matched_at, Math.max(now, Date.parse(tracking.last_matched_at)))}`,
    }
  // Tagged, but not yet tied to a creator's click: say how many, not when.
  return {
    tone: 'on',
    text:
      tracking.matched_sales > 0
        ? `${counted(tracking.matched_sales, 'tagged sale', 'tagged sales')} so far.`
        : `${counted(tracking.tagged_payments, 'tagged payment', 'tagged payments')} seen so far.`,
  }
}

/**
 * The snippet a developer adds. Two steps, because the click ID lives in the visitor's
 * browser and the Stripe payment is created on the server.
 */
export const trackingSnippet = `// 1. In the browser
const clickId = kma.getClickId()

// 2. On your server, in the Stripe call
metadata: { kma_click: clickId }`

export const trackingSnippetNote =
  'Send clickId with your checkout request. Works for PaymentIntents and Checkout Sessions.'

// What each failure means, in words a business owner can act on ----------------------------

/** What the person was doing when a request failed. */
export type ProgramStep = 'load' | 'save' | 'agreement' | 'read' | 'publish' | 'status' | 'logo'

/**
 * How the person gets past a problem: try the same thing again, connect Stripe, add funds to
 * the balance, sign in again, or nothing they can do alone. `reload` means the page has
 * fetched the latest copy.
 */
export type ProgramRecovery = 'retry' | 'reload' | 'connections' | 'balance' | 'sign-in' | 'none'

export interface ProgramProblem {
  code: string
  message: string
  recovery: ProgramRecovery
  /** Set when the problem belongs to one field of the form. */
  field?: DraftField
}

const invalidFields: Record<string, NamedField> = {
  invalid_name: 'name',
  invalid_category: 'category',
  invalid_tagline: 'tagline',
  invalid_logo_path: 'logo',
  invalid_landing_url: 'landingUrl',
  invalid_commission_type: 'amount',
  invalid_commission_rate_bps: 'amount',
  invalid_commission_fixed_minor: 'amount',
  invalid_commission_months: 'months',
  invalid_attribution_window_days: 'attributionDays',
  invalid_hold_days: 'holdDays',
  invalid_minimum_payout_minor: 'minimumPayout',
  invalid_currency: 'currency',
  invalid_extra_terms: 'extraTerms',
  invalid_earn_from: 'earnFrom',
  invalid_rewards: 'rewards',
  invalid_reward_budget_minor: 'budget',
}

/** What is missing before publishing, for a program that pays for more than sales. */
const incompleteMessages: Record<EarnFrom, string | null> = {
  sales: null,
  events: 'Fill in the product, landing page, rewards and budget before you publish.',
  both: 'Fill in the product, landing page, commission, rewards and budget before you publish.',
}

export const problemMessages: Record<string, Omit<ProgramProblem, 'code'>> = {
  program_changed: {
    message: 'This program was changed somewhere else. You are now seeing the latest version.',
    recovery: 'reload',
  },
  invalid_revision: {
    message: 'This program was changed somewhere else. You are now seeing the latest version.',
    recovery: 'reload',
  },
  program_not_found: {
    message: 'This program could not be found. You are now seeing what is saved.',
    recovery: 'reload',
  },
  invalid_input: {
    message: 'Those changes could not be saved as they are. Check the form and try again.',
    recovery: 'none',
  },
  program_in_review: {
    message: 'Your listing is being reviewed, so it cannot be changed right now.',
    recovery: 'reload',
  },
  program_incomplete: {
    message: 'Fill in the product, landing page and commission before you publish.',
    recovery: 'none',
  },
  stripe_not_connected: {
    message: 'Connect Stripe first, so sales can be tracked.',
    recovery: 'connections',
  },
  balance_required: {
    message: 'Add funds before you publish.',
    recovery: 'balance',
  },
  agreement_not_read: {
    message: 'The agreement has changed. Read it again before you publish.',
    recovery: 'none',
  },
  program_paused_by_admin: {
    message: 'KissMyApps paused this program, so it cannot be resumed from here. Contact us.',
    recovery: 'none',
  },
  nothing_to_publish: {
    message: 'There is nothing new to publish.',
    recovery: 'reload',
  },
  status_not_allowed: {
    message: 'That is not possible while the program is in this state.',
    recovery: 'reload',
  },
  invalid_status: {
    message: 'That is not possible while the program is in this state.',
    recovery: 'reload',
  },
  not_allowed: {
    message: 'Only an owner or admin can change the program. Ask one of them to do this.',
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
  logo_upload_failed: {
    message: 'The logo could not be uploaded. Try again.',
    recovery: 'none',
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
export const fallbackMessages: Record<ProgramStep, string> = {
  load: 'Your program could not be loaded. Try again.',
  save: 'Your changes were not saved. Try again.',
  agreement: 'The agreement could not be opened. Try again.',
  read: 'That was not recorded. Try again.',
  publish: 'The program was not published. Try again.',
  status: 'The program was not changed. Try again.',
  logo: 'The logo could not be uploaded. Try again.',
}

export function describeProblem(
  problem: unknown,
  step: ProgramStep,
  earnFrom: EarnFrom = 'sales',
): ProgramProblem {
  const code = problem instanceof ProgramError ? problem.code : 'unknown'
  // The browser's own refusal of a file already says what to choose instead.
  if (problem instanceof ProgramError && code === 'logo_rejected')
    return { code, message: problem.message, recovery: 'none', field: 'logo' }
  const field = invalidFields[code]
  if (field)
    return {
      code,
      message: code === 'invalid_commission_fixed_minor' ? FIXED_AMOUNT : fieldMessages[field],
      recovery: 'none',
      field,
    }
  // The answer to "what do creators earn from" is the one thing the person can change about it.
  if (code === 'events_unavailable')
    return { code, message: rewardMessages.eventsUnavailable, recovery: 'none', field: 'earnFrom' }
  const incomplete = code === 'program_incomplete' ? incompleteMessages[earnFrom] : null
  if (incomplete) return { code, message: incomplete, recovery: 'none' }
  // A paused program is resumed, not published: the same refusal, said for what was pressed.
  if (code === 'balance_required' && step === 'status')
    return { code, message: 'Add funds before you resume.', recovery: 'balance' }
  const known = problemMessages[code]
  if (known) return { code, ...known, ...(step === 'logo' ? { field: 'logo' as const } : {}) }
  return {
    code,
    message: fallbackMessages[step],
    recovery: step === 'logo' ? 'none' : 'retry',
    ...(step === 'logo' ? { field: 'logo' as const } : {}),
  }
}

/** SpeakSix → SS: the mark shown until a logo is uploaded. */
export function initials(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+|(?<=[a-z])(?=[A-Z0-9])/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/** 14 Nov 2026 */
export function formatDay(time: string): string {
  return dayFormat.format(Date.parse(time))
}

// Programs that send people to an app (Phase 7) ---------------------------------------------

/** A saved program's landing page, when it is a smart link of one of the workspace's apps. */
export interface ProgramAppLink {
  /** The link's id, which names it in the list of links. */
  id: string | null
  url: string
  name: string
}

/** A smart link of one of the workspace's apps, one a program's landing page can be. */
export interface AppLink {
  /** The link's id; its address when an answer has none. */
  id: string
  url: string
  name: string
  project_id: string
  project_name: string
  /** Whether the link's app is on iPhone, on Android, or both. */
  ios: boolean
  android: boolean
}

/** Where creator links send people: a web page, or the app through one of its smart links. */
export type LandingKind = 'web' | 'app'

/** https://fluent.go.kissmyapps.dev/start → fluent.go.kissmyapps.dev/start */
export function linkAddress(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '')
}

/**
 * The app link of a saved program. Nothing depends on it but how the form opens, so one that
 * cannot be read is no link at all rather than a refused answer.
 */
function readProgramAppLink(row: Record<string, unknown>): Pick<Program, 'app_link'> {
  if (row.app_link === undefined) return {}
  const link = record(row.app_link)
  const url = text(link?.url)
  if (!link || !url || !httpsUrl(url)) return { app_link: null }
  return {
    app_link: { id: text(link.id), url, name: text(link.name)?.trim() || linkAddress(url) },
  }
}

function readSuggestedLabel(value: unknown): string | null {
  const label = typeof value === 'string' ? value.trim() : ''
  return label && label.length <= REWARD_LABEL_MAX ? label : null
}

/** Reads the smart links a program can send people to. A link that is not a web address is left out. */
export function readAppLinks(value: unknown): AppLink[] {
  const body = record(value)
  if (!body || !Array.isArray(body.links)) throw unreadable()
  const seen = new Set<string>()
  return body.links.flatMap((item) => {
    const row = record(item)
    const url = text(row?.url)
    if (!row || !url || !httpsUrl(url) || seen.has(url)) return []
    seen.add(url)
    return [
      {
        id: text(row.id) ?? url,
        url,
        name: text(row.name)?.trim() || linkAddress(url),
        project_id: text(row.project_id) ?? '',
        project_name: text(row.project_name) ?? '',
        ios: row.ios === true,
        android: row.android === true,
      },
    ]
  })
}

/**
 * Whether the form asks where creator links send people: when the workspace has app links, and
 * for a program whose landing page already is one, so its form shows the link it has.
 */
export function offersAppLanding(
  state: Pick<ProgramState, 'app_links_available' | 'program'> | undefined,
): boolean {
  return state?.app_links_available === true || Boolean(state?.program?.app_link)
}

/** Whether a saved program's link is this one of the list: by id, or by address without one. */
export function isAppLink(saved: ProgramAppLink, link: AppLink): boolean {
  return saved.id ? link.id === saved.id : link.url === saved.url
}

/** What a saved program's landing page is. */
export const landingKindOf = (program: Program | null | undefined): LandingKind =>
  program?.app_link ? 'app' : 'web'

/** The platforms of a link's app, in words: "iOS and Android", "iOS", "Android", or null. */
export function appPlatforms(link: Pick<AppLink, 'ios' | 'android'>): string | null {
  if (link.ios && link.android) return 'iOS and Android'
  return link.ios ? 'iOS' : link.android ? 'Android' : null
}

/** The install event, which SDK 1.1 matches to the creator's click. */
export const INSTALL_EVENT = 'app_installed'

/** How the reward picker names an event: the install in words, every other event by its name. */
export function rewardEventChoice(name: string): string {
  return name === INSTALL_EVENT ? 'App installed (install)' : name
}

/** The words a reward starts with for an event: KissMyApps' suggestion, else the event's name. */
export function suggestedRewardLabel(name: string, events: readonly RewardEvent[] = []): string {
  return events.find((event) => event.name === name)?.suggested_label || labelFromEvent(name)
}

/**
 * Names the event of a reward, with the suggested words for it. As with withRewardKey, the words
 * follow the event until the person writes their own.
 */
export function withRewardEvent(
  row: RewardRow,
  key: string,
  events: readonly RewardEvent[] = [],
): RewardRow {
  const label = row.label.trim()
  const untouched =
    !label ||
    row.label === labelFromEvent(row.key) ||
    row.label === suggestedRewardLabel(row.key, events)
  return { ...row, key, label: untouched ? suggestedRewardLabel(key, events) : row.label }
}
