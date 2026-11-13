import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project, Role } from './api'
import { MerchantApp } from './MerchantApp'
import { programCheckoutBackendFixture as phase8 } from './program-checkout-backend.fixture'
import { programBackendFixture as before } from './program-backend.fixture'

// The program form's Phase 8 sections: how buyers pay (their own checkout or a KissMyApps
// checkout link with one product) and creator promo codes (a buyer discount, and how the codes
// stand on the business's Stripe account). The stand-in for the Supabase client is the one
// programs.apps.test.tsx uses.

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
  return { state, client: { auth, rpc } }
})

vi.mock('../lib/supabase', () => ({
  supabase: fake.client,
  getSupabaseConfigurationIssue: () => null,
  requireSupabaseClient: () => fake.client,
}))

type Row = Record<string, unknown>

const project: Project = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Fluent',
  platforms: ['ios', 'web'],
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

/** A Phase 8 program answer, with parts of its program or of the answer changed. */
function program(name: string, over: Row = {}, top: Row = {}): Row {
  const answer = clone(phase8[name]) as Row & { program: Row }
  return { ...answer, ...top, program: { ...answer.program, ...over } }
}
const checkoutLink = (over: Row = {}, top: Row = {}) =>
  program('workspace_program_get.kma_checkout', over, top)
const ownCheckout = (over: Row = {}, top: Row = {}) =>
  program('workspace_program_get.own_checkout', over, top)

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
    workspace_program_reward_events: { events: [] },
    workspace_program_app_links: { links: [] },
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
const paying = () => screen.getByRole('region', { name: 'How buyers pay' })
const codes = () => screen.getByRole('region', { name: 'Promo codes' })
const mode = (name: 'Your own checkout' | 'KissMyApps checkout link') =>
  within(paying()).getByRole('button', { name })
