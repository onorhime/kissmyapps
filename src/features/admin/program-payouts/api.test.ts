import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from '../api/gateway'
import type { AdminBackendResponse, AdminSupabaseClient } from '../api/types'
import {
  BLOCKER_WORDS,
  PAYOUT_AMOUNT_CHANGED,
  PAYOUT_LIST_CHANGED,
  PAYOUT_MONEY_OFF,
  PAYOUT_NOT_CANCELABLE,
  PAYOUT_NOT_PAYABLE,
  PAYOUT_NO_PLATFORM,
  PAYOUT_REQUEST_REFUSED,
  PAYOUT_SETTINGS_CHANGED,
  creatorName,
  currenciesOf,
  mapAdminProgramPayouts,
  openPayoutWords,
  payoutDate,
  payoutFailureWords,
  payoutMoney,
  programPayoutActionInput,
  programPayoutRefusal,
  programPayoutSettingsInput,
} from './api'
import type { AdminOpenPayout } from './api'

const ADA = 'c0de0000-0000-4000-8000-000000000001'
const SPEAKSIX = 'b1a70000-0000-4000-8000-000000000001'
const PAYOUT = 'fa110000-0000-4000-8000-000000000001'
const READ_AT = '2026-11-13T13:52:14.059098+00:00'

/** What the three functions answer, as the contract writes it. */
const answer = {
  enabled: true,
  money_enabled: true,
  min_payout_minor: 2500,
  updated_at: READ_AT,
  platform: { account_id: 'acct_1QK7dLConsole01', registered: true, enabled: true },
  creators: [
    {
      affiliate_id: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      payable_minor: 4410,
      programs: [{ program_id: SPEAKSIX, name: 'SpeakSix', amount_minor: 4410 }],
      account_status: 'ready',
      account_country: 'US',
      blocker: null,
    },
  ],
  open: [
    {
      id: PAYOUT,
      affiliate_id: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      amount_minor: 4410,
      status: 'approved',
      attempts: 0,
      failure_code: null,
      created_at: '2026-11-13T13:40:00+00:00',
      next_attempt_at: null,
      can_cancel: true,
    },
  ],
  recent: [
    {
      id: 'fa110000-0000-4000-8000-000000000011',
      affiliate_id: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      amount_minor: 4410,
      status: 'paid',
      failure_code: null,
      created_at: '2026-11-06T10:02:00+00:00',
      closed_at: '2026-11-06T10:03:10+00:00',
      transfer_id: 'tr_3QK7dLAdaOkafor01',
    },
  ],
  totals: {
    ready_minor_by_currency: { USD: 4410 },
    ready_count: 1,
    waiting_minor_by_currency: { USD: 900 },
    paid_minor_by_currency: { USD: 0 },
  },
}

const read = {
  enabled: true,
  moneyEnabled: true,
  minPayoutMinor: 2500,
  updatedAt: READ_AT,
  platform: { accountId: 'acct_1QK7dLConsole01', registered: true, enabled: true },
  creators: [
    {
      affiliateId: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      payableMinor: 4410,
      programs: [{ programId: SPEAKSIX, name: 'SpeakSix', amountMinor: 4410 }],
      accountStatus: 'ready',
      accountCountry: 'US',
      blocker: null,
    },
  ],
  open: [
    {
      id: PAYOUT,
      affiliateId: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      amountMinor: 4410,
      status: 'approved',
      attempts: 0,
      failureCode: null,
      createdAt: '2026-11-13T13:40:00+00:00',
      nextAttemptAt: null,
      canCancel: true,
    },
  ],
  recent: [
    {
      id: 'fa110000-0000-4000-8000-000000000011',
      affiliateId: ADA,
      name: 'Ada Okafor',
      currency: 'USD',
      amountMinor: 4410,
      status: 'paid',
      failureCode: null,
      createdAt: '2026-11-06T10:02:00+00:00',
      closedAt: '2026-11-06T10:03:10+00:00',
      transferId: 'tr_3QK7dLAdaOkafor01',
    },
  ],
  totals: {
    readyMinorByCurrency: { USD: 4410 },
    readyCount: 1,
    waitingMinorByCurrency: { USD: 900 },
    paidMinorByCurrency: { USD: 0 },
  },
}

const withCreator = (change: Record<string, unknown>) => ({
  ...answer,
  creators: [{ ...answer.creators[0], ...change }],
})
const withOpen = (change: Record<string, unknown>) => ({
  ...answer,
  open: [{ ...answer.open[0], ...change }],
})
const withRecent = (change: Record<string, unknown>) => ({
  ...answer,
  recent: [{ ...answer.recent[0], ...change }],
})

