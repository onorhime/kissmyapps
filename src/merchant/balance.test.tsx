import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import {
  amountMessage,
  BalanceError,
  balanceCurrency,
  cardExpired,
  cardExpiry,
  cardLabel,
  changedSettings,
  checkDeposit,
  defaultDeposit,
  depositBounds,
  describeProblem,
  draftFromAccount,
  entryDetail,
  entryLabel,
  fallbackMessages,
  feePercent,
  forgetLeaving,
  formatAmount,
  formatDayAndTime,
  formatMovement,
  hasStarted,
  MAX_AMOUNT_MINOR,
  meansReadOnly,
  pausedForBalance,
  problemMessages,
  readBalance,
  readCheckoutUrl,
  readReturn,
  rememberLeaving,
  returnMessages,
  topupReason,
  validateSettings,
} from './balance'
import type { BalanceStep } from './balance'
import { browser } from './connections'
import { MerchantApp } from './MerchantApp'
import { programBackendFixture } from './program-backend.fixture'
import {
  describeProblem as describeProgramProblem,
  ProgramError,
  readFailure,
  readState,
} from './programs'
import { href, parseRoute } from './routes'
import { rewardsBackendFixture } from './rewards-backend.fixture'

type Args = Record<string, unknown>
type Answer = unknown | ((args: Args) => unknown)

/** What the function sends back for a failed request: the repo's { error, message, request_id }. */
class Refusal {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    this.status = status
    this.code = code
  }
}

// A stand-in for the Supabase client: auth with listeners, the context rpcs, the
// workspace_program_* functions answered from a table, and the program-balance function.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    context: null as unknown,
    table: {} as Record<string, unknown>,
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    invoke: (() => {
      throw new Error('No answer set')
    }) as (body: Record<string, unknown>) => unknown,
    invoked: [] as Array<{ name: string; body: Record<string, unknown> }>,
  }
  const emit = (event: string) =>
    state.listeners.forEach((listener) => listener(event, state.session))
  const auth = {
    onAuthStateChange(listener: Listener) {
      state.listeners.add(listener)
      setTimeout(() => listener('INITIAL_SESSION', state.session), 0)
      return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } }
    },
    async signOut() {
      state.session = null
      emit('SIGNED_OUT')
      return { error: null }
    },
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (!name.startsWith('workspace_program_')) return { data: state.context, error: null }
    state.calls.push({ name, args })
    const answer = state.table[name]
    const value =
      typeof answer === 'function'
        ? await (answer as (args: Record<string, unknown>) => unknown)(args)
        : answer
    // A refusal is what PostgREST sends for a raised exception: errcode, message, DETAIL.
    const refusal = value as { refused?: boolean; code?: string; details?: string | null } | null
    if (refusal && refusal.refused)
      return {
        data: null,
        error: { code: refusal.code, details: refusal.details, message: 'From the database.' },
      }
    // An Error stands for a request that never got an answer.
    if (value instanceof Error) return { data: null, error: { message: value.message } }
    if (value === undefined)
      return { data: null, error: { code: 'XX000', details: null, message: `No answer: ${name}` } }
    return { data: value, error: null }
  }
  const functions = {
    async invoke(name: string, options: { body: Record<string, unknown> }) {
      state.invoked.push({ name, body: options.body })
      try {
        return { data: await state.invoke(options.body), error: null }
      } catch (problem) {
        const refusal = problem as { status?: number; code?: string }
        // supabase-js reports a non-2xx answer as an error whose context is the Response.
        if (typeof refusal.status === 'number')
          return {
            data: null,
            error: {
              context: new Response(
                JSON.stringify({
                  error: refusal.code,
                  message: 'From the server.',
                  request_id: 'r',
                }),
                { status: refusal.status },
              ),
            },
          }
        // Anything else stands for a request that never got an answer.
        return { data: null, error: { context: problem } }
      }
    },
  }
  return { state, client: { auth, rpc, functions } }
})

vi.mock('../lib/supabase', () => ({
  supabase: fake.client,
  getSupabaseConfigurationIssue: () => null,
  requireSupabaseClient: () => fake.client,
}))

const project: Project = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'SpeakSix',
  platforms: ['web', 'ios'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
}

const context = (role: Role, projects: Project[] = [project]): Context => ({
  user: { id: 'user-1', email: 'victory@example.com', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5#fidkdWxOYHwnPyd1blppbHNgWjA0'
/** The database's own timestamps: microseconds and an explicit offset. */
const AT = '2026-11-13T13:52:14.059098+00:00'

type Row = Record<string, unknown>

const program = (over: Row = {}): Row => ({
  id: 'prog-1',
  name: 'SpeakSix',
  status: 'live',
  pause_reason: null,
  currency: 'USD',
  ...over,
})

const card = { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029 }

const account = (over: Row = {}): Row => ({
  currency: 'USD',
  available_minor: 8236,
  reserved_minor: 1764,
  creators_pending_minor: 1470,
  creators_approved_minor: 2940,
  fees_minor: 441,
  deposited_minor: 15000,
  card,
  auto_topup: true,
  min_balance_minor: 5000,
  topup_amount_minor: 10000,
  topup_problem: null,
  topup_limit: null,
  ...over,
})

let rowNumber = 0
const entry = (over: Row = {}): Row => ({
  id: `entry-${++rowNumber}`,
  kind: 'commission_reserved',
  amount_minor: -1470,
  available_after_minor: 8236,
  created_at: AT,
  creator_name: 'Ada Okafor',
  sale_amount_minor: 4900,
  topup_kind: null,
  note: null,
  ...over,
})

/** The ledger of a small balance, newest first, as the database sends it. */
const ledger = (): Row[] => [
  entry({ kind: 'fee_reserved', amount_minor: -147, available_after_minor: 8236 }),
  entry({ kind: 'commission_reserved', amount_minor: -1470, available_after_minor: 8383 }),
  entry({
    kind: 'deposit',
    amount_minor: 10000,
    available_after_minor: 9853,
    creator_name: null,
    sale_amount_minor: null,
    topup_kind: 'auto',
  }),
  entry({
    kind: 'fee_returned',
    amount_minor: 147,
    available_after_minor: -147,
    creator_name: 'Lena Hoffmann',
  }),
  entry({
    kind: 'commission_returned',
    amount_minor: 1470,
    available_after_minor: -294,
    creator_name: 'Lena Hoffmann',
  }),
  entry({
    kind: 'deposit',
    amount_minor: 5000,
    available_after_minor: 5000,
    creator_name: null,
    sale_amount_minor: null,
    topup_kind: 'deposit',
  }),
]

/** A workspace_program_balance answer in the contract's shape. */
const balanceState = (over: Row = {}): Row => ({
  enabled: true,
  can_manage: true,
  program: program(),
  account: account(),
  min_deposit_minor: 5000,
  fee_bps: 1000,
  activity: ledger(),
  pending_topup: null,
  ...over,
})

const notStarted = (over: Row = {}) =>
  balanceState({ program: program({ status: 'draft' }), account: null, activity: [], ...over })

/** What the database raises: errcode 22023 with a stable code in DETAIL, unless said otherwise. */
const refuse = (details: string | null, code = '22023') => ({ refused: true, code, details })

/** An answer that arrives when the test says so. */
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function signedInAs(role: Role, projects?: Project[]) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.com' } }
  fake.state.context = context(role, projects)
}

function answers(table: Record<string, Answer>) {
  fake.state.table = { ...fake.state.table, ...table }
}

/** How the program-balance function answers each action. */
function functionAnswers(table: Record<string, unknown>) {
  fake.state.invoke = (body) => {
    const answer = table[String(body.action)]
    if (answer instanceof Refusal || answer instanceof Error) throw answer
    if (answer === undefined) throw new Error(`No answer: ${String(body.action)}`)
    return typeof answer === 'function' ? (answer as () => unknown)() : answer
  }
}

const sent = (name: 'balance' | 'balance_settings') =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)
const invoked = () => fake.state.invoked

async function openBalance(get: Answer = balanceState(), hash = '#balance', wait = true) {
  answers({ workspace_program_balance: get })
  window.location.hash = hash
  const user = userEvent.setup()
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Balance', level: 1 })
  if (wait)
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'Loading your balance' }),
      ).not.toBeInTheDocument(),
    )
  return user
}

const page = () => document.querySelector('.mc-bal') as HTMLElement
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const buttons = (name: string | RegExp) => screen.queryAllByRole('button', { name })
const summary = () => screen.getByRole('region', { name: 'Your balance' })
const settings = () => screen.getByRole('region', { name: 'Card and automatic top-up' })
const activity = () => screen.getByRole('region', { name: 'Activity' })
const attention = () => document.querySelector('.mc-bal-alert') as HTMLElement | null
const figure = (label: string) =>
  within(summary()).getByText(label).closest('.mc-bal-figure') as HTMLElement
const dialog = () => screen.getByRole('dialog', { name: 'Add funds' })
const leaving = () => vi.spyOn(browser, 'leaveFor').mockImplementation(() => {})

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.invoked = []
  fake.state.table = {}
  fake.state.invoke = () => {
    throw new Error('No answer set')
  }
  fake.state.context = context('owner')
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('balance route', () => {
  it('lives at #balance', () => {
    expect(parseRoute('#balance')).toEqual({ name: 'balance' })
    expect(parseRoute('#/balance')).toEqual({ name: 'balance' })
    expect(href({ name: 'balance' })).toBe('#balance')
    expect(parseRoute(href({ name: 'balance' }))).toEqual({ name: 'balance' })
  })

  it('reads how Stripe ended from the query inside the hash, and nothing else', () => {
    expect(parseRoute('#balance?deposit=done')).toEqual({ name: 'balance', deposit: 'done' })
    expect(parseRoute('#balance?deposit=canceled')).toEqual({
      name: 'balance',
      deposit: 'canceled',
    })
    expect(parseRoute('#balance?card=done')).toEqual({ name: 'balance', card: 'done' })
    expect(parseRoute('#balance?deposit=paid&card=1&session_id=cs_live_1')).toEqual({
      name: 'balance',
    })
    expect(href({ name: 'balance', deposit: 'done' })).toBe('#balance?deposit=done')
  })

  it('is the last entry of the Affiliates group, after Sales', async () => {
    signedInAs('owner')
    await openBalance()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Balance' })
    expect(link).toHaveAttribute('href', '#balance')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Balance')
    const group = document.getElementById('mc-nav-affiliates') as HTMLElement
    expect(
      within(group)
        .getAllByRole('link')
        .map((item) => item.textContent),
    ).toEqual(['Program', 'Creators', 'Sales', 'Rewards', 'Balance'])
    // The project the person was in keeps its menu.
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })

  it('is reachable in a workspace with no project', async () => {
    signedInAs('owner', [])
    await openBalance(notStarted())
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Balance' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('heading', { name: 'Make your first deposit' })).toBeInTheDocument()
  })

  it('asks the database as the signed-in user, for this workspace', async () => {
    signedInAs('owner')
    await openBalance()
    expect(sent('balance')[0]).toEqual({ p_workspace_id: 'ws-1' })
  })
})

