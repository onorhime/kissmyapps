import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Project } from './api'
import { MerchantApp } from './MerchantApp'
import { programCheckoutBackendFixture as phase8 } from './program-checkout-backend.fixture'
import { storeBackendFixture as store } from './store-backend.fixture'

// The Sales page with the Phase 8 answers: where each sale was paid (Stripe, the App Store or
// Google Play) and the creator's promo code when the buyer used one. The stand-in for the
// Supabase client is the one sales.test.tsx uses.

const fake = vi.hoisted(() => {
  type Session = { user: { id: string; email: string } } | null
  type Listener = (event: string, session: Session) => void
  const state = {
    session: null as Session,
    listeners: new Set<Listener>(),
    context: null as unknown,
    table: {} as Record<string, unknown>,
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
  const rpc = async (name: string) => {
    if (!name.startsWith('workspace_program_')) return { data: state.context, error: null }
    const value = state.table[name]
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
type Answer = Row & { sales: Row[] }

const project: Project = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Fluent',
  platforms: ['ios', 'android'],
  timezone: 'Europe/London',
  allowed_origins: [],
  replay_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
}

const context: Context = {
  user: { id: 'user-1', email: 'owner@example.test', name: 'Fluent Owner' },
  workspaces: [{ id: 'ws-1', name: 'Fluent Labs', role: 'owner', projects: [project] }],
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The real in-app sales, with the real sales of a code as piece B now lists them. */
function mixed(): Answer {
  const inApp = clone(store['workspace_program_sales.store']) as Answer
  const coded = (clone(phase8['workspace_program_sales.promo']) as Answer).sales.map((sale) => ({
    ...sale,
    source: 'stripe',
    store: null,
    promotion_code: sale.match_source === 'promotion_code' ? 'BEN10' : null,
  }))
  return { ...inApp, sales: [...inApp.sales, ...coded] }
}

async function openSales(list: Answer) {
  fake.state.session = { user: { id: 'user-1', email: 'owner@example.test' } }
  fake.state.table = { workspace_program_sales: list }
  window.location.hash = '#sales'
  render(<MerchantApp />)
  await screen.findByRole('heading', { name: 'Sales', level: 1 })
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Loading your sales' })).not.toBeInTheDocument(),
  )
}

const rowOf = (id: string) => document.querySelector(`[data-sale="${id}"]`) as HTMLElement
/** The Source column's cell of a sale. */
const sourceOf = (id: string) => within(rowOf(id)).getAllByRole('cell')[3]
const channelOf = (id: string) => within(rowOf(id)).getAllByRole('cell')[2]

beforeEach(() => {
  fake.state.session = null
  fake.state.listeners.clear()
  fake.state.context = context
  localStorage.clear()
  window.history.replaceState(null, '', '/?app=merchant')
})

describe('sales page: where each sale was paid', () => {
  it('names the store of an in-app purchase and Stripe for the rest', async () => {
    const list = mixed()
    await openSales(list)
    const ids = list.sales.map((sale) => sale.sale_id as string)
    expect(ids.map((id) => sourceOf(id).textContent)).toEqual([
      'App Store',
      'App Store',
      'App Store',
      'Google Play',
      'Google Play',
      'Stripe',
      'Stripe',
      'Stripe',
    ])
    // The word is a quiet label, never the tool's own code.
    expect(within(sourceOf(ids[0])).getByText('App Store')).toHaveClass('mc-pill')
    expect(document.body.textContent).not.toMatch(/app_store|play_store|revenuecat|adapty/)
  })

  it('shows the creator’s promo code in place of the link it beat', async () => {
    const list = mixed()
    await openSales(list)
    const coded = list.sales.find((sale) => sale.promotion_code === 'BEN10')!
    const channel = channelOf(coded.sale_id as string)
    expect(channel).toHaveTextContent(/^Promo code BEN10/)
    expect(within(channel).getByText('BEN10')).toHaveClass('mc-p8-code-text')
    expect(channel).not.toHaveTextContent('Main link')
    // A sale through a link still names its link.
    const linked = list.sales.find((sale) => sale.source === 'stripe' && !sale.promotion_code)!
    expect(channelOf(linked.sale_id as string)).toHaveTextContent(/^Main link/)
  })

  it('shows nothing about the buyer, and never speaks of test mode', async () => {
    await openSales(mixed())
    expect(document.body.textContent).not.toMatch(/@|\btest mode\b|sandbox/i)
  })
})
