import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import { mapAdminProgramProducts } from './programProducts'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'
import { programProductsResponse } from '../products/programProducts.fixture'

function gatewayWith(implementation: () => Promise<AdminBackendResponse>) {
  const rpc = vi.fn(implementation)
  const client = { rpc } satisfies AdminSupabaseClient
  return { rpc, gateway: createAdminGateway(client) }
}

const ok = (data: unknown): AdminBackendResponse => ({ data, error: null, status: 200 })
const refused = (code: string, status: number): AdminBackendResponse => ({
  data: null,
  error: { code, message: 'refused' },
  status,
})

function entry(overrides: Record<string, unknown> = {}) {
  return { ...programProductsResponse().products[1], ...overrides }
}

describe('admin program products', () => {
  it('reads every field of the answer', () => {
    expect(mapAdminProgramProducts(programProductsResponse())).toEqual([
      {
        productId: '22222222-2222-4222-8222-222222222222',
        programId: 'a1b2c3d4-0000-4000-8000-000000000003',
        programName: 'Lingo Loop',
        programSlug: 'lingo-loop',
        programStatus: 'paused',
      },
      {
        productId: '11111111-1111-4111-8111-111111111111',
        programId: 'a1b2c3d4-0000-4000-8000-000000000002',
        programName: 'SpeakSix',
        programSlug: 'speaksix',
        programStatus: 'live',
      },
    ])
    expect(mapAdminProgramProducts({ products: [] })).toEqual([])
  })

  it('names a program without a name by its marketplace address', () => {
    const [program] = mapAdminProgramProducts({
      products: [entry({ program_name: null, program_status: 'archived' })],
    })
    expect(program).toMatchObject({ programName: 'speaksix', programStatus: 'archived' })
  })

  it.each([
    ['nothing', null],
    ['a bare list', [entry()]],
    ['no list', {}],
    ['a list that is not one', { products: 'none' }],
    ['an entry that is not an object', { products: ['speaksix'] }],
    ['a missing product id', { products: [entry({ product_id: undefined })] }],
    ['a product id that is not an id', { products: [entry({ product_id: 'speaksix' })] }],
    ['a program id that is not an id', { products: [entry({ program_id: 7 })] }],
    ['a name that is not text', { products: [entry({ program_name: 7 })] }],
    ['a missing name', { products: [entry({ program_name: undefined })] }],
    ['an address that is not one', { products: [entry({ program_slug: 'Speak Six' })] }],
    ['an unknown status', { products: [entry({ program_status: 'retired' })] }],
    ['one product in two programs', { products: [entry(), entry({ program_slug: 'other' })] }],
  ])('refuses %s', (_name, answer) => {
    expect(() => mapAdminProgramProducts(answer)).toThrow()
  })

  it('refuses the whole list when one entry cannot be trusted', async () => {
    const { gateway } = gatewayWith(async () =>
      ok({ products: [entry(), entry({ product_id: 'speaksix' })] }),
    )
    await expect(gateway.getProgramProducts!()).resolves.toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'invalid_response', retryable: false },
    })
  })

  it('calls the function by name, without arguments', async () => {
    expect(ADMIN_RPCS.programProducts).toBe('get_admin_program_products')
    const { gateway, rpc } = gatewayWith(async () => ok(programProductsResponse()))

    const result = await gateway.getProgramProducts!()

    expect(rpc).toHaveBeenCalledWith('get_admin_program_products', undefined)
    expect(result.status).toBe('ready')
    expect(result.data?.map((program) => program.programName)).toEqual(['Lingo Loop', 'SpeakSix'])
  })

  it('stays unconfigured without a backend', async () => {
    await expect(createAdminGateway(null).getProgramProducts!()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { retryable: false },
    })
  })

  it.each([
    ['PGRST202', 404],
    ['42883', 404],
  ])('reports a database without the function (%s) as not available yet', async (code, status) => {
    const { gateway } = gatewayWith(async () => refused(code, status))
    await expect(gateway.getProgramProducts!()).resolves.toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'contract_unavailable', retryable: false },
    })
  })

  it('keeps access refusals and passing failures apart', async () => {
    await expect(
      gatewayWith(async () => refused('42501', 403)).gateway.getProgramProducts!(),
    ).resolves.toMatchObject({ status: 'unauthorized', error: { code: 'not_authorized' } })
    await expect(
      gatewayWith(async () => refused('28000', 401)).gateway.getProgramProducts!(),
    ).resolves.toMatchObject({ status: 'unauthorized', error: { code: 'not_authenticated' } })
    await expect(
      gatewayWith(async () => refused('XX000', 500)).gateway.getProgramProducts!(),
    ).resolves.toMatchObject({ status: 'error', error: { retryable: true } })
    await expect(
      gatewayWith(async () => {
        throw new Error('network')
      }).gateway.getProgramProducts!(),
    ).resolves.toMatchObject({ status: 'error', error: { retryable: true } })
  })
})
