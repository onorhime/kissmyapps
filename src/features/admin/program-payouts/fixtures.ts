import type {
  AdminClosedPayout,
  AdminOpenPayout,
  AdminPayoutCreator,
  AdminProgramPayouts,
} from './api'

/**
 * Program payouts as the database answers them, for tests and for rendering the panel with
 * believable data. Totals are added up from the rows, never typed in.
 */

export const PAYOUTS_READ_AT = '2026-11-13T13:52:14.059098+00:00'

const SPEAKSIX = 'b1a70000-0000-4000-8000-000000000001'
const HABITLOOP = 'b1a70000-0000-4000-8000-000000000002'
const MEALMAP = 'b1a70000-0000-4000-8000-000000000003'
const LERNWEG = 'b1a70000-0000-4000-8000-000000000004'

const creator = (
  number: number,
  name: string,
  programs: [string, string, number][],
  rest: Partial<AdminPayoutCreator> = {},
): AdminPayoutCreator => ({
  affiliateId: `c0de0000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  name,
  currency: 'USD',
  payableMinor: programs.reduce((sum, [, , amount]) => sum + amount, 0),
  programs: programs.map(([programId, programName, amountMinor]) => ({
    programId,
    name: programName,
    amountMinor,
  })),
  accountStatus: 'ready',
  accountCountry: 'US',
  blocker: null,
  ...rest,
})

export const fixtureCreators: AdminPayoutCreator[] = [
  creator(1, 'Ada Okafor', [
    [SPEAKSIX, 'SpeakSix', 3000],
    [HABITLOOP, 'HabitLoop', 1410],
  ]),
  creator(2, 'Mateo Rossi', [[SPEAKSIX, 'SpeakSix', 6320]], { accountCountry: 'GB' }),
  creator(3, 'Priya Nair', [
    [MEALMAP, 'MealMap', 2500],
    [HABITLOOP, 'HabitLoop', 320],
  ]),
  creator(4, 'Ben Carter', [[SPEAKSIX, 'SpeakSix', 3150]], {
    accountStatus: 'not_connected',
    accountCountry: null,
    blocker: 'no_account',
  }),
  creator(5, 'Hana Sato', [[MEALMAP, 'MealMap', 5890]], {
    accountStatus: 'restricted',
    blocker: 'account_not_ready',
  }),
  creator(6, 'Lena Fischer', [[LERNWEG, 'Lernweg', 1800]], {
    currency: 'EUR',
    accountCountry: 'DE',
    blocker: 'below_minimum',
  }),
  creator(7, 'Tom Whitfield', [[HABITLOOP, 'HabitLoop', 900]], { blocker: 'below_minimum' }),
]

const payout = (number: number) => `fa110000-0000-4000-8000-${String(number).padStart(12, '0')}`

export const fixtureOpen: AdminOpenPayout[] = [
  {
    id: payout(1),
    affiliateId: 'c0de0000-0000-4000-8000-000000000008',
    name: 'Sofia Marin',
    currency: 'USD',
    amountMinor: 12840,
    status: 'processing',
    attempts: 3,
    failureCode: 'platform_balance_insufficient',
    createdAt: '2026-11-12T09:14:00+00:00',
    nextAttemptAt: '2026-11-13T14:20:00+00:00',
    canCancel: false,
  },
  {
    id: payout(2),
    affiliateId: 'c0de0000-0000-4000-8000-000000000009',
    name: 'Noah Lindqvist',
    currency: 'USD',
    amountMinor: 4725,
    status: 'approved',
    attempts: 0,
    failureCode: null,
    createdAt: '2026-11-13T13:40:00+00:00',
    nextAttemptAt: null,
    canCancel: true,
  },
]

export const fixtureRecent: AdminClosedPayout[] = [
  {
    id: payout(11),
    affiliateId: 'c0de0000-0000-4000-8000-000000000001',
    name: 'Ada Okafor',
    currency: 'USD',
    amountMinor: 21000,
    status: 'paid',
    failureCode: null,
    createdAt: '2026-11-06T10:02:00+00:00',
    closedAt: '2026-11-06T10:03:10+00:00',
    transferId: 'tr_3QK7dLAdaOkafor01',
  },
  {
    id: payout(12),
    affiliateId: 'c0de0000-0000-4000-8000-000000000005',
    name: 'Hana Sato',
    currency: 'USD',
    amountMinor: 5890,
    status: 'failed',
    failureCode: 'account_not_ready',
    createdAt: '2026-11-06T10:02:00+00:00',
    closedAt: '2026-11-06T10:03:40+00:00',
    transferId: null,
  },
  {
    id: payout(13),
    affiliateId: 'c0de0000-0000-4000-8000-000000000002',
    name: 'Mateo Rossi',
    currency: 'USD',
    amountMinor: 9650,
    status: 'paid',
    failureCode: null,
    createdAt: '2026-10-30T08:45:00+00:00',
    closedAt: '2026-10-30T08:46:02+00:00',
    transferId: 'tr_3QH2mPMateoRossi07',
  },
  {
    id: payout(14),
    affiliateId: 'c0de0000-0000-4000-8000-000000000003',
    name: 'Priya Nair',
    currency: 'USD',
    amountMinor: 3300,
    status: 'canceled',
    failureCode: null,
    createdAt: '2026-10-29T16:20:00+00:00',
    closedAt: '2026-10-29T16:31:00+00:00',
    transferId: null,
  },
]

function sum(rows: readonly { currency: string; minor: number }[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const row of rows) totals[row.currency] = (totals[row.currency] ?? 0) + row.minor
  return totals
}

/** The answer for these rows, with the totals the database would add up from them. */
export function payoutsFixture(
  overrides: Partial<Omit<AdminProgramPayouts, 'totals'>> = {},
): AdminProgramPayouts {
  const base = {
    enabled: true,
    moneyEnabled: true,
    minPayoutMinor: 2500,
    updatedAt: PAYOUTS_READ_AT,
    platform: { accountId: 'acct_1QK7dLConsole01', registered: true, enabled: true },
    creators: fixtureCreators,
    open: fixtureOpen,
    recent: fixtureRecent,
    ...overrides,
  }
  const amounts = (rows: readonly AdminPayoutCreator[]) =>
    sum(rows.map((row) => ({ currency: row.currency, minor: row.payableMinor })))
  const ready = base.creators.filter((row) => row.blocker === null)
  return {
    ...base,
    totals: {
      readyMinorByCurrency: amounts(ready),
      readyCount: ready.length,
      waitingMinorByCurrency: amounts(base.creators.filter((row) => row.blocker !== null)),
      paidMinorByCurrency: sum(
        base.recent
          .filter((row) => row.status === 'paid')
          .map((row) => ({ currency: row.currency, minor: row.amountMinor })),
      ),
    },
  }
}

/** Payouts on, and nothing owed, on its way or paid yet. */
export const emptyPayoutsFixture = () => payoutsFixture({ creators: [], open: [], recent: [] })
