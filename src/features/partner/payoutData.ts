import { payoutStatusLabels, previewPayouts, previewRecords, shortDate } from './data.ts'
import type { PayoutStatus, PreviewPayout } from './data.ts'

// A presentation-only projection of the existing fixtures, not a payout engine.
// Live balances, status, agreement versions and settlement evidence must come
// from affiliate-safe backend views. No scenario below enters account totals.
export const payoutSnapshotDate = '2026-08-26'
export const sampleAgreement = Object.freeze({
  version: 'Example agreement · v1',
  partner: 'Example partner',
  model: 'Revenue share',
  rateBps: 3000,
  currency: 'USD',
  frequency: 'Every 14 days · UTC',
  minimumMinor: 10000,
  method: 'Bank transfer',
  destination: 'Example bank · ending 4821',
})

export type CalculationLine = { key: string; label: string; amountMinor: number; note: string }
export type MoneyHistoryEntry = {
  date: string
  title: string
  detail: string
  amountMinor: number
}
export type PayoutDetail = Readonly<PreviewPayout> & {
  agreement: typeof sampleAgreement
  bridge: CalculationLine[]
  paidAt: string | null
  paymentReference: string | null
  moneyHistory: MoneyHistoryEntry[]
  changes: { date: string; label: string }[]
}

