import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { MerchantApp } from './MerchantApp'
import { programBackendFixture as before } from './program-backend.fixture'
import { programRewardsBackendFixture as captured } from './program-rewards-backend.fixture'
import {
  agreementReady,
  asksEarnFrom,
  blankReward,
  budgetBelowReward,
  changedInput,
  changesAgreement,
  describeProblem,
  draftEarning,
  draftFromProgram,
  draftProgress,
  earnFromAbout,
  earnHeadline,
  earningStep,
  fieldMessages,
  inputFromDraft,
  labelFromEvent,
  MAX_REWARDS,
  ProgramError,
  readRewardEvents,
  readState,
  rewardField,
  rewardLine,
  rewardMessages,
  rewardsFromRows,
  validateBudget,
  validateDraft,
  validateRewards,
  withRewardKey,
} from './programs'
import type { EarnFrom, Program, ProgramDraft, ProgramState, Reward, RewardRow } from './programs'
import { href } from './routes'

// The program form for a program that pays for events (Phase 6): the readers against the
// hand-written answers, the rules the form checks before sending, the money round trip, and
// the page. The stand-in for the Supabase client is the one programs.test.tsx uses.

type Args = Record<string, unknown>
type Answer = unknown | ((args: Args) => unknown)

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
  const auth = {
    onAuthStateChange(listener: Listener) {
      state.listeners.add(listener)
      setTimeout(() => listener('INITIAL_SESSION', state.session), 0)
      return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } }
    },
    async signOut() {
      state.session = null
      state.listeners.forEach((listener) => listener('SIGNED_OUT', state.session))
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
    if (value instanceof Error) return { data: null, error: { message: value.message } }
    if (value === undefined)
      return { data: null, error: { code: 'XX000', details: null, message: `No answer: ${name}` } }
    return { data: value, error: null }
  }
  const storage = {
    from: (bucket: string) => ({
      async upload(path: string) {
        return { data: { path }, error: null }
      },
      getPublicUrl: (path: string) => ({
        data: { publicUrl: `https://files.example/${bucket}/${path}` },
      }),
    }),
  }
  return { state, client: { auth, rpc, storage } }
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
  user: { id: 'user-1', email: 'owner@example.test', name: 'Fluent Owner' },
  workspaces: [{ id: 'ws-1', name: 'Fluent', role, projects }],
})

const REWARDS: Reward[] = [
  { key: 'signup_completed', label: 'Account created', amount_minor: 200 },
  { key: 'trial_started', label: 'Trial started', amount_minor: 1000 },
]

/** A complete draft that pays for sales, as the database returns it since Phase 6. */
const program = (over: Partial<Program> = {}): Program => ({
  id: 'prog-1',
  revision: 3,
  status: 'draft',
  pause_reason: null,
  review_note: null,
  slug: 'fluent',
  name: 'Fluent',
  category: 'education',
  tagline: 'Speak a new language in ten minutes a day',
  logo_path: null,
  landing_url: 'https://fluent-app.io/start',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  marketplace_listed: true,
  extra_terms: null,
  agreement_read: false,
  has_unpublished_changes: false,
  live_terms_version: null,
  submitted_at: null,
  first_published_at: null,
  updated_at: '2026-11-19T10:12:40.118204+00:00',
  earn_from: 'sales',
  rewards: [],
  reward_budget_minor: null,
  ...over,
})

/** The same program paying for events only: no commission, two rewards and a budget. */
const eventsProgram = (over: Partial<Program> = {}) =>
  program({
    commission_type: null,
    commission_rate_bps: null,
    commission_duration: null,
    commission_months: null,
    approval_mode: 'manual',
    earn_from: 'events',
    rewards: REWARDS,
    reward_budget_minor: 50000,
    ...over,
  })

const live = {
  status: 'live',
  revision: 9,
  agreement_read: true,
  live_terms_version: 1,
  submitted_at: '2026-11-17T10:00:00.120000+00:00',
  first_published_at: '2026-11-18T09:00:00.550058+00:00',
} as const

/** A ProgramState of a workspace that can pay for events, its checklist following the program. */
function programState(
  row: Program | null = program(),
  over: Partial<ProgramState> = {},
): ProgramState {
  const earnFrom = row?.earn_from ?? 'sales'
  const sales = Boolean(row?.commission_type)
  const events = Boolean(row?.rewards?.length && row.reward_budget_minor)
  const checklist = {
    stripe_connected: true,
    details: Boolean(row?.name && row.category && row.tagline),
    landing_page: Boolean(row?.landing_url),
    commission: earnFrom === 'sales' ? sales : earnFrom === 'events' ? events : sales && events,
    agreement_read: Boolean(row?.agreement_read),
  }
  return {
    can_manage: true,
    stripe_connected: true,
    brand_name: 'Fluent Ltd',
    program: row,
    checklist,
    can_submit: false,
    events_available: true,
    ...over,
  }
}

// The events a reward can be tied to, as the database lists them (newest first).
const listed = captured['workspace_program_reward_events.listed']
const none = captured['workspace_program_reward_events.none']
const refuse = (details: string | null, code = '22023') => ({ refused: true, code, details })

const tracking = {
  connected: true,
  payments_seen: 0,
  tagged_payments: 0,
  sales: 0,
  matched_sales: 0,
  last_sale_at: null,
  last_matched_at: null,
  last_match_source: null,
  sdk_click_seen_at: null,
}