function rpcClient(
  implementation: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => Promise<AdminBackendResponse>,
) {
  const rpc = vi.fn(implementation)
  return { value: { rpc } satisfies AdminSupabaseClient, rpc }
}

const answering = () => rpcClient(async () => ({ data: answer, error: null, status: 200 }))

function refusing(error: NonNullable<AdminBackendResponse['error']>, status = 400) {
  return rpcClient(async () => ({ data: null, error, status }))
}

const pay = { action: 'pay', affiliateId: ADA, currency: 'USD', expectedAmountMinor: 4410 } as const
const payReady = {
  action: 'pay_ready',
  currency: 'USD',
  expectedCount: 3,
  expectedTotalMinor: 13230,
} as const
const cancel = { action: 'cancel', payoutId: PAYOUT } as const
const settings = { enabled: true, minPayoutMinor: 5000, expectedUpdatedAt: READ_AT }

describe('reading program payouts', () => {
  it('reads the switch, the platform, the three lists and the totals', () => {
    expect(mapAdminProgramPayouts(answer)).toEqual(read)
  })

  it('reads an answer wrapped in a row or under the function name', () => {
    expect(mapAdminProgramPayouts([answer])).toEqual(read)
    expect(mapAdminProgramPayouts({ get_admin_program_payouts: answer })).toEqual(read)
    expect(mapAdminProgramPayouts([{ perform_admin_program_payout: answer }])).toEqual(read)
    expect(mapAdminProgramPayouts({ configure_admin_program_payouts: answer })).toEqual(read)
  })

  it('reads a platform that is not there yet, empty lists and no money in any currency', () => {
    const payouts = mapAdminProgramPayouts({
      enabled: false,
      money_enabled: false,
      min_payout_minor: '2500',
      updated_at: null,
      platform: null,
      creators: [],
      open: null,
      recent: [],
      totals: {
        ready_minor_by_currency: {},
        ready_count: 0,
        waiting_minor_by_currency: null,
        paid_minor_by_currency: { USD: '900000000000' },
      },
    })
    expect(payouts).toEqual({
      enabled: false,
      moneyEnabled: false,
      minPayoutMinor: 2500,
      updatedAt: null,
      platform: null,
      creators: [],
      open: [],
      recent: [],
      totals: {
        readyMinorByCurrency: {},
        readyCount: 0,
        waitingMinorByCurrency: {},
        paidMinorByCurrency: { USD: 900000000000 },
      },
    })
  })

  it('reads every reason a creator is waiting', () => {
    for (const blocker of [
      'payouts_off',
      'platform_not_ready',
      'payout_open',
      'no_account',
      'account_not_ready',
      'below_minimum',
    ]) {
      expect(mapAdminProgramPayouts(withCreator({ blocker })).creators[0].blocker).toBe(blocker)
    }
  })

  it('never reads a reason it does not know as "can be paid"', () => {
    const payouts = mapAdminProgramPayouts(withCreator({ blocker: 'under_review' }))
    expect(payouts.creators[0].blocker).toBe('other')
  })

  it('reads a creator with no account, no country and no name', () => {
    const creator = mapAdminProgramPayouts(
      withCreator({ account_status: null, account_country: null, name: null }),
    ).creators[0]
    expect(creator).toMatchObject({
      accountStatus: 'not_connected',
      accountCountry: null,
      name: '',
    })
    expect(creatorName(creator.name)).toBe('Unnamed creator')
  })

  it('offers Cancel only when the answer says so', () => {
    expect(mapAdminProgramPayouts(withOpen({ can_cancel: undefined })).open[0].canCancel).toBe(
      false,
    )
    expect(mapAdminProgramPayouts(withOpen({ can_cancel: 'true' })).open[0].canCancel).toBe(false)
  })

  it('reads a payout that failed and one that was canceled', () => {
    const failed = mapAdminProgramPayouts(
      withRecent({ status: 'failed', failure_code: 'account_not_ready', transfer_id: null }),
    ).recent[0]
    expect(failed).toMatchObject({
      status: 'failed',
      failureCode: 'account_not_ready',
      transferId: null,
    })
    expect(
      mapAdminProgramPayouts(withRecent({ status: 'canceled', closed_at: null })).recent[0],
    ).toMatchObject({ status: 'canceled', closedAt: null })
  })

  it.each([
    ['nothing', null],
    ['a list of two rows', [answer, answer]],
    ['text', 'on'],
    ['a switch that is not true or false', { ...answer, enabled: 'true' }],
    ['no word on program money', { ...answer, money_enabled: undefined }],
    ['a smallest payout that is not whole', { ...answer, min_payout_minor: 25.5 }],
    ['a negative smallest payout', { ...answer, min_payout_minor: -1 }],
    ['a version that is not a time', { ...answer, updated_at: 'yesterday' }],
    ['no totals', { ...answer, totals: undefined }],
    ['totals as a list', { ...answer, totals: [] }],
    [
      'a total in a currency that is not a code',
      { ...answer, totals: { ...answer.totals, ready_minor_by_currency: { usd: 1 } } },
    ],
    ['creators that are not a list', { ...answer, creators: {} }],
    ['a creator without an id', withCreator({ affiliate_id: '' })],
    ['a creator without a currency', withCreator({ currency: undefined })],
    ['a payable that is not a number', withCreator({ payable_minor: 'x' })],
    ['a negative payable', withCreator({ payable_minor: -4410 })],
    ['a reason that is not text', withCreator({ blocker: 1 })],
    ['programs that are not a list', withCreator({ programs: 'SpeakSix' })],
    ['a platform without an account', { ...answer, platform: { registered: true, enabled: true } }],
    ['an open payout that is already paid', withOpen({ status: 'paid' })],
    ['an open payout without a time', withOpen({ created_at: null })],
    ['a closed payout that is still open', withRecent({ status: 'processing' })],
    ['a closed payout without an amount', withRecent({ amount_minor: undefined })],
  ])('refuses %s', (_name, value) => {
    expect(() => mapAdminProgramPayouts(value)).toThrow()
  })
})

