import { describe, expect, it } from 'vitest'
import { readCohorts, readCostImport, readCosts, readRevenueSetup, readRoi } from './api'
import type { RevenueEvent } from './api'
import { attributionRoiFixture as hand } from './attribution-roi.fixture'
import {
  MAX_UPLOAD_ROWS,
  addDays,
  checkCostDraft,
  checkRevenueEvents,
  cohortLabel,
  filtersFor,
  formatMoney,
  formatMoneyTick,
  formatMoneyTile,
  formatRatio,
  groupFor,
  levelFor,
  parseAmount,
  parseCostCsv,
  parseDay,
  plainDate,
  revenueSnippets,
  roiKeyLabel,
  skipReason,
  sourceKey,
  splitCsv,
  todayIn,
  unconvertedNote,
} from './roi'

const copy = (value: unknown) => structuredClone(value)

describe('ROI and cohort readers', () => {
  it('reads a report by source, with the null key as its own row', () => {
    const report = readRoi(copy(hand.roi_sources))
    expect(report).toMatchObject({
      currency: 'USD',
      range: '30d',
      from: '2026-10-15',
      to: '2026-11-13',
      timezone: 'Africa/Lagos',
      group: 'source',
      filters: {},
      complete: { d0: false, d7: false, d30: false },
      has_costs: true,
      has_revenue: true,
      unconverted: { revenue: 0, cost: 1, currencies: ['NGN'] },
    })
    expect(report.rows.map((row) => row.key)).toEqual([
      'meta',
      'tiktok',
      'influencer',
      'google_ads',
      null,
    ])
    expect(report.totals).toMatchObject({ users: 1240, installs: 860, cost: 4330.5, payers: 96 })
    // A source with spend and nobody yet: nothing to divide by.
    expect(report.rows[3]).toMatchObject({ users: 0, cost: 120, cpi: null, roas: 0 })
    expect(report.rows[4]).toMatchObject({ cost: 0, cpi: null, roas: null, revenue: 339.5 })
  })

  it('keeps a filter sent as null apart from one not sent', () => {
    const report = readRoi({
      ...(copy(hand.roi_campaigns) as object),
      filters: { source: null, campaign: 'spring' },
    })
    expect(report.filters).toEqual({ source: null, campaign: 'spring' })
    expect('adset' in report.filters).toBe(false)
  })

  it('reads numbers sent as text, and treats days it is not told about as filling', () => {
    const report = readRoi({
      currency: 'eur',
      range: 'forever',
      group: 'week',
      rows: [
        { key: 'meta', users: '12', cost: '40.50', roas: '1.25', cpi: 'n/a' },
        'not a row',
        null,
      ],
      totals: { users: 12, payers: -3 },
    })
    expect(report.currency).toBe('EUR')
    expect(report.range).toBe('30d')
    expect(report.group).toBe('source')
    expect(report.complete).toEqual({ d0: false, d7: false, d30: false })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ users: 12, cost: 40.5, roas: 1.25, cpi: null })
    expect(report.totals.payers).toBe(0)
    expect(report.has_costs).toBe(false)
  })

  it('refuses an answer that is not a report', () => {
    expect(() => readRoi(null)).toThrow('The answer could not be read')
    expect(() => readRoi({ rows: 'none' })).toThrow('The answer could not be read')
    expect(() => readCohorts([])).toThrow('The answer could not be read')
    expect(() => readCosts({ rows: null })).toThrow('The answer could not be read')
    expect(() => readRevenueSetup('nothing')).toThrow('The answer could not be read')
  })

  it('reads cohorts newest first, with each day complete, partial or still to come', () => {
    const report = readCohorts(copy(hand.cohorts_day))
    expect(report.interval).toBe('day')
    expect(report.today).toBe('2026-11-13')
    expect(report.days).toEqual([0, 1, 3, 7, 14, 30, 60, 90])
    expect(report.cohorts).toHaveLength(30)
    expect(report.cohorts[0].start).toBe('2026-11-13')
    expect(report.cohorts[0].cells.map((cell) => cell.state)).toEqual([
      'partial',
      'future',
      'future',
      'future',
      'future',
      'future',
      'future',
      'future',
    ])
    expect(report.cohorts[3].cells.slice(0, 4).map((cell) => cell.state)).toEqual([
      'complete',
      'complete',
      'partial',
      'future',
    ])
    expect(report.curve).toHaveLength(31)
  })

  it('reads a cohort state it does not know as a day still to come, and drops broken rows', () => {
    const report = readCohorts({
      interval: 'year',
      cohorts: [
        { start: '2026-11-10', users: 4, cells: [{ day: 0, state: 'soon', revenue: '3.5' }] },
        { start: 'yesterday', users: 2, cells: [] },
      ],
      days: 'all',
    })
    expect(report.interval).toBe('day')
    expect(report.days).toEqual([0, 1, 3, 7, 14, 30, 60, 90])
    expect(report.cohorts).toHaveLength(1)
    expect(report.cohorts[0].cells[0]).toMatchObject({ state: 'future', revenue: 3.5 })
  })

  it('reads a revenue setup defensively', () => {
    const setup = readRevenueSetup({
      currency: 'NGN',
      events: [
        { event: 'order_paid', amount_property: 'value', unit: 'cents', currency: 'usd' },
        { event: '', amount_property: 'value' },
      ],
      stores: [{ provider: 'stripe', connected: true }, { provider: 'adapty' }],
      last_7d: { payments: '3', revenue: 'lots' },
      skipped_7d: [
        { reason: 'bad_amount', events: 0 },
        { reason: 'no_person', events: 2 },
      ],
      last_received_at: 'not a time',
      rates_day: '2026-11-12',
    })
    expect(setup.events).toEqual([
      {
        event: 'order_paid',
        amount_property: 'value',
        unit: 'major',
        currency_property: null,
        currency: 'USD',
      },
    ])
    expect(setup.stores).toEqual([{ provider: 'adapty', connected: true }])
    expect(setup.last_7d).toEqual({
      payments: 3,
      refunds: 0,
      payers: 0,
      revenue: 0,
      unconverted: 0,
    })
    expect(setup.skipped_7d).toEqual([{ reason: 'no_person', events: 2 }])
    expect(setup.last_received_at).toBeNull()
  })

  it('reads spend defensively', () => {
    const report = readCosts({
      currency: 'USD',
      rows: [
        { id: 'r1', day: '2026-11-12', source: 'meta', amount: '12.50', origin: 'robot' },
        { id: 'r2', day: '12/11/2026', source: 'meta', amount: 3 },
        { day: '2026-11-12', source: 'meta', amount: 3 },
      ],
      rules: [{ id: 'x', kind: 'view', link_id: 'l', starts_on: '2026-11-01' }],
      sources: ['Meta', 'meta', 'tiktok', 7],
    })
    expect(report.rows).toEqual([
      {
        id: 'r1',
        day: '2026-11-12',
        source: 'meta',
        campaign: '',
        adset: '',
        ad: '',
        amount: 12.5,
        currency: 'USD',
        origin: 'manual',
        import_id: null,
        updated_at: null,
      },
    ])
    expect(report.rules).toEqual([])
    expect(report.sources).toEqual(['meta', 'tiktok'])
    expect(report.range).toBe('30d')
  })

  it('reads an upload answer with problems that have no row', () => {
    expect(readCostImport({ imported: '2', errors: [{ message: 'Too many rows' }, {}] })).toEqual({
      import_id: null,
      imported: 2,
      replaced: 0,
      errors: [{ row: 0, message: 'Too many rows' }],
    })
  })
})

