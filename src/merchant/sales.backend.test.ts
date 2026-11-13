import { describe, expect, it } from 'vitest'
import { readCreators } from './creators'
import { linksBackendFixture as backend } from './links-backend.fixture'
import { hasCommission, readSales, saleStatus, withNextPage } from './sales'

// The merchant Sales and Creators readers against what the database functions really return.
describe('merchant sales and the real backend answers', () => {
  it('reads the first page with the summary of the last 30 days', () => {
    const page = readSales(backend.workspace_program_sales_first_page)
    expect(page.program).toMatchObject({ slug: 'speaksix', name: 'SpeakSix', status: 'live' })
    expect(page.currency).toBe('USD')
    expect(page.summary).toEqual({
      days: 30,
      sales: 5,
      sales_amount_minor: 26900,
      commission_minor: 6870,
      fee_minor: 687,
    })
    expect(page.sales).toHaveLength(5)
    expect(page.next_before).not.toBeNull()
    const times = page.sales.map((sale) => Date.parse(sale.paid_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('joins the pages into the whole list without a sale twice', () => {
    const first = readSales(backend.workspace_program_sales_first_page)
    const second = readSales(backend.workspace_program_sales_next_page)
    const last = readSales(backend.workspace_program_sales_last_page)
    const all = withNextPage(withNextPage(first, second), last)
    const whole = readSales(backend.workspace_program_sales_all_statuses)
    expect(all.sales.map((sale) => sale.sale_id)).toEqual(whole.sales.map((sale) => sale.sale_id))
    expect(new Set(all.sales.map((sale) => sale.sale_id)).size).toBe(12)
    expect(all.next_before).toBeNull()
  })

  it('reads every way a sale can end, with words for each', () => {
    const whole = readSales(backend.workspace_program_sales_all_statuses)
    expect(new Set(whole.sales.map((sale) => sale.status))).toEqual(
      new Set(['pending', 'approved', 'returned', 'not_earned', 'not_judged']),
    )
    const reasons = whole.sales
      .filter((sale) => sale.status === 'not_earned')
      .map((sale) => sale.reason)
    expect(new Set(reasons)).toEqual(
      new Set(['not_a_member', 'program_paused', 'currency_mismatch']),
    )
    for (const sale of whole.sales) {
      const words = saleStatus(sale)
      expect(words.label).not.toBe('')
      expect(words.label).not.toBe('Recorded')
      if (sale.status === 'not_earned') expect(words.detail).not.toBeNull()
      expect(sale.creator_name).not.toBeNull()
      expect(sale.member_id).toMatch(/^[0-9a-f-]{36}$/)
    }
    const pending = whole.sales.find(
      (sale) => sale.link_name === 'TikTok' && sale.status === 'pending',
    )!
    expect(pending).toMatchObject({ amount_minor: 4900, commission_minor: 1470, fee_minor: 147 })
    expect(pending.hold_until).not.toBeNull()
    expect(hasCommission(pending)).toBe(true)
    const returned = whole.sales.find((sale) => sale.status === 'returned')!
    expect(returned).toMatchObject({ refunded_minor: 4900, commission_minor: 0 })
    const partly = whole.sales.find((sale) => sale.refunded_minor === 4000)!
    expect(partly).toMatchObject({ status: 'pending', amount_minor: 8000, commission_minor: 1200 })
    // A sale paid in another currency keeps its own.
    const euro = whole.sales.find((sale) => sale.reason === 'currency_mismatch')!
    expect(euro).toMatchObject({ currency: 'EUR', amount_minor: 7000 })
    expect(whole.sales.filter((sale) => sale.currency === 'USD')).toHaveLength(11)
    // The merchant's list carries no buyer address.
    expect(JSON.stringify(whole)).not.toContain('@')
  })

  it('reads the list of one creator, a sale an empty balance could not cover, and the empty answers', () => {
    const one = readSales(backend.workspace_program_sales_one_creator)
    expect(new Set(one.sales.map((sale) => sale.creator_name))).toEqual(new Set(['Ben Creator']))
    // The summary is the program's, whoever is filtered.
    expect(one.summary?.sales).toBe(5)

    const uncovered = readSales(backend.workspace_program_sales_balance_empty)
    expect(uncovered.program?.status).toBe('paused')
    expect(uncovered.sales[0]).toMatchObject({ status: 'not_earned', reason: 'balance_empty' })
    expect(saleStatus(uncovered.sales[0]).detail).toBe('Your balance could not cover it')

    const none = readSales(backend.workspace_program_sales_no_sales)
    expect(none.sales).toEqual([])
    expect(none.next_before).toBeNull()
    expect(none.program?.slug).toBe('rival-reader')

    const noProgram = readSales(backend.workspace_program_sales_no_program)
    expect(noProgram).toMatchObject({ program: null, sales: [], summary: null, next_before: null })
  })

  it('reads what each creator sold and earned, with the totals', () => {
    const state = readCreators(backend.workspace_program_creators_with_money)
    expect(state.currency).toBe('USD')
    expect(state.totals).toEqual({
      clicks: 19,
      sales: 12,
      sales_amount_minor: 49700,
      commission_minor: 10140,
      pending_minor: 6870,
    })
    const ada = state.creators.find((creator) => creator.name === 'Ada Okafor')!
    expect(ada).toMatchObject({
      status: 'active',
      clicks: 16,
      sales: 9,
      sales_amount_minor: 46200,
      commission_minor: 9540,
      pending_minor: 6270,
    })
    // A creator who left still counts in the totals.
    const left = state.creators.find((creator) => creator.name === 'Cy Park')!
    expect(left.status).not.toBe('active')
    expect(
      state.creators.reduce((total, creator) => total + (creator.commission_minor ?? 0), 0),
    ).toBe(state.totals!.commission_minor)

    const empty = readCreators(backend.workspace_program_creators_no_program)
    expect(empty).toMatchObject({ program: null, creators: [], currency: null, totals: null })
  })
})
