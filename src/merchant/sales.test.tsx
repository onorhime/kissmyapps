import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { formatShortDay } from './balance'
import { formatWhen } from './connections'
import { MerchantApp } from './MerchantApp'
import { ProgramError, readFailure } from './programs'
import { href, parseRoute } from './routes'
import {
  describeProblem,
  fallbackMessages,
  hasCommission,
  PAGE_SIZE,
  problemMessages,
  readSales,
  refundLine,
  saleStatus,
  summaryLine,
  withNextPage,
} from './sales'
import type { SalesStep, SaleStatus } from './sales'
import { salesFixture, salesFixtureMember } from './sales.fixture'

type Args = Record<string, unknown>
type Answer = unknown | ((args: Args) => unknown)

// A stand-in for the Supabase client: auth with listeners, the context rpcs, and the
// workspace_program_* functions answered from a table.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    context: null as unknown,
    table: {} as Record<string, unknown>,
    calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
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
  return { state, client: { auth, rpc } }
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
  user: { id: 'user-1', email: 'owner@example.test', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const DAY = 24 * 60
const HOLD = '2026-12-13T12:00:00.000000+00:00'

const PROGRAM = { id: 'prog-1', slug: 'speaksix', name: 'SpeakSix', status: 'live' }
const SUMMARY = {
  days: 30,
  sales: 70,
  sales_amount_minor: 343000,
  commission_minor: 102900,
  fee_minor: 10290,
}

type Row = Record<string, unknown>

/** One sale, as the database returns it. */
const sale = (over: Row = {}): Row => ({
  sale_id: 's-ada-1',
  paid_at: ago(60),
  amount_minor: 4900,
  currency: 'USD',
  refunded_minor: 0,
  member_id: 'm-ada',
  creator_name: 'Ada Okafor',
  link_name: 'TikTok',
  match_source: 'metadata',
  status: 'pending',
  reason: null,
  commission_minor: 1470,
  fee_minor: 147,
  hold_until: HOLD,
  ...over,
})

const pending = sale()
const approved = sale({
  sale_id: 's-kwame-1',
  paid_at: ago(40 * DAY),
  amount_minor: 9900,
  member_id: 'm-kwame',
  creator_name: 'Kwame Mensah',
  link_name: 'YouTube',
  status: 'approved',
  commission_minor: 2970,
  fee_minor: 297,
})
const returned = sale({
  sale_id: 's-lena-1',
  paid_at: ago(6 * DAY),
  refunded_minor: 4900,
  member_id: 'm-lena',
  creator_name: 'Lena Hoffmann',
  link_name: 'Newsletter',
  status: 'returned',
  commission_minor: 0,
  fee_minor: 0,
})
const unfunded = sale({
  sale_id: 's-mei-1',
  paid_at: ago(7 * DAY),
  member_id: 'm-mei',
  creator_name: 'Mei Tanaka',
  link_name: 'Instagram',
  status: 'not_earned',
  reason: 'balance_empty',
  commission_minor: 0,
  fee_minor: 0,
  hold_until: null,
})
const early = sale({
  sale_id: 's-ada-0',
  paid_at: ago(30 * DAY),
  link_name: null,
  match_source: 'email',
  status: 'not_judged',
  commission_minor: null,
  fee_minor: null,
  hold_until: null,
})
const partRefund = sale({
  sale_id: 's-ada-2',
  paid_at: ago(10 * DAY),
  amount_minor: 9900,
  refunded_minor: 2000,
  link_name: 'Instagram',
  commission_minor: 2370,
  fee_minor: 237,
})
const mixed = [pending, approved, returned, unfunded, partRefund, early]

/** A workspace_program_sales answer. */
const answer = (rows: Row[] = [], over: Row = {}): Row => ({
  program: PROGRAM,
  currency: 'USD',
  summary: SUMMARY,
  sales: rows,
  next_before: null,
  ...over,
})

/** A workspace_program_creators answer with the people a filter may name. */
const people = (...names: Array<[string, string]>) => ({
  can_manage: true,
  program: { ...PROGRAM, approval_mode: 'manual', marketplace_listed: true },
  counts: { pending: 0, active: names.length, ended: 0 },
  creators: names.map(([member_id, name]) => ({ member_id, status: 'active', name })),
})

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
  fake.state.session = { user: { id: 'user-1', email: 'owner@example.test' } }
  fake.state.context = context(role, projects)
}

function answers(table: Record<string, Answer>) {
  fake.state.table = { ...fake.state.table, ...table }
}

const sent = (name: 'sales' | 'creators' = 'sales') =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)
const asked = () => sent().map((args: Args) => args.p_input)

async function openSales(list: Answer = answer(mixed), hash = '#sales', wait = true) {
  answers({ workspace_program_sales: list })
  window.location.hash = hash
  const user = userEvent.setup()
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Sales', level: 1 })
  if (wait)
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Loading your sales' })).not.toBeInTheDocument(),
    )
  return user
}

const page = () => document.querySelector('.mc-sales') as HTMLElement
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const buttons = (name: string | RegExp) => screen.queryAllByRole('button', { name })
const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)
const rowOf = (id: string) => document.querySelector(`[data-sale="${id}"]`) as HTMLElement
const cells = (id: string) =>
  within(rowOf(id))
    .getAllByRole('cell')
    .map((cell) => cell.textContent)