describe('what is sent to pay, cancel and configure', () => {
  it('names the amount on screen when paying one creator', () => {
    expect(programPayoutActionInput(pay)).toEqual({
      action: 'pay',
      affiliate_id: ADA,
      currency: 'USD',
      expected_amount_minor: 4410,
    })
  })

  it('names the count and the total when paying everyone who is ready', () => {
    expect(programPayoutActionInput(payReady)).toEqual({
      action: 'pay_ready',
      currency: 'USD',
      expected_count: 3,
      expected_total_minor: 13230,
    })
  })

  it('names the payout when canceling', () => {
    expect(programPayoutActionInput(cancel)).toEqual({ action: 'cancel', payout_id: PAYOUT })
  })

  it.each([
    ['a payout of nothing', { ...pay, expectedAmountMinor: 0 }],
    ['an amount that is not whole', { ...pay, expectedAmountMinor: 44.1 }],
    ['a creator that is not named', { ...pay, affiliateId: ' ' }],
    ['a currency that is not a code', { ...pay, currency: 'usd' }],
    ['paying no one', { ...payReady, expectedCount: 0 }],
    ['a total of nothing', { ...payReady, expectedTotalMinor: 0 }],
    ['a payout that is not named', { ...cancel, payoutId: '' }],
    ['an action it does not know', { action: 'refund', payoutId: PAYOUT } as never],
  ])('does not send %s', (_name, input) => {
    expect(programPayoutActionInput(input)).toBeNull()
  })

  it('sends settings with the version they were made against', () => {
    expect(programPayoutSettingsInput(settings)).toEqual({
      input: { enabled: true, min_payout_minor: 5000, expected_updated_at: READ_AT },
    })
  })

  it.each([
    [
      'a smallest payout under 1.00',
      { ...settings, minPayoutMinor: 99 },
      'The smallest payout must be between 1.00 and 1,000,000.00.',
    ],
    [
      'a smallest payout over 1,000,000.00',
      { ...settings, minPayoutMinor: 100_000_001 },
      'The smallest payout must be between 1.00 and 1,000,000.00.',
    ],
    [
      'no version',
      { ...settings, expectedUpdatedAt: null },
      'Refresh this page before changing payout settings.',
    ],
    [
      'a version that is not a time',
      { ...settings, expectedUpdatedAt: 'latest' },
      'Refresh this page before changing payout settings.',
    ],
  ])('does not send %s', (_name, input, refused) => {
    expect(programPayoutSettingsInput(input)).toEqual({ refused })
  })
})