describe('reading answers', () => {
  it('reads the balance the database sends', () => {
    const read = readBalance(
      balanceState({
        activity: [entry({ id: 'e-1' })],
        pending_topup: { id: 't-1', amount_minor: 10000, status: 'processing', created_at: AT },
      }),
    )
    expect(read).toEqual({
      enabled: true,
      can_manage: true,
      program: {
        id: 'prog-1',
        name: 'SpeakSix',
        status: 'live',
        pause_reason: null,
        currency: 'USD',
      },
      account: {
        currency: 'USD',
        available_minor: 8236,
        reserved_minor: 1764,
        creators_pending_minor: 1470,
        creators_approved_minor: 2940,
        fees_minor: 441,
        deposited_minor: 15000,
        card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2029 },
        auto_topup: true,
        min_balance_minor: 5000,
        topup_amount_minor: 10000,
        topup_problem: null,
        topup_limit: null,
      },
      min_deposit_minor: 5000,
      fee_bps: 1000,
      activity: [
        {
          id: 'e-1',
          kind: 'commission_reserved',
          amount_minor: -1470,
          available_after_minor: 8236,
          created_at: AT,
          creator_name: 'Ada Okafor',
          sale_amount_minor: 4900,
          topup_kind: null,
          note: null,
        },
      ],
      pending_topup: { id: 't-1', amount_minor: 10000, status: 'processing', created_at: AT },
    })
  })

  it('refuses an answer that cannot draw the page', () => {
    for (const bad of [
      null,
      'ok',
      [],
      {},
      { enabled: 'yes' },
      balanceState({ can_manage: undefined }),
      balanceState({ program: { id: 'prog-1', status: 'retired' } }),
      balanceState({ program: { status: 'live' } }),
      balanceState({ account: 'none' }),
    ])
      expect(() => readBalance(bad)).toThrow(ProgramError)
  })

  it('never turns an amount it cannot read into a number', () => {
    for (const field of [
      'available_minor',
      'reserved_minor',
      'creators_pending_minor',
      'creators_approved_minor',
      'fees_minor',
      'deposited_minor',
      'min_balance_minor',
      'topup_amount_minor',
    ])
      for (const bad of [undefined, null, '8236', 82.36, Number.NaN])
        expect(() => readBalance(balanceState({ account: account({ [field]: bad }) }))).toThrow(
          ProgramError,
        )
    // A balance below zero is real: a deposit can be reversed after it was spent.
    expect(
      readBalance(balanceState({ account: account({ available_minor: -294 }) })).account
        ?.available_minor,
    ).toBe(-294)
  })

  it('reads a balance that is switched off without asking for the rest', () => {
    expect(readBalance({ enabled: false })).toEqual({
      enabled: false,
      can_manage: false,
      program: null,
      account: null,
      min_deposit_minor: 5000,
      fee_bps: null,
      activity: [],
      pending_topup: null,
    })
    expect(readBalance(balanceState({ enabled: false })).account).toBeNull()
  })

  it('has no program, and so no balance, once the program is archived', () => {
    const read = readBalance(balanceState({ program: program({ status: 'archived' }) }))
    expect(read.program).toBeNull()
    expect(read.account).toBeNull()
  })

  it('has no account before the first deposit is started', () => {
    expect(readBalance(notStarted()).account).toBeNull()
    expect(readBalance(balanceState({ account: undefined })).account).toBeNull()
  })

  it('leaves out ledger lines it cannot trust and keeps kinds it has no words for', () => {
    const read = readBalance(
      balanceState({
        activity: [
          entry({ id: 'e-1' }),
          entry({ id: '' }),
          entry({ amount_minor: '1470' }),
          entry({ kind: 7 }),
          'row',
          null,
          entry({ id: 'e-2', kind: 'payout_reserved', available_after_minor: null }),
          entry({ id: 'e-3', kind: 'deposit', topup_kind: 'gift', created_at: 'soon' }),
        ],
      }),
    )
    expect(read.activity.map((row) => [row.id, row.kind])).toEqual([
      ['e-1', 'commission_reserved'],
      ['e-2', 'other'],
      ['e-3', 'deposit'],
    ])
    expect(read.activity[1].available_after_minor).toBeNull()
    expect(read.activity[2].topup_kind).toBeNull()
    expect(read.activity[2].created_at).toBeNull()
    expect(readBalance(balanceState({ activity: undefined })).activity).toEqual([])
  })

  it('reads the saved card, and only brand, last four and expiry', () => {
    const read = (value: unknown) =>
      readBalance(balanceState({ account: account({ card: value }) }))
    expect(read({ ...card, brand: 'VISA', number: '4242424242424242' }).account?.card).toEqual(card)
    expect(read(null).account?.card).toBeNull()
    expect(read({ ...card, last4: '42424242' }).account?.card).toBeNull()
    expect(read({ ...card, last4: 4242 }).account?.card).toBeNull()
    expect(read({ last4: '0005', exp_month: 13, exp_year: 29 }).account?.card).toEqual({
      brand: 'card',
      last4: '0005',
      exp_month: null,
      exp_year: null,
    })
  })

  it("reads the day's limit on automatic top-ups, and drops one it cannot trust", () => {
    const limit = { per_day: 5, resumes_at: '2026-11-14T13:52:14+00:00' }
    const read = (value: unknown) =>
      readBalance(balanceState({ account: account({ topup_limit: value }) })).account?.topup_limit
    expect(read(limit)).toEqual(limit)
    expect(read({ per_day: 5, resumes_at: 'soon' })).toEqual({ per_day: 5, resumes_at: null })
    expect(read({ per_day: 0, resumes_at: limit.resumes_at })).toBeNull()
    expect(read('5')).toBeNull()
    const { topup_limit: _absent, ...older } = account()
    expect(readBalance(balanceState({ account: older })).account?.topup_limit).toBeNull()
  })

  it('reads a failed top-up and a deposit that is on its way', () => {
    const failed = { code: 'card_declined', failed_at: AT, retry_at: '2026-11-14T13:52:14+00:00' }
    expect(
      readBalance(balanceState({ account: account({ topup_problem: failed }) })).account
        ?.topup_problem,
    ).toEqual(failed)
    expect(
      readBalance(balanceState({ account: account({ topup_problem: { failed_at: 'x' } }) })).account
        ?.topup_problem,
    ).toEqual({ code: 'unknown', failed_at: null, retry_at: null })
    const pending = (value: unknown) => readBalance(balanceState({ pending_topup: value }))
    expect(
      pending({ id: 't-1', amount_minor: 5000, status: 'pending', created_at: AT }).pending_topup,
    ).toEqual({ id: 't-1', amount_minor: 5000, status: 'pending', created_at: AT })
    expect(pending({ id: 't-1', amount_minor: 5000, status: 'succeeded' }).pending_topup).toBeNull()
    expect(pending({ id: 't-1', amount_minor: 0, status: 'pending' }).pending_topup).toBeNull()
    expect(pending({ id: 't-1', status: 'pending' }).pending_topup).toBeNull()
  })

  it('keeps the limits the answer gives and falls back when it gives none', () => {
    expect(readBalance(balanceState({ min_deposit_minor: 2500, fee_bps: 1250 }))).toMatchObject({
      min_deposit_minor: 2500,
      fee_bps: 1250,
    })
    expect(
      readBalance(balanceState({ min_deposit_minor: undefined, fee_bps: undefined })),
    ).toMatchObject({ min_deposit_minor: 5000, fee_bps: null })
    expect(readBalance(balanceState({ fee_bps: 0 })).fee_bps).toBe(0)
    expect(readBalance(balanceState({ fee_bps: 20000 })).fee_bps).toBeNull()
  })

  it('uses the balance currency, fixed when it was opened', () => {
    const read = readBalance(
      balanceState({
        program: program({ currency: 'eur' }),
        account: account({ currency: undefined }),
      }),
    )
    expect(read.account?.currency).toBe('EUR')
    expect(balanceCurrency(read)).toBe('EUR')
    expect(
      balanceCurrency(readBalance(notStarted({ program: program({ currency: 'GBP' }) }))),
    ).toBe('GBP')
  })

  it('only ever accepts an address on Stripe Checkout', () => {
    expect(readCheckoutUrl({ checkout_url: CHECKOUT })).toBe(CHECKOUT)
    for (const bad of [
      'http://checkout.stripe.com/c/pay/cs_live_1',
      'https://checkout.stripe.com',
      'https://checkout.stripe.com.evil.test/c/pay/cs_live_1',
      'https://checkout.stripe.com@evil.test/c/pay/cs_live_1',
      'https://user:pass@checkout.stripe.com/c/pay/cs_live_1',
      'https://checkout.stripe.com:8443/c/pay/cs_live_1',
      'https://evil.test/?next=https://checkout.stripe.com/',
      ' https://checkout.stripe.com/c/pay/cs_live_1',
      'https://connect.stripe.com/oauth/authorize',
      'javascript:alert(1)',
      '',
      null,
      42,
    ])
      expect(() => readCheckoutUrl({ checkout_url: bad })).toThrow(ProgramError)
    expect(() => readCheckoutUrl(null)).toThrow(ProgramError)
    expect(() => readCheckoutUrl({ url: CHECKOUT })).toThrow(ProgramError)
  })
})