export function addUtcDays(date: string, days: number) {
  const result = new Date(`${date}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

export function payoutSchedule(payout: Pick<PreviewPayout, 'start' | 'end'>) {
  return {
    opensAt: `${payout.start}T00:00:00Z`,
    closesAt: `${payout.end}T23:59:59Z`,
    reviewStart: addUtcDays(payout.end, 1),
    reviewEnd: addUtcDays(payout.end, 4),
    expectedDate: addUtcDays(payout.end, 5),
  }
}

function projectPayout(payout: PreviewPayout): PayoutDetail {
  const rows = previewRecords.filter((row) => row.date >= payout.start && row.date <= payout.end)
  const gross = rows.reduce((total, row) => total + (row.purchases + row.renewals) * 2490, 0)
  const refunds = rows.reduce((total, row) => total + row.refunds * 2490, 0)
  const schedule = payoutSchedule(payout)
  const paidAt = payout.status === 'paid' ? payout.due : null
  const paymentReference = payout.statement ? `${payout.statement}-TRANSFER` : null
  const bridge: CalculationLine[] = [
    {
      key: 'gross',
      label: 'Gross verified payments',
      amountMinor: gross,
      note: 'Fictional first payments and renewals; trials do not earn revenue share.',
    },
    {
      key: 'fees',
      label: 'Stripe fees',
      amountMinor: 0,
      note: 'No fee deduction in this fixture; not a claim about real Stripe fees.',
    },
    {
      key: 'refunds',
      label: 'Refunds · balance impact',
      amountMinor: refunds ? -refunds : 0,
      note: 'This fixture uses a $24.90 balance debit per refund. Live amounts must use actual settlement impact, including non-returned fees.',
    },
    {
      key: 'disputes',
      label: 'Dispute amounts',
      amountMinor: 0,
      note: 'No disputes in this example.',
    },
    {
      key: 'dispute-fees',
      label: 'Dispute fees',
      amountMinor: 0,
      note: 'No dispute fees in this example.',
    },
    {
      key: 'fx',
      label: 'Settlement currency conversion',
      amountMinor: 0,
      note: 'USD-settled example. Live FX uses Stripe settlement amounts, never a display exchange rate.',
    },
    {
      key: 'taxes',
      label: 'Taxes & contractual deductions',
      amountMinor: 0,
      note: 'No tax or contractual deduction in this fixture; the effective agreement determines the real basis.',
    },
  ]
  const moneyHistory: MoneyHistoryEntry[] = [
    {
      date: payout.status === 'open' ? payoutSnapshotDate : payout.end,
      title: 'Earned during this period',
      detail: '30% of eligible revenue under example agreement v1, before separate adjustments.',
      amountMinor: payout.earningsMinor,
    },
  ]
  if (payout.adjustmentsMinor) {
    moneyHistory.push({
      date: '2026-07-27',
      title: 'Late refund reversal · earlier paid period',
      detail:
        'Separate $14.94 commission reversal for Jul 6–19 (SAMPLE-2026-0004). Posted in Jul 20–Aug 2; the original paid statement stays unchanged. Not a second deduction of this period’s refunds.',
      amountMinor: payout.adjustmentsMinor,
    })
  }
  if (paidAt) {
    moneyHistory.push({
      date: paidAt,
      title: 'Sample payment recorded',
      detail: `${paymentReference}. Illustrative settlement only; no transfer occurred.`,
      amountMinor: -payout.finalMinor,
    })
  }
  moneyHistory.sort((a, b) => a.date.localeCompare(b.date))
  const changes = [{ date: payout.start, label: 'Period opened · agreement v1 pinned' }]
  if (paidAt) {
    changes.push(
      { date: schedule.reviewStart, label: 'Pending review · sample reconciliation began' },
      { date: addUtcDays(payout.end, 3), label: 'Approved · example approval recorded' },
      { date: schedule.reviewEnd, label: 'Scheduled · destination snapshot locked' },
      { date: paidAt, label: 'Paid · sample statement finalized and locked' },
    )
  }
  return Object.freeze({
    ...payout,
    agreement: sampleAgreement,
    bridge,
    paidAt,
    paymentReference,
    moneyHistory,
    changes,
  })
}

export const payoutDetails: readonly PayoutDetail[] = previewPayouts.map(projectPayout)

export function payoutSummary(payouts: readonly PayoutDetail[]) {
  return {
    openMinor: payouts
      .filter((p) => p.status === 'open')
      .reduce((total, p) => total + p.earningsMinor, 0),
    approvedMinor: payouts
      .filter((p) => p.status === 'approved' || p.status === 'scheduled')
      .reduce((total, p) => total + p.finalMinor, 0),
    paidMinor: payouts
      .filter((p) => p.status === 'paid')
      .reduce((total, p) => total + p.finalMinor, 0),
  }
}

export const payoutStateExamples: Record<
  PayoutStatus,
  {
    balanceMinor: number
    transferredMinor: number
    carriedMinor: number
    explanation: string
    next: string
    dateLabel: string
    date: string | null
  }
> = {
  open: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation:
      'Earnings are still accruing. Even above the minimum, this amount is not approved for payment.',
    next: 'Close the period, reconcile its ledger, then review it.',
    dateLabel: 'Illustrative target, subject to review',
    date: '2026-08-21',
  },
  review: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation:
      'The period is closed. Refunds, disputes, and eligibility are under review; the balance is not yet approved.',
    next: 'Review Monday–Thursday; an explicit approval is required.',
    dateLabel: 'Illustrative target, subject to approval',
    date: '2026-08-21',
  },
  approved: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation: 'This example has an explicit approval. Approved does not mean sent or settled.',
    next: 'Schedule the approved amount after payment checks pass.',
    dateLabel: 'Expected, not yet scheduled',
    date: '2026-08-21',
  },
  scheduled: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation:
      'The approved amount has a payment date. The saved destination is locked at this stage.',
    next: 'Record settlement evidence before changing the status to Paid.',
    dateLabel: 'Example scheduled date',
    date: '2026-08-21',
  },
  paid: {
    balanceMinor: 0,
    transferredMinor: 25000,
    carriedMinor: 0,
    explanation:
      'This example includes a completed settlement record and a locked statement. It is not a real transfer.',
    next: 'Later corrections create entries in a new open period; never rewrite the paid statement.',
    dateLabel: 'Illustrative payment date',
    date: '2026-08-21',
  },
  on_hold: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation:
      'A payment-detail change is awaiting verification and its 48-hour security hold. No payment date is promised.',
    next: 'Password and 2FA, email confirmation, and the hold must all clear before rescheduling.',
    dateLabel: 'Payment date after hold',
    date: null,
  },
  failed: {
    balanceMinor: 25000,
    transferredMinor: 0,
    carriedMinor: 0,
    explanation:
      'The example transfer failed. The amount remains unpaid; no completed payment evidence is shown.',
    next: 'Review the failure and safely reschedule. This preview cannot retry or move money.',
    dateLabel: 'Rescheduled payment date',
    date: null,
  },
  carried_forward: {
    balanceMinor: 0,
    transferredMinor: 0,
    carriedMinor: 7500,
    explanation:
      '$75.00 is below the example $100.00 minimum. It moves to the next period, not to the bank and not into new earnings.',
    next: 'Next period: $75.00 carried in + $60.00 newly earned = $135.00 for review. Meeting the minimum does not approve it.',
    dateLabel: 'Payment date after carry-forward',
    date: null,
  },
}

export type CommissionExample = 'revenue_share' | 'cpl' | 'cpa' | 'hybrid'
const revenueComponent = {
  label: 'Eligible net revenue × 30%',
  basis: '$1,000.00 × 30%',
  amountMinor: 30000,
}
const leadComponent = {
  label: '40 accepted qualified leads × $5.00',
  basis: '40 × $5.00',
  amountMinor: 40 * 500,
}
const actionComponent = {
  label: '12 verified first purchases × $18.00',
  basis: '12 × $18.00',
  amountMinor: 12 * 1800,
}
export const commissionExamples: Record<
  CommissionExample,
  {
    label: string
    rule: string
    components: { label: string; basis: string; amountMinor: number }[]
  }
> = {
  revenue_share: {
    label: 'Revenue share',
    rule: 'Verified first payments and eligible renewals, using the effective agreement. Trial starts do not earn revenue share.',
    components: [revenueComponent],
  },
  cpl: {
    label: 'CPL · Cost per lead',
    rule: 'Backend-accepted, deduplicated qualified leads only. The default validation window is 72 hours; raw form submissions do not qualify automatically.',
    components: [leadComponent],
  },
  cpa: {
    label: 'CPA · Cost per action',
    rule: 'The named action in this example is a verified first purchase. An agreement may name a confirmed install instead; these are not interchangeable counts.',
    components: [actionComponent],
  },
  hybrid: {
    label: 'Hybrid',
    rule: 'Only the components explicitly included in an effective agreement are added. This illustration combines accepted leads, verified first purchases and eligible revenue.',
    components: [leadComponent, actionComponent, revenueComponent],
  },
}

export function statementPdfPath(payout: PayoutDetail): string | null {
  return payout.status === 'paid' &&
    payout.statement &&
    /^SAMPLE-2026-\d{4}$/.test(payout.statement)
    ? `statements/${payout.statement}.pdf`
    : null
}

export function payoutHistoryCsv(payouts: readonly PayoutDetail[]) {
  return {
    headers: [
      'Dataset',
      'Period start (UTC)',
      'Period end (UTC)',
      'Eligible basis (USD)',
      'Agreement version',
      'Rate (%)',
      'Earnings before adjustments (USD)',
      'Adjustments (USD)',
      'Period amount (USD)',
      'Amount state',
      'Currency',
      'Method',
      'Status',
      'Statement',
      'Expected date (not a guarantee)',
      'Sample payment date (UTC)',
      'Sample payment reference',
    ],
    rows: payouts.map((p): (string | number)[] => [
      'UI PREVIEW ONLY - NO TRANSFER',
      p.start,
      p.end,
      p.eligibleRevenueMinor / 100,
      p.agreement.version,
      p.agreement.rateBps / 100,
      p.earningsMinor / 100,
      p.adjustmentsMinor / 100,
      p.finalMinor / 100,
      p.status === 'paid' ? 'Finalized sample' : 'Preliminary - not approved',
      p.agreement.currency,
      p.agreement.method,
      payoutStatusLabels[p.status],
      p.statement ?? 'Not issued',
      p.due,
      p.paidAt ?? '',
      p.paymentReference ?? '',
    ]),
  }
}

export function payoutStatementCsv(p: PayoutDetail) {
  if (!statementPdfPath(p)) return null
  const headers = [
    'Dataset',
    'Statement',
    'Period start (UTC)',
    'Period end (UTC)',
    'Partner snapshot',
    'Agreement version',
    'Currency',
    'Section',
    'Item',
    'Amount (USD)',
    'Detail',
  ]
  const row = (
    section: string,
    item: string,
    amount: number | '',
    detail: string,
  ): (string | number)[] => [
    'SAMPLE - NOT AN INVOICE OR PAYMENT RECORD',
    p.statement!,
    p.start,
    p.end,
    p.agreement.partner,
    p.agreement.version,
    p.agreement.currency,
    section,
    item,
    amount === '' ? '' : amount / 100,
    detail,
  ]
  return {
    headers,
    rows: [
      ...p.bridge.map((line) => row('Revenue basis', line.label, line.amountMinor, line.note)),
      row(
        'Calculation',
        'Eligible net revenue',
        p.eligibleRevenueMinor,
        'Gross plus the signed deductions and settlement conversion above',
      ),
      row(
        'Calculation',
        'Partner earnings before adjustments',
        p.earningsMinor,
        'Eligible net revenue × 30%',
      ),
      row(
        'Calculation',
        'Approved adjustments',
        p.adjustmentsMinor,
        'Separate commission entries; not another deduction of current-period refunds',
      ),
      row(
        'Calculation',
        'Final sample payout',
        p.finalMinor,
        'Locked paid-period snapshot; no real transfer occurred',
      ),
      row('Payment', 'Sample payment date (UTC)', '', p.paidAt!),
      row('Payment', 'Sample payment reference', '', p.paymentReference!),
      row(
        'Payment',
        'Destination snapshot',
        '',
        `${p.agreement.method} · ${p.agreement.destination}`,
      ),
      ...p.moneyHistory.map((entry) =>
        row(
          'Money-affecting history',
          entry.title,
          entry.amountMinor,
          `${entry.date} UTC · ${entry.detail}`,
        ),
      ),
      ...p.changes.map((entry) => row('Change history', entry.label, '', `${entry.date} UTC`)),
    ],
  }
}

export function payoutPeriodLabel(payout: Pick<PreviewPayout, 'start' | 'end'>) {
  return `${shortDate(payout.start)} – ${shortDate(payout.end)}, ${payout.end.slice(0, 4)}`
}
