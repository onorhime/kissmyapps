import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { formatShortDay } from './balance'
import { formatWhen } from './connections'
import { MerchantApp } from './MerchantApp'
import { ProgramError, readFailure } from './programs'
import {
  awardStatus,
  budgetLeft,
  budgetLine,
  budgetNotes,
  budgetStanding,
  checkNote,
  confirmLine,
  creatorsInOrder,
  describeProblem,
  doneLine,
  earns,
  emptyNames,
  fallbackMessages,
  feeOn,
  goingBack,
  monthName,
  NOTE_MAX,
  PAGE_SIZE,
  problemMessages,
  readRejection,
  readRewards,
  reasonMessage,
  REJECT_MAX,
  rejectMessages,
  rejectReasonNames,
  rejectTitle,
  STALE_LINE,
  standsOut,
  standsOutLine,
  statusNames,
  UNAVAILABLE,
  USED_UP_LINE,
  wentFurther,
  withFreshFigures,
  withNextPage,
  withoutRejecting,
  withRejected,
} from './rewards'
import type { RewardCreator, RewardsStep } from './rewards'
import { rewardsFixture, rewardsFixtureMember, rewardsFixtureStandsOut } from './rewards.fixture'
import { href, parseRoute } from './routes'

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
  name: 'Fluent',
  platforms: ['web'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
}

const context = (role: Role, projects: Project[] = [project]): Context => ({
  user: { id: 'user-1', email: 'owner@example.test', name: 'Sam Owner' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const DAY = 24 * 60
const HOLD = '2026-12-13T12:00:00.000000+00:00'

const PROGRAM = {
  id: 'prog-1',
  slug: 'fluent',
  name: 'Fluent',
  status: 'live',
  earn_from: 'events',
}
const BUDGET = {
  month: '2026-11',
  budget_minor: 50000,
  used_minor: 17600,
  daily_limit_minor: 5000,
  fee_bps: 1000,
}
const SIGNUP = { key: 'signup_completed', label: 'Account created', amount_minor: 200 }
const TRIAL = { key: 'trial_started', label: 'Trial started', amount_minor: 600 }
const REWARDS = [
  { ...SIGNUP, count: 43, amount_total_minor: 8600 },
  { ...TRIAL, count: 15, amount_total_minor: 9000 },
]

type Row = Record<string, unknown>

/** One creator's last 30 days, as the database returns them. */
const creator = (over: Row = {}): Row => ({
  member_id: 'm-mira',
  name: 'Mira Maker',
  clicks: 340,
  people: 25,
  went_further: 9,
  counts: [
    { key: SIGNUP.key, count: 25 },
    { key: TRIAL.key, count: 9 },
  ],
  earned_minor: 10400,
  pending_minor: 5200,
  rejected: 1,
  not_counted: 4,
  ...over,
})
const mira = creator()
const jonas = creator({
  member_id: 'm-jonas',
  name: 'Jonas Weber',
  clicks: 1210,
  people: 18,
  went_further: 6,
  counts: [
    { key: SIGNUP.key, count: 18 },
    { key: TRIAL.key, count: 6 },
  ],
  earned_minor: 7200,
  pending_minor: 0,
  rejected: 0,
  not_counted: 2,
})
const deal = creator({
  member_id: 'm-deal',
  name: 'Deal Drop',
  clicks: 540,
  people: 500,
  went_further: 0,
  counts: [
    { key: SIGNUP.key, count: 500 },
    { key: TRIAL.key, count: 0 },
  ],
  earned_minor: 100000,
  pending_minor: 100000,
  rejected: 0,
  not_counted: 37,
})
const CREATORS = [mira, jonas]

/** One reward, as the database returns it. */
const award = (over: Row = {}): Row => ({
  award_id: 'a-mira-1',
  occurred_at: ago(60),
  member_id: 'm-mira',
  creator_name: 'Mira Maker',
  link_name: 'TikTok',
  reward_key: SIGNUP.key,
  reward_label: SIGNUP.label,
  amount_minor: SIGNUP.amount_minor,
  status: 'pending',
  reason: null,
  hold_until: HOLD,
  reject_reason: null,
  can_reject: true,
  ...over,
})

const pending = award()
const trial = award({
  award_id: 'a-mira-2',
  occurred_at: ago(90),
  link_name: 'Main link',
  reward_key: TRIAL.key,
  reward_label: TRIAL.label,
  amount_minor: TRIAL.amount_minor,
})
const other = award({
  award_id: 'a-jonas-1',
  occurred_at: ago(3 * 60),
  member_id: 'm-jonas',
  creator_name: 'Jonas Weber',
  link_name: 'No link',
})
const approved = award({
  award_id: 'a-jonas-0',
  occurred_at: ago(40 * DAY),
  member_id: 'm-jonas',
  creator_name: 'Jonas Weber',
  link_name: 'YouTube',
  status: 'approved',
  can_reject: false,
})
const rejected = award({
  award_id: 'a-mira-0',
  occurred_at: ago(2 * DAY),
  link_name: 'Instagram',
  status: 'rejected',
  reject_reason: 'duplicate',
  can_reject: false,
})
const uncounted = award({
  award_id: 'a-mira-x',
  occurred_at: ago(3 * DAY),
  status: 'not_counted',
  reason: 'already_rewarded',
  hold_until: null,
  can_reject: false,
})
const mixed = [pending, trial, other, rejected, uncounted, approved]

/** A workspace_program_rewards answer. */
const answer = (rows: Row[] = [], over: Row = {}): Row => ({
  can_manage: true,
  program: PROGRAM,
  currency: 'USD',
  budget: BUDGET,
  rewards: REWARDS,
  creators: CREATORS,
  awards: rows,
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

const sent = (name: 'rewards' | 'reward_reject' | 'creators' = 'rewards') =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)
const asked = () => sent().map((args: Args) => args.p_input)
const input = (args: Args) => args.p_input as Record<string, unknown>

async function openRewards(list: Answer = answer(mixed), hash = '#rewards', wait = true) {
  answers({ workspace_program_rewards: list })
  window.location.hash = hash
  const user = userEvent.setup()
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Rewards', level: 1 })
  if (wait)
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'Loading your rewards' }),
      ).not.toBeInTheDocument(),
    )
  return user
}

const page = () => document.querySelector('.mc-rw') as HTMLElement
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const buttons = (name: string | RegExp) => screen.queryAllByRole('button', { name })
const month = () => screen.getByRole('region', { name: /budget$/ })
const creators = () => screen.getByRole('region', { name: 'Creators' })
const list = () => screen.getByRole('region', { name: /^(All rewards|Rewards from)$/ })
const table = () => within(list()).getByRole('table')
const rows = () => within(table()).getAllByRole('row').slice(1)
const ids = () => rows().map((row) => row.dataset.award)
const rowOf = (id: string) => document.querySelector(`[data-award="${id}"]`) as HTMLElement
const texts = (row: HTMLElement, role: 'cell' | 'columnheader' = 'cell') =>
  within(row)
    .getAllByRole(role)
    .map((cell) => cell.textContent)
const cells = (id: string) => texts(rowOf(id))
const tick = (id: string) => within(rowOf(id)).getByRole('checkbox')
const ticks = () => within(list()).queryAllByRole('checkbox')
const bar = () => screen.getByRole('group', { name: 'Selected rewards' })
const dialog = () => screen.getByRole('dialog')
const creatorRow = (name: string) =>
  within(creators())
    .getAllByRole('row')
    .find((row) => row.textContent?.includes(name)) as HTMLElement
const when = (time: unknown) => formatWhen(time as string, Date.now())

/** Ticks the rewards, opens the confirmation and chooses a reason. */
async function ask(user: ReturnType<typeof userEvent.setup>, picks: string[], reason = 'Fake') {
  for (const id of picks) await user.click(tick(id))
  await user.click(within(bar()).getByRole('button', { name: 'Reject' }))
  if (reason) await user.click(within(dialog()).getByRole('radio', { name: reason }))
}

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.table = {}
  fake.state.context = context('owner')
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('rewards route', () => {
  it('lives at #rewards', () => {
    expect(parseRoute('#rewards')).toEqual({ name: 'rewards' })
    expect(parseRoute('#/rewards')).toEqual({ name: 'rewards' })
    expect(href({ name: 'rewards' })).toBe('#rewards')
    expect(parseRoute(href({ name: 'rewards' }))).toEqual({ name: 'rewards' })
  })

  it('carries the one creator whose rewards to show', () => {
    expect(parseRoute('#rewards?creator=m-mira')).toEqual({ name: 'rewards', creator: 'm-mira' })
    expect(href({ name: 'rewards', creator: 'm-mira' })).toBe('#rewards?creator=m-mira')
    // Whatever is put there is one value, never more of the address.
    const odd = 'a b&creator=x#y'
    expect(href({ name: 'rewards', creator: odd })).toBe('#rewards?creator=a%20b%26creator%3Dx%23y')
    expect(parseRoute(href({ name: 'rewards', creator: odd }))).toEqual({
      name: 'rewards',
      creator: odd,
    })
  })

  it('treats an empty filter, and anything else in the address, as no filter', () => {
    expect(parseRoute('#rewards?creator=')).toEqual({ name: 'rewards' })
    expect(parseRoute('#rewards?creator=%20%20')).toEqual({ name: 'rewards' })
    expect(parseRoute('#rewards?member=m-mira')).toEqual({ name: 'rewards' })
    expect(parseRoute('#rewards/m-mira')).toEqual({ name: 'rewards' })
  })

  it('is in the Affiliates group between Sales and Balance', async () => {
    signedInAs('owner')
    await openRewards()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Rewards' })
    expect(link).toHaveAttribute('href', '#rewards')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Rewards')
    const group = document.getElementById('mc-nav-affiliates') as HTMLElement
    expect(
      within(group)
        .getAllByRole('link')
        .map((item) => item.textContent),
    ).toEqual(['Program', 'Creators', 'Sales', 'Rewards', 'Balance'])
    // The project the person was in keeps its menu.
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })

  it('stays the current menu entry while one creator is shown, and without a project', async () => {
    signedInAs('owner', [])
    await openRewards(answer([pending]), '#rewards?creator=m-mira')
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Rewards' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(table()).toBeInTheDocument()
  })

  it('asks the database as the signed-in user, for this workspace, for the first page', async () => {
    signedInAs('owner')
    await openRewards()
    expect(sent()[0]).toEqual({
      p_workspace_id: 'ws-1',
      p_input: { limit: PAGE_SIZE, before: null, member_id: null, status: null },
    })
    expect(PAGE_SIZE).toBe(50)
  })
})