describe('money as it is shown', () => {
  it('writes every amount in normal units with its currency', () => {
    expect(formatAmount(8236, 'USD')).toBe('$82.36')
    expect(formatAmount(0, 'USD')).toBe('$0.00')
    expect(formatAmount(100_000_000, 'USD')).toBe('$1,000,000.00')
    expect(formatAmount(-294, 'USD')).toBe('−$2.94')
    expect(formatAmount(1500, 'EUR')).toBe('15.00 EUR')
    expect(formatAmount(-5, 'GBP')).toBe('−0.05 GBP')
  })

  it('signs a movement of money', () => {
    expect(formatMovement(10000, 'USD')).toBe('+$100.00')
    expect(formatMovement(-1470, 'USD')).toBe('−$14.70')
    expect(formatMovement(0, 'USD')).toBe('$0.00')
    expect(formatMovement(147, 'EUR')).toBe('+1.47 EUR')
  })

  it('shows the fee as a percentage', () => {
    expect(feePercent(1000)).toBe('10%')
    expect(feePercent(1250)).toBe('12.5%')
    expect(feePercent(0)).toBe('0%')
    expect(feePercent(null)).toBeNull()
  })
})

describe('adding funds: the amount', () => {
  const first = readBalance(notStarted())
  const later = readBalance(balanceState())

  it('asks more for the first deposit than for the ones after it', () => {
    expect(depositBounds(first)).toEqual({ min_minor: 5000, max_minor: 100_000_000, first: true })
    expect(depositBounds(later)).toEqual({ min_minor: 1000, max_minor: 100_000_000, first: false })
    // An account opened by a payment that was never finished is still before its first deposit.
    expect(
      depositBounds(
        readBalance(balanceState({ account: account({ deposited_minor: 0 }), activity: [] })),
      ),
    ).toMatchObject({ min_minor: 5000, first: true })
    // A deposit that landed and was reversed in full still counts as the first one.
    expect(
      depositBounds(
        readBalance(
          balanceState({
            account: account({ deposited_minor: 0 }),
            activity: [entry({ kind: 'deposit', amount_minor: 5000 })],
          }),
        ),
      ),
    ).toMatchObject({ min_minor: 1000, first: false })
    expect(depositBounds(readBalance(notStarted({ min_deposit_minor: 20000 }))).min_minor).toBe(
      20000,
    )
  })

  it('starts the field at the top-up amount, inside the limits', () => {
    expect(defaultDeposit(later)).toBe('100.00')
    expect(defaultDeposit(first)).toBe('100.00')
    expect(defaultDeposit(readBalance(notStarted({ min_deposit_minor: 25000 })))).toBe('250.00')
    expect(
      defaultDeposit(readBalance(balanceState({ account: account({ topup_amount_minor: 2550 }) }))),
    ).toBe('25.50')
  })

  it('accepts an amount inside the limits and says what is wrong with any other', () => {
    const bounds = depositBounds(first)
    expect(checkDeposit('50', bounds, 'USD')).toEqual({ minor: 5000 })
    expect(checkDeposit('$1,250.50', bounds, 'USD')).toEqual({ minor: 125050 })
    expect(checkDeposit('1000000', bounds, 'USD')).toEqual({ minor: MAX_AMOUNT_MINOR })
    const limits = 'Enter an amount from $50.00 to $1,000,000.00.'
    expect(amountMessage(bounds, 'USD')).toBe(limits)
    expect(checkDeposit('49.99', bounds, 'USD')).toEqual({ error: limits })
    expect(checkDeposit('1000000.01', bounds, 'USD')).toEqual({ error: limits })
    for (const typed of ['', 'fifty', '-50', '50.999', '5e3', '50 dollars'])
      expect(checkDeposit(typed, bounds, 'USD')).toEqual({ error: 'Enter an amount like 100.00.' })
    expect(checkDeposit('10', depositBounds(later), 'USD')).toEqual({ minor: 1000 })
    expect(checkDeposit('9.99', depositBounds(later), 'EUR')).toEqual({
      error: 'Enter an amount from 10.00 EUR to 1,000,000.00 EUR.',
    })
  })
})

describe('card and automatic top-up: wording and arithmetic', () => {
  const saved = { auto_topup: true, min_balance_minor: 5000, topup_amount_minor: 10000 }

  it('names the card by brand, last four and expiry', () => {
    expect(cardLabel(card)).toBe('Visa ending 4242')
    expect(cardLabel({ ...card, brand: 'amex' })).toBe('American Express ending 4242')
    expect(cardLabel({ ...card, brand: 'somecard' })).toBe('Card ending 4242')
    expect(cardExpiry(card)).toBe('04/29')
    expect(cardExpiry({ ...card, exp_month: null })).toBeNull()
  })

  it('knows a card is good to the end of the month printed on it', () => {
    const at = (iso: string) => new Date(iso).getTime()
    expect(cardExpired(card, at('2029-04-15T12:00:00'))).toBe(false)
    expect(cardExpired(card, at('2029-05-01T12:00:00'))).toBe(true)
    expect(cardExpired(card, at('2030-01-01T12:00:00'))).toBe(true)
    expect(cardExpired({ ...card, exp_year: null }, at('2040-01-01T12:00:00'))).toBe(false)
  })

  it('shows the saved settings in normal units', () => {
    expect(draftFromAccount(saved)).toEqual({
      autoTopup: true,
      minBalance: '50.00',
      topupAmount: '100.00',
    })
  })

  it('checks the amounts only while top-up is on', () => {
    expect(validateSettings(draftFromAccount(saved), 'USD')).toEqual({})
    expect(
      validateSettings({ autoTopup: true, minBalance: 'fifty', topupAmount: '9.99' }, 'USD'),
    ).toEqual({
      minBalance: 'Enter the amount the balance should not fall below, like 50.00.',
      topupAmount: 'Enter an amount from $10.00 to $1,000,000.00.',
    })
    expect(
      validateSettings({ autoTopup: true, minBalance: '1000000.01', topupAmount: '' }, 'USD'),
    ).toEqual({
      minBalance: 'Enter an amount up to $1,000,000.00.',
      topupAmount: 'Enter the amount to add, like 100.00.',
    })
    expect(
      validateSettings({ autoTopup: false, minBalance: 'fifty', topupAmount: '' }, 'USD'),
    ).toEqual({})
  })

  it('sends only what changed, in minor units', () => {
    expect(changedSettings(draftFromAccount(saved), saved)).toBeNull()
    expect(
      changedSettings({ autoTopup: true, minBalance: '75', topupAmount: '100.00' }, saved),
    ).toEqual({ min_balance_minor: 7500 })
    expect(
      changedSettings({ autoTopup: true, minBalance: '50.00', topupAmount: '$250.50' }, saved),
    ).toEqual({ topup_amount_minor: 25050 })
    expect(
      changedSettings({ autoTopup: false, minBalance: '75', topupAmount: '200' }, saved),
    ).toEqual({ auto_topup: false })
    expect(
      changedSettings(
        { autoTopup: true, minBalance: '20', topupAmount: '50' },
        { ...saved, auto_topup: false },
      ),
    ).toEqual({ auto_topup: true, min_balance_minor: 2000, topup_amount_minor: 5000 })
  })

  it('says why a top-up failed in plain words', () => {
    expect(topupReason('card_declined')).toBe('your card was declined')
    expect(topupReason('insufficient_funds')).toBe('the card did not have enough funds')
    expect(topupReason('expired_card')).toBe('the card has expired')
    expect(topupReason('requires_action')).toBe(
      'your bank wants you to confirm the payment yourself',
    )
    expect(topupReason('something_new')).toBe('the card payment did not go through')
  })
})

describe('the activity list: wording', () => {
  const row = (over: Row) => readBalance(balanceState({ activity: [entry(over)] })).activity[0]

  it('names each kind of movement', () => {
    const label = (kind: string, topup: string | null = null) =>
      entryLabel(row({ kind, topup_kind: topup }))
    expect(label('deposit', 'deposit')).toBe('Deposit')
    expect(label('deposit')).toBe('Deposit')
    expect(label('deposit', 'auto')).toBe('Automatic top-up')
    expect(label('deposit_reversed')).toBe('Deposit reversed')
    expect(label('commission_reserved')).toBe('Commission set aside')
    expect(label('commission_returned')).toBe('Commission returned')
    expect(label('fee_reserved')).toBe('Fee')
    expect(label('fee_returned')).toBe('Fee returned')
    expect(label('withdrawal')).toBe('Withdrawal')
    expect(label('adjustment')).toBe('Adjustment')
    expect(label('something_new')).toBe('Balance change')
  })

  it('says who and which sale a commission line is about', () => {
    expect(entryDetail(row({}), 'USD')).toBe('Ada Okafor · $49.00 sale')
    expect(entryDetail(row({ sale_amount_minor: null }), 'USD')).toBe('Ada Okafor')
    expect(entryDetail(row({ creator_name: null }), 'EUR')).toBe('49.00 EUR sale')
    expect(entryDetail(row({ kind: 'fee_returned' }), 'USD')).toBe('Ada Okafor · $49.00 sale')
    expect(
      entryDetail(
        row({
          kind: 'commission_returned',
          note: "Refund recovered from the creator's later earnings",
        }),
        'USD',
      ),
    ).toBe("Ada Okafor · $49.00 sale · Refund recovered from the creator's later earnings")
    expect(entryDetail(row({ kind: 'deposit', topup_kind: 'auto' }), 'USD')).toBeNull()
    expect(entryDetail(row({ kind: 'adjustment', note: 'Goodwill credit' }), 'USD')).toBe(
      'Goodwill credit',
    )
  })
})

describe('where the balance stands', () => {
  it('is the first deposit until money or a card has arrived', () => {
    expect(hasStarted(readBalance(notStarted()))).toBe(false)
    expect(hasStarted(readBalance(balanceState()))).toBe(true)
    const opened = account({
      available_minor: 0,
      reserved_minor: 0,
      creators_pending_minor: 0,
      creators_approved_minor: 0,
      fees_minor: 0,
      deposited_minor: 0,
      card: null,
      auto_topup: false,
    })
    // A payment page that was opened and never paid leaves an empty account behind.
    expect(hasStarted(readBalance(balanceState({ account: opened, activity: [] })))).toBe(false)
    expect(
      hasStarted(readBalance(balanceState({ account: { ...opened, card }, activity: [] }))),
    ).toBe(true)
    expect(hasStarted(readBalance(balanceState({ account: opened })))).toBe(true)
  })

  it('knows a program paused for its balance from one paused for another reason', () => {
    const paused = (reason: string | null) =>
      pausedForBalance(
        readBalance(balanceState({ program: program({ status: 'paused', pause_reason: reason }) }))
          .program,
      )
    expect(paused('balance_empty')).toBe(true)
    expect(paused('merchant')).toBe(false)
    expect(paused(null)).toBe(false)
    expect(pausedForBalance(readBalance(balanceState()).program)).toBe(false)
    expect(pausedForBalance(null)).toBe(false)
  })
})

