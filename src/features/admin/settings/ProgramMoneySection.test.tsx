import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type { AdminContext, AdminDataResult, AdminGateway, AdminPlatformSettings } from '../api'
import { PROGRAM_MONEY_CHANGED } from '../api/programMoney'
import type { AdminProgramMoney, AdminProgramMoneyUpdate } from '../api/programMoney'
import { PlatformSettingsPage } from './PlatformSettingsPage'
import { ProgramMoneySection } from './ProgramMoneySection'

type MoneyResult = AdminDataResult<AdminProgramMoney | null>

const owner: AdminContext = {
  userId: 'admin-owner',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}
const operations: AdminContext = { ...owner, userId: 'admin-ops', role: 'operations' }

const READ_AT = '2026-11-13T13:52:14.059098+00:00'
const SAVED_AT = '2026-11-13T14:05:00.000000+00:00'

const moneyOff: AdminProgramMoney = {
  enabled: false,
  feeBps: 1000,
  minDepositMinor: 5000,
  updatedAt: READ_AT,
  totals: {
    programsWithBalance: 3,
    availableMinorByCurrency: { USD: 823600, EUR: 41000 },
    reservedMinorByCurrency: { USD: 12100 },
    owedToCreatorsMinorByCurrency: {},
  },
}
const moneyOn: AdminProgramMoney = { ...moneyOff, enabled: true }

const ready = (data: AdminProgramMoney): MoneyResult => ({ data, status: 'ready', error: null })

function failed(code: NonNullable<MoneyResult['error']>['code'], message = 'No.'): MoneyResult {
  return { data: null, status: 'error', error: { code, message, retryable: false } }
}

/** A gateway that answers a change with what was asked for, the way the backend does. */
function moneyGateway(
  money: AdminProgramMoney = moneyOff,
  overrides: Partial<Pick<AdminGateway, 'getProgramMoney' | 'configureProgramMoney'>> = {},
) {
  const getProgramMoney = vi.fn(async (): Promise<MoneyResult> => ready(money))
  const configureProgramMoney = vi.fn(
    async (input: AdminProgramMoneyUpdate): Promise<MoneyResult> =>
      ready({
        ...money,
        enabled: input.enabled,
        feeBps: input.feeBps,
        minDepositMinor: input.minDepositMinor,
        updatedAt: SAVED_AT,
      }),
  )
  const gateway = {
    getAdminContext: vi.fn(),
    getProducts: vi.fn(),
    createProduct: vi.fn(),
    getProgramMoney,
    configureProgramMoney,
    ...overrides,
  } satisfies AdminGateway
  return gateway
}

function show(
  gateway: AdminGateway,
  options: { context?: AdminContext; settingsUpdatedAt?: string | null } = {},
) {
  const onChanged = vi.fn()
  const props = {
    gateway,
    context: options.context ?? owner,
    settingsUpdatedAt:
      options.settingsUpdatedAt === undefined ? READ_AT : options.settingsUpdatedAt,
    onChanged,
  }
  const view = render(<ProgramMoneySection {...props} reloadKey={0} />)
  return { ...view, onChanged, props }
}

const section = () => screen.getByRole('region', { name: 'Program money' })
const feeInput = () => screen.getByLabelText('KissMyApps fee (%)')
const depositInput = () => screen.getByLabelText('Minimum first deposit')

async function retype(user: ReturnType<typeof userEvent.setup>, input: HTMLElement, text: string) {
  await user.clear(input)
  if (text) await user.type(input, text)
}

