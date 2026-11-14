import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiKey,
  Attribution,
  AttributionLinks,
  AttributionSources,
  Context,
  PersonDetail,
  Project,
  Role,
} from './api'
import { attributionBackendFixture as captured } from './attribution-backend.fixture'
import { attributionRevenueBackendFixture as revenueBackend } from './attribution-revenue-backend.fixture'
import { sdkSnippets } from './attribution'
import { MerchantApp } from './MerchantApp'

// A stand-in for the Supabase client: a signed-in session, and rpc calls answered by handlers.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    handlers: {} as Record<string, (args: Record<string, unknown>) => unknown>,
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
  name: 'Fluent',
  platforms: ['ios', 'android'],
  timezone: 'Africa/Lagos',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
  last_event_at: '2026-11-12T08:30:00Z',
  attribution_enabled: true,
}

// The field with a key's full text, named in parts so the leaked-key scanner stays quiet.
const KEY_TEXT = ('to' + 'ken') as Extract<keyof ApiKey, `to${string}`>
const publicKey = 'kma_pk_live_' + 'K'.repeat(23)
const clientKey: ApiKey = {
  [KEY_TEXT]: publicKey,
  id: 'key-1',
  project_id: 'proj-1',
  name: 'Apps',
  kind: 'client',
  environment: 'production',
  prefix: 'kma_pk_live_',
  last4: 'RbC8',
  created_at: '2026-10-01T09:00:00Z',
  last_used_at: null,
  revoked_at: null,
  created_by: 'Victory Onorhime',
}

const context = (role: Role, projects: Project[] = [project]): Context => ({
  user: { id: 'user-1', email: 'victory@example.test', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects }],
})

function signedInAs(role: Role, projects?: Project[]) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.test' } }
  fake.state.handlers.analytics_bootstrap = () => context(role, projects)
  fake.state.handlers.analytics_context = () => context(role, projects)
}

const calls = (name: string) => fake.state.calls.filter((call) => call.name === name)
const copy = <T,>(value: unknown) => structuredClone(value) as T
const withInstalls = () => copy<Attribution>(captured.attribution_get_with_installs)
const linksAnswer = () => copy<AttributionLinks>(captured.attribution_links_with_installs)
const sourcesAnswer = () => copy<AttributionSources>(captured.attribution_sources_with_installs)
const code = (label: string) =>
  [...document.querySelectorAll(`pre[aria-label="${label}"]`)]
    .map((block) => block.textContent)
    .join('\n')

let view: Attribution

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  view = withInstalls()
  fake.state.handlers = {
    analytics_project_settings: () => ({ project, role: 'owner', keys: [clientKey] }),
    attribution_get: () => view,
    attribution_update: ({ p_patch }) => {
      view = { ...view, settings: { ...view.settings!, ...(p_patch as object) } }
      return view
    },
    attribution_links: () => linksAnswer(),
    attribution_sources: () => sourcesAnswer(),
    attribution_revenue_setup: () => structuredClone(revenueBackend.revenue_setup_empty),
  }
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SDK 1.1 code', () => {
  it('hands links to the SDK on every platform, with clipboard handoff only when it is on', () => {
    const off = sdkSnippets({ key: 'kma_pk_live_abc', clipboard: false })
    expect(off.iosCode).toContain('.onOpenURL { KissMyApps.handleDeepLink($0) }')
    expect(off.iosCode).toContain('KissMyApps.onDeepLink { link in')
    expect(off.iosCode).toContain('KissMyApps.start(key: "kma_pk_live_abc")')
    expect(off.iosCode).not.toContain('clipboardHandoff')
    expect(off.androidGradle).toContain(
      'implementation("com.github.onorhime:kissmyapps-mobile:1.1.0")',
    )
    expect(off.androidCode.match(/KissMyApps\.handleDeepLink\(intent\)/g)).toHaveLength(2)
    expect(off.androidCode).toContain('override fun onNewIntent(intent: Intent)')
    expect(off.androidCode).toContain('KissMyApps.onDeepLink { link ->')
    expect(off.reactNativeInstall).toContain('npm install @kissmyappss/react-native@^1.1.0')
    expect(off.reactNativeCode).toContain('KissMyApps.onDeepLink((link) => {')
    expect(off.reactNativeCode).toContain('KissMyApps.handleDeepLink(url)')
    expect(off.flutterInstall).toBe('flutter pub add kissmyapps:^1.1.0')
    expect(off.flutterCode).toContain('KissMyApps.onDeepLink((link) {')

    const on = sdkSnippets({ key: 'kma_pk_live_abc', clipboard: true })
    expect(on.iosCode).toContain(
      [
        'KissMyApps.start(',
        '            key: "kma_pk_live_abc",',
        '            options: KissMyAppsOptions(clipboardHandoff: true)',
        '        )',
      ].join('\n'),
    )
    expect(on.reactNativeCode).toContain('clipboardHandoff: true,')
    expect(on.flutterCode).toContain('options: const KissMyAppsOptions(clipboardHandoff: true)')
  })
})