const when = (time: unknown) => formatWhen(time as string, Date.now())

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.table = {}
  fake.state.context = context('owner')
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('sales route', () => {
  it('lives at #sales', () => {
    expect(parseRoute('#sales')).toEqual({ name: 'sales' })
    expect(parseRoute('#/sales')).toEqual({ name: 'sales' })
    expect(href({ name: 'sales' })).toBe('#sales')
    expect(parseRoute(href({ name: 'sales' }))).toEqual({ name: 'sales' })
  })

  it('carries the one creator whose sales to show', () => {
    expect(parseRoute('#sales?creator=m-ada')).toEqual({ name: 'sales', creator: 'm-ada' })
    expect(href({ name: 'sales', creator: 'm-ada' })).toBe('#sales?creator=m-ada')
    const id = '0a6f2f4e-58d1-4a62-9a35-2f1c6f0d7a11'
    expect(parseRoute(href({ name: 'sales', creator: id }))).toEqual({ name: 'sales', creator: id })
    // Whatever is put there is one value, never more of the address.
    const odd = 'a b&creator=x#y'
    expect(href({ name: 'sales', creator: odd })).toBe('#sales?creator=a%20b%26creator%3Dx%23y')
    expect(parseRoute(href({ name: 'sales', creator: odd }))).toEqual({
      name: 'sales',
      creator: odd,
    })
  })

  it('treats an empty filter, and anything else in the address, as no filter', () => {
    expect(parseRoute('#sales?creator=')).toEqual({ name: 'sales' })
    expect(parseRoute('#sales?creator=%20%20')).toEqual({ name: 'sales' })
    expect(parseRoute('#sales?member=m-ada')).toEqual({ name: 'sales' })
    expect(parseRoute('#sales/m-ada')).toEqual({ name: 'sales' })
  })

  it('is in the Affiliates group between Creators and Rewards', async () => {
    signedInAs('owner')
    await openSales()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Sales' })
    expect(link).toHaveAttribute('href', '#sales')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Sales')
    const group = document.getElementById('mc-nav-affiliates') as HTMLElement
    expect(
      within(group)
        .getAllByRole('link')
        .map((item) => item.textContent),
    ).toEqual(['Program', 'Creators', 'Sales', 'Rewards', 'Balance'])
    // The project the person was in keeps its menu.
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })

  it('stays the current menu entry while one creator is shown', async () => {
    signedInAs('owner')
    await openSales(answer([pending]), '#sales?creator=m-ada')
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Sales' })).toHaveAttribute('aria-current', 'page')
  })

  it('is reachable in a workspace with no project', async () => {
    signedInAs('owner', [])
    await openSales(answer([pending]))
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Sales' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('asks the database as the signed-in user, for this workspace, for the first page', async () => {
    signedInAs('owner')
    await openSales()
    expect(sent()).toEqual([
      { p_workspace_id: 'ws-1', p_input: { limit: PAGE_SIZE, before: null, member_id: null } },
    ])
    expect(PAGE_SIZE).toBeGreaterThanOrEqual(1)
    expect(PAGE_SIZE).toBeLessThanOrEqual(100)
  })
})

