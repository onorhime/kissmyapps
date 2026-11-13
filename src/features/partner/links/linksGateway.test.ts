import { describe, expect, it, vi } from 'vitest'
import { PARTNER_RPCS, createPartnerDataGateway } from '../api'
import type { PartnerSupabaseClient } from '../api'
import { linksBackendFixture as backend } from './links.fixture'

/**
 * The three link functions through the partner gateway: the names and arguments that go to the
 * database, and what each of its failures turns into.
 */

type RpcAnswer = {
  data: unknown
  error: { code?: string; message?: string; details?: string; status?: number } | null
  status?: number
}

function clientAnswering(answer: RpcAnswer | (() => Promise<RpcAnswer>)) {
  const rpc = vi.fn((functionName: string, args?: Record<string, unknown>) => {
    void functionName
    void args
    return typeof answer === 'function' ? answer() : Promise.resolve(answer)
  })
  const client: PartnerSupabaseClient = {
    from: () => {
      throw new Error('The link functions read no views.')
    },
    rpc,
  }
  return { rpc, gateway: createPartnerDataGateway(client) }
}

const ok = (data: unknown): RpcAnswer => ({ data, error: null, status: 200 })

describe('the link functions the partner dashboard calls', () => {
  it('names the three functions exactly as the backend does', () => {
    expect(PARTNER_RPCS).toMatchObject({
      programLinks: 'partner_program_links',
      programLinkCreate: 'partner_program_link_create',
      programLinkRemove: 'partner_program_link_remove',
    })
  })

  it('reads the links with no arguments', async () => {
    const { gateway, rpc } = clientAnswering(ok(backend.partner_program_links))
    const result = await gateway.getProgramLinks!()

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_links', undefined)
    expect(result.status).toBe('ready')
    expect(result.error).toBeNull()
    expect(result.data?.programs.length).toBeGreaterThan(1)
    expect(result.data?.programs[0].links[0].kind).toBe('main')
  })

  it('answers a creator with no program as ready and empty, not as a failure', async () => {
    const { gateway } = clientAnswering(ok(backend.partner_program_links_none))
    const result = await gateway.getProgramLinks!()
    expect(result).toMatchObject({ status: 'ready', error: null, data: { programs: [] } })
  })

  it('adds a link with the program’s slug and the name', async () => {
    const { gateway, rpc } = clientAnswering(ok(backend.partner_program_link_create))
    const result = await gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' })

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_link_create', {
      p_input: { slug: 'speaksix', name: 'Podcast' },
    })
    expect(result.status).toBe('ready')
    expect(result.data?.slug).toBe('speaksix')
    expect(result.data?.links.some((link) => link.kind === 'custom')).toBe(true)
  })

  it('removes a link by its id', async () => {
    const { gateway, rpc } = clientAnswering(ok(backend.partner_program_link_remove))
    const result = await gateway.removeProgramLink!('link-9')

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_link_remove', {
      p_input: { link_id: 'link-9' },
    })
    expect(result.data?.slug).toBe('speaksix')
  })

  it.each([
    [{ code: '22023', details: 'invalid_input', status: 400 }, 'invalid_input'],
    [{ code: '22023', details: 'invalid_name', status: 400 }, 'invalid_name'],
    [{ code: '22023', details: 'name_taken', status: 400 }, 'name_taken'],
    [{ code: '22023', details: 'too_many_links', status: 400 }, 'too_many_links'],
    [{ code: '42501', details: 'not_member', status: 403 }, 'not_member'],
    [{ code: '42501', status: 403 }, 'not_authorized'],
    [{ code: 'PGRST301', status: 401 }, 'not_authenticated'],
    [{ code: 'PGRST202', status: 404 }, 'contract_unavailable'],
    [{ code: '57014', status: 503 }, 'temporarily_unavailable'],
    [{ code: 'XX000', status: 400 }, 'unknown'],
  ] as const)('turns the failure %o of adding into %s', async (error, code) => {
    const { gateway } = clientAnswering({ data: null, error, status: error.status })
    const result = await gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' })

    expect(result.data).toBeNull()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe(code)
    // The sentence is ours; whatever the database wrote is never passed on.
    expect(result.error?.message).not.toMatch(/_|SQL|permission denied/i)
  })

  it.each([
    [{ code: '22023', details: 'invalid_input', status: 400 }, 'invalid_input'],
    [{ code: '22023', details: 'link_in_use', status: 400 }, 'link_in_use'],
    [{ code: '22023', details: 'not_removable', status: 400 }, 'not_removable'],
    [{ code: 'P0002', details: 'link_not_found', status: 400 }, 'link_not_found'],
    [{ code: 'P0002', status: 400 }, 'link_not_found'],
    [{ code: '42501', status: 403 }, 'not_authorized'],
  ] as const)('turns the failure %o of removing into %s', async (error, code) => {
    const { gateway } = clientAnswering({ data: null, error, status: error.status })
    const result = await gateway.removeProgramLink!('link-9')
    expect(result).toMatchObject({ data: null, status: 'error', error: { code } })
  })

  it('does not pass on the database’s own message', async () => {
    const { gateway } = clientAnswering({
      data: null,
      error: {
        code: '22023',
        message: 'a link named podcast already exists for member 42',
        details: 'name_taken',
      },
      status: 400,
    })
    const result = await gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' })
    expect(result.error).toEqual({
      code: 'name_taken',
      message: 'You already have a link with that name. Pick another name.',
      retryable: false,
    })
  })

  it('says links are not here yet on a database from before them', async () => {
    const { gateway } = clientAnswering({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
      status: 404,
    })
    expect((await gateway.getProgramLinks!()).error).toMatchObject({
      code: 'contract_unavailable',
      retryable: false,
    })
  })

  it('refuses an answer it cannot read rather than drawing from it', async () => {
    for (const data of [null, [], { programs: 'none' }, { stats_days: 30, programs: [] }]) {
      const { gateway } = clientAnswering(ok(data))
      expect((await gateway.getProgramLinks!()).error?.code).toBe('invalid_response')
    }
    const wholePage = clientAnswering(ok(backend.partner_program_links))
    expect(
      (await wholePage.gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' })).error
        ?.code,
    ).toBe('invalid_response')
    const nothing = clientAnswering(ok({ ok: true }))
    expect((await nothing.gateway.removeProgramLink!('link-9')).error?.code).toBe(
      'invalid_response',
    )
  })

  it('answers a network failure as something to try again', async () => {
    const { gateway } = clientAnswering(() => Promise.reject(new TypeError('Failed to fetch')))
    for (const result of [
      await gateway.getProgramLinks!(),
      await gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' }),
      await gateway.removeProgramLink!('link-9'),
    ])
      expect(result.error).toMatchObject({ code: 'temporarily_unavailable', retryable: true })
  })

  it('says it is not configured, and calls nothing, without a client', async () => {
    const gateway = createPartnerDataGateway(null)
    const results = await Promise.all([
      gateway.getProgramLinks!(),
      gateway.createProgramLink!({ slug: 'speaksix', name: 'Podcast' }),
      gateway.removeProgramLink!('link-9'),
    ])
    for (const result of results) {
      expect(result).toMatchObject({
        data: null,
        status: 'unconfigured',
        error: { code: 'not_configured' },
      })
    }
  })
})