describe('reading answers', () => {
  it('reads every answer the contract describes', () => {
    for (const name of Object.keys(rewardsFixture).filter((key) => key.startsWith('rewards_'))) {
      const read = readRewards(rewardsFixture[name])
      const raw = rewardsFixture[name] as { awards: unknown[]; creators: unknown[] }
      expect(read.awards, name).toHaveLength(raw.awards.length)
      expect(read.creators, name).toHaveLength(raw.creators.length)
      expect(read.currency, name).toBe('USD')
      for (const row of read.awards) {
        expect(Number.isSafeInteger(row.amount_minor), name).toBe(true)
        expect(Number.isFinite(Date.parse(row.occurred_at)), name).toBe(true)
        expect(row.status, name).not.toBe('other')
      }
    }
    const busy = readRewards(rewardsFixture.rewards_busy)
    expect(busy.program).toEqual({
      id: '6b1f7a52-3c0e-4d7b-9a41-5e2d8c0f1a11',
      slug: 'fluent',
      name: 'Fluent',
      status: 'live',
      earn_from: 'events',
    })
    expect(busy.budget).toEqual({
      month: '2026-11',
      budget_minor: 50000,
      used_minor: 17600,
      daily_limit_minor: 5000,
      fee_bps: 1000,
    })
    expect(busy.rewards[0]).toEqual({
      key: 'signup_completed',
      label: 'Account created',
      amount_minor: 200,
      count: 43,
      amount_total_minor: 8600,
    })
    expect(busy.creators[0]).toEqual({
      member_id: rewardsFixtureMember,
      name: 'Mira Maker',
      clicks: 340,
      people: 25,
      went_further: 9,
      counts: { signup_completed: 25, trial_started: 9 },
      earned_minor: 10400,
      pending_minor: 5200,
      rejected: 1,
      not_counted: 4,
    })
    expect(new Set(busy.awards.map((row) => row.status))).toEqual(
      new Set(['pending', 'approved', 'rejected', 'not_counted']),
    )
    expect(busy.next_before).not.toBeNull()
    const times = busy.awards.map((row) => Date.parse(row.occurred_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    // The pages join into one list.
    const whole = withNextPage(busy, readRewards(rewardsFixture.rewards_next_page))
    expect(whole.awards).toHaveLength(busy.awards.length + 1)
    expect(whole.next_before).toBeNull()
    // The filtered answers carry what they were asked for.
    const one = readRewards(rewardsFixture.rewards_filtered_creator)
    expect(new Set(one.awards.map((row) => row.member_id))).toEqual(new Set([rewardsFixtureMember]))
    const waiting = readRewards(rewardsFixture.rewards_pending_only)
    expect(waiting.awards.every((row) => row.status === 'pending' && row.can_reject)).toBe(true)
    expect(readRewards(rewardsFixture.rewards_viewer).awards.some((row) => row.can_reject)).toBe(
      false,
    )
  })

  it('reads a reward the way the database writes it', () => {
    const [read] = readRewards(answer([pending])).awards
    expect(read).toEqual({
      award_id: 'a-mira-1',
      occurred_at: pending.occurred_at,
      member_id: 'm-mira',
      creator_name: 'Mira Maker',
      link_name: 'TikTok',
      reward_key: 'signup_completed',
      reward_label: 'Account created',
      amount_minor: 200,
      status: 'pending',
      reason: null,
      hold_until: HOLD,
      reject_reason: null,
      can_reject: true,
    })
    // The database names a reward whose click is tied to no link "No link".
    expect(readRewards(answer([other])).awards[0].link_name).toBeNull()
  })

  it('keeps nothing it was not told to show, the person who did the event least of all', () => {
    const read = readRewards(
      answer(
        [
          {
            ...pending,
            person_id: 'person-123',
            session_id: 'session-456',
            event_id: 789,
            email: 'someone@example.test',
          },
        ],
        { creators: [{ ...mira, email: 'mira@example.test', person_ids: ['person-123'] }] },
      ),
    )
    const kept = JSON.stringify(read)
    for (const gone of ['person-123', 'session-456', '789', '@', 'person_id', 'event_id'])
      expect(kept).not.toContain(gone)
    expect(Object.keys(read.awards[0]).sort()).toEqual(
      Object.keys(readRewards(answer([pending])).awards[0]).sort(),
    )
  })

  it('fills what a thin row leaves out and drops a row it cannot trust', () => {
    const read = readRewards(
      answer([
        { award_id: 'a-1', occurred_at: ago(5), amount_minor: 200, status: 'pending' },
        { award_id: 'a-2', occurred_at: ago(5), amount_minor: 200, status: 'something_new' },
        { award_id: '', occurred_at: ago(5), amount_minor: 200, status: 'pending' },
        { award_id: 'a-3', occurred_at: 'soon', amount_minor: 200, status: 'pending' },
        { award_id: 'a-4', occurred_at: ago(5), amount_minor: '200', status: 'pending' },
        { award_id: 'a-5', occurred_at: ago(5), amount_minor: -200, status: 'pending' },
        { award_id: 'a-6', occurred_at: ago(5), amount_minor: 200 },
        // Not rows at all.
        ...(['row', null] as unknown as Row[]),
      ]),
    )
    expect(read.awards.map((row) => [row.award_id, row.status])).toEqual([
      ['a-1', 'pending'],
      ['a-2', 'other'],
    ])
    expect(read.awards[0]).toMatchObject({
      member_id: null,
      creator_name: null,
      link_name: null,
      reward_key: null,
      reward_label: 'Reward',
      reason: null,
      hold_until: null,
      reject_reason: null,
      can_reject: false,
    })
  })

  it('lets a reward be rejected only while it is pending and the reader may manage', () => {
    const can = (over: Row, top: Row = {}) => readRewards(answer([award(over)], top)).awards[0]
    expect(can({}).can_reject).toBe(true)
    expect(can({ can_reject: 'yes' }).can_reject).toBe(false)
    expect(can({ can_reject: undefined }).can_reject).toBe(false)
    for (const status of ['approved', 'rejected', 'not_counted', 'something_new'])
      expect(can({ status }).can_reject).toBe(false)
    expect(can({}, { can_manage: false }).can_reject).toBe(false)
  })

  it('reads a reason only for a reward that did not count, and a known reject reason', () => {
    const read = (over: Row) => readRewards(answer([award(over)])).awards[0]
    expect(read({ status: 'not_counted', reason: 'daily_limit' }).reason).toBe('daily_limit')
    expect(read({ status: 'pending', reason: 'daily_limit' }).reason).toBeNull()
    expect(read({ status: 'rejected', reject_reason: 'fake' }).reject_reason).toBe('fake')
    expect(read({ status: 'rejected', reject_reason: 'spite' }).reject_reason).toBeNull()
  })

  it('reads the budget, and none when what is used cannot be read', () => {
    const read = (budget: unknown) => readRewards(answer([], { budget })).budget
    expect(read(BUDGET)).toEqual(BUDGET)
    for (const wrong of [null, undefined, 'budget', [], {}, { ...BUDGET, used_minor: '17600' }])
      expect(read(wrong)).toBeNull()
    expect(read({ ...BUDGET, used_minor: 176.5 })).toBeNull()
    // A budget that is not set, a month or a fee that was not sent: the rest still reads.
    expect(read({ used_minor: 0 })).toEqual({
      month: null,
      budget_minor: null,
      used_minor: 0,
      daily_limit_minor: null,
      fee_bps: null,
    })
    expect(read({ ...BUDGET, month: '2026-13' })?.month).toBeNull()
    expect(read({ ...BUDGET, month: 'November' })?.month).toBeNull()
    expect(read({ ...BUDGET, fee_bps: 10001 })?.fee_bps).toBeNull()
    expect(read({ ...BUDGET, fee_bps: 0 })?.fee_bps).toBe(0)
  })

  it('reads the rewards and the creators, leaving out rows it cannot trust', () => {
    const read = readRewards(
      answer([], {
        rewards: [
          REWARDS[0],
          { ...REWARDS[1], amount_total_minor: 'much', count: -4 },
          { key: 'x', label: '', amount_minor: 100 },
          { key: 'y', label: 'Free', amount_minor: 0 },
          { label: 'No key', amount_minor: 100 },
          'reward',
        ],
        creators: [
          mira,
          creator({ member_id: 'm-2', name: 'Thin', counts: 'none', went_further: null }),
          creator({ member_id: 'm-3', name: 'Odd', earned_minor: -1, pending_minor: 1.5 }),
          creator({ member_id: '', name: 'No id' }),
          creator({ member_id: 'm-4', name: '  ' }),
          null,
        ],
      }),
    )
    expect(read.rewards.map((row) => [row.key, row.count, row.amount_total_minor])).toEqual([
      ['signup_completed', 43, 8600],
      ['trial_started', 0, null],
    ])
    expect(read.creators.map((row) => row.name)).toEqual(['Mira Maker', 'Thin', 'Odd'])
    expect(read.creators[1]).toMatchObject({ counts: {}, went_further: null })
    expect(read.creators[2]).toMatchObject({ earned_minor: null, pending_minor: null })
    expect(readRewards(answer([], { rewards: undefined, creators: 'none' }))).toMatchObject({
      rewards: [],
      creators: [],
    })
  })

  it('reads a workspace with no program as nothing to list', () => {
    const none = readRewards(rewardsFixture.rewards_sales_program)
    expect(none).toEqual({
      can_manage: true,
      program: null,
      currency: 'USD',
      budget: null,
      rewards: [],
      creators: [],
      awards: [],
      next_before: null,
    })
    expect(readRewards({ program: null }).program).toBeNull()
    expect(readRewards(answer([pending], { program: { ...PROGRAM, status: 'archived' } }))).toEqual(
      {
        ...none,
      },
    )
  })

  it('keeps the rewards of a program that went back to sales, still open to rejecting', () => {
    const sales = readRewards(answer([pending], { program: { ...PROGRAM, earn_from: 'sales' } }))
    expect(sales.program?.earn_from).toBe('sales')
    expect(sales.awards.map((row) => [row.award_id, row.can_reject])).toEqual([['a-mira-1', true]])
    expect(sales.budget).not.toBeNull()
  })

  it('reads the currency and where the next page starts', () => {
    expect(readRewards(answer([], { currency: 'eur' })).currency).toBe('EUR')
    expect(readRewards(answer([], { currency: 'dollars' })).currency).toBe('USD')
    expect(readRewards(answer([], { next_before: HOLD })).next_before).toBe(HOLD)
    expect(readRewards(answer([], { next_before: 'later' })).next_before).toBeNull()
  })

  it('refuses an answer it cannot trust', () => {
    for (const wrong of [
      null,
      'rewards',
      [],
      answer([], { program: 'fluent' }),
      answer([], { program: { ...PROGRAM, id: '' } }),
      answer([], { program: { ...PROGRAM, status: 'banned' } }),
      answer([], { program: { ...PROGRAM, earn_from: 'installs' } }),
      answer([], { program: { ...PROGRAM, earn_from: undefined } }),
      answer([], { awards: 'none' }),
      answer([], { can_manage: 'yes' }),
    ])
      expect(() => readRewards(wrong)).toThrowError(ProgramError)
  })

  it('reads what a rejection gave back, and never fails one that already happened', () => {
    expect(readRejection(rewardsFixture.reward_reject_done)).toEqual({
      rejected: 2,
      returned_minor: 440,
    })
    for (const odd of [null, 'done', [], {}, { rejected: '2', returned_minor: 4.4 }])
      expect(readRejection(odd)).toEqual({ rejected: null, returned_minor: null })
    expect(readRejection({ rejected: 2, returned_minor: -1 })).toEqual({
      rejected: 2,
      returned_minor: null,
    })
  })
})

describe('the page’s own arithmetic', () => {
  it('adds a page to the list without listing a reward twice', () => {
    const first = readRewards(answer([pending, trial], { next_before: trial.occurred_at }))
    const next = readRewards(answer([trial, other], { next_before: other.occurred_at }))
    const joined = withNextPage(first, next)
    expect(joined.awards.map((row) => row.award_id)).toEqual(['a-mira-1', 'a-mira-2', 'a-jonas-1'])
    expect(joined.next_before).toBe(other.occurred_at)
    // A page that starts where the last one did ends the list.
    expect(withNextPage(first, { ...next, next_before: first.next_before }).next_before).toBeNull()
  })

  it('marks rewards rejected, and takes them out of a list narrowed to another status', () => {
    const before = readRewards(answer([pending, trial, other]))
    const all = withRejected(before, ['a-mira-1', 'a-jonas-1'], 'fake', null)
    expect(all.awards.map((row) => [row.award_id, row.status, row.can_reject])).toEqual([
      ['a-mira-1', 'rejected', false],
      ['a-mira-2', 'pending', true],
      ['a-jonas-1', 'rejected', false],
    ])
    expect(all.awards[0].reject_reason).toBe('fake')
    expect(
      withRejected(before, ['a-mira-1'], 'fake', 'pending').awards.map((row) => row.award_id),
    ).toEqual(['a-mira-2', 'a-jonas-1'])
    expect(withRejected(before, ['a-mira-1'], 'fake', 'rejected').awards).toHaveLength(3)
  })

  it('takes fresh figures around a list that stays as it is', () => {
    const before = readRewards(answer([pending, trial]))
    const fresh = readRewards(
      answer([other], { budget: { ...BUDGET, used_minor: 17400 }, creators: [jonas] }),
    )
    const after = withFreshFigures(before, fresh)
    expect(after.awards).toBe(before.awards)
    expect(after.budget?.used_minor).toBe(17400)
    expect(after.creators.map((row) => row.name)).toEqual(['Jonas Weber'])
    // An answer without a program has no figures to take.
    expect(withFreshFigures(before, readRewards(rewardsFixture.rewards_sales_program))).toBe(before)
  })

  it('takes rejecting away when the database says this person may not', () => {
    const after = withoutRejecting(readRewards(answer([pending, trial])))
    expect(after.can_manage).toBe(false)
    expect(after.awards.some((row) => row.can_reject)).toBe(false)
  })

  it('works out the fee on each reward the way the database does, rounded down', () => {
    expect(feeOn(200, 1000)).toBe(20)
    expect(feeOn(199, 1000)).toBe(19)
    expect(feeOn(333, 1250)).toBe(41)
    expect(feeOn(200, 0)).toBe(0)
    // Three rewards of $1.99: the fee is rounded down on each, not on their sum.
    expect(
      goingBack([{ amount_minor: 199 }, { amount_minor: 199 }, { amount_minor: 199 }], 1000),
    ).toEqual({ count: 3, rewards_minor: 597, fee_minor: 57, total_minor: 654 })
    expect(goingBack([{ amount_minor: 200 }, { amount_minor: 600 }], 1000)).toEqual({
      count: 2,
      rewards_minor: 800,
      fee_minor: 80,
      total_minor: 880,
    })
    expect(goingBack([{ amount_minor: 200 }], null)).toEqual({
      count: 1,
      rewards_minor: 200,
      fee_minor: null,
      total_minor: null,
    })
    expect(goingBack([], 1000)).toMatchObject({ count: 0, total_minor: 0 })
  })

  it('says where the month stands: fine, nearly used, used up', () => {
    const at = (used: number) => budgetStanding({ budget_minor: 50000, used_minor: used }, REWARDS)
    expect(at(17600)).toEqual({ share: 0.352, left_minor: 32400, level: 'fine' })
    expect(at(0)).toMatchObject({ share: 0, left_minor: 50000, level: 'fine' })
    expect(at(39999)?.level).toBe('fine')
    expect(at(40000)?.level).toBe('nearly')
    expect(at(49800)).toMatchObject({ left_minor: 200, level: 'nearly' })
    // Used up is when the smallest reward no longer fits, which is when events stop earning.
    expect(at(49801)).toMatchObject({ left_minor: 199, level: 'used_up' })
    expect(at(50000)).toMatchObject({ share: 1, left_minor: 0, level: 'used_up' })
    expect(at(61000)).toMatchObject({ share: 1, left_minor: 0, level: 'used_up' })
    expect(budgetStanding({ budget_minor: 50000, used_minor: 49999 }, [])?.level).toBe('nearly')
    // No budget set: there is no bar to draw.
    expect(budgetStanding({ budget_minor: null, used_minor: 0 }, REWARDS)).toBeNull()
  })

  it('singles out a creator with many first rewards and nobody going further', () => {
    const read = (rowsOf: Row[]) => readRewards(answer([], { creators: rowsOf })).creators
    const [a, b, c] = read([mira, jonas, deal])
    expect(standsOut(c, [a, b, c])).toBe(true)
    expect(standsOut(a, [a, b, c])).toBe(false)
    expect(standsOut(b, [a, b, c])).toBe(false)
    // The plan's example: 500 first rewards, nobody going further.
    expect(c).toMatchObject({ people: 500, went_further: 0 })
    // Too few people to say anything.
    const few = read([creator({ people: 19, went_further: 0 })])
    expect(standsOut(few[0], few)).toBe(false)
    const enough = read([creator({ people: 20, went_further: 0 })])
    expect(standsOut(enough[0], enough)).toBe(true)
    // A program with one reward has nowhere further to go.
    const single = read([creator({ people: 500, went_further: null })])
    expect(standsOut(single[0], single)).toBe(false)
  })

  it('singles out a creator far below the others, when there are others to compare with', () => {
    const read = (rowsOf: Row[]) => readRewards(answer([], { creators: rowsOf })).creators
    const low = creator({ member_id: 'm-low', name: 'Low', people: 400, went_further: 4 })
    // The others: 15 of 43 went further, 35%. A quarter of that is under 9%.
    const [a, b, c] = read([mira, jonas, low])
    expect(standsOut(c, [a, b, c])).toBe(true)
    const fair = read([mira, jonas, creator({ member_id: 'm-ok', people: 400, went_further: 40 })])
    expect(standsOut(fair[2], fair)).toBe(false)
    // Alone, or beside too few people, a low share is only a low share.
    const alone = read([low])
    expect(standsOut(alone[0], alone)).toBe(false)
    const thin = read([low, creator({ member_id: 'm-thin', people: 6, went_further: 6 })])
    expect(standsOut(thin[0], thin)).toBe(false)
  })

  it('puts the rows that stand out first and leaves the rest in the order sent', () => {
    const everyone = readRewards(answer([], { creators: [mira, deal, jonas] })).creators
    expect(creatorsInOrder(everyone).map((row: RewardCreator) => row.name)).toEqual([
      'Deal Drop',
      'Mira Maker',
      'Jonas Weber',
    ])
    const calm = readRewards(answer([], { creators: [jonas, mira] })).creators
    expect(creatorsInOrder(calm).map((row) => row.name)).toEqual(['Jonas Weber', 'Mira Maker'])
  })
})

describe('the words on the page', () => {
  const words = (over: Row) => awardStatus(readRewards(answer([award(over)])).awards[0])
  const reasons: Record<string, string> = {
    not_a_member: 'The creator was not in your program',
    not_in_terms: 'Not in the terms the creator accepted',
    already_rewarded: 'This person already earned it',
    own_action: 'The creator’s own action',
    budget_reached: 'Your monthly budget was used up',
    daily_limit: 'The creator reached the daily limit',
    balance_empty: 'Your balance could not cover it',
    program_paused: 'Your program was paused',
    currency_mismatch: 'Your balance is in another currency',
  }

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
    expect(words({ status: 'something_new' })).toEqual({
      label: 'Recorded',
      tone: 'neutral',
      detail: null,
    })
    expect(statusNames).toEqual({
      pending: 'Pending',
      approved: 'Approved',
      rejected: 'Rejected',
      not_counted: 'Not counted',
    })
  })

  it('says why a reward was rejected, for every reason a merchant can give', () => {
    const details: Record<string, string | null> = {
      fake: 'Fake',
      duplicate: 'Duplicate',
      own_action: 'The creator’s own action',
      low_quality: 'Low quality',
      other: null,
    }
    for (const [reason, detail] of Object.entries(details))
      expect(words({ status: 'rejected', reject_reason: reason })).toEqual({
        label: 'Rejected',
        tone: 'neutral',
        detail,
      })
    expect(words({ status: 'rejected', reject_reason: null }).detail).toBeNull()
    expect(rejectReasonNames).toEqual({
      fake: 'Fake',
      duplicate: 'Duplicate',
      own_action: 'Creator’s own',
      low_quality: 'Low quality',
      other: 'Other',
    })
  })

  it('says why an event earned nothing, for every reason the database gives', () => {
    for (const [reason, detail] of Object.entries(reasons)) {
      const said = words({ status: 'not_counted', reason })
      expect(said.label).toBe('Not counted')
      expect(said.detail).toBe(detail)
      // The three the merchant can do something about stand out.
      expect(said.tone).toBe(
        ['balance_empty', 'program_paused', 'budget_reached'].includes(reason)
          ? 'warning'
          : 'neutral',
      )
    }
    // A reason from a later version is not shown as a code.
    expect(words({ status: 'not_counted', reason: 'new_rule_17' })).toEqual({
      label: 'Not counted',
      tone: 'neutral',
      detail: null,
    })
    expect(words({ status: 'not_counted', reason: null }).detail).toBeNull()
  })

  it('never shows a code, minor units, or speaks of test mode', () => {
    const said = [
      ...['pending', 'approved', 'something_new'].map((status) => words({ status })),
      ...Object.keys(reasons).map((reason) => words({ status: 'not_counted', reason })),
      ...Object.keys(rejectReasonNames).map((reason) =>
        words({ status: 'rejected', reject_reason: reason }),
      ),
    ].flatMap(({ label, detail }) => (detail ? [label, detail] : [label]))
    for (const text of [
      ...said,
      ...Object.values(statusNames),
      ...Object.values(emptyNames),
      ...Object.values(rejectReasonNames),
      USED_UP_LINE,
      reasonMessage,
      ...budgetNotes(BUDGET, 'USD'),
      confirmLine(goingBack([{ amount_minor: 200 }], 1000), 'USD'),
      doneLine(2, 440, 'USD'),
    ])
      expect(text).not.toMatch(/_|\btest\b|sandbox|\bminor\b|\bbps\b/i)
  })

  it('shows an amount as earning only while it is pending or approved', () => {
    expect(earns({ status: 'pending' })).toBe(true)
    expect(earns({ status: 'approved' })).toBe(true)
    for (const status of ['rejected', 'not_counted', 'other'] as const)
      expect(earns({ status })).toBe(false)
  })

  it('says the budget in one line, in normal units', () => {
    expect(budgetLine({ budget_minor: 50000, used_minor: 17600 }, 'USD')).toBe(
      '$176.00 of $500.00 used',
    )
    expect(budgetLine({ budget_minor: 50000, used_minor: 17600 }, 'EUR')).toBe(
      '176.00 EUR of 500.00 EUR used',
    )
    expect(budgetLine({ budget_minor: null, used_minor: 0 }, 'USD')).toBe('$0.00 used')
    expect(budgetLeft({ share: 0.352, left_minor: 32400, level: 'fine' }, 'USD')).toBe(
      '$324.00 left',
    )
    expect(budgetLeft({ share: 1, left_minor: 100, level: 'used_up' }, 'USD')).toBe('Used up')
    expect(budgetNotes(BUDGET, 'USD')).toEqual([
      'The 10% KissMyApps fee comes on top.',
      'One creator can earn up to $50.00 a day.',
    ])
    expect(budgetNotes({ fee_bps: 1250, daily_limit_minor: null }, 'USD')).toEqual([
      'The 12.5% KissMyApps fee comes on top.',
    ])
    expect(budgetNotes({ fee_bps: 0, daily_limit_minor: null }, 'USD')).toEqual([])
    expect(budgetNotes({ fee_bps: null, daily_limit_minor: 5000 }, 'EUR')).toEqual([
      'One creator can earn up to 50.00 EUR a day.',
    ])
  })

  it('names the month the budget is for', () => {
    expect(monthName('2026-11')).toBe('November')
    expect(monthName('2027-01')).toBe('January')
    expect(monthName(null)).toBeNull()
  })

  it('says how many went further, and why a row stands out', () => {
    expect(wentFurther({ people: 25, went_further: 9 })).toBe('9 of 25')
    expect(wentFurther({ people: 1500, went_further: 0 })).toBe('0 of 1,500')
    expect(wentFurther({ people: 25, went_further: null })).toBeNull()
    // Nobody earned the first reward: there is nothing to say "of".
    expect(wentFurther({ people: 0, went_further: 0 })).toBeNull()
    expect(standsOutLine({ people: 500, went_further: 0 })).toBe('None of 500 went further')
    expect(standsOutLine({ people: 400, went_further: 4 })).toBe('Only 4 of 400 went further')
  })

  it('says before rejecting how many rewards and how much goes back to the balance', () => {
    expect(rejectTitle(1)).toBe('Reject 1 reward?')
    expect(rejectTitle(12)).toBe('Reject 12 rewards?')
    expect(
      confirmLine(goingBack([{ amount_minor: 200 }, { amount_minor: 200 }], 1000), 'USD'),
    ).toBe(
      '$4.40 goes back to your balance: $4.00 in rewards and $0.40 in fees. The creators do not earn them.',
    )
    expect(confirmLine(goingBack([{ amount_minor: 600 }], 1000), 'USD')).toBe(
      '$6.60 goes back to your balance: $6.00 in rewards and $0.60 in fees. The creator does not earn it.',
    )
    expect(confirmLine(goingBack([{ amount_minor: 600 }], 0), 'USD')).toBe(
      '$6.00 goes back to your balance. The creator does not earn it.',
    )
    // A fee that was not sent is not guessed.
    expect(confirmLine(goingBack([{ amount_minor: 600 }], null), 'EUR')).toBe(
      '6.00 EUR and the KissMyApps fee on it go back to your balance. The creator does not earn it.',
    )
  })

  it('says afterwards what was rejected and what came back', () => {
    expect(doneLine(2, 440, 'USD')).toBe('2 rewards rejected. $4.40 is back in your balance.')
    expect(doneLine(1, 220, 'USD')).toBe('1 reward rejected. $2.20 is back in your balance.')
    expect(doneLine(3, null, 'USD')).toBe('3 rewards rejected. The money is back in your balance.')
  })

  it('accepts no note, a short note, and nothing longer than the database takes', () => {
    expect(NOTE_MAX).toBe(300)
    expect(REJECT_MAX).toBe(100)
    expect(checkNote('')).toBeNull()
    expect(checkNote('x'.repeat(300))).toBeNull()
    expect(checkNote(`  ${'x'.repeat(300)}  `)).toBeNull()
    expect(checkNote('x'.repeat(301))).toBe('Keep the note under 300 characters.')
  })
})