describe('the return trip from Stripe', () => {
  it('reads how it ended from the address', () => {
    expect(readReturn({})).toBeNull()
    expect(readReturn({ deposit: 'done' })).toEqual({ what: 'deposit', outcome: 'done' })
    expect(readReturn({ deposit: 'canceled' })).toEqual({ what: 'deposit', outcome: 'canceled' })
    expect(readReturn({ card: 'done' })).toEqual({ what: 'card', outcome: 'done' })
  })

  it('remembers which errand it was when the address does not say', () => {
    rememberLeaving('card')
    expect(readReturn({ deposit: 'done' })).toEqual({ what: 'card', outcome: 'done' })
    expect(readReturn({ deposit: 'canceled' })).toEqual({ what: 'card', outcome: 'canceled' })
    forgetLeaving()
    expect(readReturn({ deposit: 'done' })).toEqual({ what: 'deposit', outcome: 'done' })
    // Remembering an errand never invents a return.
    rememberLeaving('deposit')
    expect(readReturn({})).toBeNull()
  })
})

describe('error mapping', () => {
  const steps: BalanceStep[] = ['load', 'deposit', 'card', 'settings']
  const fromDatabase = (details: string | null, code = '22023') =>
    readFailure({ code, details, message: 'From the database.' })

  it('has words for every refusal the payments function sends', () => {
    const refused = (code: string, status: number) =>
      describeProblem(new BalanceError(code, '', status), 'deposit')
    expect(refused('verified_email_required', 401)).toMatchObject({
      message: 'Confirm your email address first, then sign in again to add funds.',
      recovery: 'none',
    })
    expect(refused('balance_conflict', 409)).toMatchObject({ recovery: 'retry' })
    expect(refused('currency_mismatch', 409)).toMatchObject({ recovery: 'none' })
    expect(refused('platform_mismatch', 409)).toMatchObject({ recovery: 'none' })
    expect(refused('stripe_rejected', 502).message).toBe(
      'Stripe did not accept the request, so nothing was charged. Try again.',
    )
    for (const [code, status] of [
      ['invalid_input', 400],
      ['invalid_amount_minor', 400],
      ['unauthorized', 401],
      ['origin_rejected', 403],
      ['not_a_member', 403],
      ['owner_or_admin_required', 403],
      ['program_money_disabled', 409],
      ['no_program', 409],
      ['balance_not_started', 409],
      ['stripe_unavailable', 502],
      ['program_balance_disabled', 503],
      ['configuration_error', 503],
      ['database_boundary_error', 503],
    ] as const)
      expect(refused(code, status).message, code).not.toBe(fallbackMessages.deposit)
  })

  it('puts a refused setting at its field', () => {
    expect(describeProblem(fromDatabase('invalid_min_balance_minor'), 'settings')).toEqual({
      code: 'invalid_min_balance_minor',
      message: 'Enter the amount the balance should not fall below, like 50.00.',
      recovery: 'none',
      field: 'minBalance',
    })
    expect(describeProblem(fromDatabase('invalid_topup_amount_minor'), 'settings')).toEqual({
      code: 'invalid_topup_amount_minor',
      message: 'Enter the amount to add, like 100.00.',
      recovery: 'none',
      field: 'topupAmount',
    })
    expect(describeProblem(fromDatabase('invalid_auto_topup'), 'settings')).toMatchObject({
      message: 'Automatic top-up could not be changed. Try again.',
      recovery: 'none',
    })
  })

  it('explains the two things settings can need first', () => {
    expect(describeProblem(fromDatabase('balance_not_started'), 'settings')).toEqual({
      code: 'balance_not_started',
      message: 'Add funds first. Your card and top-up settings start with your first deposit.',
      recovery: 'reload',
    })
    expect(describeProblem(fromDatabase('card_required'), 'settings')).toEqual({
      code: 'card_required',
      message: 'Add a card before you turn on automatic top-up.',
      recovery: 'none',
    })
  })

  it('reads permission from the database errcode when there is no DETAIL', () => {
    const denied = describeProblem(fromDatabase(null, '42501'), 'settings')
    expect(denied).toEqual({
      code: 'not_allowed',
      message:
        'Only an owner or admin can add funds or change these settings. Ask one of them to do this.',
      recovery: 'none',
    })
    expect(meansReadOnly(denied)).toBe(true)
    expect(describeProblem(fromDatabase(null, 'P0002'), 'load')).toMatchObject({
      code: 'not_found',
      message: 'You are no longer a member of this workspace. Ask its owner to add you again.',
      recovery: 'none',
    })
    expect(describeProblem(fromDatabase(null, 'PGRST301'), 'load').recovery).toBe('sign-in')
  })

  it('reads the function refusals', () => {
    const from = (status: number, code: string) =>
      new BalanceError(code, 'From the server.', status)
    const off = 'Payments into your balance are not available yet.'
    expect(describeProblem(from(503, 'program_balance_disabled'), 'deposit')).toEqual({
      code: 'program_balance_disabled',
      message: off,
      recovery: 'none',
    })
    // Whatever name the switched-off function gives itself.
    expect(describeProblem(from(503, 'balance_function_disabled'), 'card').message).toBe(off)
    const denied = describeProblem(from(403, 'owner_or_admin_required'), 'deposit')
    expect(denied.message).toMatch(/^Only an owner or admin can add funds/)
    expect(meansReadOnly(denied)).toBe(true)
    expect(describeProblem(from(403, 'not_a_member'), 'deposit').message).toMatch(
      /^You are no longer a member/,
    )
    expect(describeProblem(from(401, 'unauthorized'), 'deposit').recovery).toBe('sign-in')
    expect(describeProblem(from(401, 'jwt_expired'), 'card').recovery).toBe('sign-in')
    expect(describeProblem(from(429, 'rate_limited'), 'deposit')).toMatchObject({
      message: 'Too many attempts. Wait a minute, then try again.',
      recovery: 'retry',
    })
    for (const code of ['invalid_amount', 'amount_too_small', 'amount_too_large'])
      expect(describeProblem(from(400, code), 'deposit')).toMatchObject({
        field: 'amount',
        recovery: 'none',
      })
    for (const code of ['stripe_unavailable', 'payment_provider_unavailable', 'stripe_timeout'])
      expect(describeProblem(from(502, code), 'deposit')).toMatchObject({
        message: 'Stripe did not respond, so nothing was charged. Try again in a minute.',
        recovery: 'retry',
      })
    expect(describeProblem(from(503, 'database_boundary_error'), 'deposit')).toMatchObject({
      message: 'KissMyApps is briefly unavailable. Try again in a minute.',
      recovery: 'retry',
    })
    expect(describeProblem(from(400, 'balance_not_started'), 'card').recovery).toBe('reload')
    expect(describeProblem(from(404, 'program_not_found'), 'deposit').recovery).toBe('reload')
  })

  it('says what did not happen when it has no words for the failure', () => {
    expect(describeProblem(new BalanceError('http_500', '', 500), 'deposit')).toEqual({
      code: 'http_500',
      message: 'Stripe could not be opened, so nothing was charged. Try again.',
      recovery: 'retry',
    })
    expect(describeProblem(new ProgramError('response_unreadable'), 'card')).toEqual({
      code: 'response_unreadable',
      message: 'Stripe could not be opened, so your card was not changed. Try again.',
      recovery: 'retry',
    })
    expect(describeProblem(new Error('boom'), 'load')).toEqual({
      code: 'unknown',
      message: 'Your balance could not be loaded. Try again.',
      recovery: 'retry',
    })
    expect(describeProblem(fromDatabase(null, 'XX000'), 'settings').message).toBe(
      'Your changes were not saved. Try again.',
    )
    expect(describeProblem(new BalanceError('offline'), 'deposit').message).toBe(
      'You are offline. Reconnect to the internet and try again.',
    )
  })

  it('writes every message as a full sentence, with nothing about test mode', () => {
    const messages = [
      ...Object.values(problemMessages).map((item) => item.message),
      ...steps.map((step) => fallbackMessages[step]),
      ...Object.values(returnMessages).filter((message) => message !== 'Funds added'),
    ]
    for (const message of messages) {
      expect(message).toMatch(/^[A-Z].*\.$/)
      expect(message).not.toMatch(/test mode|sandbox|live mode|\btest\b/i)
      expect(message).not.toMatch(/[_{}]|undefined|null/)
    }
  })
})

describe('balance page: loading and failing to load', () => {
  it('shows the shape of the page while it loads', async () => {
    signedInAs('owner')
    const answer = held<unknown>()
    await openBalance(() => answer.promise, '#balance', false)
    expect(screen.getByRole('status', { name: 'Loading your balance' })).toBeInTheDocument()
    expect(buttons(/./)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ textContent: 'Add funds' })]),
    )
    answer.release(balanceState())
    expect(await screen.findByRole('region', { name: 'Your balance' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading your balance' })).not.toBeInTheDocument()
  })

  it('says the balance could not be loaded and loads it on Retry', async () => {
    signedInAs('owner')
    let broken = true
    const user = await openBalance(() => (broken ? refuse(null, 'XX000') : balanceState()))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your balance could not be loaded. Try again.',
    )
    expect(screen.queryByRole('region', { name: 'Your balance' })).not.toBeInTheDocument()
    broken = false
    await user.click(button('Retry'))
    expect(await screen.findByRole('region', { name: 'Your balance' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refuses an answer it cannot read instead of showing wrong money', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ account: account({ available_minor: '8236' }) }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your balance could not be loaded. Try again.',
    )
    expect(page()).not.toHaveTextContent('$')
  })

  it('tells someone who is offline, and reads again when they are back', async () => {
    signedInAs('owner')
    let down = true
    await openBalance(() => (down ? new Error('TypeError: Failed to fetch') : balanceState()))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    down = false
    window.dispatchEvent(new Event('online'))
    expect(await screen.findByRole('region', { name: 'Your balance' })).toBeInTheDocument()
  })

  it('offers to sign in again when the session has expired', async () => {
    signedInAs('owner')
    const user = await openBalance(refuse(null, 'PGRST301'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired.')
    await user.click(button('Sign in again'))
    await screen.findByRole('heading', { name: 'Sign in to your merchant workspace' })
  })
})

describe('balance page: nothing to fund yet', () => {
  it('says one calm thing while balances are switched off', async () => {
    signedInAs('owner')
    await openBalance({ enabled: false, can_manage: true })
    expect(
      await screen.findByText(
        'Balances are not switched on yet. There is nothing you need to do here.',
      ),
    ).toBeInTheDocument()
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('link')).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('$')
  })

  it('sends a workspace without a program to set one up', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ program: null, account: null, activity: [] }))
    expect(
      await screen.findByText(/No Brainer Lab has no affiliate program yet\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up your program' })).toHaveAttribute(
      'href',
      '#program',
    )
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not tell a viewer to set the program up', async () => {
    signedInAs('analyst')
    await openBalance(
      balanceState({ can_manage: false, program: null, account: null, activity: [] }),
    )
    expect(await screen.findByRole('link', { name: 'Open Program' })).toHaveAttribute(
      'href',
      '#program',
    )
  })
})

