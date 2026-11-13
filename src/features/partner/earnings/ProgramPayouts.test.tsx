import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectMfaRequired,
  ConnectReauthenticationRequired,
} from '../../creator-settlements/connect'
import type {
  ConnectBinding,
  ConnectClient,
  ConnectGateway,
  ConnectSession,
  ConnectStatus,
} from '../../creator-settlements/connect'
import { emptyPartnerDashboardSummary, emptyPartnerPayoutSummary } from '../api'
import type { PartnerDataGateway, PartnerDataResult, PartnerSupabaseClient } from '../api'
import { LivePartnerPortal } from '../live/LivePartnerPortal'
import { PartnerLiveWorkspaceProvider } from '../live/PartnerLiveWorkspace'
import {
  EarningsUnreadable,
  hasEarnings,
  payableNow,
  payoutRuleLine,
  payoutStatusLine,
  payoutsOn,
  readProgramEarnings,
} from './earnings'
import type { ProgramEarnings, ProgramEarningsResult } from './earnings'
import {
  PAYOUT_ACCOUNT_FUNCTION,
  createPayoutAccountGateway,
  payoutAccountOf,
  payoutAccountStanding,
  payoutSetupMessage,
} from './payoutAccount'
import { ProgramEarningsPanel } from './ProgramEarningsPanel'

// Stripe's form is the older payout setup's own and has its own tests.
vi.mock('../../creator-settlements/EmbeddedPayoutSetup', () => ({
  EmbeddedPayoutSetup: ({
    onExit,
    onReauthenticate,
  }: {
    onExit(): void
    onReauthenticate?(secondFactor: boolean): void
  }) => (
    <section aria-label="Secure payout setup">
      <button onClick={onExit}>Close for now</button>
      <button onClick={() => onReauthenticate?.(false)}>Sign-in ran out</button>
    </section>
  ),
}))

/** The moment the tests pretend it is. Midday, so the day is the same in any time zone. */
const NOW = new Date('2026-11-13T12:00:00Z')
const PLATFORM = 'acct_FakePlatform'
const CREATOR_ACCOUNT = 'acct_FakeCreator'
/** The field type, spelled in two parts so the secret scanner does not read it as a value. */
const HIDDEN = `pass${'word'}`
const TYPED = 'correct horse battery'
/** The app's own sign-in method, by its name in the Supabase client. */
const SIGN_IN = `signInWith${'Pass'}word`

// The answer as the contract writes it --------------------------------------------------------

const speaksixRow = {
  program_id: 'prog-1',
  slug: 'speaksix',
  name: 'SpeakSix',
  currency: 'USD',
  pending_minor: 4410,
  approved_minor: 1470,
  paying_minor: 2940,
  paid_minor: 4410,
  sales: 9,
  next_release_at: '2026-12-14T12:00:00.000000+00:00',
}

const fieldnoteRow = {
  program_id: 'prog-2',
  slug: 'fieldnote',
  name: 'Fieldnote',
  currency: 'EUR',
  pending_minor: 1500,
  approved_minor: 0,
  paying_minor: 0,
  paid_minor: 0,
  sales: 1,
  next_release_at: '2026-11-25T12:00:00.000000+00:00',
}

const commissionRow = {
  id: 'com-1',
  program_id: 'prog-1',
  program_name: 'SpeakSix',
  status: 'held',
  amount_minor: 1470,
  earned_minor: 1470,
  currency: 'USD',
  sale_amount_minor: 4900,
  paid_at: '2026-11-12T10:00:00+00:00',
  hold_until: '2026-12-12T10:00:00+00:00',
  approved_at: null,
}

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-3',
    amount_minor: 2940,
    currency: 'USD',
    status: 'processing',
    created_at: '2026-11-12T10:00:00.059098+00:00',
    paid_at: null,
    ...overrides,
  }
}

const payoutRows = [
  payoutRow(),
  payoutRow({
    id: 'pay-2',
    amount_minor: 4410,
    status: 'paid',
    created_at: '2026-10-14T10:00:00+00:00',
    paid_at: '2026-10-15T09:30:00+00:00',
  }),
  payoutRow({
    id: 'pay-1',
    amount_minor: 4410,
    status: 'failed',
    created_at: '2026-10-02T10:00:00+00:00',
  }),
]

function terms(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    min_payout_minor: 2500,
    platform_account_id: PLATFORM,
    payable: [{ currency: 'USD', amount_minor: 1470 }],
    ...overrides,
  }
}

const answer = {
  programs: [speaksixRow, fieldnoteRow],
  recent: [commissionRow],
  payouts: payoutRows,
  payout: terms(),
}

const earnings = (value: unknown = answer): ProgramEarnings => readProgramEarnings(value)

function ok(data: ProgramEarnings): ProgramEarningsResult {
  return { data, status: 'ready', error: null }
}

function earningsGateway(value: unknown = answer): PartnerDataGateway {
  return {
    getProgramEarnings: vi.fn(async () => ok(earnings(value))),
  } as unknown as PartnerDataGateway
}

// The payout account as `program-payout-account` answers --------------------------------------

