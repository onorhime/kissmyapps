import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiKey, Context, Overview, Person, Project, Role } from './api'
import { csvText, toCsv } from './csv'
import {
  formatChange,
  formatClockDuration,
  formatDuration,
  personLabel,
  placeLabel,
  plural,
  referrerHost,
} from './format'
import { isMerchantConsole } from './host'
import { MerchantApp } from './MerchantApp'
import { href, parseRoute } from './routes'
import type { Route } from './routes'
import { useRpc } from './ui/useRpc'

// A stand-in for the Supabase client: auth with listeners, and rpc calls answered by handlers.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
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
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      if (password !== 'correct-horse-battery')
        return { error: { message: 'Invalid login credentials', status: 400 } }
      state.session = { user: { id: 'user-1', email } }
      emit('SIGNED_IN')
      return { error: null }
    },
    async signUp() {
      return { data: { user: null, session: null }, error: null }
    },
    async resetPasswordForEmail() {
      return { error: null }
    },
    async updateUser() {
      return { error: null }
    },
    async signOut() {
      state.session = null
      emit('SIGNED_OUT')
      return { error: null }
    },
  }
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    state.calls.push({ name, args })
    const handler = state.handlers[name]
    if (!handler) return { data: null, error: { code: 'P0002', message: `No handler for ${name}` } }
    try {
      return { data: await handler(args), error: null }
    } catch (problem) {
      return { data: null, error: problem }
    }
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
  timezone: 'Africa/Lagos',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
  last_event_at: '2026-10-30T09:59:00Z',
  online_now: 2,
  users_today: 9,
}

const context = (role: Role = 'owner'): Context => ({
  user: { id: 'user-1', email: 'victory@example.com', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects: [project] }],
})

const kpis = (users: number) => ({
  users,
  new_users: Math.round(users / 2),
  returning_users: users - Math.round(users / 2),
  sessions: users * 2,
  avg_session_seconds: 154,
  sessions_per_user: 2,
  events: users * 9,
  errors: 1,
  daily_users: users / 7,
})

const overview: Overview = {
  range: {
    key: '7d',
    from: '2026-10-24T00:00:00Z',
    to: '2026-10-30T10:00:00Z',
    prev_from: '2026-10-17T00:00:00Z',
    prev_to: '2026-10-24T00:00:00Z',
    bucket: 'day',
    timezone: 'Africa/Lagos',
  },
  current: kpis(1240),
  previous: kpis(1000),
  comparable: true,
  online_now: 2,
  series: Array.from({ length: 7 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 9, 24 + index)).toISOString(),
    users: 150 + index * 10,
    new_users: 60,
    sessions: 300,
    partial: index === 6,
  })),
  breakdowns: {
    countries: [
      { key: 'NG', users: 700 },
      { key: 'GB', users: 300 },
    ],
    unknown_country: 4,
    cities: [{ key: 'Lagos', country: 'NG', users: 500 }],
    platforms: [
      { key: 'ios', users: 800 },
      { key: 'web', users: 440 },
    ],
    device_types: [{ key: 'mobile', users: 900 }],
    devices: [{ key: 'iPhone 15', users: 400 }],
    os: [{ key: 'iOS', users: 800 }],
    browsers: [{ key: 'Chrome', users: 300 }],
    app_versions: [{ key: '2.4.0', platform: 'ios', users: 600 }],
    languages: [{ key: 'en-NG', users: 600 }],
    referrers: [{ key: 'instagram', users: 200 }],
    entry_screens: [{ key: '/', sessions: 400 }],
    actions: [{ key: 'lesson_completed', users: 900, events: 4000 }],
    screens: [{ key: 'Lesson', users: 1000, views: 6000 }],
    errors: [],
  },
  bots: { excluded_sessions: 12, flagged_sessions: 14, sessions: 2492 },
  last_event_at: '2026-10-30T09:59:00Z',
  has_data: true,
  sources: [],
}

const online = [
  {
    person_id: 'person-1',
    distinct_id: 'amaka@example.com',
    user_id: 'amaka@example.com',
    traits: { name: 'Amaka Obi', email: 'amaka@example.com' },
    session_id: 'session-1',
    started_at: '2026-10-30T09:55:00Z',
    last_seen: '2026-10-30T09:59:30Z',
    platform: 'ios',
    country: 'NG',
    city: 'Lagos',
    device_model: 'iPhone 15',
    device_type: 'mobile',
    os_name: 'iOS',
    browser: null,
    app_version: '2.4.0',
    screen: 'Lesson 4',
    events_count: 12,
  },
]

