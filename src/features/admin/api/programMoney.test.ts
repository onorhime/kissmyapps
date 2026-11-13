import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import {
  PROGRAM_MONEY_CHANGED,
  depositField,
  depositLabel,
  depositToMinor,
  feeField,
  feeLabel,
  feePercentToBps,
  mapAdminProgramMoney,
  moneyByCurrency,
  programMoneyRefusal,
} from './programMoney'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'

/** What `get_admin_program_money` and `configure_admin_program_money` answer. */
const answer = {
  enabled: false,
  fee_bps: 1000,
  min_deposit_minor: 5000,
  updated_at: '2026-11-13T13:52:14.059098+00:00',
  programs_with_balance: 3,
  available_minor_by_currency: { USD: 823600, EUR: 41000 },
  reserved_minor_by_currency: { USD: 12100 },
  owed_to_creators_minor_by_currency: {},
}

const read = {
  enabled: false,
  feeBps: 1000,
  minDepositMinor: 5000,
  updatedAt: '2026-11-13T13:52:14.059098+00:00',
  totals: {
    programsWithBalance: 3,
    availableMinorByCurrency: { USD: 823600, EUR: 41000 },
    reservedMinorByCurrency: { USD: 12100 },
    owedToCreatorsMinorByCurrency: {},
  },
}

const change = {
  enabled: true,
  feeBps: 1250,
  minDepositMinor: 10000,
  expectedUpdatedAt: '2026-11-13T13:52:14.059098+00:00',
}

function rpcClient(
  implementation: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => Promise<AdminBackendResponse>,
) {
  const rpc = vi.fn(implementation)
  return { value: { rpc } satisfies AdminSupabaseClient, rpc }
}

function refusing(error: NonNullable<AdminBackendResponse['error']>, status = 400) {
  return rpcClient(async () => ({ data: null, error, status }))
}

describe('reading program money', () => {
  it('reads the switch, the two numbers, the version and the four totals', () => {
    expect(mapAdminProgramMoney(answer)).toEqual(read)
  })

  it('reads an answer wrapped in a row or under the function name', () => {
    expect(mapAdminProgramMoney([answer])).toEqual(read)
    expect(mapAdminProgramMoney({ get_admin_program_money: answer })).toEqual(read)
    expect(mapAdminProgramMoney([{ configure_admin_program_money: answer }])).toEqual(read)
  })

  it('reads totals placed under "totals"', () => {
    const { enabled, fee_bps, min_deposit_minor, updated_at, ...totals } = answer
    expect(
      mapAdminProgramMoney({ enabled, fee_bps, min_deposit_minor, updated_at, totals }),
    ).toEqual(read)
  })

  it('keeps going without totals or a version', () => {
    expect(mapAdminProgramMoney({ enabled: true, fee_bps: 0, min_deposit_minor: 100 })).toEqual({
      enabled: true,
      feeBps: 0,
      minDepositMinor: 100,
      updatedAt: null,
      totals: null,
    })
  })

  it('reads no money in any currency, and sums sent as digits', () => {
    const money = mapAdminProgramMoney({
      ...answer,
      updated_at: null,
      programs_with_balance: '0',
      available_minor_by_currency: null,
      reserved_minor_by_currency: {},
      owed_to_creators_minor_by_currency: { USD: '900000000000' },
    })
    expect(money.updatedAt).toBeNull()
    expect(money.totals).toEqual({
      programsWithBalance: 0,
      availableMinorByCurrency: {},
      reservedMinorByCurrency: {},
      owedToCreatorsMinorByCurrency: { USD: 900000000000 },
    })
  })

  it.each([
    ['nothing', null],
    ['a list of two rows', [answer, answer]],
    ['text', 'on'],
    ['a switch that is not true or false', { ...answer, enabled: 'true' }],
    ['a missing fee', { ...answer, fee_bps: undefined }],
    ['a fee that is not whole', { ...answer, fee_bps: 10.5 }],
    ['a fee above 100%', { ...answer, fee_bps: 10001 }],
    ['a negative deposit', { ...answer, min_deposit_minor: -1 }],
    ['a version that is not a time', { ...answer, updated_at: 'yesterday' }],
    ['a negative count', { ...answer, programs_with_balance: -1 }],
    ['a count that is missing among totals', { ...answer, programs_with_balance: undefined }],
    ['totals as a list', { ...answer, available_minor_by_currency: [823600] }],
    ['a currency that is not a code', { ...answer, reserved_minor_by_currency: { usd: 1 } }],
    ['an amount that is not a number', { ...answer, reserved_minor_by_currency: { USD: 'x' } }],
  ])('refuses %s', (_name, value) => {
    expect(() => mapAdminProgramMoney(value)).toThrow()
  })
})

