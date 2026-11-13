import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { amplitudeBackendFixture as amplitude } from './amplitude-backend.fixture'
import { MerchantApp } from './MerchantApp'
import { PLACEHOLDER_HEADER_VALUE, storeBackendFixture as store } from './store-backend.fixture'

// The Connections page's Phase 8 cards: RevenueCat and Adapty per app (connecting shows the
// webhook address and the header value once), and Amplitude per app (the key never shown
// whole). The stand-in for the Supabase client answers each rpc by name from a table.

type Args = Record<string, unknown>
type Row = Record<string, unknown>

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
    if (!name.startsWith('workspace_store_') && !name.startsWith('analytics_destination'))
      return { data: state.context, error: null }
    state.calls.push({ name, args })
    const answer = state.table[name]
    const value =
      typeof answer === 'function'
        ? await (answer as (args: Record<string, unknown>) => unknown)(args)
        : answer
    const refusal = value as { refused?: boolean; code?: string; details?: string | null } | null
    if (refusal && refusal.refused)
      return {
        data: null,
        error: { code: refusal.code, details: refusal.details, message: 'From the database.' },
      }
    if (value === undefined)
      return { data: null, error: { code: 'XX000', details: null, message: `No answer: ${name}` } }
    return { data: value, error: null }
  }
  // Stripe's own card asks its function; it is connected and has seen nothing yet.
  const functions = {
    async invoke() {
      return {
        data: {
          enabled: true,
          workspace_id: 'ws-1',
          can_manage: true,
          connection: null,
          payments: { seen: 0, tagged: 0, last_at: null, last_tagged_at: null },
        },
        error: null,
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

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fixture = (name: string) => clone(store[name]) as Row & { connections: Row[] }
const destinations = (name: string) => clone(amplitude[name]) as Row & { destinations: Row[] }

const FLUENT = '0be808cd-1411-4791-b8f2-ce3038d2c865'
const SPEAKSIX = '9c2e4f61-7a3b-4d58-b0e9-1f2a3c4d5e6f'
const DUOFLASH = '4d6e8f0a-2b3c-4e5f-8a9b-0c1d2e3f4a5b'

const projectOf = (id: string, name: string): Project => ({
  id,
  workspace_id: 'ws-1',
  name,
  platforms: ['ios', 'android'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
})

const context = (role: Role, projects = [projectOf(FLUENT, 'Fluent')]): Context => ({
  user: { id: 'user-1', email: 'owner@example.test', name: 'Fluent Owner' },
  workspaces: [{ id: 'ws-1', name: 'Fluent Labs', role, projects }],
})

/** The three-app list, as a workspace whose answer does not say who may change it. */
const threeApps = () => fixture('workspace_store_connections.three_apps')

/** What making a connection answers, for the app it was asked for. */
const made = (args: Args): Row => ({
  ...fixture('workspace_store_connection_create.revenuecat'),
  project_id: args.p_project_id,
  project_name: args.p_project_id === SPEAKSIX ? 'SpeakSix' : 'DuoFlash',
  provider: args.p_provider,
})

const sent = (name: string) =>
  fake.state.calls.filter((call) => call.name === name).map((call) => call.args)

async function openConnections(role: Role, table: Record<string, unknown>, projects?: Project[]) {
  fake.state.session = { user: { id: 'user-1', email: 'owner@example.test' } }
  fake.state.context = context(role, projects)
  fake.state.table = table
  window.location.hash = '#connections'
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Connections', level: 1 })
  return userEvent.setup()
}

const card = (name: 'RevenueCat' | 'Adapty' | 'Amplitude') => screen.getByRole('region', { name })
const app = (tool: 'RevenueCat' | 'Adapty', name: string) =>
  within(within(card(tool)).getByRole('list', { name: `Apps connected to ${tool}` }))
    .getAllByRole('listitem')
    .find((item) => within(item).queryByRole('heading', { name }))!

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.table = {}
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('RevenueCat and Adapty on the Connections page', () => {
  it('lists the apps each tool reports for, and what arrived in 30 days', async () => {
    await openConnections('owner', {
      workspace_store_connections: fixture('workspace_store_connections.listed'),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const fluent = await waitFor(() => app('RevenueCat', 'Fluent'))
    expect(fluent).toHaveTextContent('Events, 30 days15')
    expect(fluent).toHaveTextContent('Creator sales, 30 days4')
    expect(within(fluent).getByRole('button', { name: 'New header value' })).toBeEnabled()
    expect(within(fluent).getByRole('button', { name: 'Remove' })).toBeEnabled()
    expect(app('Adapty', 'Fluent')).toHaveTextContent('Events, 30 days2')
    // The other app can still be connected to each tool.
    const another = within(card('RevenueCat')).getByLabelText('Another app')
    expect(
      within(another)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['Fluent web'])
    expect(sent('workspace_store_connections')).toEqual([{ p_workspace_id: 'ws-1' }])
    // The header value is never on the page unless it was just made.
    expect(document.body.textContent).not.toMatch(/Bearer/)
  })

  it('never lists a connection that was removed', async () => {
    await openConnections('owner', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    await waitFor(() => app('Adapty', 'SpeakSix'))
    expect(within(card('Adapty')).queryByRole('heading', { name: 'DuoFlash' })).toBeNull()
    expect(
      within(within(card('Adapty')).getByLabelText('Another app'))
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['Fluent', 'DuoFlash'])
  })

  it('connects an app and shows the address and header value once, with copy buttons', async () => {
    let connected = false
    const user = await openConnections('owner', {
      workspace_store_connections: () => {
        if (!connected) return threeApps()
        const list = threeApps()
        const {
          webhook_url: _url,
          header_value: _value,
          ...row
        } = made({
          p_project_id: SPEAKSIX,
          p_provider: 'revenuecat',
        })
        return { ...list, connections: [...list.connections, row] }
      },
      workspace_store_connection_create: (args: Args) => {
        connected = true
        return made(args)
      },
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const picker = await within(card('RevenueCat')).findByLabelText('Another app')
    await user.selectOptions(picker, SPEAKSIX)
    await user.click(within(card('RevenueCat')).getByRole('button', { name: 'Connect RevenueCat' }))

    const setup = await within(card('RevenueCat')).findByRole('region', {
      name: 'Add the webhook in RevenueCat',
    })
    expect(sent('workspace_store_connection_create')).toEqual([
      { p_workspace_id: 'ws-1', p_project_id: SPEAKSIX, p_provider: 'revenuecat' },
    ])
    expect(setup).toHaveTextContent(
      'In RevenueCat, open Project settings, then Integrations, then Webhooks, and add one.',
    )
    expect(
      within(setup).getByText(
        'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/revenuecat',
      ),
    ).toBeInTheDocument()
    expect(within(setup).getByText(PLACEHOLDER_HEADER_VALUE)).toBeInTheDocument()
    expect(within(setup).getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
    expect(setup).toHaveTextContent('This header value will not be shown again. Copy it now.')
    // It sits with the app it was made for, and the person is taken there.
    expect(within(app('RevenueCat', 'SpeakSix')).getByRole('region')).toBe(setup)
    expect(setup).toHaveFocus()
    expect(await screen.findByText('RevenueCat connected to SpeakSix')).toBeInTheDocument()

    await user.click(within(setup).getByRole('button', { name: 'I have added it' }))
    expect(screen.queryByText(PLACEHOLDER_HEADER_VALUE)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Add the webhook in RevenueCat' })).toBeNull()
  })

  it('names Adapty’s own place for the webhook', async () => {
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      workspace_store_connection_create: made,
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const picker = await within(card('Adapty')).findByLabelText('Another app')
    await user.selectOptions(picker, DUOFLASH)
    await user.click(within(card('Adapty')).getByRole('button', { name: 'Connect Adapty' }))
    const setup = await screen.findByRole('region', { name: 'Add the webhook in Adapty' })
    expect(setup).toHaveTextContent(
      'In Adapty, open App settings, then Integrations, then Webhooks.',
    )
  })

  it('asks before a new header value, and shows the new one once', async () => {
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      workspace_store_connection_rotate: (args: Args) => ({
        ...fixture('workspace_store_connection_create.revenuecat'),
        id: args.p_connection_id,
        project_id: FLUENT,
        project_name: 'Fluent',
      }),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const fluent = await waitFor(() => app('RevenueCat', 'Fluent'))
    await user.click(within(fluent).getByRole('button', { name: 'New header value' }))
    const dialog = await screen.findByRole('dialog', { name: 'Make a new header value?' })
    expect(dialog).toHaveTextContent('The value RevenueCat sends now stops working at once.')
    await user.click(within(dialog).getByRole('button', { name: 'Make a new value' }))
    await waitFor(() =>
      expect(sent('workspace_store_connection_rotate')).toEqual([
        { p_connection_id: 'e5a1c2d3-0001-4b00-8c00-0000000000c1' },
      ]),
    )
    const setup = await within(app('RevenueCat', 'Fluent')).findByRole('region', {
      name: 'Add the webhook in RevenueCat',
    })
    expect(within(setup).getByText(PLACEHOLDER_HEADER_VALUE)).toBeInTheDocument()
  })

  it('removes a connection after asking, and lists what the answer says is left', async () => {
    const after = threeApps()
    after.connections = after.connections.filter((row) => row.provider !== 'revenuecat')
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      workspace_store_connection_remove: after,
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const fluent = await waitFor(() => app('RevenueCat', 'Fluent'))
    await user.click(within(fluent).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove RevenueCat from Fluent?' })
    expect(dialog).toHaveTextContent('Sales already recorded stay.')
    await user.click(within(dialog).getByRole('button', { name: 'Remove RevenueCat' }))
    await waitFor(() =>
      expect(within(card('RevenueCat')).queryByRole('heading', { name: 'Fluent' })).toBeNull(),
    )
    expect(sent('workspace_store_connection_remove')).toEqual([
      { p_connection_id: 'e5a1c2d3-0001-4b00-8c00-0000000000c1' },
    ])
    // The answer was the list, so it was not asked for again.
    expect(sent('workspace_store_connections')).toHaveLength(1)
    expect(within(card('RevenueCat')).getByLabelText('App')).toBeInTheDocument()
  })

  it('shows the list without buttons to someone the answer says cannot change it', async () => {
    const listed = { ...fixture('workspace_store_connections.listed'), can_manage: false }
    await openConnections('owner', {
      workspace_store_connections: listed,
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    await waitFor(() => app('RevenueCat', 'Fluent'))
    expect(within(card('RevenueCat')).queryByRole('button')).toBeNull()
    expect(within(card('Adapty')).queryByRole('button')).toBeNull()
    expect(card('RevenueCat')).toHaveTextContent(
      'Only an owner or admin of Fluent Labs can connect RevenueCat.',
    )
  })

  it('says a failed load plainly and tries again on Retry', async () => {
    let fail = true
    const user = await openConnections('owner', {
      workspace_store_connections: () =>
        fail ? { refused: true, code: 'XX000', details: null } : threeApps(),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const note = await within(card('RevenueCat')).findByText(
      'Your in-app purchase connections could not be loaded. Try again.',
    )
    expect(note).toBeInTheDocument()
    fail = false
    await user.click(within(card('RevenueCat')).getByRole('button', { name: 'Retry' }))
    expect(await waitFor(() => app('RevenueCat', 'Fluent'))).toBeInTheDocument()
  })

  it('says why an app could not be connected, and keeps the choice', async () => {
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      workspace_store_connection_create: { refused: true, code: '42501', details: null },
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
    })
    const picker = await within(card('RevenueCat')).findByLabelText('Another app')
    await user.selectOptions(picker, DUOFLASH)
    await user.click(within(card('RevenueCat')).getByRole('button', { name: 'Connect RevenueCat' }))
    expect(
      await within(card('RevenueCat')).findByText(
        'Your role cannot change this. Ask an owner or admin of the workspace.',
      ),
    ).toBeInTheDocument()
    expect(picker).toHaveValue(DUOFLASH)
    expect(document.body.textContent).not.toMatch(/42501|not_allowed/)
  })
})

describe('Amplitude on the Connections page', () => {
  const apps = [projectOf(FLUENT, 'Fluent'), projectOf(SPEAKSIX, 'SpeakSix')]

  it('shows a saved key by its last four only, per app', async () => {
    const user = await openConnections(
      'owner',
      {
        workspace_store_connections: threeApps(),
        analytics_destinations_get: (args: Args) =>
          args.p_project_id === FLUENT
            ? destinations('analytics_destinations_get.saved')
            : destinations('analytics_destinations_get.none'),
      },
      apps,
    )
    const amp = card('Amplitude')
    expect(await within(amp).findByText('Waiting for the first install to send')).toBeVisible()
    expect(amp).toHaveTextContent('API keyEnding in ••••beef')
    expect(amp).toHaveTextContent('Data regionUS')
    expect(amp).not.toHaveTextContent(/[0-9a-f]{32}/)
    await user.selectOptions(within(amp).getByLabelText('App'), SPEAKSIX)
    expect(await within(amp).findByLabelText('API key')).toHaveValue('')
    expect(amp).toHaveTextContent('Installs made before the key is saved are not sent.')
    expect(sent('analytics_destinations_get')).toEqual([
      { p_project_id: FLUENT },
      { p_project_id: SPEAKSIX },
    ])
  })

  it('connects with a key and a region, and never shows the key again', async () => {
    const key = 'a'.repeat(28) + 'beef'
    const user = await openConnections('developer', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
      analytics_destination_save: () => {
        const saved = destinations('analytics_destinations_get.saved')
        saved.destinations[0].region = 'eu'
        return saved
      },
    })
    const amp = card('Amplitude')
    const field = await within(amp).findByLabelText('API key')
    await user.type(field, `  ${key.toUpperCase()} `)
    await user.click(within(amp).getByRole('button', { name: 'EU' }))
    await user.click(within(amp).getByRole('button', { name: 'Connect Amplitude' }))
    await waitFor(() => expect(sent('analytics_destination_save')).toHaveLength(1))
    expect(sent('analytics_destination_save')[0]).toEqual({
      p_project_id: FLUENT,
      p_provider: 'amplitude',
      p_input: { region: 'eu', ['api_' + 'key']: key.toUpperCase() },
    })
    expect(
      await within(amp).findByText('Waiting for the first install to send for Fluent'),
    ).toBeVisible()
    expect(amp).toHaveTextContent('Data regionEU')
    expect(document.body.textContent).not.toContain(key.toUpperCase())
    expect(await screen.findByText('Amplitude connected to Fluent')).toBeInTheDocument()
  })

  it('checks the key before sending it, and says what the database refused at the field', async () => {
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: destinations('analytics_destinations_get.none'),
      analytics_destination_save: { refused: true, code: '22023', details: 'invalid_key' },
    })
    const amp = card('Amplitude')
    const field = await within(amp).findByLabelText('API key')
    await user.type(field, 'not-a-key')
    await user.click(within(amp).getByRole('button', { name: 'Connect Amplitude' }))
    expect(
      within(amp).getByText('Enter the 32-character API key of your Amplitude project.'),
    ).toBeVisible()
    expect(sent('analytics_destination_save')).toEqual([])
    await user.clear(field)
    await user.type(field, 'b'.repeat(32))
    await user.click(within(amp).getByRole('button', { name: 'Connect Amplitude' }))
    await waitFor(() => expect(sent('analytics_destination_save')).toHaveLength(1))
    expect(
      await within(amp).findByText('Enter the 32-character API key of your Amplitude project.'),
    ).toBeVisible()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveValue('b'.repeat(32))
    expect(amp).not.toHaveTextContent('invalid_key')
  })

  it('says when Amplitude refused the key, and takes a new one', async () => {
    const paused = destinations('analytics_destinations_get.saved')
    Object.assign(paused.destinations[0], { status: 'paused', last_error: 'invalid_key' })
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: paused,
      analytics_destination_save: destinations('analytics_destinations_get.saved'),
    })
    const amp = card('Amplitude')
    expect(
      await within(amp).findByText('Amplitude refused this key. Paste a new one.'),
    ).toBeVisible()
    // The state line says it already; the bare reason is not repeated.
    expect(amp).not.toHaveTextContent('Last error')
    await user.click(within(amp).getByRole('button', { name: 'Paste a new key' }))
    expect(within(amp).getByText('Leave it empty to keep the key ending in beef.')).toBeVisible()
    await user.click(within(amp).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent('analytics_destination_save')).toHaveLength(1))
    // Left empty, the saved key stays and only the region is sent.
    expect(sent('analytics_destination_save')[0].p_input).toEqual({ region: 'us' })
    expect(
      await within(amp).findByText('Waiting for the first install to send for Fluent'),
    ).toBeVisible()
  })

  it('shows a refused key to someone who cannot change it, without a way to', async () => {
    const paused = destinations('analytics_destinations_get.saved')
    Object.assign(paused.destinations[0], { status: 'paused', last_error: 'invalid_key' })
    await openConnections('analyst', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: paused,
    })
    const amp = card('Amplitude')
    expect(
      await within(amp).findByText(
        'Amplitude refused this key. A developer, admin or owner can paste a new one.',
      ),
    ).toBeVisible()
    expect(within(amp).queryByRole('button')).toBeNull()
  })

  it('removes Amplitude after asking, from what the answer says', async () => {
    const user = await openConnections('owner', {
      workspace_store_connections: threeApps(),
      analytics_destinations_get: destinations('analytics_destinations_get.saved'),
      analytics_destination_remove: destinations('analytics_destinations_get.none'),
    })
    const amp = card('Amplitude')
    await within(amp).findByText('Waiting for the first install to send for Fluent')
    await user.click(within(amp).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove Amplitude from Fluent?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove Amplitude' }))
    expect(await within(amp).findByLabelText('API key')).toHaveValue('')
    expect(sent('analytics_destination_remove')).toEqual([
      { p_project_id: FLUENT, p_provider: 'amplitude' },
    ])
    expect(sent('analytics_destinations_get')).toHaveLength(1)
  })
})
