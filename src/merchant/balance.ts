import { requireSupabaseClient } from '../lib/supabase'
import { bpsToPercent, dollarsToMinor, minorToDollars, ProgramError, readFailure } from './programs'
import type { ProgramStatus } from './programs'

/**
 * The prepaid balance creators are paid from: the calls to the two `workspace_program_balance*`
 * database functions and the `program-balance` function, what their errors mean to a business
 * owner, and the arithmetic and wording the page is built from. Every backend shape is read in
 * this file only. Money arrives in minor units and is only ever shown in normal units.
 */

const FUNCTION = 'program-balance'

/** Stripe's hosted payment page: the only place the browser is ever sent with an answer. */
export const CHECKOUT_ORIGIN = 'https://checkout.stripe.com/'

/** The smallest deposit after the first one, and the smallest automatic top-up. */
export const MIN_TOPUP_MINOR = 1_000
/** The largest single deposit or top-up. */
export const MAX_AMOUNT_MINOR = 100_000_000
/** What a first deposit and a top-up start at when nothing else is known. */
export const DEFAULT_TOPUP_MINOR = 10_000
const DEFAULT_MIN_DEPOSIT_MINOR = 5_000

export type EntryKind =
  | 'deposit'
  | 'deposit_reversed'
  | 'commission_reserved'
  | 'commission_returned'
  | 'fee_reserved'
  | 'fee_returned'
  | 'withdrawal'
  | 'adjustment'
  /** A kind this page has no words for yet: still money that moved, so it is still shown. */
  | 'other'

export interface BalanceEntry {
  id: string
  kind: EntryKind
  /** Signed: money in is positive, money set aside or taken out is negative. */
  amount_minor: number
  available_after_minor: number | null
  created_at: string | null
  creator_name: string | null
  sale_amount_minor: number | null
  topup_kind: 'deposit' | 'auto' | null
  note: string | null
  /** Set when the line is about a reward for an event: what creators read as its name. */
  reward_label?: string
}

export interface BalanceCard {
  brand: string
  last4: string
  exp_month: number | null
  exp_year: number | null
}

export interface TopupProblem {
  code: string
  failed_at: string | null
  retry_at: string | null
}

/** Set while the day's limit on automatic charges is holding the next top-up back. */
export interface TopupLimit {
  per_day: number
  resumes_at: string | null
}

export interface BalanceAccount {
  currency: string
  available_minor: number
  reserved_minor: number
  creators_pending_minor: number
  creators_approved_minor: number
  fees_minor: number
  deposited_minor: number
  card: BalanceCard | null
  auto_topup: boolean
  min_balance_minor: number
  topup_amount_minor: number
  topup_problem: TopupProblem | null
  topup_limit: TopupLimit | null
}

export interface BalanceProgram {
  id: string
  name: string | null
  status: Exclude<ProgramStatus, 'archived'>
  pause_reason: string | null
  currency: string
}

export interface PendingTopup {
  id: string
  amount_minor: number
  status: 'pending' | 'processing'
  created_at: string | null
}

export interface BalanceState {
  enabled: boolean
  can_manage: boolean
  program: BalanceProgram | null
  account: BalanceAccount | null
  min_deposit_minor: number
  /** The KissMyApps fee on top of each commission, or null when the answer did not say. */
  fee_bps: number | null
  activity: BalanceEntry[]
  pending_topup: PendingTopup | null
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
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null
const moment = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
const currencyCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null

const PROGRAM_STATUSES: ReadonlyArray<BalanceProgram['status']> = [
  'draft',
  'in_review',
  'changes_requested',
  'live',
  'paused',
]
const ENTRY_KINDS: ReadonlyArray<Exclude<EntryKind, 'other'>> = [
  'deposit',
  'deposit_reversed',
  'commission_reserved',
  'commission_returned',
  'fee_reserved',
  'fee_returned',
  'withdrawal',
  'adjustment',
]

function programFrom(value: unknown): BalanceProgram | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row || typeof row.id !== 'string' || !row.id) throw unreadable()
  // An archived program is history: the workspace has no program to fund.
  if (row.status === 'archived') return null
  const status = PROGRAM_STATUSES.find((item) => item === row.status)
  if (!status) throw unreadable()
  return {
    id: row.id,
    name: text(row.name),
    status,
    pause_reason: text(row.pause_reason),
    currency: currencyCode(row.currency) ?? 'USD',
  }
}

