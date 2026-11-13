import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type { AdminDataResult, AdminGateway, AdminRole } from '../api/types'
import { PayoutsPage } from '../payouts/PayoutsPage'
import { workspaceFixture } from '../payouts/fixtures'
import {
  PAYOUT_AMOUNT_CHANGED,
  PAYOUT_MONEY_OFF,
  PAYOUT_NOT_CANCELABLE,
  PAYOUT_NO_PLATFORM,
  PAYOUT_SETTINGS_CHANGED,
} from './api'
import type {
  AdminProgramPayoutAction,
  AdminProgramPayoutSettings,
  AdminProgramPayouts,
} from './api'
import {
  PAYOUTS_READ_AT,
  emptyPayoutsFixture,
  fixtureCreators,
  fixtureOpen,
  payoutsFixture,
} from './fixtures'
import { ProgramPayoutsPanel } from './ProgramPayoutsPanel'

type PayoutsResult = AdminDataResult<AdminProgramPayouts | null>
type PayoutMethods = Pick<
  AdminGateway,
  'getProgramPayouts' | 'performProgramPayout' | 'configureProgramPayouts'
>

const SAVED_AT = '2026-11-13T14:05:00.000000+00:00'
const [ada, mateo, priya, , , lena] = fixtureCreators
const noah = fixtureOpen[1]

const ready = (data: AdminProgramPayouts): PayoutsResult => ({ data, status: 'ready', error: null })

function failed(code: NonNullable<PayoutsResult['error']>['code'], message = 'No.'): PayoutsResult {
  return { data: null, status: 'error', error: { code, message, retryable: false } }
}

const signedOut: PayoutsResult = {
  data: null,
  status: 'unauthorized',
  error: { code: 'not_authorized', message: 'No.', retryable: false },
}

/** What the database answers after everyone who was ready in a currency has been paid. */
function afterPaying(payouts: AdminProgramPayouts, affiliateIds: string[]): AdminProgramPayouts {
  const paid = payouts.creators.filter((creator) => affiliateIds.includes(creator.affiliateId))
  return payoutsFixture({
    ...payouts,
    creators: payouts.creators.filter((creator) => !paid.includes(creator)),
    open: [
      ...payouts.open,
      ...paid.map((creator, index) => ({
        id: `fa110000-0000-4000-8000-00000000010${index}`,
        affiliateId: creator.affiliateId,
        name: creator.name,
        currency: creator.currency,
        amountMinor: creator.payableMinor,
        status: 'approved' as const,
        attempts: 0,
        failureCode: null,
        createdAt: SAVED_AT,
        nextAttemptAt: null,
        canCancel: true,
      })),
    ],
  })
}

/** A gateway that answers the way the backend does: the same object after every change. */
function payoutGateway(
  payouts: AdminProgramPayouts = payoutsFixture(),
  overrides: Partial<PayoutMethods> = {},
) {
  const getProgramPayouts = vi.fn(async (): Promise<PayoutsResult> => ready(payouts))
  const performProgramPayout = vi.fn(
    async (action: AdminProgramPayoutAction): Promise<PayoutsResult> => {
      if (action.action === 'cancel') {
        return ready(
          payoutsFixture({
            ...payouts,
            open: payouts.open.filter((payout) => payout.id !== action.payoutId),
          }),
        )
      }
      const paid = payouts.creators.filter(
        (creator) =>
          creator.blocker === null &&
          creator.currency === action.currency &&
          (action.action === 'pay_ready' || creator.affiliateId === action.affiliateId),
      )
      return ready(
        afterPaying(
          payouts,
          paid.map((creator) => creator.affiliateId),
        ),
      )
    },
  )
  const configureProgramPayouts = vi.fn(
    async (input: AdminProgramPayoutSettings): Promise<PayoutsResult> =>
      ready(
        payoutsFixture({
          ...payouts,
          enabled: input.enabled,
          minPayoutMinor: input.minPayoutMinor,
          updatedAt: SAVED_AT,
        }),
      ),
  )
  const gateway = {
    getAdminContext: vi.fn(),
    getProducts: vi.fn(),
    createProduct: vi.fn(),
    getProgramPayouts,
    performProgramPayout,
    configureProgramPayouts,
    ...overrides,
  } satisfies AdminGateway
  return gateway
}

function show(gateway: AdminGateway, role: AdminRole = 'owner') {
  const view = render(<ProgramPayoutsPanel gateway={gateway} role={role} />)
  return { ...view, gateway, role }
}