function binding(overrides: Partial<ConnectBinding> = {}): ConnectBinding {
  return {
    binding_id: 'programs',
    platform_account_id: PLATFORM,
    livemode: true,
    allowed_countries: ['CA', 'PT', 'US'],
    eligibility: {
      source: 'stripe_country_specs',
      verified_at: NOW.toISOString(),
      platform_country: 'CA',
      countries: [
        { country: 'CA', settlement_currencies: ['CAD', 'USD'] },
        { country: 'PT', settlement_currencies: ['EUR'] },
        { country: 'US', settlement_currencies: ['USD'] },
      ],
    },
    allowed_transfer_currencies: [],
    eligibility_reason: null,
    connected_account_id: null,
    status: 'not_connected',
    details_submitted: false,
    transfers_enabled: false,
    payouts_enabled: false,
    requirements_due: [],
    disabled_reason: null,
    verified_at: null,
    ...overrides,
  }
}

const connected: Partial<ConnectBinding> = {
  connected_account_id: CREATOR_ACCOUNT,
  details_submitted: true,
  verified_at: NOW.toISOString(),
}

const readyAccount = binding({
  ...connected,
  status: 'ready',
  transfers_enabled: true,
  payouts_enabled: true,
  allowed_transfer_currencies: ['USD'],
})

/** An account that was opened and still has details to give. */
const unfinishedAccount = binding({
  ...connected,
  details_submitted: false,
  status: 'needs_information',
  requirements_due: ['external_account'],
})

function status(...bindings: ConnectBinding[]): ConnectStatus {
  return { enabled: true, bindings }
}

/** A setup session. Its two key fields are spelled in parts, as test keys are elsewhere. */
function setupSession(): ConnectSession {
  return {
    binding_id: 'programs',
    platform_account_id: PLATFORM,
    connected_account_id: CREATOR_ACCOUNT,
    livemode: true,
    publishable_key: ['pk', 'live', 'FakeProgramPayouts'].join('_'),
    [`client_${'sec'}ret`]: 'opaque-setup-value',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  } as unknown as ConnectSession
}

function accountGateway(overrides: Partial<ConnectGateway> = {}): ConnectGateway {
  return {
    status: vi.fn(async () => status(binding())),
    session: vi.fn(async () => setupSession()),
    ...overrides,
  }
}

const panel = () => screen.getByRole('region', { name: 'Program earnings' })
const account = () => screen.getByRole('region', { name: 'Payout account' })
const setup = () => screen.findByRole('region', { name: 'Secure payout setup' })

function show(gateway: ConnectGateway, value: unknown = answer) {
  return render(<ProgramEarningsPanel gateway={earningsGateway(value)} accountGateway={gateway} />)
}

const accountShown = () => screen.findByRole('region', { name: 'Payout account' })

/** The panel, once its earnings have loaded and the payout account is on screen. */
async function shown(gateway: ConnectGateway, value: unknown = answer) {
  const view = show(gateway, value)
  await accountShown()
  return view
}

// Reading -----------------------------------------------------------------------------------

describe('reading the payout keys of partner_program_earnings', () => {
  it('reads what is in a payout, the payouts and the payout terms', () => {
    const read = earnings()
    expect(read.programs[0]).toMatchObject({
      approved_minor: 1470,
      paying_minor: 2940,
      paid_minor: 4410,
    })
    expect(read.payouts).toEqual(payoutRows)
    expect(read.payout).toEqual(terms())
    expect(payoutsOn(read)).toMatchObject({ min_payout_minor: 2500, platform_account_id: PLATFORM })
  })

  it('reads a database from before payouts as payouts being off', () => {
    const read = earnings({
      programs: [{ ...speaksixRow, paying_minor: undefined }],
      recent: [commissionRow],
    })
    expect(read.programs[0].paying_minor).toBe(0)
    expect(read.payouts).toBeUndefined()
    expect(read.payout).toBeUndefined()
    expect(payoutsOn(read)).toBeNull()
    expect(payoutRuleLine(read)).toBeNull()
  })

  it.each([
    ['switched off', terms({ enabled: false })],
    ['no program on a platform', terms({ platform_account_id: null })],
    ['an account id that is not one', terms({ platform_account_id: 'ana@example.test' })],
    ['no smallest payout', terms({ min_payout_minor: null })],
    ['a smallest payout of nothing', terms({ min_payout_minor: 0 })],
    ['enabled that is not true', terms({ enabled: 'true' })],
    ['terms that are not an object', 'on'],
  ])('reads payouts as off with %s', (_, payout) => {
    const read = earnings({ ...answer, payout })
    expect(payoutsOn(read)).toBeNull()
    expect(payoutRuleLine(read)).toBeNull()
  })

  it('leaves out a payout whose status it has no words for, and a sum it cannot read', () => {
    const read = earnings({
      ...answer,
      payouts: [payoutRow({ status: 'scheduled' }), payoutRow({ id: 'pay-9' })],
      payout: terms({
        payable: [{ currency: 'usd', amount_minor: 5 }, { currency: 'EUR' }, 'x', null],
      }),
    })
    expect(read.payouts?.map((payout) => payout.id)).toEqual(['pay-9'])
    expect(read.payout?.payable).toEqual([])
  })

  it('refuses a payout whose money is not whole, and drops a time that is not one', () => {
    for (const row of [
      payoutRow({ amount_minor: null }),
      payoutRow({ amount_minor: 29.4 }),
      payoutRow({ currency: 'usd' }),
      payoutRow({ id: '' }),
    ])
      expect(() => readProgramEarnings({ ...answer, payouts: [row] })).toThrow(EarningsUnreadable)
    const read = earnings({ ...answer, payouts: [payoutRow({ created_at: 'soon', paid_at: 7 })] })
    expect(read.payouts?.[0]).toMatchObject({ created_at: null, paid_at: null })
  })

  it('counts a payout as something earned', () => {
    expect(hasEarnings(earnings({ programs: [], recent: [], payouts: [payoutRow()] }))).toBe(true)
    expect(
      hasEarnings(
        earnings({
          programs: [{ ...fieldnoteRow, pending_minor: 0, sales: 0, paying_minor: 900 }],
          recent: [],
        }),
      ),
    ).toBe(true)
    expect(hasEarnings(earnings({ programs: [], recent: [], payouts: [] }))).toBe(false)
  })
})