function answers(table: Record<string, Answer>) {
  fake.state.table = {
    workspace_program_tracking: tracking,
    workspace_program_reward_events: listed,
    ...table,
  }
}

const sent = (name: string) =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)

async function openProgram(get: Answer = programState(), table: Record<string, Answer> = {}) {
  fake.state.session = { user: { id: 'user-1', email: 'owner@example.test' } }
  answers({ ...table, workspace_program_get: get })
  window.location.hash = '#program'
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Affiliate program', level: 1 })
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Loading your program' })).not.toBeInTheDocument(),
  )
  return userEvent.setup()
}

const page = () => document.querySelector('.mc-prog') as HTMLElement
const form = () => screen.getByRole('form', { name: 'Program details' })
const side = () => screen.getByRole('complementary', { name: 'Preview and publishing' })
const button = (name: string) => screen.getByRole('button', { name })
const field = (name: string) => screen.getByLabelText(name)
const question = () => screen.getByRole('group', { name: 'What do creators earn from?' })
const choose = (name: string) => within(question()).getByRole('button', { name })
const reward = (number: number) => screen.getByRole('group', { name: `Reward ${number}` })
const part = (number: number, name: string) => within(reward(number)).getByLabelText(name)
/** The reward rows are there once the events they can be tied to have been read. */
const rewardsShown = () => waitFor(() => expect(part(1, 'Event')).toBeInTheDocument())
const options = () =>
  within(screen.getByRole('region', { name: 'More options' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent)
const steps = () =>
  within(side())
    .getAllByRole('listitem')
    .map((item) => item.textContent)

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.context = context('owner')
  answers({})
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('reading a program that can pay for events', () => {
  it('asks the question for an events program even where events are switched off', () => {
    expect(asksEarnFrom(programState(eventsProgram(), { events_available: false }))).toBe(true)
    expect(asksEarnFrom(programState(program(), { events_available: false }))).toBe(false)
    expect(asksEarnFrom(programState(null, { events_available: false }))).toBe(false)
    expect(asksEarnFrom(undefined)).toBe(false)
  })

  it('refuses an answer whose earnings it cannot trust', () => {
    const wrong: Array<Partial<Record<keyof Program, unknown>>> = [
      { earn_from: 'installs' },
      { earn_from: null },
      { rewards: null },
      { rewards: { key: 'signup_completed' } },
      { rewards: Array.from({ length: 6 }, (_, at) => ({ ...REWARDS[0], key: `event_${at}` })) },
      { rewards: [{ key: 'signup_completed', label: 'Account created' }] },
      { rewards: [{ ...REWARDS[0], key: '1st_signup' }] },
      { rewards: [{ ...REWARDS[0], label: ' ' }] },
      { rewards: [{ ...REWARDS[0], label: 'x'.repeat(41) }] },
      { rewards: [{ ...REWARDS[0], amount_minor: 0 }] },
      { rewards: [{ ...REWARDS[0], amount_minor: 1.5 }] },
      { rewards: [{ ...REWARDS[0], amount_minor: '200' }] },
      { rewards: [{ ...REWARDS[0], amount_minor: 100_000_001 }] },
      { reward_budget_minor: 99 },
      { reward_budget_minor: '50000' },
    ]
    for (const over of wrong)
      expect(() => readState(programState({ ...eventsProgram(), ...over } as Program))).toThrow(
        ProgramError,
      )
  })

  it('reads only the events a reward can be tied to', () => {
    // A name that could not be saved as a reward is not offered, and no name is offered twice.
    expect(
      readRewardEvents({
        events: [{ name: '$pageview' }, { name: 'signup' }, { name: 'signup' }, { name: 7 }, null],
      }),
    ).toEqual([{ name: 'signup', description: null, first_seen: null, last_seen: null }])
    for (const wrong of [null, [], {}, { events: 'none' }])
      expect(() => readRewardEvents(wrong)).toThrow(ProgramError)
  })
})

describe('money in rewards and the budget', () => {
  const draftOf = (rewards: Reward[], budget: number | null) =>
    draftFromProgram(eventsProgram({ rewards, reward_budget_minor: budget }), true)

  it('shows what is stored in normal units', () => {
    const draft = draftOf(REWARDS, 50000)
    expect(draft.rewards).toEqual([
      { key: 'signup_completed', label: 'Account created', amount: '2.00' },
      { key: 'trial_started', label: 'Trial started', amount: '10.00' },
    ])
    expect(draft.budget).toBe('500.00')
  })

  it('sends back exactly what it was given, never a hundred times more or less', () => {
    for (const minor of [1, 29, 115, 200, 1000, 12550, 99999, 100_000_000]) {
      const rewards = [{ key: 'signup_completed', label: 'Account created', amount_minor: minor }]
      const budget = Math.max(minor, 100)
      const input = inputFromDraft(draftOf(rewards, budget))
      expect(input.rewards).toEqual(rewards)
      expect(input.reward_budget_minor).toBe(budget)
    }
    // Untouched, a saved program has nothing to send: no amount is rewritten on the way.
    const saved = eventsProgram()
    expect(changedInput(draftFromProgram(saved, true), saved)).toEqual({ revision: 3 })
  })

  it('takes money as it is typed', () => {
    const typed = (amount: string) =>
      rewardsFromRows([{ key: 'signup_completed', label: 'Account created', amount }])[0]
        ?.amount_minor
    expect(typed('2')).toBe(200)
    expect(typed('2.5')).toBe(250)
    expect(typed('2.00')).toBe(200)
    expect(typed('$1,250.50')).toBe(125050)
    expect(typed('0.29')).toBe(29)
    for (const wrong of ['', '0', '0.00', '200 cents', '2.005', '-2', '1000000.01'])
      expect(typed(wrong)).toBeUndefined()
    expect(
      inputFromDraft({ ...draftOf(REWARDS, null), budget: ' 1,500 ' }).reward_budget_minor,
    ).toBe(150000)
    expect(inputFromDraft({ ...draftOf(REWARDS, null), budget: '' }).reward_budget_minor).toBeNull()
  })
})

describe('the rules the form checks before sending', () => {
  const row = (over: Partial<RewardRow> = {}): RewardRow => ({
    key: 'signup_completed',
    label: 'Account created',
    amount: '2.00',
    ...over,
  })

  it('takes a good list and ignores a row with nothing in it', () => {
    expect(validateRewards([row(), row({ key: 'trial_started', label: 'Trial started' })])).toEqual(
      {},
    )
    expect(validateRewards([row(), blankReward()])).toEqual({})
    expect(validateRewards([blankReward()])).toEqual({})
    expect(rewardsFromRows([row({ label: ' Account created ' }), blankReward()])).toEqual([
      REWARDS[0],
    ])
  })

  it('wants an event name the database takes, once', () => {
    expect(validateRewards([row({ key: '' })])).toEqual({
      [rewardField(0, 'key')]: rewardMessages.keyMissing,
    })
    for (const key of ['1signup', 'sign up', 'signup!', 'é', 'x'.repeat(81)])
      expect(validateRewards([row({ key })])[rewardField(0, 'key')]).toBe(rewardMessages.keyInvalid)
    for (const key of ['a', 'Signup.Completed', 'trial:started-2', 'x'.repeat(80)])
      expect(validateRewards([row({ key })])).toEqual({})
    expect(validateRewards([row(), row({ label: 'Signed up' })])).toEqual({
      [rewardField(1, 'key')]: rewardMessages.keyRepeated,
    })
  })

  it('wants words for creators, up to 40 characters, not used twice in any case', () => {
    expect(validateRewards([row({ label: '  ' })])).toEqual({
      [rewardField(0, 'label')]: rewardMessages.labelMissing,
    })
    expect(validateRewards([row({ label: 'x'.repeat(41) })])).toEqual({
      [rewardField(0, 'label')]: rewardMessages.labelLong,
    })
    expect(validateRewards([row({ label: 'x'.repeat(40) })])).toEqual({})
    expect(
      validateRewards([row(), row({ key: 'trial_started', label: 'ACCOUNT created ' })]),
    ).toEqual({ [rewardField(1, 'label')]: rewardMessages.labelRepeated })
  })

  it('wants an amount from 0.01 to 1,000,000.00', () => {
    for (const amount of ['', '0', 'two', '2.005'])
      expect(validateRewards([row({ amount })])).toEqual({
        [rewardField(0, 'amount')]: rewardMessages.amount,
      })
    expect(validateRewards([row({ amount: '1000000.01' })])).toEqual({
      [rewardField(0, 'amount')]: rewardMessages.amountLarge,
    })
    for (const amount of ['0.01', '2', '1,000,000.00'])
      expect(validateRewards([row({ amount })])).toEqual({})
  })

  it('takes five rewards at most, and needs one once creators can see the program', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, at) => row({ key: `event_${at}`, label: `Reward ${at}` }))
    expect(MAX_REWARDS).toBe(5)
    expect(validateRewards(many(5))).toEqual({})
    expect(validateRewards(many(6))).toEqual({ rewards: rewardMessages.tooMany })
    expect(validateRewards([blankReward()])).toEqual({})
    expect(validateRewards([blankReward()], true)).toEqual({ rewards: rewardMessages.none })
    expect(validateRewards([], true)).toEqual({ rewards: rewardMessages.none })
  })

  it('wants a budget that is at least the largest reward', () => {
    const rows = [row(), row({ key: 'trial_started', label: 'Trial started', amount: '25' })]
    expect(validateBudget('', rows, 'USD')).toBeNull()
    expect(validateBudget(' ', rows, 'USD', true)).toBe(rewardMessages.budgetMissing)
    for (const budget of ['0.99', '0', 'lots', '1000000.01'])
      expect(validateBudget(budget, rows, 'USD')).toBe(rewardMessages.budgetRange)
    expect(validateBudget('24.99', rows, 'USD')).toBe(
      'The budget must cover your largest reward, $25.00.',
    )
    expect(validateBudget('24.99', rows, 'EUR')).toBe(budgetBelowReward(2500, 'EUR'))
    expect(validateBudget('25', rows, 'USD')).toBeNull()
    expect(validateBudget('1,000,000.00', rows, 'USD')).toBeNull()
    // A reward that does not read as money is said at the reward, not at the budget.
    expect(validateBudget('1', [row({ amount: 'two' })], 'USD')).toBeNull()
  })

  it('checks only what the program pays for', () => {
    const bad: Partial<ProgramDraft> = {
      percent: '130',
      months: '40',
      rewards: [row({ amount: '0' })],
      budget: '0',
    }
    const draft = (earnFrom: EarnFrom) => ({
      ...draftFromProgram(program({ earn_from: earnFrom }), true),
      ...bad,
    })
    expect(Object.keys(validateDraft(draft('sales'))).sort()).toEqual(['amount', 'months'])
    expect(Object.keys(validateDraft(draft('events'))).sort()).toEqual([
      'budget',
      rewardField(0, 'amount'),
    ])
    expect(Object.keys(validateDraft(draft('both'))).sort()).toEqual([
      'amount',
      'budget',
      'months',
      rewardField(0, 'amount'),
    ])
  })

  it('lets a draft be unfinished, but not a program creators can see', () => {
    const empty = {
      ...draftFromProgram(eventsProgram(), true),
      rewards: [blankReward()],
      budget: '',
    }
    expect(validateDraft(empty)).toEqual({})
    expect(validateDraft(empty, true)).toEqual({
      rewards: rewardMessages.none,
      budget: rewardMessages.budgetMissing,
    })
    // An events program has no commission to fill in; one that pays for both has.
    expect(
      validateDraft({ ...draftFromProgram(eventsProgram(), true), percent: '' }, true),
    ).toEqual({})
    expect(
      validateDraft({ ...draftFromProgram(eventsProgram({ earn_from: 'both' }), true) }, true),
    ).toEqual({ amount: fieldMessages.amount })
  })

  it('ticks the checklist from the form for what the program pays for', () => {
    const events = draftFromProgram(eventsProgram(), true)
    expect(draftProgress(events).commission).toBe(true)
    expect(draftProgress({ ...events, budget: '' }).commission).toBe(false)
    expect(draftProgress({ ...events, rewards: [blankReward()] }).commission).toBe(false)
    expect(draftProgress({ ...events, rewards: [row({ amount: '0' })] }).commission).toBe(false)
    expect(draftProgress({ ...events, budget: '1.00' }).commission).toBe(false)
    const both = { ...events, earnFrom: 'both' as const }
    expect(draftProgress(both).commission).toBe(false)
    expect(draftProgress({ ...both, percent: '30' }).commission).toBe(true)
    expect(draftProgress({ ...events, earnFrom: 'sales' }).commission).toBe(false)
    expect(agreementReady(events)).toBe(true)
    expect(agreementReady({ ...events, budget: '' })).toBe(false)
  })
})

