import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { MerchantApp } from './MerchantApp'
import { programAppsBackendFixture as apps } from './program-apps-backend.fixture'
import { programRewardsBackendFixture as phase6 } from './program-rewards-backend.fixture'
import {
  landingKindOf,
  offersAppLanding,
  ProgramError,
  readAppLinks,
  readRewardEvents,
  readState,
  withRewardEvent,
} from './programs'
import { href } from './routes'

// The program form for a program that sends people to an app (Phase 7): the choice of a web
// page or the app, the smart link, the reward picker's install and suggested words, and how an
// install is tied to a creator. The stand-in for the Supabase client is the one
// programs.rewards.test.tsx uses.

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

type Row = Record<string, unknown>

const LINKS = readAppLinks(apps['workspace_program_app_links.listed'])
const LINK = LINKS[0]
const NO_LINKS = { links: [] }
const linkLabel = (link: { name: string; url: string }) =>
  `${link.name} · ${link.url.replace(/^https:\/\//, '')}`

const project: Project = {
  id: LINK.project_id,
  workspace_id: 'ws-1',
  name: LINK.project_name,
  platforms: ['android', 'web'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
}

const context = (role: Role = 'owner'): Context => ({
  user: { id: 'user-1', email: 'owner@example.test', name: 'Fluent Owner' },
  workspaces: [{ id: 'ws-1', name: 'Fluent', role, projects: [project] }],
})

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The saved app program, as the database answers it. */
const appProgram = () => clone(apps['workspace_program_get.app_program']) as Row & { program: Row }

/** A Phase 6 answer as the Phase 7 database gives it: a web page, in a workspace with app links. */
function webProgram(name = 'workspace_program_get.events_draft', over: Row = {}): Row {
  const answer = clone(phase6[name]) as Row & { program: Row }
  return {
    ...answer,
    app_links_available: true,
    program: { ...answer.program, app_link: null, ...over },
  }
}

const WEB_URL = (phase6['workspace_program_get.events_draft'] as { program: Row }).program
  .landing_url as string

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
    workspace_program_reward_events: apps['workspace_program_reward_events.with_app_events'],
    workspace_program_app_links: apps['workspace_program_app_links.listed'],
    ...table,
  }
}

const sent = (name: string) =>
  fake.state.calls.filter((call) => call.name === `workspace_program_${name}`).map((c) => c.args)