describe('Program money on the admin Settings page', () => {
  it('says it is loading until the answer arrives', async () => {
    let answer: (result: MoneyResult) => void = () => {}
    const gateway = moneyGateway(moneyOff, {
      getProgramMoney: vi.fn(() => new Promise<MoneyResult>((resolve) => (answer = resolve))),
    })
    show(gateway)

    expect(screen.getByRole('status')).toHaveTextContent('Loading program money')
    expect(section()).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByLabelText('KissMyApps fee (%)')).not.toBeInTheDocument()

    answer(ready(moneyOff))
    expect(await screen.findByLabelText('KissMyApps fee (%)')).toHaveValue('10')
    expect(section()).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('Loading program money')).not.toBeInTheDocument()
  })

  it('shows the Owner the switch off, the warning, the two numbers and the totals', async () => {
    const gateway = moneyGateway()
    show(gateway)

    expect(await screen.findByLabelText('KissMyApps fee (%)')).toHaveValue('10')
    expect(depositInput()).toHaveValue('50.00')
    expect(screen.getByRole('heading', { level: 2, name: 'Program money' })).toBeVisible()
    expect(within(section()).getByText('Off')).toBeVisible()
    expect(
      screen.getByText(
        /switching this on makes every program need a funded balance to be published and to stay live/i,
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Switch on program money' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save fee and deposit' })).toBeDisabled()
    expect(gateway.getProgramMoney).toHaveBeenCalledTimes(1)

    const totals = screen.getByLabelText('Program money totals')
    const total = (label: string) =>
      within(within(totals).getByText(label).closest('div') as HTMLElement)
    expect(total('Programs with a balance').getByText('3')).toBeVisible()
    expect(total('Available in balances').getByText('$8,236.00')).toBeVisible()
    expect(total('Available in balances').getByText('410.00 EUR')).toBeVisible()
    expect(total('Reserved').getByText('$121.00')).toBeVisible()
    expect(total('Owed to creators').getByText('None')).toBeVisible()
  })

  it('shows the switch on and what that means', async () => {
    show(moneyGateway(moneyOn))

    expect(await screen.findByRole('button', { name: 'Switch off program money' })).toBeEnabled()
    expect(within(section()).getByText('On')).toBeVisible()
    expect(
      screen.getByText(/while this is on, a program needs a funded balance to be published/i),
    ).toBeVisible()
    expect(screen.queryByText(/switching this on makes every program/i)).not.toBeInTheDocument()
  })

  it('speaks only of live money and has no accessibility violations', async () => {
    const { container } = show(moneyGateway())
    await screen.findByLabelText('KissMyApps fee (%)')

    expect(container.textContent).not.toMatch(/test mode|sandbox|test key|livemode/i)
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations).toEqual([])
  })

  it('saves the fee and the deposit against the version it read', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    const { onChanged } = show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '12.5')
    await retype(user, depositInput(), '100')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() =>
      expect(gateway.configureProgramMoney).toHaveBeenCalledWith({
        enabled: false,
        feeBps: 1250,
        minDepositMinor: 10000,
        expectedUpdatedAt: READ_AT,
      }),
    )
    expect(gateway.configureProgramMoney).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByText('Fee and minimum deposit saved.')).toBeInTheDocument(),
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(feeInput()).toHaveValue('12.5')
    expect(depositInput()).toHaveValue('100.00')
    expect(screen.getByRole('button', { name: 'Save fee and deposit' })).toBeDisabled()
  })

  it('names the next change after the version the last one answered', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '5')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))
    await waitFor(() => expect(gateway.configureProgramMoney).toHaveBeenCalledTimes(1))
    await retype(user, feeInput(), '6')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() => expect(gateway.configureProgramMoney).toHaveBeenCalledTimes(2))
    expect(gateway.configureProgramMoney).toHaveBeenLastCalledWith({
      enabled: false,
      feeBps: 600,
      minDepositMinor: 5000,
      expectedUpdatedAt: SAVED_AT,
    })
  })

  it('uses the version the page read when the answer carries none', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway({ ...moneyOff, updatedAt: null })
    show(gateway, { settingsUpdatedAt: '2026-09-01T10:00:00.000Z' })

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '0')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() =>
      expect(gateway.configureProgramMoney).toHaveBeenCalledWith({
        enabled: false,
        feeBps: 0,
        minDepositMinor: 5000,
        expectedUpdatedAt: '2026-09-01T10:00:00.000Z',
      }),
    )
  })

  it.each([
    ['60', 'Enter a fee from 0 to 50, for example 10.'],
    ['', 'Enter a fee from 0 to 50, for example 10.'],
    ['ten', 'Enter a fee from 0 to 50, for example 10.'],
  ])('does not save the fee "%s"', async (typed, message) => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), typed)
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    expect(await screen.findByText(message)).toBeVisible()
    expect(feeInput()).toHaveAttribute('aria-invalid', 'true')
    expect(feeInput()).toHaveAccessibleDescription(message)
    await waitFor(() => expect(feeInput()).toHaveFocus())
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()

    await retype(user, feeInput(), '10')
    expect(screen.queryByText(message)).not.toBeInTheDocument()
  })

  it('does not save a deposit outside 1.00 to 1,000,000.00', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    show(gateway)

    await retype(user, await screen.findByLabelText('Minimum first deposit'), '0.50')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    const message = 'Enter an amount from 1.00 to 1,000,000.00, for example 50.'
    expect(await screen.findByText(message)).toBeVisible()
    expect(depositInput()).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(depositInput()).toHaveFocus())
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()
  })

  it('asks before switching on, and cancelling changes nothing', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    const { onChanged } = show(gateway)

    const switchOn = await screen.findByRole('button', { name: 'Switch on program money' })
    await user.click(switchOn)

    const dialog = screen.getByRole('dialog', { name: 'Switch on program money' })
    expect(dialog).toHaveTextContent(
      /a program needs a funded balance to be published and to stay live/i,
    )
    expect(dialog).toHaveTextContent('KissMyApps fee of 10%')
    expect(dialog).toHaveTextContent('The minimum first deposit will be 50.00')
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(switchOn).toHaveFocus())
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('switches on with the numbers on screen', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    const { onChanged } = show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '15')
    await retype(user, depositInput(), '1,250.50')
    await user.click(screen.getByRole('button', { name: 'Switch on program money' }))
    const dialog = screen.getByRole('dialog', { name: 'Switch on program money' })
    expect(dialog).toHaveTextContent('KissMyApps fee of 15%')
    expect(dialog).toHaveTextContent('The minimum first deposit will be 1,250.50')
    await user.click(within(dialog).getByRole('button', { name: 'Switch on' }))

    await waitFor(() =>
      expect(gateway.configureProgramMoney).toHaveBeenCalledWith({
        enabled: true,
        feeBps: 1500,
        minDepositMinor: 125050,
        expectedUpdatedAt: READ_AT,
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByText(
          'Program money is on. Programs now need a funded balance to publish and stay live.',
        ),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(section()).getByText('On')).toBeVisible()
    const switchOff = screen.getByRole('button', { name: 'Switch off program money' })
    await waitFor(() => expect(switchOff).toHaveFocus())
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('does not offer to switch on while a number is wrong', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway()
    show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '75')
    await user.click(screen.getByRole('button', { name: 'Switch on program money' }))

    expect(await screen.findByText('Enter a fee from 0 to 50, for example 10.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()
  })

  it('asks before switching off and keeps the saved numbers', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway(moneyOn)
    show(gateway)

    // A number typed and not saved is not part of switching off.
    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '20')
    await user.click(screen.getByRole('button', { name: 'Switch off program money' }))
    const dialog = screen.getByRole('dialog', { name: 'Switch off program money' })
    expect(dialog).toHaveTextContent(/sales earn no program commission/i)
    expect(dialog).toHaveTextContent(/balances and commission already recorded are kept/i)
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }))

    await waitFor(() =>
      expect(gateway.configureProgramMoney).toHaveBeenCalledWith({
        enabled: false,
        feeBps: 1000,
        minDepositMinor: 5000,
        expectedUpdatedAt: READ_AT,
      }),
    )
    await waitFor(() => expect(screen.getByText('Program money is off.')).toBeInTheDocument())
    expect(within(section()).getByText('Off')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Switch on program money' })).toBeVisible()
  })

  it('keeps the totals when a change answers without them', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway(moneyOff, {
      configureProgramMoney: vi.fn(async (input: AdminProgramMoneyUpdate) =>
        ready({ ...input, updatedAt: SAVED_AT, totals: null }),
      ),
    })
    show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '8')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() =>
      expect(screen.getByText('Fee and minimum deposit saved.')).toBeInTheDocument(),
    )
    expect(
      within(screen.getByLabelText('Program money totals')).getByText('$8,236.00'),
    ).toBeVisible()
  })

  it('shows the latest settings when they changed in another session', async () => {
    const user = userEvent.setup()
    const theirs: AdminProgramMoney = { ...moneyOn, feeBps: 2000, updatedAt: SAVED_AT }
    const getProgramMoney = vi
      .fn<() => Promise<MoneyResult>>()
      .mockResolvedValueOnce(ready(moneyOff))
      .mockResolvedValue(ready(theirs))
    const gateway = moneyGateway(moneyOff, {
      getProgramMoney,
      configureProgramMoney: vi.fn(async () => failed('conflict', PROGRAM_MONEY_CHANGED)),
    })
    const { onChanged } = show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '12')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() => expect(screen.getByText(PROGRAM_MONEY_CHANGED)).toBeInTheDocument())
    expect(screen.getByText(PROGRAM_MONEY_CHANGED).closest('[role="alert"]')).not.toBeNull()
    await waitFor(() => expect(getProgramMoney).toHaveBeenCalledTimes(2))
    expect(onChanged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(feeInput()).toHaveValue('20'))
    expect(within(section()).getByText('On')).toBeVisible()
  })

  it.each([
    [
      'a refused number',
      failed('invalid_input', 'The fee must be between 0% and 50%.'),
      'The fee must be between 0% and 50%.',
    ],
    [
      'a failing service',
      failed('temporarily_unavailable'),
      'That change did not go through. Nothing was saved. Try again.',
    ],
    [
      'an ended session',
      {
        data: null,
        status: 'unauthorized',
        error: { code: 'not_authenticated', message: 'No.', retryable: false },
      } as MoneyResult,
      'This change was not authorized. Sign in again as the Owner and retry.',
    ],
  ])('says so after %s and keeps what was typed', async (_name, result, message) => {
    const user = userEvent.setup()
    const gateway = moneyGateway(moneyOff, { configureProgramMoney: vi.fn(async () => result) })
    const { onChanged } = show(gateway)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '12')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
    expect(feeInput()).toHaveValue('12')
    expect(screen.getByRole('button', { name: 'Save fee and deposit' })).toBeEnabled()
    expect(gateway.getProgramMoney).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('says so when the change throws', async () => {
    const user = userEvent.setup()
    const gateway = moneyGateway(moneyOn, {
      configureProgramMoney: vi.fn(async () => {
        throw new Error('network')
      }),
    })
    show(gateway)

    await user.click(await screen.findByRole('button', { name: 'Switch off program money' }))
    await user.click(screen.getByRole('button', { name: 'Switch off' }))

    await waitFor(() =>
      expect(
        screen.getByText('That change did not go through. Nothing was saved. Try again.'),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(section()).getByText('On')).toBeVisible()
  })

  it('shows another admin role the settings without a way to change them', async () => {
    const gateway = moneyGateway(moneyOn)
    show(gateway, { context: operations })

    expect(await screen.findByText('10% of each commission')).toBeVisible()
    expect(screen.getByText('50.00')).toBeVisible()
    expect(screen.getByText('Only an Owner can change program money.')).toBeVisible()
    expect(screen.getByLabelText('Program money totals')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(gateway.configureProgramMoney).not.toHaveBeenCalled()
  })

  it('tells another role what off means without the Owner’s warning', async () => {
    show(moneyGateway(moneyOff), { context: operations })

    expect(
      await screen.findByText(/while this is off, programs do not need a balance/i),
    ).toBeVisible()
    expect(screen.queryByText(/switching this on makes every program/i)).not.toBeInTheDocument()
  })

  it('tells a role that may not see program money to ask the Owner', async () => {
    const gateway = moneyGateway(moneyOff, {
      getProgramMoney: vi.fn(async (): Promise<MoneyResult> => ({
        data: null,
        status: 'unauthorized',
        error: { code: 'not_authorized', message: 'No.', retryable: false },
      })),
    })
    show(gateway, { context: { ...owner, role: 'support' } })

    expect(
      await screen.findByText('Your admin role cannot see program money. Ask the Owner.'),
    ).toBeVisible()
    expect(screen.queryByLabelText('Program money totals')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['the functions are not deployed', failed('contract_unavailable')],
    [
      'the connection is not set up',
      { data: null, status: 'unconfigured', error: null } as MoneyResult,
    ],
  ])('says program money is not available when %s', async (_name, result) => {
    show(moneyGateway(moneyOff, { getProgramMoney: vi.fn(async () => result) }))

    expect(
      await screen.findByText('Program money is not available in this deployment yet.'),
    ).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers to try again when the read fails, and recovers', async () => {
    const user = userEvent.setup()
    const getProgramMoney = vi
      .fn<() => Promise<MoneyResult>>()
      .mockResolvedValueOnce(failed('temporarily_unavailable'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ready(moneyOff))
    show(moneyGateway(moneyOff, { getProgramMoney }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Program money did not load. The rest of this page is not affected.',
    )
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    // The second read throws: the same message, and another try.
    await waitFor(() => expect(getProgramMoney).toHaveBeenCalledTimes(2))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(await screen.findByLabelText('KissMyApps fee (%)')).toHaveValue('10')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getProgramMoney).toHaveBeenCalledTimes(3)
  })

  it('renders nothing for a gateway that has no program money', () => {
    const { container } = show({
      getAdminContext: vi.fn(),
      getProducts: vi.fn(),
      createProduct: vi.fn(),
    })

    expect(container).toBeEmptyDOMElement()
  })

  it('reads again when the page reloads or its settings change', async () => {
    const gateway = moneyGateway()
    const { rerender, props } = show(gateway)
    await screen.findByLabelText('KissMyApps fee (%)')
    expect(gateway.getProgramMoney).toHaveBeenCalledTimes(1)

    rerender(<ProgramMoneySection {...props} reloadKey={1} />)
    await waitFor(() => expect(gateway.getProgramMoney).toHaveBeenCalledTimes(2))

    rerender(<ProgramMoneySection {...props} reloadKey={1} settingsUpdatedAt={SAVED_AT} />)
    await waitFor(() => expect(gateway.getProgramMoney).toHaveBeenCalledTimes(3))
    expect(feeInput()).toHaveValue('10')
  })
})

describe('Program money inside the Settings page', () => {
  const settings: AdminPlatformSettings = {
    tracking: {
      baseUrl: 'https://go.kissmyapps.dev',
      enabled: true,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    readiness: {
      canEnable: true,
      activeProductCount: 1,
      liveDefaultFunnelCount: 1,
      launchReadyAgreementCount: 1,
      verifiedActiveOfferCount: 1,
      enableReadyProductCount: 1,
      commercialEnableReadyProductCount: 1,
      trackingOnlyReadyProductCount: 0,
    },
    expectedHosts: {
      partner: 'https://partners.kissmyapps.dev',
      admin: 'https://admin.kissmyapps.dev',
      tracking: 'https://go.kissmyapps.dev',
    },
  }

  function pageGateway(money: AdminProgramMoney = moneyOff) {
    return {
      ...moneyGateway(money),
      getPlatformSettings: vi.fn(
        async (): Promise<AdminDataResult<AdminPlatformSettings | null>> => ({
          data: settings,
          status: 'ready',
          error: null,
        }),
      ),
      configureTracking: vi.fn(),
    } satisfies AdminGateway
  }

  it('sits on the page with the tracking settings', async () => {
    const gateway = pageGateway()
    render(<PlatformSettingsPage context={owner} gateway={gateway} />)

    expect(await screen.findByRole('heading', { level: 2, name: 'Program money' })).toBeVisible()
    expect(await screen.findByLabelText('KissMyApps fee (%)')).toHaveValue('10')
    expect(screen.getByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(1)
    expect(gateway.getProgramMoney).toHaveBeenCalledTimes(1)
  })

  it('leaves the page as it was for a gateway without program money', async () => {
    const gateway = pageGateway()
    render(
      <PlatformSettingsPage
        context={owner}
        gateway={{ ...gateway, getProgramMoney: undefined, configureProgramMoney: undefined }}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Program money' })).not.toBeInTheDocument()
  })

  it('has the page read its settings again after a change, since they share a version', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    render(<PlatformSettingsPage context={owner} gateway={gateway} />)

    await retype(user, await screen.findByLabelText('KissMyApps fee (%)'), '12')
    await user.click(screen.getByRole('button', { name: 'Save fee and deposit' }))

    await waitFor(() => expect(gateway.configureProgramMoney).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByText('Fee and minimum deposit saved.')).toBeInTheDocument(),
    )
    expect(screen.getByLabelText('KissMyApps fee (%)')).toHaveValue('12')
  })

  it('reads program money again when the page is refreshed', async () => {
    const user = userEvent.setup()
    const gateway = pageGateway()
    render(<PlatformSettingsPage context={owner} gateway={gateway} />)
    await screen.findByLabelText('KissMyApps fee (%)')

    await user.click(screen.getByRole('button', { name: /refresh settings/i }))

    await waitFor(() => expect(gateway.getProgramMoney).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(gateway.getPlatformSettings).toHaveBeenCalledTimes(2))
  })

  it('keeps the rest of the page when program money does not load', async () => {
    const gateway = {
      ...pageGateway(),
      getProgramMoney: vi.fn(async () => failed('temporarily_unavailable')),
    }
    render(<PlatformSettingsPage context={owner} gateway={gateway} />)

    expect(await screen.findByText(/program money did not load/i)).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Launch readiness' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disable tracking' })).toBeVisible()
  })
})