function cardFrom(value: unknown): BalanceCard | null {
  const row = record(value)
  if (!row || typeof row.last4 !== 'string' || !/^\d{4}$/.test(row.last4)) return null
  const month = minor(row.exp_month)
  const year = minor(row.exp_year)
  return {
    brand: text(row.brand)?.toLowerCase() ?? 'card',
    last4: row.last4,
    exp_month: month !== null && month >= 1 && month <= 12 ? month : null,
    exp_year: year !== null && year >= 2000 && year <= 2200 ? year : null,
  }
}

function topupLimitFrom(value: unknown): TopupLimit | null {
  const row = record(value)
  const perDay = minor(row?.per_day)
  if (!row || perDay === null || perDay < 1) return null
  return { per_day: perDay, resumes_at: moment(row.resumes_at) }
}

function topupProblemFrom(value: unknown): TopupProblem | null {
  const row = record(value)
  if (!row) return null
  return {
    code: text(row.code) ?? 'unknown',
    failed_at: moment(row.failed_at),
    retry_at: moment(row.retry_at),
  }
}

function accountFrom(value: unknown, programCurrency: string | undefined): BalanceAccount | null {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row) throw unreadable()
  const available = minor(row.available_minor)
  const reserved = minor(row.reserved_minor)
  const pending = minor(row.creators_pending_minor)
  const approved = minor(row.creators_approved_minor)
  const fees = minor(row.fees_minor)
  const deposited = minor(row.deposited_minor)
  const floor = minor(row.min_balance_minor)
  const topup = minor(row.topup_amount_minor)
  // An amount of money that cannot be read is never shown as zero: the page says it cannot load.
  if (
    available === null ||
    reserved === null ||
    pending === null ||
    approved === null ||
    fees === null ||
    deposited === null ||
    floor === null ||
    topup === null
  )
    throw unreadable()
  return {
    currency: currencyCode(row.currency) ?? programCurrency ?? 'USD',
    available_minor: available,
    reserved_minor: reserved,
    creators_pending_minor: pending,
    creators_approved_minor: approved,
    fees_minor: fees,
    deposited_minor: deposited,
    card: cardFrom(row.card),
    auto_topup: row.auto_topup === true,
    min_balance_minor: floor,
    topup_amount_minor: topup,
    topup_problem: topupProblemFrom(row.topup_problem),
    topup_limit: topupLimitFrom(row.topup_limit),
  }
}

/** One line of the ledger as the database sends it, or null when the row cannot be trusted. */
function entryFrom(value: unknown): BalanceEntry | null {
  const row = record(value)
  const amount = minor(row?.amount_minor)
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.kind !== 'string') return null
  if (amount === null) return null
  const reward = text(row.reward_label)
  return {
    id: row.id,
    kind: ENTRY_KINDS.find((item) => item === row.kind) ?? 'other',
    amount_minor: amount,
    available_after_minor: minor(row.available_after_minor),
    created_at: moment(row.created_at),
    creator_name: text(row.creator_name),
    sale_amount_minor: minor(row.sale_amount_minor),
    topup_kind:
      row.topup_kind === 'auto' ? 'auto' : row.topup_kind === 'deposit' ? 'deposit' : null,
    note: text(row.note),
    // A line about a sale, and every line from before rewards existed, carries none.
    ...(reward ? { reward_label: reward } : {}),
  }
}

