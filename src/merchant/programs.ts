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
  }
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
}

export type DraftField =
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

/** The form for a saved program, or the defaults a new one starts with. */
export function draftFromProgram(program: Program | null): ProgramDraft {
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

export const fieldMessages: Record<DraftField, string> = {
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
}
const FIXED_AMOUNT = 'Enter an amount like 20.00.'

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
  const typed = draft.commissionType === 'percent' ? draft.percent : draft.fixed
  if (typed.trim() ? commissionAmount(draft) === null : published)
    errors.amount = draft.commissionType === 'percent' ? fieldMessages.amount : FIXED_AMOUNT
  if (draft.duration === 'months' && days(draft.months, 1, 36) === null)
    errors.months = fieldMessages.months
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
  return {
    details: Boolean(draft.name.trim() && draft.category && draft.tagline.trim()),
    landing_page: httpsUrl(draft.landingUrl),
    commission:
      commissionAmount(draft) !== null &&
      (draft.duration !== 'months' || days(draft.months, 1, 36) !== null),
  }
}

/** The form as the database takes it. Call only for a draft that passes validateDraft. */
export function inputFromDraft(draft: ProgramDraft): Required<ProgramInput> {
  const amount = commissionAmount(draft)
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
  }
}

/** Fields the database checks against each other, so one never travels without the rest. */
const sentTogether = [
  ['commission_type', 'commission_rate_bps', 'commission_fixed_minor'],
  ['commission_duration', 'commission_months'],
]

/**
 * Only what differs from the saved program is sent, with its revision; a new program sends
 * everything it has a value for.
 */
export function changedInput(
  draft: ProgramDraft,
  program: Program | null,
): ProgramInput & { revision?: number } {
  const next = inputFromDraft(draft) as Record<string, unknown>
  const saved = program as unknown as Record<string, unknown> | null
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(next)) {
    if (saved ? next[key] !== saved[key] : next[key] !== null) changed[key] = next[key]
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

const invalidFields: Record<string, DraftField> = {
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

export function describeProblem(problem: unknown, step: ProgramStep): ProgramProblem {
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