describe('program payout words', () => {
  it('shows money in normal units, never minor units', () => {
    expect(payoutMoney(4410, 'USD')).toBe('$44.10')
    expect(payoutMoney(1234567, 'USD')).toBe('$12,345.67')
    expect(payoutMoney(41000, 'EUR')).toBe('410.00 EUR')
  })

  it('says why a creator is waiting in plain words', () => {
    expect(BLOCKER_WORDS).toEqual({
      no_account: 'No payout account yet',
      account_not_ready: 'Payout account needs attention',
      below_minimum: 'Below the smallest payout',
      payout_open: 'A payout is on its way',
      payouts_off: 'Payouts are switched off',
      platform_not_ready: 'Platform is not set up for payouts',
      other: 'Cannot be paid yet',
    })
  })

  it('says why a transfer was not taken in plain words', () => {
    expect(payoutFailureWords('platform_balance_insufficient')).toBe('Platform balance too low')
    expect(payoutFailureWords('recipient_currency_unsupported')).toBe(
      'Account cannot receive this currency',
    )
    expect(payoutFailureWords('platform_cross_border_route_unavailable')).toBe(
      'Account country cannot be paid',
    )
    expect(payoutFailureWords('transfer_not_found')).toBe('Stripe has no record of the transfer')
    expect(payoutFailureWords('account_not_ready')).toBe('Payout account could not receive it')
    expect(payoutFailureWords('provider_outcome_unknown')).toBe('Stripe did not answer')
    expect(payoutFailureWords('card_declined')).toBe('Stripe refused the transfer')
    expect(payoutFailureWords(null)).toBeNull()
  })

  it('says where an open payout stands', () => {
    const open = mapAdminProgramPayouts(answer).open[0]
    const sending: AdminOpenPayout = { ...open, status: 'processing', attempts: 1 }
    expect(openPayoutWords(open)).toBe('Queued')
    expect(openPayoutWords(sending)).toBe('Sending')
    expect(openPayoutWords({ ...sending, attempts: 3 })).toBe('Trying again')
    expect(
      openPayoutWords({ ...sending, attempts: 2, failureCode: 'platform_balance_insufficient' }),
    ).toBe('Trying again: platform balance too low')
  })

  it('shows a date without its year only in the same year', () => {
    const now = new Date('2026-11-13T12:00:00Z')
    expect(payoutDate('2026-11-06T10:03:10+00:00', now)).toBe('6 Nov')
    expect(payoutDate('2025-12-31T23:59:00+00:00', now)).toBe('31 Dec 2025')
    expect(payoutDate(null, now)).toBe('')
    expect(payoutDate('soon', now)).toBe('')
  })

  it('lists currencies with US dollars first', () => {
    expect(currenciesOf([{ currency: 'GBP' }, { currency: 'USD' }, { currency: 'EUR' }])).toEqual([
      'USD',
      'EUR',
      'GBP',
    ])
    expect(currenciesOf([{ currency: 'USD' }, { currency: 'USD' }])).toEqual(['USD'])
  })

  it('names a refusal from its detail', () => {
    expect(programPayoutRefusal('amount_changed')).toMatchObject({
      code: 'conflict',
      message: PAYOUT_AMOUNT_CHANGED,
    })
    expect(programPayoutRefusal('not_cancelable')).toMatchObject({
      code: 'invalid_state',
      message: PAYOUT_NOT_CANCELABLE,
    })
    expect(programPayoutRefusal('settings_changed')).toMatchObject({
      code: 'conflict',
      message: PAYOUT_SETTINGS_CHANGED,
    })
    expect(programPayoutRefusal('money_disabled')).toMatchObject({
      code: 'invalid_state',
      message: PAYOUT_MONEY_OFF,
    })
    expect(programPayoutRefusal('no_platform')).toMatchObject({
      code: 'invalid_state',
      message: PAYOUT_NO_PLATFORM,
    })
    expect(programPayoutRefusal('invalid_min_payout_minor')).toMatchObject({
      code: 'invalid_input',
      message: 'The smallest payout must be between 1.00 and 1,000,000.00.',
    })
    for (const detail of ['invalid_input', 'invalid_enabled', 'invalid_expected_updated_at']) {
      expect(programPayoutRefusal(detail)).toMatchObject({
        code: 'invalid_input',
        message: PAYOUT_REQUEST_REFUSED,
      })
    }
    expect(programPayoutRefusal('something_else')).toBeNull()
    expect(programPayoutRefusal(null)).toBeNull()
  })

  it('says why a creator cannot be paid when the refusal names the reason', () => {
    expect(programPayoutRefusal('not_payable', 'creator is not payable: below_minimum')).toEqual({
      code: 'invalid_state',
      message:
        'This creator cannot be paid right now, so nothing was sent: below the smallest payout.',
      retryable: false,
    })
    expect(programPayoutRefusal('not_payable', 'creator is not payable')).toMatchObject({
      code: 'invalid_state',
      message: PAYOUT_NOT_PAYABLE,
    })
  })
})