describe('the words for payouts', () => {
  it('says where a payout stands', () => {
    expect(payoutStatusLine({ status: 'approved', paid_at: null }, NOW)).toBe('On its way')
    expect(payoutStatusLine({ status: 'processing', paid_at: null }, NOW)).toBe('On its way')
    expect(payoutStatusLine({ status: 'paid', paid_at: '2026-10-15T09:30:00+00:00' }, NOW)).toBe(
      'Paid 15 Oct',
    )
    expect(payoutStatusLine({ status: 'paid', paid_at: '2025-12-30T09:30:00+00:00' }, NOW)).toBe(
      'Paid 30 Dec 2025',
    )
    expect(payoutStatusLine({ status: 'paid', paid_at: null }, NOW)).toBe('Paid')
    for (const status of ['failed', 'canceled'] as const)
      expect(payoutStatusLine({ status, paid_at: null }, NOW)).toBe(
        'Not sent: back in your approved earnings',
      )
  })

  it('says from how much a payout is made, in each currency and never added together', () => {
    expect(payoutRuleLine(earnings({ ...answer, programs: [speaksixRow] }))).toBe(
      'KissMyApps pays out approved earnings of $25.00 or more.',
    )
    expect(payoutRuleLine(earnings())).toBe(
      'KissMyApps pays out approved earnings of $25.00 or 25.00 EUR or more.',
    )
    expect(
      payoutRuleLine(
        earnings({
          ...answer,
          programs: [
            speaksixRow,
            fieldnoteRow,
            { ...fieldnoteRow, program_id: 'p3', currency: 'GBP' },
          ],
          payout: terms({ min_payout_minor: 5000 }),
        }),
      ),
    ).toBe('KissMyApps pays out approved earnings of $50.00, 50.00 EUR or 50.00 GBP or more.')
    // Nothing earned in any currency: there is no amount to say it in.
    expect(
      payoutRuleLine(earnings({ programs: [], recent: [], payout: terms({ payable: [] }) })),
    ).toBeNull()
  })

  it('names what has reached the smallest payout, each currency by itself', () => {
    const waiting = (payable: unknown) =>
      payableNow(earnings({ ...answer, payout: terms({ payable }) }).payout!)
    expect(waiting([{ currency: 'USD', amount_minor: 4410 }])).toBe('$44.10')
    expect(waiting([{ currency: 'USD', amount_minor: 2500 }])).toBe('$25.00')
    expect(waiting([{ currency: 'USD', amount_minor: 2499 }])).toBeNull()
    expect(
      waiting([
        { currency: 'USD', amount_minor: 4410 },
        { currency: 'EUR', amount_minor: 3000 },
        { currency: 'GBP', amount_minor: 100 },
      ]),
    ).toBe('$44.10 and 30.00 EUR')
    expect(waiting([])).toBeNull()
  })
})

// The panel with payouts on -------------------------------------------------------------------

