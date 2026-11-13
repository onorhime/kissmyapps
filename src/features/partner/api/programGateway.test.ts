import { describe, expect, it, vi } from 'vitest'
import { PARTNER_RPCS } from './contract'
import { createPartnerDataGateway } from './gateway'
import type { PartnerSupabaseClient } from './gateway'

/**
 * The five program functions through the partner gateway: the names and arguments that go to
 * the database, and what each of its failures turns into.
 */

type RpcAnswer = {
  data: unknown
  error: { code?: string; message?: string; details?: string; status?: number } | null
  status?: number
}

const SHA = 'a'.repeat(64)

const card = {
  slug: 'speaksix',
  name: 'SpeakSix',
  category: 'education',
  tagline: 'Speak English with confidence in six weeks.',
  logo_path: null,
  brand_name: 'SpeakSix Ltd',
  commission_type: 'percent',
  commission_rate_bps: 3000,
  commission_fixed_minor: null,
  currency: 'USD',
  commission_duration: 'months',
  commission_months: 12,
  attribution_window_days: 30,
  hold_days: 30,
  minimum_payout_minor: 2000,
  approval_mode: 'automatic',
  terms_version: 1,
}

const membership = {
  id: 'mem-1',
  program_id: 'prog-1',
  program: card,
  program_status: 'live',
  status: 'active',
  terms_version: 1,
  accepted_at: '2026-11-13T13:52:14.059098+00:00',
  needs_new_terms: false,
  link: {
    url: 'https://go.kissmyapps.dev/r/ana-creator/k3x9q2',
    short_url: 'https://go.kissmyapps.dev/speaksix/ana',
    working: true,
  },
  requested_at: '2026-11-13T13:52:14.059098+00:00',
  activated_at: '2026-11-13T13:52:14.059098+00:00',
  ended_at: null,
  decision_note: null,
}

const detail = {
  ...card,
  id: 'prog-1',
  status: 'live',
  landing_url: 'https://speaksix.com/start',
  agreement: {
    title: 'SpeakSix Affiliate Agreement',
    brand_name: 'SpeakSix Ltd',
    program_name: 'SpeakSix',
    summary: [{ label: 'Commission', value: '30% of every payment for 12 months' }],
    sections: [{ heading: '1. Commission', paragraphs: ['You earn 30% of every payment.'] }],
    extra_terms: null,
  },
  agreement_sha256: SHA,
}

function clientAnswering(answer: RpcAnswer | (() => Promise<RpcAnswer>)) {
  const rpc = vi.fn((functionName: string, args?: Record<string, unknown>) => {
    void functionName
    void args
    return typeof answer === 'function' ? answer() : Promise.resolve(answer)
  })
  const client: PartnerSupabaseClient = {
    from: () => {
      throw new Error('The program functions read no views.')
    },
    rpc,
  }
  return { client, rpc, gateway: createPartnerDataGateway(client) }
}

const ok = (data: unknown): RpcAnswer => ({ data, error: null, status: 200 })