describe('what is sent for a program that pays for events', () => {
  const filled: ProgramDraft = {
    ...draftFromProgram(null, true),
    name: 'Fluent',
    landingUrl: 'https://fluent-app.io/start',
    earnFrom: 'events',
    approvalMode: 'manual',
    rewards: [{ key: 'signup_completed', label: 'Account created', amount: '2' }],
    budget: '500',
  }

  it('starts a form that asks with sales chosen, one blank reward and no budget', () => {
    expect(draftFromProgram(null, true)).toEqual({
      ...draftFromProgram(null),
      earnFrom: 'sales',
      rewards: [{ key: '', label: '', amount: '' }],
      budget: '',
    })
  })

  it('sends a new events program with its rewards and budget and no commission', () => {
    expect(changedInput(filled, null)).toEqual({
      name: 'Fluent',
      landing_url: 'https://fluent-app.io/start',
      currency: 'USD',
      attribution_window_days: 30,
      hold_days: 30,
      minimum_payout_minor: 2000,
      approval_mode: 'manual',
      marketplace_listed: true,
      earn_from: 'events',
      rewards: [{ key: 'signup_completed', label: 'Account created', amount_minor: 200 }],
      reward_budget_minor: 50000,
    })
  })

  it('sends nothing new for a sales program in a form that asks', () => {
    const input = changedInput({ ...filled, earnFrom: 'sales', percent: '30' }, null)
    for (const key of ['earn_from', 'rewards', 'reward_budget_minor'])
      expect(input).not.toHaveProperty(key)
    expect(input).toMatchObject({ commission_type: 'percent', commission_rate_bps: 3000 })
  })

  it('sends only what changed for a saved program', () => {
    const saved = program()
    const draft = draftFromProgram(saved, true)
    expect(
      changedInput({ ...draft, earnFrom: 'events', rewards: filled.rewards, budget: '500' }, saved),
    ).toEqual({
      earn_from: 'events',
      rewards: [{ key: 'signup_completed', label: 'Account created', amount_minor: 200 }],
      reward_budget_minor: 50000,
      revision: 3,
    })
    const events = eventsProgram()
    const eventsDraft = draftFromProgram(events, true)
    expect(changedInput({ ...eventsDraft, budget: '750' }, events)).toEqual({
      reward_budget_minor: 75000,
      revision: 3,
    })
    expect(changedInput({ ...eventsDraft, earnFrom: 'both', percent: '25' }, events)).toEqual({
      earn_from: 'both',
      commission_type: 'percent',
      commission_rate_bps: 2500,
      commission_fixed_minor: null,
      commission_duration: 'months',
      commission_months: 12,
      revision: 3,
    })
    // Going back to sales keeps the rewards as they were saved: they are just not used.
    expect(
      changedInput(
        { ...eventsDraft, earnFrom: 'sales', percent: '30', rewards: [blankReward()] },
        events,
      ),
    ).toEqual({
      earn_from: 'sales',
      commission_type: 'percent',
      commission_rate_bps: 3000,
      commission_fixed_minor: null,
      commission_duration: 'months',
      commission_months: 12,
      revision: 3,
    })
  })

  it('knows the rewards are something creators agree to, and the budget is not', () => {
    const saved = eventsProgram()
    const draft = draftFromProgram(saved, true)
    expect(changesAgreement(draft, saved)).toBe(false)
    expect(changesAgreement({ ...draft, budget: '750' }, saved)).toBe(false)
    expect(changesAgreement({ ...draft, earnFrom: 'both' }, saved)).toBe(true)
    const [first, second] = draft.rewards as RewardRow[]
    for (const rewards of [
      [first],
      [second, first],
      [{ ...first, amount: '3' }, second],
      [{ ...first, label: 'Signed up' }, second],
    ])
      expect(changesAgreement({ ...draft, rewards }, saved)).toBe(true)
  })
})

