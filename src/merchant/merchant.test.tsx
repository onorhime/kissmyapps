import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiKey,
  Attribution,
  AttributionDomain,
  AttributionLink,
  AttributionSettings,
  AttributionSources,
  Context,
  Funnel,
  FunnelReport,
  FunnelStep,
  Overview,
  Person,
  PersonDetail,
  Places,
  Project,
  RetentionReport,
  Role,
} from './api'
import {
  androidIntentFilter,
  fingerprintList,
  linkWithOverrides,
  qrDataUrl,
  sourceLabel,
  suggestedPath,
  suggestedSubdomain,
} from './attribution'
import { csvText, toCsv } from './csv'
import {
  formatChange,
  formatClockDuration,
  formatDuration,
  fullPlace,
  personLabel,
  placeLabel,
  plural,
  referrerHost,
} from './format'
import { isMerchantConsole } from './host'
import { MerchantApp } from './MerchantApp'
import { placeOptions } from './places'
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
    analytics_retention_summary: () => ({
      day: 7,
      from: '2026-09-23',
      to: '2026-10-22',
      people: 64,
      returned: 8,
    }),
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
      { name: 'funnels', projectId: 'p1' },
      { name: 'funnel', projectId: 'p1', funnelId: 'new' },
      { name: 'funnel', projectId: 'p1', funnelId: 'f-1' },
      { name: 'retention', projectId: 'p1' },
      { name: 'events', projectId: 'p1' },
      { name: 'live', projectId: 'p1' },
      { name: 'event', projectId: 'p1', eventName: 'plan:selected' },
      { name: 'bots', projectId: 'p1' },
      { name: 'attribution', projectId: 'p1', section: 'setup' },
      { name: 'attribution', projectId: 'p1', section: 'links' },
      { name: 'attribution', projectId: 'p1', section: 'sources' },
      { name: 'attribution', projectId: 'p1', section: 'settings' },
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
    expect(fullPlace(person({ city: 'Ikeja' }))).toBe('Ikeja, Lagos, Nigeria')
    expect(fullPlace(person())).toBe('Lagos, Nigeria')
    expect(fullPlace(person({ region: null, city: null }))).toBe('Nigeria')
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
    expect(within(where).getByRole('button', { name: /Nigeria\s*700/ })).toBeInTheDocument()
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

  it('says events are getting through when only sessionless events have arrived', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_project_status = () => ({
      events_total: 1,
      last_event_at: '2026-10-30T10:20:00Z',
      sources: [],
    })
    window.location.hash = '#p/proj-1/settings/install'
    render(<MerchantApp />)
    expect(
      await screen.findByText(
        /Events are getting through\. Waiting for the first visit from SpeakSix/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('1 event received so far.')).toBeInTheDocument()
    expect(screen.queryByText(/Waiting for the first event/)).not.toBeInTheDocument()
  })

  it('gives app install steps with the project key for iOS, Android, React Native and Flutter', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/settings/install'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const tabs = await screen.findByRole('group', { name: 'Where you send from' })
    const code = (label: string) =>
      [...document.querySelectorAll(`pre[aria-label="${label}"]`)]
        .map((block) => block.textContent)
        .join('\n')

    await user.click(within(tabs).getByRole('button', { name: 'iOS' }))
    expect(screen.getByRole('heading', { name: '1. Add the package' })).toBeInTheDocument()
    expect(code('Swift Package Manager')).toContain('https://github.com/onorhime/kissmyapps-mobile')
    expect(code('Swift')).toContain('KissMyApps.start(key: "kma_pk_live_xXSXRWuFNMSSr8ssfpyRbC8")')
    expect(code('Swift')).toContain('.kmaScreen("Lesson")')

    await user.click(within(tabs).getByRole('button', { name: 'Android' }))
    expect(code('Gradle')).toContain('maven("https://jitpack.io")')
    expect(code('Gradle')).toContain(
      'implementation("com.github.onorhime:kissmyapps-mobile:1.0.0")',
    )
    expect(code('Kotlin')).toContain(
      'KissMyApps.start(this, "kma_pk_live_xXSXRWuFNMSSr8ssfpyRbC8")',
    )

    await user.click(within(tabs).getByRole('button', { name: 'React Native' }))
    expect(code('Terminal')).toContain('npm install @kissmyappss/react-native')
    expect(code('TypeScript')).toContain("key: 'kma_pk_live_xXSXRWuFNMSSr8ssfpyRbC8'")
    expect(code('TypeScript')).toContain('{...trackNavigation(navigation)}')
    expect(screen.getByText(/Waiting for the first event from SpeakSix/)).toBeInTheDocument()

    await user.click(within(tabs).getByRole('button', { name: 'Flutter' }))
    expect(code('Terminal')).toContain('flutter pub add kissmyapps')
    expect(code('Dart')).toContain("KissMyApps.start('kma_pk_live_xXSXRWuFNMSSr8ssfpyRbC8')")
    expect(code('Dart')).toContain('navigatorObservers: [KissMyAppsObserver()]')

    await user.click(within(tabs).getByRole('button', { name: 'HTTP' }))
    expect(screen.getByRole('heading', { name: 'Send events over HTTP' })).toBeInTheDocument()
  })

  it('opens the install steps on the platform an app-only project chose', async () => {
    signedInAs('owner')
    const androidOnly = { ...project, platforms: ['android'] as Project['platforms'] }
    fake.state.handlers.analytics_project_settings = () => ({
      project: androidOnly,
      role: 'owner',
      keys: [clientKey],
    })
    fake.state.handlers.analytics_project_status = () => ({
      events_total: 3,
      last_event_at: '2026-10-30T10:20:00Z',
      sources: [],
    })
    const withAndroid = (): Context => ({
      ...context(),
      workspaces: [{ ...context().workspaces[0], projects: [androidOnly] }],
    })
    fake.state.handlers.analytics_bootstrap = withAndroid
    fake.state.handlers.analytics_context = withAndroid
    window.location.hash = '#p/proj-1/settings/install'
    render(<MerchantApp />)
    expect(
      await screen.findByRole('heading', { name: '2. Start it in your Application class' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Events are getting through\. Waiting for the first app session/),
    ).toBeInTheDocument()
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

describe('funnels', () => {
  const finishedIn = (panel: HTMLElement) =>
    within(panel).queryByText('Finished')?.parentElement?.querySelector('strong')?.textContent
  const steps: FunnelStep[] = [
    { kind: 'screen', match: 'is', value: '/pricing' },
    { kind: 'event', event: 'signup_started' },
    { kind: 'event', event: 'purchase', filter: { property: 'plan', value: 'annual' } },
  ]
  const saved: Funnel = {
    id: 'funnel-1',
    name: 'Pricing to purchase',
    steps,
    window_seconds: 86400,
    created_at: '2026-10-29T09:00:00Z',
    updated_at: '2026-10-29T09:00:00Z',
    created_by: 'Victory Onorhime',
  }
  // 10 start, 6 reach step 2, 3 finish: 40% stop after step 1 and 50% after step 2.
  const report = (counts = [10, 6, 3]): FunnelReport => ({
    range: {
      key: '30d',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-30T10:00:00Z',
      bucket: 'day',
      timezone: 'Africa/Lagos',
    },
    window_seconds: 86400,
    steps: counts.map((people, at) => ({
      index: at + 1,
      step: steps[at] ?? { kind: 'event', event: 'purchase' },
      people,
      from_start: people / counts[0],
      from_previous: at ? people / counts[at - 1] : null,
      dropped: at < counts.length - 1 ? people - counts[at + 1] : null,
      median_seconds: at ? 90 : null,
    })),
    started: counts[0],
    converted: counts[counts.length - 1],
    series: [
      { start: '2026-10-29T00:00:00Z', partial: false, started: 6, converted: 2 },
      { start: '2026-10-30T00:00:00Z', partial: true, started: 4, converted: 1 },
    ],
    breakdown: [
      { key: 'mobile', steps: [6, 2, 1] },
      { key: 'desktop', steps: [4, 4, 2] },
    ],
    other_groups: 0,
  })

  it('builds a funnel, previews it from past visits and saves it', async () => {
    signedInAs('analyst')
    fake.state.handlers.analytics_funnel_options = () => ({
      events: [{ name: 'purchase', description: 'Paid', last_seen: '2026-10-30T09:00:00Z' }],
      screens: [{ screen: '/pricing', users: 40 }],
      properties: {},
    })
    fake.state.handlers.analytics_funnel_report = () => report([10, 4])
    fake.state.handlers.analytics_save_funnel = (args) => ({
      ...saved,
      id: 'funnel-2',
      name: args.p_name as string,
      steps: args.p_steps as FunnelStep[],
    })
    fake.state.handlers.analytics_funnels = () => []
    window.location.hash = '#p/proj-1/funnels/new'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'New funnel', level: 1 })

    await user.click(screen.getByRole('button', { name: 'Save funnel' }))
    expect(screen.getByText('Name the funnel.')).toBeInTheDocument()
    expect(screen.getAllByText('Enter the address to match.')).toHaveLength(2)
    expect(fake.state.calls.some((call) => call.name === 'analytics_save_funnel')).toBe(false)

    await user.type(screen.getByLabelText('Name'), 'Pricing to purchase')
    await user.type(screen.getByLabelText('Step 1 page or screen'), '/pricing')
    await user.selectOptions(screen.getByLabelText('Step 2 is'), 'event')
    await user.type(screen.getByLabelText('Step 2 event'), 'purchase')
    const preview = (await screen.findByRole('heading', { name: 'Preview' })).closest('section')!
    await waitFor(() => expect(finishedIn(preview)).toBe('40%'))
    const definition = {
      steps: [
        { kind: 'screen', match: 'is', value: '/pricing' },
        { kind: 'event', event: 'purchase' },
      ],
      window_seconds: 86400,
    }
    expect(
      fake.state.calls.filter((call) => call.name === 'analytics_funnel_report').at(-1)?.args,
    ).toEqual({
      p_project: 'proj-1',
      p_definition: definition,
      p_range: '30d',
      p_breakdown: 'device',
    })

    await user.click(screen.getByRole('button', { name: 'Save funnel' }))
    await waitFor(() => expect(window.location.hash).toBe('#p/proj-1/funnels/funnel-2'))
    expect(fake.state.calls.find((call) => call.name === 'analytics_save_funnel')?.args).toEqual({
      p_project: 'proj-1',
      p_funnel: null,
      p_name: 'Pricing to purchase',
      p_steps: definition.steps,
      p_window_seconds: 86400,
    })
  })

  it('shows where people stop, who they are, and the steps for one group', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_funnels = () => [saved]
    fake.state.handlers.analytics_funnel_report = () => report()
    fake.state.handlers.analytics_funnel_people = () => ({
      total: 1,
      people: [
        {
          id: 'person-1',
          distinct_id: 'amaka@example.com',
          user_id: 'amaka@example.com',
          traits: { name: 'Amaka Obi' },
          country: 'NG',
          city: 'Lagos',
          platform: 'web',
          device_type: 'mobile',
          last_seen: '2026-10-30T09:00:00Z',
          at: '2026-10-30T08:00:00Z',
          session_id: 'session-9',
          replay: true,
        },
      ],
    })
    window.location.hash = '#p/proj-1/funnels/funnel-1'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Pricing to purchase', level: 1 })
    const stepsPanel = screen.getByRole('heading', { name: 'Steps' }).closest('section')!
    await waitFor(() => expect(finishedIn(stepsPanel)).toBe('30%'))
    expect(within(stepsPanel).getByText('Step 2')).toBeInTheDocument()
    expect(within(stepsPanel).getByText('50%, the biggest drop')).toBeInTheDocument()
    expect(within(stepsPanel).getByText('plan')).toBeInTheDocument()

    await user.click(within(stepsPanel).getByRole('button', { name: '3 people stopped here' }))
    const people = (await screen.findByRole('heading', { name: /stopped after step 2/ })).closest(
      'section',
    )!
    expect(await within(people).findByText('Amaka Obi')).toBeInTheDocument()
    expect(within(people).getByRole('link', { name: 'Watch replay' })).toHaveAttribute(
      'href',
      '#p/proj-1/sessions/session-9',
    )
    expect(
      fake.state.calls.find((call) => call.name === 'analytics_funnel_people')?.args,
    ).toMatchObject({ p_step: 2, p_outcome: 'dropped', p_breakdown: 'none', p_group: null })

    const groups = screen.getByRole('heading', { name: 'Who finishes' }).closest('section')!
    await user.click(within(groups).getByRole('button', { name: 'Phone' }))
    expect(screen.getByRole('heading', { name: 'Steps for Phone' })).toBeInTheDocument()
    expect(finishedIn(stepsPanel)).toBe('17%')
    await user.click(within(stepsPanel).getByRole('button', { name: '4 people stopped here' }))
    await waitFor(() =>
      expect(
        fake.state.calls.filter((call) => call.name === 'analytics_funnel_people').at(-1)?.args,
      ).toMatchObject({
        p_step: 1,
        p_outcome: 'dropped',
        p_breakdown: 'device',
        p_group: 'mobile',
      }),
    )
  })

  it('offers the first funnel where the list will be', async () => {
    signedInAs('analyst')
    fake.state.handlers.analytics_funnels = () => []
    window.location.hash = '#p/proj-1/funnels'
    render(<MerchantApp />)
    expect(await screen.findByRole('link', { name: 'Build your first funnel' })).toHaveAttribute(
      'href',
      '#p/proj-1/funnels/new',
    )
  })
})