describe('what each failure says', () => {
  const steps: RewardsStep[] = ['load', 'more', 'reject']
  const failed = (details: string | null, code = '22023') =>
    readFailure({ code, details, message: 'From the database.' })

  it('has words for every code the two functions raise', () => {
    expect(describeProblem(failed('not_rejectable'), 'reject')).toEqual({
      code: 'not_rejectable',
      message:
        'Some of these rewards could no longer be rejected, so none were. You are now seeing the latest list.',
      recovery: 'reload',
    })
    expect(describeProblem(failed('invalid_input'), 'reject')).toMatchObject({
      message:
        'That could not be sent as it is, so nothing was rejected. Check the note and try again.',
      recovery: 'none',
    })
    expect(describeProblem(failed('invalid_input'), 'load')).toMatchObject({
      message: 'That creator could not be found. Remove the filter to see every reward.',
      recovery: 'none',
    })
    expect(describeProblem(failed(null, '42501'), 'reject')).toMatchObject({
      code: 'not_allowed',
      message: 'Only an owner or admin can reject rewards. Ask one of them to do this.',
    })
    expect(describeProblem(failed(null, '42501'), 'load').message).toBe(
      'You do not have access to these rewards. Ask an owner of the workspace.',
    )
  })

  it('reads what an errcode alone means', () => {
    expect(describeProblem(failed(null, 'P0002'), 'load').message).toContain(
      'no longer a member of this workspace',
    )
    expect(describeProblem(failed(null, 'PGRST301'), 'reject').recovery).toBe('sign-in')
    expect(
      describeProblem(readFailure({ message: 'TypeError: Failed to fetch' }), 'reject'),
    ).toMatchObject({ code: 'unreachable', recovery: 'retry' })
  })

  it('says rewards are not available yet for a database without them', () => {
    expect(describeProblem(new ProgramError(UNAVAILABLE), 'load')).toEqual({
      code: 'rewards_unavailable',
      message: 'Rewards are not available yet.',
      recovery: 'none',
    })
    expect(describeProblem(new ProgramError(UNAVAILABLE), 'reject').message).toBe(
      'Rewards are not available yet.',
    )
  })

  it('gives an unknown code one plain message for what was being done', () => {
    for (const step of steps) {
      for (const [code, errcode] of [
        ['something_new', 'XX000'],
        [null, 'XX000'],
        [null, '22P02'],
      ] as const) {
        const problem = describeProblem(failed(code, errcode), step)
        expect(problem.message).toBe(fallbackMessages[step])
        expect(problem.recovery).toBe('retry')
      }
      expect(describeProblem(new Error('boom'), step).message).toBe(fallbackMessages[step])
    }
    // A refusal that belongs to rejecting means nothing when reading the list.
    expect(describeProblem(failed('not_rejectable'), 'load').message).toBe(fallbackMessages.load)
  })

  it('never shows a code, and never speaks of test mode', () => {
    const all = [
      ...Object.values(problemMessages).map((item) => item.message),
      ...Object.values(rejectMessages).map((item) => item.message),
      ...Object.values(fallbackMessages),
      STALE_LINE,
    ]
    for (const message of all) {
      expect(message).not.toMatch(/_|\btest\b|sandbox/i)
      expect(message).toMatch(/[.]$/)
    }
  })
})