describe('the program functions the partner dashboard calls', () => {
  it('names the five functions exactly as the backend does', () => {
    expect(PARTNER_RPCS).toMatchObject({
      marketplace: 'partner_marketplace',
      programDetail: 'partner_program_detail',
      programJoin: 'partner_program_join',
      programAcceptTerms: 'partner_program_accept_terms',
      programLeave: 'partner_program_leave',
    })
  })

  it('reads the marketplace with no arguments', async () => {
    const { gateway, rpc } = clientAnswering(
      ok({ tracking_ready: true, programs: [card], memberships: [membership] }),
    )
    const result = await gateway.getMarketplace!()

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_marketplace', undefined)
    expect(result.status).toBe('ready')
    expect(result.error).toBeNull()
    expect(result.data?.programs[0].slug).toBe('speaksix')
    expect(result.data?.memberships[0]).toMatchObject({ id: 'mem-1', program_id: 'prog-1' })
  })

  it('reads one program by its slug', async () => {
    const { gateway, rpc } = clientAnswering(
      ok({ program: detail, membership: null, accept_name: 'Ana Creator' }),
    )
    const result = await gateway.getProgram!('speaksix')

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_detail', { p_slug: 'speaksix' })
    expect(result.data).toMatchObject({
      program: { id: 'prog-1', agreement_sha256: SHA, terms_version: 1 },
      membership: null,
      accept_name: 'Ana Creator',
    })
  })

  it('joins with the slug, the version and the hash the creator was shown', async () => {
    const { gateway, rpc } = clientAnswering(ok({ membership }))
    const result = await gateway.joinProgram!({
      slug: 'speaksix',
      termsVersion: 3,
      agreementSha256: SHA,
    })

    expect(rpc).toHaveBeenCalledExactlyOnceWith('partner_program_join', {
      p_input: { slug: 'speaksix', terms_version: 3, agreement_sha256: SHA },
    })
    expect(result.data).toMatchObject({ status: 'active', link: { working: true } })
  })

  it('accepts new terms and leaves by the program’s id', async () => {
    const terms = clientAnswering(ok({ membership }))
    await terms.gateway.acceptProgramTerms!({
      programId: 'prog-1',
      termsVersion: 2,
      agreementSha256: SHA,
    })
    expect(terms.rpc).toHaveBeenCalledExactlyOnceWith('partner_program_accept_terms', {
      p_input: { program_id: 'prog-1', terms_version: 2, agreement_sha256: SHA },
    })

    const leave = clientAnswering(ok({ membership: { ...membership, status: 'left' } }))
    const result = await leave.gateway.leaveProgram!('prog-1')
    expect(leave.rpc).toHaveBeenCalledExactlyOnceWith('partner_program_leave', {
      p_input: { program_id: 'prog-1' },
    })
    expect(result.data?.status).toBe('left')
  })

  it.each([
    [{ code: 'P0002', details: 'program_not_found', status: 400 }, 'program_not_found'],
    [{ code: '22023', details: 'program_not_open', status: 400 }, 'program_not_open'],
    [{ code: '40001', details: 'terms_changed', status: 400 }, 'terms_changed'],
    [{ code: '22023', details: 'already_member', status: 400 }, 'already_member'],
    [{ code: '22023', details: 'membership_closed', status: 400 }, 'membership_closed'],
    [{ code: '22023', details: 'tracking_not_enabled', status: 400 }, 'tracking_not_enabled'],
    [{ code: '22023', details: 'not_a_member', status: 400 }, 'not_a_member'],
    [{ code: '22023', details: 'invalid_accept_name', status: 400 }, 'name_missing'],
    [{ code: '22023', details: 'invalid_terms_version', status: 400 }, 'invalid_request'],
    [{ code: '42501', status: 403 }, 'not_authorized'],
    [{ code: 'PGRST301', status: 401 }, 'not_authenticated'],
    [{ code: 'PGRST202', status: 404 }, 'contract_unavailable'],
    [{ code: '57014', status: 503 }, 'temporarily_unavailable'],
    [{ code: 'XX000', status: 400 }, 'unknown'],
  ] as const)('turns the failure %o into %s', async (error, code) => {
    const { gateway } = clientAnswering({ data: null, error, status: error.status })
    const result = await gateway.joinProgram!({
      slug: 'speaksix',
      termsVersion: 1,
      agreementSha256: SHA,
    })

    expect(result.data).toBeNull()
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe(code)
    // The sentence is ours; whatever the database wrote is never passed on.
    expect(result.error?.message).not.toMatch(/_|SQL|permission denied/i)
  })

  it('does not pass on the database’s own message', async () => {
    const { gateway } = clientAnswering({
      data: null,
      error: {
        code: '22023',
        message: 'program is not open for joining',
        details: 'program_not_open',
      },
      status: 400,
    })
    const result = await gateway.getProgram!('speaksix')
    expect(result.error).toEqual({
      code: 'program_not_open',
      message: 'This program is not taking new creators right now.',
      retryable: false,
    })
  })

  it('refuses an answer it cannot read rather than drawing from it', async () => {
    for (const data of [null, [], { programs: 'none' }, { memberships: [] }]) {
      const { gateway } = clientAnswering(ok(data))
      expect((await gateway.getMarketplace!()).error?.code).toBe('invalid_response')
    }
    const unreadable = clientAnswering(ok({ program: { ...detail, agreement: null } }))
    expect((await unreadable.gateway.getProgram!('speaksix')).error?.code).toBe('invalid_response')
    const noMembership = clientAnswering(ok({ ok: true }))
    expect((await noMembership.gateway.leaveProgram!('prog-1')).error?.code).toBe(
      'invalid_response',
    )
  })

  it('answers a network failure as something to try again', async () => {
    const { gateway } = clientAnswering(() => Promise.reject(new TypeError('Failed to fetch')))
    const result = await gateway.getMarketplace!()
    expect(result.error).toMatchObject({ code: 'temporarily_unavailable', retryable: true })
  })

  it('says it is not configured, and calls nothing, without a client', async () => {
    const gateway = createPartnerDataGateway(null)
    const results = await Promise.all([
      gateway.getMarketplace!(),
      gateway.getProgram!('speaksix'),
      gateway.joinProgram!({ slug: 'speaksix', termsVersion: 1, agreementSha256: SHA }),
      gateway.acceptProgramTerms!({ programId: 'p', termsVersion: 1, agreementSha256: SHA }),
      gateway.leaveProgram!('p'),
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