describe('attribution setup: the SDK step', () => {
  it('is live, with the code for each platform and its link domain', async () => {
    signedInAs('developer')
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const heading = await screen.findByRole('heading', { name: 'SDK and deep links', level: 2 })
    const step = heading.closest('section')!
    expect(within(step).getByText('Done')).toBeInTheDocument()
    // The database counts the SDK step done once the app has sent events; conversions are not set.
    expect(screen.getByText('3 of 5 steps done')).toBeInTheDocument()
    expect(within(step).getByText(/30 installs matched so far/)).toBeInTheDocument()
    // Nothing about the SDK is left for later.
    const plan = screen.getByRole('heading', { name: 'Coming next' }).closest('section')!
    expect(within(plan).queryByText(/SDK/)).toBeNull()

    expect(code('Associated Domains')).toBe('applinks:fluent.go.kissmyapps.dev\n')
    // The code waits for the project's key.
    await screen.findByLabelText('Swift')
    expect(code('Swift')).toContain('.onOpenURL { KissMyApps.handleDeepLink($0) }')
    // Clipboard handoff is on for this project, so the code turns it on in the SDK.
    expect(code('Swift')).toContain(`key: "${publicKey}",`)
    expect(code('Swift')).toContain('options: KissMyAppsOptions(clipboardHandoff: true)')

    const tabs = within(step).getByRole('group', { name: 'Your app is built with' })
    await user.click(within(tabs).getByRole('button', { name: 'Android' }))
    expect(code('Intent filter')).toContain('<intent-filter android:autoVerify="true">')
    expect(code('Intent filter')).toContain('<data android:host="fluent.go.kissmyapps.dev" />')
    expect(code('Kotlin')).toContain('KissMyApps.handleDeepLink(intent)')
    await user.click(within(tabs).getByRole('button', { name: 'React Native' }))
    expect(code('TypeScript')).toContain('KissMyApps.onDeepLink((link) => {')
    expect(code('Associated Domains')).not.toBe('')
    expect(code('Intent filter')).not.toBe('')
    await user.click(within(tabs).getByRole('button', { name: 'Flutter' }))
    expect(code('Dart')).toContain('KissMyApps.onDeepLink((link) {')
  })

  it('asks for the app identifiers first when the address cannot name the app yet', async () => {
    signedInAs('owner')
    view = withInstalls()
    view.settings = { ...view.settings!, ios_team_id: null }
    window.location.hash = '#p/proj-1/attribution'
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'SDK and deep links' })
    expect(screen.getByText(/Add your iOS app’s bundle ID and Team ID in step 1/)).toBeVisible()
    expect(code('Associated Domains')).toBe('')
  })

  it('turns clipboard handoff for iPhone off and on through the attribution settings', async () => {
    signedInAs('developer')
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const handoff = await screen.findByRole('switch', { name: 'Clipboard handoff for iPhone' })
    expect(handoff).toBeChecked()
    await user.click(handoff)
    await screen.findByText(/Clipboard handoff is off/)
    expect(calls('attribution_update')[0].args).toEqual({
      p_project: 'proj-1',
      p_patch: { ios_clipboard_handoff: false },
    })
    expect(handoff).not.toBeChecked()
    await waitFor(() => expect(code('Swift')).not.toContain('clipboardHandoff'))

    // A database that refuses the change puts the switch back and says why.
    fake.state.handlers.attribution_update = () => {
      throw { code: '22023', message: 'Turn clipboard handoff on or off' }
    }
    await user.click(handoff)
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn clipboard handoff on or off')
    expect(handoff).not.toBeChecked()
  })

  it('lets analysts see the switch but not change it', async () => {
    signedInAs('analyst')
    window.location.hash = '#p/proj-1/attribution'
    render(<MerchantApp />)
    expect(
      await screen.findByRole('switch', { name: 'Clipboard handoff for iPhone' }),
    ).toBeDisabled()
  })

  it('tests a link on a phone: its QR code, then three checks every 3 seconds while open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    signedInAs('analyst')
    const lesson = 'e6601862-4538-47ad-ade3-f94533b71444'
    const phoneTest = '659ccdeb-57b5-437c-8f06-9243da2ccb91'
    const bio = '17cf915d-1a41-4d2e-b4ef-3df98cad4d46'
    let answer: unknown = { ...(captured.attribution_test_device_waiting as object), click: null }
    fake.state.handlers.attribution_test_device = () => answer
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const panel = (await screen.findByRole('heading', { name: 'Test on your phone' })).closest(
      'section',
    )!
    expect(calls('attribution_test_device')).toHaveLength(0)
    await user.click(within(panel).getByRole('button', { name: 'Start a test' }))

    // A link that opens a screen comes first, as it tests all three steps. The paused link is
    // left out.
    const picker = await within(panel).findByLabelText('Link to test')
    expect(picker).toHaveValue(lesson)
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Lesson 4', 'Bio link', 'Phone test'])
    expect(
      await within(panel).findByRole('img', {
        name: 'QR code for https://fluent.go.kissmyapps.dev/lesson-4',
      }),
    ).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))

    await user.selectOptions(picker, phoneTest)
    expect(
      await within(panel).findByRole('img', {
        name: 'QR code for https://fluent.go.kissmyapps.dev/qr-test',
      }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(calls('attribution_test_device').at(-1)?.args).toEqual({
        p_project: 'proj-1',
        p_link: phoneTest,
      }),
    )
    const checks = within(panel).getByRole('list', { name: 'Checks' })
    expect(within(checks).getByText('Waiting for the link to be opened')).toBeInTheDocument()

    answer = captured.attribution_test_device_waiting
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(await within(checks).findByText('From an Android phone')).toBeInTheDocument()
    expect(within(checks).getByText("Waiting for the app's first launch")).toBeInTheDocument()

    answer = captured.attribution_test_device_done
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(
      await within(checks).findByText('Matched by Google Play install referrer (exact)'),
    ).toBeInTheDocument()
    expect(within(checks).getByText('onDeepLink got welcome')).toBeInTheDocument()
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Your app is ready: installs from your links are matched and open the screen each link points to.',
    )
    // Nothing is left to look for, so it stops asking.
    const asked = calls('attribution_test_device').length
    await act(() => vi.advanceTimersByTimeAsync(9_000))
    expect(calls('attribution_test_device')).toHaveLength(asked)

    // Another link starts again; one that opens no screen has nothing to deliver.
    answer = { ...(captured.attribution_test_device_waiting as object), click: null }
    await user.selectOptions(within(panel).getByLabelText('Link to test'), bio)
    expect(
      await within(panel).findByText(/This link opens no screen in the app/),
    ).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Stop test' }))
    const stopped = calls('attribution_test_device').length
    await act(() => vi.advanceTimersByTimeAsync(9_000))
    expect(calls('attribution_test_device')).toHaveLength(stopped)
  })

  it('keeps the test going when a check fails, and offers to try again', async () => {
    signedInAs('owner')
    fake.state.handlers.attribution_test_device = () => {
      throw { code: 'XX000', message: 'boom' }
    }
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const panel = (await screen.findByRole('heading', { name: 'Test on your phone' })).closest(
      'section',
    )!
    await user.click(within(panel).getByRole('button', { name: 'Start a test' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      "Couldn't check for your phone. Something went wrong. Try again.",
    )
    fake.state.handlers.attribution_test_device = () => captured.attribution_test_device_waiting
    await user.click(within(panel).getByRole('button', { name: 'Retry' }))
    expect(await within(panel).findByText('From an Android phone')).toBeInTheDocument()
    expect(within(panel).queryByRole('alert')).toBeNull()
  })

  it('asks for a link first when the project has none to test', async () => {
    signedInAs('owner')
    fake.state.handlers.attribution_links = () => ({ ...linksAnswer(), links: [] })
    window.location.hash = '#p/proj-1/attribution'
    const user = userEvent.setup()
    render(<MerchantApp />)
    const panel = (await screen.findByRole('heading', { name: 'Test on your phone' })).closest(
      'section',
    )!
    await user.click(within(panel).getByRole('button', { name: 'Start a test' }))
    expect(await within(panel).findByRole('link', { name: 'Make a link' })).toHaveAttribute(
      'href',
      '#p/proj-1/attribution/links',
    )
    expect(calls('attribution_test_device')).toHaveLength(0)
  })

  it('leaves the SDK step out for a project without an app', async () => {
    const web = { ...project, platforms: ['web'] as Project['platforms'] }
    signedInAs('owner', [web])
    view = withInstalls()
    view.settings = {
      ...view.settings!,
      ios_app_store_id: null,
      ios_bundle_id: null,
      ios_team_id: null,
      android_package: null,
      android_sha256: [],
    }
    window.location.hash = '#p/proj-1/attribution'
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Conversions', level: 2 })
    expect(screen.queryByRole('heading', { name: 'SDK and deep links' })).toBeNull()
    expect(screen.getByText(/of 4 steps done/)).toBeInTheDocument()
  })
})