describe('balance page: the first deposit', () => {
  it('is the whole page before any money has arrived', async () => {
    signedInAs('owner')
    await openBalance(notStarted())
    const first = screen.getByRole('region', { name: 'Make your first deposit' })
    expect(first).toHaveTextContent(
      'Commission is set aside from your balance when a sale happens, and creators are paid only from it. KissMyApps adds a 10% fee on top of each commission.',
    )
    expect(within(first).getByLabelText('Amount')).toHaveValue('100.00')
    expect(within(first).getByText('Minimum $50.00')).toBeInTheDocument()
    expect(within(first).getByRole('button', { name: 'Continue to payment' })).toBeEnabled()
    // Nothing else competes with it.
    expect(screen.queryByRole('region', { name: 'Your balance' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Activity' })).not.toBeInTheDocument()
    expect(buttons('Add funds')).toHaveLength(0)
    expect(page()).not.toHaveTextContent(/test mode/i)
  })

  it('reads the fee and the minimum from the answer', async () => {
    signedInAs('owner')
    await openBalance(notStarted({ fee_bps: 1250, min_deposit_minor: 20000 }))
    const first = screen.getByRole('region', { name: 'Make your first deposit' })
    expect(first).toHaveTextContent('KissMyApps adds a 12.5% fee on top of each commission.')
    expect(within(first).getByText('Minimum $200.00')).toBeInTheDocument()
    expect(within(first).getByLabelText('Amount')).toHaveValue('200.00')
  })

  it('goes to Stripe to pay the amount typed', async () => {
    signedInAs('owner')
    functionAnswers({ deposit: { checkout_url: CHECKOUT } })
    const leave = leaving()
    const user = await openBalance(notStarted())
    const amount = screen.getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '250.50')
    await user.click(button('Continue to payment'))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
    expect(leave).toHaveBeenCalledTimes(1)
    expect(invoked()).toEqual([
      {
        name: 'program-balance',
        body: { action: 'deposit', workspace_id: 'ws-1', amount_minor: 25050 },
      },
    ])
    // Until the browser has left, the button says where it is going and cannot be pressed twice.
    expect(button('Opening Stripe')).toBeDisabled()
  })

  it('holds a first deposit to its minimum without asking the server', async () => {
    signedInAs('owner')
    const leave = leaving()
    const user = await openBalance(notStarted())
    const amount = screen.getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '49.99')
    await user.click(button('Continue to payment'))
    expect(
      await screen.findByText('Enter an amount from $50.00 to $1,000,000.00.'),
    ).toBeInTheDocument()
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(invoked()).toHaveLength(0)
    expect(leave).not.toHaveBeenCalled()
    // Typing again clears the complaint.
    await user.type(amount, '0')
    expect(screen.queryByText(/^Enter an amount from/)).not.toBeInTheDocument()
  })

  it('shows a viewer what the balance is for, and no way to pay', async () => {
    signedInAs('analyst')
    await openBalance(notStarted({ can_manage: false }))
    const first = screen.getByRole('region', { name: 'Make your first deposit' })
    expect(first).toHaveTextContent(
      'An owner or admin of No Brainer Lab can make the first deposit.',
    )
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('treats a payment page that was opened and never paid as still the first deposit', async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({
        account: account({
          available_minor: 0,
          reserved_minor: 0,
          creators_pending_minor: 0,
          creators_approved_minor: 0,
          fees_minor: 0,
          deposited_minor: 0,
          card: null,
          auto_topup: false,
        }),
        activity: [],
        pending_topup: { id: 't-1', amount_minor: 10000, status: 'pending', created_at: AT },
      }),
    )
    expect(screen.getByRole('region', { name: 'Make your first deposit' })).toBeInTheDocument()
    expect(screen.getByText('Minimum $50.00')).toBeInTheDocument()
    // Nobody paid, so nothing is "on its way".
    expect(page()).not.toHaveTextContent('on its way')
  })
})

describe('balance page: a funded balance', () => {
  it('shows where the money stands, each figure with what it is', async () => {
    signedInAs('owner')
    await openBalance()
    expect(figure('Available')).toHaveTextContent('$82.36')
    expect(figure('Available')).toHaveTextContent('Ready for new commissions')
    expect(figure('Available')).toHaveClass('is-lead')
    expect(figure('Reserved')).toHaveTextContent('$17.64')
    expect(figure('Reserved')).toHaveTextContent('For sales still in their hold')
    expect(figure('Approved for creators')).toHaveTextContent('$29.40')
    expect(figure('Approved for creators')).toHaveTextContent('Past the hold and owed to them')
    expect(figure('KissMyApps fees')).toHaveTextContent('$4.41')
    expect(figure('KissMyApps fees')).toHaveTextContent('10% on top of each commission')
    expect(summary()).toHaveTextContent(
      'Commission is set aside when a sale happens, and creators are paid only from this balance.',
    )
    // Money is never shown in minor units.
    expect(page()).not.toHaveTextContent(/8236|1764|2940/)
  })

  it('reads the fee percentage from the answer', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ fee_bps: 750 }))
    expect(figure('KissMyApps fees')).toHaveTextContent('7.5% on top of each commission')
  })

  it('shows the saved card and the top-up rule', async () => {
    signedInAs('owner')
    await openBalance()
    const panel = settings()
    expect(panel).toHaveTextContent('Visa ending 4242')
    expect(panel).toHaveTextContent('Expires 04/29')
    expect(within(panel).getByRole('button', { name: 'Change card' })).toBeEnabled()
    expect(within(panel).getByRole('switch', { name: 'Automatic top-up' })).toBeChecked()
    expect(within(panel).getByLabelText('When the balance falls below')).toHaveValue('50.00')
    expect(within(panel).getByLabelText('Amount to add')).toHaveValue('100.00')
    expect(within(panel).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('lists every movement newest first, with its amount and the balance after it', async () => {
    signedInAs('owner')
    await openBalance()
    const rows = within(activity()).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Fee',
      'Commission set aside',
      'Automatic top-up',
      'Fee returned',
      'Commission returned',
      'Deposit',
    ])
    expect(rows[1]).toHaveTextContent('Ada Okafor · $49.00 sale')
    expect(rows[1]).toHaveTextContent('−$14.70')
    expect(rows[1]).toHaveTextContent('$83.83')
    expect(rows[2]).toHaveTextContent('+$100.00')
    expect(rows[2]).toHaveTextContent('$98.53')
    expect(rows[3]).toHaveTextContent('Lena Hoffmann · $49.00 sale')
    expect(rows[3]).toHaveTextContent('+$1.47')
    // A balance below zero is written with its minus sign.
    expect(rows[3]).toHaveTextContent('−$1.47')
    expect(rows[5]).toHaveTextContent('+$50.00')
    expect(
      within(activity())
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Entry', 'Date', 'Amount', 'Balance after'])
    // Figures that are compared sit in right-aligned columns.
    expect(rows[1].querySelectorAll('td.mc-num-col')).toHaveLength(2)
  })

  it('shows ten movements and more on request', async () => {
    signedInAs('owner')
    const many = Array.from({ length: 35 }, (_, index) =>
      entry({ amount_minor: -100 - index, available_after_minor: 500000 - index }),
    )
    const user = await openBalance(balanceState({ activity: many }))
    expect(within(activity()).getAllByRole('row')).toHaveLength(11)
    expect(activity()).toHaveTextContent('Showing 10 of the latest 35')
    await user.click(button('Show more'))
    expect(within(activity()).getAllByRole('row')).toHaveLength(31)
    await user.click(button('Show more'))
    expect(within(activity()).getAllByRole('row')).toHaveLength(36)
    expect(buttons('Show more')).toHaveLength(0)
  })

  it('keeps the frame of an empty ledger', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ activity: [] }))
    expect(activity()).toHaveTextContent(
      'Nothing has moved yet. Deposits and commissions appear here.',
    )
  })

  it('writes every amount with its currency when the balance is not in dollars', async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({
        program: program({ currency: 'EUR' }),
        account: account({ currency: 'EUR' }),
      }),
    )
    expect(figure('Available')).toHaveTextContent('82.36 EUR')
    expect(figure('Reserved')).toHaveTextContent('17.64 EUR')
    expect(within(activity()).getAllByRole('row')[2]).toHaveTextContent('−14.70 EUR')
    expect(within(activity()).getAllByRole('row')[2]).toHaveTextContent('49.00 EUR sale')
    expect(page()).not.toHaveTextContent('$')
  })

  it('shows a viewer everything and offers them nothing to press', async () => {
    signedInAs('analyst')
    await openBalance(balanceState({ can_manage: false }))
    expect(figure('Available')).toHaveTextContent('$82.36')
    expect(settings()).toHaveTextContent('Visa ending 4242')
    expect(settings()).toHaveTextContent(
      'Automatic top-up is on. When the balance falls below $50.00, $100.00 is added.',
    )
    expect(
      screen.getByText(
        'Only an owner or admin of No Brainer Lab can add funds or change these settings.',
      ),
    ).toBeInTheDocument()
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('tells a viewer when top-up is off', async () => {
    signedInAs('analyst')
    await openBalance(balanceState({ can_manage: false, account: account({ auto_topup: false }) }))
    expect(settings()).toHaveTextContent('Automatic top-up is off.')
  })

  it('marks a card that has expired', async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({ account: account({ card: { ...card, exp_month: 9, exp_year: 2026 } }) }),
    )
    expect(settings()).toHaveTextContent('Expired 09/26')
  })
})