describe('money and words', () => {
  it('writes money as the console does', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('$1,234.50')
    expect(formatMoney(1234.5, 'EUR')).toBe('1,234.50 EUR')
    expect(formatMoney(-59.99, 'USD')).toBe('−$59.99')
    expect(formatMoney(-0.001, 'USD')).toBe('$0.00')
    expect(formatMoney(1500, 'JPY')).toBe('1,500 JPY')
    expect(formatMoney(12345.67, 'USD', true)).toBe('$12,346')
    expect(formatMoneyTile(9999.5, 'USD')).toBe('$9,999.50')
    expect(formatMoneyTile(12345.67, 'NGN')).toBe('12,346 NGN')
    expect(formatMoneyTick(200, 'USD')).toBe('$200')
    expect(formatMoneyTick(0.5, 'USD')).toBe('$0.50')
  })

  it('writes ROAS and retention as shares', () => {
    expect(formatRatio(1.1824)).toBe('118%')
    expect(formatRatio(0.0523)).toBe('5.2%')
    expect(formatRatio(0)).toBe('0%')
    expect(formatRatio(12.5)).toBe('1,250%')
    expect(formatRatio(-0.25)).toBe('−25%')
    expect(formatRatio(null)).toBe('—')
  })

  it('names rows and walks down from source to ad', () => {
    expect(roiKeyLabel('source', null)).toBe('Direct and organic')
    expect(roiKeyLabel('source', 'meta')).toBe('Meta')
    expect(roiKeyLabel('campaign', null)).toBe('No campaign')
    expect(roiKeyLabel('adset', null)).toBe('No ad set')
    expect(roiKeyLabel('ad', 'video_1')).toBe('video_1')
    expect(filtersFor([])).toEqual({})
    expect(filtersFor(['meta', null])).toEqual({ source: 'meta', campaign: null })
    expect(filtersFor(['meta', 'spring', 'lagos'])).toEqual({
      source: 'meta',
      campaign: 'spring',
      adset: 'lagos',
    })
    expect([[], ['meta'], ['meta', 'spring'], ['meta', 'spring', 'lagos']].map(groupFor)).toEqual([
      'source',
      'campaign',
      'adset',
      'ad',
    ])
    expect(levelFor(['a', 'b', 'c', 'd'])).toBe('ad')
  })

  it('writes report days on the day they name, whatever the browser zone', () => {
    expect(plainDate('2026-11-13')).toBe('Nov 13')
    expect(plainDate('2026-11-13', 'long')).toBe('Nov 13, 2026')
    expect(plainDate('2026-11-13', 'weekday')).toBe('Fri, Nov 13')
    expect(plainDate('nonsense')).toBe('nonsense')
    expect(cohortLabel('week', '2026-11-09')).toBe('Week of Nov 9')
    expect(cohortLabel('month', '2026-11-01')).toBe('November 2026')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    // 23:30 in London is already tomorrow in Lagos.
    const late = Date.parse('2026-11-13T23:30:00Z')
    expect(todayIn('Africa/Lagos', late)).toBe('2026-11-14')
    expect(todayIn('America/New_York', late)).toBe('2026-11-13')
    expect(todayIn('Not/AZone', late)).toBe('2026-11-13')
  })

  it('says why payments were not counted in plain words', () => {
    expect(skipReason('no_currency')).toBe('came without a currency')
    expect(skipReason('bad_currency')).toContain('three-letter code')
    expect(skipReason('bad_amount')).toContain('amount')
    expect(skipReason('no_person')).toContain('store tool')
    expect(skipReason('something_new')).toBe('could not be read')
  })

  it('says what was left out for want of an exchange rate, with the currencies', () => {
    expect(unconvertedNote({ revenue: 0, cost: 0, currencies: [] })).toBeNull()
    expect(unconvertedNote({ revenue: 2, cost: 0, currencies: ['NGN'] })).toBe(
      "2 payments in NGN aren't included: the European Central Bank publishes no daily rate for it.",
    )
    expect(unconvertedNote({ revenue: 1, cost: 3, currencies: ['NGN', 'GHS', 'KES'] })).toBe(
      "1 payment and 3 spend lines in NGN, GHS and KES aren't included: the European Central Bank publishes no daily rate for them.",
    )
    expect(unconvertedNote({ revenue: 0, cost: 1, currencies: [] })).toBe(
      "1 spend line isn't included: the European Central Bank publishes no daily rate for its currency.",
    )
  })
})