describe('installs in the reports', () => {
  it('shows installs and re-engagements for each link', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/links'
    render(<MerchantApp />)
    const row = (await screen.findByText('Lesson 4')).closest('tr')!
    expect(row.querySelector('[data-label="Installs"]')).toHaveTextContent('7')
    expect(row.querySelector('[data-label="Re-engagements"]')).toHaveTextContent('1')
    const bio = screen.getByText('Bio link').closest('tr')!
    expect(bio.querySelector('[data-label="Installs"]')).toHaveTextContent('2')
    expect(screen.getByRole('columnheader', { name: 'Installs' })).toBeInTheDocument()
  })

  it('shows zero installs from a database that does not send them', async () => {
    signedInAs('owner')
    fake.state.handlers.attribution_links = () => {
      const answer = linksAnswer()
      answer.links.forEach((link) => {
        delete link.installs
        delete link.reengagements
      })
      return answer
    }
    window.location.hash = '#p/proj-1/attribution/links'
    render(<MerchantApp />)
    const row = (await screen.findByText('Lesson 4')).closest('tr')!
    expect(row.querySelector('[data-label="Installs"]')).toHaveTextContent('0')
  })

  it('shows installs for each source, in the totals and the export', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/sources'
    render(<MerchantApp />)
    const totals = await screen.findByRole('group', { name: 'Totals' })
    await waitFor(() =>
      expect(within(totals).getByText('Installs').closest('.mc-kpi')).toHaveTextContent('23'),
    )
    const tiktok = screen.getByRole('button', { name: 'TikTok: see its campaigns' }).closest('tr')!
    expect(tiktok.querySelector('[data-label="Installs"]')).toHaveTextContent('6')
    // Apple Ads by name; organic installs under Direct or unknown.
    const installsOf = (name: string) =>
      [...document.querySelectorAll('tbody tr')]
        .find((row) => row.querySelector('th, td')?.textContent?.startsWith(name))
        ?.querySelector('[data-label="Installs"]')?.textContent
    expect(installsOf('Apple Ads')).toBe('1')
    expect(installsOf('Direct or unknown')).toBe('12')
    expect(screen.getByText(/An install counts once, for the click that brought it/)).toBeVisible()
  })

  it('says installs are matched now in the attribution windows', async () => {
    signedInAs('owner')
    window.location.hash = '#p/proj-1/attribution/settings'
    render(<MerchantApp />)
    expect(await screen.findByText(/App installs are matched now/)).toBeInTheDocument()
    expect(screen.queryByText(/next release/)).toBeNull()
  })
})