describe('retention', () => {
  const cohort = (start: string, people: number, values: Array<number | null>, partial = -1) => ({
    start,
    people,
    values: values.map((count, at) => ({
      period: at + 1,
      state: (count === null ? 'future' : at === partial ? 'partial' : 'complete') as
        'future' | 'partial' | 'complete',
      people: count,
    })),
  })
  const report = (interval: 'day' | 'week' = 'day'): RetentionReport => ({
    definition: { interval, start: { kind: 'first_seen' }, return: { kind: 'any' } },
    timezone: 'Africa/Lagos',
    today: '2026-10-30',
    periods: 3,
    started: 18,
    headline: [
      { day: 1, people: 15, returned: 4 },
      { day: 7, people: 0, returned: 0 },
      { day: 30, people: 0, returned: 0 },
    ],
    cohorts: [
      // Before anyone started: left off the table.
      cohort('2026-10-26', 0, [0, 0, 0]),
      cohort('2026-10-27', 10, [4, 2, 1], 2),
      cohort('2026-10-28', 5, [0, 1, null], 1),
      cohort('2026-10-29', 0, [0, null, null], 0),
      cohort('2026-10-30', 3, [null, null, null]),
    ],
    curve: [
      { period: 1, people: 15, returned: 4 },
      { period: 2, people: 10, returned: 2 },
      { period: 3, people: 0, returned: 0 },
    ],
    breakdown: [
      {
        key: 'mobile',
        people: 12,
        values: [
          { period: 1, people: 10, returned: 3 },
          { period: 2, people: 6, returned: 2 },
          { period: 3, people: 0, returned: 0 },
        ],
      },
    ],
    other_groups: 1,
  })
  const lastCall = (name: string) =>
    fake.state.calls.filter((call) => call.name === name).at(-1)?.args

  it('shows who comes back, lists the people behind a number, and regroups', async () => {
    signedInAs('analyst')
    fake.state.handlers.analytics_funnel_options = () => ({
      events: [{ name: 'signed_up', description: null, last_seen: '2026-10-30T09:00:00Z' }],
      screens: [],
      properties: {},
    })
    fake.state.handlers.analytics_retention_report = (args) =>
      report((args.p_definition as RetentionReport['definition']).interval as 'day' | 'week')
    fake.state.handlers.analytics_retention_people = () => ({
      total: 1,
      people: [
        {
          id: 'person-1',
          distinct_id: 'amaka@example.com',
          user_id: 'amaka@example.com',
          traits: { name: 'Amaka Obi' },
          country: 'NG',
          city: 'Lagos',
          platform: 'ios',
          device_type: 'mobile',
          started_at: '2026-10-27T08:00:00Z',
          last_seen: '2026-10-30T09:00:00Z',
          days_back: 3,
        },
      ],
    })
    window.location.hash = '#p/proj-1/retention'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Retention', level: 1 })
    const headline = await screen.findByRole('group', { name: 'Back after 1, 7 and 30 days' })
    expect(await within(headline).findByText('27%')).toBeInTheDocument()
    expect(within(headline).getByText('4 of 15 people')).toBeInTheDocument()
    expect(within(headline).getByText('Nobody has reached day 7 yet')).toBeInTheDocument()
    expect(lastCall('analytics_retention_report')).toEqual({
      p_project: 'proj-1',
      p_definition: { interval: 'day', start: { kind: 'first_seen' }, return: { kind: 'any' } },
      p_breakdown: 'none',
    })

    const table = screen.getByRole('region', { name: 'Who came back' })
    expect(within(table).getByRole('rowheader', { name: 'Tue, Oct 27' })).toBeInTheDocument()
    expect(within(table).queryByRole('rowheader', { name: 'Mon, Oct 26' })).toBeNull()
    expect(
      within(table).getByRole('button', { name: '10%: 1 of 10 people back on day 3 so far' }),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: '27%: 4 of 15 people back on day 1' }),
    ).toBeInTheDocument()

    await user.click(
      within(table).getByRole('button', { name: '40%: 4 of 10 people back on day 1' }),
    )
    const people = (
      await screen.findByRole('heading', {
        name: '1 person who started on Tue, Oct 27 and came back on day 1',
      })
    ).closest('section')!
    expect(await within(people).findByText('Amaka Obi')).toBeInTheDocument()
    expect(within(people).getByText('3 days')).toBeInTheDocument()
    expect(lastCall('analytics_retention_people')).toEqual({
      p_project: 'proj-1',
      p_definition: { interval: 'day', start: { kind: 'first_seen' }, return: { kind: 'any' } },
      p_cohort: '2026-10-27',
      p_period: 1,
      p_breakdown: 'none',
      p_group: null,
      p_offset: 0,
    })

    await user.selectOptions(screen.getByLabelText('Rows'), 'device')
    await screen.findByRole('heading', { name: 'Who came back, by device' })
    expect(screen.queryByText('Amaka Obi')).toBeNull()
    const grouped = screen.getByRole('region', { name: 'Who came back' })
    expect(within(grouped).getByRole('rowheader', { name: 'Phone' })).toBeInTheDocument()
    expect(screen.getByText(/1 smaller group not shown/)).toBeInTheDocument()
    await user.click(
      within(grouped).getByRole('button', { name: '30%: 3 of 10 people back on day 1' }),
    )
    await waitFor(() =>
      expect(lastCall('analytics_retention_people')).toMatchObject({
        p_cohort: null,
        p_period: 1,
        p_breakdown: 'device',
        p_group: 'mobile',
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Weeks' }))
    await user.selectOptions(screen.getByLabelText('When people start'), 'signed_up')
    await waitFor(() =>
      expect(lastCall('analytics_retention_report')).toEqual({
        p_project: 'proj-1',
        p_definition: {
          interval: 'week',
          start: { kind: 'event', event: 'signed_up' },
          return: { kind: 'any' },
        },
        p_breakdown: 'device',
      }),
    )
  })

  it('says so when nobody has started yet', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_funnel_options = () => ({
      events: [],
      screens: [],
      properties: {},
    })
    fake.state.handlers.analytics_retention_report = () => ({
      ...report(),
      started: 0,
      cohorts: [cohort('2026-10-30', 0, [null, null, null])],
      curve: [],
      breakdown: [],
      other_groups: 0,
    })
    window.location.hash = '#p/proj-1/retention'
    render(<MerchantApp />)
    expect(await screen.findByText(/Nobody was first seen in this window yet/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Who came back' })).toBeNull()
  })

  it('puts day 7 on the overview, linked to the retention page', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/overview'
    render(<MerchantApp />)
    const link = await screen.findByRole('link', { name: /Back on day 7/ })
    expect(link).toHaveAttribute('href', '#p/proj-1/retention')
    expect(await within(link).findByText('13%')).toBeInTheDocument()
    expect(within(link).getByText('of 64 people first seen Sep 23 to Oct 22')).toBeInTheDocument()
  })
})

describe('city location', () => {
  const range = { key: '7d' as const, from: overview.range.from, to: overview.range.to }
  const nigeria: Places = {
    range,
    country: 'NG',
    users: 700,
    unknown_region: 20,
    unknown_city: 40,
    regions: [
      { key: 'Lagos', users: 500 },
      { key: 'Federal Capital Territory', users: 160 },
    ],
    cities: [
      { key: 'Ikeja', region: 'Lagos', country: 'NG', users: 300 },
      { key: 'Lagos', region: 'Lagos', country: 'NG', users: 200 },
      { key: 'Abuja', region: 'Federal Capital Territory', country: 'NG', users: 160 },
    ],
  }
  const everywhere: Places = {
    ...nigeria,
    country: null,
    users: 1236,
    unknown_city: 80,
    regions: [],
    cities: [
      ...nigeria.cities,
      { key: 'Springfield', region: 'Illinois', country: 'US', users: 5 },
      { key: 'Springfield', region: 'Missouri', country: 'US', users: 3 },
    ],
  }

  it('opens a country into its cities and regions, each leading to the people there', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_places = (args) => (args.p_country ? nigeria : everywhere)
    window.location.hash = '#p/proj-1/overview'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const where = (await screen.findByRole('heading', { name: 'Where they are' })).closest(
      'section',
    )!
    // Places load only when asked for.
    expect(fake.state.calls.some((call) => call.name === 'analytics_places')).toBe(false)
    await user.click(within(where).getByRole('button', { name: /Nigeria\s*700/ }))

    expect(await within(where).findByRole('heading', { name: 'Nigeria', level: 3 })).toHaveFocus()
    expect(fake.state.calls.find((call) => call.name === 'analytics_places')?.args).toEqual({
      p_project: 'proj-1',
      p_range: '7d',
      p_country: 'NG',
    })
    expect(await within(where).findByRole('link', { name: /^Ikeja\s*Lagos/ })).toHaveAttribute(
      'href',
      '#p/proj-1/users?range=7d&country=NG&region=Lagos&city=Ikeja',
    )
    // Shares are of the country's people; a city named like its region shows once.
    expect(within(where).getByRole('link', { name: /^Ikeja/ })).toHaveTextContent('300 · 43%')
    expect(within(where).getByRole('link', { name: /^Lagos200/ })).toBeInTheDocument()
    expect(within(where).getByRole('link', { name: 'See 700 users' })).toHaveAttribute(
      'href',
      '#p/proj-1/users?range=7d&country=NG',
    )
    expect(within(where).getByText('40 users in Nigeria without a known city.')).toBeInTheDocument()

    await user.click(within(where).getByRole('button', { name: 'Regions' }))
    expect(within(where).getByRole('link', { name: /^Federal Capital Territory/ })).toHaveAttribute(
      'href',
      '#p/proj-1/users?range=7d&country=NG&region=Federal+Capital+Territory',
    )

    await user.click(within(where).getByRole('button', { name: 'All countries' }))
    expect(within(where).getByRole('button', { name: /Nigeria\s*700/ })).toHaveFocus()

    await user.click(within(where).getByRole('button', { name: 'Cities' }))
    expect(await within(where).findByRole('link', { name: /^Ikeja, Nigeria/ })).toBeInTheDocument()
    // Two cities of one name in a country are told apart by their regions.
    expect(
      within(where).getByRole('link', { name: /^Springfield, Illinois, United States/ }),
    ).toBeInTheDocument()
    expect(within(where).getByText('80 users without a known city.')).toBeInTheDocument()
  })

  it('filters the Users list by a region or city within the country', async () => {
    signedInAs('owner')
    fake.state.handlers.analytics_people_page = () => ({
      total: 1,
      range: overview.range,
      facets: {
        platforms: ['ios'],
        countries: ['NG', 'GB'],
        places: [
          { region: 'Lagos', city: 'Ikeja' },
          { region: 'Lagos', city: 'Lagos' },
          { region: null, city: 'Ota' },
        ],
      },
      rows: [person({ city: 'Ikeja' })],
    })
    window.location.hash = '#p/proj-1/users?range=7d&country=NG&region=Lagos&city=Ikeja'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const choice = await screen.findByRole('combobox', { name: 'Region or city' })
    expect(choice).toHaveValue(JSON.stringify(['Lagos', 'Ikeja']))
    const first = fake.state.calls.find((call) => call.name === 'analytics_people_page')!
    expect(first.args.p_query).toMatchObject({
      range: '7d',
      country: 'NG',
      region: 'Lagos',
      city: 'Ikeja',
    })

    await user.selectOptions(choice, 'All of Lagos')
    await waitFor(() =>
      expect(
        fake.state.calls.filter((call) => call.name === 'analytics_people_page').at(-1)!.args
          .p_query,
      ).toMatchObject({ country: 'NG', region: 'Lagos', city: undefined }),
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Country' }), 'United Kingdom')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Region or city' })).toHaveValue(''),
    )
    const last = fake.state.calls.filter((call) => call.name === 'analytics_people_page').at(-1)!
    expect(last.args.p_query).toMatchObject({ country: 'GB', region: undefined, city: undefined })
  })

  it("lists a country's regions with their cities, then cities with no known region", () => {
    const options = placeOptions(
      'NG',
      [
        { region: 'Lagos', city: 'Lagos' },
        { region: 'Lagos', city: 'Ikeja' },
        { region: 'Federal Capital Territory', city: 'Abuja' },
        { region: null, city: 'Ota' },
      ],
      [null, null],
    )
    expect(options.map((option) => [option.group ?? '', option.label])).toEqual([
      ['', 'All of Nigeria'],
      ['Federal Capital Territory', 'All of Federal Capital Territory'],
      ['Federal Capital Territory', 'Abuja'],
      ['Lagos', 'All of Lagos'],
      ['Lagos', 'Ikeja'],
      ['Lagos', 'Lagos'],
      ['Region not known', 'Ota'],
    ])
    // A place chosen from a link stays listed before the page that names it arrives.
    expect(placeOptions('NG', [], ['Kano', 'Kano']).map((option) => option.label)).toEqual([
      'All of Nigeria',
      'All of Kano',
      'Kano',
    ])
  })

  it('shows the whole place on a profile, and credits DB-IP', async () => {
    signedInAs('owner')
    const detail: PersonDetail = {
      person: person({ city: 'Ikeja' }),
      override: null,
      stats: {
        sessions: 0,
        total_seconds: 0,
        avg_seconds: 0,
        replays: 0,
        countries: ['NG'],
        devices: [],
        bot_sessions: 0,
      },
      sessions: [],
      top_events: [],
      recent_events: [],
    }
    fake.state.handlers.analytics_person = () => detail
    window.location.hash = '#p/proj-1/users/person-1'
    render(<MerchantApp />)
    const where = (await screen.findByRole('heading', { name: 'Where' })).closest('section')!
    expect(await within(where).findByText('Ikeja, Lagos, Nigeria')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'IP geolocation by DB-IP' })).toHaveAttribute(
      'href',
      'https://db-ip.com',
    )
  })
})