describe('payment events', () => {
  const event = (over: Partial<RevenueEvent> = {}): RevenueEvent => ({
    event: 'order_paid',
    amount_property: 'value',
    unit: 'major',
    currency_property: 'currency',
    currency: null,
    ...over,
  })

  it('accepts events with a currency property or one fixed currency', () => {
    expect(
      checkRevenueEvents([
        event(),
        event({ event: 'coins_bought', currency_property: null, currency: 'USD', unit: 'minor' }),
      ]).size,
    ).toBe(0)
  })

  it('finds what is wrong with each event, by its place in the list', () => {
    const found = checkRevenueEvents([
      event({ event: '9lives' }),
      event(),
      event(),
      event({ event: 'paid', amount_property: '' }),
      event({ event: 'paid_two', amount_property: 'kma_revenue' }),
      event({ event: 'paid_three', currency_property: null, currency: null }),
      event({ event: 'paid_four', currency_property: 'has space' }),
    ])
    expect(found.get(0)?.event).toMatch(/starting with a letter/)
    expect(found.has(1)).toBe(false)
    expect(found.get(2)?.event).toBe('order_paid is listed twice.')
    expect(found.get(3)?.amount_property).toMatch(/holds the amount/)
    expect(found.get(4)?.amount_property).toMatch(/kma_revenue counts on its own/)
    expect(found.get(5)?.currency).toMatch(/Choose the currency/)
    expect(found.get(6)?.currency_property).toMatch(/holds the currency/)
  })

  it('shows the revenue call for every SDK and the same payment from a server', () => {
    const code = revenueSnippets()
    expect(code.web).toContain("kma('revenue', 59.99, 'USD'")
    expect(code.ios).toContain('KissMyApps.revenue(')
    expect(code.ios).toContain('currency: "USD"')
    expect(code.android).toContain('productId = "annual"')
    expect(code.reactNative).toContain("KissMyApps.revenue(59.99, 'USD', {")
    expect(code.flutter).toContain("transactionId: 'order-1042',")
    expect(code.server).toContain('"kma_revenue": 59.99')
    expect(code.server).toContain('"kma_currency": "USD"')
    expect(code.server).toContain('/v1/events')
    for (const text of [code.web, code.ios, code.android, code.reactNative, code.flutter])
      expect(text).toMatch(/-59\.99/)
  })
})