function pendingFrom(value: unknown): PendingTopup | null {
  const row = record(value)
  const amount = minor(row?.amount_minor)
  if (!row || typeof row.id !== 'string' || amount === null || amount <= 0) return null
  if (row.status !== 'pending' && row.status !== 'processing') return null
  return {
    id: row.id,
    amount_minor: amount,
    status: row.status,
    created_at: moment(row.created_at),
  }
}

/** Reads a `workspace_program_balance` answer, refusing one that cannot draw the page. */
export function readBalance(value: unknown): BalanceState {
  const body = record(value)
  if (!body || typeof body.enabled !== 'boolean') throw unreadable()
  const deposit = minor(body.min_deposit_minor)
  const fee = minor(body.fee_bps)
  const shared = {
    min_deposit_minor: deposit !== null && deposit > 0 ? deposit : DEFAULT_MIN_DEPOSIT_MINOR,
    fee_bps: fee !== null && fee >= 0 && fee <= 10_000 ? fee : null,
  }
  // Switched off, there is nothing to draw and nothing to refuse.
  if (!body.enabled)
    return {
      enabled: false,
      can_manage: body.can_manage === true,
      program: null,
      account: null,
      activity: [],
      pending_topup: null,
      ...shared,
    }
  if (typeof body.can_manage !== 'boolean') throw unreadable()
  const program = programFrom(body.program)
  return {
    enabled: true,
    can_manage: body.can_manage,
    program,
    account: program ? accountFrom(body.account, program.currency) : null,
    activity: (Array.isArray(body.activity) ? body.activity : []).flatMap(
      (item) => entryFrom(item) ?? [],
    ),
    pending_topup: pendingFrom(body.pending_topup),
    ...shared,
  }
}

/** Only Stripe's own payment page may be opened with the answer to `deposit` or `card`. */
export function readCheckoutUrl(value: unknown): string {
  const address = record(value)?.checkout_url
  if (typeof address === 'string' && address.startsWith(CHECKOUT_ORIGIN)) {
    try {
      const url = new URL(address)
      if (
        url.protocol === 'https:' &&
        url.hostname === 'checkout.stripe.com' &&
        !url.port &&
        !url.username &&
        !url.password
      )
        return address
    } catch {
      /* Refused below. */
    }
  }
  throw unreadable()
}

// The calls ---------------------------------------------------------------------------------

/** A refusal from the `program-balance` function: its code, and the HTTP status it came with. */
export class BalanceError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message = '', status?: number) {
    super(message || code)
    this.name = 'BalanceError'
    this.code = code
    this.status = status
  }
}

type Client = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown
    error: { message?: string; details?: string | null; code?: string } | null
  }>
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): PromiseLike<{ data: unknown; error: { context?: unknown } | null }>
  }
}