describe('reading answers', () => {
  it('reads every answer the contract describes', () => {
    for (const name of ['sales_mixed', 'sales_next', 'sales_one_creator', 'sales_empty']) {
      const read = readSales(salesFixture[name])
      expect(read.program).toEqual({
        id: expect.any(String),
        slug: 'speaksix',
        name: 'SpeakSix',
        status: 'live',
      })
      expect(read.currency).toBe('USD')
      expect(Object.keys(read.summary!).sort()).toEqual([
        'commission_minor',
        'days',
        'fee_minor',
        'sales',
        'sales_amount_minor',
      ])
      expect(read.summary!.days).toBe(30)
      const sent = (salesFixture[name] as { sales: unknown[] }).sales
      expect(read.sales).toHaveLength(sent.length)
      for (const row of read.sales) {
        expect(Object.keys(row).sort()).toEqual([
          'amount_minor',
          'commission_minor',
          'creator_name',
          'currency',
          'fee_minor',
          'hold_until',
          'link_name',
          'match_source',
          'member_id',
          'paid_at',
          'promotion_code',
          'reason',
          'refunded_minor',
          'sale_id',
          'source',
          'status',
          'store',
        ])
        // An answer from before in-app purchases lists Stripe sales, with no store and no code.
        expect(row).toMatchObject({ source: 'stripe', store: null, promotion_code: null })
        expect(row.status).not.toBe('other')
        expect(Number.isFinite(Date.parse(row.paid_at))).toBe(true)
        expect(Number.isSafeInteger(row.amount_minor)).toBe(true)
        expect(row.reason !== null).toBe(row.status === 'not_earned')
      }
    }
  })

  it('reads every status, and whether there is more to ask for', () => {
    const first = readSales(salesFixture.sales_mixed)
    expect(new Set(first.sales.map((row) => row.status))).toEqual(
      new Set<SaleStatus>(['pending', 'approved', 'returned', 'not_earned', 'not_judged']),
    )
    expect(first.next_before).toBe(first.sales.at(-1)!.paid_at)
    expect(readSales(salesFixture.sales_next).next_before).toBeNull()
    const one = readSales(salesFixture.sales_one_creator)
    expect(new Set(one.sales.map((row) => row.member_id))).toEqual(new Set([salesFixtureMember]))
  })

  it('reads a workspace without a program as nothing to list', () => {
    expect(readSales(salesFixture.sales_no_program)).toEqual({
      program: null,
      currency: 'USD',
      summary: null,
      sales: [],
      next_before: null,
    })
    expect(readSales({ sales: [] }).program).toBeNull()
    // An archived program is history, and so are its sales here.
    const archived = readSales(answer(mixed, { program: { ...PROGRAM, status: 'archived' } }))
    expect(archived.program).toBeNull()
    expect(archived.sales).toEqual([])
  })

  it('reads a sale the way the database writes it', () => {
    const stamped = sale({
      paid_at: '2026-11-13T09:41:07.120045+00:00',
      hold_until: '2026-12-13T09:41:07.120045+00:00',
    })
    const [read] = readSales(answer([stamped])).sales
    // Before Phase 8 the database names no source: every sale came from Stripe.
    expect(read).toEqual({ ...stamped, source: 'stripe', store: null, promotion_code: null })
    expect(new Date(read.paid_at).toISOString()).toBe('2026-11-13T09:41:07.120Z')
  })

  it('keeps nothing it was not told to show, a buyer least of all', () => {
    const read = readSales(
      answer([
        sale({
          buyer_email: 'buyer@example.test',
          customer_name: 'Bea Buyer',
          payment_intent_id: 'pi_123',
          stripe_customer_id: 'cus_123',
        }),
      ]),
    )
    const written = JSON.stringify(read)
    for (const leak of ['buyer@example.test', 'Bea Buyer', 'pi_123', 'cus_123'])
      expect(written).not.toContain(leak)
    expect(Object.keys(read.sales[0]).sort()).toEqual(
      [...Object.keys(pending), 'source', 'store', 'promotion_code'].sort(),
    )
  })

  it('fills what a thin row leaves out and drops a row it cannot trust', () => {
    const read = readSales(
      answer([
        { sale_id: 's-1', paid_at: '2026-11-01T10:00:00Z', amount_minor: 4900, status: 'approved' },
        sale({ sale_id: 's-2', status: 'chargeback_won' }),
        sale({ sale_id: '' }),
        sale({ sale_id: 7 }),
        sale({ sale_id: 's-3', amount_minor: '4900' }),
        sale({ sale_id: 's-4', amount_minor: 49.5 }),
        sale({ sale_id: 's-5', amount_minor: -4900 }),
        sale({ sale_id: 's-6', paid_at: 'yesterday' }),
        sale({ sale_id: 's-7', paid_at: null }),
        sale({ sale_id: 's-8', status: null }),
        'nonsense' as unknown as Row,
        null as unknown as Row,
      ]),
    )
    expect(read.sales.map((row) => row.sale_id)).toEqual(['s-1', 's-2'])
    expect(read.sales[0]).toEqual({
      sale_id: 's-1',
      paid_at: '2026-11-01T10:00:00Z',
      amount_minor: 4900,
      currency: null,
      refunded_minor: 0,
      member_id: null,
      creator_name: null,
      link_name: null,
      match_source: null,
      status: 'approved',
      reason: null,
      commission_minor: null,
      fee_minor: null,
      hold_until: null,
      source: 'stripe',
      store: null,
      promotion_code: null,
    })
    // A status from a later version is still a sale.
    expect(read.sales[1].status).toBe('other')
  })

  it('reads a commission as whole minor units or as none', () => {
    const [read] = readSales(
      answer([sale({ commission_minor: '1470', fee_minor: 14.7, refunded_minor: -1 })]),
    ).sales
    expect(read.commission_minor).toBeNull()
    expect(read.fee_minor).toBeNull()
    expect(read.refunded_minor).toBe(0)
    expect(hasCommission(read)).toBe(false)
  })

  it('never shows half a summary', () => {
    expect(readSales(answer([pending])).summary).toEqual(SUMMARY)
    for (const wrong of [
      null,
      undefined,
      'summary',
      [],
      {},
      { ...SUMMARY, fee_minor: undefined },
      { ...SUMMARY, commission_minor: '102900' },
      { ...SUMMARY, sales_amount_minor: -1 },
      { ...SUMMARY, sales: 1.5 },
    ])
      expect(readSales(answer([pending], { summary: wrong })).summary).toBeNull()
    // The span is the database's to say; one it does not say is the 30 days it promised.
    expect(readSales(answer([], { summary: { ...SUMMARY, days: 7 } })).summary!.days).toBe(7)
    for (const days of [undefined, 0, -3, 'thirty', 5000])
      expect(readSales(answer([], { summary: { ...SUMMARY, days } })).summary!.days).toBe(30)
  })

  it('reads the currency and where the next page starts', () => {
    expect(readSales(answer([], { currency: 'eur' })).currency).toBe('EUR')
    for (const wrong of [null, undefined, 'dollars', 840])
      expect(readSales(answer([], { currency: wrong })).currency).toBe('USD')
    expect(readSales(answer([pending], { next_before: pending.paid_at })).next_before).toBe(
      pending.paid_at,
    )
    for (const wrong of [undefined, null, '', 'later', 12])
      expect(readSales(answer([pending], { next_before: wrong })).next_before).toBeNull()
  })

  it('refuses an answer it cannot trust', () => {
    for (const wrong of [
      null,
      'ok',
      [],
      {},
      { program: PROGRAM },
      { program: PROGRAM, sales: 'none' },
      { program: PROGRAM, sales: {} },
      { sales: [], program: { ...PROGRAM, status: 'sideways' } },
      { sales: [], program: { status: 'live' } },
      { sales: [], program: { ...PROGRAM, id: '' } },
      { sales: [], program: 'speaksix' },
    ])
      expect(() => readSales(wrong)).toThrow(ProgramError)
  })

  it('adds a page to the list without listing a sale twice', () => {
    const first = readSales(answer([pending, approved], { next_before: approved.paid_at }))
    const next = readSales(answer([approved, returned], { next_before: returned.paid_at }))
    const both = withNextPage(first, next)
    expect(both.sales.map((row) => row.sale_id)).toEqual(['s-ada-1', 's-kwame-1', 's-lena-1'])
    expect(both.next_before).toBe(returned.paid_at)
    expect(both.summary).toEqual(first.summary)
    expect(withNextPage(both, readSales(answer([early]))).next_before).toBeNull()
    // A page that starts where the last one did would be asked for forever.
    expect(withNextPage(first, { ...next, next_before: first.next_before }).next_before).toBeNull()
  })
})