describe('the words for a program that pays for events', () => {
  const terms = draftEarning(draftFromProgram(eventsProgram(), true))

  it('says what a creator earns on the card', () => {
    expect(rewardLine(REWARDS[0], 'USD')).toBe('$2.00 per Account created')
    expect(rewardLine(REWARDS[0], 'EUR')).toBe('2.00 EUR per Account created')
    expect(earnHeadline({ ...terms, rewards: [REWARDS[0]] })).toBe('$2.00 per Account created')
    expect(earnHeadline(terms)).toBe('$2.00 per Account created, $10.00 per Trial started')
    expect(earnHeadline({ ...terms, rewards: [] })).toBeNull()
    const both = draftEarning({
      ...draftFromProgram(eventsProgram(), true),
      earnFrom: 'both',
      percent: '30',
      duration: 'lifetime',
    })
    expect(earnHeadline(both)).toBe('30% of every payment, plus rewards')
    expect(earnHeadline({ ...both, rewards: [] })).toBe('30% of every payment')
    expect(earnHeadline({ ...both, commission_type: null })).toBeNull()
    expect(earnHeadline(draftEarning(draftFromProgram(program(), true)))).toBe(
      '30% of every payment for 12 months',
    )
  })

  it('leaves a commission out of an events program, whatever was typed before', () => {
    expect(
      draftEarning({ ...draftFromProgram(eventsProgram(), true), percent: '30' }),
    ).toMatchObject({
      earn_from: 'events',
      commission_type: null,
      commission_rate_bps: null,
      commission_duration: null,
    })
    expect(draftEarning(draftFromProgram(program(), true)).rewards).toEqual([])
  })

  it('guesses what creators read from the event name, until they write their own', () => {
    expect(labelFromEvent('signup_completed')).toBe('Signup completed')
    expect(labelFromEvent('trialStarted')).toBe('Trial started')
    expect(labelFromEvent('checkout:step-2.done')).toBe('Checkout step 2 done')
    expect(labelFromEvent('x'.repeat(80))).toHaveLength(40)
    expect(labelFromEvent('')).toBe('')
    const picked = withRewardKey(blankReward(), 'signup_completed')
    expect(picked).toEqual({ key: 'signup_completed', label: 'Signup completed', amount: '' })
    expect(withRewardKey(picked, 'trial_started').label).toBe('Trial started')
    expect(withRewardKey({ ...picked, label: 'Account created' }, 'trial_started').label).toBe(
      'Account created',
    )
  })

  it.each([
    ['invalid_earn_from', 'earnFrom', fieldMessages.earnFrom],
    ['invalid_rewards', 'rewards', fieldMessages.rewards],
    ['invalid_reward_budget_minor', 'budget', fieldMessages.budget],
    ['events_unavailable', 'earnFrom', rewardMessages.eventsUnavailable],
  ])('puts %s at the %s field', (code, target, message) => {
    expect(describeProblem(new ProgramError(code), 'save')).toEqual({
      code,
      field: target,
      message,
      recovery: 'none',
    })
  })

  it('says what is missing before publishing, for what the program pays for', () => {
    const incomplete = (earnFrom?: EarnFrom) =>
      describeProblem(new ProgramError('program_incomplete'), 'publish', earnFrom).message
    expect(incomplete()).toBe(
      'Fill in the product, landing page and commission before you publish.',
    )
    expect(incomplete('sales')).toBe(incomplete())
    expect(incomplete('events')).toBe(
      'Fill in the product, landing page, rewards and budget before you publish.',
    )
    expect(incomplete('both')).toBe(
      'Fill in the product, landing page, commission, rewards and budget before you publish.',
    )
  })

  it('never uses database words, test-mode words or em-dashes', () => {
    const words = [
      ...Object.values(rewardMessages),
      ...Object.values(earnFromAbout),
      ...Object.values(earningStep).flatMap((step) => Object.values(step)),
      fieldMessages.earnFrom,
      fieldMessages.rewards,
      fieldMessages.budget,
      budgetBelowReward(2500, 'USD'),
    ]
    for (const message of words) {
      expect(message).not.toMatch(/bps|minor|revision|funnel|terms version|slug|earn_from|key\b/i)
      expect(message).not.toMatch(/test mode|test account|sandbox|livemode/i)
      expect(message).not.toMatch(/[—–]/)
    }
  })
})

