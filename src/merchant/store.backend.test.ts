import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_HEADER_VALUE, storeBackendFixture as store } from './store-backend.fixture'
import { ProgramError } from './programs'
import { readStoreConnections, readStoreWebhook, webhookAddress } from './api'
import { readSales, saleSource } from './sales'

type Body = Record<string, unknown>
const answer = (name: string) => structuredClone(store[name]) as Body
const unreadable = expect.objectContaining({ code: 'response_unreadable' })

// The in-app purchase readers against what the Phase 8 database functions really return
// (suite 91_program_store_sales.sql).
describe('in-app purchase readers and the real backend answers', () => {
  it('reads the connections of a workspace, and who may change them', () => {
    const read = readStoreConnections(answer('workspace_store_connections.listed'))
    expect(read.can_manage).toBe(true)
    expect(read.projects).toEqual([
      { id: 'beb8b9da-c1bd-441b-9121-de3aab813c8a', name: 'Fluent' },
      { id: '94c63271-48af-4421-95fc-ed003f334262', name: 'Fluent web' },
    ])
    expect(read.connections.map((item) => item.provider)).toEqual(['adapty', 'revenuecat'])
    expect(read.connections[1]).toEqual({
      id: 'bda11dea-8371-4252-826a-f0364f6c92b2',
      provider: 'revenuecat',
      project_id: 'beb8b9da-c1bd-441b-9121-de3aab813c8a',
      project_name: 'Fluent',
      status: 'active',
      created_at: '2026-11-13T22:01:42.335812+00:00',
      last_event_at: '2026-11-13T22:01:42.774319+00:00',
      events_30d: 15,
      sales_30d: 4,
      ignored_30d: 8,
      webhook_url:
        'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/revenuecat',
    })
    // The header value is never in the list, so nothing of it is kept.
    expect(JSON.stringify(read)).not.toMatch(/Bearer/)
  })

  it('lists live connections only: a removed one is history', () => {
    const read = readStoreConnections(answer('workspace_store_connections.three_apps'))
    expect(read.connections.map((item) => item.project_name)).toEqual(['Fluent', 'SpeakSix'])
    expect(read.connections.every((item) => item.status === 'active')).toBe(true)
    expect(read.projects.map((item) => item.name)).toEqual(['Fluent', 'SpeakSix', 'DuoFlash'])
    // An answer that does not say who may change them leaves it to the person's role.
    expect(read).not.toHaveProperty('can_manage')
  })

  it('reads what connecting answers: the address and the header value, shown once', () => {
    const made = readStoreWebhook(answer('workspace_store_connection_create.revenuecat'))
    expect(made.webhook_url).toBe(
      'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/revenuecat',
    )
    expect(made.header_value).toBe(PLACEHOLDER_HEADER_VALUE)
    expect(made.connection).toMatchObject({
      id: 'bda11dea-8371-4252-826a-f0364f6c92b2',
      provider: 'revenuecat',
      project_name: 'Fluent',
      status: 'active',
      last_event_at: null,
    })
    // The same answer with the connection under its own key reads the same.
    const { webhook_url, header_value, ...connection } = answer(
      'workspace_store_connection_create.revenuecat',
    )
    expect(readStoreWebhook({ connection, webhook_url, header_value })).toEqual(made)
  })

  it('refuses a header value or an address that could not be pasted as it is', () => {
    const made = answer('workspace_store_connection_create.revenuecat')
    for (const header_value of [
      null,
      '',
      'K'.repeat(43),
      'Bearer short',
      'Bearer has spaces in it',
    ])
      expect(() => readStoreWebhook({ ...made, header_value })).toThrow(unreadable)
    for (const webhook_url of [
      null,
      '/functions/v1/program-store-webhook/revenuecat',
      'http://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/revenuecat',
      'https://mmyruzjemjecqyivhrgr.supabase.co/',
      'https://someone@mmyruzjemjecqyivhrgr.supabase.co/functions/v1/program-store-webhook/x',
      'not an address',
    ])
      expect(() => readStoreWebhook({ ...made, webhook_url })).toThrow(unreadable)
    expect(webhookAddress(' https://example.test/hook ')).toBe('https://example.test/hook')
  })

  it('refuses a list whose connections cannot be read', () => {
    const listed = answer('workspace_store_connections.listed') as {
      connections: Body[]
    } & Body
    const broken = (change: Body) => ({
      ...listed,
      connections: [{ ...listed.connections[0], ...change }],
    })
    for (const value of [
      { connections: [] },
      { ...listed, can_manage: 'yes' },
      broken({ provider: 'stripe' }),
      broken({ status: 'paused' }),
      broken({ events_30d: -1 }),
      broken({ sales_30d: '4' }),
      broken({ last_event_at: 'yesterday' }),
      broken({ id: '' }),
    ])
      expect(() => readStoreConnections(value)).toThrow(ProgramError)
    // A connection without its app's name takes it from the projects.
    const nameless = broken({ project_name: null })
    expect(readStoreConnections(nameless).connections[0].project_name).toBe('Fluent')
  })

  it('reads the sales of in-app purchases: the tool, the store and no code', () => {
    const state = readSales(answer('workspace_program_sales.store'))
    expect(state.sales).toHaveLength(5)
    expect(state.sales.map((sale) => [sale.source, sale.store, saleSource(sale)])).toEqual([
      ['revenuecat', 'app_store', 'App Store'],
      ['revenuecat', 'app_store', 'App Store'],
      ['revenuecat', 'app_store', 'App Store'],
      ['adapty', 'play_store', 'Google Play'],
      ['revenuecat', 'play_store', 'Google Play'],
    ])
    expect(state.sales.every((sale) => sale.promotion_code === null)).toBe(true)
    // A store the page has no word for is named by the tool that reported it.
    expect(saleSource({ source: 'adapty', store: 'other' })).toBe('Adapty')
    expect(saleSource({ source: 'revenuecat', store: null })).toBe('RevenueCat')
    expect(saleSource({ source: 'revenuecat', store: 'amazon' })).toBe('Amazon Appstore')
    expect(saleSource({ source: 'stripe', store: 'stripe' })).toBe('Stripe')
    expect(saleSource({ source: null, store: null })).toBeNull()
  })

  it('keeps a promo code only when it is one, and a source it has words for', () => {
    const state = answer('workspace_program_sales.store') as { sales: Body[] } & Body
    const row = state.sales[0]
    const read = readSales({
      ...state,
      sales: [
        { ...row, sale_id: 'a', source: 'stripe', store: null, promotion_code: 'BEN10' },
        { ...row, sale_id: 'b', promotion_code: 'ben 10; drop' },
        { ...row, sale_id: 'c', source: 'paddle' },
      ],
    })
    expect(read.sales.map((sale) => [sale.source, sale.promotion_code])).toEqual([
      ['stripe', 'BEN10'],
      ['revenuecat', null],
      [null, null],
    ])
  })
})