const clientKey: ApiKey = {
  id: 'key-1',
  project_id: 'proj-1',
  name: 'Apps',
  kind: 'client',
  environment: 'production',
  prefix: 'kma_pk_live_',
  last4: 'RbC8',
  token: 'kma_pk_live_xXSXRWuFNMSSr8ssfpyRbC8',
  created_at: '2026-10-01T09:00:00Z',
  last_used_at: null,
  revoked_at: null,
  created_by: 'Victory Onorhime',
}

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-1',
    distinct_id: 'amaka@example.com',
    user_id: 'amaka@example.com',
    anonymous_ids: ['device-a'],
    traits: { name: 'Amaka Obi', email: 'amaka@example.com' },
    environment: 'production',
    first_seen: '2026-10-20T09:00:00Z',
    last_seen: '2026-10-30T09:59:00Z',
    platform: 'ios',
    country: 'NG',
    region: 'Lagos',
    city: 'Lagos',
    timezone: 'Africa/Lagos',
    language: 'en-NG',
    device_type: 'mobile',
    device_model: 'iPhone 15',
    os_name: 'iOS',
    os_version: '18.1',
    browser: null,
    browser_version: null,
    app_version: '2.4.0',
    sdk: 'http',
    screen_width: 393,
    screen_height: 852,
    initial_referrer: null,
    initial_utm_source: 'instagram',
    initial_utm_medium: null,
    initial_utm_campaign: null,
    initial_landing: null,
    sessions_count: 9,
    events_count: 120,
    online: true,
    ...overrides,
  }
}

function signedInAs(role: Role) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.com' } }
  fake.state.handlers.analytics_bootstrap = () => context(role)
  fake.state.handlers.analytics_context = () => context(role)
}

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.handlers = {
    analytics_overview: () => overview,
    analytics_online: () => online,
    analytics_project_settings: () => ({ project, role: 'owner', keys: [clientKey] }),
    analytics_project_status: () => ({ events_total: 0, last_event_at: null, sources: [] }),
  }
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('merchant console host', () => {
  const at = (hostname: string, search = '', pathname = '/') => ({ hostname, search, pathname })

  it('opens on the merchant subdomain and with ?app=merchant elsewhere', () => {
    expect(isMerchantConsole(at('merchant.kissmyapps.dev'))).toBe(true)
    expect(isMerchantConsole(at('merchant.localhost'))).toBe(true)
    expect(isMerchantConsole(at('localhost', '?app=merchant'))).toBe(true)
    expect(isMerchantConsole(at('localhost'))).toBe(false)
  })

  it('leaves the partner and admin hosts and the Stripe connect pages alone', () => {
    expect(isMerchantConsole(at('partners.kissmyapps.dev', '?app=merchant'))).toBe(false)
    expect(isMerchantConsole(at('admin.kissmyapps.dev', '?app=merchant'))).toBe(false)
    expect(isMerchantConsole(at('merchant.kissmyapps.dev', '', '/merchant/callback'))).toBe(false)
  })
})

describe('merchant routes', () => {
  it('round-trips every page through the hash', () => {
    const routes: Route[] = [
      { name: 'sign-in' },
      { name: 'new-password' },
      { name: 'sign-up' },
      { name: 'sign-up', email: 'ada+team@studio.test', invited: true },
      { name: 'confirm-email', token: 'pkce_a1b2/c3+d4' },
      { name: 'confirm-email' },
      { name: 'workspace', section: 'projects', projectId: 'p 1', create: true },
      { name: 'workspace', section: 'members', projectId: 'p1' },
      { name: 'overview', projectId: 'p1' },
      { name: 'users', projectId: 'p1' },
      { name: 'person', projectId: 'p1', personId: 'a/b c' },
      { name: 'sessions', projectId: 'p1' },
      { name: 'session', projectId: 'p1', sessionId: 's1' },
      { name: 'events', projectId: 'p1' },
      { name: 'live', projectId: 'p1' },
      { name: 'event', projectId: 'p1', eventName: 'plan:selected' },
      { name: 'bots', projectId: 'p1' },
      { name: 'settings', projectId: 'p1', section: 'keys' },
    ]
    for (const route of routes) expect(parseRoute(href(route))).toEqual(route)
  })

  it('falls back to safe pages for unknown hashes', () => {
    expect(parseRoute('#nowhere')).toEqual({ name: 'home' })
    expect(parseRoute('#p/')).toEqual({ name: 'home' })
    expect(parseRoute('#p/p1/whatever')).toEqual({ name: 'overview', projectId: 'p1' })
    expect(parseRoute('#p/p1/settings/billing')).toEqual({
      name: 'settings',
      projectId: 'p1',
      section: 'general',
    })
    expect(parseRoute('#p/%E0%A4%A/users')).toEqual({ name: 'home' })
  })
})