function offlineCode(): 'offline' | 'unreachable' {
  return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable'
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

async function request(body: Record<string, unknown>): Promise<unknown> {
  let response
  try {
    const client = requireSupabaseClient() as unknown as Client
    response = await client.functions.invoke(FUNCTION, { body })
  } catch {
    throw new BalanceError(offlineCode())
  }
  if (!response.error) return response.data
  const answer = response.error.context
  // Without an HTTP answer the request never arrived, or its answer never came back.
  if (!(answer instanceof Response)) throw new BalanceError(offlineCode())
  let failure: Record<string, unknown> = {}
  try {
    failure = record(await answer.clone().json()) ?? {}
  } catch {
    /* The status alone decides the message. */
  }
  // The repo's functions answer errors as { error: code, message, request_id }.
  throw new BalanceError(
    typeof failure.error === 'string' && failure.error ? failure.error : `http_${answer.status}`,
    typeof failure.message === 'string' ? failure.message : '',
    answer.status,
  )
}

export interface SettingsInput {
  auto_topup?: boolean
  min_balance_minor?: number
  topup_amount_minor?: number
}

export const balance = {
  get: async (workspaceId: string) =>
    readBalance(await call('workspace_program_balance', { p_workspace_id: workspaceId })),
  saveSettings: async (workspaceId: string, input: SettingsInput) =>
    readBalance(
      await call('workspace_program_balance_settings', {
        p_workspace_id: workspaceId,
        p_input: input,
      }),
    ),
  /** Stripe's payment page for a deposit of this amount. Nothing is charged until it is paid there. */
  deposit: async (workspaceId: string, amountMinor: number) =>
    readCheckoutUrl(
      await request({ action: 'deposit', workspace_id: workspaceId, amount_minor: amountMinor }),
    ),
  /** Stripe's page for replacing the saved card. */
  changeCard: async (workspaceId: string) =>
    readCheckoutUrl(await request({ action: 'card', workspace_id: workspaceId })),
}

// Money as it is shown ----------------------------------------------------------------------

const amountFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const MINUS = '−'

/** 8236 → "$82.36", -500 → "−$5.00", 1500 in euros → "15.00 EUR". Never minor units. */
export function formatAmount(amountMinor: number, currency: string): string {
  const figure = amountFormat.format(Math.abs(amountMinor) / 100)
  const sign = amountMinor < 0 ? MINUS : ''
  return currency === 'USD' ? `${sign}$${figure}` : `${sign}${figure} ${currency}`
}

/** A movement of money: "+$100.00" in, "−$14.70" out. */
export function formatMovement(amountMinor: number, currency: string): string {
  return `${amountMinor > 0 ? '+' : ''}${formatAmount(amountMinor, currency)}`
}

/** 1000 → "10%", 1250 → "12.5%". Null when the fee is not known. */
export function feePercent(feeBps: number | null): string | null {
  return feeBps === null ? null : `${bpsToPercent(feeBps)}%`
}

const shortDayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/** 15 Nov, in the reader's own time. */
export function formatShortDay(time: string): string {
  return shortDayFormat.format(Date.parse(time))
}

const dayTimeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

/** 14:30 on 15 Nov, in the reader's own time. */
export function formatDayAndTime(time: string): string {
  return `${dayTimeFormat.format(Date.parse(time))} on ${formatShortDay(time)}`
}

/**
 * The limit matters only while it is holding a top-up back: the balance is under the
 * minimum and automatic top-up would otherwise have charged the card.
 */
export function heldBackByLimit(account: BalanceAccount | null): TopupLimit | null {
  if (!account?.topup_limit || !account.auto_topup) return null
  return account.available_minor < account.min_balance_minor ? account.topup_limit : null
}

// The balance itself ------------------------------------------------------------------------

/** Whether there is a balance to show yet. Until money or a card arrives, the page is the first deposit. */
export function hasStarted(state: Pick<BalanceState, 'account' | 'activity'>): boolean {
  const account = state.account
  if (!account) return false
  return (
    account.deposited_minor !== 0 ||
    account.available_minor !== 0 ||
    account.reserved_minor !== 0 ||
    account.card !== null ||
    state.activity.length > 0
  )
}

export function pausedForBalance(program: BalanceProgram | null): boolean {
  return program?.status === 'paused' && program.pause_reason === 'balance_empty'
}

/** The currency every amount on the page is in: the balance's own, fixed when it was opened. */
export function balanceCurrency(state: Pick<BalanceState, 'account' | 'program'>): string {
  return state.account?.currency ?? state.program?.currency ?? 'USD'
}

// Adding funds ------------------------------------------------------------------------------

export interface DepositBounds {
  min_minor: number
  max_minor: number
  /** The first deposit has a higher minimum than the ones after it. */
  first: boolean
}

export function depositBounds(
  state: Pick<BalanceState, 'account' | 'min_deposit_minor' | 'activity'>,
): DepositBounds {
  // The server asks the first-deposit minimum until one deposit has landed, even one reversed later.
  const landed =
    (state.account?.deposited_minor ?? 0) > 0 ||
    state.activity.some((entry) => entry.kind === 'deposit')
  const first = !state.account || !landed
  return {
    min_minor: first ? Math.max(state.min_deposit_minor, MIN_TOPUP_MINOR) : MIN_TOPUP_MINOR,
    max_minor: MAX_AMOUNT_MINOR,
    first,
  }
}

/** What the amount field starts at: the top-up amount the merchant chose, inside the bounds. */
export function defaultDeposit(
  state: Pick<BalanceState, 'account' | 'min_deposit_minor' | 'activity'>,
): string {
  const bounds = depositBounds(state)
  const wanted = state.account?.topup_amount_minor ?? DEFAULT_TOPUP_MINOR
  return minorToDollars(Math.min(Math.max(wanted, bounds.min_minor), bounds.max_minor))
}

export function amountMessage(bounds: DepositBounds, currency: string): string {
  return `Enter an amount from ${formatAmount(bounds.min_minor, currency)} to ${formatAmount(bounds.max_minor, currency)}.`
}

/** The typed amount in minor units, or what is wrong with it. */
export function checkDeposit(
  typed: string,
  bounds: DepositBounds,
  currency: string,
): { minor: number } | { error: string } {
  const amount = dollarsToMinor(typed)
  if (amount === null) return { error: 'Enter an amount like 100.00.' }
  if (amount < bounds.min_minor || amount > bounds.max_minor)
    return { error: amountMessage(bounds, currency) }
  return { minor: amount }
}

// Card and automatic top-up -----------------------------------------------------------------

const cardBrands: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
}