describe('rewards page: what it shows', () => {
  it('keeps its frame while the list loads', async () => {
    signedInAs('owner')
    const first = held<Row>()
    await openRewards(() => first.promise, '#rewards', false)
    expect(screen.getByRole('status', { name: 'Loading your rewards' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    first.release(answer(mixed))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(screen.queryByRole('status', { name: 'Loading your rewards' })).not.toBeInTheDocument()
  })

  it('says when the list cannot be loaded, and loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openRewards(() =>
      ++attempt === 1 ? new Error('TypeError: Failed to fetch') : answer(mixed),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    await user.click(button('Retry'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent()).toHaveLength(2)
  })

  it('says so when the answer cannot be read, instead of showing wrong money', async () => {
    signedInAs('owner')
    await openRewards({ program: PROGRAM, awards: 'none' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your rewards could not be loaded. Try again.',
    )
    expect(page()).not.toHaveTextContent('$')
  })

  it('offers to sign in again when the session has expired', async () => {
    signedInAs('owner')
    const user = await openRewards(refuse(null, 'PGRST301'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired.')
    expect(buttons('Retry')).toHaveLength(0)
    await user.click(button('Sign in again'))
    await waitFor(() => expect(window.location.hash).toBe('#sign-in'))
  })

  it('says rewards are not available yet when the database does not have them, calmly', async () => {
    for (const errcode of ['PGRST202', '42883']) {
      signedInAs('owner')
      const view = render(<span />)
      view.unmount()
      answers({ workspace_program_rewards: refuse(null, errcode) })
      window.location.hash = '#rewards'
      const { unmount } = render(<MerchantApp />)
      expect(
        await screen.findByText(
          'Rewards are not available yet. There is nothing you need to do here.',
        ),
      ).toBeInTheDocument()
      // Not a broken page: no alert, nothing to retry, no skeleton left behind.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(buttons('Retry')).toHaveLength(0)
      expect(screen.queryByRole('status', { name: 'Loading your rewards' })).toBeNull()
      expect(page()).not.toHaveTextContent(errcode)
      unmount()
      fake.state.listeners.clear()
    }
  })

  it('says in one sentence when there is nothing to review, with the way to the program', async () => {
    signedInAs('owner')
    await openRewards(rewardsFixture.rewards_sales_program)
    const panel = screen.getByRole('region', { name: 'Rewards' })
    expect(panel).toHaveTextContent(
      'Rewards appear here once your program pays creators for events. Open Program',
    )
    expect(within(panel).getByRole('link', { name: 'Open Program' })).toHaveAttribute(
      'href',
      '#program',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('$')
  })

  it('lists the rewards of a program that went back to sales, and says so once', async () => {
    signedInAs('owner')
    await openRewards(answer([pending, other], { program: { ...PROGRAM, earn_from: 'sales' } }))
    expect(page()).toHaveTextContent(
      'Your program pays for sales now, so events earn nothing new. Earlier rewards stay here, and pending ones can still be rejected. Open Program',
    )
    // No budget for a month in which events earn nothing; the list and the ticks stay.
    expect(screen.queryByRole('region', { name: /budget$/ })).not.toBeInTheDocument()
    expect(rows()).toHaveLength(2)
    expect(tick('a-mira-1')).toBeEnabled()
    expect(page()).not.toHaveTextContent('Rewards appear here once')
  })

  it('says the month’s budget in one line and one bar, with the fee and the daily limit quietly', async () => {
    signedInAs('owner')
    await openRewards()
    expect(within(month()).getByRole('heading', { name: 'November budget' })).toBeInTheDocument()
    expect(month()).toHaveTextContent('$176.00 of $500.00 used')
    expect(month()).toHaveTextContent('$324.00 left')
    const bar = within(month()).getByRole('meter', { name: 'November budget' })
    expect(bar).toHaveAttribute('aria-valuenow', '176')
    expect(bar).toHaveAttribute('aria-valuemax', '500')
    expect(bar).toHaveAttribute('aria-valuetext', '$176.00 of $500.00 used')
    expect(bar).toHaveClass('is-fine')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('35.2%')
    const quiet = within(month()).getByText(/KissMyApps fee/)
    expect(quiet).toHaveTextContent(
      'The 10% KissMyApps fee comes on top. One creator can earn up to $50.00 a day.',
    )
    expect(quiet).toHaveClass('mc-rw-quiet')
    expect(within(month()).getByRole('link', { name: 'Change budget' })).toHaveAttribute(
      'href',
      '#program',
    )
    // Money is never shown in minor units.
    expect(page()).not.toHaveTextContent('17600')
    expect(page()).not.toHaveTextContent('50000')
  })

  it('says so when the budget is nearly used, and when it is used up', async () => {
    signedInAs('owner')
    const { unmount } = render(<span />)
    unmount()
    await openRewards(rewardsFixture.rewards_budget_nearly)
    expect(month()).toHaveTextContent('$464.00 of $500.00 used')
    expect(month()).toHaveTextContent('$36.00 left')
    expect(within(month()).getByRole('meter')).toHaveClass('is-nearly')
    expect(month()).not.toHaveTextContent('Used up')
  })

  it('says a used-up budget in words, and what ends it', async () => {
    signedInAs('owner')
    await openRewards(rewardsFixture.rewards_budget_reached)
    expect(month()).toHaveTextContent('$500.00 of $500.00 used')
    expect(month()).toHaveTextContent('Used up')
    expect(month()).toHaveTextContent(
      'New events earn nothing until next month, or until you raise the budget.',
    )
    const bar = within(month()).getByRole('meter')
    expect(bar).toHaveClass('is-used_up')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%')
  })

  it('says when no budget is set, and draws no bar for it', async () => {
    signedInAs('owner')
    await openRewards(answer([], { budget: { ...BUDGET, budget_minor: null, used_minor: 0 } }))
    expect(month()).toHaveTextContent('No monthly budget is set, so events earn nothing.')
    expect(within(month()).queryByRole('meter')).not.toBeInTheDocument()
  })

  it('lists each reward with its amount and this month’s count', async () => {
    signedInAs('owner')
    await openRewards()
    const rewardsTable = within(month()).getByRole('table')
    expect(texts(rewardsTable.querySelector('thead tr') as HTMLElement, 'columnheader')).toEqual([
      'Reward',
      'Amount',
      'This month',
      'Total',
    ])
    expect(
      within(rewardsTable)
        .getAllByRole('row')
        .slice(1)
        .map((row) => texts(row)),
    ).toEqual([
      ['Account created', '$2.00', '43', '$86.00'],
      ['Trial started', '$6.00', '15', '$90.00'],
    ])
  })

  it('shows each creator’s last 30 days: clicks, every reward, who went further, what they earned', async () => {
    signedInAs('owner')
    await openRewards()
    expect(creators()).toHaveTextContent('Last 30 days.')
    expect(creators()).toHaveTextContent(
      'Went further: people who earned the first reward and then another.',
    )
    const head = within(creators()).getByRole('table').querySelector('thead tr') as HTMLElement
    expect(texts(head, 'columnheader')).toEqual([
      'Creator',
      'Clicks',
      'Account created',
      'Trial started',
      'Went further',
      'Earned',
      'Rejected',
    ])
    expect(texts(creatorRow('Mira Maker'))).toEqual([
      'Mira Maker',
      '340',
      '25',
      '9',
      '9 of 25',
      '$104.00' + '$52.00 pending',
      '1',
    ])
    // Nothing pending is not said.
    expect(texts(creatorRow('Jonas Weber')).slice(4)).toEqual(['6 of 18', '$72.00', '0'])
    const link = within(creators()).getByRole('link', {
      name: 'Mira Maker: show only their rewards',
    })
    expect(link).toHaveAttribute('href', '#rewards?creator=m-mira')
    // A calm month marks nobody.
    expect(creators().querySelector('.mc-rw-mark')).toBeNull()
  })

  it('marks a creator with many first rewards and nobody going further, in words, and lists them first', async () => {
    signedInAs('owner')
    await openRewards(answer(mixed, { creators: [mira, jonas, deal] }))
    const names = within(creators())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent)
    expect(names).toEqual([
      'Deal Drop' + 'Worth a look: None of 500 went further',
      'Mira Maker',
      'Jonas Weber',
    ])
    const marked = creatorRow('Deal Drop')
    // It is said in words and marked with a shape, so it does not rest on colour.
    expect(within(marked).getByText('None of 500 went further')).toBeVisible()
    expect(marked.querySelector('.mc-rw-mark svg')).not.toBeNull()
    expect(texts(marked).slice(1)).toEqual([
      '540',
      '500',
      '0',
      '0 of 500',
      '$1,000.00' + '$1,000.00 pending',
      '0',
    ])
    expect(creators().querySelectorAll('.mc-rw-mark')).toHaveLength(1)
    // One quiet marker, not an alarm.
    expect(within(creators()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads the month the contract describes for a creator who stands out', async () => {
    signedInAs('owner')
    await openRewards(rewardsFixture.rewards_suspicious)
    expect(creatorRow('Deal Drop')).toHaveTextContent('None of 500 went further')
    expect(
      within(creators()).getByRole('link', { name: 'Deal Drop: show only their rewards' }),
    ).toHaveAttribute('href', `#rewards?creator=${rewardsFixtureStandsOut}`)
    expect(month()).toHaveTextContent('$1,176.00 of $2,500.00 used')
  })

  it('leaves Went further out for a program with one reward', async () => {
    signedInAs('owner')
    await openRewards(rewardsFixture.rewards_one_reward)
    const head = within(creators()).getByRole('table').querySelector('thead tr') as HTMLElement
    expect(texts(head, 'columnheader')).toEqual([
      'Creator',
      'Clicks',
      'Account created',
      'Earned',
      'Rejected',
    ])
    expect(creators()).not.toHaveTextContent('Went further')
    expect(creators().querySelector('.mc-rw-mark')).toBeNull()
  })

  it('shows eight creators and the rest on request', async () => {
    signedInAs('owner')
    const many = Array.from({ length: 30 }, (_, index) =>
      creator({ member_id: `m-${index}`, name: `Creator ${index}` }),
    )
    const user = await openRewards(answer(mixed, { creators: many }))
    expect(within(creators()).getAllByRole('row')).toHaveLength(9)
    expect(creators()).toHaveTextContent('Showing 8 of 30')
    await user.click(button('Show all creators'))
    expect(within(creators()).getAllByRole('row')).toHaveLength(31)
    expect(buttons('Show all creators')).toHaveLength(0)
  })

  it('lists each reward: when, who, through which link, what for, how much, what became of it', async () => {
    signedInAs('owner')
    await openRewards()
    expect(texts(table().querySelector('thead tr') as HTMLElement, 'columnheader')).toEqual([
      'Select',
      'Date',
      'Creator',
      'Channel',
      'Reward',
      'Amount',
      'Status',
    ])
    expect(ids()).toEqual([
      'a-mira-1',
      'a-mira-2',
      'a-jonas-1',
      'a-mira-0',
      'a-mira-x',
      'a-jonas-0',
    ])
    expect(cells('a-mira-1')).toEqual([
      '',
      when(pending.occurred_at),
      'Mira Maker',
      'TikTok',
      'Account created · TikTok',
      '$2.00',
      `Pending until ${formatShortDay(HOLD)}`,
    ])
    expect(cells('a-mira-2').slice(3, 6)).toEqual([
      'Main link',
      'Trial started · Main link',
      '$6.00',
    ])
    // Figures that are compared sit in a right-aligned column.
    expect(rowOf('a-mira-1').querySelectorAll('td.mc-num-col')).toHaveLength(1)
  })

  it('says every status in words, and why a reward did not count or was rejected', async () => {
    signedInAs('owner')
    const not = (reason: string, id: string) =>
      award({ award_id: id, status: 'not_counted', reason, hold_until: null, can_reject: false })
    await openRewards(
      answer([
        pending,
        approved,
        rejected,
        uncounted,
        not('budget_reached', 'a-budget'),
        not('daily_limit', 'a-daily'),
        not('own_action', 'a-own'),
        not('new_rule_17', 'a-new'),
      ]),
    )
    const said = (id: string) => cells(id).at(-1)
    expect(said('a-jonas-0')).toBe('Approved')
    expect(said('a-mira-0')).toBe('Rejected' + 'Duplicate')
    expect(said('a-mira-x')).toBe('Not counted' + 'This person already earned it')
    expect(said('a-budget')).toBe('Not counted' + 'Your monthly budget was used up')
    expect(said('a-daily')).toBe('Not counted' + 'The creator reached the daily limit')
    expect(said('a-own')).toBe('Not counted' + 'The creator’s own action')
    expect(said('a-new')).toBe('Not counted')
    // What earned nothing shows no amount; what was rejected keeps the amount that went back.
    expect(cells('a-mira-x').at(-2)).toBe('—None')
    expect(cells('a-mira-0').at(-2)).toBe('$2.00')
    expect(page()).not.toHaveTextContent(/already_rewarded|budget_reached|new_rule_17/)
  })

  it('says when a reward is tied to no link, and when the creator is not known', async () => {
    signedInAs('owner')
    await openRewards(
      answer([other, award({ award_id: 'a-none', member_id: null, creator_name: null })]),
    )
    expect(cells('a-jonas-1').slice(3, 5)).toEqual(['No link', 'Account created · No link'])
    expect(cells('a-none')[2]).toBe('—Not known')
  })

  it('shows money in the program’s currency', async () => {
    signedInAs('owner')
    await openRewards(answer([pending], { currency: 'EUR' }))
    expect(cells('a-mira-1')[5]).toBe('2.00 EUR')
    expect(month()).toHaveTextContent('176.00 EUR of 500.00 EUR used')
    expect(texts(creatorRow('Mira Maker'))[5]).toBe('104.00 EUR' + '52.00 EUR pending')
  })

  it('never shows anything about the person who did the event, or speaks of test mode', async () => {
    signedInAs('owner')
    await openRewards(
      answer([{ ...pending, person_id: 'person-123', session_id: 'session-456', event_id: 789 }]),
    )
    expect(page()).not.toHaveTextContent(/person-123|session-456|789|@/)
    expect(page().innerHTML).not.toMatch(/person-123|session-456/)
    expect(page()).not.toHaveTextContent(/\btest\b|sandbox/i)
  })

  it('says a paused program earns nothing, with the way to the program', async () => {
    signedInAs('owner')
    await openRewards(answer(mixed, { program: { ...PROGRAM, status: 'paused' } }))
    const banner = screen.getByText(/This program is paused/).closest('p') as HTMLElement
    expect(banner).toHaveTextContent(
      'This program is paused, so events earn nothing until it is live again.',
    )
    expect(within(banner).getByRole('link', { name: 'Open Program' })).toHaveAttribute(
      'href',
      '#program',
    )
  })

  it('says what will appear while a live program has no rewards, and keeps the budget in view', async () => {
    signedInAs('owner')
    await openRewards(rewardsFixture.rewards_empty)
    expect(month()).toHaveTextContent('$0.00 of $500.00 used')
    expect(list()).toHaveTextContent(
      'No rewards yet. One appears here each time someone from a creator’s link does one of your events. Open Creators',
    )
    expect(within(list()).getByRole('link', { name: 'Open Creators' })).toHaveAttribute(
      'href',
      '#creators',
    )
    expect(within(list()).queryByRole('table')).not.toBeInTheDocument()
    // Nobody earned anything, so there is no creators table to show empty.
    expect(screen.queryByRole('region', { name: 'Creators' })).not.toBeInTheDocument()
  })

  it('says events earn once a program that is not live yet is', async () => {
    signedInAs('owner')
    await openRewards(answer([], { program: { ...PROGRAM, status: 'in_review' }, creators: [] }))
    expect(list()).toHaveTextContent('Events earn rewards once your program is live. Open Program')
  })

  it('keeps long names whole and on the page', async () => {
    signedInAs('owner')
    const long = 'Maximiliano Alexander Fitzgerald-Montgomery von Hohenzollern the Third'
    const label = 'Completed the whole onboarding questionnaire'.slice(0, 40)
    await openRewards(
      answer(
        [
          award({
            creator_name: long,
            link_name: 'Instagram story highlight link',
            reward_label: label,
          }),
        ],
        {
          creators: [creator({ name: long })],
          rewards: [{ ...SIGNUP, label, count: 1200000, amount_total_minor: 240000000 }],
        },
      ),
    )
    expect(cells('a-mira-1')[2]).toBe(long)
    expect(cells('a-mira-1')[4]).toBe(`${label} · Instagram story highlight link`)
    expect(creatorRow(long)).toBeInTheDocument()
    expect(month()).toHaveTextContent('1,200,000')
    expect(month()).toHaveTextContent('$2,400,000.00')
  })
})

describe('rewards page: one creator', () => {
  it('asks for one creator’s rewards and names them on a chip', async () => {
    signedInAs('owner')
    await openRewards(answer([pending, trial]), '#rewards?creator=m-mira')
    expect(asked()[0]).toEqual({
      limit: PAGE_SIZE,
      before: null,
      member_id: 'm-mira',
      status: null,
    })
    expect(within(list()).getByRole('heading', { name: 'Rewards from' })).toBeInTheDocument()
    expect(button('Remove filter: Mira Maker')).toBeInTheDocument()
    // Their own row of the last 30 days stays in view; the others wait for the filter to go.
    expect(within(creators()).getAllByRole('row')).toHaveLength(2)
    expect(creatorRow('Mira Maker')).toBeInTheDocument()
    // Narrowed to them already, their name is only a name.
    expect(screen.queryByRole('link', { name: /show only their rewards/ })).toBeNull()
  })

  it('reads the filtered answer the contract describes', async () => {
    signedInAs('owner')
    await openRewards(
      rewardsFixture.rewards_filtered_creator,
      `#rewards?creator=${rewardsFixtureMember}`,
    )
    expect(asked()[0]).toMatchObject({ member_id: rewardsFixtureMember })
    expect(button('Remove filter: Mira Maker')).toBeInTheDocument()
    expect(rows()).toHaveLength(4)
  })

  it('shows everyone’s rewards again when the chip is removed', async () => {
    signedInAs('owner')
    const user = await openRewards(
      (args: Args) => (input(args).member_id ? answer([pending]) : answer(mixed)),
      '#rewards?creator=m-mira',
    )
    expect(rows()).toHaveLength(1)
    await user.click(button('Remove filter: Mira Maker'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(window.location.hash).toBe('#rewards')
    expect(within(list()).getByRole('heading', { name: 'All rewards' })).toBeInTheDocument()
    expect(asked().at(-1)).toMatchObject({ member_id: null })
  })

  it('goes from everyone to one creator through a name, in the list or in the table', async () => {
    signedInAs('owner')
    const user = await openRewards((args: Args) =>
      input(args).member_id === 'm-jonas' ? answer([other]) : answer(mixed),
    )
    await user.click(
      within(rowOf('a-jonas-1')).getByRole('link', {
        name: 'Jonas Weber: show only their rewards',
      }),
    )
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(window.location.hash).toBe('#rewards?creator=m-jonas')
    expect(button('Remove filter: Jonas Weber')).toBeInTheDocument()
  })

  it('says a creator has no rewards yet, by name, with the way back to all rewards', async () => {
    signedInAs('owner')
    answers({ workspace_program_creators: people(['m-new', 'Priya Nair']) })
    await openRewards(answer([]), '#rewards?creator=m-new')
    expect(await screen.findByText(/No rewards from Priya Nair yet\./)).toBeInTheDocument()
    expect(button('Remove filter: Priya Nair')).toBeInTheDocument()
    expect(within(list()).getByRole('link', { name: 'Show all rewards' })).toHaveAttribute(
      'href',
      '#rewards',
    )
    expect(sent('creators')).toHaveLength(1)
    // Their name was not on the page, so there is no row for them above the list.
    expect(screen.queryByRole('region', { name: 'Creators' })).not.toBeInTheDocument()
  })

  it('still filters when the creator’s name cannot be found', async () => {
    signedInAs('owner')
    answers({ workspace_program_creators: new Error('TypeError: Failed to fetch') })
    await openRewards(answer([]), '#rewards?creator=m-gone')
    expect(await screen.findByText(/No rewards from them yet\./)).toBeInTheDocument()
    expect(button('Remove filter: One creator')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the chip when the list cannot be loaded, so the filter can be taken off', async () => {
    signedInAs('owner')
    const user = await openRewards(
      (args: Args) => (input(args).member_id ? refuse('invalid_input') : answer(mixed)),
      '#rewards?creator=not-a-member',
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That creator could not be found. Remove the filter to see every reward.',
    )
    expect(buttons('Retry')).toHaveLength(0)
    await user.click(button('Remove filter: One creator'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('rewards page: one status', () => {
  const byStatus = (args: Args) => {
    const status = input(args).status
    if (status === 'pending') return answer([pending, trial, other])
    if (status === 'approved') return answer([])
    return answer(mixed)
  }
  const filter = () => screen.getByRole('group', { name: 'Status' })
  const choice = (name: string) => within(filter()).getByRole('button', { name })

  it('offers every status, with all of them shown first', async () => {
    signedInAs('owner')
    await openRewards()
    expect(
      within(filter())
        .getAllByRole('button')
        .map((item) => [item.textContent, item.getAttribute('aria-pressed')]),
    ).toEqual([
      ['All', 'true'],
      ['Pending', 'false'],
      ['Approved', 'false'],
      ['Rejected', 'false'],
      ['Not counted', 'false'],
    ])
  })

  it('asks for one status and lists what comes back', async () => {
    signedInAs('owner')
    const user = await openRewards(byStatus)
    await user.click(choice('Pending'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(asked().at(-1)).toEqual({
      limit: PAGE_SIZE,
      before: null,
      member_id: null,
      status: 'pending',
    })
    expect(choice('Pending')).toHaveAttribute('aria-pressed', 'true')
    await user.click(choice('All'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(asked().at(-1)).toMatchObject({ status: null })
  })

  it('reads the pending answer the contract describes', async () => {
    signedInAs('owner')
    const user = await openRewards((args: Args) =>
      input(args).status === 'pending'
        ? rewardsFixture.rewards_pending_only
        : rewardsFixture.rewards_busy,
    )
    expect(rows()).toHaveLength(11)
    await user.click(choice('Pending'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(ticks()).toHaveLength(4)
  })

  it('keeps the creator when the status changes', async () => {
    signedInAs('owner')
    const user = await openRewards(byStatus, '#rewards?creator=m-mira')
    await user.click(choice('Pending'))
    await waitFor(() => expect(sent()).toHaveLength(2))
    expect(asked().at(-1)).toMatchObject({ member_id: 'm-mira', status: 'pending' })
  })

  it('keeps the page and shows the list is loading while another status is asked for', async () => {
    signedInAs('owner')
    const next = held<Row>()
    const user = await openRewards((args: Args) =>
      input(args).status ? next.promise : answer(mixed),
    )
    await user.click(choice('Rejected'))
    expect(await within(list()).findByRole('status', { name: 'Loading rewards' })).toBeVisible()
    expect(within(list()).queryByRole('table')).not.toBeInTheDocument()
    // The budget and the creators stay where they are.
    expect(month()).toHaveTextContent('$176.00 of $500.00 used')
    expect(creators()).toBeInTheDocument()
    next.release(answer([rejected]))
    await waitFor(() => expect(ids()).toEqual(['a-mira-0']))
  })

  it('says a status has nothing in it, and shows every status again on request', async () => {
    signedInAs('owner')
    const user = await openRewards(byStatus)
    await user.click(choice('Approved'))
    expect(await within(list()).findByText(/No approved rewards\./)).toBeInTheDocument()
    await user.click(button('Show every status'))
    await waitFor(() => expect(rows()).toHaveLength(6))
    expect(choice('All')).toHaveAttribute('aria-pressed', 'true')
  })

  it('names the creator when one creator has nothing in a status', async () => {
    signedInAs('owner')
    const user = await openRewards(byStatus, '#rewards?creator=m-mira')
    await user.click(choice('Approved'))
    expect(
      await within(list()).findByText(/No approved rewards from Mira Maker\./),
    ).toBeInTheDocument()
  })

  it('says so in the list when another status cannot be loaded, and loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openRewards((args: Args) => {
      if (!input(args).status) return answer(mixed)
      return ++attempt === 1 ? new Error('TypeError: Failed to fetch') : answer([rejected])
    })
    await user.click(choice('Rejected'))
    expect(await within(list()).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(month()).toHaveTextContent('$176.00 of $500.00 used')
    await user.click(button('Retry'))
    await waitFor(() => expect(ids()).toEqual(['a-mira-0']))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('rewards page: more rewards', () => {
  const first = answer([pending, trial], { next_before: trial.occurred_at })
  const second = answer([other, rejected], { next_before: rejected.occurred_at })
  const last = answer([approved])
  const paged = (args: Args) => {
    const before = input(args).before
    return before === trial.occurred_at ? second : before === rejected.occurred_at ? last : first
  }

  it('adds the next page under the list with Show more, until there is no more', async () => {
    signedInAs('owner')
    const user = await openRewards(paged)
    expect(rows()).toHaveLength(2)
    expect(list()).toHaveTextContent('Showing the latest 2')
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(asked().at(-1)).toEqual({
      limit: PAGE_SIZE,
      before: trial.occurred_at,
      member_id: null,
      status: null,
    })
    expect(ids()).toEqual(['a-mira-1', 'a-mira-2', 'a-jonas-1', 'a-mira-0'])
    // Focus follows the list down to the first reward that was added.
    expect(rowOf('a-jonas-1')).toHaveFocus()
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(buttons('Show more')).toHaveLength(0)
    expect(list()).toHaveTextContent('All 5 rewards shown')
    expect(sent()).toHaveLength(3)
  })

  it('reads the two pages the contract describes', async () => {
    signedInAs('owner')
    const user = await openRewards((args: Args) =>
      input(args).before ? rewardsFixture.rewards_next_page : rewardsFixture.rewards_busy,
    )
    expect(rows()).toHaveLength(11)
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(12))
    expect(buttons('Show more')).toHaveLength(0)
  })

  it('keeps asking for the same creator and status on the next page', async () => {
    signedInAs('owner')
    const user = await openRewards(paged, '#rewards?creator=m-mira')
    await user.click(within(screen.getByRole('group', { name: 'Status' })).getByText('Pending'))
    await waitFor(() => expect(sent()).toHaveLength(2))
    await user.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(sent()).toHaveLength(3))
    expect(asked().at(-1)).toEqual({
      limit: PAGE_SIZE,
      before: trial.occurred_at,
      member_id: 'm-mira',
      status: 'pending',
    })
  })

  it('shows that it is loading, and cannot be asked twice', async () => {
    signedInAs('owner')
    const next = held<Row>()
    const user = await openRewards((args: Args) => (input(args).before ? next.promise : first))
    await user.click(button('Show more'))
    const busy = await screen.findByRole('button', { name: 'Loading' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    expect(sent()).toHaveLength(2)
    next.release(last)
    await waitFor(() => expect(rows()).toHaveLength(3))
  })

  it('never lists a reward twice when a page overlaps the one before', async () => {
    signedInAs('owner')
    const user = await openRewards((args: Args) =>
      input(args).before ? answer([trial, other]) : first,
    )
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(ids()).toEqual(['a-mira-1', 'a-mira-2', 'a-jonas-1'])
  })

  it('keeps the list and says so when more cannot be loaded, then loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openRewards((args: Args) => {
      if (!input(args).before) return first
      return ++attempt === 1 ? refuse('something_new', 'XX000') : last
    })
    await user.click(button('Show more'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'More rewards could not be loaded. Try again.',
    )
    expect(rows()).toHaveLength(2)
    await user.click(button('Retry'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('rewards page: staying current', () => {
  it('looks for new rewards by itself, and keeps the page when that fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      await openRewards(() => {
        reads += 1
        if (reads === 1) return answer([trial])
        if (reads === 2) return answer([pending, trial])
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

  it('leaves the list alone while rewards are selected, and once more of it was asked for', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      const user = await openRewards((args: Args) =>
        input(args).before
          ? answer([other])
          : answer([pending, trial], { next_before: trial.occurred_at }),
      )
      await user.click(tick('a-mira-1'))
      await vi.advanceTimersByTimeAsync(180_000)
      expect(sent()).toHaveLength(1)
      expect(tick('a-mira-1')).toBeChecked()
      // With nothing selected it looks again.
      await user.click(tick('a-mira-1'))
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(sent()).toHaveLength(2))
      await user.click(button('Show more'))
      await waitFor(() => expect(rows()).toHaveLength(3))
      await vi.advanceTimersByTimeAsync(180_000)
      expect(sent()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('rewards page: rejecting', () => {
  const rejections = () => sent('reward_reject')
  const done = { rejected: 2, returned_minor: 440 }
  /** The list as the database has it after the two $2.00 rewards were rejected. */
  const after = answer(
    [
      { ...pending, status: 'rejected', reject_reason: 'fake', can_reject: false },
      trial,
      { ...other, status: 'rejected', reject_reason: 'fake', can_reject: false },
      rejected,
      uncounted,
      approved,
    ],
    { budget: { ...BUDGET, used_minor: 17200 } },
  )

  it('lets an owner or admin tick the rewards that are still pending, and only those', async () => {
    signedInAs('owner')
    await openRewards()
    expect(ticks()).toHaveLength(3)
    expect(tick('a-mira-1')).toHaveAccessibleName('Select: Mira Maker, Account created, $2.00')
    for (const id of ['a-mira-0', 'a-mira-x', 'a-jonas-0'])
      expect(within(rowOf(id)).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Selected rewards' })).not.toBeInTheDocument()
    expect(buttons('Reject')).toHaveLength(0)
  })

  it('shows a member who cannot manage the list and nothing to press', async () => {
    signedInAs('analyst')
    await openRewards(rewardsFixture.rewards_viewer)
    expect(rows()).toHaveLength(6)
    expect(ticks()).toHaveLength(0)
    expect(buttons(/^Select|^Reject\b/)).toHaveLength(0)
    expect(texts(table().querySelector('thead tr') as HTMLElement, 'columnheader')).toEqual([
      'Date',
      'Creator',
      'Channel',
      'Reward',
      'Amount',
      'Status',
    ])
    expect(list()).toHaveTextContent('Only an owner or admin of No Brainer Lab can reject rewards.')
    expect(within(month()).getByRole('link', { name: 'Open Program' })).toBeInTheDocument()
    expect(within(month()).queryByRole('link', { name: 'Change budget' })).toBeNull()
  })

  it('offers nothing to tick when nothing on the page is pending', async () => {
    signedInAs('owner')
    await openRewards(answer([approved, rejected, uncounted]))
    expect(ticks()).toHaveLength(0)
    expect(buttons(/^Select/)).toHaveLength(0)
    expect(list()).not.toHaveTextContent('Only an owner or admin')
  })

  it('says how many are selected and what they come to, and clears on request', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await user.click(tick('a-mira-1'))
    expect(bar()).toHaveTextContent('1 selected' + '$2.00')
    expect(rowOf('a-mira-1')).toHaveClass('is-picked')
    await user.click(tick('a-mira-2'))
    expect(bar()).toHaveTextContent('2 selected' + '$8.00')
    await user.click(tick('a-mira-1'))
    expect(bar()).toHaveTextContent('1 selected' + '$6.00')
    await user.click(within(bar()).getByRole('button', { name: 'Clear' }))
    expect(screen.queryByRole('group', { name: 'Selected rewards' })).not.toBeInTheDocument()
    expect(tick('a-mira-2')).not.toBeChecked()
    expect(rejections()).toHaveLength(0)
  })

  it('selects every pending reward on the page at once, and clears them again', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await user.click(button('Select all pending'))
    expect(ticks().every((box) => (box as HTMLInputElement).checked)).toBe(true)
    expect(bar()).toHaveTextContent('3 selected' + '$10.00')
    await user.click(button('Clear selection'))
    expect(ticks().some((box) => (box as HTMLInputElement).checked)).toBe(false)
    expect(button('Select all pending')).toBeInTheDocument()
  })

  it('selects at most a hundred, the most one rejection can name', async () => {
    signedInAs('owner')
    const many = Array.from({ length: 104 }, (_, index) =>
      award({ award_id: `a-${index}`, occurred_at: ago(index + 1) }),
    )
    const user = await openRewards(answer(many))
    await user.click(button('Select the first 100 pending'))
    expect(bar()).toHaveTextContent('100 selected' + '$200.00' + 'The most at one time')
    expect(tick('a-99')).toBeChecked()
    expect(tick('a-100')).not.toBeChecked()
    expect(tick('a-100')).toBeDisabled()
    // Room for another once one is let go.
    await user.click(tick('a-0'))
    expect(tick('a-100')).toBeEnabled()
    await user.click(tick('a-100'))
    await user.click(within(bar()).getByRole('button', { name: 'Reject' }))
    expect(dialog()).toHaveAccessibleName('Reject 100 rewards?')
  })

  it('asks first, saying how many rewards and how much goes back to the balance', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await user.click(tick('a-mira-1'))
    await user.click(tick('a-jonas-1'))
    await user.click(within(bar()).getByRole('button', { name: 'Reject' }))
    expect(dialog()).toHaveAccessibleName('Reject 2 rewards?')
    expect(dialog()).toHaveAccessibleDescription(
      '$4.40 goes back to your balance: $4.00 in rewards and $0.40 in fees. The creators do not earn them. This cannot be undone.',
    )
    expect(
      within(dialog())
        .getAllByRole('radio')
        .map((item) => [(item as HTMLInputElement).labels?.[0].textContent, item]),
    ).toHaveLength(5)
    for (const name of ['Fake', 'Duplicate', 'Creator’s own', 'Low quality', 'Other'])
      expect(within(dialog()).getByRole('radio', { name })).not.toBeChecked()
    expect(within(dialog()).getByLabelText('Note (optional)')).toHaveValue('')
    expect(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' })).toBeEnabled()
    // Nothing is sent by opening it.
    expect(rejections()).toHaveLength(0)
  })

  it('says the fee comes back too when it is not known how much it is', async () => {
    signedInAs('owner')
    const user = await openRewards(answer(mixed, { budget: { ...BUDGET, fee_bps: null } }))
    await user.click(tick('a-mira-2'))
    await user.click(within(bar()).getByRole('button', { name: 'Reject' }))
    expect(dialog()).toHaveAccessibleName('Reject 1 reward?')
    expect(dialog()).toHaveAccessibleDescription(
      '$6.00 and the KissMyApps fee on it go back to your balance. The creator does not earn it. This cannot be undone.',
    )
  })

  it('wants a reason before anything is sent', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await ask(user, ['a-mira-1'], '')
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    expect(within(dialog()).getByText('Choose a reason.')).toBeVisible()
    expect(rejections()).toHaveLength(0)
    await user.click(within(dialog()).getByRole('radio', { name: 'Duplicate' }))
    expect(within(dialog()).queryByText('Choose a reason.')).not.toBeInTheDocument()
  })

  it('refuses a note that is too long before anything is sent', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await ask(user, ['a-mira-1'])
    const note = within(dialog()).getByLabelText('Note (optional)')
    await user.click(note)
    await user.paste('x'.repeat(301))
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    expect(within(dialog()).getByText('Keep the note under 300 characters.')).toBeVisible()
    expect(note).toHaveAttribute('aria-invalid', 'true')
    expect(rejections()).toHaveLength(0)
  })

  it('sends nothing on Cancel, and keeps what was selected', async () => {
    signedInAs('owner')
    const user = await openRewards()
    await ask(user, ['a-mira-1', 'a-jonas-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(rejections()).toHaveLength(0)
    expect(bar()).toHaveTextContent('2 selected')
    // The reason is asked again next time: it is never carried over.
    await user.click(within(bar()).getByRole('button', { name: 'Reject' }))
    expect(within(dialog()).getByRole('radio', { name: 'Fake' })).not.toBeChecked()
  })

  it('rejects the selected rewards with the reason and the note, and says what came back', async () => {
    signedInAs('owner')
    let rejectedNow = false
    answers({
      workspace_program_reward_reject: () => {
        rejectedNow = true
        return done
      },
    })
    const user = await openRewards(() => (rejectedNow ? after : answer(mixed)))
    await ask(user, ['a-mira-1', 'a-jonas-1'], 'Duplicate')
    await user.type(within(dialog()).getByLabelText('Note (optional)'), '  Same device twice  ')
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(rejections()).toEqual([
      {
        p_workspace_id: 'ws-1',
        p_input: {
          award_ids: ['a-mira-1', 'a-jonas-1'],
          reason: 'duplicate',
          note: 'Same device twice',
        },
      },
    ])
    const said = within(list()).getByText('2 rewards rejected. $4.40 is back in your balance.')
    expect(said.closest('[role="status"]')).not.toBeNull()
    await waitFor(() => expect(said.closest('[role="status"]')).toHaveFocus())
    // The list is read again: the two are rejected, and the budget has them back.
    await waitFor(() => expect(month()).toHaveTextContent('$172.00 of $500.00 used'))
    expect(cells('a-mira-1').at(-1)).toBe('Rejected' + 'Fake')
    expect(cells('a-jonas-1').at(-1)).toBe('Rejected' + 'Fake')
    expect(ticks()).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Selected rewards' })).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('440')
  })

  it('sends no note when none is typed', async () => {
    signedInAs('owner')
    answers({ workspace_program_reward_reject: { rejected: 1, returned_minor: 660 } })
    const user = await openRewards()
    await ask(user, ['a-mira-2'], 'Creator’s own')
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    await within(list()).findByText('1 reward rejected. $6.60 is back in your balance.')
    expect(input(rejections()[0])).toEqual({
      award_ids: ['a-mira-2'],
      reason: 'own_action',
      note: null,
    })
  })

  it('cannot be pressed twice: one rejection is sent however fast the button is pressed', async () => {
    signedInAs('owner')
    const sending = held<Row>()
    answers({ workspace_program_reward_reject: () => sending.promise })
    const user = await openRewards()
    await ask(user, ['a-mira-1', 'a-jonas-1'])
    const confirm = within(dialog()).getByRole('button', { name: 'Reject 2 rewards' })
    await user.dblClick(confirm)
    const busy = await within(dialog()).findByRole('button', { name: 'Rejecting' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    await user.keyboard('{Enter}')
    expect(rejections()).toHaveLength(1)
    // While it is on its way the dialog cannot be left and nothing in it can be changed.
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog()).getByRole('radio', { name: 'Fake' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(dialog()).toBeInTheDocument()
    sending.release(done)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await within(list()).findByText('2 rewards rejected. $4.40 is back in your balance.')
    expect(rejections()).toHaveLength(1)
  })

  it('still says what was rejected when the answer leaves the figures out', async () => {
    signedInAs('owner')
    answers({ workspace_program_reward_reject: {} })
    const user = await openRewards()
    await ask(user, ['a-mira-1', 'a-jonas-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' }))
    expect(
      await within(list()).findByText('2 rewards rejected. The money is back in your balance.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads the list again and says so when some could no longer be rejected', async () => {
    signedInAs('owner')
    let refused = false
    answers({
      workspace_program_reward_reject: () => {
        refused = true
        return refuse('not_rejectable')
      },
    })
    // In the meantime the hold of one of them ended.
    const moved = answer([{ ...pending, status: 'approved', can_reject: false }, trial, other])
    const user = await openRewards(() => (refused ? moved : answer(mixed)))
    await ask(user, ['a-mira-1', 'a-jonas-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      await within(list()).findByText(
        'Some of these rewards could no longer be rejected, so none were. You are now seeing the latest list.',
      ),
    ).toBeVisible()
    // Not an error to fix: the page has already done the one thing there is to do.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent()).toHaveLength(2)
    expect(cells('a-mira-1').at(-1)).toBe('Approved')
    expect(cells('a-jonas-1').at(-1)).toBe(`Pending until ${formatShortDay(HOLD)}`)
    // Nothing stays selected: what is rejected next is chosen again, on the list as it is now.
    expect(screen.queryByRole('group', { name: 'Selected rewards' })).not.toBeInTheDocument()
    expect(ticks().some((box) => (box as HTMLInputElement).checked)).toBe(false)
    expect(page()).not.toHaveTextContent('not_rejectable')
  })

  it('says so when the list cannot be read again after that, and reads it on Retry', async () => {
    signedInAs('owner')
    let reads = 0
    answers({ workspace_program_reward_reject: refuse('not_rejectable') })
    const user = await openRewards(() => {
      reads += 1
      return reads === 2 ? new Error('TypeError: Failed to fetch') : answer(mixed)
    })
    await ask(user, ['a-mira-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    expect(await within(list()).findByRole('alert')).toHaveTextContent(
      'Some of these rewards could no longer be rejected, so none were. The list could not be read again.',
    )
    await user.click(within(list()).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sent()).toHaveLength(3))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('keeps the dialog and what was chosen when the rejection does not go through', async () => {
    signedInAs('owner')
    let attempt = 0
    answers({
      workspace_program_reward_reject: () =>
        ++attempt === 1 ? new Error('TypeError: Failed to fetch') : done,
    })
    const user = await openRewards()
    await ask(user, ['a-mira-1', 'a-jonas-1'], 'Low quality')
    await user.type(within(dialog()).getByLabelText('Note (optional)'), 'Bounced at once')
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(within(dialog()).getByRole('radio', { name: 'Low quality' })).toBeChecked()
    expect(within(dialog()).getByLabelText('Note (optional)')).toHaveValue('Bounced at once')
    // Its own button tries again.
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 2 rewards' }))
    await within(list()).findByText('2 rewards rejected. $4.40 is back in your balance.')
    expect(rejections()).toHaveLength(2)
    expect(input(rejections()[1])).toEqual({
      award_ids: ['a-mira-1', 'a-jonas-1'],
      reason: 'low_quality',
      note: 'Bounced at once',
    })
  })

  it('gives an unknown failure one plain message that says nothing was rejected', async () => {
    signedInAs('owner')
    answers({ workspace_program_reward_reject: refuse('something_new', 'XX000') })
    const user = await openRewards()
    await ask(user, ['a-mira-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Nothing was rejected. Try again.',
    )
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(cells('a-mira-1').at(-1)).toBe(`Pending until ${formatShortDay(HOLD)}`)
  })

  it('takes the ticks away when the database says this person may not reject', async () => {
    signedInAs('owner')
    answers({ workspace_program_reward_reject: refuse(null, '42501') })
    const user = await openRewards()
    await ask(user, ['a-mira-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await within(list()).findByRole('alert')).toHaveTextContent(
      'Only an owner or admin can reject rewards. Ask one of them to do this.',
    )
    expect(ticks()).toHaveLength(0)
    expect(buttons(/^Select|^Reject\b/)).toHaveLength(0)
    expect(buttons('Retry')).toHaveLength(0)
  })

  it('takes rejected rewards out of a list narrowed to pending', async () => {
    signedInAs('owner')
    let rejectedNow = false
    answers({
      workspace_program_reward_reject: () => {
        rejectedNow = true
        return { rejected: 1, returned_minor: 220 }
      },
    })
    const user = await openRewards((args: Args) =>
      input(args).status === 'pending'
        ? answer(rejectedNow ? [trial, other] : [pending, trial, other])
        : answer(mixed),
    )
    await user.click(within(screen.getByRole('group', { name: 'Status' })).getByText('Pending'))
    await waitFor(() => expect(rows()).toHaveLength(3))
    await ask(user, ['a-mira-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    await within(list()).findByText('1 reward rejected. $2.20 is back in your balance.')
    await waitFor(() => expect(ids()).toEqual(['a-mira-2', 'a-jonas-1']))
  })

  it('keeps a list that was added to in place, marks the rejected and refreshes the figures', async () => {
    signedInAs('owner')
    let rejectedNow = false
    answers({
      workspace_program_reward_reject: () => {
        rejectedNow = true
        return { rejected: 1, returned_minor: 220 }
      },
    })
    const user = await openRewards((args: Args) =>
      input(args).before
        ? answer([other, approved])
        : answer([pending, trial], {
            next_before: trial.occurred_at,
            budget: { ...BUDGET, used_minor: rejectedNow ? 17400 : 17600 },
          }),
    )
    await user.click(button('Show more'))
    await waitFor(() => expect(rows()).toHaveLength(4))
    await ask(user, ['a-jonas-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    await within(list()).findByText('1 reward rejected. $2.20 is back in your balance.')
    // The list keeps its four rows where the person left them.
    expect(ids()).toEqual(['a-mira-1', 'a-mira-2', 'a-jonas-1', 'a-jonas-0'])
    expect(cells('a-jonas-1').at(-1)).toBe('Rejected' + 'Fake')
    await waitFor(() => expect(month()).toHaveTextContent('$174.00 of $500.00 used'))
    expect(ids()).toHaveLength(4)
  })

  it('says rewards are not available when the database cannot reject yet', async () => {
    signedInAs('owner')
    answers({ workspace_program_reward_reject: refuse(null, 'PGRST202') })
    const user = await openRewards()
    await ask(user, ['a-mira-1'])
    await user.click(within(dialog()).getByRole('button', { name: 'Reject 1 reward' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'Rewards are not available yet.',
    )
  })
})
