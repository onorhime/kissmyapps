import { describe, expect, it } from 'vitest'
import { readCostImport, readCostRule, readCosts } from './api'
import { attributionCostsBackendFixture as backend } from './attribution-costs-backend.fixture'
import { linkCostTotals } from './roi'

const copy = (value: unknown) => structuredClone(value)
// Ids and times change on every run of the database suite, so only their form is checked.
const ID = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const MOMENT = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/)

// The Costs screen's readers against what the spend functions really return.
describe('spend readers and the real backend answers', () => {
  it('reads typed and uploaded spend, newest day first, each in its own currency', () => {
    const report = readCosts(copy(backend.costs))
    expect(report).toMatchObject({
      currency: 'USD',
      range: '30d',
      from: '2026-10-16',
      to: '2026-11-14',
    })
    expect(report.rows).toHaveLength(7)
    expect(report.rows[0]).toEqual({
      id: ID,
      day: '2026-11-13',
      source: 'facebook',
      campaign: 'spring',
      adset: 'adset-a',
      ad: '',
      amount: 30,
      currency: 'USD',
      origin: 'manual',
      import_id: null,
      updated_at: MOMENT,
    })
    expect(report.rows.map((row) => [row.source, row.amount, row.currency])).toEqual([
      ['facebook', 30, 'USD'],
      ['meta', 98, 'USD'],
      ['snapchat', 10, 'NGN'],
      ['meta', 101, 'USD'],
      ['meta', 15, 'USD'],
      ['tiktok', 60, 'EUR'],
      ['google_ads', 20, 'GBP'],
    ])
    const uploaded = report.rows.filter((row) => row.origin === 'csv')
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].import_id).toBe(report.imports[0].id)
  })

  it('reads the totals in the project currency, with the lines that had no rate counted', () => {
    const { totals } = readCosts(copy(backend.costs))
    expect(totals).toEqual({
      cost: 343.06,
      typed: 320.88,
      uploaded: 15,
      links: 7.18,
      unconverted: 1,
    })
    expect(totals.typed + totals.uploaded + totals.links).toBeCloseTo(totals.cost, 2)
  })

  it('reads uploads, link prices at full precision, and source suggestions', () => {
    const report = readCosts(copy(backend.costs))
    expect(report.imports).toEqual([
      {
        id: ID,
        file_name: 'meta-oct.csv',
        rows: 4,
        created_at: MOMENT,
        remaining: 1,
      },
    ])
    expect(
      report.rules.map((rule) => [rule.link_name, rule.kind, rule.amount, rule.currency]),
    ).toEqual([
      ["Ada's reels", 'install', 2, 'USD'],
      ['Newsletter', 'click', 1, 'USD'],
      ['TikTok bio', 'click', 0.05, 'EUR'],
    ])
    expect(report.rules[1]).toMatchObject({
      link_source: 'email',
      link_campaign: '',
      starts_on: '2026-10-15',
      ends_on: '2026-11-12',
    })
    expect(report.rules[0].ends_on).toBeNull()
    expect(report.sources).toEqual([
      'meta',
      'tiktok',
      'email',
      'google_ads',
      'newsletter',
      'snapchat',
    ])
  })

  it('adds up what each link price cost over the range, by link and currency', () => {
    const report = readCosts(copy(backend.costs))
    expect(report.link_costs).toHaveLength(4)
    expect(report.link_costs[1]).toEqual({
      day: '2026-11-13',
      link_id: ID,
      link_name: 'TikTok bio',
      source: 'tiktok',
      campaign: '',
      kind: 'click',
      count: 3,
      amount: 0.15,
      currency: 'EUR',
    })
    const added = linkCostTotals(report.link_costs)
    const byName = new Map(report.rules.map((rule) => [rule.link_name, added.get(rule.link_id)]))
    expect(byName.get("Ada's reels")).toEqual({ count: 3, amounts: new Map([['USD', 6]]) })
    expect(byName.get('TikTok bio')).toEqual({ count: 3, amounts: new Map([['EUR', 0.15]]) })
    expect(byName.get('Newsletter')).toEqual({ count: 1, amounts: new Map([['USD', 1]]) })
  })

  it('reads a project with no spend yet', () => {
    const report = readCosts(copy(backend.costs_empty))
    expect(report).toEqual({
      currency: 'USD',
      range: '30d',
      from: '2026-10-16',
      to: '2026-11-14',
      rows: [],
      link_costs: [],
      totals: { cost: 0, typed: 0, uploaded: 0, links: 0, unconverted: 0 },
      imports: [],
      rules: [],
      sources: [],
    })
  })

  it('reads an upload that was refused, with each problem by row', () => {
    const result = readCostImport(copy(backend.cost_import_errors))
    expect(result.import_id).toBeNull()
    expect(result.imported).toBe(0)
    expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6, 7])
    expect(result.errors[0]).toEqual({ row: 2, message: 'Day 2026-13-01 is not a date' })
    expect(result.errors[3].message).toBe(
      'Repeats row 1: same day, source, campaign, ad set and ad',
    )
  })

  it('reads an upload that was written', () => {
    const written = readCostImport(copy(backend.cost_import_ok))
    // The upload the list shows is the one this answer wrote.
    expect(written.import_id).toBe(readCosts(copy(backend.costs)).imports[0].id)
    expect(written).toEqual({
      import_id: ID,
      imported: 4,
      replaced: 1,
      errors: [],
    })
  })

  it('reads a saved link price', () => {
    expect(readCostRule(copy(backend.cost_rule))).toEqual({
      id: ID,
      link_id: ID,
      link_name: "Ada's reels",
      link_source: 'instagram',
      link_campaign: 'ada-reels',
      kind: 'install',
      amount: 2,
      currency: 'USD',
      starts_on: '2026-11-12',
      ends_on: null,
      updated_at: MOMENT,
    })
  })
})