describe('balance page: what needs the merchant', () => {
  const pausedState = (over: Row = {}) =>
    balanceState({
      program: program({ status: 'paused', pause_reason: 'balance_empty' }),
      account: account({ available_minor: 116, auto_topup: false }),
      ...over,
    })

  it('says plainly that the program is paused for its balance, with Add funds', async () => {
    signedInAs('owner')
    const user = await openBalance(pausedState())
    const alert = attention() as HTMLElement
    expect(alert).toHaveTextContent(
      'Your program is paused. The balance could not cover a commission, so new sales earn creators nothing. Add funds and it goes live again.',
    )
    // One Add funds on the page, and it is in the notice.
    expect(buttons('Add funds')).toHaveLength(1)
    await user.click(within(alert).getByRole('button', { name: 'Add funds' }))
    expect(within(dialog()).getByLabelText('Amount')).toBeInTheDocument()
    expect(within(alert).queryByRole('button', { name: 'Change card' })).not.toBeInTheDocument()
  })

  it('does not blame the balance for a program paused for another reason', async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({ program: program({ status: 'paused', pause_reason: 'merchant' }) }),
    )
    expect(attention()).toBeNull()
    expect(buttons('Add funds')).toHaveLength(1)
  })

  it('shows a paused program above the first deposit too', async () => {
    signedInAs('owner')
    await openBalance(
      notStarted({ program: program({ status: 'paused', pause_reason: 'balance_empty' }) }),
    )
    const alert = attention() as HTMLElement
    expect(alert).toHaveTextContent('Your program is paused.')
    // The form below is the way out.
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
    expect(button('Continue to payment')).toBeEnabled()
  })

  it('says what happened to a failed top-up and when the next try is', async () => {
    signedInAs('owner')
    functionAnswers({ card: { checkout_url: CHECKOUT } })
    const leave = leaving()
    const user = await openBalance(
      balanceState({
        account: account({
          topup_problem: {
            code: 'card_declined',
            failed_at: '2026-11-12T12:00:00+00:00',
            retry_at: '2026-11-15T12:00:00+00:00',
          },
        }),
      }),
    )
    const alert = attention() as HTMLElement
    expect(alert).toHaveTextContent(
      'Automatic top-up failed on 12 Nov: your card was declined. We will try again on 15 Nov.',
    )
    expect(within(alert).getByRole('button', { name: 'Add funds' })).toBeEnabled()
    await user.click(within(alert).getByRole('button', { name: 'Change card' }))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
    expect(invoked()[0].body).toEqual({ action: 'card', workspace_id: 'ws-1' })
  })

  it('says when no more tries are coming', async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({
        account: account({
          topup_problem: { code: 'expired_card', failed_at: null, retry_at: null },
        }),
      }),
    )
    expect(attention()).toHaveTextContent(
      'Automatic top-up failed: the card has expired. We will not try again until you add funds or change your card.',
    )
  })

  it("says when the day's limit is holding a top-up back, and what to do meanwhile", async () => {
    signedInAs('owner')
    const resumes = '2026-11-14T12:30:00+00:00'
    const user = await openBalance(
      balanceState({
        account: account({
          available_minor: 1200,
          topup_limit: { per_day: 5, resumes_at: resumes },
        }),
      }),
    )
    const alert = attention() as HTMLElement
    expect(formatDayAndTime(resumes)).toMatch(/^\d{2}:\d{2} on 1[45] Nov$/)
    expect(alert).toHaveTextContent(
      `Automatic top-up is waiting: your card was charged 5 times in 24 hours, the most we charge automatically. It starts again at ${formatDayAndTime(resumes)}. Add funds yourself until then, or raise the top-up amount so each one lasts longer.`,
    )
    expect(within(alert).queryByRole('button', { name: 'Change card' })).not.toBeInTheDocument()
    expect(buttons('Add funds')).toHaveLength(1)
    await user.click(within(alert).getByRole('button', { name: 'Add funds' }))
    expect(within(dialog()).getByLabelText('Amount')).toBeInTheDocument()
  })

  it("keeps quiet about the day's limit while the balance is above the minimum", async () => {
    signedInAs('owner')
    await openBalance(
      balanceState({
        account: account({ topup_limit: { per_day: 5, resumes_at: '2026-11-14T12:30:00+00:00' } }),
      }),
    )
    expect(attention()).toBeNull()
  })

  it('says both when the program is paused and the top-up failed', async () => {
    signedInAs('owner')
    await openBalance(
      pausedState({
        account: account({
          available_minor: 116,
          topup_problem: {
            code: 'insufficient_funds',
            failed_at: '2026-11-10T12:00:00+00:00',
            retry_at: null,
          },
        }),
      }),
    )
    const alert = attention() as HTMLElement
    expect(alert).toHaveTextContent('Your program is paused.')
    expect(alert).toHaveTextContent(
      'The automatic top-up on 10 Nov failed: the card did not have enough funds. We will not try again until you add funds or change your card.',
    )
    expect(
      within(alert)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Change card', 'Add funds'])
  })

  it('tells a viewer without offering them the ways out', async () => {
    signedInAs('analyst')
    await openBalance(pausedState({ can_manage: false }))
    const alert = attention() as HTMLElement
    expect(alert).toHaveTextContent('Your program is paused.')
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('balance page: adding funds', () => {
  it('asks for an amount, starting at the top-up amount', async () => {
    signedInAs('owner')
    const user = await openBalance(balanceState({ account: account({ topup_amount_minor: 7500 }) }))
    await user.click(button('Add funds'))
    expect(dialog()).toHaveTextContent(
      'You pay by card on Stripe. The card is saved for automatic top-ups.',
    )
    expect(within(dialog()).getByLabelText('Amount')).toHaveValue('75.00')
    // After the first deposit the minimum is lower.
    expect(within(dialog()).getByText('Minimum $10.00')).toBeInTheDocument()
    expect(invoked()).toHaveLength(0)
  })

  it('sends the amount in minor units and goes to the address Stripe gave', async () => {
    signedInAs('owner')
    const answer = held<unknown>()
    functionAnswers({ deposit: () => answer.promise })
    const leave = leaving()
    const user = await openBalance()
    await user.click(button('Add funds'))
    const amount = within(dialog()).getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '$1,250.5')
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))

    // While it is on its way: the button says so and nothing can be pressed twice.
    expect(await within(dialog()).findByRole('button', { name: 'Opening Stripe' })).toBeDisabled()
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(leave).not.toHaveBeenCalled()
    expect(invoked()).toEqual([
      {
        name: 'program-balance',
        body: { action: 'deposit', workspace_id: 'ws-1', amount_minor: 125050 },
      },
    ])
    answer.release({ checkout_url: CHECKOUT })
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
    expect(leave).toHaveBeenCalledTimes(1)
    expect(within(dialog()).getByRole('button', { name: 'Opening Stripe' })).toBeDisabled()
  })

  it('refuses an amount outside the limits without asking the server', async () => {
    signedInAs('owner')
    const leave = leaving()
    const user = await openBalance()
    await user.click(button('Add funds'))
    const amount = within(dialog()).getByLabelText('Amount')
    const go = within(dialog()).getByRole('button', { name: 'Continue to payment' })
    for (const [typed, message] of [
      ['9.99', 'Enter an amount from $10.00 to $1,000,000.00.'],
      ['1000000.01', 'Enter an amount from $10.00 to $1,000,000.00.'],
      ['a lot', 'Enter an amount like 100.00.'],
    ]) {
      await user.clear(amount)
      await user.type(amount, typed)
      await user.click(go)
      expect(await within(dialog()).findByText(message)).toBeInTheDocument()
    }
    await user.clear(amount)
    await user.click(go)
    expect(await within(dialog()).findByText('Enter an amount like 100.00.')).toBeInTheDocument()
    expect(invoked()).toHaveLength(0)
    expect(leave).not.toHaveBeenCalled()
  })

  it('does not follow an address that is not Stripe Checkout', async () => {
    signedInAs('owner')
    for (const address of [
      'https://checkout.stripe.com.evil.test/c/pay/cs_live_1',
      'https://evil.test/checkout',
      'http://checkout.stripe.com/c/pay/cs_live_1',
    ]) {
      functionAnswers({ deposit: { checkout_url: address } })
      const leave = leaving()
      const user = await openBalance()
      await user.click(button('Add funds'))
      await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
      expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
        'Stripe could not be opened, so nothing was charged. Try again.',
      )
      expect(leave).not.toHaveBeenCalled()
      expect(within(dialog()).getByRole('button', { name: 'Continue to payment' })).toBeEnabled()
      leave.mockRestore()
      cleanupPage()
    }
  })

  it('says so when the function is switched off', async () => {
    signedInAs('owner')
    functionAnswers({ deposit: new Refusal(503, 'program_balance_disabled') })
    const leave = leaving()
    const user = await openBalance()
    await user.click(button('Add funds'))
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Payments into your balance are not available yet.',
    )
    expect(leave).not.toHaveBeenCalled()
  })

  it('puts an amount the server refuses back at the field', async () => {
    signedInAs('owner')
    functionAnswers({ deposit: new Refusal(400, 'invalid_amount') })
    const user = await openBalance()
    await user.click(button('Add funds'))
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    expect(
      await within(dialog()).findByText('Enter an amount from $10.00 to $1,000,000.00.'),
    ).toBeInTheDocument()
    expect(within(dialog()).getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing was charged when Stripe does not answer, and keeps what was typed', async () => {
    signedInAs('owner')
    let down = true
    functionAnswers({
      deposit: () => {
        if (down) throw new Refusal(502, 'stripe_unavailable')
        return { checkout_url: CHECKOUT }
      },
    })
    const leave = leaving()
    const user = await openBalance()
    await user.click(button('Add funds'))
    const amount = within(dialog()).getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '40')
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Stripe did not respond, so nothing was charged. Try again in a minute.',
    )
    expect(amount).toHaveValue('40')
    down = false
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
    expect(invoked().map((call) => call.body.amount_minor)).toEqual([4000, 4000])
  })

  it('says a request that never arrived did not arrive', async () => {
    signedInAs('owner')
    functionAnswers({ deposit: new TypeError('Failed to fetch') })
    const user = await openBalance()
    await user.click(button('Add funds'))
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
  })

  it('turns read-only when the server says this person may not add funds', async () => {
    signedInAs('owner')
    functionAnswers({ deposit: new Refusal(403, 'owner_or_admin_required') })
    const user = await openBalance()
    await user.click(button('Add funds'))
    await user.click(within(dialog()).getByRole('button', { name: 'Continue to payment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an owner or admin can add funds or change these settings.',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
  })

  it('closes without sending anything on Cancel', async () => {
    signedInAs('owner')
    const user = await openBalance()
    await user.click(button('Add funds'))
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoked()).toHaveLength(0)
  })
})