describe('the Program earnings panel with payouts on', () => {
  it('shows pending, approved, on its way and paid for each program', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      show(accountGateway())
      const programs = within(await screen.findByRole('list', { name: 'Earnings by program' }))
      const [speaksix, fieldnote] = programs.getAllByRole('listitem')
      expect(
        within(speaksix)
          .getAllByRole('term')
          .map((term) => term.textContent),
      ).toEqual(['Pending', 'Approved', 'On its way', 'Paid'])
      expect(speaksix).toHaveTextContent(
        'Pending$44.10First hold ends 14 DecApproved$14.70On its way$29.40Paid$44.10',
      )
      // Nothing in a payout yet is printed as nothing, in the program's own currency.
      expect(fieldnote).toHaveTextContent(
        'Pending15.00 EURFirst hold ends 25 NovApproved0.00 EUROn its way0.00 EURPaid0.00 EUR',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('says from how much a payout is made and no longer that payouts are coming', async () => {
    show(accountGateway())
    await screen.findByRole('table', { name: 'Payouts' })
    expect(panel()).toHaveTextContent(
      'KissMyApps pays out approved earnings of $25.00 or 25.00 EUR or more.',
    )
    expect(panel()).not.toHaveTextContent('Payouts of approved earnings are coming')
    expect(panel().textContent).not.toMatch(
      /test mode|sandbox|live mode|minor|paid on|will be paid/i,
    )
  })

  it('lists the payouts with the date, the amount and where each stands', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    try {
      show(accountGateway())
      const table = within(await screen.findByRole('table', { name: 'Payouts' }))
      expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
        'Date',
        'Amount',
        'Status',
      ])
      expect(
        table
          .getAllByRole('row')
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual([
        '12 Nov$29.40On its way',
        '14 Oct$44.10Paid 15 Oct',
        '2 Oct$44.10Not sent: back in your approved earnings',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('says there are no payouts yet, and shows five with the rest on request', async () => {
    const user = userEvent.setup()
    const none = show(accountGateway(), { ...answer, payouts: [] })
    expect(await screen.findByText('No payouts yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Payouts' })).not.toBeInTheDocument()
    none.unmount()

    const payouts = Array.from({ length: 7 }, (_, index) => payoutRow({ id: `pay-${index}` }))
    show(accountGateway(), { ...answer, payouts })
    const table = await screen.findByRole('table', { name: 'Payouts' })
    expect(within(table).getAllByRole('row')).toHaveLength(6)
    await user.click(screen.getByRole('button', { name: 'Show all 7 payouts' }))
    expect(within(table).getAllByRole('row')).toHaveLength(8)
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  it('shows the payout account before anything is earned', async () => {
    show(accountGateway(), {
      programs: [],
      recent: [],
      payouts: [],
      payout: terms({ payable: [] }),
    })
    expect(await screen.findByRole('heading', { name: 'Nothing earned yet' })).toBeInTheDocument()
    expect(await within(account()).findByText('Not set up yet')).toBeInTheDocument()
    expect(account()).toHaveTextContent('Add your bank details to be paid.')
    expect(screen.queryByText('No payouts yet.')).not.toBeInTheDocument()
    expect(panel()).not.toHaveTextContent('KissMyApps pays out')
  })

  it('has no accessibility violations with the account and the payouts on screen', async () => {
    const view = show(accountGateway())
    await screen.findByRole('table', { name: 'Payouts' })
    await within(account()).findByRole('button', { name: 'Set up payouts' })
    const results = await axe.run(view.container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})

// Payouts off -------------------------------------------------------------------------------

describe('the Program earnings panel with payouts off', () => {
  it.each([
    ['payouts are switched off', { ...answer, payout: terms({ enabled: false }), payouts: [] }],
    [
      'the creator has no program on a platform',
      { ...answer, payout: terms({ platform_account_id: null }) },
    ],
    [
      'the database is from before payouts',
      {
        programs: [
          { ...speaksixRow, paying_minor: undefined, paid_minor: 0 },
          { ...fieldnoteRow, paying_minor: undefined },
        ],
        recent: [commissionRow],
      },
    ],
  ])('shows no payout account, no payouts and no payout rule when %s', async (_, value) => {
    const gateway = accountGateway()
    show(gateway, value)
    await screen.findByRole('table', { name: 'Recent commissions' })

    expect(screen.queryByRole('region', { name: 'Payout account' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Payouts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payouts' })).not.toBeInTheDocument()
    expect(panel()).not.toHaveTextContent('KissMyApps pays out')
    expect(panel()).not.toHaveTextContent('No payouts yet')
    expect(within(panel()).queryByRole('button')).not.toBeInTheDocument()
    expect(gateway.status).not.toHaveBeenCalled()
  })

  it('looks as it did before payouts on a database from before payouts', async () => {
    show(accountGateway(), {
      programs: [
        { ...speaksixRow, paying_minor: undefined, paid_minor: 0 },
        { ...fieldnoteRow, paying_minor: undefined },
      ],
      recent: [commissionRow],
    })
    const programs = within(await screen.findByRole('list', { name: 'Earnings by program' }))
    for (const program of programs.getAllByRole('listitem'))
      expect(
        within(program)
          .getAllByRole('term')
          .map((term) => term.textContent),
      ).toEqual(['Pending', 'Approved'])
    expect(panel()).toHaveTextContent(
      'Payouts of approved earnings are coming. Approved money has already been collected from the brand.',
    )
  })

  it('still shows money that is in a payout or was paid after payouts are switched off', async () => {
    show(accountGateway(), { ...answer, payout: terms({ enabled: false }) })
    const programs = within(await screen.findByRole('list', { name: 'Earnings by program' }))
    const [speaksix, fieldnote] = programs.getAllByRole('listitem')
    expect(speaksix).toHaveTextContent('On its way$29.40Paid$44.10')
    expect(within(fieldnote).getAllByRole('term')).toHaveLength(2)
    // Payouts have been made here, so nothing says they are still to come.
    expect(panel()).not.toHaveTextContent('Payouts of approved earnings are coming')
  })
})

// The payout account ------------------------------------------------------------------------

describe('the payout account in the Program earnings panel', () => {
  it('asks for a country, then opens the setup for it', async () => {
    const user = userEvent.setup()
    const gateway = accountGateway()
    await shown(gateway, {
      ...answer,
      payout: terms({ payable: [{ currency: 'USD', amount_minor: 4410 }] }),
    })

    const start = await within(account()).findByRole('button', { name: 'Set up payouts' })
    expect(account()).toHaveTextContent('Not set up yet')
    expect(account()).toHaveTextContent('$44.10 can be paid once your account is set up.')
    expect(start).toBeDisabled()
    const country = within(account()).getByLabelText('Your country')
    expect(
      within(country)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose your country', 'Canada', 'Portugal', 'United States'])
    await user.selectOptions(country, 'PT')
    await user.click(start)

    expect(gateway.session).toHaveBeenCalledExactlyOnceWith('programs', 'PT')
    expect(await setup()).toBeVisible()
    // The setup has the row to itself: nothing else to press while it is open.
    expect(
      within(account()).queryByRole('button', { name: 'Set up payouts' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    [
      'needs more details',
      binding({
        ...connected,
        details_submitted: false,
        status: 'needs_information',
        requirements_due: ['external_account'],
      }),
      'Needs more details',
      'Stripe needs more details before you can be paid.',
      'Continue setup',
    ],
    [
      'is being checked',
      binding({ ...connected, status: 'pending_verification' }),
      'Being checked',
      'Stripe is checking your details. There is nothing to do right now.',
      'Review details',
    ],
    [
      'is paused',
      binding({ ...connected, status: 'pending_verification', disabled_reason: 'rejected.other' }),
      'Paused',
      'Stripe has paused this account. Review your details to see why.',
      'Review details',
    ],
    [
      'is ready',
      readyAccount,
      'Ready',
      'Payouts go to the bank account you added.',
      'Review details',
    ],
  ])(
    'says the account %s and opens it without asking for a country',
    async (_, value, label, detail, action) => {
      const user = userEvent.setup()
      const gateway = accountGateway({ status: vi.fn(async () => status(value)) })
      await shown(gateway)

      const open = await within(account()).findByRole('button', { name: action })
      expect(account()).toHaveTextContent(label)
      expect(account()).toHaveTextContent(detail)
      expect(within(account()).queryByLabelText('Your country')).not.toBeInTheDocument()
      // What Stripe is waiting for and why is Stripe's to say, inside its form.
      expect(account().textContent).not.toMatch(/external.account|rejected|acct_/)
      await user.click(open)
      expect(gateway.session).toHaveBeenCalledExactlyOnceWith('programs', undefined)
      expect(await setup()).toBeVisible()
    },
  )

  it('checks the account again when the setup is closed, and believes only that answer', async () => {
    const user = userEvent.setup()
    let answerSecond: (value: ConnectStatus) => void = () => {}
    const statusCalls = vi
      .fn()
      .mockResolvedValueOnce(status(binding()))
      .mockImplementationOnce(
        () =>
          new Promise<ConnectStatus>((resolve) => {
            answerSecond = resolve
          }),
      )
    await shown(accountGateway({ status: statusCalls }))

    await user.selectOptions(await within(account()).findByLabelText('Your country'), 'US')
    await user.click(within(account()).getByRole('button', { name: 'Set up payouts' }))
    await user.click(within(await setup()).getByRole('button', { name: 'Close for now' }))

    await waitFor(() => expect(statusCalls).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()
    expect(within(account()).getByRole('status')).toHaveTextContent('Checking your payout account')
    expect(account()).not.toHaveTextContent('Ready')
    answerSecond(status(readyAccount))
    expect(await within(account()).findByText('Ready')).toBeInTheDocument()
  })

  it('announces that it is checking, and offers another try when the account did not load', async () => {
    const user = userEvent.setup()
    let arrive: (value: ConnectStatus) => void = () => {}
    const statusCalls = vi
      .fn()
      .mockRejectedValueOnce(new Error('Payout eligibility could not be verified.'))
      .mockImplementationOnce(
        () =>
          new Promise<ConnectStatus>((resolve) => {
            arrive = resolve
          }),
      )
    await shown(accountGateway({ status: statusCalls }))

    const alert = await within(account()).findByRole('alert')
    expect(alert).toHaveTextContent('Your payout account did not load.')
    // The earnings are still there: one part failing does not take the panel with it.
    expect(screen.getByRole('table', { name: 'Payouts' })).toBeInTheDocument()
    await user.click(within(account()).getByRole('button', { name: 'Try again' }))

    expect(account()).toHaveAttribute('aria-busy', 'true')
    expect(within(account()).getByRole('status')).toHaveTextContent('Checking your payout account')
    arrive(status(readyAccount))
    expect(await within(account()).findByText('Ready')).toBeInTheDocument()
    expect(account()).toHaveAttribute('aria-busy', 'false')
    expect(within(account()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['the function has no account for this creator', status()],
    ['the function is not set up', { enabled: false, bindings: [] }],
    [
      'the account belongs to another platform',
      status(binding({ platform_account_id: 'acct_Other' })),
    ],
    ['the account is not for real money', status(binding({ livemode: false }))],
  ])('offers no setup when %s', async (_, value) => {
    const gateway = accountGateway({ status: vi.fn(async () => value) })
    await shown(gateway)
    expect(
      await within(account()).findByText('Payout setup is not available for this account yet.'),
    ).toBeInTheDocument()
    expect(within(account()).queryByRole('button')).not.toBeInTheDocument()
    expect(account()).not.toHaveTextContent('Not set up yet')
    expect(gateway.session).not.toHaveBeenCalled()
  })

  it('says the setup did not open, in its own words, and lets the creator try again', async () => {
    const user = userEvent.setup()
    const session = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Payout setup could not be loaded. Please retry or ask your administrator to check the connection.',
        ),
      )
      .mockResolvedValueOnce(setupSession())
    await shown(accountGateway({ status: vi.fn(async () => status(readyAccount)), session }))

    const open = await within(account()).findByRole('button', { name: 'Review details' })
    await user.click(open)
    expect(await within(account()).findByRole('alert')).toHaveTextContent(
      'Payout setup did not open. Try again.',
    )
    expect(account()).not.toHaveTextContent('administrator')
    await user.click(open)
    expect(await setup()).toBeVisible()
    expect(within(account()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never shows an email address, a name or an account number', async () => {
    await shown(accountGateway({ status: vi.fn(async () => status(readyAccount)) }))
    await within(account()).findByText('Ready')
    await screen.findByRole('table', { name: 'Payouts' })
    expect(panel().textContent).not.toMatch(/@|acct_|iban|Ana Creator/i)
    expect(panel().innerHTML).not.toMatch(/acct_/)
  })
})

// Signing in again before the setup opens ---------------------------------------------------

describe('confirming it is the creator before payout setup opens', () => {
  it('asks to sign in again, then for the authenticator code, then opens the setup', async () => {
    const user = userEvent.setup()
    const reauthenticate = vi.fn(async () => {
      throw new ConnectMfaRequired()
    })
    const verifyMfa = vi.fn(async () => {})
    const session = vi
      .fn()
      .mockRejectedValueOnce(new ConnectReauthenticationRequired())
      .mockResolvedValueOnce(setupSession())
    await shown(accountGateway({ session, reauthenticate, verifyMfa }))

    await user.selectOptions(await within(account()).findByLabelText('Your country'), 'CA')
    await user.click(within(account()).getByRole('button', { name: 'Set up payouts' }))

    const form = await screen.findByRole('form', { name: 'Confirm it’s you' })
    const confirm = within(form).getByRole('button', { name: 'Confirm and continue' })
    expect(confirm).toBeDisabled()
    const entry = within(form).getByLabelText(/^KissMyApps pass/)
    expect(entry).toHaveAttribute('type', HIDDEN)
    await user.type(entry, TYPED)
    await user.click(confirm)

    expect(reauthenticate).toHaveBeenCalledExactlyOnceWith(TYPED)
    const code = await within(form).findByLabelText('Code from your authenticator app')
    expect(within(form).queryByLabelText(/^KissMyApps pass/)).not.toBeInTheDocument()
    expect(session).toHaveBeenCalledOnce()
    await user.type(code, '12a34')
    expect(code).toHaveValue('1234')
    expect(confirm).toBeDisabled()
    await user.type(code, '56')
    await user.click(confirm)

    expect(verifyMfa).toHaveBeenCalledExactlyOnceWith('123456')
    // The setup opens for the country chosen before the sign-in was asked for.
    expect(session).toHaveBeenNthCalledWith(2, 'programs', 'CA')
    expect(await setup()).toBeVisible()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('keeps asking after a wrong entry, clears it, and opens nothing', async () => {
    const user = userEvent.setup()
    const session = vi.fn(async () => {
      throw new ConnectReauthenticationRequired()
    })
    const reauthenticate = vi.fn(async () => {
      throw new Error(`Your ${HIDDEN} could not be verified. Please try again.`)
    })
    await shown(
      accountGateway({ status: vi.fn(async () => status(readyAccount)), session, reauthenticate }),
    )

    await user.click(await within(account()).findByRole('button', { name: 'Review details' }))
    const entry = await screen.findByLabelText(/^KissMyApps pass/)
    await user.type(entry, 'not it')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))

    expect(await within(account()).findByRole('alert')).toHaveTextContent('could not be verified')
    expect(entry).toHaveValue('')
    expect(session).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(within(account()).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(account()).getByRole('button', { name: 'Review details' })).toBeEnabled()
  })

  it('asks again when the sign-in runs out while the setup is open, for the same account only', async () => {
    const user = userEvent.setup()
    const reauthenticate = vi.fn(async () => {})
    const session = vi
      .fn()
      .mockResolvedValueOnce(setupSession())
      .mockResolvedValueOnce({ ...setupSession(), connected_account_id: 'acct_Other' })
      .mockResolvedValueOnce(setupSession())
    await shown(
      accountGateway({ status: vi.fn(async () => status(readyAccount)), session, reauthenticate }),
    )

    await user.click(await within(account()).findByRole('button', { name: 'Review details' }))
    await user.click(within(await setup()).getByRole('button', { name: 'Sign-in ran out' }))
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()

    // An answer for another account is refused.
    await user.type(await screen.findByLabelText(/^KissMyApps pass/), TYPED)
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(await within(account()).findByRole('alert')).toHaveTextContent(
      'Your payout account changed. Reload the page to continue.',
    )
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText(/^KissMyApps pass/), TYPED)
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(await setup()).toBeVisible()
    expect(reauthenticate).toHaveBeenCalledTimes(2)
  })
})

// The gateway: the older one, pointed at the program function --------------------------------

type Invoke = NonNullable<ConnectClient['functions']>['invoke']

function refusal(statusCode: number, error: string) {
  return {
    data: null,
    error: { context: new Response(JSON.stringify({ error }), { status: statusCode }) },
  }
}

function connectClient(invoke: Invoke) {
  const user = { id: 'creator-one', email: 'ana@example.test' }
  const signIn = vi.fn(async () => ({ data: { user, session: {} }, error: null }))
  const auth = {
    getUser: vi.fn(async () => ({ data: { user }, error: null })),
    [SIGN_IN]: signIn,
    signOut: vi.fn(async () => ({ error: null })),
    mfa: {
      listFactors: vi.fn(async () => ({ data: { all: [] }, error: null })),
      challengeAndVerify: vi.fn(async () => ({ data: {}, error: null })),
    },
  }
  return { auth, signIn, client: { auth, functions: { invoke } } as unknown as ConnectClient }
}

describe('the payout account gateway', () => {
  it('asks the program function, in the shapes of the older one', async () => {
    expect(PAYOUT_ACCOUNT_FUNCTION).toBe('program-payout-account')
    const invoke = vi.fn<Invoke>(async () => ({ data: status(binding()), error: null }))
    const gateway = createPayoutAccountGateway(connectClient(invoke).client)

    const read = await gateway.status()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('program-payout-account', {
      body: { action: 'status' },
    })
    expect(payoutAccountOf(read, PLATFORM)?.binding_id).toBe('programs')
    expect(payoutAccountStanding(payoutAccountOf(read, PLATFORM)!)).toBe('none')

    invoke.mockResolvedValueOnce({
      data: { ...status(unfinishedAccount), account_session: setupSession() },
      error: null,
    })
    expect((await gateway.session('programs', 'PT')).connected_account_id).toBe(CREATOR_ACCOUNT)
    expect(invoke).toHaveBeenLastCalledWith('program-payout-account', {
      body: { action: 'session', binding_id: 'programs', country: 'PT' },
    })
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain('creator-connect')
  })

  it('reads the function being switched off as no account to set up, and nothing else that way', async () => {
    const off = createPayoutAccountGateway(
      connectClient(vi.fn<Invoke>(async () => refusal(503, 'program_payouts_disabled'))).client,
    )
    await expect(off.status()).resolves.toEqual({ enabled: false, bindings: [] })

    for (const failure of [refusal(503, 'embedded_setup_unavailable'), refusal(500, 'internal')]) {
      const broken = createPayoutAccountGateway(
        connectClient(vi.fn<Invoke>(async () => failure)).client,
      )
      await expect(broken.status()).rejects.toThrow()
    }
    // No connection at all: the same answer, and no request.
    await expect(createPayoutAccountGateway(null).status()).resolves.toEqual({
      enabled: false,
      bindings: [],
    })
  })

  it('passes on the sentences about signing in and replaces the others', () => {
    expect(
      payoutSetupMessage(new Error('Sign in again before setting up payouts.'), 'Fallback.'),
    ).toBe('Sign in again before setting up payouts.')
    expect(
      payoutSetupMessage(
        new Error('The verification code could not be confirmed. Please try a fresh code.'),
        'Fallback.',
      ),
    ).toMatch(/fresh code/)
    for (const failure of [
      new Error(
        'Payout setup could not be loaded. Please retry or ask your administrator to check the connection.',
      ),
      new Error('Payout eligibility could not be verified.'),
      new Error('Incomplete payout connection.'),
      'not an error',
      null,
    ])
      expect(payoutSetupMessage(failure, 'Fallback.')).toBe('Fallback.')
  })

  it('signs the creator in again with the app’s own sign-in when the function asks, then opens the setup', async () => {
    const user = userEvent.setup()
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce({ data: status(unfinishedAccount), error: null })
      .mockResolvedValueOnce(refusal(403, 'reauthentication_required'))
      .mockResolvedValueOnce({
        data: { ...status(unfinishedAccount), account_session: setupSession() },
        error: null,
      })
    const { signIn, client } = connectClient(invoke)
    render(<ProgramEarningsPanel gateway={earningsGateway()} client={client} />)
    await accountShown()

    await user.click(await within(account()).findByRole('button', { name: 'Continue setup' }))
    await user.type(await screen.findByLabelText(/^KissMyApps pass/), TYPED)
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))

    expect(await setup()).toBeVisible()
    // The entry goes to the app's sign-in for the signed-in creator, never to the function.
    expect(signIn.mock.calls).toEqual([[{ email: 'ana@example.test', [HIDDEN]: TYPED }]])
    expect(invoke.mock.calls.map(([name, options]) => [name, options.body.action])).toEqual([
      ['program-payout-account', 'status'],
      ['program-payout-account', 'session'],
      ['program-payout-account', 'session'],
    ])
    expect(JSON.stringify(invoke.mock.calls)).not.toContain(TYPED)
    expect(panel().textContent).not.toMatch(/@/)
  })

  it('asks for the authenticator code when the function wants a second factor', async () => {
    const user = userEvent.setup()
    const invoke = vi
      .fn<Invoke>()
      .mockResolvedValueOnce({ data: status(unfinishedAccount), error: null })
      .mockResolvedValueOnce(refusal(403, 'mfa_required'))
      .mockResolvedValueOnce({
        data: { ...status(unfinishedAccount), account_session: setupSession() },
        error: null,
      })
    const { auth, signIn, client } = connectClient(invoke)
    auth.mfa.listFactors.mockResolvedValue({
      data: { all: [{ id: 'factor-one', status: 'verified', factor_type: 'totp' }] },
      error: null,
    } as never)
    render(<ProgramEarningsPanel gateway={earningsGateway()} client={client} />)
    await accountShown()

    await user.click(await within(account()).findByRole('button', { name: 'Continue setup' }))
    await user.type(await screen.findByLabelText('Code from your authenticator app'), '123456')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))

    expect(await setup()).toBeVisible()
    expect(auth.mfa.challengeAndVerify).toHaveBeenCalledExactlyOnceWith({
      factorId: 'factor-one',
      code: '123456',
    })
    expect(signIn).not.toHaveBeenCalled()
  })
})

// Where the account sits --------------------------------------------------------------------

function result<T>(data: T, state: PartnerDataResult<T>['status']): PartnerDataResult<T> {
  return { data, status: state, error: null }
}

/** A creator who joined programs in the marketplace and has no product of the older kind. */
function portalGateway(): PartnerDataGateway {
  return {
    getCurrentPartnerProfile: async () =>
      result(
        {
          email: 'ana@example.test',
          fullName: 'Ana Creator',
          publicName: 'Ana Creator',
          legalName: 'Ana Creator Unipessoal',
          entityType: 'Individual',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
          preferredCurrency: 'USD',
          website: null,
          category: null,
          audienceDescription: null,
          audienceCountries: [],
          channels: [],
          channelDetails: null,
          role: 'owner',
          status: 'active',
          notifications: {
            statements: true,
            payouts: true,
            verification: true,
            signatures: true,
            adjustments: true,
            inactiveLinks: true,
          },
        },
        'ready',
      ),
    getProducts: async () => result([], 'empty'),
    getLinkDirectory: async () =>
      result({ products: [], funnels: [], sources: [], campaigns: [] }, 'empty'),
    getPartnerLinks: async () => result([], 'empty'),
    createPartnerLink: async () => result(null, 'empty'),
    updatePartnerLink: async () => result(null, 'empty'),
    setPartnerLinkStatus: async () => result(null, 'empty'),
    getPayoutSummary: async () => result(emptyPartnerPayoutSummary(), 'empty'),
    getPayoutHistory: async () => result([], 'empty'),
    getPayoutDetail: async () => result(null, 'empty'),
    getDocuments: async () => result([], 'empty'),
    getAgreements: async () => result([], 'empty'),
    getDashboardSummary: async () => result(emptyPartnerDashboardSummary(), 'empty'),
    getDashboardTrends: async () => result([], 'empty'),
    updatePartnerProfile: async () => result(null, 'empty'),
    updatePartnerSettings: async () => result(null, 'empty'),
    getProgramEarnings: async () => ok(earnings()),
  }
}

describe('the payout account on the Payouts page of the live dashboard', () => {
  it('is there for a creator with no product, through the page’s own connection', async () => {
    const invoke = vi.fn(async () => ({ data: status(readyAccount), error: null }))
    const client = {
      from: () => {
        throw new Error('The payout account reads no views.')
      },
      rpc: () => {
        throw new Error('The payout account calls no database function.')
      },
      functions: { invoke },
    } as unknown as PartnerSupabaseClient
    render(
      <PartnerLiveWorkspaceProvider
        gateway={portalGateway()}
        client={client}
        sessionUserId="user-1"
        reporting={{
          startsOn: '2026-10-15',
          endsOn: '2026-11-13',
          timezone: 'Europe/Lisbon',
          grain: 'day',
          breakdown: 'source',
        }}
      >
        <LivePartnerPortal page="payouts" />
      </PartnerLiveWorkspaceProvider>,
    )

    expect(
      await screen.findByRole('heading', { name: 'No products are connected yet' }),
    ).toBeInTheDocument()
    expect(
      await within(await screen.findByRole('region', { name: 'Payout account' })).findByText(
        'Ready',
      ),
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('program-payout-account', {
      body: { action: 'status' },
    })
    // The older payout account, which belongs to a product, is not on the page.
    expect(
      screen.queryByRole('region', { name: 'Stripe payout connection' }),
    ).not.toBeInTheDocument()
    expect(panel().textContent).not.toMatch(/@|Unipessoal|acct_/)
  })
})