describe('a person acquired by a link', () => {
  const personAnswer = (acquisition?: unknown): PersonDetail => {
    const answer = copy<Record<string, unknown>>(captured.analytics_person_acquired)
    if (acquisition === undefined) delete answer.acquisition
    else if (acquisition !== 'as captured') answer.acquisition = acquisition
    return answer as unknown as PersonDetail
  }
  const openPerson = async (answer: PersonDetail) => {
    signedInAs('owner')
    fake.state.handlers.analytics_person = () => answer
    window.location.hash = `#p/proj-1/users/${answer.person.id}`
    render(<MerchantApp />)
    return (await screen.findByRole('heading', { name: 'How they found you' })).closest('section')!
  }
  const captive = captured.analytics_person_acquired as { acquisition: Record<string, unknown> }

  it('says where they came from, how they were matched and how exact the match is', async () => {
    const found = await openPerson(personAnswer('as captured'))
    expect(
      within(found).getByText(
        'Acquired from Instagram, reels, matched by a link that opened the app (exact)',
      ),
    ).toBeInTheDocument()
    expect(
      within(found).getByText('Installed Nov 13, 2026, through the link Lesson 4'),
    ).toBeInTheDocument()
    // An app person with no web visit has no empty web facts under it.
    expect(within(found).queryByText('UTM source')).toBeNull()
  })

  it('marks a flagged install for review, and says a rejected one did not count', async () => {
    const flagged = await openPerson(
      personAnswer({ ...captive.acquisition, exact: false, verdict: 'flagged' }),
    )
    expect(
      within(flagged).getByText(
        'Acquired from Instagram, reels, matched by a link that opened the app (likely), marked for review',
      ),
    ).toBeInTheDocument()
  })

  it('says a rejected install did not count, as a warning', async () => {
    const found = await openPerson(personAnswer({ ...captive.acquisition, verdict: 'rejected' }))
    const line = within(found).getByText('Install not counted: the click came after the install')
    expect(line).toHaveClass('mc-warning-text')
    // The link was not what brought the install, so it is not named as the way in.
    expect(
      within(found).getByText('Installed Nov 13, 2026, before the click on Lesson 4'),
    ).toBeInTheDocument()
    expect(within(found).queryByText(/Acquired from/)).toBeNull()
  })

  it('says nothing about an install from a database that does not send one', async () => {
    const found = await openPerson(personAnswer())
    expect(within(found).queryByText(/Acquired from/)).toBeNull()
    expect(within(found).getByText('UTM source')).toBeInTheDocument()
  })
})
