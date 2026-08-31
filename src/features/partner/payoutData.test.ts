/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { csvContent, payoutStatusLabels, previewPayouts } from './data'
import {
  addUtcDays,
  commissionExamples,
  payoutDetails,
  payoutHistoryCsv,
  payoutSchedule,
  payoutStateExamples,
  payoutStatementCsv,
  payoutSummary,
  sampleAgreement,
  statementPdfPath,
} from './payoutData'

describe('payout presentation contracts', () => {
  it('preserves all six baseline payouts and excludes scenarios from account totals', () => {
    expect(payoutDetails).toHaveLength(6)
    payoutDetails.forEach((detail, index) => expect(detail).toMatchObject(previewPayouts[index]))
    expect(payoutSummary(payoutDetails)).toEqual({
      openMinor: 209907,
      approvedMinor: 0,
      paidMinor: 1256454,
    })
    expect(payoutDetails.filter((p) => p.status === 'paid')).toHaveLength(5)
    expect(payoutSummary([])).toEqual({ openMinor: 0, approvedMinor: 0, paidMinor: 0 })
  })
  it.each([
    [0, 699690, 0, 699690, 209907, 0, 209907],
    [1, 928770, -12450, 916320, 274896, 0, 274896],
    [2, 898890, -12450, 886440, 265932, -1494, 264438],
  ])(
    'reconciles the exact money bridge for fixture %i',
    (index, gross, refunds, eligible, earnings, adjustment, balance) => {
      const p = payoutDetails[index]
      expect(p.bridge.find((line) => line.key === 'gross')?.amountMinor).toBe(gross)
      expect(p.bridge.find((line) => line.key === 'refunds')?.amountMinor).toBe(refunds)
      expect([p.eligibleRevenueMinor, p.earningsMinor, p.adjustmentsMinor, p.finalMinor]).toEqual([
        eligible,
        earnings,
        adjustment,
        balance,
      ])
    },
  )
  it('uses integer signed deductions without inventing fee, tax or FX amounts', () => {
    for (const p of payoutDetails) {
      expect(p.bridge.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(p.eligibleRevenueMinor)
      expect(Math.round((p.eligibleRevenueMinor * p.agreement.rateBps) / 10000)).toBe(
        p.earningsMinor,
      )
      expect(p.earningsMinor + p.adjustmentsMinor).toBe(p.finalMinor)
      for (const line of p.bridge) {
        expect(Number.isSafeInteger(line.amountMinor)).toBe(true)
        if (!['gross', 'refunds'].includes(line.key)) expect(line.amountMinor).toBe(0)
      }
    }
  })
  it('keeps 14-day boundaries, Monday–Thursday review and Friday target in UTC', () => {
    for (const p of payoutDetails) {
      const s = payoutSchedule(p)
      expect(Date.parse(s.closesAt) - Date.parse(s.opensAt)).toBe(14 * 86400000 - 1000)
      expect(
        [s.opensAt, s.closesAt, s.reviewStart, s.reviewEnd, s.expectedDate].map((date) =>
          new Date(date).getUTCDay(),
        ),
      ).toEqual([1, 0, 1, 4, 5])
      expect(s.expectedDate).toBe(p.due)
    }
    expect(payoutSchedule(payoutDetails[0])).toMatchObject({
      reviewStart: '2026-08-31',
      reviewEnd: '2026-09-03',
      expectedDate: '2026-09-04',
    })
    expect(addUtcDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addUtcDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('requires an explicit approval status even when Open earnings exceed the minimum', () => {
    expect(payoutDetails[0].finalMinor).toBeGreaterThan(sampleAgreement.minimumMinor)
    expect(payoutDetails[0].status).toBe('open')
    const approved = { ...payoutDetails[0], status: 'approved' as const }
    const scheduled = { ...payoutDetails[0], status: 'scheduled' as const }
    expect(payoutSummary([approved, scheduled]).approvedMinor).toBe(2 * payoutDetails[0].finalMinor)
  })
  it('pins immutable statement identity, agreement and destination snapshots', () => {
    expect(Object.isFrozen(sampleAgreement)).toBe(true)
    payoutDetails.forEach((p) => {
      expect(Object.isFrozen(p)).toBe(true)
      expect(p.agreement.partner).toBe('Example partner')
      expect(p.agreement.version).toBe('Example agreement · v1')
      expect(p.agreement.destination).toBe('Example bank · ending 4821')
    })
  })
  it('posts a later correction separately without changing the original paid period', () => {
    const p = payoutDetails[2]
    const original = payoutDetails[3]
    const reversal = p.moneyHistory.find((entry) => entry.amountMinor === -1494)!
    expect(reversal.date).toBe('2026-07-27')
    expect(reversal.detail).toContain(original.statement)
    expect(original.adjustmentsMinor).toBe(0)
    expect(original.finalMinor).toBe(previewPayouts[3].finalMinor)
    expect(p.moneyHistory.filter((entry) => entry.amountMinor === -1494)).toHaveLength(1)
  })
  it('separates commission movements from settlements and leaves Open evidence absent', () => {
    for (const p of payoutDetails) {
      const remaining = p.moneyHistory.reduce((sum, entry) => sum + entry.amountMinor, 0)
      if (p.status === 'paid') {
        expect(remaining).toBe(0)
        expect(p.paidAt).toBe(p.due)
        expect(p.paymentReference).toBe(`${p.statement}-TRANSFER`)
      } else {
        expect(remaining).toBe(p.finalMinor)
        expect(p.paidAt).toBeNull()
        expect(p.paymentReference).toBeNull()
        expect(statementPdfPath(p)).toBeNull()
        expect(payoutStatementCsv(p)).toBeNull()
      }
    }
  })
})

describe('independent examples', () => {
  it('covers all eight statuses and does not promise payment for exceptions', () => {
    expect(Object.keys(payoutStateExamples)).toEqual(Object.keys(payoutStatusLabels))
    expect(new Set(Object.values(payoutStateExamples).map((p) => p.explanation)).size).toBe(8)
    expect(payoutStateExamples.paid.transferredMinor).toBe(25000)
    for (const [status, p] of Object.entries(payoutStateExamples)) {
      expect(p.next.length).toBeGreaterThan(20)
      if (status !== 'paid') expect(p.transferredMinor).toBe(0)
      if (['on_hold', 'failed', 'carried_forward'].includes(status)) expect(p.date).toBeNull()
    }
  })
  it('carries a below-minimum balance once without treating it as earned or paid', () => {
    const p = payoutStateExamples.carried_forward
    expect(p.carriedMinor).toBe(7500)
    expect(p.carriedMinor).toBeLessThan(sampleAgreement.minimumMinor)
    expect(p.balanceMinor).toBe(0)
    expect(p.transferredMinor).toBe(0)
    expect(p.carriedMinor + 6000).toBe(13500)
    expect(p.next).toContain('does not approve')
  })
  it.each([
    ['revenue_share', 30000],
    ['cpl', 20000],
    ['cpa', 21600],
    ['hybrid', 71600],
  ] as const)('reconciles the %s example in USD cents', (model, expected) => {
    expect(commissionExamples[model].components.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(
      expected,
    )
    expect(sampleAgreement.rateBps).toBe(3000)
    expect(payoutSummary(payoutDetails).openMinor).toBe(209907)
  })
})

describe('payout exports', () => {
  it('exports numeric negatives, neutral period labels and no false Open settlement', () => {
    const history = payoutHistoryCsv(payoutDetails)
    expect(history.rows[2][history.headers.indexOf('Adjustments (USD)')]).toBe(-14.94)
    expect(history.rows[0]).toContain('Preliminary - not approved')
    expect(history.headers).not.toContain('Final payout (USD)')
    expect(history.rows[0].at(-1)).toBe('')
    const csv = csvContent(history.headers, history.rows)
    expect(csv).toContain('"-14.94"')
    expect(csv).not.toContain("'-14.94")
    expect(csvContent(['Text'], [['=HYPERLINK("bad")'], ['-not-a-number']])).toContain(
      "'-not-a-number",
    )
  })
  it('exports selected history with eligible basis, version, currency and payment context', () => {
    const csv = payoutHistoryCsv(payoutDetails.filter((p) => p.status === 'paid'))
    expect(csv.rows).toHaveLength(5)
    expect(csv.headers).toEqual(
      expect.arrayContaining([
        'Eligible basis (USD)',
        'Rate (%)',
        'Agreement version',
        'Currency',
        'Method',
        'Sample payment date (UTC)',
        'Sample payment reference',
      ]),
    )
    expect(csv.rows.every((row) => row.includes('Paid'))).toBe(true)
  })
  it.each(payoutDetails.filter((p) => p.status === 'paid'))(
    'aligns CSV and generated PDF with the UI snapshot for $statement',
    (p) => {
      const csv = payoutStatementCsv(p)!
      expect(csv.rows.find((row) => row[8] === 'Final sample payout')?.[9]).toBe(p.finalMinor / 100)
      expect(csv.rows.find((row) => row[8] === 'Approved adjustments')?.[9]).toBe(
        p.adjustmentsMinor / 100,
      )
      expect(
        csv.rows.every((row) => row[1] === p.statement && row[5] === p.agreement.version),
      ).toBe(true)
      expect(csv.rows.find((row) => row[8] === 'Sample payment reference')?.[10]).toBe(
        p.paymentReference,
      )
      const pdf = readFileSync(`public/${statementPdfPath(p)}`)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdf.toString('latin1')).toContain('%%EOF')
      const fingerprint = createHash('sha256').update(JSON.stringify(p)).digest('hex')
      expect(pdf.toString('latin1')).toContain(`Fixture-SHA256:${fingerprint}`)
    },
  )
})
