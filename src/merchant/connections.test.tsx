import { StrictMode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import {
  browser,
  claimStripeReturn,
  ConnectError,
  describeProblem,
  fallbackMessages,
  formatDay,
  formatWhen,
  problemMessages,
  readAuthorizationUrl,
  readStatus,
  readStripeReturn,
  returnMessages,
} from './connections'
import type { StripeStatus } from './connections'
import { MerchantApp } from './MerchantApp'
import { href, parseRoute } from './routes'

type Body = Record<string, unknown>
/** What the function sends back for a failed request: the repo's { error, message, request_id }. */
class Refusal {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    this.status = status
    this.code = code
  }
}

// A stand-in for the Supabase client: auth with listeners, the two context rpcs, and the
// workspace-stripe-connect function answered per action.
const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    context: null as unknown,
    answer: (() => {
      throw new Error('No answer set')
    }) as (body: Record<string, unknown>) => unknown,
    calls: [] as Array<{ name: string; body: Record<string, unknown> }>,
  }
  const emit = (event: string) =>
    state.listeners.forEach((listener) => listener(event, state.session))
  const auth = {
    onAuthStateChange(listener: Listener) {
      state.listeners.add(listener)
      setTimeout(() => listener('INITIAL_SESSION', state.session), 0)
      return { data: { subscription: { unsubscribe: () => state.listeners.delete(listener) } } }
    },
    async signInWithPassword({ email }: { email: string; password: string }) {
      state.session = { user: { id: 'user-1', email } }
      emit('SIGNED_IN')
      return { error: null }
    },
    async signOut() {
      state.session = null
      emit('SIGNED_OUT')
      return { error: null }
    },
  }
  const rpc = async () => ({ data: state.context, error: null })
  const functions = {
    async invoke(name: string, options: { body: Record<string, unknown> }) {
      state.calls.push({ name, body: options.body })
      try {
        return { data: await state.answer(options.body), error: null }
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

const context = (role: Role): Context => ({
  user: { id: 'user-1', email: 'victory@example.com', name: 'Victory Onorhime' },
  workspaces: [{ id: 'ws-1', name: 'No Brainer Lab', role, projects: [project] }],
})

const connection = {
  status: 'active',
  account_id: 'acct_1QabcSpeakSix4f2Q',
  business_name: 'SpeakSix Ltd',
  country: 'GB',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  connected_at: '2026-11-13T12:00:00Z',
}

const status = (over: Partial<StripeStatus> = {}): StripeStatus => ({
  enabled: true,
  workspace_id: 'ws-1',
  can_manage: true,
  connection: null,
  payments: { seen: 0, tagged: 0, last_at: null, last_tagged_at: null },
  ...over,
})

const STATE = 'state_0123456789abcdefghijklmnopqrstuvwxyzAB'
const AUTHORIZE = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_1&scope=read_write&state=${STATE}`

function signedInAs(role: Role) {
  fake.state.session = { user: { id: 'user-1', email: 'victory@example.com' } }
  fake.state.context = context(role)
}

/** Answers each action from a table; a Refusal is thrown as the function's error answer. */
function answers(table: Record<string, unknown | (() => unknown)>) {
  fake.state.answer = (body: Body) => {
    const answer = table[String(body.action)]
    const value = typeof answer === 'function' ? (answer as () => unknown)() : answer
    if (value === undefined) throw new Error(`No answer for ${String(body.action)}`)
    if (value instanceof Refusal || value instanceof Error) throw value
    return value
  }
}

const sent = (action: string) =>
  fake.state.calls.filter((call) => call.body.action === action).map((call) => call.body)

async function openConnections() {
  window.location.hash = '#connections'
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Connections', level: 1 })
  return screen.getByRole('region', { name: 'Stripe' })
}

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.context = context('owner')
  answers({ status: status() })
  claimStripeReturn()
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('connections route', () => {
  it('lives at #connections', () => {
    expect(parseRoute('#connections')).toEqual({ name: 'connections' })
    expect(parseRoute('#/connections')).toEqual({ name: 'connections' })
    expect(href({ name: 'connections' })).toBe('#connections')
    expect(parseRoute(href({ name: 'connections' }))).toEqual({ name: 'connections' })
  })

  it('has its own entry in the menu, marked while open', async () => {
    signedInAs('owner')
    await openConnections()
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    const link = within(nav).getByRole('link', { name: 'Connections' })
    expect(link).toHaveAttribute('href', '#connections')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(document.title).toContain('Connections')
    // The project the person was in keeps its menu.
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })
})

describe('reading the answer from Stripe', () => {
  it('takes an approval out of the query and keeps every other parameter', () => {
    expect(
      readStripeReturn(`?app=merchant&code=ac_123&state=${STATE}&scope=read_write&utm=x`),
    ).toEqual({
      result: { kind: 'approved', state: STATE, code: 'ac_123' },
      search: '?app=merchant&utm=x',
    })
    expect(readStripeReturn(`?code=ac_123&state=${STATE}`)?.search).toBe('')
  })

  it('tells a decline from any other failure', () => {
    expect(
      readStripeReturn(`?error=access_denied&error_description=Denied&state=${STATE}`)?.result,
    ).toEqual({ kind: 'declined' })
    expect(readStripeReturn(`?error=invalid_scope&state=${STATE}`)?.result).toEqual({
      kind: 'failed',
    })
  })

  it('leaves Supabase Auth returns and unrelated queries alone', () => {
    expect(readStripeReturn('?app=merchant')).toBeNull()
    expect(readStripeReturn('?code=pkce-code-from-supabase')).toBeNull()
    expect(
      readStripeReturn(`?error=access_denied&error_code=otp_expired&state=${STATE}`),
    ).toBeNull()
    expect(readStripeReturn('?code=ac_123&state=short')).toBeNull()
    expect(readStripeReturn(`?state=${STATE}`)).toBeNull()
  })
})

describe('reading answers from the function', () => {
  it('fills what a switched-off answer leaves out', () => {
    expect(readStatus({ enabled: false }, 'ws-9')).toEqual(
      status({ enabled: false, workspace_id: 'ws-9', can_manage: false }),
    )
  })

  it('refuses an answer it cannot trust', () => {
    expect(() => readStatus(null, 'ws-1')).toThrow(ConnectError)
    expect(() => readStatus({ enabled: 'yes' }, 'ws-1')).toThrow(ConnectError)
    expect(() =>
      readStatus({ enabled: true, connection: { account_id: 'not-an-account' } }, 'ws-1'),
    ).toThrow(ConnectError)
  })

  it('only opens the Stripe authorisation page', () => {
    expect(readAuthorizationUrl({ authorization_url: AUTHORIZE })).toBe(AUTHORIZE)
    for (const url of [
      'https://connect.stripe.com.evil.test/oauth/authorize?x=1',
      'http://connect.stripe.com/oauth/authorize',
      'https://connect.stripe.com/other',
      'javascript:alert(1)',
      undefined,
    ])
      expect(() => readAuthorizationUrl({ authorization_url: url })).toThrow(ConnectError)
  })
})

describe('what each failure says', () => {
  const contractCodes = [
    'console_connect_disabled',
    'not_a_member',
    'owner_or_admin_required',
    'stripe_account_in_use',
    'stripe_account_not_ready',
    'stripe_not_live',
    'connection_in_use',
    'state_invalid',
    // Passed through from the Stripe provider.
    'merchant_provider_disabled',
    'merchant_provider_unavailable',
    'merchant_connection_rejected',
    'merchant_scope_mismatch',
    'merchant_account_ineligible',
  ]

  it.each(contractCodes)('%s has its own plain message', (code) => {
    const problem = describeProblem(new ConnectError(code, 'From the server.', 409), 'complete')
    expect(problem.message).toBe(problemMessages[code].message)
    expect(problem.message).not.toMatch(/From the server|_/)
    expect(problem.message.length).toBeGreaterThan(20)
  })

  it('never speaks of test mode, sandboxes or test accounts', () => {
    const everything = [...Object.values(problemMessages), ...Object.values(fallbackMessages)].map(
      (item) => item.message,
    )
    for (const message of [...everything, ...Object.values(returnMessages)])
      expect(message).not.toMatch(/test|sandbox/i)
  })

  it('falls back by what the person was doing, and by the HTTP status', () => {
    expect(describeProblem(new ConnectError('something_new', '', 500), 'load')).toEqual({
      code: 'something_new',
      ...fallbackMessages.load,
    })
    expect(describeProblem(new Error('boom'), 'disconnect').message).toBe(
      fallbackMessages.disconnect.message,
    )
    expect(describeProblem(new ConnectError('http_401', '', 401), 'load').recovery).toBe('sign-in')
    expect(describeProblem(new ConnectError('http_429', '', 429), 'start').message).toBe(
      problemMessages.rate_limited.message,
    )
    expect(describeProblem(new ConnectError('database_boundary_error', '', 503), 'load')).toEqual({
      code: 'database_boundary_error',
      ...problemMessages.unavailable,
    })
  })

  it('never offers to run a completion again', () => {
    for (const code of [...Object.keys(problemMessages), 'something_new'])
      expect(describeProblem(new ConnectError(code, '', 500), 'complete').recovery).not.toBe(
        'retry',
      )
  })
})

describe('dates on the page', () => {
  it('writes days and recent times the way people say them', () => {
    const now = new Date(2026, 10, 13, 15, 0).getTime()
    const at = (...parts: [number, number, number, number, number]) =>
      new Date(...parts).toISOString()
    expect(formatDay(at(2026, 10, 13, 12, 0))).toBe('13 Nov 2026')
    expect(formatWhen(at(2026, 10, 13, 9, 42), now)).toBe('Today, 09:42')
    expect(formatWhen(at(2026, 10, 12, 18, 5), now)).toBe('Yesterday, 18:05')
    expect(formatWhen(at(2026, 10, 3, 14, 20), now)).toBe('3 Nov, 14:20')
    expect(formatWhen(at(2025, 10, 3, 14, 20), now)).toBe('3 Nov 2025')
  })
})

describe('connections page', () => {
  it('keeps its frame while the connection loads', async () => {
    signedInAs('owner')
    fake.state.answer = () => new Promise(() => {})
    const stripe = await openConnections()
    expect(within(stripe).getByRole('status', { name: 'Loading your Stripe connection' }))
    expect(stripe).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('button', { name: 'Connect Stripe' })).not.toBeInTheDocument()
    // The tools that once were promised as coming soon are cards of their own now (Phase 8;
    // connections.tools.test.tsx), and nothing is promised for later any more.
    expect(screen.queryByRole('region', { name: 'More connections' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Analytics tools' })).not.toBeInTheDocument()
    for (const tool of ['RevenueCat', 'Adapty', 'Amplitude'])
      expect(screen.getByRole('heading', { name: tool, level: 2 })).toBeInTheDocument()
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument()
    expect(sent('status')).toEqual([{ action: 'status', workspace_id: 'ws-1' }])
    expect(fake.state.calls[0].name).toBe('workspace-stripe-connect')
  })

  it('offers nothing to press while the feature is switched off', async () => {
    signedInAs('owner')
    answers({ status: { enabled: false } })
    const stripe = await openConnections()
    expect(await within(stripe).findByText('Coming soon')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
  })

  it('gives an owner one sentence and one action when Stripe is not connected', async () => {
    signedInAs('owner')
    const stripe = await openConnections()
    expect(await within(stripe).findByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
    expect(within(stripe).getByText(/Connect the Stripe account your customers pay into/))
    expect(within(stripe).getAllByRole('button')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/test mode|sandbox|test account/i)
  })

  it.each(['admin'] as Role[])('lets an %s connect too', async (role) => {
    signedInAs(role)
    const stripe = await openConnections()
    expect(await within(stripe).findByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
  })

  it.each(['developer', 'analyst'] as Role[])(
    'shows a %s the row without the action, and says who can connect',
    async (role) => {
      signedInAs(role)
      answers({ status: status({ can_manage: false }) })
      const stripe = await openConnections()
      expect(
        await within(stripe).findByText(
          'Only an owner or admin of No Brainer Lab can connect Stripe.',
        ),
      ).toBeInTheDocument()
      expect(within(stripe).getByText(/Connect the Stripe account your customers pay into/))
      expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
    },
  )

  it('shows a connected account waiting for its first payment', async () => {
    signedInAs('owner')
    answers({ status: status({ connection }) })
    const stripe = await openConnections()
    expect(await within(stripe).findByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(within(stripe).getByText('SpeakSix Ltd')).toBeInTheDocument()
    expect(within(stripe).getByText('United Kingdom')).toBeInTheDocument()
    expect(within(stripe).getByText('13 Nov 2026')).toBeInTheDocument()
    // The account is recognisable without printing its whole id.
    expect(within(stripe).getByText('Account').nextSibling).toHaveTextContent('acct_••••4f2Q')
    expect(stripe.textContent).not.toContain(connection.account_id)
    expect(within(stripe).getByText('Waiting for your first payment')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button', { name: 'Connect Stripe' })).toBeNull()
  })

  it('says when payments are seen but none came from a creator link', async () => {
    signedInAs('owner')
    answers({
      status: status({
        connection,
        payments: { seen: 1248, tagged: 0, last_at: '2025-03-04T12:00:00Z', last_tagged_at: null },
      }),
    })
    const stripe = await openConnections()
    expect((await within(stripe).findByText('Payments seen')).nextSibling).toHaveTextContent(
      '1,248',
    )
    expect(within(stripe).getByText('Last payment').nextSibling).toHaveTextContent('4 Mar 2025')
    expect(within(stripe).getByText('From creator links').nextSibling).toHaveTextContent('None yet')
    expect(within(stripe).queryByText('Waiting for your first payment')).toBeNull()
  })

  it('shows the last payment that came from a creator link, with its date', async () => {
    signedInAs('owner')
    answers({
      status: status({
        connection,
        payments: {
          seen: 48,
          tagged: 7,
          last_at: '2025-03-09T12:00:00Z',
          last_tagged_at: '2025-03-04T12:00:00Z',
        },
      }),
    })
    const stripe = await openConnections()
    expect((await within(stripe).findByText('Payments seen')).nextSibling).toHaveTextContent('48')
    expect(within(stripe).getByText('From creator links').nextSibling).toHaveTextContent('7')
    expect(within(stripe).getByText('Last creator sale').nextSibling).toHaveTextContent(
      '4 Mar 2025',
    )
  })

  it('shows a connected account to a developer without the way to disconnect it', async () => {
    signedInAs('developer')
    answers({ status: status({ connection, can_manage: false }) })
    const stripe = await openConnections()
    expect(await within(stripe).findByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
  })

  it('says so when Stripe has paused payments on the connected account', async () => {
    signedInAs('owner')
    answers({ status: status({ connection: { ...connection, charges_enabled: false } }) })
    const stripe = await openConnections()
    expect(
      await within(stripe).findByText(/Connected, but Stripe has paused payments on this account/),
    ).toBeInTheDocument()
    expect(within(stripe).getByRole('link', { name: 'Open Stripe' })).toHaveAttribute(
      'href',
      'https://dashboard.stripe.com/',
    )
    expect(within(stripe).queryByText('Connected. Watching for sales.')).toBeNull()
  })

  it('explains a request that never arrived and loads again on Retry', async () => {
    signedInAs('owner')
    let reachable = false
    answers({ status: () => (reachable ? status() : new TypeError('Failed to fetch')) })
    const user = userEvent.setup()
    const stripe = await openConnections()
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    expect(within(stripe).queryByRole('button', { name: 'Connect Stripe' })).toBeNull()
    reachable = true
    await user.click(within(stripe).getByRole('button', { name: 'Retry' }))
    expect(await within(stripe).findByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
    expect(within(stripe).queryByRole('alert')).toBeNull()
  })

  it('says offline when the browser is, and loads by itself once it is back', async () => {
    signedInAs('owner')
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    answers({ status: () => (online.mock.results.at(-1)?.value ? status() : new TypeError('x')) })
    const stripe = await openConnections()
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'You are offline. Reconnect to the internet and try again.',
    )
    online.mockReturnValue(true)
    answers({ status: status() })
    window.dispatchEvent(new Event('online'))
    expect(await within(stripe).findByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
  })

  it('offers to sign in again when the session has expired', async () => {
    signedInAs('owner')
    answers({ status: new Refusal(401, 'unauthorized') })
    const user = userEvent.setup()
    const stripe = await openConnections()
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'Your session has expired. Sign in again to continue.',
    )
    await user.click(within(stripe).getByRole('button', { name: 'Sign in again' }))
    await screen.findByRole('heading', { name: 'Sign in to your merchant workspace' })
  })
})

describe('connecting Stripe', () => {
  it('asks the function for the Stripe page and sends the browser there', async () => {
    signedInAs('owner')
    answers({ status: status(), start: { authorization_url: AUTHORIZE } })
    const leave = vi.spyOn(browser, 'leaveFor').mockImplementation(() => {})
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Connect Stripe' }))
    await waitFor(() => expect(leave).toHaveBeenCalledWith(AUTHORIZE))
    expect(leave).toHaveBeenCalledTimes(1)
    expect(sent('start')).toEqual([{ action: 'start', workspace_id: 'ws-1' }])
    // Until the browser has left, the card says where it is going and cannot be pressed twice.
    expect(within(stripe).getByRole('button', { name: 'Opening Stripe' })).toBeDisabled()
  })

  it('does not follow an address that is not Stripe', async () => {
    signedInAs('owner')
    answers({ status: status(), start: { authorization_url: 'https://stripe.evil.test/oauth' } })
    const leave = vi.spyOn(browser, 'leaveFor').mockImplementation(() => {})
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Connect Stripe' }))
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'Stripe could not be opened. Try again.',
    )
    expect(leave).not.toHaveBeenCalled()
    expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
  })

  it('turns read-only when the server says this person may not connect', async () => {
    signedInAs('owner')
    answers({ status: status(), start: new Refusal(403, 'owner_or_admin_required') })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Connect Stripe' }))
    expect(
      await within(stripe).findByText(
        'Only an owner or admin of No Brainer Lab can connect Stripe.',
      ),
    ).toBeInTheDocument()
    expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
  })

  it('stops offering the action once the server says the feature is off', async () => {
    signedInAs('owner')
    answers({ status: status(), start: new Refusal(503, 'console_connect_disabled') })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Connect Stripe' }))
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'Connecting Stripe is not available yet.',
    )
    expect(within(stripe).getByText('Coming soon')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('coming back from Stripe', () => {
  const returned = `/?app=merchant&code=ac_123&state=${STATE}&scope=read_write`

  it('completes the connection once, cleans the address and shows it connected', async () => {
    signedInAs('owner')
    let finish: (value: StripeStatus) => void = () => {}
    const completed = new Promise<StripeStatus>((resolve) => (finish = resolve))
    answers({ status: status(), complete: () => completed })
    window.history.replaceState(null, '', returned)
    // StrictMode runs effects twice, which is where a second completion would slip in.
    render(
      <StrictMode>
        <MerchantApp />
      </StrictMode>,
    )
    // The code and state are out of the address before anything is drawn; ?app=merchant stays.
    expect(window.location.search).toBe('?app=merchant')
    expect(window.location.hash).toBe('#connections')
    const stripe = await screen.findByRole('region', { name: 'Stripe' })
    expect(within(stripe).getByText('Finishing your Stripe connection')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button')).not.toBeInTheDocument()
    finish(status({ connection }))
    expect(await within(stripe).findByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(within(stripe).getByText('SpeakSix Ltd')).toBeInTheDocument()
    expect(sent('complete')).toEqual([{ action: 'complete', state: STATE, code: 'ac_123' }])
    // No status read raced the completion and overwrote it.
    expect(sent('status')).toEqual([])
    expect(window.location.href).not.toMatch(/ac_123|state_/)
  })

  it('lets a signed-out visitor sign in first, then completes', async () => {
    fake.state.context = context('owner')
    answers({ status: status(), complete: status({ connection }) })
    window.history.replaceState(null, '', returned)
    const user = userEvent.setup()
    render(<MerchantApp />)
    await screen.findByRole('heading', { name: 'Sign in to your merchant workspace' })
    expect(window.location.search).toBe('?app=merchant')
    expect(fake.state.calls).toEqual([])

    await user.type(screen.getByLabelText('Work email'), 'victory@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByRole('heading', { name: 'Connections', level: 1 })
    expect(await screen.findByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(window.location.hash).toBe('#connections')
    expect(sent('complete')).toEqual([{ action: 'complete', state: STATE, code: 'ac_123' }])
  })

  it('says a decline plainly and still offers to connect', async () => {
    signedInAs('owner')
    window.history.replaceState(
      null,
      '',
      `/?app=merchant&error=access_denied&error_description=The+user+denied+your+request&state=${STATE}`,
    )
    render(<MerchantApp />)
    const stripe = await screen.findByRole('region', { name: 'Stripe' })
    expect(
      await within(stripe).findByText('You cancelled on Stripe, so nothing was connected.'),
    ).toBeInTheDocument()
    expect(await within(stripe).findByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
    expect(within(stripe).queryByRole('alert')).toBeNull()
    expect(window.location.search).toBe('?app=merchant')
    expect(sent('complete')).toEqual([])
  })

  it.each([
    ['state_invalid', 403],
    ['stripe_account_in_use', 409],
    ['stripe_account_not_ready', 409],
    ['stripe_not_live', 409],
    ['merchant_provider_unavailable', 502],
    ['merchant_connection_rejected', 502],
    ['merchant_account_ineligible', 409],
    ['merchant_scope_mismatch', 409],
  ] as Array<[string, number]>)(
    'explains %s and leaves Connect Stripe as the way on',
    async (code, http) => {
      signedInAs('owner')
      answers({ status: status(), complete: new Refusal(http, code) })
      window.history.replaceState(null, '', returned)
      render(<MerchantApp />)
      const stripe = await screen.findByRole('region', { name: 'Stripe' })
      expect(await within(stripe).findByRole('alert')).toHaveTextContent(
        problemMessages[code].message,
      )
      expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
      // A completion is never sent a second time.
      expect(within(stripe).queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(sent('complete')).toHaveLength(1)
      expect(within(stripe).queryAllByRole('link', { name: 'Open Stripe' })).toHaveLength(
        code === 'stripe_account_not_ready' ? 1 : 0,
      )
    },
  )

  it('checks before complaining when the completion got no clear answer', async () => {
    signedInAs('owner')
    // The answer was lost, but the connection was made.
    answers({ status: status({ connection }), complete: new Refusal(500, 'internal_error') })
    window.history.replaceState(null, '', returned)
    render(<MerchantApp />)
    const stripe = await screen.findByRole('region', { name: 'Stripe' })
    expect(await within(stripe).findByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(within(stripe).queryByRole('alert')).toBeNull()
    expect(sent('complete')).toHaveLength(1)
  })

  it('says so when the completion failed and nothing is connected', async () => {
    signedInAs('owner')
    answers({ status: status(), complete: new TypeError('Failed to fetch') })
    window.history.replaceState(null, '', returned)
    render(<MerchantApp />)
    const stripe = await screen.findByRole('region', { name: 'Stripe' })
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      fallbackMessages.complete.message,
    )
    expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
    expect(sent('complete')).toHaveLength(1)
  })
})

describe('disconnecting Stripe', () => {
  const live = status({
    connection,
    payments: {
      seen: 12,
      tagged: 3,
      last_at: '2025-03-09T12:00:00Z',
      last_tagged_at: '2025-03-04T12:00:00Z',
    },
  })

  it('asks first, saying what stops, and can be backed out of', async () => {
    signedInAs('owner')
    answers({ status: live })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Stripe?' })
    expect(dialog).toHaveTextContent(
      'KissMyApps will stop seeing sales from SpeakSix Ltd, so new sales can no longer be matched to creators. Your customers can still pay you as usual.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Keep connected' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(sent('disconnect')).toEqual([])
    expect(within(stripe).getByText('Connected. Watching for sales.')).toBeInTheDocument()
  })

  it('disconnects after the confirmation and offers to connect again', async () => {
    signedInAs('owner')
    answers({ status: live, disconnect: status() })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Stripe?' })
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect Stripe' }))
    expect(
      await within(stripe).findByText(
        'Stripe is disconnected. KissMyApps no longer sees your sales.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sent('disconnect')).toEqual([{ action: 'disconnect', workspace_id: 'ws-1' }])
    expect(within(stripe).getByRole('button', { name: 'Connect Stripe' })).toBeEnabled()
    expect(within(stripe).queryByText('Connected. Watching for sales.')).toBeNull()
  })

  it('keeps the connection and explains when products are still sold through it', async () => {
    signedInAs('owner')
    answers({ status: live, disconnect: new Refusal(409, 'connection_in_use') })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Stripe?' })
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect Stripe' }))
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'Stripe cannot be disconnected while products are still sold through it. Ask KissMyApps to move those products first.',
    )
    expect(within(stripe).getByText('Connected. Watching for sales.')).toBeInTheDocument()
    expect(within(stripe).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers Retry when the request to disconnect did not get through', async () => {
    signedInAs('owner')
    let reachable = false
    answers({
      status: live,
      disconnect: () => (reachable ? status() : new TypeError('Failed to fetch')),
    })
    const user = userEvent.setup()
    const stripe = await openConnections()
    await user.click(await within(stripe).findByRole('button', { name: 'Disconnect' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect Stripe' }),
    )
    expect(await within(stripe).findByRole('alert')).toHaveTextContent(
      'KissMyApps could not be reached. Check your connection and try again.',
    )
    reachable = true
    await user.click(within(stripe).getByRole('button', { name: 'Retry' }))
    expect(
      await within(stripe).findByText(
        'Stripe is disconnected. KissMyApps no longer sees your sales.',
      ),
    ).toBeInTheDocument()
  })
})
