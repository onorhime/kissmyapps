import { describe, expect, it } from 'vitest'
import { readCohorts, readRoi } from './api'
import type { CohortCell, RoiMetrics } from './api'
import { attributionRoiBackendFixture as backend } from './attribution-roi-backend.fixture'
import { addDays, roiKeyLabel, unconvertedNote } from './roi'

const copy = (value: unknown) => structuredClone(value)

const add = (rows: RoiMetrics[], key: 'users' | 'installs' | 'payers' | 'cost' | 'revenue') =>
  Math.round(rows.reduce((total, row) => total + row[key], 0) * 100) / 100

const STATE_ORDER: Record<CohortCell['state'], number> = { complete: 0, partial: 1, future: 2 }

// The ROI and Cohorts tabs' readers against what the ROI functions really return.
describe('ROI readers and the real backend answers', () => {
  it('reads sources with direct and organic last, and totals that add up', () => {
    const report = readRoi(copy(backend.roi_sources))
    expect(report).toMatchObject({
      currency: 'USD',
      range: '30d',
      from: '2026-10-16',
      to: '2026-11-14',
      timezone: 'Africa/Lagos',
      group: 'source',
      filters: {},
      complete: { d0: false, d7: false, d30: false },
      has_costs: true,
      has_revenue: true,
    })
    expect(report.rows.map((row) => row.key)).toEqual(['meta', 'tiktok', 'google_ads', null])
    expect(report.rows.map((row) => roiKeyLabel('source', row.key))).toEqual([
      'Meta',
      'TikTok',
      'Google Ads',
      'Direct and organic',
    ])
    for (const key of ['users', 'installs', 'payers', 'cost', 'revenue'] as const)
      expect(add(report.rows, key)).toBe(report.totals[key])
    expect(report.totals).toMatchObject({
      users: 10,
      cost: 270,
      revenue: 117.58,
      payers: 5,
      roas: 0.4355,
      cost_per_payer: 54,
    })
  })

  it('reads a ratio as missing only when its divisor is zero', () => {
    const [meta, , googleAds, organic] = readRoi(copy(backend.roi_sources)).rows
    expect(meta).toMatchObject({ cpi: 200, cost_per_payer: 66.67, roas: 0.5249, roas_d0: 0.275 })
    // Spend with nobody arriving: nothing to divide by.
    expect(googleAds).toMatchObject({ users: 0, cost: 25, cpi: null, arpu: null, roas: 0 })
    // People with no spend: the cost per person is a real zero and ROAS has no divisor.
    expect(organic).toMatchObject({ cost: 0, cpi: 0, cost_per_user: 0, roas: null, arpu: 0.75 })
  })

  it('reads payments and spend left out for want of a rate, as counts with their currency', () => {
    const sources = readRoi(copy(backend.roi_sources))
    expect(sources.unconverted).toEqual({ revenue: 1, cost: 1, currencies: ['NGN'] })
    expect(unconvertedNote(sources.unconverted)).toBe(
      "1 payment and 1 spend line in NGN aren't included: the European Central Bank publishes no daily rate for it.",
    )
    const campaigns = readRoi(copy(backend.roi_campaigns))
    expect(unconvertedNote(campaigns.unconverted)).toBe(
      "1 spend line in NGN isn't included: the European Central Bank publishes no daily rate for it.",
    )
    expect(unconvertedNote(readRoi(copy(backend.roi_empty)).unconverted)).toBeNull()
  })

  it("reads a source's campaigns with the filter folded to its family", () => {
    const report = readRoi(copy(backend.roi_campaigns))
    expect(report.group).toBe('campaign')
    expect(report.filters).toEqual({ source: 'meta' })
    expect(report.rows.map((row) => roiKeyLabel('campaign', row.key))).toEqual([
      'spring',
      'speaksix-funnel',
      'No campaign',
    ])
    // The campaigns add up to the source's own row.
    const meta = readRoi(copy(backend.roi_sources)).rows[0]
    const { key: _key, ...metaFigures } = meta
    expect(report.totals).toEqual(metaFigures)
    // Spend on a campaign nobody arrived from with an install has no cost per install.
    expect(report.rows[0]).toMatchObject({ installs: 0, cost: 170, cpi: null, cost_per_user: 85 })
  })

  it('reads every day of the range, oldest first, with spend on days nobody arrived', () => {
    const report = readRoi(copy(backend.roi_days))
    expect(report.group).toBe('day')
    expect(report.rows).toHaveLength(30)
    expect(report.rows.map((row) => row.key)).toEqual(
      Array.from({ length: 30 }, (_, index) => addDays('2026-10-16', index)),
    )
    for (const key of ['users', 'installs', 'payers', 'cost', 'revenue'] as const)
      expect(add(report.rows, key)).toBe(report.totals[key])
    expect(report.rows.find((row) => row.key === '2026-11-06')).toMatchObject({
      users: 0,
      cost: 25,
      roas: 0,
    })
  })

  it('reads a project with nothing yet', () => {
    const report = readRoi(copy(backend.roi_empty))
    expect(report.rows).toEqual([])
    expect(report.complete).toEqual({ d0: true, d7: true, d30: true })
    expect(report).toMatchObject({ has_costs: false, has_revenue: false })
    expect(report.totals).toMatchObject({ users: 0, cost: 0, revenue: 0, cpi: null, roas: null })
  })
})