/** "Visa ending 4242"; a brand we have no name for is simply a card. */
export function cardLabel(card: BalanceCard): string {
  return `${cardBrands[card.brand] ?? 'Card'} ending ${card.last4}`
}

/** "04/29", or null when the expiry is not known. */
export function cardExpiry(card: BalanceCard): string | null {
  if (!card.exp_month || !card.exp_year) return null
  return `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year % 100).padStart(2, '0')}`
}

/** A card is good to the end of the month printed on it. */
export function cardExpired(card: BalanceCard, now: number): boolean {
  if (!card.exp_month || !card.exp_year) return false
  const today = new Date(now)
  const year = today.getFullYear()
  return card.exp_year < year || (card.exp_year === year && card.exp_month < today.getMonth() + 1)
}

export interface SettingsDraft {
  autoTopup: boolean
  minBalance: string
  topupAmount: string
}
export type SettingsField = 'minBalance' | 'topupAmount'
export type SettingsErrors = Partial<Record<SettingsField, string>>

export function draftFromAccount(
  account: Pick<BalanceAccount, 'auto_topup' | 'min_balance_minor' | 'topup_amount_minor'>,
): SettingsDraft {
  return {
    autoTopup: account.auto_topup,
    minBalance: minorToDollars(account.min_balance_minor),
    topupAmount: minorToDollars(account.topup_amount_minor),
  }
}

export const settingsMessages: Record<SettingsField, string> = {
  minBalance: 'Enter the amount the balance should not fall below, like 50.00.',
  topupAmount: 'Enter the amount to add, like 100.00.',
}

/** What is wrong with the top-up settings as typed. Amounts only matter while top-up is on. */
export function validateSettings(draft: SettingsDraft, currency: string): SettingsErrors {
  const errors: SettingsErrors = {}
  if (!draft.autoTopup) return errors
  const floor = dollarsToMinor(draft.minBalance)
  const amount = dollarsToMinor(draft.topupAmount)
  if (floor === null) errors.minBalance = settingsMessages.minBalance
  else if (floor > MAX_AMOUNT_MINOR)
    errors.minBalance = `Enter an amount up to ${formatAmount(MAX_AMOUNT_MINOR, currency)}.`
  if (amount === null) errors.topupAmount = settingsMessages.topupAmount
  else if (amount < MIN_TOPUP_MINOR || amount > MAX_AMOUNT_MINOR)
    errors.topupAmount = `Enter an amount from ${formatAmount(MIN_TOPUP_MINOR, currency)} to ${formatAmount(MAX_AMOUNT_MINOR, currency)}.`
  return errors
}