describe('spend as people type it', () => {
  it('reads amounts with thousands separators, symbols and either decimal mark', () => {
    const cases: Array<[string, number | null]> = [
      ['120.50', 120.5],
      ['1,234.56', 1234.56],
      ['1.234,56', 1234.56],
      ['120,50', 120.5],
      ['1,234', 1234],
      ['12,345,678', 12345678],
      ['1.234.567', 1234567],
      ['1.234', 1.234],
      ['$1 234.56', 1234.56],
      ['€99', 99],
      ['1’234.50', null],
      ["1'234.50", 1234.5],
      ['12 USD', 12],
      ['(12.00)', -12],
      ['-5', -5],
      ['.5', 0.5],
      ['abc', null],
      ['', null],
      ['1,23,4', null],
    ]
    for (const [text, expected] of cases)
      expect([text, parseAmount(text)]).toEqual([text, expected])
  })

  it('reads days as YYYY-MM-DD, with slashes, dots or a time after them', () => {
    expect(parseDay('2026-11-12')).toBe('2026-11-12')
    expect(parseDay('2026/11/2')).toBe('2026-11-02')
    expect(parseDay('2026.11.12')).toBe('2026-11-12')
    expect(parseDay('2026-11-12T10:00:00Z')).toBe('2026-11-12')
    expect(parseDay('2026-11-12 10:00')).toBe('2026-11-12')
    expect(parseDay('2026-13-01')).toBeNull()
    expect(parseDay('2026-02-30')).toBeNull()
    expect(parseDay('12/11/2026')).toBeNull()
  })

  it('checks a day of spend before it is sent', () => {
    const today = '2026-11-13'
    const draft = {
      day: '2026-11-12',
      source: ' Google Ads ',
      campaign: ' brand ',
      adset: '',
      ad: '',
      amount: '1,250.00',
      currency: 'usd',
    }
    expect(checkCostDraft(draft, today)).toEqual({
      errors: {},
      input: {
        day: '2026-11-12',
        source: 'google_ads',
        campaign: 'brand',
        amount: 1250,
        currency: 'USD',
      },
    })
    expect(sourceKey('Face Book')).toBe('face_book')
    const bad = checkCostDraft(
      {
        day: '2026-11-14',
        source: 'Meta!',
        campaign: '',
        adset: 'lagos',
        ad: 'video',
        amount: '-3',
        currency: 'dollars',
      },
      today,
    )
    expect(bad.input).toBeNull()
    expect(bad.errors).toEqual({
      day: 'Spend can only be added for today or earlier.',
      source: 'Name the source in letters, numbers and _ . -, such as meta.',
      adset: 'An ad set needs its campaign.',
      amount: 'Spend cannot be below zero.',
      currency: 'Choose a currency.',
    })
    expect(checkCostDraft({ ...draft, day: '2024-11-12' }, today).errors.day).toBe(
      'Spend can go back up to two years.',
    )
    expect(checkCostDraft({ ...draft, campaign: 'c', adset: '', ad: 'a' }, today).errors.ad).toBe(
      'An ad needs its ad set.',
    )
    expect(checkCostDraft({ ...draft, amount: '2000000000' }, today).errors.amount).toBe(
      'That is more than a billion.',
    )
  })
})