describe('cohort readers and the real backend answers', () => {
  it("reads 30 daily cohorts, newest first, with today's day 0 still filling", () => {
    const report = readCohorts(copy(backend.cohorts_day))
    expect(report).toMatchObject({
      currency: 'USD',
      interval: 'day',
      timezone: 'Africa/Lagos',
      today: '2026-11-14',
      filters: {},
      days: [0, 1, 3, 7, 14, 30, 60, 90],
      totals: { users: 10, cost: 270, revenue: 117.58, payers: 5 },
      unconverted: { revenue: 1, cost: 1, currencies: ['NGN'] },
    })
    expect(report.cohorts.map((cohort) => cohort.start)).toEqual(
      Array.from({ length: 30 }, (_, index) => addDays('2026-11-14', -index)),
    )
    const today = report.cohorts[0]
    expect(today).toMatchObject({ users: 1, cost: 5 })
    expect(today.cells[0]).toEqual({
      day: 0,
      state: 'partial',
      complete_users: 0,
      revenue: 3,
      revenue_per_user: 3,
      roas: 0.6,
      returned: 0,
      retention: null,
    })
    expect(today.cells.slice(1).every((cell) => cell.state === 'future')).toBe(true)
    // Yesterday's people are on day 1 today; the day before's have all finished it.
    expect(report.cohorts[1].cells.map((cell) => cell.state).slice(0, 3)).toEqual([
      'partial',
      'partial',
      'future',
    ])
    expect(report.cohorts[2].cells[1]).toMatchObject({ state: 'complete', complete_users: 1 })
  })

  it('reads cell states in order: finished days, then days under way, then days to come', () => {
    for (const name of ['cohorts_day', 'cohorts_week', 'cohorts_empty']) {
      const report = readCohorts(copy(backend[name]))
      for (const cohort of report.cohorts) {
        expect(cohort.cells.map((cell) => cell.day)).toEqual(report.days)
        const order = cohort.cells.map((cell) => STATE_ORDER[cell.state])
        expect(order).toEqual([...order].sort((a, b) => a - b))
        // Nobody has finished a day still to come.
        for (const cell of cohort.cells)
          if (cell.state === 'future') expect(cell.complete_users).toBe(0)
      }
    }
  })

  it('reads the day 0 to 30 curve over the people who have finished each day', () => {
    const { curve } = readCohorts(copy(backend.cohorts_day))
    expect(curve.map((point) => point.day)).toEqual(Array.from({ length: 31 }, (_, day) => day))
    expect(curve[0]).toEqual({ day: 0, users: 8, revenue_per_user: 8.1225, retention: 0.875 })
    expect(curve.slice(6).every((point) => point.users === 0 && point.retention === null)).toBe(
      true,
    )
  })

  it('reads 12 weekly cohorts starting on Mondays, this week still filling', () => {
    const report = readCohorts(copy(backend.cohorts_week))
    expect(report.interval).toBe('week')
    expect(report.cohorts.map((cohort) => cohort.start)).toEqual(
      Array.from({ length: 12 }, (_, index) => addDays('2026-11-09', -7 * index)),
    )
    const [thisWeek] = report.cohorts
    expect(thisWeek).toMatchObject({ users: 9, cost: 235 })
    expect(thisWeek.cells.slice(0, 4).map((cell) => cell.state)).toEqual([
      'partial',
      'partial',
      'partial',
      'future',
    ])
    expect(thisWeek.cells[0]).toMatchObject({
      complete_users: 7,
      revenue_per_user: 7.5533,
      returned: 6,
      retention: 0.8571,
    })
    expect(report.totals).toEqual({ users: 12, cost: 470, revenue: 296.58, payers: 7 })
  })

  it('reads a project nobody arrived in yet', () => {
    const report = readCohorts(copy(backend.cohorts_empty))
    expect(report.totals).toEqual({ users: 0, cost: 0, revenue: 0, payers: 0 })
    expect(report.cohorts).toHaveLength(30)
    expect(report.cohorts.every((cohort) => cohort.users === 0)).toBe(true)
    expect(
      report.curve.every((point) => point.users === 0 && point.revenue_per_user === null),
    ).toBe(true)
  })
})