describe('the words on the page', () => {
  const words = (over: Row) => saleStatus(readSales(answer([sale(over)])).sales[0])

  it('has a plain word for every status', () => {
    expect(words({ status: 'pending' })).toEqual({
      label: `Pending until ${formatShortDay(HOLD)}`,
      tone: 'info',
      detail: null,
    })
    expect(words({ status: 'pending', hold_until: null }).label).toBe('Pending')
    expect(words({ status: 'approved' })).toEqual({
      label: 'Approved',
      tone: 'positive',
      detail: null,
    })
    expect(words({ status: 'returned', refunded_minor: 4900 })).toEqual({
      label: 'Returned',
      tone: 'neutral',
      detail: 'The sale was refunded',
    })
    expect(words({ status: 'returned' }).detail).toBe('Back in your balance')
    expect(words({ status: 'not_judged', commission_minor: null })).toEqual({
      label: 'No commission',
      tone: 'neutral',
      detail: 'From before commissions started',
    })
    expect(words({ status: 'something_new' })).toEqual({
      label: 'Recorded',
      tone: 'neutral',
      detail: null,
    })
  })

  it('says why a sale earned nothing, for every reason the database gives', () => {
    const reasons: Record<string, string> = {
      balance_empty: 'Your balance could not cover it',
      program_paused: 'Your program was paused',
      not_a_member: 'The creator was not in your program',
      outside_duration: 'After the commission period',
      currency_mismatch: 'Paid in another currency',
      zero_amount: 'The commission came to zero',
      refunded: 'The sale was refunded',
      no_creator: 'No creator was credited',
    }
    for (const [reason, detail] of Object.entries(reasons)) {
      const said = words({ status: 'not_earned', reason })
      expect(said.label).toBe('No commission')
      expect(said.detail).toBe(detail)
      // The two the merchant can do something about stand out.
      expect(said.tone).toBe(
        reason === 'balance_empty' || reason === 'program_paused' ? 'warning' : 'neutral',
      )
    }
    // A reason from a later version is not shown as a code.
    expect(words({ status: 'not_earned', reason: 'new_rule_17' })).toEqual({
      label: 'No commission',
      tone: 'neutral',
      detail: null,
    })
    expect(words({ status: 'not_earned', reason: null }).detail).toBeNull()
  })

  it('never shows a code, minor units, or speaks of test mode', () => {
    const said = [
      'pending',
      'approved',
      'returned',
      'not_judged',
      'other',
      ...[
        'balance_empty',
        'program_paused',
        'not_a_member',
        'outside_duration',
        'currency_mismatch',
        'zero_amount',
        'refunded',
        'no_creator',
      ].map((reason) => `not_earned:${reason}`),
    ].flatMap((key) => {
      const [status, reason = null] = key.split(':')
      const { label, detail } = words({ status, reason })
      return detail ? [label, detail] : [label]
    })
    for (const text of [...said, summaryLine({ days: 30 }, false), summaryLine({ days: 30 }, true)])
      expect(text).not.toMatch(/_|\btest\b|sandbox|\bminor\b/i)
  })

  it('shows a commission only where one was worked out', () => {
    expect(hasCommission({ status: 'pending', commission_minor: 1470 })).toBe(true)
    expect(hasCommission({ status: 'approved', commission_minor: 1470 })).toBe(true)
    expect(hasCommission({ status: 'returned', commission_minor: 0 })).toBe(true)
    expect(hasCommission({ status: 'not_earned', commission_minor: 0 })).toBe(false)
    expect(hasCommission({ status: 'not_judged', commission_minor: null })).toBe(false)
    expect(hasCommission({ status: 'pending', commission_minor: null })).toBe(false)
    expect(hasCommission({ status: 'other', commission_minor: 1470 })).toBe(false)
  })

  it('says what was refunded, in normal units', () => {
    expect(refundLine({ refunded_minor: 0 }, 'USD')).toBeNull()
    expect(refundLine({ refunded_minor: 2000 }, 'USD')).toBe('$20.00 refunded')
    expect(refundLine({ refunded_minor: 2000 }, 'EUR')).toBe('20.00 EUR refunded')
  })

  it('says what the summary counts', () => {
    expect(summaryLine({ days: 30 }, false)).toBe(
      'Sales in the last 30 days that earned a commission.',
    )
    expect(summaryLine({ days: 30 }, true)).toBe(
      'Sales from all creators in the last 30 days that earned a commission.',
    )
    expect(summaryLine({ days: 1 }, false)).toBe('Sales in the last day that earned a commission.')
  })
})

describe('what each failure says', () => {
  const steps: SalesStep[] = ['load', 'more']
  const failed = (details: string | null, code = '22023') =>
    readFailure({ code, details, message: 'From the database.' })

  it('reads what an errcode alone means', () => {
    expect(describeProblem(failed(null, '42501'), 'load')).toMatchObject({
      code: 'not_allowed',
      recovery: 'none',
    })
    expect(describeProblem(failed(null, 'P0002'), 'load').message).toContain(
      'no longer a member of this workspace',
    )
    expect(describeProblem(failed(null, 'PGRST301'), 'load').recovery).toBe('sign-in')
    expect(
      describeProblem(readFailure({ message: 'TypeError: Failed to fetch' }), 'more'),
    ).toMatchObject({ code: 'unreachable', recovery: 'retry' })
    expect(describeProblem(failed('invalid_input'), 'load')).toMatchObject({
      message: 'That creator could not be found. Remove the filter to see every sale.',
      recovery: 'none',
    })
  })

  it('gives an unknown code one plain message for what was being done', () => {
    for (const step of steps) {
      // PGRST202 is a database that does not have the function yet.
      for (const [code, errcode] of [
        ['something_new', 'XX000'],
        [null, 'XX000'],
        [null, 'PGRST202'],
        [null, '22P02'],
      ] as const) {
        const problem = describeProblem(failed(code, errcode), step)
        expect(problem.message).toBe(fallbackMessages[step])
        expect(problem.recovery).toBe('retry')
      }
      expect(describeProblem(new Error('boom'), step).message).toBe(fallbackMessages[step])
    }
  })

  it('never shows a code, and never speaks of test mode', () => {
    const all = [
      ...Object.values(problemMessages).map((item) => item.message),
      ...Object.values(fallbackMessages),
    ]
    for (const message of all) {
      expect(message).not.toMatch(/_|\btest\b|sandbox/i)
      expect(message).toMatch(/[.]$/)
    }
  })
})