async function openProgram(get: Answer, table: Record<string, Answer> = {}) {
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

const button = (name: string) => screen.getByRole('button', { name })
const kinds = () => screen.getByRole('group', { name: 'Where creator links send people' })
const kind = (name: 'A web page' | 'Your app') => within(kinds()).getByRole('button', { name })
const address = () => screen.getByLabelText('Landing page address')
const smartLink = () => screen.findByLabelText('Smart link')
const landing = () => screen.getByRole('region', { name: 'Landing page' })
const reward = (number: number) => screen.getByRole('group', { name: `Reward ${number}` })
const part = (number: number, name: string) => within(reward(number)).getByLabelText(name)
const rewardsShown = () => waitFor(() => expect(part(1, 'Event')).toBeInTheDocument())
const optionTexts = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options).map((option) => option.textContent)

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.context = context()
  answers({})
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('the landing page of a program that can send people to an app', () => {
  it('keeps today’s form where the database says nothing of app links', async () => {
    await openProgram(phase6['workspace_program_get.events_draft'])
    expect(screen.queryByRole('group', { name: 'Where creator links send people' })).toBeNull()
    expect(address()).toHaveValue(WEB_URL)
    expect(screen.queryByLabelText('Smart link')).not.toBeInTheDocument()
    expect(sent('app_links')).toEqual([])
    // The tracking text is the one for a site.
    expect(screen.getByText(/nothing more to add/)).toBeInTheDocument()
  })

  it('offers a web page or the app, and the chosen link becomes the landing page', async () => {
    const user = await openProgram(webProgram(), {
      workspace_program_save: (args: Args) => {
        const input = args.p_input as Row
        const next = appProgram()
        next.program = {
          ...(webProgram().program as Row),
          landing_url: input.landing_url,
          app_link: { id: LINK.id, url: LINK.url, name: LINK.name },
          revision: 16,
        }
        return next
      },
    })
    expect(kind('A web page')).toHaveAttribute('aria-pressed', 'true')
    expect(address()).toHaveValue(WEB_URL)
    await waitFor(() => expect(sent('app_links')).toEqual([{ p_workspace_id: 'ws-1' }]))

    await user.click(kind('Your app'))
    expect(kind('Your app')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByLabelText('Landing page address')).not.toBeInTheDocument()
    const select = await smartLink()
    expect(select).toHaveValue('')
    expect(optionTexts(select)).toEqual(['Choose a link', linkLabel(LINK)])
    // The links of one app sit under its name and the platforms it is on.
    expect(within(select).getByRole('group')).toHaveAttribute('label', 'Fluent · Android')

    await user.selectOptions(select, LINK.url)
    expect(select).toHaveValue(LINK.url)
    expect(within(landing()).getByText('For Fluent on')).toBeInTheDocument()
    expect(within(landing()).getByText('Android')).toBeInTheDocument()
    expect(within(landing()).queryByText('iOS')).not.toBeInTheDocument()

    await user.click(button('Save'))
    await waitFor(() => expect(sent('save')).toHaveLength(1))
    expect(sent('save')[0].p_input).toEqual({ landing_url: LINK.url, revision: 15 })
    // The saved answer names the link, so the form stays on the app.
    await waitFor(() => expect(button('Save')).toBeDisabled())
    expect(kind('Your app')).toHaveAttribute('aria-pressed', 'true')
    expect(await smartLink()).toHaveValue(LINK.url)
  })

  it('keeps what each choice held when the person goes back and forth', async () => {
    const user = await openProgram(webProgram())
    await user.click(kind('Your app'))
    await user.selectOptions(await smartLink(), LINK.url)
    await user.click(kind('A web page'))
    expect(address()).toHaveValue(WEB_URL)
    // Back on the web page with nothing changed, there is nothing to save.
    expect(button('Save')).toBeDisabled()
    await user.click(kind('Your app'))
    expect(await smartLink()).toHaveValue(LINK.url)
    expect(button('Save')).toBeEnabled()
    await user.click(button('Discard'))
    expect(kind('A web page')).toHaveAttribute('aria-pressed', 'true')
    expect(address()).toHaveValue(WEB_URL)
  })

  it('opens a saved app program on the app, with its link chosen', async () => {
    const user = await openProgram(appProgram())
    expect(kind('Your app')).toHaveAttribute('aria-pressed', 'true')
    expect(await smartLink()).toHaveValue(LINK.url)
    expect(screen.queryByLabelText('Landing page address')).not.toBeInTheDocument()
    expect(button('Save')).toBeDisabled()
    // A web page starts empty; the app's link comes back with the app.
    await user.click(kind('A web page'))
    expect(address()).toHaveValue('')
    await user.click(kind('Your app'))
    expect(await smartLink()).toHaveValue(LINK.url)
    expect(button('Save')).toBeDisabled()
  })

  it('keeps a saved link that is no longer listed, and shows it while the list loads', async () => {
    await openProgram(appProgram(), {
      workspace_program_app_links: NO_LINKS,
    })
    const select = await smartLink()
    await waitFor(() => expect(sent('app_links')).toHaveLength(1))
    expect(select).toHaveValue(LINK.url)
    expect(optionTexts(select)).toEqual(['Choose a link', linkLabel(LINK)])
    // Nothing says which platforms an unlisted link's app is on.
    expect(within(landing()).queryByText('Android')).not.toBeInTheDocument()
  })

  it('finds the saved link in the list by its id', async () => {
    // The same link, as the list names it; the address saved with the program still stands.
    const user = await openProgram(appProgram(), {
      workspace_program_app_links: {
        links: [
          { ...LINK, name: 'Renamed' },
          { ...LINK, id: 'other', url: `${LINK.url}-2`, name: 'Second' },
        ],
      },
    })
    const select = await smartLink()
    await waitFor(() => expect(optionTexts(select)).toHaveLength(3))
    expect(select).toHaveValue(LINK.url)
    expect(optionTexts(select)).toEqual([
      'Choose a link',
      linkLabel({ ...LINK, name: 'Renamed' }),
      linkLabel({ ...LINK, url: `${LINK.url}-2`, name: 'Second' }),
    ])
    await user.selectOptions(select, `${LINK.url}-2`)
    expect(button('Save')).toBeEnabled()
    await user.selectOptions(select, LINK.url)
    expect(button('Save')).toBeDisabled()
  })

  it('says when the smart links cannot be loaded, and tries again', async () => {
    let calls = 0
    const user = await openProgram(webProgram(), {
      workspace_program_app_links: () =>
        ++calls === 1
          ? new Error('TypeError: Failed to fetch')
          : apps['workspace_program_app_links.listed'],
    })
    await user.click(kind('Your app'))
    const alert = await within(landing()).findByRole('alert')
    expect(alert).toHaveTextContent('Your smart links could not be loaded.')
    expect(screen.queryByLabelText('Smart link')).not.toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await smartLink()).toHaveValue('')
    expect(within(landing()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('points to Attribution when the apps have no smart links yet', async () => {
    const user = await openProgram(webProgram(), {
      workspace_program_app_links: NO_LINKS,
    })
    await user.click(kind('Your app'))
    await waitFor(() =>
      expect(within(landing()).getByText(/no active smart links yet/)).toBeInTheDocument(),
    )
    expect(within(landing()).getByRole('link', { name: 'Make a smart link' })).toHaveAttribute(
      'href',
      href({ name: 'attribution', projectId: project.id, section: 'links' }),
    )
  })

  it('asks for a link before a live program’s landing page can be the app', async () => {
    const user = await openProgram(webProgram('workspace_program_get.events_live'))
    await user.click(kind('Your app'))
    const select = await smartLink()
    await user.click(button('Save'))
    expect(
      await within(landing()).findByText('Choose the smart link creators send people to.'),
    ).toBeInTheDocument()
    expect(select).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(select).toHaveFocus())
    expect(sent('save')).toEqual([])
    await user.selectOptions(select, LINK.url)
    expect(select).not.toHaveAttribute('aria-invalid')
  })

  it('shows a viewer the app and its link, and changes nothing', async () => {
    fake.state.context = context('analyst')
    await openProgram({ ...appProgram(), can_manage: false })
    expect(kind('Your app')).toHaveAttribute('aria-pressed', 'true')
    expect(kind('Your app')).toBeDisabled()
    expect(await smartLink()).toBeDisabled()
    expect(await smartLink()).toHaveValue(LINK.url)
  })
})

describe('the rewards of a program that sends people to an app', () => {
  it('names the install in words, offers it first, and fills in the suggested words', async () => {
    const user = await openProgram(webProgram(), {
      workspace_program_reward_events: phase6['workspace_program_reward_events.listed'],
    })
    await rewardsShown()
    // A web program is offered the events its site sent, and nothing more.
    expect(optionTexts(part(1, 'Event'))).not.toContain('App installed (install)')

    await user.click(kind('Your app'))
    await user.click(button('Add reward'))
    const event = part(3, 'Event')
    expect(optionTexts(event).slice(0, 2)).toEqual(['Choose an event', 'App installed (install)'])
    await user.selectOptions(event, 'app_installed')
    expect(part(3, 'What creators read')).toHaveValue('App installed')
  })

  it('suggests the words the database gives, until the person writes their own', async () => {
    const user = await openProgram(appProgram(), {
      workspace_program_reward_events: {
        events: [
          ...(apps['workspace_program_reward_events.with_app_events'] as { events: Row[] }).events,
          {
            name: 'lesson_finished',
            description: null,
            first_seen: null,
            last_seen: null,
            suggested_label: 'First lesson done',
          },
        ],
      },
    })
    await rewardsShown()
    expect(part(1, 'Event')).toHaveValue('app_installed')
    expect(optionTexts(part(1, 'Event'))).toContain('App installed (install)')
    await user.click(button('Add reward'))
    await user.selectOptions(part(3, 'Event'), 'lesson_finished')
    expect(part(3, 'What creators read')).toHaveValue('First lesson done')
    // Untouched words follow the event.
    await user.selectOptions(part(3, 'Event'), 'app_opened')
    expect(part(3, 'What creators read')).toHaveValue('App opened')
    // Words the person wrote stay.
    await user.clear(part(3, 'What creators read'))
    await user.type(part(3, 'What creators read'), 'Came back')
    await user.selectOptions(part(3, 'Event'), 'lesson_finished')
    expect(part(3, 'What creators read')).toHaveValue('Came back')
  })

  it('works out the words without a list, as an older database answers', () => {
    const row = { key: '', label: '', amount: '' }
    expect(withRewardEvent(row, 'app_installed').label).toBe('App installed')
    expect(withRewardEvent(row, 'app_installed', []).label).toBe('App installed')
    const events = [
      {
        name: 'quiz_done',
        description: null,
        first_seen: null,
        last_seen: null,
        suggested_label: 'Quiz finished',
      },
    ]
    expect(withRewardEvent(row, 'quiz_done', events).label).toBe('Quiz finished')
    expect(withRewardEvent({ ...row, label: 'Mine' }, 'quiz_done', events).label).toBe('Mine')
    // A suggestion that does not fit the field is no suggestion.
    const odd = readRewardEvents({
      events: [
        { name: 'quiz_done', suggested_label: 'x'.repeat(41) },
        { name: 'quiz_started', suggested_label: 7 },
        { name: 'quiz_left', suggested_label: '  Left a quiz ' },
      ],
    })
    expect(odd.map((event) => event.suggested_label)).toEqual([null, null, 'Left a quiz'])
    expect(withRewardEvent(row, 'quiz_done', odd).label).toBe('Quiz done')
  })
})

describe('reading what the database says of app links', () => {
  it('reads a saved link it cannot use as a web page, and never refuses the answer for it', () => {
    const base = appProgram()
    for (const wrong of [
      null,
      'https://x.example',
      {},
      { url: 'http://fluent.example/start' },
      { name: 'Get the app' },
    ]) {
      const state = readState({ ...base, program: { ...base.program, app_link: wrong } })
      expect(state.program?.app_link).toBeNull()
      expect(landingKindOf(state.program)).toBe('web')
    }
    // A link with no name is named by its address.
    const unnamed = readState({
      ...base,
      program: { ...base.program, app_link: { url: LINK.url } },
    })
    expect(unnamed.program?.app_link).toEqual({
      id: null,
      url: LINK.url,
      name: 'fluent.go.kissmyapps.dev/get-app',
    })
  })

  it('offers the app where links are available, or where the program already has one', () => {
    const base = appProgram()
    expect(offersAppLanding(readState({ ...base, app_links_available: false }))).toBe(true)
    const web = webProgram()
    expect(offersAppLanding(readState({ ...web, app_links_available: false }))).toBe(false)
    expect(offersAppLanding(readState(web))).toBe(true)
    expect(offersAppLanding(undefined)).toBe(false)
  })

  it('reads only the links it can use, and refuses a list it cannot read', () => {
    expect(
      readAppLinks({
        links: [
          {
            id: 'link-a',
            url: 'https://a.go.kissmyapps.dev/x',
            name: 'A',
            project_id: 'p',
            project_name: 'App',
            ios: true,
          },
          { url: 'https://a.go.kissmyapps.dev/x', name: 'Again' },
          { url: 'http://a.go.kissmyapps.dev/y', name: 'Plain' },
          { url: 'https://a.go.kissmyapps.dev/z', name: ' ', ios: 'yes', android: 1 },
          { name: 'No address' },
          null,
          7,
        ],
      }),
    ).toEqual([
      {
        id: 'link-a',
        url: 'https://a.go.kissmyapps.dev/x',
        name: 'A',
        project_id: 'p',
        project_name: 'App',
        ios: true,
        android: false,
      },
      {
        id: 'https://a.go.kissmyapps.dev/z',
        url: 'https://a.go.kissmyapps.dev/z',
        name: 'a.go.kissmyapps.dev/z',
        project_id: '',
        project_name: '',
        ios: false,
        android: false,
      },
    ])
    for (const wrong of [null, [], {}, { links: 'none' }])
      expect(() => readAppLinks(wrong)).toThrow(ProgramError)
  })
})

describe('how an install is tied to a creator', () => {
  it('tells an app program about the SDK, the links that open the app, and the setup', async () => {
    await openProgram(appProgram())
    const section = screen.getByRole('region', { name: 'Event tracking' })
    expect(within(section).getByText('How an install is tied to a creator')).toBeInTheDocument()
    expect(section).toHaveTextContent(
      /KissMyApps SDK\s1\.1 or later in your app matches each install/,
    )
    expect(section).toHaveTextContent(
      'Your smart links must open the app: add Associated Domains on iPhone and App Links on Android.',
    )
    await waitFor(() =>
      expect(within(section).getByRole('link', { name: 'Set up attribution' })).toHaveAttribute(
        'href',
        href({ name: 'attribution', projectId: LINK.project_id, section: 'setup' }),
      ),
    )
    expect(screen.queryByRole('heading', { name: 'Sale tracking' })).not.toBeInTheDocument()
  })

  it('shows both for an app program that pays for sales and events', async () => {
    const answer = appProgram()
    answer.program = {
      ...answer.program,
      earn_from: 'both',
      commission_type: 'percent',
      commission_rate_bps: 2000,
      commission_duration: 'lifetime',
    }
    await openProgram(answer)
    expect(screen.getByRole('heading', { name: 'Sale tracking' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Event tracking' })).toHaveTextContent(
      /Associated Domains/,
    )
  })

  it('follows the form: back to a web page, the text is the one for a site', async () => {
    const user = await openProgram(appProgram())
    await user.click(kind('A web page'))
    expect(screen.queryByText(/Associated Domains/)).not.toBeInTheDocument()
    expect(screen.getByText(/nothing more to add/)).toBeInTheDocument()
  })
})