describe('the admin program payouts gateway', () => {
  it('names the three functions', () => {
    expect(ADMIN_RPCS).toMatchObject({
      programPayouts: 'get_admin_program_payouts',
      performProgramPayout: 'perform_admin_program_payout',
      configureProgramPayouts: 'configure_admin_program_payouts',
    })
  })

  it('answers "not configured" without a client', async () => {
    const gateway = createAdminGateway(null)
    const unconfigured = { data: null, status: 'unconfigured', error: { code: 'not_configured' } }

    await expect(gateway.getProgramPayouts?.()).resolves.toMatchObject(unconfigured)
    await expect(gateway.performProgramPayout?.(pay)).resolves.toMatchObject(unconfigured)
    await expect(gateway.configureProgramPayouts?.(settings)).resolves.toMatchObject(unconfigured)
  })

  it('reads program payouts with no arguments', async () => {
    const client = answering()

    const result = await createAdminGateway(client.value).getProgramPayouts?.()

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('get_admin_program_payouts', undefined)
    expect(result).toEqual({ data: read, status: 'ready', error: null })
  })

  it.each([
    ['a role that may not see it', { code: '42501', message: 'no' }, 403, 'unauthorized'],
    ['an ended session', { code: '28000', message: 'no' }, 401, 'unauthorized'],
    ['a failing service', { code: 'XX000', message: 'no' }, 503, 'error'],
  ])('reports %s on a read', async (_name, error, status, expected) => {
    const result = await createAdminGateway(refusing(error, status).value).getProgramPayouts?.()

    expect(result?.data).toBeNull()
    expect(result?.status).toBe(expected)
  })

  it('reports a database without the functions as not available', async () => {
    const client = refusing({ code: 'PGRST202', message: 'Could not find the function' }, 404)
    const gateway = createAdminGateway(client.value)

    await expect(gateway.getProgramPayouts?.()).resolves.toMatchObject({
      error: { code: 'contract_unavailable' },
    })
    await expect(gateway.performProgramPayout?.(pay)).resolves.toMatchObject({
      error: { code: 'contract_unavailable' },
    })
  })

  it('reports an answer it cannot read, and a call that throws', async () => {
    const unreadable = rpcClient(async () => ({ data: { enabled: 'yes' }, error: null }))
    const thrown = rpcClient(async () => {
      throw new Error('network')
    })

    await expect(createAdminGateway(unreadable.value).getProgramPayouts?.()).resolves.toMatchObject(
      { data: null, error: { code: 'invalid_response' } },
    )
    await expect(
      createAdminGateway(unreadable.value).performProgramPayout?.(pay),
    ).resolves.toMatchObject({ data: null, error: { code: 'invalid_response' } })
    await expect(createAdminGateway(thrown.value).getProgramPayouts?.()).resolves.toMatchObject({
      data: null,
      error: { code: 'temporarily_unavailable', retryable: true },
    })
    await expect(
      createAdminGateway(thrown.value).performProgramPayout?.(pay),
    ).resolves.toMatchObject({ data: null, error: { code: 'temporarily_unavailable' } })
    await expect(
      createAdminGateway(thrown.value).configureProgramPayouts?.(settings),
    ).resolves.toMatchObject({ data: null, error: { code: 'temporarily_unavailable' } })
  })

  it('pays one creator as one input that names the expected amount', async () => {
    const client = answering()

    const result = await createAdminGateway(client.value).performProgramPayout?.(pay)

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('perform_admin_program_payout', {
      p_input: { action: 'pay', affiliate_id: ADA, currency: 'USD', expected_amount_minor: 4410 },
    })
    expect(result).toEqual({ data: read, status: 'ready', error: null })
  })

  it('pays everyone who is ready as one input that names the count and the total', async () => {
    const client = answering()

    await createAdminGateway(client.value).performProgramPayout?.(payReady)

    expect(client.rpc).toHaveBeenCalledWith('perform_admin_program_payout', {
      p_input: {
        action: 'pay_ready',
        currency: 'USD',
        expected_count: 3,
        expected_total_minor: 13230,
      },
    })
  })

  it('cancels a payout by its id', async () => {
    const client = answering()

    await createAdminGateway(client.value).performProgramPayout?.(cancel)

    expect(client.rpc).toHaveBeenCalledWith('perform_admin_program_payout', {
      p_input: { action: 'cancel', payout_id: PAYOUT },
    })
  })

  it('does not send a payment it cannot describe', async () => {
    const client = answering()

    const result = await createAdminGateway(client.value).performProgramPayout?.({
      ...pay,
      expectedAmountMinor: 0,
    })

    expect(client.rpc).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'invalid_input', message: PAYOUT_REQUEST_REFUSED },
    })
  })

  it.each([
    ['amounts that changed', 'amount_changed', 'conflict', PAYOUT_AMOUNT_CHANGED],
    ['a creator who cannot be paid', 'not_payable', 'invalid_state', PAYOUT_NOT_PAYABLE],
    ['a payout already sending', 'not_cancelable', 'invalid_state', PAYOUT_NOT_CANCELABLE],
    ['an input it does not accept', 'invalid_input', 'invalid_input', PAYOUT_REQUEST_REFUSED],
  ])('reports %s', async (_name, details, code, message) => {
    const client = refusing({ code: '22023', message: 'no', details })

    await expect(createAdminGateway(client.value).performProgramPayout?.(pay)).resolves.toEqual({
      data: null,
      status: 'error',
      error: { code, message, retryable: false },
    })
  })

  it('reports a refusal that names no reason by its error code', async () => {
    const conflict = refusing({ code: '40001', message: 'changed' }, 409)
    const invalid = refusing({ code: '22023', message: 'no' })

    await expect(
      createAdminGateway(conflict.value).performProgramPayout?.(pay),
    ).resolves.toMatchObject({ error: { code: 'conflict', message: PAYOUT_LIST_CHANGED } })
    await expect(
      createAdminGateway(invalid.value).performProgramPayout?.(pay),
    ).resolves.toMatchObject({ error: { code: 'invalid_input', message: PAYOUT_REQUEST_REFUSED } })
  })

  it('reports a sign-in that is not recent enough as an access refusal', async () => {
    const client = refusing(
      { code: '42501', message: 'Pay Program Creators requires a recent sign-in', details: 'x' },
      403,
    )
    const gateway = createAdminGateway(client.value)

    await expect(gateway.performProgramPayout?.(pay)).resolves.toMatchObject({
      data: null,
      status: 'unauthorized',
      error: { code: 'not_authorized' },
    })
    await expect(gateway.configureProgramPayouts?.(settings)).resolves.toMatchObject({
      data: null,
      status: 'unauthorized',
    })
  })

  it('keeps an access refusal an access refusal whatever its detail says', async () => {
    const client = refusing({ code: '42501', message: 'no', details: 'amount_changed' }, 403)

    await expect(
      createAdminGateway(client.value).performProgramPayout?.(pay),
    ).resolves.toMatchObject({ data: null, status: 'unauthorized' })
  })

  it('sends settings as one input that names the version they were made against', async () => {
    const client = answering()

    const result = await createAdminGateway(client.value).configureProgramPayouts?.(settings)

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('configure_admin_program_payouts', {
      p_input: { enabled: true, min_payout_minor: 5000, expected_updated_at: READ_AT },
    })
    expect(result).toEqual({ data: read, status: 'ready', error: null })
  })

  it('does not send settings without a version or with a number out of range', async () => {
    const client = answering()
    const gateway = createAdminGateway(client.value)

    await expect(
      gateway.configureProgramPayouts?.({ ...settings, expectedUpdatedAt: null }),
    ).resolves.toMatchObject({ data: null, status: 'error', error: { code: 'invalid_input' } })
    await expect(
      gateway.configureProgramPayouts?.({ ...settings, minPayoutMinor: 50 }),
    ).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'The smallest payout must be between 1.00 and 1,000,000.00.',
      },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['settings that changed in another session', '40001', 'settings_changed', 'conflict'],
    ['program money being off', '22023', 'money_disabled', 'invalid_state'],
    ['no program with a balance', '22023', 'no_platform', 'invalid_state'],
    ['a smallest payout out of range', '22023', 'invalid_min_payout_minor', 'invalid_input'],
  ])('reports %s', async (_name, code, details, expected) => {
    const client = refusing({ code, message: 'no', details }, code === '40001' ? 409 : 400)

    await expect(
      createAdminGateway(client.value).configureProgramPayouts?.(settings),
    ).resolves.toMatchObject({ data: null, status: 'error', error: { code: expected } })
  })
})
