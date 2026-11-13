import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { MerchantApp } from './MerchantApp'
import { creatorBackendFixture } from './creator-backend.fixture'
import { rewardsBackendFixture } from './rewards-backend.fixture'
import {
  canApproveAgain,
  channelLabel,
  channelList,
  checkNote,
  describeProblem,
  fallbackMessages,
  groupCreators,
  inviteLink,
  inviteSummary,
  moneyCurrency,
  NOTE_MAX,
  problemMessages,
  readCreators,
  readDecision,
  totalsNote,
  websiteLink,
  withDecision,
} from './creators'
import type {
  Creator,
  CreatorsProgram,
  CreatorsState,
  CreatorStep,
  CreatorTotals,
} from './creators'
import { ProgramError, readFailure } from './programs'
import { href, parseRoute } from './routes'
import { salesFixture } from './sales.fixture'

type Args = Record<string, unknown>
type Answer = unknown | ((args: Args) => unknown)

// A stand-in for the Supabase client: auth with listeners, the context rpcs, and the two
// workspace_program_creator* functions answered from a table.
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
  user: { id: 'user-1', email: 'victory@example.com', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const DAY = 24 * 60

const program = (over: Partial<CreatorsProgram> = {}): CreatorsProgram => ({
  id: 'prog-1',
  slug: 'speaksix',
  name: 'SpeakSix',
  status: 'live',
  approval_mode: 'manual',
  marketplace_listed: true,
  ...over,
})

/** One creator, as the database returns it. */
const creator = (over: Partial<Creator> = {}): Creator => ({
  member_id: 'm-ada',
  status: 'active',
  name: 'Ada Okafor',
  handle: 'ada-okafor',
  country_code: 'NG',
  channels: ['tiktok', 'instagram'],
  website_url: null,
  requested_at: '2026-11-01T10:00:00Z',
  activated_at: '2026-11-01T10:00:00Z',
  ended_at: null,
  decision_note: null,
  terms_version: 1,
  needs_new_terms: false,
  clicks: 0,
  sales: 0,
  last_click_at: null,
  // A database from before Phase 5 sends no money: these tests are that page.
  sales_amount_minor: null,
  commission_minor: null,
  pending_minor: null,
  ...over,
})

const ada = creator({
  member_id: 'm-ada',
  status: 'pending',
  website_url: 'https://www.adaokafor.com/',
  requested_at: ago(2 * DAY),
  activated_at: null,
})
const tomas = creator({
  member_id: 'm-tomas',
  status: 'pending',
  name: 'Tomás Rivera',
  handle: 'tomas-rivera',
  country_code: 'MX',
  channels: ['youtube'],
  requested_at: ago(5 * 60),
  activated_at: null,
})
const lena = creator({
  member_id: 'm-lena',
  name: 'Lena Hoffmann',
  handle: 'lena-hoffmann',
  country_code: 'DE',
  activated_at: '2026-11-04T09:00:00Z',
  clicks: 1248,
  sales: 31,
  last_click_at: ago(3 * 60),
})
const kwame = creator({
  member_id: 'm-kwame',
  name: 'Kwame Mensah',
  handle: 'kwame-mensah',
  country_code: 'GH',
  activated_at: '2026-11-01T09:00:00Z',
  needs_new_terms: true,
  clicks: 412,
  sales: 7,
  last_click_at: ago(2 * DAY),
})
const priya = creator({
  member_id: 'm-priya',
  name: 'Priya Nair',
  handle: 'priya-nair',
  country_code: 'IN',
  activated_at: '2026-11-12T09:00:00Z',
})
const jonas = creator({
  member_id: 'm-jonas',
  status: 'removed',
  name: 'Jonas Berg',
  handle: 'jonas-berg',
  ended_at: '2026-11-09T12:00:00Z',
  decision_note: 'Ads were bidding on the SpeakSix name.',
})
const sofia = creator({
  member_id: 'm-sofia',
  status: 'declined',
  name: 'Sofia Almeida',
  handle: 'sofia-almeida',
  activated_at: null,
  ended_at: '2026-11-07T12:00:00Z',
})
const noor = creator({
  member_id: 'm-noor',
  status: 'left',
  name: 'Noor Haddad',
  handle: 'noor-haddad',
  ended_at: '2026-10-29T12:00:00Z',
})
const everyone = [ada, tomas, lena, kwame, priya, jonas, sofia, noor]

/** A workspace_program_creators answer whose counts follow from its rows, as the database's do. */
function creatorsState(
  rows: Creator[] = [],
  over: Partial<Omit<CreatorsState, 'creators'>> = {},
): CreatorsState {
  return {
    can_manage: true,
    program: program(),
    counts: {
      pending: rows.filter((row) => row.status === 'pending').length,
      active: rows.filter((row) => row.status === 'active').length,
      ended: rows.filter((row) => row.status !== 'pending' && row.status !== 'active').length,
    },
    creators: rows,
    currency: null,
    totals: null,
    ...over,
  }
}

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

const sent = (name: 'creators' | 'creator_decide') =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)

async function openCreators(list: Answer = creatorsState(everyone), wait = true) {
  answers({ workspace_program_creators: list })
  window.location.hash = '#creators'
  const user = userEvent.setup()
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Creators', level: 1 })
  if (wait)
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'Loading your creators' }),
      ).not.toBeInTheDocument(),
    )
  return user
}

const page = () => document.querySelector('.mc-crt') as HTMLElement
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const buttons = (name: string | RegExp) => screen.queryAllByRole('button', { name })
const waiting = () => screen.getByRole('region', { name: /^Waiting for you/ })
const promoting = () => screen.getByRole('region', { name: /^Creators/ })
const ended = () => screen.getByRole('region', { name: 'Ended creators' })
const rowOf = (name: string) =>
  screen.getByText(name, { selector: 'strong' }).closest('[data-member]') as HTMLElement