describe('formatting', () => {
  it('describes changes honestly', () => {
    expect(formatChange(120, 100).text).toMatch(/\+20/)
    expect(formatChange(120, 100).tone).toBe('positive')
    expect(formatChange(80, 100, false).tone).toBe('positive')
    expect(formatChange(5, 0).text).toMatch(/new/)
  })

  it('names people by what the app told us, else by their ID', () => {
    expect(personLabel(person()).name).toBe('Amaka Obi')
    const anonymous = personLabel({ distinct_id: '3ade85f0-aaaa', user_id: null, traits: {} })
    expect(anonymous.anonymous).toBe(true)
    expect(anonymous.name).toMatch(/^Anonymous/)
  })

  it('writes places, durations and counts for people', () => {
    expect(placeLabel(person())).toBe('Lagos, Nigeria')
    expect(placeLabel(person({ city: null, country: null }))).toBe('Unknown')
    expect(formatDuration(154)).toBe('2 m 34 s')
    expect(formatClockDuration(65_000)).toBe('1:05')
    expect(plural(1, 'person', 'people')).toBe('1 person')
    expect(plural(3, 'session')).toBe('3 sessions')
    expect(referrerHost('https://www.google.com/search?q=x')).toBe('google.com')
  })

  it('keeps spreadsheet formulas out of exports', () => {
    const text = csvText(toCsv([{ name: '=HYPERLINK("x")', city: 'Lagos, NG', count: 3 }]))
    expect(text.split('\n')[0]).toBe('name,city,count')
    expect(text.split('\n')[1]).toBe(`"'=HYPERLINK(""x"")","Lagos, NG",3`)
  })
})

describe('useRpc', () => {
  it('keeps the last good data when a refresh fails', async () => {
    let fail = false
    const load = vi.fn(async () => {
      if (fail) throw new Error('Network is down')
      return { users: 5 }
    })
    const { result } = renderHook(() => useRpc('k', load))
    await waitFor(() => expect(result.current.data).toEqual({ users: 5 }))
    fail = true
    await act(() => result.current.refresh())
    expect(result.current.data).toEqual({ users: 5 })
    expect(result.current.error).toBe('Network is down')
  })
})