describe('program money numbers', () => {
  it('turns a typed fee into basis points', () => {
    expect(feePercentToBps('10')).toBe(1000)
    expect(feePercentToBps(' 12.5% ')).toBe(1250)
    expect(feePercentToBps('0')).toBe(0)
    expect(feePercentToBps('0.25')).toBe(25)
    expect(feePercentToBps('50')).toBe(5000)
  })

  it.each(['', 'ten', '-1', '50.01', '51', '100', '1.234', '1e1'])(
    'refuses the fee "%s"',
    (fee) => {
      expect(feePercentToBps(fee)).toBeNull()
    },
  )

  it('turns a typed deposit into minor units', () => {
    expect(depositToMinor('50')).toBe(5000)
    expect(depositToMinor('$1,250.50')).toBe(125050)
    expect(depositToMinor('1')).toBe(100)
    expect(depositToMinor('1000000')).toBe(100000000)
    expect(depositToMinor('2.5')).toBe(250)
  })

  it.each(['', 'fifty', '0', '0.99', '1000000.01', '12.345', '-5'])(
    'refuses the deposit "%s"',
    (deposit) => {
      expect(depositToMinor(deposit)).toBeNull()
    },
  )

  it('shows the numbers the way they are typed and read', () => {
    expect(feeField(1000)).toBe('10')
    expect(feeField(1250)).toBe('12.5')
    expect(feeLabel(1000)).toBe('10%')
    expect(feeLabel(0)).toBe('0%')
    expect(depositField(5000)).toBe('50.00')
    expect(depositLabel(5000)).toBe('50.00')
    expect(depositLabel(125050)).toBe('1,250.50')
  })

  it('reads back what it shows', () => {
    for (const bps of [0, 25, 1000, 1250, 5000]) expect(feePercentToBps(feeField(bps))).toBe(bps)
    for (const minor of [100, 5000, 125050, 100000000]) {
      expect(depositToMinor(depositField(minor))).toBe(minor)
    }
  })

  it('lists money per currency, US dollars first', () => {
    expect(moneyByCurrency({ EUR: 41000, USD: 823600, GBP: 100 })).toEqual([
      '$8,236.00',
      '410.00 EUR',
      '1.00 GBP',
    ])
    expect(moneyByCurrency({})).toEqual([])
  })

  it('names a refusal from its detail', () => {
    expect(programMoneyRefusal('invalid_fee_bps')).toMatchObject({
      code: 'invalid_input',
      message: 'The fee must be between 0% and 50%.',
    })
    expect(programMoneyRefusal('invalid_min_deposit_minor')).toMatchObject({
      code: 'invalid_input',
      message: 'The minimum first deposit must be between 1.00 and 1,000,000.00.',
    })
    expect(programMoneyRefusal('settings_changed')).toMatchObject({
      code: 'conflict',
      message: PROGRAM_MONEY_CHANGED,
    })
    expect(programMoneyRefusal('something_else')).toBeNull()
    expect(programMoneyRefusal(null)).toBeNull()
  })
})