describe('program page, paying for events', () => {
  it('is exactly the sales form for an answer from before Phase 6', async () => {
    const old = readState(before.state_draft)
    await openProgram(before.state_draft)
    expect(
      screen.queryByRole('group', { name: 'What do creators earn from?' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Earnings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Rewards' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Monthly budget')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Commission' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sale tracking' })).toBeInTheDocument()
    expect(field('Commission percent')).toHaveValue('30')
    expect(old.program?.name).toBe('Lingo')
    // The events of the site are not even asked for.
    expect(sent('reward_events')).toEqual([])
  })

  it('asks what creators earn from where events can be paid for, with sales chosen', async () => {
    const user = await openProgram()
    expect(screen.getByRole('heading', { name: 'Earnings' })).toBeInTheDocument()
    expect(choose('Sales')).toHaveAttribute('aria-pressed', 'true')
    expect(within(form()).getByText(earnFromAbout.sales)).toBeInTheDocument()
    expect(field('Commission percent')).toHaveValue('30')
    expect(screen.queryByRole('heading', { name: 'Rewards' })).not.toBeInTheDocument()
    expect(button('Save')).toBeDisabled()
    expect(sent('reward_events')).toEqual([])

    await user.click(choose('Events'))
    expect(choose('Events')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('Commission percent')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Commission lasts' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Rewards' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Event tracking' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sale tracking' })).not.toBeInTheDocument()
    await rewardsShown()
    expect(sent('reward_events')).toEqual([{ p_workspace_id: 'ws-1' }])
    expect(steps()).toContain('To do: Set rewards and a budget')
    expect(within(side()).getByText('Your rewards')).toBeInTheDocument()

    await user.click(choose('Both'))
    expect(field('Commission percent')).toHaveValue('30')
    expect(screen.getByRole('heading', { name: 'Rewards' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sale tracking' })).toBeInTheDocument()
    expect(steps()).toContain('To do: Set a commission, rewards and a budget')
  })

  it('sets creator approval to manual for events, unless the business already chose', async () => {
    const user = await openProgram()
    expect(options()).toContain('Creators approved automatically')
    await user.click(choose('Events'))
    expect(options()).toContain('You approve each creator')
    // Back to sales, the approval is what was saved.
    await user.click(choose('Sales'))
    expect(options()).toContain('Creators approved automatically')
    expect(button('Save')).toBeDisabled()

    await user.click(button('Change'))
    await user.click(button('I approve each creator'))
    await user.click(button('Automatic'))
    await user.click(button('Hide options'))
    await user.click(choose('Both'))
    expect(options()).toContain('Creators approved automatically')
  })

  it('leaves the approval of a saved events program as it is', async () => {
    const user = await openProgram(programState(eventsProgram({ approval_mode: 'automatic' })))
    await user.click(choose('Both'))
    expect(options()).toContain('Creators approved automatically')
  })

  it('fills in a reward and saves it in what the database stores', async () => {
    const saved = eventsProgram({
      revision: 4,
      commission_type: 'percent',
      commission_rate_bps: 3000,
      commission_duration: 'months',
      commission_months: 12,
      rewards: [REWARDS[0]],
    })
    const user = await openProgram(programState(), { workspace_program_save: programState(saved) })
    await user.click(choose('Events'))
    await rewardsShown()
    expect(
      within(part(1, 'Event'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose an event', 'trial_started', 'signup_completed', 'lesson_finished'])
    await user.selectOptions(part(1, 'Event'), 'signup_completed')
    // The words are a first guess from the event name, and can be rewritten.
    expect(part(1, 'What creators read')).toHaveValue('Signup completed')
    await user.clear(part(1, 'What creators read'))
    await user.type(part(1, 'What creators read'), 'Account created')
    await user.type(part(1, 'Amount'), '2')
    expect(within(side()).getByText('$2.00 per Account created')).toBeInTheDocument()
    expect(steps()).toContain('To do: Set rewards and a budget')
    await user.type(field('Monthly budget'), '500')
    expect(steps()).toContain('Done: Rewards set')

    await user.click(button('Save'))
    await screen.findByText('Draft saved')
    expect(sent('save')).toEqual([
      {
        p_workspace_id: 'ws-1',
        p_input: {
          earn_from: 'events',
          rewards: [{ key: 'signup_completed', label: 'Account created', amount_minor: 200 }],
          reward_budget_minor: 50000,
          approval_mode: 'manual',
          revision: 3,
        },
      },
    ])
    // What comes back is shown in normal units again, and there is nothing left to save.
    expect(part(1, 'Amount')).toHaveValue('2.00')
    expect(field('Monthly budget')).toHaveValue('500.00')
    expect(button('Save')).toBeDisabled()
    expect(page().textContent).not.toMatch(/50000|\b200\b/)
  })

  it('shows a saved events program in normal units, with its card and checklist', async () => {
    await openProgram(programState(eventsProgram()))
    await rewardsShown()
    expect(part(1, 'Event')).toHaveValue('signup_completed')
    expect(part(1, 'What creators read')).toHaveValue('Account created')
    expect(part(1, 'Amount')).toHaveValue('2.00')
    expect(part(2, 'Event')).toHaveValue('trial_started')
    expect(part(2, 'Amount')).toHaveValue('10.00')
    expect(field('Monthly budget')).toHaveValue('500.00')
    expect(field('Monthly budget')).toHaveAccessibleDescription(
      'The KissMyApps fee comes on top. One creator can earn at most a tenth of it per day.',
    )
    // For events the card's line names every reward, as the agreement does.
    expect(
      within(side()).getByText('$2.00 per Account created, $10.00 per Trial started'),
    ).toBeInTheDocument()
    expect(within(side()).queryByRole('list', { name: 'Rewards' })).not.toBeInTheDocument()
    expect(steps()).toContain('Done: Rewards set')
    expect(screen.queryByLabelText('Commission percent')).not.toBeInTheDocument()
    expect(page().textContent).not.toMatch(/50000|\b1000\b|\b200\b/)
    expect(page().textContent).not.toMatch(/test mode|test account|sandbox|livemode|[—–]/i)
  })

  it('shows a program that pays for both', async () => {
    await openProgram(
      programState(
        eventsProgram({
          earn_from: 'both',
          commission_type: 'percent',
          commission_rate_bps: 3000,
          commission_duration: 'lifetime',
        }),
      ),
    )
    await rewardsShown()
    expect(choose('Both')).toHaveAttribute('aria-pressed', 'true')
    expect(field('Commission percent')).toHaveValue('30')
    expect(part(2, 'Amount')).toHaveValue('10.00')
    expect(within(side()).getByText('30% of every payment, plus rewards')).toBeInTheDocument()
    // The line only says "plus rewards", so the card lists them.
    expect(
      within(within(side()).getByRole('list', { name: 'Rewards' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Account created$2.00', 'Trial started$10.00'])
    expect(steps()).toContain('Done: Commission and rewards set')
    expect(within(form()).getByText(earnFromAbout.both)).toBeInTheDocument()
  })

  it('offers each event to one reward only, and keeps an event that is no longer listed', async () => {
    await openProgram(
      programState(
        eventsProgram({
          rewards: [REWARDS[0], { key: 'old_event', label: 'Old thing', amount_minor: 100 }],
        }),
      ),
    )
    await rewardsShown()
    const option = (number: number, name: string) =>
      within(part(number, 'Event')).getByRole('option', { name }) as HTMLOptionElement
    expect(part(1, 'Event')).toHaveValue('signup_completed')
    expect(option(1, 'trial_started').disabled).toBe(false)
    expect(part(2, 'Event')).toHaveValue('old_event')
    expect(option(2, 'old_event').disabled).toBe(false)
    expect(option(2, 'signup_completed').disabled).toBe(true)
    expect(option(2, 'trial_started').disabled).toBe(false)
  })

  it('adds rewards up to five and removes them', async () => {
    const user = await openProgram(programState(eventsProgram()))
    await rewardsShown()
    await user.click(button('Add reward'))
    expect(part(3, 'Event')).toHaveFocus()
    await user.click(button('Add reward'))
    await user.click(button('Add reward'))
    expect(screen.getAllByRole('group', { name: /^Reward \d$/ })).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'Add reward' })).not.toBeInTheDocument()
    expect(within(form()).getByText('A program can have up to five rewards.')).toBeInTheDocument()

    await user.click(button('Remove reward 1'))
    expect(screen.getAllByRole('group', { name: /^Reward \d$/ })).toHaveLength(4)
    expect(part(1, 'Event')).toHaveValue('trial_started')
    expect(button('Add reward')).toHaveFocus()
    // Removing the last one leaves a blank row to fill in, not an empty list.
    for (const number of [4, 3, 2, 1]) await user.click(button(`Remove reward ${number}`))
    expect(screen.getAllByRole('group', { name: /^Reward \d$/ })).toHaveLength(1)
    expect(part(1, 'Event')).toHaveValue('')
    expect(part(1, 'Amount')).toHaveValue('')
    expect(button('Remove reward 1')).toBeDisabled()
  })

  it('marks what is wrong with the rewards before asking the database', async () => {
    const user = await openProgram(programState(eventsProgram()), {
      workspace_program_reward_events: none,
    })
    await rewardsShown()
    await user.click(button('Add reward'))
    await user.type(part(3, 'Event'), 'signup_completed')
    await user.clear(part(3, 'What creators read'))
    await user.type(part(3, 'What creators read'), 'trial started')
    await user.type(part(3, 'Amount'), '0')
    await user.clear(part(2, 'Amount'))
    await user.type(part(2, 'Amount'), '25')
    await user.clear(field('Monthly budget'))
    await user.type(field('Monthly budget'), '20')
    await user.click(button('Save'))

    expect(part(3, 'Event')).toHaveAccessibleDescription(rewardMessages.keyRepeated)
    expect(part(3, 'Event')).toHaveFocus()
    expect(part(3, 'What creators read')).toHaveAccessibleDescription(rewardMessages.labelRepeated)
    expect(part(3, 'Amount')).toHaveAccessibleDescription(rewardMessages.amount)
    expect(field('Monthly budget')).toHaveAttribute('aria-invalid', 'true')
    expect(
      within(form()).getByText('The budget must cover your largest reward, $25.00.'),
    ).toBeInTheDocument()
    expect(part(1, 'Amount')).not.toHaveAttribute('aria-invalid')
    expect(within(form()).getByText('Fix the marked fields, then save.')).toBeInTheDocument()
    expect(sent('save')).toEqual([])

    // Fixing a field clears its message, and the others stay.
    await user.clear(part(3, 'Amount'))
    await user.type(part(3, 'Amount'), '1')
    expect(part(3, 'Amount')).not.toHaveAttribute('aria-invalid')
    expect(part(3, 'What creators read')).toHaveAttribute('aria-invalid', 'true')
  })

  it('does not let a published events program lose its rewards or its budget', async () => {
    const user = await openProgram(programState(eventsProgram(live)))
    await rewardsShown()
    await user.click(button('Remove reward 2'))
    await user.click(button('Remove reward 1'))
    await user.clear(field('Monthly budget'))
    await user.click(button('Save'))
    expect(within(form()).getByText(rewardMessages.none)).toBeInTheDocument()
    expect(part(1, 'Event')).toHaveAttribute('aria-invalid', 'true')
    expect(part(1, 'Event')).toHaveAccessibleDescription(rewardMessages.none)
    expect(field('Monthly budget')).toHaveAccessibleDescription(
      expect.stringContaining(rewardMessages.budgetMissing),
    )
    expect(sent('save')).toEqual([])
  })

  it.each([
    ['invalid_rewards', fieldMessages.rewards],
    ['invalid_reward_budget_minor', fieldMessages.budget],
    ['invalid_earn_from', fieldMessages.earnFrom],
    ['events_unavailable', rewardMessages.eventsUnavailable],
  ])('says in plain words why the database refused with %s', async (code, message) => {
    const user = await openProgram(programState(eventsProgram()), {
      workspace_program_save: refuse(code),
    })
    await rewardsShown()
    await user.clear(field('Monthly budget'))
    await user.type(field('Monthly budget'), '600')
    await user.click(button('Save'))
    expect(await within(form()).findByText(message)).toBeInTheDocument()
    expect(within(form()).getByText('Fix the marked fields, then save.')).toBeInTheDocument()
    // What was typed is kept, and nothing reads as saved.
    expect(field('Monthly budget')).toHaveValue('600')
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
    expect(page().textContent).not.toContain(code)
    if (code === 'invalid_reward_budget_minor')
      expect(field('Monthly budget')).toHaveAttribute('aria-invalid', 'true')
    if (code === 'invalid_rewards') expect(part(1, 'Event')).toHaveAttribute('aria-invalid', 'true')
    if (code === 'events_unavailable') expect(choose('Events')).toHaveFocus()
  })

  it('lets the name be typed while no event has arrived, and says how events get there', async () => {
    const user = await openProgram(programState(), { workspace_program_reward_events: none })
    await user.click(choose('Events'))
    await rewardsShown()
    expect(
      within(form()).getByText(/No events have arrived from your site yet\./),
    ).toHaveTextContent(
      'No events have arrived from your site yet. They come from the KissMyApps tracking code, so for now type the name your site will send.',
    )
    expect(screen.getByRole('link', { name: 'Set up tracking' })).toHaveAttribute(
      'href',
      href({ name: 'settings', projectId: 'proj-1', section: 'install' }),
    )
    expect(part(1, 'Event').tagName).toBe('INPUT')
    await user.type(part(1, 'Event'), 'trial_started')
    expect(part(1, 'What creators read')).toHaveValue('Trial started')
    await user.type(part(1, 'Event'), ' now')
    await user.type(part(1, 'Amount'), '5')
    await user.click(button('Save'))
    expect(part(1, 'Event')).toHaveAccessibleDescription(rewardMessages.keyInvalid)
    expect(sent('save')).toEqual([])
  })

  it('lets the name be typed when the events could not be loaded, and loads them on retry', async () => {
    let down = true
    const user = await openProgram(programState(eventsProgram()), {
      workspace_program_reward_events: () =>
        down ? new Error('TypeError: Failed to fetch') : listed,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The events from your site could not be loaded. Type the event name, or retry.',
    )
    expect(part(1, 'Event').tagName).toBe('INPUT')
    expect(part(1, 'Event')).toHaveValue('signup_completed')
    down = false
    await user.click(button('Retry'))
    await waitFor(() => expect(part(1, 'Event').tagName).toBe('SELECT'))
    expect(part(1, 'Event')).toHaveValue('signup_completed')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is read-only for someone who cannot manage the program', async () => {
    fake.state.context = context('analyst')
    await openProgram(programState(eventsProgram(live), { can_manage: false }))
    await rewardsShown()
    expect(part(1, 'Event')).toBeDisabled()
    expect(part(1, 'Amount')).toBeDisabled()
    expect(field('Monthly budget')).toBeDisabled()
    expect(choose('Sales')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Add reward' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('needs the agreement read again after a reward changes, but not after the budget does', async () => {
    const user = await openProgram(
      programState(eventsProgram({ ...live, has_unpublished_changes: false })),
    )
    await rewardsShown()
    expect(within(side()).getByRole('heading', { name: 'Published' })).toBeInTheDocument()
    await user.clear(field('Monthly budget'))
    await user.type(field('Monthly budget'), '750')
    expect(within(side()).getByRole('heading', { name: 'Published' })).toBeInTheDocument()
    await user.clear(part(1, 'Amount'))
    await user.type(part(1, 'Amount'), '3')
    expect(within(side()).getByRole('heading', { name: 'Changes to publish' })).toBeInTheDocument()
  })
})
