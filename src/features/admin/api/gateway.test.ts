import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'

const contextRow = {
  user_id: 'admin-1',
  email: 'owner@example.test',
  full_name: 'Platform Owner',
  role: 'owner',
  active: true,
}

const productRow = {
  id: 'product-1',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'draft',
  created_at: '2026-08-28T10:00:00.000Z',
  updated_at: '2026-08-28T10:00:00.000Z',
}

function rpcClient(
  implementation: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => Promise<AdminBackendResponse>,
) {
  const rpc = vi.fn(implementation)
  return { client: { rpc } satisfies AdminSupabaseClient, rpc }
}

describe('admin RPC gateway', () => {
  it('stays unconfigured without attempting a browser data request', async () => {
    const gateway = createAdminGateway(null)

    await expect(gateway.getAdminContext()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
      error: { code: 'not_configured', retryable: false },
    })
    await expect(gateway.getProducts()).resolves.toMatchObject({
      data: [],
      status: 'unconfigured',
    })
  })

  it('maps protected admin context and product RPC rows', async () => {
    const { client, rpc } = rpcClient(async (functionName) => {
      if (functionName === ADMIN_RPCS.context) {
        return { data: [contextRow], error: null, status: 200 }
      }
      return { data: [productRow], error: null, status: 200 }
    })
    const gateway = createAdminGateway(client)

    await expect(gateway.getAdminContext()).resolves.toEqual({
      data: {
        userId: 'admin-1',
        email: 'owner@example.test',
        fullName: 'Platform Owner',
        role: 'owner',
        active: true,
      },
      status: 'ready',
      error: null,
    })
    await expect(gateway.getProducts()).resolves.toEqual({
      data: [
        {
          id: 'product-1',
          name: 'Daily Planner',
          slug: 'daily-planner',
          status: 'draft',
          createdAt: '2026-08-28T10:00:00.000Z',
          updatedAt: '2026-08-28T10:00:00.000Z',
        },
      ],
      status: 'ready',
      error: null,
    })
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_admin_context', undefined)
    expect(rpc).toHaveBeenNthCalledWith(2, 'get_admin_products', undefined)
  })

  it('creates only the name and slug draft payload through create_admin_product', async () => {
    const { client, rpc } = rpcClient(async () => ({
      data: productRow,
      error: null,
      status: 200,
    }))

    const result = await createAdminGateway(client).createProduct({
      name: '  Daily Planner  ',
      slug: '  DAILY-PLANNER  ',
    })

    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith('create_admin_product', {
      p_input: { name: 'Daily Planner', slug: 'daily-planner' },
    })
    expect(result).toMatchObject({ status: 'ready', data: { status: 'draft' }, error: null })
    const payload = rpc.mock.calls[0]?.[1] as { p_input?: object } | undefined
    expect(Object.keys(payload?.p_input ?? {})).toEqual(['name', 'slug'])
  })

  it('rejects a create response that is not draft', async () => {
    const { client } = rpcClient(async () => ({
      data: { ...productRow, status: 'active' },
      error: null,
      status: 200,
    }))

    await expect(
      createAdminGateway(client).createProduct({ name: 'Daily Planner', slug: 'daily-planner' }),
    ).resolves.toMatchObject({
      data: null,
      status: 'error',
      error: { code: 'invalid_response', retryable: false },
    })
  })

  it('sanitizes authorization and duplicate errors without leaking backend details', async () => {
    const authorization = rpcClient(async () => ({
      data: null,
      error: { code: '42501', message: 'secret policy and table details', status: 403 },
      status: 403,
    }))
    const duplicate = rpcClient(async () => ({
      data: null,
      error: { code: '23505', message: 'products_slug_key raw database detail', status: 409 },
      status: 409,
    }))

    const denied = await createAdminGateway(authorization.client).getProducts()
    const conflict = await createAdminGateway(duplicate.client).createProduct({
      name: 'Daily Planner',
      slug: 'daily-planner',
    })

    expect(denied).toMatchObject({
      status: 'unauthorized',
      error: { code: 'not_authorized', retryable: false },
    })
    expect(denied.error?.message).not.toContain('secret policy')
    expect(conflict).toMatchObject({
      status: 'error',
      error: { code: 'conflict', message: 'A product with that slug already exists.' },
    })
    expect(conflict.error?.message).not.toContain('products_slug_key')
  })

  it('returns safe failures for thrown requests and malformed data', async () => {
    const thrown = rpcClient(async () => {
      throw new Error('network details that must not reach the UI')
    })
    const malformed = rpcClient(async () => ({ data: [{ id: 123 }], error: null, status: 200 }))

    await expect(createAdminGateway(thrown.client).getProducts()).resolves.toMatchObject({
      data: [],
      status: 'error',
      error: { code: 'temporarily_unavailable', retryable: true },
    })
    await expect(createAdminGateway(malformed.client).getProducts()).resolves.toMatchObject({
      data: [],
      status: 'error',
      error: { code: 'invalid_response', retryable: false },
    })
  })
})