describe('balance page: changing the card', () => {
  it('goes to Stripe to replace the saved card', async () => {
    signedInAs('owner')
    functionAnswers({ card: { checkout_url: CHECKOUT } })
    const leave = leaving()
    const user = await openBalance()
    await user.click(within(settings()).getByRole('button', { name: 'Change card' }))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
    expect(invoked()).toEqual([
      { name: 'program-balance', body: { action: 'card', workspace_id: 'ws-1' } },
    ])
    expect(within(settings()).getByRole('button', { name: 'Opening Stripe' })).toBeDisabled()
    expect(button('Add funds')).toBeDisabled()
  })

  it('does not follow an address that is not Stripe Checkout', async () => {
    signedInAs('owner')
    functionAnswers({ card: { checkout_url: 'https://billing.stripe.com/p/session/live_1' } })
    const leave = leaving()
    const user = await openBalance()
    await user.click(within(settings()).getByRole('button', { name: 'Change card' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stripe could not be opened, so your card was not changed. Try again.',
    )
    expect(leave).not.toHaveBeenCalled()
    expect(within(settings()).getByRole('button', { name: 'Change card' })).toBeEnabled()
  })

  it('offers Retry when Stripe could not be opened', async () => {
    signedInAs('owner')
    let down = true
    functionAnswers({
      card: () => {
        if (down) throw new Refusal(500, 'internal_error')
        return { checkout_url: CHECKOUT }
      },
    })
    const leave = leaving()
    const user = await openBalance()
    await user.click(within(settings()).getByRole('button', { name: 'Change card' }))
    await screen.findByRole('alert')
    down = false
    await user.click(button('Retry'))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(CHECKOUT))
  })

  it('offers to add a card when none is saved, and keeps top-up off until then', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ account: account({ card: null, auto_topup: false }) }))
    const panel = settings()
    expect(panel).toHaveTextContent('No card saved')
    expect(within(panel).getByRole('button', { name: 'Add card' })).toBeEnabled()
    expect(within(panel).getByRole('switch', { name: 'Automatic top-up' })).toBeDisabled()
    expect(panel).toHaveTextContent('Add a card to turn on automatic top-up.')
  })
})

describe('balance page: automatic top-up settings', () => {
  it('saves only what changed and shows what the server kept', async () => {
    signedInAs('owner')
    const answer = held<unknown>()
    answers({ workspace_program_balance_settings: () => answer.promise })
    const user = await openBalance()
    const floor = within(settings()).getByLabelText('When the balance falls below')
    await user.clear(floor)
    await user.type(floor, '75')
    const save = within(settings()).getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()
    await user.click(save)

    expect(await within(settings()).findByRole('button', { name: 'Saving' })).toBeDisabled()
    expect(button('Add funds')).toBeDisabled()
    expect(sent('balance_settings')).toEqual([
      { p_workspace_id: 'ws-1', p_input: { min_balance_minor: 7500 } },
    ])
    answer.release(balanceState({ account: account({ min_balance_minor: 7500 }) }))
    expect(await screen.findByText('Top-up settings saved')).toBeInTheDocument()
    expect(within(settings()).getByLabelText('When the balance falls below')).toHaveValue('75.00')
    expect(within(settings()).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('switches top-up off, and hides the amounts that no longer apply', async () => {
    signedInAs('owner')
    answers({
      workspace_program_balance_settings: balanceState({
        account: account({ auto_topup: false }),
      }),
    })
    const user = await openBalance()
    await user.click(within(settings()).getByRole('switch', { name: 'Automatic top-up' }))
    expect(within(settings()).queryByLabelText('Amount to add')).not.toBeInTheDocument()
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    await screen.findByText('Top-up settings saved')
    expect(sent('balance_settings')).toEqual([
      { p_workspace_id: 'ws-1', p_input: { auto_topup: false } },
    ])
    expect(within(settings()).getByRole('switch', { name: 'Automatic top-up' })).not.toBeChecked()
  })

  it('switches top-up on with both amounts', async () => {
    signedInAs('owner')
    answers({
      workspace_program_balance_settings: balanceState({
        account: account({ topup_amount_minor: 20000 }),
      }),
    })
    const user = await openBalance(balanceState({ account: account({ auto_topup: false }) }))
    await user.click(within(settings()).getByRole('switch', { name: 'Automatic top-up' }))
    const add = within(settings()).getByLabelText('Amount to add')
    await user.clear(add)
    await user.type(add, '200')
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    await screen.findByText('Top-up settings saved')
    expect(sent('balance_settings')[0].p_input).toEqual({
      auto_topup: true,
      topup_amount_minor: 20000,
    })
  })

  it('checks the amounts before asking the server', async () => {
    signedInAs('owner')
    const user = await openBalance()
    const floor = within(settings()).getByLabelText('When the balance falls below')
    const add = within(settings()).getByLabelText('Amount to add')
    await user.clear(floor)
    await user.type(floor, 'fifty')
    await user.clear(add)
    await user.type(add, '5')
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(
      await within(settings()).findByText(
        'Enter the amount the balance should not fall below, like 50.00.',
      ),
    ).toBeInTheDocument()
    expect(
      within(settings()).getByText('Enter an amount from $10.00 to $1,000,000.00.'),
    ).toBeInTheDocument()
    expect(floor).toHaveAttribute('aria-invalid', 'true')
    expect(add).toHaveAttribute('aria-invalid', 'true')
    expect(sent('balance_settings')).toHaveLength(0)
    // Fixing a field clears its complaint.
    await user.clear(add)
    await user.type(add, '50')
    expect(
      within(settings()).queryByText('Enter an amount from $10.00 to $1,000,000.00.'),
    ).not.toBeInTheDocument()
  })

  it('puts an amount the server refuses at its field and keeps what was typed', async () => {
    signedInAs('owner')
    answers({ workspace_program_balance_settings: refuse('invalid_topup_amount_minor') })
    const user = await openBalance()
    const add = within(settings()).getByLabelText('Amount to add')
    await user.clear(add)
    await user.type(add, '15')
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(
      await within(settings()).findByText('Enter the amount to add, like 100.00.'),
    ).toBeInTheDocument()
    expect(add).toHaveValue('15')
    expect(add).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('explains that top-up needs a card when the server says so', async () => {
    signedInAs('owner')
    answers({ workspace_program_balance_settings: refuse('card_required') })
    const user = await openBalance(balanceState({ account: account({ auto_topup: false }) }))
    await user.click(within(settings()).getByRole('switch', { name: 'Automatic top-up' }))
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Add a card before you turn on automatic top-up.',
    )
    expect(buttons('Retry')).toHaveLength(0)
  })

  it('reads the balance again when the server says it has not started', async () => {
    signedInAs('owner')
    let reads = 0
    answers({ workspace_program_balance_settings: refuse('balance_not_started') })
    const user = await openBalance(() => {
      reads += 1
      return reads === 1 ? balanceState() : notStarted()
    })
    await user.click(within(settings()).getByRole('switch', { name: 'Automatic top-up' }))
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText(
        'Add funds first. Your card and top-up settings start with your first deposit.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Make your first deposit' })).toBeInTheDocument()
    expect(sent('balance')).toHaveLength(2)
  })

  it('turns read-only when the database says this person may not change settings', async () => {
    signedInAs('owner')
    answers({ workspace_program_balance_settings: refuse(null, '42501') })
    const user = await openBalance()
    await user.click(within(settings()).getByRole('switch', { name: 'Automatic top-up' }))
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an owner or admin can add funds or change these settings.',
    )
    expect(within(page()).queryByRole('button')).not.toBeInTheDocument()
    expect(within(page()).queryByRole('switch')).not.toBeInTheDocument()
  })

  it('offers Retry when the save never got an answer, and keeps what was typed', async () => {
    signedInAs('owner')
    let down = true
    answers({
      workspace_program_balance_settings: () =>
        down
          ? new Error('TypeError: Failed to fetch')
          : balanceState({ account: account({ min_balance_minor: 2000 }) }),
    })
    const user = await openBalance()
    const floor = within(settings()).getByLabelText('When the balance falls below')
    await user.clear(floor)
    await user.type(floor, '20')
    await user.click(within(settings()).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(floor).toHaveValue('20')
    down = false
    await user.click(button('Retry'))
    await screen.findByText('Top-up settings saved')
    expect(sent('balance_settings')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('balance page: coming back from Stripe', () => {
  const onItsWay = { id: 't-1', amount_minor: 10000, status: 'pending', created_at: AT }

  it('shows a paid deposit as on its way and refreshes quietly until it lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      await openBalance(() => {
        reads += 1
        if (reads <= 2) return balanceState({ pending_topup: onItsWay })
        return balanceState({
          account: account({ available_minor: 18236, deposited_minor: 25000 }),
          activity: [
            entry({
              kind: 'deposit',
              amount_minor: 10000,
              available_after_minor: 18236,
              creator_name: null,
              sale_amount_minor: null,
              topup_kind: 'deposit',
            }),
            ...ledger(),
          ],
        })
      }, '#balance?deposit=done')
      expect(
        await screen.findByText(
          '$100.00 is on its way to your balance. This usually takes a few seconds.',
        ),
      ).toBeInTheDocument()
      // Stripe's answer has left the address bar, so a reload does not announce it again.
      expect(window.location.hash).toBe('#balance')
      expect(figure('Available')).toHaveTextContent('$82.36')

      await vi.advanceTimersByTimeAsync(3_000)
      await waitFor(() => expect(sent('balance')).toHaveLength(2))
      expect(screen.getByText(/is on its way to your balance/)).toBeInTheDocument()

      await vi.advanceTimersByTimeAsync(3_000)
      expect(await screen.findByText('Funds added')).toBeInTheDocument()
      expect(screen.queryByText(/is on its way to your balance/)).not.toBeInTheDocument()
      expect(figure('Available')).toHaveTextContent('$182.36')
      // Once it has landed the page stops asking every few seconds.
      await vi.advanceTimersByTimeAsync(9_000)
      expect(sent('balance')).toHaveLength(3)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so at once when the deposit has already landed', async () => {
    signedInAs('owner')
    await openBalance(balanceState(), '#balance?deposit=done')
    expect(await screen.findByText('Funds added')).toBeInTheDocument()
    expect(screen.queryByText(/is on its way to your balance/)).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#balance')
  })

  it('keeps what is on screen when a quiet refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      await openBalance(() => {
        reads += 1
        return reads === 1
          ? balanceState({ pending_topup: onItsWay })
          : new Error('TypeError: Failed to fetch')
      }, '#balance?deposit=done')
      await screen.findByText(/is on its way to your balance/)
      await vi.advanceTimersByTimeAsync(3_000)
      await waitFor(() => expect(sent('balance')).toHaveLength(2))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(figure('Available')).toHaveTextContent('$82.36')
      expect(screen.getByText(/is on its way to your balance/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing was added when the person cancelled on Stripe', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ pending_topup: onItsWay }), '#balance?deposit=canceled')
    expect(
      await screen.findByText('You cancelled on Stripe, so nothing was added.'),
    ).toBeInTheDocument()
    // The payment page they left is not a deposit on its way.
    expect(screen.queryByText(/is on its way to your balance/)).not.toBeInTheDocument()
    expect(screen.queryByText('Funds added')).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#balance')
  })

  it('does not call an abandoned payment page a deposit on its way', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ pending_topup: onItsWay }))
    expect(screen.queryByText(/is on its way to your balance/)).not.toBeInTheDocument()
  })

  it('shows a charge Stripe is still working on, whoever started it', async () => {
    signedInAs('owner')
    await openBalance(balanceState({ pending_topup: { ...onItsWay, status: 'processing' } }))
    expect(
      screen.getByText('$100.00 is on its way to your balance. This usually takes a few seconds.'),
    ).toBeInTheDocument()
  })

  it('says the card was saved, or that it was not changed', async () => {
    signedInAs('owner')
    await openBalance(balanceState(), '#balance?card=done')
    expect(
      await screen.findByText('Your card was saved on Stripe. It can take a moment to show here.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Funds added')).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#balance')
    cleanupPage()

    await openBalance(balanceState(), '#balance?card=canceled')
    expect(
      await screen.findByText('You cancelled on Stripe, so your card was not changed.'),
    ).toBeInTheDocument()
  })

  it('knows a card change from a deposit when the address does not say which it was', async () => {
    signedInAs('owner')
    functionAnswers({ card: { checkout_url: CHECKOUT } })
    const leave = leaving()
    const user = await openBalance()
    await user.click(within(settings()).getByRole('button', { name: 'Change card' }))
    await waitFor(() => expect(leave).toHaveBeenCalled())
    cleanupPage()

    // Stripe sends the browser back to the same tab.
    await openBalance(balanceState(), '#balance?deposit=done')
    expect(
      await screen.findByText('Your card was saved on Stripe. It can take a moment to show here.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Funds added')).not.toBeInTheDocument()
  })
})