/** Only what differs from what is saved is sent. Null when nothing changed. */
export function changedSettings(
  draft: SettingsDraft,
  account: Pick<BalanceAccount, 'auto_topup' | 'min_balance_minor' | 'topup_amount_minor'>,
): SettingsInput | null {
  const input: SettingsInput = {}
  if (draft.autoTopup !== account.auto_topup) input.auto_topup = draft.autoTopup
  // With top-up off the amounts are not on screen to be changed.
  if (draft.autoTopup) {
    const floor = dollarsToMinor(draft.minBalance)
    const amount = dollarsToMinor(draft.topupAmount)
    if (floor !== null && floor !== account.min_balance_minor) input.min_balance_minor = floor
    if (amount !== null && amount !== account.topup_amount_minor) input.topup_amount_minor = amount
  }
  return Object.keys(input).length ? input : null
}

/** Why an automatic top-up did not go through, as the end of "…failed: ". */
const topupReasons: Record<string, string> = {
  card_declined: 'your card was declined',
  generic_decline: 'your card was declined',
  do_not_honor: 'your card was declined',
  insufficient_funds: 'the card did not have enough funds',
  expired_card: 'the card has expired',
  incorrect_cvc: 'the card was refused',
  lost_card: 'the card was refused',
  stolen_card: 'the card was refused',
  card_not_supported: 'the card does not support this kind of payment',
  authentication_required: 'your bank wants you to confirm the payment yourself',
  requires_action: 'your bank wants you to confirm the payment yourself',
  processing_error: 'the card network had a problem',
  no_card: 'there is no saved card',
}

export function topupReason(code: string): string {
  return topupReasons[code] ?? 'the card payment did not go through'
}

// The activity list -------------------------------------------------------------------------

const entryLabels: Record<EntryKind, string> = {
  deposit: 'Deposit',
  deposit_reversed: 'Deposit reversed',
  commission_reserved: 'Commission set aside',
  commission_returned: 'Commission returned',
  fee_reserved: 'Fee',
  fee_returned: 'Fee returned',
  withdrawal: 'Withdrawal',
  adjustment: 'Adjustment',
  other: 'Balance change',
}

export function entryLabel(entry: Pick<BalanceEntry, 'kind' | 'topup_kind'>): string {
  if (entry.kind === 'deposit' && entry.topup_kind === 'auto') return 'Automatic top-up'
  return entryLabels[entry.kind]
}

/**
 * Who and what a line is about: "Ada Okafor · $49.00 sale", or for a reward
 * "Reward for Mira Maker: Account created". Null when there is nothing to add.
 */
export function entryDetail(
  entry: Pick<
    BalanceEntry,
    'kind' | 'creator_name' | 'sale_amount_minor' | 'note' | 'reward_label'
  >,
  currency: string,
): string | null {
  const about =
    entry.kind === 'commission_reserved' ||
    entry.kind === 'commission_returned' ||
    entry.kind === 'fee_reserved' ||
    entry.kind === 'fee_returned'
  if (about && entry.reward_label)
    return entry.creator_name
      ? `Reward for ${entry.creator_name}: ${entry.reward_label}`
      : `Reward: ${entry.reward_label}`
  const parts = about
    ? [
        entry.creator_name,
        entry.sale_amount_minor !== null
          ? `${formatAmount(entry.sale_amount_minor, currency)} sale`
          : null,
      ]
    : [entry.note]
  const line = parts.filter(Boolean).join(' · ')
  return line || null
}

// The return trip from Stripe ---------------------------------------------------------------

export type ReturnOutcome = 'done' | 'canceled'
export interface StripeReturn {
  what: 'deposit' | 'card'
  outcome: ReturnOutcome
}