const panel = () => screen.getByRole('region', { name: 'Program payouts' })
const block = (name: string) => within(screen.getByRole('group', { name }))
const loaded = () => screen.findByLabelText('Program payout totals')
const total = (label: string) =>
  within(within(screen.getByLabelText('Program payout totals')).getByText(label).closest('div')!)
const row = (name: string, text: string) =>
  within(block(name).getByText(text).closest('li') as HTMLElement)
const minInput = () => screen.getByLabelText('Smallest payout')

async function retype(user: ReturnType<typeof userEvent.setup>, input: HTMLElement, text: string) {
  await user.clear(input)
  if (text) await user.type(input, text)
}

describe('Program payouts in the admin app', () => {
  it('says it is loading until the answer arrives', async () => {
    let answer: (result: PayoutsResult) => void = () => {}
    const gateway = payoutGateway(payoutsFixture(), {
      getProgramPayouts: vi.fn(() => new Promise<PayoutsResult>((resolve) => (answer = resolve))),
    })
    show(gateway)

    expect(screen.getByRole('status')).toHaveTextContent('Loading program payouts')
    expect(panel()).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByLabelText('Program payout totals')).not.toBeInTheDocument()

    answer(ready(payoutsFixture()))
    await loaded()
    expect(panel()).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('Loading program payouts')).not.toBeInTheDocument()
  })

  it('shows the Owner the totals, who is ready, who waits, what is on its way and what was paid', async () => {
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    expect(screen.getByRole('heading', { level: 2, name: 'Program payouts' })).toBeVisible()
    expect(within(panel()).getByText('On')).toBeVisible()
    expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(1)

    expect(total('Ready to pay').getByText('$135.50')).toBeVisible()
    expect(total('Ready to pay').getByText('3 creators')).toBeVisible()
    expect(total('Paid').getByText('$306.50')).toBeVisible()

    expect(row('Ready to pay', 'Ada Okafor').getByText('$44.10')).toBeVisible()
    expect(row('Ready to pay', 'Ada Okafor').getByText(/SpeakSix \$30\.00/)).toBeVisible()
    expect(row('Ready to pay', 'Ada Okafor').getByText(/HabitLoop \$14\.10/)).toBeVisible()
    // One program: its name is enough, the amount is the row's.
    expect(row('Ready to pay', 'Mateo Rossi').getByText('SpeakSix')).toBeVisible()
    expect(block('Ready to pay').getAllByRole('button', { name: /^Pay / })).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Pay all ready: 3 creators, $135.50' })).toBeEnabled()

    expect(row('Waiting', 'Ben Carter').getByText('No payout account yet')).toBeVisible()
    expect(row('Waiting', 'Ben Carter').getByText('$31.50')).toBeVisible()
    expect(row('Waiting', 'Hana Sato').getByText('Payout account needs attention')).toBeVisible()
    expect(row('Waiting', 'Tom Whitfield').getByText('Below the smallest payout')).toBeVisible()
    expect(block('Waiting').queryByRole('button')).not.toBeInTheDocument()

    expect(
      row('On its way', 'Sofia Marin').getByText(/Trying again: platform balance too low/),
    ).toBeVisible()
    expect(row('On its way', 'Sofia Marin').queryByRole('button')).not.toBeInTheDocument()
    expect(row('On its way', 'Noah Lindqvist').getByText(/^Queued/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Cancel payout to Noah Lindqvist, $47.25' }),
    ).toBeEnabled()

    expect(row('Recent', 'Ada Okafor').getByText('Paid')).toBeVisible()
    expect(row('Recent', 'Ada Okafor').getByText('tr_3QK7dLAdaOkafor01')).toBeVisible()
    expect(row('Recent', 'Hana Sato').getByText('Not sent')).toBeVisible()
    expect(
      row('Recent', 'Hana Sato').getByText('Payout account could not receive it'),
    ).toBeVisible()
    expect(row('Recent', 'Priya Nair').getByText('Canceled')).toBeVisible()
    expect(
      screen.getByText(/not sent or was canceled is back in what the creator is owed/i),
    ).toBeVisible()

    expect(minInput()).toHaveValue('25.00')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Switch off payouts' })).toBeEnabled()
  })

  it('never adds different currencies together', async () => {
    const euros = payoutsFixture({
      creators: [
        ...fixtureCreators.map((creator) =>
          creator === lena ? { ...creator, blocker: null, payableMinor: 4100 } : creator,
        ),
        {
          ...lena,
          affiliateId: 'c0de0000-0000-4000-8000-000000000020',
          name: 'Jonas Weber',
          blocker: null,
          payableMinor: 6050,
        },
        // One creator owed in two currencies: two rows, never one sum.
        { ...ada, currency: 'EUR', payableMinor: 2600 },
      ],
    })
    const user = userEvent.setup()
    const gateway = payoutGateway(euros)
    show(gateway)
    await loaded()

    expect(total('Ready to pay').getByText('$135.50')).toBeVisible()
    expect(total('Ready to pay').getByText('127.50 EUR')).toBeVisible()
    expect(total('Waiting').getByText('$99.40')).toBeVisible()
    expect(block('Ready to pay').getAllByText('Ada Okafor')).toHaveLength(2)
    expect(block('Ready to pay').getByText('26.00 EUR')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Pay all ready in USD: 3 creators, $135.50' }),
    ).toHaveTextContent('Pay all in USD')

    await user.click(
      screen.getByRole('button', { name: 'Pay all ready in EUR: 3 creators, 127.50 EUR' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Pay all ready' })
    expect(dialog).toHaveTextContent('127.50 EUR to 3 creators')
    expect(dialog).not.toHaveTextContent('$')
    await user.click(within(dialog).getByRole('button', { name: 'Pay 3 creators 127.50 EUR' }))

    await waitFor(() =>
      expect(gateway.performProgramPayout).toHaveBeenCalledWith({
        action: 'pay_ready',
        currency: 'EUR',
        expectedCount: 3,
        expectedTotalMinor: 12750,
      }),
    )
  })

  it('speaks only of live money, shows no email, and has no accessibility violations', async () => {
    const { container } = show(payoutGateway())
    await loaded()

    expect(container.textContent).not.toMatch(/test mode|sandbox|test key|livemode|minor/i)
    expect(container.textContent).not.toMatch(/@|acct_/)
    // Money is in normal units: $44.10, never 4410.
    expect(container.textContent).not.toMatch(/4410|13550/)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })

  it('asks before paying one creator, and cancelling sends nothing', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    const pay = screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' })
    await user.click(pay)

    const dialog = screen.getByRole('dialog', { name: 'Pay Ada Okafor' })
    expect(dialog).toHaveTextContent('$44.10 to Ada Okafor')
    expect(dialog).toHaveTextContent('SpeakSix$30.00')
    expect(dialog).toHaveTextContent('HabitLoop$14.10')
    expect(dialog).toHaveTextContent(/after that it cannot be taken back/i)
    expect(within(dialog).getByRole('button', { name: 'Pay $44.10' })).not.toHaveFocus()
    expect(gateway.performProgramPayout).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(pay).toHaveFocus())
    expect(gateway.performProgramPayout).not.toHaveBeenCalled()
  })

  it('pays one creator the amount on screen and shows the payout on its way', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' }))
    await user.click(screen.getByRole('button', { name: 'Pay $44.10' }))

    await waitFor(() =>
      expect(gateway.performProgramPayout).toHaveBeenCalledWith({
        action: 'pay',
        affiliateId: ada.affiliateId,
        currency: 'USD',
        expectedAmountMinor: 4410,
      }),
    )
    expect(gateway.performProgramPayout).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByText('$44.10 to Ada Okafor is on its way.')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(block('Ready to pay').queryByText('Ada Okafor')).not.toBeInTheDocument()
    expect(row('On its way', 'Ada Okafor').getByText('$44.10')).toBeVisible()
    expect(total('Ready to pay').getByText('$91.40')).toBeVisible()
    // The answer to the change is the list: it is not read a second time.
    expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(1)
  })

  it('shows paying as busy and cannot be sent twice or closed meanwhile', async () => {
    const user = userEvent.setup()
    let answer: (result: PayoutsResult) => void = () => {}
    const gateway = payoutGateway(payoutsFixture(), {
      performProgramPayout: vi.fn(
        () => new Promise<PayoutsResult>((resolve) => (answer = resolve)),
      ),
    })
    show(gateway)
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Mateo Rossi $63.20' }))
    await user.click(screen.getByRole('button', { name: 'Pay $63.20' }))

    const busy = await screen.findByRole('button', { name: 'Paying…' })
    expect(busy).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Pay Mateo Rossi' })).toBeVisible()
    expect(gateway.performProgramPayout).toHaveBeenCalledTimes(1)

    answer(ready(afterPaying(payoutsFixture(), [mateo.affiliateId])))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('$63.20 to Mateo Rossi is on its way.')).toBeInTheDocument()
  })

  it('asks before paying everyone who is ready, stating the count and the total', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    await user.click(screen.getByRole('button', { name: /^Pay all ready/ }))

    const dialog = screen.getByRole('dialog', { name: 'Pay all ready' })
    expect(dialog).toHaveTextContent('$135.50 to 3 creators')
    expect(dialog).toHaveTextContent('Ada Okafor$44.10')
    expect(dialog).toHaveTextContent('Mateo Rossi$63.20')
    expect(dialog).toHaveTextContent('Priya Nair$28.20')
    expect(dialog).not.toHaveTextContent('Ben Carter')
    expect(gateway.performProgramPayout).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Pay 3 creators $135.50' }))

    await waitFor(() =>
      expect(gateway.performProgramPayout).toHaveBeenCalledWith({
        action: 'pay_ready',
        currency: 'USD',
        expectedCount: 3,
        expectedTotalMinor: 13550,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText('$135.50 to 3 creators is on its way.')).toBeInTheDocument(),
    )
    expect(block('Ready to pay').getByText('No one is ready to be paid.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Pay all ready/ })).not.toBeInTheDocument()
    expect(row('On its way', 'Priya Nair').getByText('$28.20')).toBeVisible()
  })

  it('lists the first creators and counts the rest when many are ready', async () => {
    const user = userEvent.setup()
    const many = payoutsFixture({
      creators: Array.from({ length: 9 }, (_, index) => ({
        ...mateo,
        affiliateId: `c0de0000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        name: `Creator ${index + 1}`,
        payableMinor: 3000,
      })),
    })
    show(payoutGateway(many))
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay all ready: 9 creators, $270.00' }))

    const dialog = screen.getByRole('dialog', { name: 'Pay all ready' })
    expect(within(dialog).getByText('Creator 6')).toBeVisible()
    expect(within(dialog).queryByText('Creator 7')).not.toBeInTheDocument()
    expect(within(dialog).getByText('and 3 more')).toBeVisible()
  })

  it('offers no "pay all" for a single creator', async () => {
    show(payoutGateway(payoutsFixture({ creators: [ada, fixtureCreators[3]] })))
    await loaded()

    expect(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^Pay all/ })).not.toBeInTheDocument()
  })

  it('reloads and says the amounts changed when the database refuses a payment', async () => {
    const user = userEvent.setup()
    const theirs = payoutsFixture({
      creators: fixtureCreators.map((creator) =>
        creator === ada ? { ...creator, payableMinor: 5610 } : creator,
      ),
    })
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(ready(payoutsFixture()))
      .mockResolvedValue(ready(theirs))
    const gateway = payoutGateway(payoutsFixture(), {
      getProgramPayouts,
      performProgramPayout: vi.fn(async () => failed('conflict', PAYOUT_AMOUNT_CHANGED)),
    })
    show(gateway)
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' }))
    await user.click(screen.getByRole('button', { name: 'Pay $44.10' }))

    await waitFor(() => expect(screen.getByText(PAYOUT_AMOUNT_CHANGED)).toBeInTheDocument())
    expect(screen.getByText(PAYOUT_AMOUNT_CHANGED).closest('[role="alert"]')).not.toBeNull()
    expect(PAYOUT_AMOUNT_CHANGED).toMatch(/nothing was sent/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Pay Ada Okafor $56.10' })).toBeEnabled()
    expect(total('Ready to pay').getByText('$147.50')).toBeVisible()
  })

  it('reloads and says why when a creator can no longer be paid', async () => {
    const user = userEvent.setup()
    const message =
      'This creator cannot be paid right now, so nothing was sent: payout account needs attention.'
    const theirs = payoutsFixture({
      creators: fixtureCreators.map((creator) =>
        creator === priya ? { ...creator, blocker: 'account_not_ready' as const } : creator,
      ),
    })
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(ready(payoutsFixture()))
      .mockResolvedValue(ready(theirs))
    show(
      payoutGateway(payoutsFixture(), {
        getProgramPayouts,
        performProgramPayout: vi.fn(async () => failed('invalid_state', message)),
      }),
    )
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Priya Nair $28.20' }))
    await user.click(screen.getByRole('button', { name: 'Pay $28.20' }))

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(
        row('Waiting', 'Priya Nair').getByText('Payout account needs attention'),
      ).toBeVisible(),
    )
  })

  it('says a recent sign-in is needed when paying is not authorized', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway(payoutsFixture(), {
      performProgramPayout: vi.fn(async () => signedOut),
    })
    show(gateway, 'finance')
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' }))
    await user.click(screen.getByRole('button', { name: 'Pay $44.10' }))

    await waitFor(() =>
      expect(
        screen.getByText(
          'Paying was not authorized, so nothing was sent. Sign in again as an Owner or Finance admin and retry.',
        ),
      ).toBeInTheDocument(),
    )
    // Nothing changed, so the list is not read again and the creator can be paid after signing in.
    expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' })).toBeEnabled()
  })

  it.each([
    ['fails', vi.fn(async () => failed('temporarily_unavailable'))],
    [
      'throws',
      vi.fn(async (): Promise<PayoutsResult> => {
        throw new Error('network')
      }),
    ],
    ['answers something unreadable', vi.fn(async () => failed('invalid_response'))],
  ])('reads the list again when paying %s, since it may have gone through', async (_name, pay) => {
    const user = userEvent.setup()
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(ready(payoutsFixture()))
      .mockResolvedValue(ready(afterPaying(payoutsFixture(), [ada.affiliateId])))
    show(payoutGateway(payoutsFixture(), { getProgramPayouts, performProgramPayout: pay }))
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' }))
    await user.click(screen.getByRole('button', { name: 'Pay $44.10' }))

    await waitFor(() =>
      expect(
        screen.getByText(
          'Paying could not be confirmed. The list was reloaded: check On its way before paying again.',
        ),
      ).toBeInTheDocument(),
    )
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(row('On its way', 'Ada Okafor').getByText('$44.10')).toBeVisible())
    expect(screen.queryByRole('button', { name: /^Pay Ada Okafor/ })).not.toBeInTheDocument()
  })

  it('asks before canceling a payout that has not started, then gives the money back', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    await user.click(
      screen.getByRole('button', { name: 'Cancel payout to Noah Lindqvist, $47.25' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Cancel this payout' })
    expect(dialog).toHaveTextContent('$47.25 to Noah Lindqvist')
    expect(dialog).toHaveTextContent(/goes back to what the creator is owed/i)

    await user.click(within(dialog).getByRole('button', { name: 'Keep payout' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(gateway.performProgramPayout).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Cancel payout to Noah Lindqvist, $47.25' }),
    )
    await user.click(screen.getByRole('button', { name: 'Cancel payout' }))

    await waitFor(() =>
      expect(gateway.performProgramPayout).toHaveBeenCalledWith({
        action: 'cancel',
        payoutId: noah.id,
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByText(
          'Payout to Noah Lindqvist canceled. $47.25 is back in what they are owed.',
        ),
      ).toBeInTheDocument(),
    )
    expect(block('On its way').queryByText('Noah Lindqvist')).not.toBeInTheDocument()
  })

  it('reloads and says a payout already started when it cannot be canceled', async () => {
    const user = userEvent.setup()
    const theirs = payoutsFixture({
      open: fixtureOpen.map((payout) =>
        payout === noah
          ? { ...payout, status: 'processing' as const, attempts: 1, canCancel: false }
          : payout,
      ),
    })
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(ready(payoutsFixture()))
      .mockResolvedValue(ready(theirs))
    show(
      payoutGateway(payoutsFixture(), {
        getProgramPayouts,
        performProgramPayout: vi.fn(async () => failed('invalid_state', PAYOUT_NOT_CANCELABLE)),
      }),
    )
    await loaded()

    await user.click(
      screen.getByRole('button', { name: 'Cancel payout to Noah Lindqvist, $47.25' }),
    )
    await user.click(screen.getByRole('button', { name: 'Cancel payout' }))

    await waitFor(() => expect(screen.getByText(PAYOUT_NOT_CANCELABLE)).toBeInTheDocument())
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(row('On its way', 'Noah Lindqvist').getByText(/^Sending/)).toBeVisible(),
    )
    expect(screen.queryByRole('button', { name: /^Cancel payout to/ })).not.toBeInTheDocument()
  })

  it('saves the smallest payout against the version it read', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    await retype(user, minInput(), '40')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(gateway.configureProgramPayouts).toHaveBeenCalledWith({
        enabled: true,
        minPayoutMinor: 4000,
        expectedUpdatedAt: PAYOUTS_READ_AT,
      }),
    )
    await waitFor(() => expect(screen.getByText('Smallest payout saved.')).toBeInTheDocument())
    expect(minInput()).toHaveValue('40.00')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    // The next change names the version the last one answered.
    await retype(user, minInput(), '45')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(gateway.configureProgramPayouts).toHaveBeenCalledTimes(2))
    expect(gateway.configureProgramPayouts).toHaveBeenLastCalledWith({
      enabled: true,
      minPayoutMinor: 4500,
      expectedUpdatedAt: SAVED_AT,
    })
  })

  it.each(['0.50', '', 'ten', '1000000.01'])(
    'does not save the smallest payout "%s"',
    async (typed) => {
      const user = userEvent.setup()
      const gateway = payoutGateway()
      show(gateway)
      await loaded()

      await retype(user, minInput(), typed)
      await user.click(screen.getByRole('button', { name: 'Save' }))

      const message = 'Enter an amount from 1.00 to 1,000,000.00, for example 25.'
      expect(await screen.findByText(message)).toBeVisible()
      expect(minInput()).toHaveAttribute('aria-invalid', 'true')
      expect(minInput()).toHaveAccessibleDescription(message)
      await waitFor(() => expect(minInput()).toHaveFocus())
      expect(gateway.configureProgramPayouts).not.toHaveBeenCalled()

      await retype(user, minInput(), '25')
      expect(screen.queryByText(message)).not.toBeInTheDocument()
    },
  )

  it('shows the latest settings when they changed in another session', async () => {
    const user = userEvent.setup()
    const theirs = payoutsFixture({ minPayoutMinor: 10000, updatedAt: SAVED_AT })
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(ready(payoutsFixture()))
      .mockResolvedValue(ready(theirs))
    show(
      payoutGateway(payoutsFixture(), {
        getProgramPayouts,
        configureProgramPayouts: vi.fn(async () => failed('conflict', PAYOUT_SETTINGS_CHANGED)),
      }),
    )
    await loaded()

    await retype(user, minInput(), '40')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText(PAYOUT_SETTINGS_CHANGED)).toBeInTheDocument())
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(minInput()).toHaveValue('100.00'))
  })

  it.each([
    [
      'a refused number',
      failed('invalid_input', 'The smallest payout must be between 1.00 and 1,000,000.00.'),
      'The smallest payout must be between 1.00 and 1,000,000.00.',
    ],
    [
      'an ended session',
      signedOut,
      'This change was not authorized. Sign in again as the Owner and retry.',
    ],
  ])('says so after %s and keeps what was typed', async (_name, result, message) => {
    const user = userEvent.setup()
    const gateway = payoutGateway(payoutsFixture(), {
      configureProgramPayouts: vi.fn(async () => result),
    })
    show(gateway)
    await loaded()

    await retype(user, minInput(), '40')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
    expect(minInput()).toHaveValue('40')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(1)
  })

  it('says so when a settings change throws', async () => {
    const user = userEvent.setup()
    show(
      payoutGateway(payoutsFixture(), {
        configureProgramPayouts: vi.fn(async () => {
          throw new Error('network')
        }),
      }),
    )
    await loaded()

    await user.click(screen.getByRole('button', { name: 'Switch off payouts' }))
    await user.click(screen.getByRole('button', { name: 'Switch off' }))

    await waitFor(() =>
      expect(
        screen.getByText('That change did not go through. Nothing was saved. Try again.'),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks before switching payouts off, and keeps the smallest payout', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway()
    show(gateway)
    await loaded()

    // A number typed and not saved is not part of switching off.
    await retype(user, minInput(), '90')
    await user.click(screen.getByRole('button', { name: 'Switch off payouts' }))
    const dialog = screen.getByRole('dialog', { name: 'Switch off payouts' })
    expect(dialog).toHaveTextContent(/no one can be paid while this is off/i)
    expect(dialog).toHaveTextContent(/what creators are owed is kept/i)
    expect(gateway.configureProgramPayouts).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }))

    await waitFor(() =>
      expect(gateway.configureProgramPayouts).toHaveBeenCalledWith({
        enabled: false,
        minPayoutMinor: 2500,
        expectedUpdatedAt: PAYOUTS_READ_AT,
      }),
    )
    await waitFor(() => expect(screen.getByText('Payouts switched off.')).toBeInTheDocument())
    expect(within(panel()).getByText('Off')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Switch on payouts' })).toBeEnabled()
  })

  const switchedOff = () =>
    payoutsFixture({
      enabled: false,
      open: [],
      creators: fixtureCreators.map((creator) => ({ ...creator, blocker: 'payouts_off' as const })),
    })

  it('shows the Owner the switch while payouts are off, and no way to pay', async () => {
    const user = userEvent.setup()
    const gateway = payoutGateway(switchedOff())
    show(gateway)
    await loaded()

    expect(within(panel()).getByText('Off')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent(
      'Payouts are off. No one can be paid until you switch them on.',
    )
    expect(block('Ready to pay').getByText('No one is ready to be paid.')).toBeVisible()
    expect(row('Waiting', 'Ada Okafor').getByText('Payouts are switched off')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch off payouts' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Switch on payouts' }))
    const dialog = screen.getByRole('dialog', { name: 'Switch on payouts' })
    expect(dialog).toHaveTextContent(/nothing is paid by itself/i)
    expect(dialog).toHaveTextContent('The smallest payout is 25.00')
    await user.click(within(dialog).getByRole('button', { name: 'Switch on' }))

    await waitFor(() =>
      expect(gateway.configureProgramPayouts).toHaveBeenCalledWith({
        enabled: true,
        minPayoutMinor: 2500,
        expectedUpdatedAt: PAYOUTS_READ_AT,
      }),
    )
    await waitFor(() => expect(screen.getByText('Payouts switched on.')).toBeInTheDocument())
    expect(within(panel()).getByText('On')).toBeVisible()
  })

  it.each([
    ['program money is off', { moneyEnabled: false }, PAYOUT_MONEY_OFF],
    ['no program has a balance yet', { platform: null }, PAYOUT_NO_PLATFORM],
  ])('does not offer to switch on while %s, and says why', async (_name, change, reason) => {
    show(payoutGateway({ ...switchedOff(), ...change }))
    await loaded()

    expect(screen.getByRole('note')).toHaveTextContent(reason)
    expect(screen.getByRole('button', { name: 'Switch on payouts' })).toBeDisabled()
  })

  it('tells another role that only the Owner can switch payouts on', async () => {
    show(payoutGateway(switchedOff()), 'finance')
    await loaded()

    expect(screen.getByRole('note')).toHaveTextContent(
      'Payouts are off. Only the Owner can switch them on.',
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says no one can be paid while the platform is not enabled for payouts', async () => {
    show(
      payoutGateway(
        payoutsFixture({
          platform: { accountId: 'acct_1QK7dLConsole01', registered: true, enabled: false },
          creators: fixtureCreators.map((creator) => ({
            ...creator,
            blocker: 'platform_not_ready' as const,
          })),
        }),
      ),
    )
    await loaded()

    expect(screen.getByRole('note')).toHaveTextContent(/no one can be paid yet/i)
    expect(
      row('Waiting', 'Ada Okafor').getByText('Platform is not set up for payouts'),
    ).toBeVisible()
  })

  it('lets Finance pay and cancel but not change the settings', async () => {
    show(payoutGateway(), 'finance')
    await loaded()

    expect(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Pay all ready/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Cancel payout to Noah/ })).toBeEnabled()
    expect(screen.queryByLabelText('Smallest payout')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch off payouts' })).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Smallest payout: 25.00 in the program’s currency. Only the Owner can change payout settings.',
      ),
    ).toBeVisible()
  })

  it.each(['operations', 'analyst'] as const)(
    'shows %s everything and no actions',
    async (role) => {
      const gateway = payoutGateway()
      show(gateway, role)
      await loaded()

      expect(row('Ready to pay', 'Ada Okafor').getByText('$44.10')).toBeVisible()
      expect(row('On its way', 'Noah Lindqvist').getByText('$47.25')).toBeVisible()
      expect(row('Recent', 'Mateo Rossi').getByText('$96.50')).toBeVisible()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(
        screen.getByText(
          'Smallest payout: 25.00 in the program’s currency. Only an Owner or Finance admin can pay.',
        ),
      ).toBeVisible()
      expect(gateway.performProgramPayout).not.toHaveBeenCalled()
    },
  )

  it('says there is nothing to pay yet and keeps the totals and the settings', async () => {
    show(payoutGateway(emptyPayoutsFixture()))
    await loaded()

    expect(
      screen.getByText(
        'Nothing to pay yet. Creators appear here once a program approves their commission.',
      ),
    ).toBeVisible()
    expect(total('Ready to pay').getByText('None')).toBeVisible()
    expect(total('Waiting').getByText('None')).toBeVisible()
    expect(total('Paid').getByText('None')).toBeVisible()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument()
    expect(minInput()).toHaveValue('25.00')
  })

  it('shows only the lists that have something in them', async () => {
    show(payoutGateway(payoutsFixture({ creators: [], open: [] })))
    await loaded()

    expect(block('Ready to pay').getByText('No one is ready to be paid.')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Waiting' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'On its way' })).not.toBeInTheDocument()
    expect(row('Recent', 'Ada Okafor').getByText('$210.00')).toBeVisible()
  })

  it('names a creator without a name', async () => {
    show(payoutGateway(payoutsFixture({ creators: [{ ...ada, name: '' }], open: [], recent: [] })))
    await loaded()

    expect(screen.getByRole('button', { name: 'Pay Unnamed creator $44.10' })).toBeEnabled()
  })

  it.each([
    ['the functions are not deployed', failed('contract_unavailable')],
    [
      'the connection is not set up',
      { data: null, status: 'unconfigured', error: null } as PayoutsResult,
    ],
  ])('says payouts are not available when %s', async (_name, result) => {
    show(payoutGateway(payoutsFixture(), { getProgramPayouts: vi.fn(async () => result) }))

    expect(
      await screen.findByText('Program payouts are not available in this deployment.'),
    ).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('tells a role that may not see payouts to ask the Owner', async () => {
    show(
      payoutGateway(payoutsFixture(), { getProgramPayouts: vi.fn(async () => signedOut) }),
      'operations',
    )

    expect(
      await screen.findByText('Your admin role cannot see program payouts. Ask the Owner.'),
    ).toBeVisible()
    expect(screen.queryByLabelText('Program payout totals')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers to try again when the read fails, and recovers', async () => {
    const user = userEvent.setup()
    const getProgramPayouts = vi
      .fn<() => Promise<PayoutsResult>>()
      .mockResolvedValueOnce(failed('temporarily_unavailable'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ready(payoutsFixture()))
    show(payoutGateway(payoutsFixture(), { getProgramPayouts }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Program payouts did not load. Nothing was paid or changed.',
    )
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    // The second read throws: the same message, and another try.
    await waitFor(() => expect(getProgramPayouts).toHaveBeenCalledTimes(2))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))

    await loaded()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getProgramPayouts).toHaveBeenCalledTimes(3)
  })

  it('renders nothing for a gateway that has no program payouts', () => {
    const { container } = show({
      getAdminContext: vi.fn(),
      getProducts: vi.fn(),
      createProduct: vi.fn(),
    })

    expect(container).toBeEmptyDOMElement()
  })

  it('reads again when the page is refreshed, keeping what is on screen meanwhile', async () => {
    const gateway = payoutGateway()
    const { rerender } = show(gateway)
    await loaded()
    expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(1)

    rerender(<ProgramPayoutsPanel gateway={gateway} role="owner" reloadKey={1} />)

    expect(screen.getByLabelText('Program payout totals')).toBeVisible()
    await waitFor(() => expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(2))
  })
})

describe('Program payouts on the admin Payouts page', () => {
  function pageGateway(methods: Partial<PayoutMethods> = payoutGateway()) {
    return {
      ...methods,
      getPayoutWorkspace: vi.fn(async () => ({
        status: 'ready' as const,
        data: workspaceFixture(),
        error: null,
      })),
    } as unknown as AdminGateway
  }

  it('sits above the legacy settlements', async () => {
    render(
      <div className="admin-portal">
        <PayoutsPage role="owner" gateway={pageGateway()} />
      </div>,
    )

    const heading = await screen.findByRole('heading', { level: 2, name: 'Program payouts' })
    await loaded()
    const legacy = screen.getByText(/legacy subscription statements/i)
    expect(heading.compareDocumentPosition(legacy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pay Ada Okafor $44.10' })).toBeEnabled()
  })

  it('reads again when the page is refreshed', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    render(<PayoutsPage role="finance" gateway={gateway} />)
    await loaded()
    await screen.findByText('Example partner')

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(gateway.getProgramPayouts).toHaveBeenCalledTimes(2))
  })

  it('leaves the page as it was for a gateway without program payouts', async () => {
    render(<PayoutsPage role="owner" gateway={pageGateway({})} />)

    expect(await screen.findByText('Example partner')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Program payouts' })).not.toBeInTheDocument()
  })

  it('shows Support neither the page nor the panel', () => {
    const gateway = pageGateway()
    render(<PayoutsPage role="support" gateway={gateway} />)

    expect(screen.getByRole('heading', { name: 'Payout access restricted' })).toBeVisible()
    expect(gateway.getProgramPayouts).not.toHaveBeenCalled()
  })
})