describe('the admin program money gateway', () => {
  it('names the two functions', () => {
    expect(ADMIN_RPCS).toMatchObject({
      programMoney: 'get_admin_program_money',
      configureProgramMoney: 'configure_admin_program_money',
    })
  })

  it('answers "not configured" without a client', async () => {
    const gateway = createAdminGateway(null)

    await expect(gateway.getProgramMoney?.()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured' },
    })
    await expect(gateway.configureProgramMoney?.(change)).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured' },
    })
  })

  it('reads program money with no arguments', async () => {
    const client = rpcClient(async () => ({ data: answer, error: null, status: 200 }))

    const result = await createAdminGateway(client.value).getProgramMoney?.()

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('get_admin_program_money', undefined)
    expect(result).toEqual({ data: read, status: 'ready', error: null })
  })

  it.each([
    ['a role that may not see it', { code: '42501', message: 'no' }, 403, 'unauthorized'],
    ['an ended session', { code: '28000', message: 'no' }, 401, 'unauthorized'],
    ['a database without the function', { code: 'PGRST202', message: 'no' }, 404, 'error'],
    ['a failing service', { code: 'XX000', message: 'no' }, 503, 'error'],
  ])('reports %s on a read', async (_name, error, status, expected) => {
    const result = await createAdminGateway(refusing(error, status).value).getProgramMoney?.()

    expect(result?.data).toBeNull()
    expect(result?.status).toBe(expected)
  })

  it('reports a database without the function as not available yet', async () => {
    const client = refusing({ code: 'PGRST202', message: 'Could not find the function' }, 404)

    await expect(createAdminGateway(client.value).getProgramMoney?.()).resolves.toMatchObject({
      error: { code: 'contract_unavailable' },
    })
  })

  it('reports an answer it cannot read, and a call that throws', async () => {
    const unreadable = rpcClient(async () => ({ data: { enabled: 'yes' }, error: null }))
    const thrown = rpcClient(async () => {
      throw new Error('network')
    })

    await expect(createAdminGateway(unreadable.value).getProgramMoney?.()).resolves.toMatchObject({
      data: null,
      error: { code: 'invalid_response' },
    })
    await expect(createAdminGateway(thrown.value).getProgramMoney?.()).resolves.toMatchObject({
      data: null,
      error: { code: 'temporarily_unavailable', retryable: true },
    })
  })

  it('sends a change as one input that names the version it was made against', async () => {
    const saved = { ...answer, enabled: true, fee_bps: 1250, min_deposit_minor: 10000 }
    const client = rpcClient(async () => ({ data: saved, error: null, status: 200 }))

    const result = await createAdminGateway(client.value).configureProgramMoney?.(change)

    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(client.rpc).toHaveBeenCalledWith('configure_admin_program_money', {
      p_input: {
        enabled: true,
        fee_bps: 1250,
        min_deposit_minor: 10000,
        expected_updated_at: '2026-11-13T13:52:14.059098+00:00',
      },
    })
    expect(result).toEqual({
      data: { ...read, enabled: true, feeBps: 1250, minDepositMinor: 10000 },
      status: 'ready',
      error: null,
    })
  })

  it('sends a null version when there are no settings yet', async () => {
    const client = rpcClient(async () => ({ data: answer, error: null, status: 200 }))

    await createAdminGateway(client.value).configureProgramMoney?.({
      ...change,
      expectedUpdatedAt: null,
    })

    expect(client.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_input: { expected_updated_at: null },
    })
  })

  it.each([
    ['a fee above 50%', { ...change, feeBps: 5001 }],
    ['a negative fee', { ...change, feeBps: -1 }],
    ['a fee that is not whole', { ...change, feeBps: 10.5 }],
    ['a deposit under 1.00', { ...change, minDepositMinor: 99 }],
    ['a deposit over 1,000,000.00', { ...change, minDepositMinor: 100000001 }],
    ['a version that is not a time', { ...change, expectedUpdatedAt: 'latest' }],
    ['an empty version', { ...change, expectedUpdatedAt: ' ' }],
  ])('does not send %s', async (_name, input) => {
    const client = rpcClient(async () => ({ data: answer, error: null, status: 200 }))

    const result = await createAdminGateway(client.value).configureProgramMoney?.(input)

    expect(client.rpc).not.toHaveBeenCalled()
    expect(result).toMatchObject({ data: null, status: 'error', error: { code: 'invalid_input' } })
  })

  it('reports settings that changed in another session', async () => {
    const client = refusing(
      {
        code: '40001',
        message: 'platform settings changed; reload before saving',
        details: 'settings_changed',
      },
      409,
    )

    await expect(createAdminGateway(client.value).configureProgramMoney?.(change)).resolves.toEqual(
      {
        data: null,
        status: 'error',
        error: { code: 'conflict', message: PROGRAM_MONEY_CHANGED, retryable: false },
      },
    )
  })

  it('reports a conflict that names no reason the same way', async () => {
    const client = refusing({ code: '40001', message: 'changed' }, 400)

    await expect(
      createAdminGateway(client.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({ error: { code: 'conflict', message: PROGRAM_MONEY_CHANGED } })
  })

  it('names the number the database refused', async () => {
    const fee = refusing({ code: '22023', message: 'no', details: 'invalid_fee_bps' })
    const deposit = refusing({ code: '22023', message: 'no', details: 'invalid_min_deposit_minor' })
    const other = refusing({ code: '22023', message: 'no', details: 'invalid_input' })

    await expect(
      createAdminGateway(fee.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({
      error: { code: 'invalid_input', message: 'The fee must be between 0% and 50%.' },
    })
    await expect(
      createAdminGateway(deposit.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'The minimum first deposit must be between 1.00 and 1,000,000.00.',
      },
    })
    await expect(
      createAdminGateway(other.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'Check the fee and the minimum first deposit, then try again.',
      },
    })
  })

  it('keeps an access refusal an access refusal whatever its detail says', async () => {
    const client = refusing({ code: '42501', message: 'no', details: 'settings_changed' }, 403)

    await expect(
      createAdminGateway(client.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({ data: null, status: 'unauthorized' })
  })

  it('reports a change whose answer it cannot read, and a call that throws', async () => {
    const unreadable = rpcClient(async () => ({ data: [], error: null }))
    const thrown = rpcClient(async () => {
      throw new Error('network')
    })

    await expect(
      createAdminGateway(unreadable.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({ data: null, error: { code: 'invalid_response' } })
    await expect(
      createAdminGateway(thrown.value).configureProgramMoney?.(change),
    ).resolves.toMatchObject({ data: null, error: { code: 'temporarily_unavailable' } })
  })
})