const LEAVING = 'kma:merchant:balance-leaving'

/** Remembered for this tab only: what the person went to Stripe to do. */
export function rememberLeaving(what: StripeReturn['what']) {
  try {
    sessionStorage.setItem(LEAVING, what)
  } catch {
    /* Without it the address the person comes back to still says enough. */
  }
}

function leftFor(): StripeReturn['what'] | null {
  try {
    const what = sessionStorage.getItem(LEAVING)
    return what === 'deposit' || what === 'card' ? what : null
  } catch {
    return null
  }
}

/** Called once the page has read why the person is back, so an old errand names no later one. */
export function forgetLeaving() {
  try {
    sessionStorage.removeItem(LEAVING)
  } catch {
    /* Nothing was remembered. */
  }
}

/**
 * What Stripe's page sent the person back with. The address says how it ended; when it does
 * not say which errand it was, this tab's own memory of leaving does.
 */
export function readReturn(route: {
  deposit?: ReturnOutcome
  card?: ReturnOutcome
}): StripeReturn | null {
  if (route.card) return { what: 'card', outcome: route.card }
  if (route.deposit) return { what: leftFor() ?? 'deposit', outcome: route.deposit }
  return null
}

export const returnMessages = {
  depositCanceled: 'You cancelled on Stripe, so nothing was added.',
  cardCanceled: 'You cancelled on Stripe, so your card was not changed.',
  cardDone: 'Your card was saved on Stripe. It can take a moment to show here.',
  depositDone: 'Funds added',
}

// What each failure means, in words a business owner can act on ----------------------------

/** What the person was doing when a request failed. */
export type BalanceStep = 'load' | 'deposit' | 'card' | 'settings'

/**
 * How the person gets past a problem: try the same thing again, sign in again, or nothing
 * they can do alone. `reload` means the page has fetched the latest balance.
 */
export type BalanceRecovery = 'retry' | 'reload' | 'sign-in' | 'none'

export interface BalanceProblem {
  code: string
  message: string
  recovery: BalanceRecovery
  /** Set when the problem belongs to one field. */
  field?: 'amount' | SettingsField
}

const NOT_AVAILABLE: Omit<BalanceProblem, 'code'> = {
  message: 'Payments into your balance are not available yet.',
  recovery: 'none',
}
const NOT_ALLOWED: Omit<BalanceProblem, 'code'> = {
  message:
    'Only an owner or admin can add funds or change these settings. Ask one of them to do this.',
  recovery: 'none',
}
const NOT_A_MEMBER: Omit<BalanceProblem, 'code'> = {
  message: 'You are no longer a member of this workspace. Ask its owner to add you again.',
  recovery: 'none',
}
const NO_PROGRAM: Omit<BalanceProblem, 'code'> = {
  message: 'This workspace has no affiliate program to fund. You are now seeing what is saved.',
  recovery: 'reload',
}
const STRIPE_DOWN: Omit<BalanceProblem, 'code'> = {
  message: 'Stripe did not respond, so nothing was charged. Try again in a minute.',
  recovery: 'retry',
}
const AMOUNT: Omit<BalanceProblem, 'code'> = {
  message: 'Enter an amount inside the limits.',
  recovery: 'none',
  field: 'amount',
}