const decision = (member: Creator, over: Partial<Creator>) => ({ creator: { ...member, ...over } })

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.table = {}
  fake.state.context = context('owner')
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('creators route', () => {
  it('lives at #creators', () => {
    expect(parseRoute('#creators')).toEqual({ name: 'creators' })
    expect(parseRoute('#/creators')).toEqual({ name: 'creators' })
    expect(href({ name: 'creators' })).toBe('#creators')
    expect(parseRoute(href({ name: 'creators' }))).toEqual({ name: 'creators' })
  })

  it('is the second entry of the Affiliates group, after Program', async () => {
    signedInAs('owner')
    await openCreators()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Creators' })
    expect(link).toHaveAttribute('href', '#creators')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Creators')
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
    await openCreators(creatorsState())
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    expect(within(nav).getByRole('link', { name: 'Creators' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('heading', { name: 'Invite your first creator' })).toBeInTheDocument()
  })

  it('asks the database as the signed-in user, for this workspace', async () => {
    signedInAs('owner')
    await openCreators()
    expect(sent('creators')[0]).toEqual({ p_workspace_id: 'ws-1' })
  })
})

describe('reading answers', () => {
  it('reads the list the database sends', () => {
    const read = readCreators(creatorsState(everyone))
    expect(read.can_manage).toBe(true)
    expect(read.program).toEqual(program())
    expect(read.counts).toEqual({ pending: 2, active: 3, ended: 3 })
    expect(read.creators.map((item) => item.member_id)).toEqual(
      everyone.map((item) => item.member_id),
    )
    expect(read.creators[0]).toEqual(ada)
  })

  it('keeps nothing it was not told to show, a stray email least of all', () => {
    const read = readCreators(
      creatorsState([{ ...ada, email: 'ada@example.com', legal_name: 'Adaeze Okafor' } as Creator]),
    )
    expect(JSON.stringify(read)).not.toContain('ada@example.com')
    expect(JSON.stringify(read)).not.toContain('Adaeze')
    expect(Object.keys(read.creators[0]).sort()).toEqual(Object.keys(ada).sort())
  })

  it('fills what a thin row leaves out and drops a row it cannot trust', () => {
    const read = readCreators({
      can_manage: false,
      program: null,
      creators: [
        { member_id: 'm-1', status: 'active', name: 'Mei Tanaka' },
        { member_id: 'm-2', status: 'banned', name: 'Nobody' },
        { status: 'active', name: 'No id' },
        { member_id: 'm-3', status: 'pending', name: '   ' },
        'nonsense',
      ],
    })
    expect(read.creators).toEqual([
      {
        member_id: 'm-1',
        status: 'active',
        name: 'Mei Tanaka',
        handle: '',
        country_code: null,
        channels: [],
        website_url: null,
        requested_at: null,
        activated_at: null,
        ended_at: null,
        decision_note: null,
        terms_version: null,
        needs_new_terms: false,
        clicks: 0,
        sales: 0,
        last_click_at: null,
        sales_amount_minor: null,
        commission_minor: null,
        pending_minor: null,
      },
    ])
    // The counts were missing, so they are what is on the page.
    expect(read.counts).toEqual({ pending: 0, active: 1, ended: 0 })
  })

  it('never shows a count below the rows it has, and keeps a larger one', () => {
    const read = readCreators({
      ...creatorsState([lena, kwame]),
      counts: { pending: 0, active: 1, ended: 12 },
    })
    expect(read.counts).toEqual({ pending: 0, active: 2, ended: 12 })
  })

  it('reads times the way the database writes them', () => {
    // Postgres sends microseconds and a numeric offset, not a trailing Z.
    const stamped = {
      ...lena,
      requested_at: '2026-11-03T08:15:02.120045+00:00',
      activated_at: '2026-11-04T13:52:14.059098+00:00',
      last_click_at: '2026-11-13T13:52:14.059098+00:00',
    }
    const [read] = readCreators(creatorsState([stamped])).creators
    expect(read).toEqual(stamped)
    expect(new Date(read.activated_at as string).toISOString()).toBe('2026-11-04T13:52:14.059Z')
    // Something that is not a time is no time at all.
    expect(
      readCreators(creatorsState([{ ...lena, activated_at: 'yesterday' }])).creators[0]
        .activated_at,
    ).toBeNull()
  })

  it('treats an archived program as no program', () => {
    expect(
      readCreators(creatorsState([], { program: { ...program(), status: 'archived' as never } }))
        .program,
    ).toBeNull()
  })

  it('refuses an answer it cannot trust', () => {
    for (const wrong of [
      null,
      'ok',
      [],
      {},
      { can_manage: true },
      { can_manage: 'yes', creators: [] },
      { can_manage: true, creators: [], program: { id: 'p', status: 'sideways' } },
      { can_manage: true, creators: [], program: { status: 'live' } },
    ])
      expect(() => readCreators(wrong)).toThrow(ProgramError)
    for (const wrong of [null, {}, { creator: null }, { creator: { member_id: 'm-1' } }])
      expect(() => readDecision(wrong)).toThrow(ProgramError)
    expect(readDecision({ creator: lena })).toEqual(lena)
  })
})

describe('the words on the page', () => {
  it('writes the invite address', () => {
    expect(inviteLink('speaksix')).toBe('https://kissmyapps.dev/marketplace/speaksix')
    expect(inviteLink('speak-six-2')).toBe('https://kissmyapps.dev/marketplace/speak-six-2')
  })

  it('says who can find the program and who lets creators in', () => {
    expect(inviteSummary({ marketplace_listed: true, approval_mode: 'automatic' })).toEqual([
      'Listed in the marketplace',
      'Creators are approved automatically',
    ])
    expect(inviteSummary({ marketplace_listed: false, approval_mode: 'manual' })).toEqual([
      'Not listed in the marketplace',
      'You approve each creator',
    ])
  })

  it('names channels the way they are written', () => {
    expect(channelLabel('tiktok')).toBe('TikTok')
    expect(channelLabel('YouTube')).toBe('YouTube')
    expect(channelLabel('Website / blog')).toBe('Website / blog')
    expect(channelLabel('live_events')).toBe('Live events')
    expect(channelList([])).toBeNull()
    expect(channelList(['tiktok', 'instagram'])).toBe('TikTok, Instagram')
    expect(channelList(['x', 'twitter', 'youtube'])).toBe('X, YouTube')
    expect(channelList(['tiktok', 'instagram', 'youtube', 'podcast', 'blog'])).toBe(
      'TikTok, Instagram, YouTube +2',
    )
  })

  it('only links to a web address', () => {
    expect(websiteLink('https://www.adaokafor.com/')).toEqual({
      href: 'https://www.adaokafor.com/',
      label: 'adaokafor.com',
    })
    expect(websiteLink('https://example.com/creators/ada')?.label).toBe('example.com/creators/ada')
    for (const wrong of [
      null,
      '',
      'adaokafor.com',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://someone:hidden@example.com',
    ])
      expect(websiteLink(wrong)).toBeNull()
  })

  it('lets a merchant take back their own decision, not the creator’s', () => {
    expect(canApproveAgain({ status: 'declined' })).toBe(true)
    expect(canApproveAgain({ status: 'removed' })).toBe(true)
    expect(canApproveAgain({ status: 'left' })).toBe(false)
    expect(canApproveAgain({ status: 'active' })).toBe(false)
    expect(canApproveAgain({ status: 'pending' })).toBe(false)
  })

  it('accepts no note, a short note, and nothing longer than the database takes', () => {
    expect(checkNote('')).toBeNull()
    expect(checkNote('   ')).toBeNull()
    expect(checkNote('x'.repeat(NOTE_MAX))).toBeNull()
    expect(checkNote(`  ${'x'.repeat(NOTE_MAX)}  `)).toBeNull()
    expect(checkNote('x'.repeat(NOTE_MAX + 1))).toBe('Keep the note under 500 characters.')
  })

  it('moves a creator and the counts with a decision', () => {
    const before = readCreators(creatorsState(everyone))
    const after = withDecision(before, { ...ada, status: 'active' })
    expect(after.counts).toEqual({ pending: 1, active: 4, ended: 3 })
    const groups = groupCreators(after.creators)
    expect(groups.pending.map((item) => item.name)).toEqual(['Tomás Rivera'])
    expect(groups.active.map((item) => item.name)).toEqual([
      'Ada Okafor',
      'Lena Hoffmann',
      'Kwame Mensah',
      'Priya Nair',
    ])
    const removed = withDecision(after, { ...lena, status: 'removed' })
    expect(removed.counts).toEqual({ pending: 1, active: 3, ended: 4 })
    expect(groupCreators(removed.creators).ended[0].name).toBe('Lena Hoffmann')
    // Nothing is counted twice when the same answer arrives again.
    expect(withDecision(removed, { ...lena, status: 'removed' }).counts).toEqual(removed.counts)
  })
})

describe('what each failure says', () => {
  const steps: CreatorStep[] = ['load', 'approve', 'decline', 'remove']
  const failed = (details: string | null, code = '22023') =>
    readFailure({ code, details, message: 'From the database.' })

  it('has words for every code the two functions raise', () => {
    const expected: Record<string, [string, string]> = {
      program_not_found: ['could not be found', 'reload'],
      program_not_open: ['while your program is live', 'reload'],
      tracking_not_enabled: ['links are not available yet', 'none'],
      not_a_member: ['no longer in this program', 'reload'],
      status_not_allowed: ['cannot be done for this creator right now', 'reload'],
      invalid_note: ['under 500 characters', 'none'],
    }
    for (const [code, [words, recovery]] of Object.entries(expected)) {
      const problem = describeProblem(
        failed(code, code === 'program_not_found' ? 'P0002' : '22023'),
        'approve',
      )
      expect(problem.code).toBe(code)
      expect(problem.message).toContain(words)
      expect(problem.recovery).toBe(recovery)
    }
    expect(describeProblem(failed('invalid_note'), 'decline').field).toBe('note')
  })

  it('reads what an errcode alone means', () => {
    expect(describeProblem(failed(null, '42501'), 'approve')).toMatchObject({
      code: 'not_allowed',
      recovery: 'none',
    })
    expect(describeProblem(failed(null, 'P0002'), 'load').message).toContain(
      'no longer a member of this workspace',
    )
    expect(describeProblem(failed(null, 'PGRST301'), 'load').recovery).toBe('sign-in')
    expect(
      describeProblem(readFailure({ message: 'TypeError: Failed to fetch' }), 'load'),
    ).toMatchObject({ code: 'unreachable', recovery: 'retry' })
  })

  it('gives an unknown code one plain message for what was being done', () => {
    for (const step of steps) {
      for (const code of ['invalid_member_id', 'invalid_action', 'something_new', null]) {
        const problem = describeProblem(failed(code, 'XX000'), step)
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

describe('creators page: what it shows', () => {
  it('keeps its frame while the list loads', async () => {
    signedInAs('owner')
    const answer = held<CreatorsState>()
    await openCreators(() => answer.promise, false)
    expect(screen.getByRole('status', { name: 'Loading your creators' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    answer.release(creatorsState(everyone))
    expect(await screen.findByRole('heading', { name: /^Waiting for you/ })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading your creators' })).not.toBeInTheDocument()
  })

  it('says when the list cannot be loaded, and loads it on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    const user = await openCreators(() =>
      ++attempt === 1 ? new Error('TypeError: Failed to fetch') : creatorsState(everyone),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(screen.queryByRole('heading', { name: 'Invite link' })).not.toBeInTheDocument()
    await user.click(button('Retry'))
    expect(await screen.findByRole('heading', { name: 'Invite link' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent('creators')).toHaveLength(2)
  })

  it('gives an unknown load failure one plain message', async () => {
    signedInAs('owner')
    await openCreators(refuse('something_new', 'XX000'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your creators could not be loaded. Try again.',
    )
    expect(button('Retry')).toBeInTheDocument()
  })

  it('offers to sign in again when the session has expired', async () => {
    signedInAs('owner')
    const user = await openCreators(refuse(null, 'PGRST301'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired.')
    expect(buttons('Retry')).toHaveLength(0)
    await user.click(button('Sign in again'))
    await waitFor(() => expect(window.location.hash).toBe('#sign-in'))
  })

  it('points to Program when there is no program yet', async () => {
    signedInAs('owner')
    await openCreators(creatorsState([], { program: null }))
    expect(page()).toHaveTextContent('No Brainer Lab has no affiliate program yet.')
    expect(screen.getByRole('link', { name: 'Set up your program' })).toHaveAttribute(
      'href',
      '#program',
    )
    expect(screen.queryByText(/kissmyapps\.dev\/marketplace/)).not.toBeInTheDocument()
  })

  it('says creators can join once a draft program is live', async () => {
    signedInAs('owner')
    for (const status of ['draft', 'changes_requested'] as const) {
      await openCreators(creatorsState([], { program: program({ status, slug: null }) }))
      expect(page()).toHaveTextContent('Creators can join once your program is live.')
      expect(screen.getByRole('link', { name: 'Finish your program' })).toHaveAttribute(
        'href',
        '#program',
      )
      expect(screen.queryByText(/kissmyapps\.dev\/marketplace/)).not.toBeInTheDocument()
      cleanup()
    }
  })

  it('says so while the program is in review', async () => {
    signedInAs('owner')
    await openCreators(creatorsState([], { program: program({ status: 'in_review' }) }))
    expect(page()).toHaveTextContent(
      'Your program is in review. Creators can join once it is live.',
    )
    expect(screen.getByRole('link', { name: 'Open Program' })).toHaveAttribute('href', '#program')
    expect(screen.queryByText(/kissmyapps\.dev\/marketplace/)).not.toBeInTheDocument()
  })

  it('makes the invite link the whole page while a live program has no creators', async () => {
    signedInAs('owner')
    const user = await openCreators(creatorsState([], { program: program() }))
    expect(screen.getByRole('heading', { name: 'Invite your first creator' })).toBeInTheDocument()
    expect(screen.getByText('https://kissmyapps.dev/marketplace/speaksix')).toBeInTheDocument()
    expect(page()).toHaveTextContent('Send this link to creators.')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^Waiting for you/ })).not.toBeInTheDocument()
    expect(buttons(/Ended/)).toHaveLength(0)
    await user.click(button('Copy'))
    expect(await navigator.clipboard.readText()).toBe('https://kissmyapps.dev/marketplace/speaksix')
    expect(await screen.findByText('Copied invite link')).toBeInTheDocument()
  })

  it('says under the link how creators find the program and get in, with a way to change it', async () => {
    signedInAs('owner')
    await openCreators(
      creatorsState([lena], {
        program: program({ approval_mode: 'automatic', marketplace_listed: false }),
      }),
    )
    const invite = screen.getByRole('region', { name: 'Invite link' })
    expect(invite).toHaveTextContent('Not listed in the marketplace')
    expect(invite).toHaveTextContent('Creators are approved automatically')
    expect(within(invite).getByRole('link', { name: 'Change' })).toHaveAttribute('href', '#program')
    expect(invite).not.toHaveTextContent('Send this link to creators')
  })

  it('lists who is waiting, with what a merchant weighs before answering', async () => {
    signedInAs('owner')
    await openCreators()
    expect(screen.getByRole('heading', { name: 'Waiting for you 2' })).toBeInTheDocument()
    const rows = within(waiting()).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ada Okafor')
    expect(rows[0]).toHaveTextContent('@ada-okafor')
    expect(rows[0]).toHaveTextContent('Nigeria')
    expect(rows[0]).toHaveTextContent('TikTok, Instagram')
    expect(rows[0]).toHaveTextContent('Asked 2 days ago')
    const site = within(rows[0]).getByRole('link', { name: /adaokafor\.com/ })
    expect(site).toHaveAttribute('href', 'https://www.adaokafor.com/')
    expect(site).toHaveAttribute('target', '_blank')
    expect(site.getAttribute('rel')).toContain('noreferrer')
    expect(rows[1]).toHaveTextContent('Tomás Rivera')
    expect(rows[1]).toHaveTextContent('Mexico')
    expect(rows[1]).toHaveTextContent('Asked 5 h ago')
    expect(within(rows[1]).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rows[0]).getByRole('button', { name: 'Approve Ada Okafor' })).toBeEnabled()
    expect(within(rows[0]).getByRole('button', { name: 'Decline Ada Okafor' })).toBeEnabled()
  })

  it('lists who is promoting, with clicks, sales and the terms marker', async () => {
    signedInAs('owner')
    await openCreators()
    expect(screen.getByRole('heading', { name: 'Creators 3' })).toBeInTheDocument()
    const table = within(promoting()).getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Creator', 'Joined', 'Clicks', 'Sales', 'Last click', 'Action'])
    const cells = (name: string) =>
      within(rowOf(name))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    expect(cells('Lena Hoffmann')).toEqual([
      'L' + 'Lena Hoffmann@lena-hoffmann',
      '4 Nov 2026',
      '1,248',
      '31',
      '3 h ago',
      'Remove',
    ])
    expect(rowOf('Kwame Mensah')).toHaveTextContent('New terms not yet accepted')
    expect(rowOf('Lena Hoffmann')).not.toHaveTextContent('New terms not yet accepted')
    // No click yet is a dash, and zero is a zero.
    expect(cells('Priya Nair').slice(2)).toEqual(['0', '0', '—None yet', 'Remove'])
    // Only the people who are promoting are in the table.
    expect(within(table).getAllByRole('row')).toHaveLength(4)
  })

  it('goes by status, not by whether someone was ever activated', async () => {
    signedInAs('owner')
    // Both were active once: the first activation date stays on the row for good.
    const back = {
      ...tomas,
      requested_at: '2026-11-13T06:00:00.000000+00:00',
      activated_at: '2026-10-02T13:52:14.059098+00:00',
    }
    const gone = {
      ...sofia,
      activated_at: '2026-10-05T13:52:14.059098+00:00',
      ended_at: '2026-11-07T12:00:00.059098+00:00',
    }
    const joined = { ...lena, activated_at: '2026-11-04T13:52:14.059098+00:00' }
    const user = await openCreators(creatorsState([back, joined, gone]))
    expect(within(waiting()).getByText('Tomás Rivera')).toBeInTheDocument()
    expect(within(waiting()).getByRole('button', { name: 'Approve Tomás Rivera' })).toBeEnabled()
    const table = within(promoting()).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).queryByText('Tomás Rivera')).not.toBeInTheDocument()
    expect(within(table).queryByText('Sofia Almeida')).not.toBeInTheDocument()
    expect(rowOf('Lena Hoffmann')).toHaveTextContent('4 Nov 2026')
    await user.click(button('Ended 1'))
    expect(within(ended()).getByText('Declined 7 Nov 2026')).toBeInTheDocument()
  })

  it('never shows an email address', async () => {
    signedInAs('owner')
    const user = await openCreators(
      creatorsState(everyone.map((row) => ({ ...row, email: `${row.handle}@example.com` }))),
    )
    await user.click(button(/Ended/))
    expect(page().textContent).not.toMatch(/@example\.com/)
    expect(page().innerHTML).not.toMatch(/@example\.com/)
  })

  it('keeps ended creators out of the way until asked for', async () => {
    signedInAs('owner')
    const user = await openCreators()
    const toggle = button('Ended 3')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Jonas Berg')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const rows = within(ended()).getAllByRole('listitem')
    expect(
      rows.map((row) => within(row).getByText(/^(Removed|Declined|Left) /).textContent),
    ).toEqual(['Removed 9 Nov 2026', 'Declined 7 Nov 2026', 'Left 29 Oct 2026'])
    expect(rows[0]).toHaveTextContent('Your note: Ads were bidding on the SpeakSix name.')
    expect(within(rows[0]).getByRole('button', { name: 'Approve Jonas Berg again' })).toBeEnabled()
    expect(
      within(rows[1]).getByRole('button', { name: 'Approve Sofia Almeida again' }),
    ).toBeEnabled()
    // Someone who left chose to: there is nothing to approve.
    expect(within(rows[2]).queryByRole('button')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.queryByText('Jonas Berg')).not.toBeInTheDocument()
  })

  it('leaves out the waiting list when nobody is waiting, and keeps the table’s frame when nobody is promoting', async () => {
    signedInAs('owner')
    await openCreators(creatorsState([ada]))
    expect(screen.getByRole('heading', { name: 'Waiting for you 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Creators 0' })).toBeInTheDocument()
    expect(promoting()).toHaveTextContent(
      'No one is promoting yet. Creators you approve appear here.',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    cleanup()
    await openCreators(creatorsState([lena]))
    expect(screen.queryByRole('heading', { name: /^Waiting for you/ })).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('says what a paused program means and stops approvals until it is live', async () => {
    signedInAs('owner')
    const user = await openCreators(
      creatorsState(everyone, { program: program({ status: 'paused' }) }),
    )
    const banner = screen.getByText(/This program is paused/).closest('p') as HTMLElement
    expect(banner).toHaveTextContent(
      'Creator links still open your page, but nothing is credited and no one can be approved until it is live again.',
    )
    expect(within(banner).getByRole('link', { name: 'Open Program' })).toHaveAttribute(
      'href',
      '#program',
    )
    expect(button('Approve Ada Okafor')).toBeDisabled()
    expect(button('Decline Ada Okafor')).toBeEnabled()
    expect(button('Remove Lena Hoffmann')).toBeEnabled()
    await user.click(button(/Ended/))
    expect(button('Approve Jonas Berg again')).toBeDisabled()
    expect(screen.getByText('https://kissmyapps.dev/marketplace/speaksix')).toBeInTheDocument()
  })

  it('shows a member without manage rights the lists and nothing to press', async () => {
    signedInAs('analyst')
    const user = await openCreators(creatorsState(everyone, { can_manage: false }))
    expect(page()).toHaveTextContent(
      'Only an owner or admin of No Brainer Lab can approve or remove creators.',
    )
    await user.click(button(/Ended/))
    expect(screen.getByText('Ada Okafor')).toBeInTheDocument()
    expect(screen.getByText('Lena Hoffmann')).toBeInTheDocument()
    expect(screen.getByText('Jonas Berg')).toBeInTheDocument()
    expect(buttons(/Approve|Decline|Remove/)).toHaveLength(0)
    expect(
      within(promoting())
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Creator', 'Joined', 'Clicks', 'Sales', 'Last click'])
    // The invite link is still there to copy.
    expect(button('Copy')).toBeInTheDocument()
  })

  it('says when the list is longer than what was sent', async () => {
    signedInAs('owner')
    await openCreators({
      ...creatorsState([lena, kwame]),
      counts: { pending: 0, active: 640, ended: 12 },
    })
    expect(screen.getByRole('heading', { name: 'Creators 640' })).toBeInTheDocument()
    expect(page()).toHaveTextContent('Showing the first 2 of 652.')
  })
})

describe('creators page: staying current', () => {
  it('looks for new requests by itself, and keeps the page when that fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      signedInAs('owner')
      let reads = 0
      await openCreators(() => {
        reads += 1
        if (reads === 1) return creatorsState([lena])
        if (reads === 2) return creatorsState([ada, lena])
        return new Error('TypeError: Failed to fetch')
      })
      expect(screen.queryByRole('heading', { name: /^Waiting for you/ })).not.toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await screen.findByRole('heading', { name: 'Waiting for you 1' })).toBeInTheDocument()
      expect(within(waiting()).getByText('Ada Okafor')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(60_000)
      await waitFor(() => expect(sent('creators')).toHaveLength(3))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(within(waiting()).getByText('Ada Okafor')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('creators page: decisions', () => {
  it('approves a waiting creator and moves them to the list', async () => {
    signedInAs('owner')
    const answer = held<unknown>()
    answers({ workspace_program_creator_decide: () => answer.promise })
    const user = await openCreators()
    await user.click(button('Approve Ada Okafor'))

    // While it is on its way: the button says so and nothing else can be pressed.
    expect(await screen.findByText('Approving')).toBeInTheDocument()
    expect(button('Approve Ada Okafor')).toBeDisabled()
    expect(button('Decline Ada Okafor')).toBeDisabled()
    expect(button('Approve Tomás Rivera')).toBeDisabled()
    expect(button('Remove Lena Hoffmann')).toBeDisabled()
    expect(sent('creator_decide')).toEqual([
      { p_workspace_id: 'ws-1', p_input: { member_id: 'm-ada', action: 'approve' } },
    ])

    answer.release(decision(ada, { status: 'active', activated_at: '2026-11-13T10:00:00Z' }))
    expect(await screen.findByText('Ada Okafor approved')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Waiting for you 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Creators 4' })).toBeInTheDocument()
    expect(within(waiting()).queryByText('Ada Okafor')).not.toBeInTheDocument()
    const row = within(promoting()).getAllByRole('row')[1]
    expect(row).toHaveTextContent('Ada Okafor')
    expect(row).toHaveTextContent('13 Nov 2026')
    // Focus follows the creator to where they went.
    expect(row).toHaveFocus()
    expect(button('Approve Tomás Rivera')).toBeEnabled()
    // The list on screen came from the answer; nothing was read again.
    expect(sent('creators')).toHaveLength(1)
  })

  it('declines with an optional note', async () => {
    signedInAs('owner')
    answers({
      workspace_program_creator_decide: (args: Args) =>
        decision(ada, {
          status: 'declined',
          ended_at: '2026-11-13T10:00:00Z',
          decision_note: (args.p_input as { note?: string }).note ?? null,
        }),
    })
    const user = await openCreators()
    await user.click(button('Decline Ada Okafor'))
    const dialog = await screen.findByRole('dialog', { name: 'Decline Ada Okafor?' })
    expect(dialog).toHaveTextContent('They will not get a link. You can approve them later.')
    expect(sent('creator_decide')).toHaveLength(0)
    await user.type(
      within(dialog).getByLabelText('Note to the creator (optional)'),
      '  Only English teachers for now.  ',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }))

    expect(await screen.findByText('Ada Okafor declined')).toBeInTheDocument()
    expect(sent('creator_decide')).toEqual([
      {
        p_workspace_id: 'ws-1',
        p_input: { member_id: 'm-ada', action: 'decline', note: 'Only English teachers for now.' },
      },
    ])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Waiting for you 1' })).toBeInTheDocument()
    // The ended list opens, so the person sees where the creator went.
    expect(button('Ended 4')).toHaveAttribute('aria-expanded', 'true')
    const row = within(ended()).getAllByRole('listitem')[0]
    expect(row).toHaveTextContent('Ada Okafor')
    expect(row).toHaveTextContent('Declined 13 Nov 2026')
    expect(row).toHaveTextContent('Your note: Only English teachers for now.')
    expect(within(row).getByRole('button', { name: 'Approve Ada Okafor again' })).toBeEnabled()
  })

  it('declines without a note when none is typed, and sends nothing on Cancel', async () => {
    signedInAs('owner')
    answers({
      workspace_program_creator_decide: decision(tomas, {
        status: 'declined',
        ended_at: '2026-11-13T10:00:00Z',
      }),
    })
    const user = await openCreators()
    await user.click(button('Decline Tomás Rivera'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sent('creator_decide')).toHaveLength(0)
    // Focus goes back to where the person was.
    expect(button('Decline Tomás Rivera')).toHaveFocus()
    expect(within(waiting()).getByText('Tomás Rivera')).toBeInTheDocument()

    await user.click(button('Decline Tomás Rivera'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Decline' }),
    )
    expect(await screen.findByText('Tomás Rivera declined')).toBeInTheDocument()
    expect(sent('creator_decide')).toEqual([
      { p_workspace_id: 'ws-1', p_input: { member_id: 'm-tomas', action: 'decline' } },
    ])
  })

  it('removes a creator after asking, with a note', async () => {
    signedInAs('owner')
    const answer = held<unknown>()
    answers({ workspace_program_creator_decide: () => answer.promise })
    const user = await openCreators()
    await user.click(button('Remove Lena Hoffmann'))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Lena Hoffmann?' })
    expect(dialog).toHaveTextContent(
      'Their link will still open your page, but new clicks and sales will not be credited to them.',
    )
    await user.type(
      within(dialog).getByLabelText('Note to the creator (optional)'),
      'Paid ads on our name.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Remove creator' }))
    expect(await within(dialog).findByText('Removing')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(sent('creator_decide')).toEqual([
      {
        p_workspace_id: 'ws-1',
        p_input: { member_id: 'm-lena', action: 'remove', note: 'Paid ads on our name.' },
      },
    ])

    answer.release(
      decision(lena, {
        status: 'removed',
        ended_at: '2026-11-13T10:00:00Z',
        decision_note: 'Paid ads on our name.',
      }),
    )
    expect(await screen.findByText('Lena Hoffmann removed')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Creators 2' })).toBeInTheDocument()
    expect(within(promoting()).queryByText('Lena Hoffmann')).not.toBeInTheDocument()
    const row = within(ended()).getAllByRole('listitem')[0]
    expect(row).toHaveTextContent('Lena Hoffmann')
    expect(row).toHaveTextContent('Removed 13 Nov 2026')
    expect(row).toHaveTextContent('Your note: Paid ads on our name.')
  })

  it('approves an ended creator again', async () => {
    signedInAs('owner')
    answers({
      workspace_program_creator_decide: decision(jonas, {
        status: 'active',
        ended_at: null,
        decision_note: null,
        activated_at: '2026-10-20T10:00:00Z',
      }),
    })
    const user = await openCreators()
    await user.click(button(/Ended/))
    await user.click(button('Approve Jonas Berg again'))
    expect(await screen.findByText('Jonas Berg approved')).toBeInTheDocument()
    expect(sent('creator_decide')).toEqual([
      { p_workspace_id: 'ws-1', p_input: { member_id: 'm-jonas', action: 'approve' } },
    ])
    expect(within(promoting()).getByText('Jonas Berg')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Creators 4' })).toBeInTheDocument()
    expect(button('Ended 2')).toBeInTheDocument()
    expect(within(ended()).queryByText('Jonas Berg')).not.toBeInTheDocument()
  })

  it('refuses a note that is too long before anything is sent', async () => {
    signedInAs('owner')
    const user = await openCreators()
    await user.click(button('Decline Ada Okafor'))
    const dialog = await screen.findByRole('dialog')
    const note = within(dialog).getByLabelText('Note to the creator (optional)')
    await user.click(note)
    await user.paste('x'.repeat(NOTE_MAX + 1))
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }))
    expect(within(dialog).getByText('Keep the note under 500 characters.')).toBeInTheDocument()
    expect(note).toHaveAttribute('aria-invalid', 'true')
    expect(sent('creator_decide')).toHaveLength(0)
    // Typing again clears the complaint.
    await user.type(note, '{backspace}')
    expect(within(dialog).queryByText('Keep the note under 500 characters.')).toBeNull()
  })

  it('puts the database’s complaint about a note at the note', async () => {
    signedInAs('owner')
    answers({ workspace_program_creator_decide: refuse('invalid_note') })
    const user = await openCreators()
    await user.click(button('Remove Lena Hoffmann'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Note to the creator (optional)'), 'Bye')
    await user.click(within(dialog).getByRole('button', { name: 'Remove creator' }))
    expect(
      await within(dialog).findByText('Keep the note under 500 characters.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Note to the creator (optional)')).toHaveValue('Bye')
    // Still in the table, behind the dialog.
    expect(rowOf('Lena Hoffmann').closest('table')).not.toBeNull()
  })

  it('says when an approval failed and tries it again on Retry', async () => {
    signedInAs('owner')
    let attempt = 0
    answers({
      workspace_program_creator_decide: () =>
        ++attempt === 1
          ? refuse('something_new', 'XX000')
          : decision(ada, { status: 'active', activated_at: '2026-11-13T10:00:00Z' }),
    })
    const user = await openCreators()
    await user.click(button('Approve Ada Okafor'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The creator was not approved. Try again.')
    expect(alert).not.toHaveTextContent('something_new')
    expect(within(waiting()).getByText('Ada Okafor')).toBeInTheDocument()
    expect(button('Approve Ada Okafor')).toBeEnabled()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Ada Okafor approved')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sent('creator_decide')).toHaveLength(2)
  })

  it('keeps the dialog and the note when a decline does not go through', async () => {
    signedInAs('owner')
    let attempt = 0
    answers({
      workspace_program_creator_decide: () =>
        ++attempt === 1
          ? new Error('TypeError: Failed to fetch')
          : decision(ada, { status: 'declined', ended_at: '2026-11-13T10:00:00Z' }),
    })
    const user = await openCreators()
    await user.click(button('Decline Ada Okafor'))
    const dialog = await screen.findByRole('dialog')
    const note = within(dialog).getByLabelText('Note to the creator (optional)')
    await user.type(note, 'Not a fit.')
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(note).toHaveValue('Not a fit.')
    expect(within(dialog).getByRole('button', { name: 'Decline' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('Ada Okafor declined')).toBeInTheDocument()
    expect(sent('creator_decide')[1]).toEqual({
      p_workspace_id: 'ws-1',
      p_input: { member_id: 'm-ada', action: 'decline', note: 'Not a fit.' },
    })
  })

  it('reads the list again when the database says the creator cannot be changed', async () => {
    signedInAs('owner')
    let reads = 0
    answers({ workspace_program_creator_decide: refuse('status_not_allowed') })
    const user = await openCreators(() =>
      ++reads === 1
        ? creatorsState(everyone)
        : creatorsState(everyone.filter((row) => row.member_id !== 'm-ada')),
    )
    await user.click(button('Approve Ada Okafor'))
    expect(
      await screen.findByText(
        'That cannot be done for this creator right now. You are now seeing the latest list.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Ada Okafor')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Waiting for you 1' })).toBeInTheDocument()
    expect(sent('creators')).toHaveLength(2)
  })

  it('closes the dialog and reads the list again when the creator has left', async () => {
    signedInAs('owner')
    let reads = 0
    answers({ workspace_program_creator_decide: refuse('not_a_member') })
    const user = await openCreators(() =>
      ++reads === 1
        ? creatorsState(everyone)
        : creatorsState(everyone.filter((row) => row.member_id !== 'm-lena')),
    )
    await user.click(button('Remove Lena Hoffmann'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove creator' }),
    )
    expect(
      await screen.findByText(
        'That creator is no longer in this program. You are now seeing the latest list.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Lena Hoffmann')).not.toBeInTheDocument()
  })

  it('says creators need a live program when it was paused in the meantime', async () => {
    signedInAs('owner')
    let reads = 0
    answers({ workspace_program_creator_decide: refuse('program_not_open') })
    const user = await openCreators(() =>
      ++reads === 1
        ? creatorsState(everyone)
        : creatorsState(everyone, { program: program({ status: 'paused' }) }),
    )
    await user.click(button('Approve Ada Okafor'))
    expect(
      await screen.findByText('Creators can only be approved while your program is live.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/This program is paused/)).toBeInTheDocument()
    expect(button('Approve Ada Okafor')).toBeDisabled()
  })

  it('says links are not available when tracking is off, with nothing to retry', async () => {
    signedInAs('owner')
    answers({ workspace_program_creator_decide: refuse('tracking_not_enabled') })
    const user = await openCreators()
    await user.click(button('Approve Ada Okafor'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Creator links are not available yet, so nobody can be approved right now.',
    )
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
    expect(within(waiting()).getByText('Ada Okafor')).toBeInTheDocument()
  })

  it('takes the buttons away when the database says this person may not decide', async () => {
    signedInAs('admin')
    answers({ workspace_program_creator_decide: refuse(null, '42501') })
    const user = await openCreators()
    await user.click(button('Remove Lena Hoffmann'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove creator' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an owner or admin can approve or remove creators. Ask one of them to do this.',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(buttons(/Approve|Decline|Remove/)).toHaveLength(0)
    expect(within(promoting()).getByText('Lena Hoffmann')).toBeInTheDocument()
  })
})

// Phase 5: what each creator sold and earned ---------------------------------------------------

const lenaPaid = {
  ...lena,
  sales_amount_minor: 151900,
  commission_minor: 45570,
  pending_minor: 14700,
}
const kwamePaid = { ...kwame, sales_amount_minor: 34300, commission_minor: 10290, pending_minor: 0 }
const priyaPaid = { ...priya, sales_amount_minor: 0, commission_minor: 0, pending_minor: 0 }
const jonasPaid = {
  ...jonas,
  clicks: 485,
  sales: 6,
  sales_amount_minor: 36400,
  commission_minor: 10920,
  pending_minor: 0,
}
const promotingPaid = [lenaPaid, kwamePaid, priyaPaid]

/** What the rows add up to, as the database's totals do. */
function totalsOf(rows: Creator[]): CreatorTotals {
  const sum = (pick: (row: Creator) => number | null) =>
    rows.reduce((all, row) => all + (pick(row) ?? 0), 0)
  return {
    clicks: sum((row) => row.clicks),
    sales: sum((row) => row.sales),
    sales_amount_minor: sum((row) => row.sales_amount_minor),
    commission_minor: sum((row) => row.commission_minor),
    pending_minor: sum((row) => row.pending_minor),
  }
}

/** A Phase 5 answer: the rows, the program's currency and the totals over active and ended. */
const paidState = (rows: Creator[], over: Partial<Omit<CreatorsState, 'creators'>> = {}) =>
  creatorsState(rows, {
    currency: 'USD',
    totals: totalsOf(rows.filter((row) => row.status !== 'pending')),
    ...over,
  })

const totalRow = () =>
  screen.getByRole('rowheader', { name: /^Total/ }).closest('tr') as HTMLElement
const texts = (row: HTMLElement, role: 'cell' | 'columnheader' = 'cell') =>
  within(row)
    .getAllByRole(role)
    .map((cell) => cell.textContent)

describe('reading the money creators made', () => {
  it('reads what each creator sold and earned, the currency and the totals', () => {
    const read = readCreators(salesFixture.creators_money)
    expect(read.currency).toBe('USD')
    expect(moneyCurrency(read)).toBe('USD')
    expect(Object.keys(read.totals!).sort()).toEqual([
      'clicks',
      'commission_minor',
      'pending_minor',
      'sales',
      'sales_amount_minor',
    ])
    for (const value of Object.values(read.totals!)) expect(Number.isSafeInteger(value)).toBe(true)
    expect(read.creators.length).toBeGreaterThan(0)
    for (const row of read.creators) {
      expect(Number.isSafeInteger(row.sales_amount_minor)).toBe(true)
      expect(Number.isSafeInteger(row.commission_minor)).toBe(true)
      expect(row.pending_minor).toBeLessThanOrEqual(row.commission_minor!)
    }
    expect(JSON.stringify(read)).not.toContain('@')
  })

  it('accepts an answer from before these figures existed, and reads no money from it', () => {
    for (const name of ['creators_mixed', 'creators_one_active', 'creators_pending']) {
      const read = readCreators(creatorBackendFixture[name])
      expect(read.program).not.toBeNull()
      expect(read.totals).toBeNull()
      expect(read.currency).toBeNull()
      expect(moneyCurrency(read)).toBeNull()
      expect(read.creators.length).toBeGreaterThan(0)
      for (const row of read.creators) {
        expect(row.sales_amount_minor).toBeNull()
        expect(row.commission_minor).toBeNull()
        expect(row.pending_minor).toBeNull()
      }
    }
  })

  it('never shows half a total: one unreadable amount and there is no totals line', () => {
    const good = totalsOf([lenaPaid, jonasPaid])
    expect(readCreators(paidState([lenaPaid, jonasPaid])).totals).toEqual(good)
    for (const wrong of [
      null,
      'totals',
      [],
      {},
      { ...good, commission_minor: undefined },
      { ...good, sales_amount_minor: '151900' },
      { ...good, pending_minor: -1 },
      { ...good, commission_minor: 455.7 },
      { ...good, sales_amount_minor: Number.MAX_SAFE_INTEGER + 2 },
    ])
      expect(
        readCreators({ ...paidState([lenaPaid]), totals: wrong as unknown as CreatorTotals })
          .totals,
      ).toBeNull()
    // Counts are counts: a missing one is zero, as for a creator.
    expect(
      readCreators({
        ...paidState([lenaPaid]),
        totals: { ...good, clicks: undefined } as unknown as CreatorTotals,
      }).totals,
    ).toEqual({ ...good, clicks: 0 })
  })

  it('reads an amount as whole minor units or not at all', () => {
    const [read] = readCreators(
      paidState([
        {
          ...lena,
          sales_amount_minor: '151900',
          commission_minor: -5,
          pending_minor: 14.5,
        } as unknown as Creator,
      ]),
    ).creators
    expect(read.sales_amount_minor).toBeNull()
    expect(read.commission_minor).toBeNull()
    expect(read.pending_minor).toBeNull()
  })

  it('reads the currency as a three-letter code, and falls back to dollars for the money it has', () => {
    expect(readCreators(paidState([lenaPaid], { currency: 'eur' })).currency).toBe('EUR')
    const unnamed = readCreators(paidState([lenaPaid], { currency: 'dollars' }))
    expect(unnamed.currency).toBeNull()
    expect(moneyCurrency(unnamed)).toBe('USD')
  })

  it('reads no money where there is no program', () => {
    const read = readCreators(paidState([], { program: null }))
    expect(read.totals).toBeNull()
    expect(read.currency).toBeNull()
  })

  it('keeps a creator’s figures through a decision that does not repeat them', () => {
    const before = readCreators(paidState([...promotingPaid, jonasPaid]))
    const after = withDecision(before, { ...lena, status: 'removed' })
    expect(after.creators[0]).toMatchObject({
      member_id: 'm-lena',
      status: 'removed',
      sales_amount_minor: 151900,
      commission_minor: 45570,
      pending_minor: 14700,
    })
    expect(after.totals).toEqual(before.totals)
    // An answer that does carry them is taken at its word.
    const fresh = withDecision(before, { ...lenaPaid, status: 'removed', pending_minor: 0 })
    expect(fresh.creators[0].pending_minor).toBe(0)
  })

  it('says who else is in the totals only when someone is', () => {
    const active = readCreators(paidState(promotingPaid))
    expect(totalsNote(active, groupCreators(active.creators).active)).toBeNull()
    const withEnded = readCreators(paidState([...promotingPaid, jonasPaid]))
    expect(totalsNote(withEnded, groupCreators(withEnded.creators).active)).toBe(
      'Includes ended creators',
    )
    // The list is capped and the totals are not.
    const capped = readCreators(
      paidState(promotingPaid, { totals: { ...totalsOf(promotingPaid), sales: 900 } }),
    )
    expect(totalsNote(capped, groupCreators(capped.creators).active)).toBe('All creators')
    expect(totalsNote(readCreators(creatorsState([lena])), [lena])).toBeNull()
  })
})

describe('creators page: what creators sold and earned', () => {
  it('adds the sales amount and the commission, with the pending part in quiet text', async () => {
    signedInAs('owner')
    await openCreators(paidState([ada, ...promotingPaid]))
    const table = within(promoting()).getByRole('table')
    expect(texts(table.querySelector('thead tr') as HTMLElement, 'columnheader')).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Sales',
      'Sales amount',
      'Commission',
      'Last click',
      'Action',
    ])
    expect(texts(rowOf('Lena Hoffmann'))).toEqual([
      'L' + 'Lena Hoffmann@lena-hoffmann',
      '4 Nov 2026',
      '1,248',
      '31',
      '$1,519.00',
      '$455.70' + '$147.00 pending',
      '3 h ago',
      'Remove',
    ])
    const pending = within(rowOf('Lena Hoffmann')).getByText('$147.00 pending')
    expect(pending).toHaveClass('mc-sub')
    // Nothing pending is not said, and nothing sold yet is a plain zero.
    expect(texts(rowOf('Kwame Mensah'))[5]).toBe('$102.90')
    expect(texts(rowOf('Priya Nair')).slice(4, 6)).toEqual(['$0.00', '$0.00'])
    // Money is never shown in minor units.
    expect(page()).not.toHaveTextContent('151900')
    expect(page()).not.toHaveTextContent('45570')
  })

  it('ends the table with a totals line under the same columns', async () => {
    signedInAs('owner')
    await openCreators(paidState(promotingPaid))
    expect(texts(totalRow())).toEqual([
      '',
      '1,660',
      '38',
      '$1,862.00',
      '$558.60' + '$147.00 pending',
      '',
      '',
    ])
    expect(screen.getByRole('rowheader', { name: 'Total' })).toBeInTheDocument()
    expect(totalRow().closest('tfoot')).not.toBeNull()
    // One cell per column, so every figure sits under its heading.
    expect(totalRow().children).toHaveLength(8)
  })

  it('says when the totals count creators who have ended', async () => {
    signedInAs('owner')
    await openCreators(paidState([...promotingPaid, jonasPaid]))
    expect(screen.getByRole('rowheader', { name: 'Total Includes ended creators' })).toBeVisible()
    expect(texts(totalRow()).slice(1, 5)).toEqual([
      '2,145',
      '44',
      '$2,226.00',
      '$667.80' + '$147.00 pending',
    ])
  })

  it('keeps the totals line in step when the reader cannot manage creators', async () => {
    signedInAs('analyst')
    await openCreators(paidState(promotingPaid, { can_manage: false }))
    const table = within(promoting()).getByRole('table')
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7)
    expect(totalRow().children).toHaveLength(7)
    expect(buttons(/^Remove/)).toHaveLength(0)
  })

  it('opens Sales for one creator from their name', async () => {
    signedInAs('owner')
    const user = await openCreators(paidState([ada, ...promotingPaid, jonasPaid]))
    const link = screen.getByRole('link', { name: 'Lena Hoffmann: open their sales' })
    expect(link).toHaveAttribute('href', '#sales?creator=m-lena')
    expect(link).toHaveTextContent(/^Lena Hoffmann$/)
    expect(parseRoute(link.getAttribute('href')!)).toEqual({ name: 'sales', creator: 'm-lena' })
    // Someone still waiting has sold nothing: their name is only a name.
    expect(screen.queryByRole('link', { name: /^Ada Okafor/ })).not.toBeInTheDocument()
    // Someone who has ended may have sold plenty.
    await user.click(button(/^Ended/))
    expect(screen.getByRole('link', { name: 'Jonas Berg: open their sales' })).toHaveAttribute(
      'href',
      '#sales?creator=m-jonas',
    )
  })

  it('shows a dash for a creator whose figures did not arrive', async () => {
    signedInAs('owner')
    await openCreators(paidState([lenaPaid, { ...priya }], { totals: totalsOf([lenaPaid]) }))
    expect(texts(rowOf('Priya Nair')).slice(4, 6)).toEqual(['—None yet', '—None yet'])
  })

  it('writes another currency after the amount', async () => {
    signedInAs('owner')
    await openCreators(paidState(promotingPaid, { currency: 'EUR' }))
    expect(texts(rowOf('Lena Hoffmann')).slice(4, 6)).toEqual([
      '1,519.00 EUR',
      '455.70 EUR' + '147.00 EUR pending',
    ])
  })

  it('keeps a long name and large figures on the page', async () => {
    signedInAs('owner')
    const long = 'Maximiliano Alexander Fitzgerald-Montgomery von Hohenzollern the Third'
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...lenaPaid,
      member_id: `m-${index}`,
      name: index === 0 ? long : `Creator ${index}`,
      handle: `creator-${index}`,
      sales_amount_minor: 123456700,
      commission_minor: 37037010,
      pending_minor: 12345600,
    }))
    await openCreators(paidState(many))
    expect(screen.getByRole('link', { name: `${long}: open their sales` })).toBeInTheDocument()
    expect(texts(rowOf(long)).slice(4, 6)).toEqual([
      '$1,234,567.00',
      '$370,370.10' + '$123,456.00 pending',
    ])
    expect(within(promoting()).getAllByRole('row')).toHaveLength(62)
    expect(texts(totalRow())[3]).toBe('$74,074,020.00')
  })

  it('is the page as it was for a database that sends no money yet', async () => {
    signedInAs('owner')
    await openCreators(creatorBackendFixture.creators_mixed)
    const table = within(promoting()).getByRole('table')
    expect(texts(table.querySelector('thead tr') as HTMLElement, 'columnheader')).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Sales',
      'Last click',
      'Action',
    ])
    expect(screen.queryByRole('rowheader')).not.toBeInTheDocument()
    expect(table.querySelector('tfoot')).toBeNull()
    expect(screen.queryByRole('link', { name: /open their sales/ })).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('$')
    expect(page()).not.toHaveTextContent('pending')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
  })
})

describe('creators of a program that pays for events', () => {
  const withEvents = (events: Array<number | undefined>, rows: Creator[] = promotingPaid) =>
    rows.map((row, index) => ({ ...row, events: events[index] }))
  /** The same creators in a program that has only ever paid for events. */
  const eventsOnly = withEvents(
    [34, 24, 0],
    promotingPaid.map((row) => ({ ...row, sales: 0, sales_amount_minor: 0 })),
  )
  const captured = rewardsBackendFixture.workspace_program_creators_with_events as {
    creators: Array<{ member_id: string }>
  }
  const ada = captured.creators[1].member_id
  /** A Phase 6 answer: events per creator and in the totals, and what the program pays for. */
  const eventsState = (
    earnFrom: unknown,
    rows: Creator[] = withEvents([34, 24, 0]),
    over: Partial<Omit<CreatorsState, 'creators'>> = {},
  ) =>
    paidState(rows, {
      earn_from: earnFrom as CreatorsState['earn_from'],
      totals: { ...totalsOf(rows), events: rows.reduce((all, row) => all + (row.events ?? 0), 0) },
      ...over,
    })
  const heads = () =>
    texts(
      within(promoting()).getByRole('table').querySelector('thead tr') as HTMLElement,
      'columnheader',
    )

  it('reads what the program pays for, and sales when the answer does not say', () => {
    expect(readCreators(eventsState('events')).earn_from).toBe('events')
    expect(readCreators(eventsState('both')).earn_from).toBe('both')
    for (const none of [undefined, null, 'sales', 'installs', 7])
      expect(readCreators(eventsState(none)).earn_from).toBe('sales')
    expect(readCreators(paidState(promotingPaid)).earn_from).toBe('sales')
    expect(readCreators(eventsState('both', [], { program: null })).earn_from).toBe('sales')
  })

  it('reads events as a count, and adds no key the database did not send', () => {
    const read = readCreators(
      eventsState('both', withEvents([34, -3, undefined]), {
        totals: { ...totalsOf(promotingPaid), events: 58.4 },
      }),
    )
    expect(read.creators.map((row) => row.events)).toEqual([34, 0, undefined])
    expect('events' in read.creators[2]).toBe(false)
    expect(read.totals?.events).toBe(58)
    const before = readCreators(paidState(promotingPaid))
    expect('events' in before.totals!).toBe(false)
    for (const row of before.creators) expect('events' in row).toBe(false)
  })

  it('keeps a creator’s events through a decision that does not repeat them', () => {
    const before = readCreators(eventsState('both'))
    const after = withDecision(before, { ...lena, status: 'removed' })
    expect(after.creators[0]).toMatchObject({ member_id: 'm-lena', status: 'removed', events: 34 })
    expect(after.earn_from).toBe('both')
    expect(withDecision(before, { ...lena, events: 35 }).creators[0].events).toBe(35)
  })

  it('adds an Events column beside Sales when the program pays for both', async () => {
    signedInAs('owner')
    await openCreators(eventsState('both'))
    expect(heads()).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Sales',
      'Events',
      'Sales amount',
      'Earned',
      'Last click',
      'Action',
    ])
    expect(texts(rowOf('Lena Hoffmann')).slice(2, 7)).toEqual([
      '1,248',
      '31',
      '34',
      '$1,519.00',
      '$455.70' + '$147.00 pending',
    ])
    expect(texts(totalRow())).toEqual([
      '',
      '1,660',
      '38',
      '58',
      '$1,862.00',
      '$558.60' + '$147.00 pending',
      '',
      '',
    ])
    expect(totalRow().children).toHaveLength(9)
    // The name still opens their sales; the events open their rewards.
    expect(screen.getByRole('link', { name: 'Lena Hoffmann: open their sales' })).toHaveAttribute(
      'href',
      '#sales?creator=m-lena',
    )
    const events = screen.getByRole('link', { name: 'Lena Hoffmann: open their rewards' })
    expect(events).toHaveAttribute('href', '#rewards?creator=m-lena')
    expect(events).toHaveTextContent(/^34$/)
    // Nothing to open where there are no events yet.
    expect(screen.queryByRole('link', { name: 'Priya Nair: open their rewards' })).toBeNull()
    expect(texts(rowOf('Priya Nair'))[4]).toBe('0')
  })

  it('counts events in place of sales when the program pays for events only', async () => {
    signedInAs('owner')
    await openCreators(eventsState('events', eventsOnly))
    expect(heads()).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Events',
      'Earned',
      'Last click',
      'Action',
    ])
    expect(texts(rowOf('Lena Hoffmann')).slice(2, 5)).toEqual([
      '1,248',
      '34',
      '$455.70' + '$147.00 pending',
    ])
    expect(texts(totalRow())).toEqual(['', '1,660', '58', '$558.60' + '$147.00 pending', '', ''])
    expect(totalRow().children).toHaveLength(7)
    // With no sales to open, the name opens their rewards.
    expect(screen.getByRole('link', { name: 'Lena Hoffmann: open their rewards' })).toHaveAttribute(
      'href',
      '#rewards?creator=m-lena',
    )
    expect(screen.queryByRole('link', { name: /open their sales/ })).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent(/\btest\b/i)
  })

  it('keeps the sales a program made before it moved to events, beside the events', async () => {
    signedInAs('owner')
    await openCreators(captured)
    expect(heads()).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Sales',
      'Events',
      'Sales amount',
      'Earned',
      'Last click',
      'Action',
    ])
    expect(texts(rowOf('Ada Okafor')).slice(2, 7)).toEqual([
      '8',
      '1',
      '8',
      '$49.00',
      '$36.70' + '$20.00 pending',
    ])
    expect(texts(totalRow())).toEqual([
      '',
      '9',
      '1',
      '10',
      '$49.00',
      '$43.70' + '$27.00 pending',
      '',
      '',
    ])
    expect(screen.getByRole('link', { name: 'Ada Okafor: open their rewards' })).toHaveAttribute(
      'href',
      `#rewards?creator=${ada}`,
    )
  })

  it('shows the events a program still has from before it moved to sales', async () => {
    signedInAs('owner')
    await openCreators(eventsState('sales'))
    expect(heads()).toContain('Events')
    expect(heads()).toContain('Earned')
    expect(texts(totalRow())[3]).toBe('58')
  })

  it('is the page as it is today when the program pays for sales and nobody has events', async () => {
    signedInAs('owner')
    await openCreators(eventsState('sales', withEvents([0, 0, 0])))
    expect(heads()).toEqual([
      'Creator',
      'Joined',
      'Clicks',
      'Sales',
      'Sales amount',
      'Commission',
      'Last click',
      'Action',
    ])
    expect(totalRow().children).toHaveLength(8)
    expect(texts(totalRow())[2]).toBe('38')
    expect(screen.queryByRole('link', { name: /open their rewards/ })).not.toBeInTheDocument()
    expect(page()).not.toHaveTextContent('Events')
  })

  it('says who else is in the totals when only the events differ', () => {
    const same = readCreators(eventsState('both'))
    expect(totalsNote(same, groupCreators(same.creators).active)).toBeNull()
    const more = readCreators(
      eventsState('both', withEvents([34, 24, 0]), {
        totals: { ...totalsOf(promotingPaid), events: 90 },
      }),
    )
    expect(totalsNote(more, groupCreators(more.creators).active)).toBe('All creators')
    // Where the table shows no events, they are not compared.
    const sales = readCreators(
      eventsState('sales', withEvents([0, 0, 0]), {
        totals: { ...totalsOf(promotingPaid), events: 0 },
      }),
    )
    expect(
      totalsNote(
        { ...sales, totals: { ...sales.totals!, events: undefined } },
        groupCreators(sales.creators).active,
      ),
    ).toBeNull()
  })
})