describe('sales page: what it shows', () => {
  it('keeps its frame while the list loads', async () => {
    signedInAs('owner')
    const first = held<Row>()
    await openSales(() => first.promise, '#sales', false)
    expect(screen.getByRole('status', { name: 'Loading your sales' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    first.release(answer(mixed))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading your sales' })).not.toBeInTheDocument()
  })

  it('says when the list cannot be loaded, and loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openSales(() =>
      ++attempt === 1 ? new Error('TypeError: Failed to fetch') : answer(mixed),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(button('Retry'))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent()).toHaveLength(2)
  })

  it('gives an unknown load failure one plain message', async () => {
    signedInAs('owner')
    await openSales(refuse(null, 'PGRST202'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your sales could not be loaded. Try again.',
    )
    expect(button('Retry')).toBeInTheDocument()
  })

  it('says so when the answer cannot be read, instead of showing wrong money', async () => {
    signedInAs('owner')
    await openSales({ program: PROGRAM, sales: 'none' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your sales could not be loaded. Try again.',
    )
    expect(page()).not.toHaveTextContent('$')
  })

  it('offers to sign in again when the session has expired', async () => {
    signedInAs('owner')
    const user = await openSales(refuse(null, 'PGRST301'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired.')
    expect(buttons('Retry')).toHaveLength(0)
    await user.click(button('Sign in again'))
    await waitFor(() => expect(window.location.hash).toBe('#sign-in'))
  })

  it('points to Program when there is no program yet', async () => {
    signedInAs('owner')
    await openSales(salesFixture.sales_no_program)
    expect(page()).toHaveTextContent('No Brainer Lab has no affiliate program yet.')
    expect(screen.getByRole('link', { name: 'Open Program' })).toHaveAttribute('href', '#program')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Last/ })).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('$')
  })

  it('says what will appear while a live program has no sales, and where creators are', async () => {
    signedInAs('owner')
    await openSales(salesFixture.sales_empty)
    expect(screen.getByRole('heading', { name: 'All sales' })).toBeInTheDocument()
    expect(page()).toHaveTextContent(
      'No sales yet. A sale appears here when someone buys through a creator’s link.',
    )
    expect(screen.getByRole('link', { name: 'Open Creators' })).toHaveAttribute('href', '#creators')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // Four zeros would say nothing the sentence does not.
    expect(screen.queryByRole('group', { name: /^Last/ })).not.toBeInTheDocument()
    expect(buttons('Show more')).toHaveLength(0)
  })

  it('says creators can sell once a program that is not live yet is', async () => {
    signedInAs('owner')
    await openSales(answer([], { program: { ...PROGRAM, status: 'draft' }, summary: null }))
    expect(page()).toHaveTextContent('Creators can sell once your program is live.')
    expect(screen.getByRole('link', { name: 'Open Program' })).toHaveAttribute('href', '#program')
  })

  it('sums up the last 30 days in four figures', async () => {
    signedInAs('owner')
    await openSales()
    const summary = screen.getByRole('group', { name: 'Last 30 days' })
    const figures = [...summary.querySelectorAll('.mc-kpi')].map((item) => [
      item.querySelector('.mc-kpi-label')?.textContent,
      item.querySelector('.mc-kpi-value')?.textContent,
    ])
    expect(figures).toEqual([
      ['Sales', '70'],
      ['Sales amount', '$3,430.00'],
      ['Commission', '$1,029.00'],
      ['KissMyApps fee', '$102.90'],
    ])
    expect(summary).toHaveTextContent('Sales in the last 30 days that earned a commission.')
  })

  it('lists the sales without a summary when the summary cannot be read', async () => {
    signedInAs('owner')
    await openSales(answer(mixed, { summary: { ...SUMMARY, fee_minor: 'ten' } }))
    expect(screen.queryByRole('group', { name: /^Last/ })).not.toBeInTheDocument()
    expect(rows()).toHaveLength(mixed.length)
  })

  it('lists each sale: when, who, through which link, what was paid and earned', async () => {
    signedInAs('owner')
    await openSales()
    expect(screen.getByRole('heading', { name: 'All sales' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Date', 'Creator', 'Channel', 'Source', 'Amount', 'Commission', 'Status'])
    // The word "Commission" is written for the narrow layout, where the column has no heading,
    // and so is the source, after the link.
    expect(cells('s-ada-1')).toEqual([
      when(pending.paid_at),
      'Ada Okafor',
      'TikTok · Stripe',
      'Stripe',
      '$49.00',
      'Commission $14.70',
      `Pending until ${formatShortDay(HOLD)}`,
    ])
    expect(cells('s-kwame-1').slice(1)).toEqual([
      'Kwame Mensah',
      'YouTube · Stripe',
      'Stripe',
      '$99.00',
      'Commission $29.70',
      'Approved',
    ])
    // Newest first, in the order the database sent.
    expect(rows().map((row) => row.dataset.sale)).toEqual(mixed.map((row) => row.sale_id))
  })

  it('says every status in words, and why a sale earned nothing', async () => {
    signedInAs('owner')
    await openSales(
      answer([
        ...mixed,
        sale({ sale_id: 's-paused', status: 'not_earned', reason: 'program_paused' }),
        sale({ sale_id: 's-gone', status: 'not_earned', reason: 'not_a_member' }),
        sale({ sale_id: 's-late', status: 'not_earned', reason: 'outside_duration' }),
        sale({ sale_id: 's-new', status: 'on_review' }),
      ]),
    )
    const status = (id: string) => cells(id).at(-1)
    expect(status('s-ada-1')).toBe(`Pending until ${formatShortDay(HOLD)}`)
    expect(status('s-kwame-1')).toBe('Approved')
    expect(status('s-lena-1')).toBe('Returned' + 'The sale was refunded')
    expect(status('s-mei-1')).toBe('No commission' + 'Your balance could not cover it')
    expect(status('s-paused')).toBe('No commission' + 'Your program was paused')
    expect(status('s-gone')).toBe('No commission' + 'The creator was not in your program')
    expect(status('s-late')).toBe('No commission' + 'After the commission period')
    expect(status('s-ada-0')).toBe('No commission' + 'From before commissions started')
    expect(status('s-new')).toBe('Recorded')
    // The word is a label; the reason under it is quiet text.
    expect(within(rowOf('s-mei-1')).getByText('No commission')).toHaveClass('mc-pill', 'is-warning')
    expect(within(rowOf('s-mei-1')).getByText('Your balance could not cover it')).toHaveClass(
      'mc-sub',
    )
    expect(within(rowOf('s-kwame-1')).getByText('Approved')).toHaveClass('mc-pill', 'is-positive')
    // No status reaches the page as the database spells it.
    expect(page().textContent).not.toMatch(/not_earned|not_judged|balance_empty|program_paused/)
  })

  it('shows no commission figure for a sale that earned none', async () => {
    signedInAs('owner')
    await openSales()
    expect(cells('s-mei-1')[5]).toBe('—None')
    expect(cells('s-ada-0')[5]).toBe('—None')
    // A commission that went back is the figure it now is.
    expect(within(rowOf('s-lena-1')).getAllByRole('cell')[5]).toHaveTextContent('$0.00')
  })

  it('says what was refunded under the amount', async () => {
    signedInAs('owner')
    await openSales()
    expect(cells('s-ada-2')[4]).toBe('$99.00' + '$20.00 refunded')
    expect(cells('s-lena-1')[4]).toBe('$49.00' + '$49.00 refunded')
    expect(cells('s-ada-1')[4]).toBe('$49.00')
  })

  it('says when a sale is tied to no link', async () => {
    signedInAs('owner')
    await openSales()
    expect(cells('s-ada-0')[2]).toBe('No link · Stripe')
  })

  it('shows money in normal units, in the program’s currency', async () => {
    signedInAs('owner')
    const inEuros = mixed.map((row) => ({ ...row, currency: 'EUR' }))
    await openSales(answer(inEuros, { currency: 'EUR' }))
    expect(cells('s-ada-1').slice(4, 6)).toEqual(['49.00 EUR', 'Commission 14.70 EUR'])
    expect(screen.getByRole('group', { name: 'Last 30 days' })).toHaveTextContent('3,430.00 EUR')
    for (const minor of ['4900', '1470', '343000', '102900', '10290'])
      expect(page()).not.toHaveTextContent(minor)
  })

  it('shows a sale paid in another currency in the currency the buyer paid', async () => {
    signedInAs('owner')
    const abroad = sale({
      sale_id: 's-abroad',
      currency: 'EUR',
      refunded_minor: 1000,
      status: 'not_earned',
      reason: 'currency_mismatch',
      commission_minor: 0,
      fee_minor: 0,
      hold_until: null,
    })
    await openSales(answer([abroad, pending]))
    expect(cells('s-abroad')[4]).toBe('49.00 EUR10.00 EUR refunded')
    expect(cells('s-ada-1')[4]).toBe('$49.00')
    // A row from before the database sent a currency falls back to the program's.
    const { currency: _unsent, ...older } = sale({ sale_id: 's-older' })
    expect(readSales(answer([older])).sales[0].currency).toBeNull()
  })

  it('never shows anything about the buyer, or an email address', async () => {
    signedInAs('owner')
    await openSales(
      answer([sale({ buyer_email: 'buyer@example.test', customer_name: 'Bea Buyer' }), approved]),
    )
    expect(page()).not.toHaveTextContent('buyer@example.test')
    expect(page()).not.toHaveTextContent('Bea Buyer')
    expect(page()).not.toHaveTextContent('@')
  })

  it('never speaks of test mode', async () => {
    signedInAs('owner')
    await openSales()
    expect(page().textContent).not.toMatch(/\btest\b|sandbox|live mode/i)
  })

  it('keeps long names whole and on the page', async () => {
    signedInAs('owner')
    const name = 'Maximiliano Alexander Fitzgerald-Montgomery von Hohenzollern the Third'
    const link = 'Spring newsletter, second send to the waitlist'
    await openSales(
      answer([
        sale({ creator_name: name, link_name: link }),
        sale({ sale_id: 's-nameless', creator_name: null, member_id: null }),
      ]),
    )
    expect(cells('s-ada-1').slice(1, 3)).toEqual([name, `${link} · Stripe`])
    expect(within(rowOf('s-ada-1')).getAllByRole('cell')[1]).toHaveClass('mc-sales-who')
    // A sale whose creator has no name to show still has its row.
    expect(cells('s-nameless')[1]).toBe('—Not known')
  })

  it('lists a full page of sales', async () => {
    signedInAs('owner')
    const many = Array.from({ length: PAGE_SIZE }, (_, index) =>
      sale({
        sale_id: `s-${index}`,
        paid_at: ago(index * 90),
        amount_minor: 123456700,
        commission_minor: 37037010,
      }),
    )
    await openSales(answer(many, { next_before: many.at(-1)!.paid_at }))
    expect(rows()).toHaveLength(PAGE_SIZE)
    expect(cells('s-49').slice(4, 6)).toEqual(['$1,234,567.00', 'Commission $370,370.10'])
    expect(page()).toHaveTextContent(`Showing the latest ${PAGE_SIZE}`)
    expect(button('Show more')).toBeEnabled()
  })
})

describe('sales page: one creator', () => {
  it('opens a sale’s creator on their own from the list', async () => {
    signedInAs('owner')
    await openSales()
    const link = within(rowOf('s-kwame-1')).getByRole('link', {
      name: 'Kwame Mensah: show only their sales',
    })
    expect(link).toHaveAttribute('href', '#sales?creator=m-kwame')
    expect(link).toHaveTextContent(/^Kwame Mensah$/)
  })

  it('asks for one creator’s sales and names them on a chip', async () => {
    signedInAs('owner')
    await openSales(answer([pending, partRefund, early]), '#sales?creator=m-ada')
    expect(asked()).toEqual([{ limit: PAGE_SIZE, before: null, member_id: 'm-ada' }])
    const list = screen.getByRole('region', { name: 'Sales from' })
    expect(within(list).getByText('Ada Okafor', { selector: '.mc-sales-chip *' })).toBeVisible()
    expect(button('Remove filter: Ada Okafor')).toBeInTheDocument()
    expect(rows()).toHaveLength(3)
    // The name came with the sales: nobody else had to be asked.
    expect(sent('creators')).toHaveLength(0)
    // Already theirs: the name in a row is no longer a way to filter.
    expect(within(rowOf('s-ada-1')).queryByRole('link')).not.toBeInTheDocument()
    // The summary is everyone's, and says so.
    expect(screen.getByRole('group', { name: 'Last 30 days' })).toHaveTextContent(
      'Sales from all creators in the last 30 days that earned a commission.',
    )
  })

  it('reads the filtered answer the contract describes', async () => {
    signedInAs('owner')
    await openSales(salesFixture.sales_one_creator, `#sales?creator=${salesFixtureMember}`)
    expect(asked()[0]).toMatchObject({ member_id: salesFixtureMember })
    expect(button('Remove filter: Ada Okafor')).toBeInTheDocument()
    expect(rows()).toHaveLength(3)
  })

  it('shows everyone’s sales again when the chip is removed', async () => {
    signedInAs('owner')
    const user = await openSales(
      (args: Args) =>
        (args.p_input as { member_id: string | null }).member_id
          ? answer([pending, partRefund])
          : answer(mixed),
      '#sales?creator=m-ada',
    )
    expect(rows()).toHaveLength(2)
    await user.click(button('Remove filter: Ada Okafor'))
    await waitFor(() => expect(window.location.hash).toBe('#sales'))
    expect(await screen.findByRole('heading', { name: 'All sales' })).toBeInTheDocument()
    await waitFor(() => expect(rows()).toHaveLength(mixed.length))
    expect(asked().at(-1)).toEqual({ limit: PAGE_SIZE, before: null, member_id: null })
    expect(buttons(/^Remove filter/)).toHaveLength(0)
  })

  it('goes from everyone to one creator through a name in the list', async () => {
    signedInAs('owner')
    const user = await openSales((args: Args) =>
      (args.p_input as { member_id: string | null }).member_id ? answer([approved]) : answer(mixed),
    )
    await user.click(screen.getByRole('link', { name: 'Kwame Mensah: show only their sales' }))
    expect(await screen.findByRole('heading', { name: 'Sales from' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remove filter: Kwame Mensah' })).toBeVisible()
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(asked().at(-1)).toEqual({ limit: PAGE_SIZE, before: null, member_id: 'm-kwame' })
  })

  it('says a creator has no sales yet, by name, with the way back to all sales', async () => {
    signedInAs('owner')
    answers({
      workspace_program_creators: people(['m-ada', 'Ada Okafor'], ['m-mei', 'Mei Tanaka']),
    })
    await openSales(answer([]), '#sales?creator=m-mei')
    expect(await screen.findByRole('button', { name: 'Remove filter: Mei Tanaka' })).toBeVisible()
    expect(page()).toHaveTextContent('No sales from Mei Tanaka yet.')
    expect(screen.getByRole('link', { name: 'Show all sales' })).toHaveAttribute('href', '#sales')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(sent('creators')).toEqual([{ p_workspace_id: 'ws-1' }])
    // Others did sell, so the summary of everyone is still there.
    expect(screen.getByRole('group', { name: 'Last 30 days' })).toBeInTheDocument()
  })

  it('still filters when the creator’s name cannot be found', async () => {
    signedInAs('owner')
    answers({ workspace_program_creators: new Error('TypeError: Failed to fetch') })
    await openSales(salesFixture.sales_empty, '#sales?creator=m-nobody')
    await waitFor(() => expect(sent('creators')).toHaveLength(1))
    expect(button('Remove filter: One creator')).toBeInTheDocument()
    expect(page()).toHaveTextContent('No sales from them yet.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Nobody has sold anything, so there is no summary to show either.
    expect(screen.queryByRole('group', { name: /^Last/ })).not.toBeInTheDocument()
  })

  it('keeps the chip when the list cannot be loaded, so the filter can be taken off', async () => {
    signedInAs('owner')
    const user = await openSales(
      (args: Args) =>
        (args.p_input as { member_id: string | null }).member_id
          ? refuse('invalid_input')
          : answer(mixed),
      '#sales?creator=not-a-creator',
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That creator could not be found. Remove the filter to see every sale.',
    )
    expect(buttons('Retry')).toHaveLength(0)
    await user.click(button('Remove filter: One creator'))
    await waitFor(() => expect(rows()).toHaveLength(mixed.length))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('sales page: more sales', () => {
  const first = answer([pending, approved], { next_before: approved.paid_at })
  const second = answer([returned, unfunded], { next_before: unfunded.paid_at })
  const last = answer([early])
  const paged = (args: Args) => {
    const before = (args.p_input as { before: string | null }).before
    return before === approved.paid_at ? second : before === unfunded.paid_at ? last : first
  }

  it('adds the next page under the list with Show more, until there is no more', async () => {
    signedInAs('owner')
    const user = await openSales(paged)
    expect(rows()).toHaveLength(2)
    expect(page()).toHaveTextContent('Showing the latest 2')
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(asked().at(-1)).toEqual({
      limit: PAGE_SIZE,
      before: approved.paid_at,
      member_id: null,
    })
    expect(rows().map((row) => row.dataset.sale)).toEqual([
      's-ada-1',
      's-kwame-1',
      's-lena-1',
      's-mei-1',
    ])
    // Focus follows the list down to the first sale that was added.
    expect(rowOf('s-lena-1')).toHaveFocus()
    expect(page()).toHaveTextContent('Showing the latest 4')
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(asked().at(-1)).toMatchObject({ before: unfunded.paid_at })
    expect(buttons('Show more')).toHaveLength(0)
    expect(page()).toHaveTextContent('All 5 sales shown')
    expect(sent()).toHaveLength(3)
  })

  it('reads the two pages the contract describes', async () => {
    signedInAs('owner')
    const user = await openSales((args: Args) =>
      (args.p_input as { before: string | null }).before
        ? salesFixture.sales_next
        : salesFixture.sales_mixed,
    )
    const firstPage = (salesFixture.sales_mixed as { sales: Row[]; next_before: string }).sales
    expect(rows()).toHaveLength(firstPage.length)
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(firstPage.length + 1))
    expect(asked().at(-1)).toMatchObject({
      before: (salesFixture.sales_mixed as { next_before: string }).next_before,
    })
    expect(buttons('Show more')).toHaveLength(0)
  })

  it('keeps asking for the same creator on the next page', async () => {
    signedInAs('owner')
    const user = await openSales(paged, '#sales?creator=m-ada')
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(asked().at(-1)).toEqual({
      limit: PAGE_SIZE,
      before: approved.paid_at,
      member_id: 'm-ada',
    })
  })

  it('shows that it is loading, and cannot be asked twice', async () => {
    signedInAs('owner')
    const next = held<Row>()
    const user = await openSales((args: Args) =>
      (args.p_input as { before: string | null }).before ? next.promise : first,
    )
    await user.click(button('Show more'))
    const busy = await screen.findByRole('button', { name: 'Loading' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    expect(sent()).toHaveLength(2)
    next.release(last)
    await waitFor(() => expect(rows()).toHaveLength(3))
  })

  it('never lists a sale twice when a page overlaps the one before', async () => {
    signedInAs('owner')
    const user = await openSales((args: Args) =>
      (args.p_input as { before: string | null }).before ? answer([approved, returned]) : first,
    )
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows().map((row) => row.dataset.sale)).toEqual(['s-ada-1', 's-kwame-1', 's-lena-1'])
  })

  it('keeps the list and says so when more cannot be loaded, then loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openSales((args: Args) => {
      if (!(args.p_input as { before: string | null }).before) return first
      return ++attempt === 1 ? new Error('TypeError: Failed to fetch') : last
    })
    await user.click(button('Show more'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(rows()).toHaveLength(2)
    expect(button('Show more')).toBeEnabled()
    await user.click(button('Retry'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('gives an unknown failure of Show more its own plain message', async () => {
    signedInAs('owner')
    const user = await openSales((args: Args) =>
      (args.p_input as { before: string | null }).before ? refuse('something_new', 'XX000') : first,
    )
    await user.click(button('Show more'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'More sales could not be loaded. Try again.',
    )
    expect(rows()).toHaveLength(2)
  })
})

describe('sales page: staying current', () => {
  it('looks for new sales by itself, and keeps the page when that fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      await openSales(() => {
        reads += 1
        if (reads === 1) return answer([approved])
        if (reads === 2) return answer([pending, approved])
        return new Error('TypeError: Failed to fetch')
      })
      expect(rows()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(rows()).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(sent()).toHaveLength(3))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(rows()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the list alone once more of it has been asked for', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      const user = await openSales((args: Args) =>
        (args.p_input as { before: string | null }).before
          ? answer([returned])
          : answer([pending, approved], { next_before: approved.paid_at }),
      )
      await user.click(button('Show more'))
      await waitFor(() => expect(rows()).toHaveLength(3))
      await vi.advanceTimersByTimeAsync(180_000)
      expect(sent()).toHaveLength(2)
      expect(rows()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sales of a program that pays for events only', () => {
  const unrewarded = sale({
    sale_id: 's-ada-events',
    status: 'not_earned',
    reason: 'sales_not_rewarded',
    commission_minor: 0,
    fee_minor: 0,
    hold_until: null,
  })

  it('has words for a sale that earns nothing because only events do', () => {
    const said = saleStatus(readSales(answer([unrewarded])).sales[0])
    expect(said).toEqual({
      label: 'No commission',
      tone: 'neutral',
      detail: 'Your program pays for events, not sales',
    })
    expect(said.detail).not.toMatch(/_|\btest\b|sandbox|\bminor\b/i)
  })

  it('says so on the page, with no commission figure', async () => {
    signedInAs('owner')
    await openSales(answer([unrewarded]))
    expect(cells('s-ada-events').slice(5)).toEqual([
      '—None',
      'No commission' + 'Your program pays for events, not sales',
    ])
    expect(page()).not.toHaveTextContent('sales_not_rewarded')
  })
})