describe('spend spreadsheets', () => {
  it('splits quoted cells, doubled quotes, line breaks in quotes, CRLF and a BOM', () => {
    expect(splitCsv('﻿a,b\r\n"1,5","say ""hi"""\r\n"two\nlines",x')).toEqual([
      ['a', 'b'],
      ['1,5', 'say "hi"'],
      ['two\nlines', 'x'],
    ])
  })

  it('finds a semicolon or tab between cells', () => {
    expect(splitCsv('day;amount\n2026-11-12;120,50')).toEqual([
      ['day', 'amount'],
      ['2026-11-12', '120,50'],
    ])
    expect(splitCsv('day\tamount\n2026-11-12\t9')).toEqual([
      ['day', 'amount'],
      ['2026-11-12', '9'],
    ])
  })

  it('reads the template, rows without a currency taking the project one', () => {
    const parsed = parseCostCsv(
      'day,source,campaign,adset,ad,amount,currency\n2026-11-12,meta,spring,lagos,video_1,120.5,EUR\n2026-11-12,tiktok,,,,80,\n\n',
    )
    expect(parsed).toEqual({
      problem: null,
      errors: [],
      rows: [
        {
          line: 2,
          input: {
            day: '2026-11-12',
            source: 'meta',
            campaign: 'spring',
            adset: 'lagos',
            ad: 'video_1',
            amount: 120.5,
            currency: 'EUR',
          },
        },
        { line: 3, input: { day: '2026-11-12', source: 'tiktok', amount: 80 } },
      ],
    })
  })

  it('takes heading names in any case, and the names ad accounts export', () => {
    const parsed = parseCostCsv(
      'Date,Media Source,Campaign name,Ad set name,Ad name,Amount spent (USD)\n2026-11-12,Google Ads,brand,b1,a1,"1,250.00"',
    )
    expect(parsed.rows[0].input).toEqual({
      day: '2026-11-12',
      source: 'google_ads',
      campaign: 'brand',
      adset: 'b1',
      ad: 'a1',
      amount: 1250,
    })
    expect(parseCostCsv('DAY;SOURCE;SPEND\n2026-11-12;meta;1.234,50').rows[0].input.amount).toBe(
      1234.5,
    )
    expect(
      parseCostCsv('day,source,cost,Campaign,AD GROUP\n2026-11-12,meta,9,c,x').rows[0].input,
    ).toEqual({
      day: '2026-11-12',
      source: 'meta',
      campaign: 'c',
      adset: 'x',
      amount: 9,
    })
  })

  it('lists each line to fix, by its line in the file', () => {
    const parsed = parseCostCsv(
      [
        'day,source,campaign,adset,ad,amount,currency',
        '2026-13-01,meta,,,,10,USD',
        '2026-11-12,,,,,abc,USD',
        '2026-11-12,meta!,,lagos,,5,dollars',
        '2026-11-12,meta,spring,,video,-4,USD',
        '2026-11-12,meta,spring,,,4,USD',
      ].join('\n'),
    )
    expect(parsed.rows.map((row) => row.line)).toEqual([6])
    expect(parsed.errors).toEqual([
      { line: 2, message: 'Write the day as YYYY-MM-DD, not “2026-13-01”.' },
      { line: 3, message: 'The source is empty; the amount “abc” is not a number.' },
      {
        line: 4,
        message:
          'The source “meta!” can use letters, numbers and _ . - only; an ad set needs its campaign; the currency “DOLLARS” is not a three-letter code.',
      },
      { line: 5, message: 'An ad needs its ad set; spend cannot be below zero.' },
    ])
  })

  it('says what is wrong with the file as a whole', () => {
    expect(parseCostCsv('').problem).toBe('The file is empty.')
    expect(parseCostCsv('day,amount\n2026-11-12,4').problem).toBe(
      'The first line names the columns, and needs source. Download the template to see them.',
    )
    expect(parseCostCsv('day,source,amount\n').problem).toBe(
      'The file has no rows under its first line.',
    )
    const big = ['day,source,amount', ...Array(MAX_UPLOAD_ROWS + 1).fill('2026-11-12,meta,1')]
    expect(parseCostCsv(big.join('\n')).problem).toBe(
      'Upload up to 5,000 rows at a time; this file has 5,001. Split it and upload each part.',
    )
  })
})