describe('merchant console', () => {
  it('asks for sign-in, explains a wrong password, then opens the last project', async () => {
    fake.state.handlers.analytics_bootstrap = () => context()
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Sign in to your merchant workspace' })

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText(/Enter the email you use/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Work email'), 'victory@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(
      await screen.findByText('That email and password do not match an account.'),
    ).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('heading', { name: 'Overview', level: 1 })
    expect(window.location.hash).toBe('#p/proj-1/overview')
  })

  it('shows who is using the project: users, people online and where they are', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/overview'
    render(<MerchantApp />)
    const kpis = await screen.findByRole('group', { name: 'Users in the last 7 days' })
    expect(await within(kpis).findByText('1,240')).toBeInTheDocument()
    const onlinePanel = (await screen.findByRole('heading', { name: /Online now/ })).closest(
      'section',
    )!
    expect(await within(onlinePanel).findByText('Amaka Obi')).toBeInTheDocument()
    expect(within(onlinePanel).getByText(/Lagos, Nigeria/)).toBeInTheDocument()
    const where = screen.getByRole('heading', { name: 'Where they are' }).closest('section')!
    expect(within(where).getByRole('link', { name: /Nigeria/ })).toHaveAttribute(
      'href',
      '#p/proj-1/users?country=NG',
    )
    expect(screen.getByText(/12 bot sessions/)).toBeInTheDocument()
    expect(fake.state.calls.find((call) => call.name === 'analytics_overview')?.args).toEqual({
      p_project: 'proj-1',
      p_range: '7d',
    })
  })

  it('lists people and searches everyone in the project', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_people_page = (args) => {
      const query = args.p_query as { search?: string }
      const rows = query.search
        ? [person()]
        : [
            person(),
            person({
              id: 'person-2',
              distinct_id: 'device-x',
              user_id: null,
              traits: {},
              online: false,
              country: 'GB',
              city: 'London',
            }),
          ]
      return {
        total: rows.length,
        range: overview.range,
        facets: { platforms: ['ios'], countries: ['NG', 'GB'] },
        rows,
      }
    }
    window.location.hash = '#p/proj-1/users'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByText('London, United Kingdom')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    await user.type(screen.getByRole('searchbox'), 'amaka{Enter}')
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    const last = fake.state.calls.filter((call) => call.name === 'analytics_people_page').at(-1)!
    expect(last.args.p_query).toMatchObject({ search: 'amaka', range: '30d' })
    expect(screen.getByRole('link', { name: /Amaka Obi/ })).toHaveAttribute(
      'href',
      '#p/proj-1/users/person-1',
    )
  })

  it('shows a new server key once, then only its masked form', async () => {
    signedInAs('owner')
    const serverKey: ApiKey = {
      ...clientKey,
      id: 'key-2',
      name: 'Backend import',
      kind: 'server',
      prefix: 'kma_sk_live_',
      last4: 'BPpa',
      token: null,
    }
    let keys = [clientKey]
    fake.state.handlers.analytics_project_settings = () => ({ project, role: 'owner', keys })
    fake.state.handlers.analytics_create_key = (args) => {
      expect(args).toMatchObject({
        p_project: 'proj-1',
        p_name: 'Backend import',
        p_kind: 'server',
        p_environment: 'production',
      })
      keys = [clientKey, serverKey]
      return { ...serverKey, token: 'kma_sk_live_AJyo8T9oJ3EwSHVtCjTQYACmM4NGGndDPGk9BPpa' }
    }
    window.location.hash = '#p/proj-1/settings/keys'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('button', { name: 'New key' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'Backend import')
    await user.click(within(dialog).getByRole('button', { name: 'Server key' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }))
    expect(
      await screen.findByRole('heading', { name: 'Copy this server key now' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('kma_sk_live_AJyo8T9oJ3EwSHVtCjTQYACmM4NGGndDPGk9BPpa'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'I have stored it' }))
    expect(screen.queryByText(/AJyo8T9oJ3EwSHVt/)).not.toBeInTheDocument()
    const row = screen.getByRole('row', { name: /Backend import/ })
    expect(row).toHaveTextContent('kma_sk_live_')
    expect(row).toHaveTextContent('BPpa')
  })

  it('lets analysts read reports but not manage keys', async () => {
    signedInAs('analyst')
    fake.state.handlers.analytics_project_settings = () => ({
      project,
      role: 'analyst',
      keys: [clientKey],
    })
    window.location.hash = '#p/proj-1/settings/keys'
    render(<MerchantApp />)
    await screen.findByRole('row', { name: /Apps/ })
    expect(screen.queryByRole('button', { name: 'New key' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument()
  })

  it('switches project from the menu and keeps the kind of page', async () => {
    const second: Project = { ...project, id: 'proj-2', name: 'Lingo Kids', platforms: ['android'] }
    fake.state.session = { user: { id: 'user-1', email: 'victory@example.com' } }
    const both = (): Context => ({
      ...context(),
      workspaces: [{ ...context().workspaces[0], projects: [project, second] }],
    })
    fake.state.handlers.analytics_bootstrap = both
    fake.state.handlers.analytics_context = both
    fake.state.handlers.analytics_bots = () => ({
      totals: {
        sessions: 0,
        excluded_sessions: 0,
        flagged_sessions: 0,
        excluded_events: 0,
        excluded_people: 0,
      },
      rules: [],
      flagged: [],
      overrides: [],
    })
    window.location.hash = '#p/proj-1/bots'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Bots', level: 1 })
    const sidebar = screen.getByRole('complementary', { name: 'Merchant navigation' })
    await user.click(within(sidebar).getByRole('button', { name: /SpeakSix/ }))
    expect(within(sidebar).getByRole('link', { name: 'Lingo Kids' })).toHaveAttribute(
      'href',
      '#p/proj-2/bots',
    )
  })
})