const codesSwitch = () => within(codes()).getByRole('switch', { name: 'Creator promo codes' })

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.calls = []
  fake.state.context = context()
  answers({})
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('how buyers pay and creator promo codes', () => {
  it('keeps today’s form where the database says nothing of checkout links', async () => {
    await openProgram(before.state_draft)
    expect(screen.queryByRole('region', { name: 'How buyers pay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Promo codes' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Landing page' })).toBeInTheDocument()
  })

  it('opens a checkout-link program on its product, its link and its codes', async () => {
    await openProgram(checkoutLink())
    expect(mode('KissMyApps checkout link')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Product name')).toHaveValue('Fluent Pro')
    expect(screen.getByLabelText('Price')).toHaveValue('9.99')
    expect(
      within(screen.getByRole('group', { name: 'Billed' })).getByRole('button', {
        name: 'Monthly',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Page after payment')).toHaveValue('https://fluent-app.io/welcome')
    // The link is KissMyApps' own address: read, copied, never typed.
    expect(within(paying()).getByText('kissmyapps.dev/checkout/fluent')).toBeInTheDocument()
    expect(within(paying()).queryByRole('textbox', { name: /checkout link/i })).toBeNull()
    expect(within(paying()).getByRole('button', { name: 'Copy checkout link' })).toBeInTheDocument()
    // A checkout link is where creator links send people, so there is no landing page to set.
    expect(screen.queryByRole('region', { name: 'Landing page' })).not.toBeInTheDocument()

    expect(codesSwitch()).toBeChecked()
    expect(within(codes()).getByLabelText('Buyer discount')).toHaveValue('10')
    expect(
      within(codes()).getByText(
        'A new discount retires every creator’s code and makes new ones when you publish, and creators accept the new terms again.',
      ),
    ).toBeInTheDocument()
    expect(
      within(codes()).getByText('No creator has a code yet. Each one gets a code when they join.'),
    ).toBeInTheDocument()
    expect(within(codes()).getByText(/the creator’s code is applied by itself/)).toBeInTheDocument()
    // The preview says what buyers pay and what a code gives them.
    expect(screen.getByText('Fluent Pro, $9.99 a month')).toBeInTheDocument()
    expect(screen.getByText('Buyers get 10% off with a creator’s code')).toBeInTheDocument()
  })

  it('says how many codes are ready, and warns when some could not be made', async () => {
    await openProgram(
      checkoutLink({
        promo_codes: { active: 12, pending: 1, failed: 2, last_error: 'code_taken' },
      }),
    )
    const state = within(codes()).getByRole('status')
    expect(state).toHaveTextContent('12 codes ready, 1 being made')
    expect(state).toHaveTextContent(
      '2 codes could not be made on your Stripe account. A code with that name already exists on your Stripe account. Those creators have been told, and can still share their links.',
    )
    // A reason the console has no words for is not shown as a code.
    expect(codes()).not.toHaveTextContent('code_taken')
  })

  it('leaves the reason out when it has no words for it', async () => {
    await openProgram(
      checkoutLink({
        promo_codes: { active: 0, pending: 0, failed: 1, last_error: 'worker_error' },
      }),
    )
    const state = within(codes()).getByRole('status')
    expect(state).toHaveTextContent('No code is ready yet.')
    expect(state).toHaveTextContent(
      '1 code could not be made on your Stripe account. Those creators have been told',
    )
    expect(codes()).not.toHaveTextContent('worker_error')
  })

  it('moves a program to a checkout link with a discount, and saves only that', async () => {
    const user = await openProgram(ownCheckout(), {
      workspace_program_save: () => checkoutLink({ status: 'draft' }),
    })
    expect(mode('Your own checkout')).toHaveAttribute('aria-pressed', 'true')
    expect(codesSwitch()).not.toBeChecked()
    expect(screen.queryByLabelText('Buyer discount')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Landing page' })).toBeInTheDocument()

    await user.click(mode('KissMyApps checkout link'))
    expect(screen.queryByRole('region', { name: 'Landing page' })).not.toBeInTheDocument()
    expect(within(paying()).getByText('Your checkout link appears here once you save.'))
    await user.type(screen.getByLabelText('Product name'), 'Fluent Pro')
    await user.type(screen.getByLabelText('Price'), '12.50')
    await user.click(
      within(screen.getByRole('group', { name: 'Billed' })).getByRole('button', { name: 'Yearly' }),
    )
    await user.type(screen.getByLabelText('Page after payment'), 'https://fluent.example.test/hi')
    await user.click(codesSwitch())
    await user.type(screen.getByLabelText('Buyer discount'), '15')
    // A draft has no codes yet: they are made when it is published.
    expect(within(codes()).getByText('Codes are made when you publish.')).toBeInTheDocument()

    await user.click(button('Save'))
    await waitFor(() => expect(sent('save')).toHaveLength(1))
    const input = sent('save')[0].p_input as Row
    expect(input).toEqual({
      payment_mode: 'kma_checkout',
      checkout: {
        name: 'Fluent Pro',
        amount_minor: 1250,
        interval: 'year',
        success_url: 'https://fluent.example.test/hi',
      },
      buyer_discount_bps: 1500,
      revision: 1,
    })
    expect(input).not.toHaveProperty('landing_url')
    // The saved answer carries the link the database made.
    expect(await within(paying()).findByText('kissmyapps.dev/checkout/fluent')).toBeInTheDocument()
  })

  it('says what to fix at the field, and sends nothing', async () => {
    const user = await openProgram(checkoutLink())
    const price = screen.getByLabelText('Price')
    await user.clear(price)
    await user.type(price, 'nine')
    const discount = screen.getByLabelText('Buyer discount')
    await user.clear(discount)
    await user.type(discount, '95')
    await user.click(button('Save'))
    expect(await screen.findByText('Enter a price like 9.99, up to 1,000,000.00.')).toBeVisible()
    expect(screen.getByText('Enter a whole percent from 1 to 90.')).toBeVisible()
    expect(discount).toHaveAttribute('aria-invalid', 'true')
    expect(sent('save')).toEqual([])
    // What was typed stays.
    expect(price).toHaveValue('nine')
    expect(discount).toHaveValue('95')
  })

  it('hides both for a program that earns from events only', async () => {
    const user = await openProgram(checkoutLink())
    await user.click(
      within(screen.getByRole('group', { name: 'What do creators earn from?' })).getByRole(
        'button',
        { name: 'Events' },
      ),
    )
    expect(screen.queryByRole('region', { name: 'How buyers pay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Promo codes' })).not.toBeInTheDocument()
    // An event has nothing to pay for, so creator links go to a page of the business's own.
    expect(screen.getByRole('region', { name: 'Landing page' })).toBeInTheDocument()
    expect(screen.getByLabelText('Landing page address')).toHaveValue('')
    await user.click(
      within(screen.getByRole('group', { name: 'What do creators earn from?' })).getByRole(
        'button',
        { name: 'Sales' },
      ),
    )
    // Back on sales, the checkout link is chosen again by the person, not by itself.
    expect(mode('Your own checkout')).toHaveAttribute('aria-pressed', 'true')
    expect(codesSwitch()).not.toBeChecked()
  })

  it('says when the Stripe account cannot take payments for a checkout link', async () => {
    await openProgram(checkoutLink({}, { stripe_charges_enabled: false }))
    expect(
      within(paying()).getByText(/Your Stripe account cannot take payments yet/),
    ).toBeInTheDocument()
    expect(within(paying()).getByRole('link', { name: 'Open Connections' })).toHaveAttribute(
      'href',
      '#connections',
    )
  })

  it('never speaks of test mode', async () => {
    await openProgram(checkoutLink())
    expect(document.body.textContent).not.toMatch(/\btest mode\b|sandbox/i)
  })
})