export const problemMessages: Record<string, Omit<BalanceProblem, 'code'>> = {
  invalid_min_balance_minor: {
    message: settingsMessages.minBalance,
    recovery: 'none',
    field: 'minBalance',
  },
  invalid_topup_amount_minor: {
    message: settingsMessages.topupAmount,
    recovery: 'none',
    field: 'topupAmount',
  },
  invalid_auto_topup: {
    message: 'Automatic top-up could not be changed. Try again.',
    recovery: 'none',
  },
  invalid_input: {
    message: 'That could not be sent as it is. Check the amounts and try again.',
    recovery: 'none',
  },
  invalid_amount: AMOUNT,
  invalid_amount_minor: AMOUNT,
  amount_too_small: AMOUNT,
  amount_too_large: AMOUNT,
  amount_out_of_range: AMOUNT,
  verified_email_required: {
    message: 'Confirm your email address first, then sign in again to add funds.',
    recovery: 'none',
  },
  balance_conflict: {
    message: 'Your balance changed while this was sent, so nothing was charged. Try again.',
    recovery: 'retry',
  },
  currency_mismatch: {
    message:
      'Your program and your balance are in different currencies, so nothing was charged. Contact KissMyApps to fix this.',
    recovery: 'none',
  },
  platform_mismatch: {
    message:
      'This balance cannot take payments right now, so nothing was charged. Contact KissMyApps to fix this.',
    recovery: 'none',
  },
  stripe_rejected: {
    message: 'Stripe did not accept the request, so nothing was charged. Try again.',
    recovery: 'retry',
  },
  balance_not_started: {
    message: 'Add funds first. Your card and top-up settings start with your first deposit.',
    recovery: 'reload',
  },
  card_required: {
    message: 'Add a card before you turn on automatic top-up.',
    recovery: 'none',
  },
  program_not_found: NO_PROGRAM,
  no_program: NO_PROGRAM,
  program_money_disabled: NOT_AVAILABLE,
  program_balance_disabled: NOT_AVAILABLE,
  not_allowed: NOT_ALLOWED,
  owner_or_admin_required: NOT_ALLOWED,
  not_found: NOT_A_MEMBER,
  not_a_member: NOT_A_MEMBER,
  unauthorized: {
    message: 'Your session has expired. Sign in again to continue.',
    recovery: 'sign-in',
  },
  origin_rejected: {
    message:
      'Funds can only be added from merchant.kissmyapps.dev. Open the console there and try again.',
    recovery: 'none',
  },
  rate_limited: {
    message: 'Too many attempts. Wait a minute, then try again.',
    recovery: 'retry',
  },
  stripe_unavailable: STRIPE_DOWN,
  payment_provider_unavailable: STRIPE_DOWN,
  offline: {
    message: 'You are offline. Reconnect to the internet and try again.',
    recovery: 'retry',
  },
  unreachable: {
    message: 'KissMyApps could not be reached. Check your connection and try again.',
    recovery: 'retry',
  },
  unavailable: {
    message: 'KissMyApps is briefly unavailable. Try again in a minute.',
    recovery: 'retry',
  },
}

/** When the failure is one we have no words for: what did not happen, and what to do. */
export const fallbackMessages: Record<BalanceStep, string> = {
  load: 'Your balance could not be loaded. Try again.',
  deposit: 'Stripe could not be opened, so nothing was charged. Try again.',
  card: 'Stripe could not be opened, so your card was not changed. Try again.',
  settings: 'Your changes were not saved. Try again.',
}

export function describeProblem(problem: unknown, step: BalanceStep): BalanceProblem {
  const code =
    problem instanceof ProgramError || problem instanceof BalanceError ? problem.code : 'unknown'
  const status = problem instanceof BalanceError ? problem.status : undefined
  const known =
    problemMessages[code] ??
    // Whatever a switched-off function calls itself, it answers with a code that says so.
    (/_disabled$/.test(code)
      ? NOT_AVAILABLE
      : /^stripe_|_provider_/.test(code) && (status === undefined || status >= 500)
        ? STRIPE_DOWN
        : status === 401
          ? problemMessages.unauthorized
          : status === 429
            ? problemMessages.rate_limited
            : status === 503
              ? problemMessages.unavailable
              : undefined)
  if (known) return { code, ...known }
  return { code, message: fallbackMessages[step], recovery: 'retry' }
}

/** Whether a problem means this person may not manage the balance after all. */
export function meansReadOnly(problem: BalanceProblem): boolean {
  return problem.code === 'not_allowed' || problem.code === 'owner_or_admin_required'
}