describe('attribution', () => {
  const root = 'go.kissmyapps.dev'
  const settings = (overrides: Partial<AttributionSettings> = {}): AttributionSettings => ({
    ios_app_store_id: null,
    ios_bundle_id: null,
    ios_team_id: null,
    android_package: null,
    android_sha256: [],
    web_url: 'https://speaksix.app/',
    click_lookback_days: 7,
    view_through_enabled: false,
    view_lookback_hours: 24,
    reengagement_days: 30,
    reattribution_days: 90,
    currency: 'USD',
    conversion_events: [],
    web_lookback_days: 30,
    enabled_at: '2026-11-03T09:00:00Z',
    disabled_at: null,
    updated_at: '2026-11-03T09:00:00Z',
    ...overrides,
  })
  const domain = (host: string, overrides: Partial<AttributionDomain> = {}): AttributionDomain => ({
    id: `domain-${host}`,
    host,
    kind: host.endsWith(`.${root}`) ? 'kma' : 'custom',
    status: host.endsWith(`.${root}`) ? 'live' : 'waiting',
    verified_at: null,
    last_seen_at: null,
    created_at: '2026-11-03T09:00:00Z',
    ...overrides,
  })
  // What the database answers, worked out from the settings the way it does.
  const viewOf = (
    current: Pick<Attribution, 'enabled' | 'ever_enabled' | 'settings' | 'domains'> &
      Partial<Pick<Attribution, 'events'>>,
  ): Attribution => {
    const s = current.settings
    return {
      project_id: 'proj-1',
      link_root: root,
      cname_target: `cname.${root}`,
      events: [],
      ...current,
      setup: {
        apps: Boolean(s?.ios_app_store_id && s.ios_bundle_id && s.ios_team_id && s.web_url),
        domain: Boolean(s),
        sdk: false,
        conversions: Boolean(s?.conversion_events.length),
        partners: false,
        skan: false,
      },
    }
  }
  let view: Attribution
  const calls = (name: string) => fake.state.calls.filter((call) => call.name === name)

  beforeEach(() => {
    view = viewOf({ enabled: false, ever_enabled: false, settings: null, domains: [] })
    fake.state.handlers.attribution_get = () => view
    fake.state.handlers.attribution_check_subdomain = ({ p_subdomain }) => ({
      subdomain: p_subdomain,
      host: `${p_subdomain}.${root}`,
      available: p_subdomain !== 'taken',
      reason:
        p_subdomain === 'taken' ? 'Another project already uses that name. Try another.' : null,
    })
    fake.state.handlers.attribution_enable = ({ p_subdomain }) => {
      view = viewOf({
        enabled: true,
        ever_enabled: true,
        settings: view.settings ?? settings(),
        domains: view.domains.length ? view.domains : [domain(`${p_subdomain}.${root}`)],
      })
      return view
    }
    fake.state.handlers.attribution_disable = () => {
      view = viewOf({ ...view, enabled: false })
      return view
    }
    fake.state.handlers.attribution_update = ({ p_patch }) => {
      const patch = { ...(p_patch as Partial<AttributionSettings>) }
      if (patch.ios_app_store_id) patch.ios_app_store_id = patch.ios_app_store_id.replace(/^id/, '')
      if (patch.ios_team_id) patch.ios_team_id = patch.ios_team_id.toUpperCase()
      view = viewOf({ ...view, settings: { ...view.settings!, ...patch } })
      return view
    }
    fake.state.handlers.attribution_add_domain = ({ p_host }) => {
      view = viewOf({ ...view, domains: [...view.domains, domain(p_host as string)] })
      return view
    }
    fake.state.handlers.attribution_remove_domain = ({ p_domain }) => {
      view = viewOf({ ...view, domains: view.domains.filter((item) => item.id !== p_domain) })
      return view
    }
  })

  const turnedOn = (overrides: Partial<AttributionSettings> = {}) => {
    view = viewOf({
      enabled: true,
      ever_enabled: true,
      settings: settings(overrides),
      domains: [domain(`speaksix.${root}`)],
    })
  }

  it('makes a link address from the project name, and app snippets from its domains', () => {
    expect(suggestedSubdomain('SpeakSix')).toBe('speaksix')
    expect(suggestedSubdomain('Café Olé!  Lagos')).toBe('cafe-ole-lagos')
    expect(suggestedSubdomain('AB')).toBe('')
    expect(fingerprintList('AB:CD\n\n ef01 , 23')).toEqual(['AB:CD', 'ef01', '23'])
    expect(androidIntentFilter(['a.example', 'b.example'])).toContain(
      '<data android:host="b.example" />',
    )
  })

  it('turns attribution on with a free link address', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Turn on attribution for SpeakSix' })
    const address = screen.getByLabelText('Link address')
    expect(address).toHaveValue('speaksix')
    expect(await screen.findByText(/is free/)).toHaveTextContent(`speaksix.${root} is free.`)

    await user.clear(address)
    await user.type(address, 'taken')
    expect(
      await screen.findByText('Another project already uses that name. Try another.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on attribution' })).toBeDisabled()

    await user.clear(address)
    await user.type(address, 'speaksix')
    await screen.findByText(/is free/)
    await user.click(screen.getByRole('button', { name: 'Turn on attribution' }))
    await screen.findByRole('heading', { name: 'Your apps and website' })
    expect(calls('attribution_enable').at(-1)?.args).toEqual({
      p_project: 'proj-1',
      p_subdomain: 'speaksix',
    })
    expect(screen.getByText('Attribution is on')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings', current: false })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/settings',
    )
  })

  it('describes the apps, checks them first, and shows what the address answers', async () => {
    signedInAs('owner')
    turnedOn()
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Your apps and website' })
    // The project lists web and iOS, so there is nothing to fill in for Android.
    expect(screen.queryByText('Android app')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 3 steps done')).toBeInTheDocument()

    await user.type(screen.getByLabelText('App Store ID'), 'id1234567890')
    await user.type(screen.getByLabelText('Bundle ID'), 'app.speaksix.ios')
    await user.type(screen.getByLabelText('Team ID'), 'ABC')
    await user.click(screen.getByRole('button', { name: 'Save apps and website' }))
    expect(screen.getByText('A Team ID is 10 letters and numbers.')).toBeInTheDocument()
    expect(calls('attribution_update')).toHaveLength(0)

    await user.clear(screen.getByLabelText('Team ID'))
    await user.type(screen.getByLabelText('Team ID'), 'abcde12345')
    await user.click(screen.getByRole('button', { name: 'Save apps and website' }))
    await screen.findByText('Apps and website saved')
    expect(calls('attribution_update')[0].args.p_patch).toEqual({
      ios_app_store_id: 'id1234567890',
      ios_bundle_id: 'app.speaksix.ios',
      ios_team_id: 'abcde12345',
    })
    expect(await screen.findByLabelText('Associated Domains')).toHaveTextContent(
      `applinks:speaksix.${root}`,
    )
    const rail = screen.getByRole('complementary', { name: 'What your link domain answers' })
    expect(within(rail).getByText('ABCDE12345.app.speaksix.ios')).toBeInTheDocument()
    expect(within(rail).getByRole('link', { name: /View the Apple file/ })).toHaveAttribute(
      'href',
      `https://speaksix.${root}/.well-known/apple-app-site-association`,
    )
    expect(screen.getByText('2 of 3 steps done')).toBeInTheDocument()
  })

  it('adds a domain of its own and says how to point it here', async () => {
    signedInAs('developer')
    turnedOn()
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const field = await screen.findByLabelText('Your own domain')
    await user.type(field, 'speaksix')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(screen.getByText('Enter a domain such as go.yourbrand.com.')).toBeInTheDocument()
    expect(calls('attribution_add_domain')).toHaveLength(0)

    await user.clear(field)
    await user.type(field, 'https://Go.SpeakSix.app/start')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    const row = (await screen.findByText('go.speaksix.app', { selector: '.mc-truncate' })).closest(
      'li',
    )!
    expect(calls('attribution_add_domain')[0].args).toEqual({
      p_project: 'proj-1',
      p_host: 'go.speaksix.app',
    })
    expect(within(row).getByText('Waiting')).toBeInTheDocument()
    expect(within(row).getByText(/add a CNAME record for/)).toBeInTheDocument()
    expect(
      within(row).getByText(`cname.${root}`, { selector: '.mc-key-value' }),
    ).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: /Open go.speaksix.app/ })).toHaveAttribute(
      'href',
      'https://go.speaksix.app/',
    )

    await user.click(within(row).getByRole('button', { name: 'Remove go.speaksix.app' }))
    await waitFor(() =>
      expect(screen.queryByText('go.speaksix.app', { selector: '.mc-truncate' })).toBeNull(),
    )
    // The KissMyApps address cannot be removed.
    expect(
      screen.queryByRole('button', { name: `Remove speaksix.${root}` }),
    ).not.toBeInTheDocument()
  })

  it('lets analysts look but not change anything', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution'
    const { unmount } = render(<MerchantApp />)
    expect(
      await screen.findByText('Only a workspace owner or admin can turn attribution on.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on attribution' })).not.toBeInTheDocument()
    unmount()

    turnedOn()
    render(<MerchantApp />)
    expect(await screen.findByLabelText('Bundle ID')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save apps and website' })).toBeNull()
    expect(screen.queryByLabelText('Your own domain')).toBeNull()
    window.location.hash = '#p/proj-1/attribution/settings'
    expect(await screen.findByLabelText('Click window, in days')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Turn off attribution' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename address' })).toBeNull()
  })

  it('saves the windows, then turns attribution off and on again with everything kept', async () => {
    signedInAs('owner')
    turnedOn()
    window.location.hash = '#p/proj-1/attribution/settings'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Attribution settings', level: 1 })
    const clicks = screen.getByLabelText('Click window, in days')
    await user.clear(clicks)
    await user.type(clicks, '40')
    await user.click(screen.getByRole('button', { name: 'Save windows' }))
    expect(screen.getByText('The click window is 1 to 30 days.')).toBeInTheDocument()
    await user.clear(clicks)
    await user.type(clicks, '14')
    await user.click(screen.getByRole('checkbox', { name: /Count ad views/ }))
    await user.click(screen.getByRole('button', { name: 'Save windows' }))
    await screen.findByText('Attribution windows saved')
    expect(calls('attribution_update')[0].args.p_patch).toEqual({
      view_through_enabled: true,
      click_lookback_days: 14,
      view_lookback_hours: 24,
      reengagement_days: 30,
      reattribution_days: 90,
    })

    const rename = screen.getByLabelText('Link address')
    await user.clear(rename)
    await user.type(rename, 'speak6')
    expect(
      screen.getByText(new RegExp(`Links on speaksix.${root} stop working`)),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Turn off attribution' }))
    await user.click(screen.getByRole('button', { name: 'Turn off' }))
    await screen.findByRole('heading', { name: 'Attribution is off for SpeakSix' })
    expect(calls('attribution_disable')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Turn attribution on again' }))
    expect(await screen.findByLabelText('Click window, in days')).toHaveValue(14)
    expect(calls('attribution_enable').at(-1)?.args.p_subdomain).toBeNull()
  })

  it('names sources, suggests link addresses and adds one-off settings to a link', async () => {
    expect(suggestedPath('October launch on TikTok!')).toBe('october-launch-on-tiktok')
    expect(suggestedPath('Café — Lagos')).toBe('cafe-lagos')
    expect(sourceLabel(null)).toBe('Direct or unknown')
    expect(sourceLabel('google_ads')).toBe('Google Ads')
    expect(sourceLabel('newsletter')).toBe('newsletter')
    expect(
      linkWithOverrides(`https://speaksix.${root}/tiktok`, { cmp: 'oct launch', ad: ' ' }),
    ).toBe(`https://speaksix.${root}/tiktok?cmp=oct+launch`)
    expect(await qrDataUrl(`https://speaksix.${root}/tiktok`)).toMatch(/^data:image\/png;base64,/)
  })

  describe('links', () => {
    let links: AttributionLink[]
    const linkOf = (fields: Partial<AttributionLink>): AttributionLink => ({
      id: `link-${links.length + 1}`,
      path: 'k3x9p2a',
      url: null,
      name: '',
      source: '',
      campaign: null,
      channel: null,
      adset: null,
      ad: null,
      deep_link_value: null,
      deep_link_params: {},
      web_url: null,
      ios_url: null,
      android_url: null,
      social_title: null,
      social_description: null,
      social_image: null,
      status: 'active',
      created_at: '2026-11-03T09:00:00Z',
      updated_at: '2026-11-03T09:00:00Z',
      clicks: 0,
      visits: 0,
      conversions: 0,
      ...fields,
    })

    beforeEach(() => {
      links = []
      fake.state.handlers.attribution_links = ({ p_range }) => ({
        range: p_range,
        host: `speaksix.${root}`,
        hosts: [`speaksix.${root}`],
        links,
      })
      fake.state.handlers.attribution_save_link = ({ p_link, p_fields }) => {
        const fields = p_fields as Record<string, string>
        const empty = (value: string | undefined) => (value ? value : null)
        if (p_link) {
          links = links.map((link) => (link.id === p_link ? { ...link, ...fields } : link))
          return links.find((link) => link.id === p_link)
        }
        const path = fields.path || 'k3x9p2a'
        const link = linkOf({
          path,
          url: `https://speaksix.${root}/${path}`,
          name: fields.name,
          source: fields.source.toLowerCase(),
          campaign: empty(fields.campaign),
          ad: empty(fields.ad),
        })
        links = [link, ...links]
        return link
      }
      fake.state.handlers.attribution_set_link_status = ({ p_link, p_status }) => {
        links = links.map((link) =>
          link.id === p_link ? { ...link, status: p_status as AttributionLink['status'] } : link,
        )
        return links.find((link) => link.id === p_link)
      }
    })

    it('makes a link, checks it first, and opens it for sharing', async () => {
      signedInAs('developer')
      turnedOn({ ios_app_store_id: '1234567890' })
      window.location.hash = '#p/proj-1/attribution/links'
      const user = userEvent.setup()
      render(<MerchantApp />)
      await screen.findByRole('heading', { name: 'Links', level: 1 })
      expect(await screen.findByText(/No links yet/)).toBeInTheDocument()
      expect(calls('attribution_links')[0].args).toEqual({ p_project: 'proj-1', p_range: '30d' })

      await user.click(screen.getByRole('button', { name: 'New link' }))
      await screen.findByRole('heading', { name: 'New link' })
      await user.type(screen.getByLabelText('Name'), 'October launch on TikTok')
      // The address follows the name until it is changed by hand.
      expect(screen.getByLabelText('Address')).toHaveValue('october-launch-on-tiktok')
      expect(screen.getByLabelText('iPhone')).toHaveAttribute(
        'placeholder',
        'https://apps.apple.com/app/id1234567890',
      )
      // The project has no Android app, so there is nowhere to send Android phones.
      expect(screen.queryByLabelText('Android')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Make link' }))
      expect(
        screen.getByText('Name the source in letters, numbers and _ . -, such as tiktok.'),
      ).toBeInTheDocument()
      expect(calls('attribution_save_link')).toHaveLength(0)

      await user.type(screen.getByLabelText('Media source'), 'TikTok')
      await user.type(screen.getByLabelText('Campaign'), 'october_launch')
      await user.type(screen.getByLabelText('Website page'), 'http://speaksix.app/start')
      await user.click(screen.getByRole('button', { name: 'Make link' }))
      expect(screen.getByText('Use an address that starts with https://.')).toBeInTheDocument()
      await user.clear(screen.getByLabelText('Website page'))
      await user.click(screen.getByRole('button', { name: 'Make link' }))

      const dialog = await screen.findByRole('dialog', { name: 'Share October launch on TikTok' })
      const fields = calls('attribution_save_link')[0].args
      expect(fields.p_link).toBeNull()
      expect(fields.p_fields).toMatchObject({
        name: 'October launch on TikTok',
        path: 'october-launch-on-tiktok',
        source: 'TikTok',
        campaign: 'october_launch',
        web_url: '',
      })
      const url = `https://speaksix.${root}/october-launch-on-tiktok`
      expect(within(dialog).getByText(url)).toBeInTheDocument()
      expect(
        await within(dialog).findByRole('img', { name: `QR code for ${url}` }),
      ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
      expect(within(dialog).getByRole('link', { name: /Download QR code/ })).toHaveAttribute(
        'download',
        'october-launch-on-tiktok-qr.png',
      )
      await user.click(within(dialog).getByText('Set the campaign or ad for one use'))
      await user.type(within(dialog).getByLabelText('Ad'), 'video_2')
      expect(within(dialog).getByText(`${url}?ad=video_2`)).toBeInTheDocument()
      await user.click(within(dialog).getByRole('button', { name: 'Close' }))

      const row = screen.getByText('October launch on TikTok').closest('tr')!
      expect(within(row).getByText('TikTok')).toBeInTheDocument()
      expect(within(row).getByText('october_launch')).toBeInTheDocument()
      await user.click(within(row).getByRole('button', { name: 'Pause October launch on TikTok' }))
      expect(await within(row).findByText('Paused')).toBeInTheDocument()
      expect(calls('attribution_set_link_status')[0].args).toEqual({
        p_link: 'link-1',
        p_status: 'paused',
      })
    })

    it('shows links to analysts without ways to change them', async () => {
      signedInAs('analyst')
      turnedOn()
      links = [
        linkOf({ name: 'Bio link', source: 'instagram', url: `https://speaksix.${root}/bio` }),
      ]
      window.location.hash = '#p/proj-1/attribution/links'
      render(<MerchantApp />)
      const row = (await screen.findByText('Bio link')).closest('tr')!
      expect(within(row).getByText('Instagram')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'QR code for Bio link' })).toBeInTheDocument()
      expect(within(row).queryByRole('button', { name: 'Edit Bio link' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'New link' })).toBeNull()
    })
  })

  describe('sources', () => {
    const report = (
      source: string | null,
      model: string,
      rows: AttributionSources['rows'],
      events = ['sign_up'],
    ): AttributionSources => ({
      range: '30d',
      model: model as AttributionSources['model'],
      source,
      conversion_events: events,
      web_lookback_days: 30,
      totals: {
        clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
        visits: rows.reduce((sum, row) => sum + row.visits, 0),
        people: 40,
        conversions: rows.reduce((sum, row) => sum + row.conversions, 0),
        converters: 10,
      },
      rows,
    })
    const row = (key: string | null, visits: number, conversions: number) => ({
      key,
      clicks: key === 'tiktok' ? 30 : 0,
      visits,
      people: visits,
      conversions,
      converters: conversions,
    })

    it('credits sources, opens one to see its campaigns, and switches the model', async () => {
      signedInAs('owner')
      turnedOn({ conversion_events: ['sign_up'] })
      fake.state.handlers.attribution_sources = ({ p_source, p_model }) =>
        p_source === 'tiktok'
          ? report('tiktok', p_model as string, [row('october_launch', 20, 4), row(null, 2, 1)])
          : report(null, p_model as string, [
              row('tiktok', 22, 5),
              row('google_ads', 8, 2),
              row(null, 10, 3),
            ])
      window.location.hash = '#p/proj-1/attribution/sources'
      const user = userEvent.setup()
      render(<MerchantApp />)
      const tiktok = await screen.findByRole('button', { name: 'TikTok: see its campaigns' })
      expect(calls('attribution_sources')[0].args).toEqual({
        p_project: 'proj-1',
        p_range: '30d',
        p_model: 'last',
        p_source: null,
      })
      const totals = screen.getByRole('group', { name: 'Totals' })
      expect(within(totals).getByText('25%')).toBeInTheDocument()
      expect(within(totals).getByText('by 10 people')).toBeInTheDocument()
      const google = screen.getByText('Google Ads').closest('tr')!
      expect(within(google).getByText('From a gclid on the landing page')).toBeInTheDocument()
      // Direct visits have no campaigns to open.
      const direct = screen.getByText('Direct or unknown', { selector: 'td span' }).closest('tr')!
      expect(within(direct).queryByRole('button')).toBeNull()
      expect(screen.queryByText(/No event counts as a conversion/)).toBeNull()

      await user.click(screen.getByRole('button', { name: 'First touch' }))
      await waitFor(() => expect(calls('attribution_sources').at(-1)?.args.p_model).toBe('first'))
      expect(screen.getByText(/the first source the person ever came from/)).toBeInTheDocument()

      await user.click(await screen.findByRole('button', { name: 'TikTok: see its campaigns' }))
      await screen.findByRole('heading', { name: 'Campaigns from TikTok' })
      expect(calls('attribution_sources').at(-1)?.args).toMatchObject({
        p_model: 'first',
        p_source: 'tiktok',
      })
      expect(await screen.findByText('october_launch')).toBeInTheDocument()
      expect(screen.getByText('No campaign')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'All sources' }))
      expect(await screen.findByRole('heading', { name: 'Sources', level: 2 })).toBeInTheDocument()
      expect(tiktok).not.toBeInTheDocument()
    })

    it('says where to choose conversions when none count yet', async () => {
      signedInAs('owner')
      turnedOn()
      fake.state.handlers.attribution_sources = () =>
        report(null, 'last', [row('instagram', 12, 0)], [])
      window.location.hash = '#p/proj-1/attribution/sources'
      render(<MerchantApp />)
      expect(
        await screen.findByRole('link', { name: 'Choose your conversion events in Settings' }),
      ).toHaveAttribute('href', '#p/proj-1/attribution/settings')
      const instagram = screen.getByText('Instagram').closest('tr')!
      expect(within(instagram).getAllByText('—')).toHaveLength(1)
    })
  })

  it('chooses conversion events, including one not seen yet, and the website window', async () => {
    signedInAs('developer')
    turnedOn()
    view = {
      ...view,
      events: [
        { name: 'sign_up', last_seen: '2026-11-03T08:00:00Z' },
        { name: 'purchase', last_seen: '2026-11-02T08:00:00Z' },
      ],
    }
    fake.state.handlers.attribution_set_conversions = ({ p_events, p_web_lookback_days }) => {
      view = viewOf({
        ...view,
        settings: {
          ...view.settings!,
          conversion_events: [...(p_events as string[])].sort(),
          web_lookback_days: p_web_lookback_days as number,
        },
      })
      return view
    }
    window.location.hash = '#p/proj-1/attribution/settings'
    const user = userEvent.setup()
    render(<MerchantApp />)
    await user.click(await screen.findByRole('checkbox', { name: /sign_up/ }))
    expect(screen.getByText('1 of 20 chosen')).toBeInTheDocument()

    const other = screen.getByLabelText('An event not seen yet')
    await user.type(other, '1bad')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(
      screen.getByText('Event names use letters, numbers and _ . : -, starting with a letter.'),
    ).toBeInTheDocument()
    await user.clear(other)
    await user.type(other, 'trial_started{Enter}')
    expect(screen.getByRole('checkbox', { name: /trial_started/ })).toBeChecked()
    expect(screen.getByText('2 of 20 chosen')).toBeInTheDocument()

    const days = screen.getByLabelText('Website window, in days')
    await user.clear(days)
    await user.type(days, '120')
    await user.click(screen.getByRole('button', { name: 'Save conversions' }))
    expect(screen.getByText('The website window is 1 to 90 days.')).toBeInTheDocument()
    expect(calls('attribution_set_conversions')).toHaveLength(0)
    await user.clear(days)
    await user.type(days, '14')
    await user.click(screen.getByRole('button', { name: 'Save conversions' }))
    await screen.findByText('2 conversion events saved')
    expect(calls('attribution_set_conversions')[0].args).toEqual({
      p_project: 'proj-1',
      p_events: ['sign_up', 'trial_started'],
      p_web_lookback_days: 14,
    })
    // An event chosen before it arrives stays listed, marked as not seen.
    const trial = screen.getByRole('checkbox', { name: /trial_started/ }).closest('label')!
    expect(within(trial).getByText('Not seen yet')).toBeInTheDocument()

    window.location.hash = '#p/proj-1/attribution'
    await screen.findByText('2 of 3 steps done')
    const step = screen.getByRole('heading', { name: 'Conversions', level: 2 }).closest('section')!
    expect(within(step).getByText('Done')).toBeInTheDocument()
    expect(within(step).getByRole('checkbox', { name: /sign_up/ })).toBeChecked()
  })
})