describe('balance page: staying current', () => {
  it('looks again by itself, without touching a form that is being edited', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      const user = await openBalance(() => {
        reads += 1
        return reads === 1
          ? balanceState()
          : balanceState({ account: account({ available_minor: 6619 }) })
      })
      const floor = within(settings()).getByLabelText('When the balance falls below')
      await user.clear(floor)
      await user.type(floor, '75')
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(figure('Available')).toHaveTextContent('$66.19'))
      expect(floor).toHaveValue('75')
      expect(within(settings()).getByRole('button', { name: 'Save' })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('program page: the balance in its wording', () => {
  const pausedProgram = (over: Row = {}) => {
    const base = programBackendFixture.state_admin_paused as Row
    return {
      ...base,
      ...over,
      program: { ...(base.program as Row), pause_reason: 'balance_empty', review_note: null },
    }
  }

  async function openProgram(get: Answer) {
    answers({
      workspace_program_get: get,
      workspace_program_tracking: (programBackendFixture.tracking as Row) ?? {},
    })
    window.location.hash = '#program'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Affiliate program', level: 1 })
    await screen.findByText('Paused')
    return user
  }

  it('reads a program paused for its balance', () => {
    expect(readState(pausedProgram()).program?.pause_reason).toBe('balance_empty')
  })

  it('says a paused-for-balance program resumes with funds, and links to Balance', async () => {
    signedInAs('owner')
    await openProgram(pausedProgram())
    const banner = document.querySelector('.mc-prog-banner') as HTMLElement
    expect(banner).toHaveTextContent(
      'This program is paused because its balance could not cover a commission. It goes live again when you add funds.',
    )
    expect(within(banner).getByRole('link', { name: 'Add funds' })).toHaveAttribute(
      'href',
      '#balance',
    )
    expect(banner).not.toHaveTextContent('You paused this program')
  })

  it('points a viewer at the Balance page without telling them to pay', async () => {
    signedInAs('analyst')
    await openProgram(pausedProgram({ can_manage: false }))
    const banner = document.querySelector('.mc-prog-banner') as HTMLElement
    expect(within(banner).getByRole('link', { name: 'Open Balance' })).toHaveAttribute(
      'href',
      '#balance',
    )
  })

  it('says to add funds when publishing or resuming needs a balance', async () => {
    const refused = readFailure({ code: '22023', details: 'balance_required', message: 'x' })
    expect(describeProgramProblem(refused, 'publish')).toEqual({
      code: 'balance_required',
      message: 'Add funds before you publish.',
      recovery: 'balance',
    })
    expect(describeProgramProblem(refused, 'status')).toEqual({
      code: 'balance_required',
      message: 'Add funds before you resume.',
      recovery: 'balance',
    })

    signedInAs('owner')
    answers({ workspace_program_set_status: refuse('balance_required') })
    // A program paused for its balance has no Resume: funds bring it back by themselves.
    await openProgram(pausedProgram())
    await screen.findByRole('link', { name: 'Add funds' })
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    cleanupPage()

    // One the merchant paused can be resumed, and is refused while the balance is empty.
    const byMerchant = pausedProgram()
    const user = await openProgram({
      ...byMerchant,
      program: { ...(byMerchant.program as Row), pause_reason: 'merchant' },
    })
    await user.click(await screen.findByRole('button', { name: 'Resume' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Add funds before you resume.')
    expect(within(alert).getByRole('link', { name: 'Add funds' })).toHaveAttribute(
      'href',
      '#balance',
    )
  })
})

describe('the balance of a program that pays for events', () => {
  const reward = (over: Row = {}) =>
    entry({
      creator_name: 'Mira Maker',
      sale_amount_minor: null,
      amount_minor: -200,
      reward_label: 'Account created',
      ...over,
    })
  const row = (over: Row) => readBalance(balanceState({ activity: [over] })).activity[0]

  it('reads which reward a line is for, and nothing where there is none', () => {
    expect(row(reward()).reward_label).toBe('Account created')
    expect(row(reward({ reward_label: '  Trial started ' })).reward_label).toBe('Trial started')
    // A sale's line says null; a line from before rewards existed has no such key.
    for (const none of [null, '', '   ', 7, undefined])
      expect('reward_label' in row(entry({ reward_label: none }))).toBe(false)
    expect('reward_label' in row(entry())).toBe(false)
  })

  it('names a reward and who earned it on every line about it', () => {
    for (const kind of [
      'commission_reserved',
      'fee_reserved',
      'commission_returned',
      'fee_returned',
    ])
      expect(entryDetail(row(reward({ kind })), 'USD')).toBe(
        'Reward for Mira Maker: Account created',
      )
    expect(entryDetail(row(reward({ creator_name: null })), 'USD')).toBe('Reward: Account created')
    // A sale's line reads as it always did, whatever else the row carries.
    expect(entryDetail(row(entry({ reward_label: null })), 'USD')).toBe('Ada Okafor · $49.00 sale')
    // A label never turns a deposit or an adjustment into a reward.
    expect(entryDetail(row(reward({ kind: 'adjustment', note: 'Goodwill credit' })), 'USD')).toBe(
      'Goodwill credit',
    )
    expect(entryDetail(row(reward({ kind: 'deposit', topup_kind: 'auto' })), 'USD')).toBeNull()
  })

  it('lists reward lines beside sale lines, in normal units', async () => {
    signedInAs('owner')
    const user = await openBalance(rewardsBackendFixture.workspace_program_balance_with_rewards)
    await user.click(within(activity()).getByRole('button', { name: 'Show more' }))
    const rows = within(activity()).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Fee' + 'Reward for Ben Creator: Trial started')
    expect(rows[0]).toHaveTextContent('−$0.50')
    expect(rows[1]).toHaveTextContent(
      'Commission set aside' + 'Reward for Ben Creator: Trial started',
    )
    expect(rows[1]).toHaveTextContent('−$5.00')
    expect(rows[14]).toHaveTextContent('Fee returned' + 'Reward for Ada Okafor: Account created')
    expect(rows[14]).toHaveTextContent('+$0.20')
    expect(rows[15]).toHaveTextContent(
      'Commission returned' + 'Reward for Ada Okafor: Account created',
    )
    expect(rows[15]).toHaveTextContent('+$2.00')
    expect(rows[25]).toHaveTextContent('Commission set aside' + 'Ada Okafor · $49.00 sale')
    // With rewards on the balance, the summary no longer speaks of sales alone.
    expect(figure('Reserved')).toHaveTextContent('For commissions still in their hold')
    expect(page()).toHaveTextContent(
      'Commission is set aside when a creator earns it, and creators are paid only from this balance.',
    )
    expect(page()).not.toHaveTextContent('reward_label')
    expect(page()).not.toHaveTextContent(/\btest\b/i)
  })

  it('is the page as it was for an answer from before rewards existed', async () => {
    signedInAs('owner')
    await openBalance()
    const rows = within(activity()).getAllByRole('row').slice(1)
    expect(rows[1]).toHaveTextContent('Commission set aside' + 'Ada Okafor · $49.00 sale')
    expect(activity()).not.toHaveTextContent('Reward')
    expect(figure('Reserved')).toHaveTextContent('For sales still in their hold')
  })
})

/** Takes the page down between two visits inside one test. */
function cleanupPage() {
  cleanup()
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.invoked = []
}
