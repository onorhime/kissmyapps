import { describe, expect, it, vi } from 'vitest'
import { ADMIN_RPCS, createAdminGateway } from './gateway'
import {
  mapAdminProgramReview,
  mapAdminProgramReviews,
  mapAdminProgramStatusChange,
  programLogoUrl,
} from './programs'
import type { AdminBackendResponse, AdminSupabaseClient } from './types'
import {
  fixedProgramRow,
  programRow,
  programWorkspaceId,
  reviewsResponse,
} from '../programs/fixtures'

const storage = 'https://project.supabase.co'

function gatewayWith(
  implementation: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => Promise<AdminBackendResponse>,
) {
  const rpc = vi.fn(implementation)
  const client = { rpc } satisfies AdminSupabaseClient
  return { rpc, gateway: createAdminGateway(client, storage) }
}

const ok = (data: unknown): AdminBackendResponse => ({ data, error: null, status: 200 })
const refused = (code: string, details?: string, status = 400): AdminBackendResponse => ({
  data: null,
  error: { code, message: 'refused', details },
  status,
})

describe('admin program review gateway', () => {
  it('calls the three contract functions by name', () => {
    expect(ADMIN_RPCS).toMatchObject({
      programReviews: 'list_admin_program_reviews',
      reviewProgram: 'review_admin_program',
      setProgramStatus: 'set_admin_program_status',
    })
    expect(Object.isFrozen(ADMIN_RPCS)).toBe(true)
  })

  it('stays unconfigured without a backend', async () => {
    const gateway = createAdminGateway(null)
    await expect(gateway.getProgramReviews?.()).resolves.toMatchObject({
      data: null,
      status: 'unconfigured',
    })
    await expect(
      gateway.reviewProgram?.({ programId: 'p', decision: 'approve' }),
    ).resolves.toMatchObject({ data: null, status: 'unconfigured' })
    await expect(
      gateway.setProgramStatus?.({ programId: 'p', status: 'paused' }),
    ).resolves.toMatchObject({ data: null, status: 'unconfigured' })
  })

  it('reads the queue first and the recently reviewed after it', async () => {
    const { gateway, rpc } = gatewayWith(async () =>
      ok(reviewsResponse([programRow(), fixedProgramRow()])),
    )
    const result = await gateway.getProgramReviews!()
    expect(rpc).toHaveBeenCalledWith('list_admin_program_reviews', undefined)
    expect(result.status).toBe('ready')
    expect(result.data!.waiting.map((program) => program.name)).toEqual(['SpeakSix', 'Ledgerly'])
    expect(result.data!.reviewed.map((program) => [program.name, program.status])).toEqual([
      ['HabitLoop', 'live'],
      ['MealMap', 'paused'],
      ['TrailNotes', 'paused'],
      ['PenPal', 'changes_requested'],
    ])
    expect(result.data!.waiting[0]).toMatchObject({
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
      status: 'in_review',
      category: 'education',
      tagline: 'Speak English with confidence in six weeks.',
      logoUrl: `${storage}/storage/v1/object/public/program-logos/${programWorkspaceId}/logo.png`,
      landingUrl: 'https://speaksix.com/start',
      commissionType: 'percent',
      commissionRateBps: 3000,
      commissionFixedMinor: null,
      currency: 'USD',
      commissionDuration: 'months',
      commissionMonths: 12,
      marketplaceListed: true,
      workspaceId: programWorkspaceId,
      workspaceName: 'SpeakSix',
      brandName: 'SpeakSix Ltd',
      stripeAccountId: 'acct_1QK7dLSpeakSix01',
      stripeCountry: 'GB',
      submittedAt: '2026-11-14T08:00:00Z',
    })
    expect(result.data!.waiting[0].agreement).toMatchObject({
      title: 'SpeakSix Affiliate Agreement',
      brandName: 'SpeakSix Ltd',
      summary: [
        { label: 'Commission', value: '30% of every payment for 12 months' },
        { label: 'Attribution window', value: '30 days' },
        { label: 'Hold before payout', value: '30 days' },
        { label: 'Minimum payout', value: '$20.00' },
      ],
      extraTerms: null,
    })
    expect(result.data!.waiting[0].agreement!.sections[0]).toEqual({
      heading: '1. Who this agreement is between',
      paragraphs: [expect.stringContaining('SpeakSix Ltd'), expect.stringContaining('signature')],
    })
    expect(result.data!.reviewed[1].pauseReason).toBe('admin')
  })

  it('reads an empty list as an empty queue, not as a failure', async () => {
    const { gateway } = gatewayWith(async () => ok({ programs: [] }))
    await expect(gateway.getProgramReviews!()).resolves.toEqual({
      data: { waiting: [], reviewed: [] },
      status: 'ready',
      error: null,
    })
  })

  it('keeps a program whose optional details are missing or malformed', () => {
    const program = mapAdminProgramReview(
      {
        id: 'p-1',
        status: 'in_review',
        name: null,
        slug: 'bare',
        commission_rate_bps: '3000',
        marketplace_listed: 'yes',
        logo_path: '../../etc/passwd',
        stripe_country: 'gb',
        agreement: 'not a document',
      },
      storage,
    )
    expect(program).toMatchObject({
      id: 'p-1',
      name: 'bare',
      commissionRateBps: null,
      marketplaceListed: null,
      logoUrl: null,
      stripeCountry: 'GB',
      stripeAccountId: null,
      agreement: null,
      currency: 'USD',
    })
  })

  it('refuses a list it cannot trust', async () => {
    for (const data of [null, [], { programs: 'none' }, { programs: [{ id: 'p-1' }] }]) {
      const { gateway } = gatewayWith(async () => ok(data))
      await expect(gateway.getProgramReviews!()).resolves.toMatchObject({
        data: null,
        status: 'error',
        error: { code: 'invalid_response' },
      })
    }
    expect(() => mapAdminProgramReviews({ programs: [{ id: '', status: 'live' }] })).toThrow()
  })

  it('builds logo addresses only from a workspace path on a real storage origin', () => {
    const path = `${programWorkspaceId}/logo.webp`
    expect(programLogoUrl(path, 'https://project.supabase.co/')).toBe(
      `https://project.supabase.co/storage/v1/object/public/program-logos/${path}`,
    )
    expect(programLogoUrl(path, null)).toBeNull()
    expect(programLogoUrl(path, 'not a url')).toBeNull()
    expect(programLogoUrl(path, 'http://evil.example')).toBeNull()
    expect(programLogoUrl(null, storage)).toBeNull()
    expect(programLogoUrl('https://evil.example/x.png', storage)).toBeNull()
    expect(programLogoUrl(`${programWorkspaceId}/a/../../b.png`, storage)).toBeNull()
    expect(programLogoUrl(`${programWorkspaceId}/x.png?download=1`, storage)).toBeNull()
  })

  it('approves with the contract input and confirms the program is live', async () => {
    const { gateway, rpc } = gatewayWith(async () => ok({ program_id: 'p-1', status: 'live' }))
    await expect(
      gateway.reviewProgram!({ programId: ' p-1 ', decision: 'approve' }),
    ).resolves.toEqual({ data: { programId: 'p-1', status: 'live' }, status: 'ready', error: null })
    expect(rpc).toHaveBeenCalledWith('review_admin_program', {
      p_input: { program_id: 'p-1', decision: 'approve', note: null },
    })
  })

  it('requests changes with the trimmed note', async () => {
    const { gateway, rpc } = gatewayWith(async () =>
      ok([{ program_id: 'p-1', status: 'changes_requested' }]),
    )
    await expect(
      gateway.reviewProgram!({
        programId: 'p-1',
        decision: 'request_changes',
        note: '  The landing page returns a 404.  ',
      }),
    ).resolves.toMatchObject({ data: { status: 'changes_requested' }, status: 'ready' })
    expect(rpc).toHaveBeenCalledWith('review_admin_program', {
      p_input: {
        program_id: 'p-1',
        decision: 'request_changes',
        note: 'The landing page returns a 404.',
      },
    })
  })

  it('does not report a review it cannot confirm', async () => {
    for (const data of [
      null,
      { program_id: 'someone-else', status: 'live' },
      { program_id: 'p-1', status: 'changes_requested' },
      { program_id: 'p-1' },
    ]) {
      const { gateway } = gatewayWith(async () => ok(data))
      await expect(
        gateway.reviewProgram!({ programId: 'p-1', decision: 'approve' }),
      ).resolves.toMatchObject({ data: null, error: { code: 'invalid_response' } })
    }
  })

  it('pauses and lifts a pause with the contract input', async () => {
    const { gateway, rpc } = gatewayWith(async (_name, args) =>
      ok({
        program_id: 'p-1',
        status: (args!.p_input as { status: string }).status,
      }),
    )
    await expect(
      gateway.setProgramStatus!({ programId: 'p-1', status: 'paused', note: ' Misleading ads. ' }),
    ).resolves.toMatchObject({ data: { programId: 'p-1', status: 'paused' }, status: 'ready' })
    expect(rpc).toHaveBeenLastCalledWith('set_admin_program_status', {
      p_input: { program_id: 'p-1', status: 'paused', note: 'Misleading ads.' },
    })
    await expect(
      gateway.setProgramStatus!({ programId: 'p-1', status: 'live' }),
    ).resolves.toMatchObject({ data: { programId: 'p-1', status: 'live' }, status: 'ready' })
    expect(rpc).toHaveBeenLastCalledWith('set_admin_program_status', {
      p_input: { program_id: 'p-1', status: 'live', note: null },
    })
  })

  it('accepts a status change that answers without a body, but not one for another program', () => {
    expect(mapAdminProgramStatusChange(null, 'p-1', 'paused')).toEqual({
      programId: 'p-1',
      status: 'paused',
    })
    expect(mapAdminProgramStatusChange({ status: 'live' }, 'p-1', 'live')).toEqual({
      programId: 'p-1',
      status: 'live',
    })
    expect(() =>
      mapAdminProgramStatusChange({ program_id: 'p-2', status: 'paused' }, 'p-1', 'paused'),
    ).toThrow()
  })

  it('maps refusals to the admin result conventions', async () => {
    const cases: [AdminBackendResponse, string, string][] = [
      [refused('42501', undefined, 403), 'unauthorized', 'not_authorized'],
      [refused('28000', undefined, 401), 'unauthorized', 'not_authenticated'],
      // A detail never hides an access failure.
      [refused('42501', 'stripe_not_connected', 403), 'unauthorized', 'not_authorized'],
      [refused('22023', 'stripe_not_connected'), 'error', 'invalid_state'],
      [refused('P0001', 'stripe_not_connected'), 'error', 'invalid_state'],
      [refused('22023', 'status_not_allowed'), 'error', 'invalid_state'],
      [refused('40001', 'program_changed', 409), 'error', 'conflict'],
      [refused('22023', 'invalid_note'), 'error', 'invalid_input'],
      [refused('22023'), 'error', 'invalid_input'],
      [refused('P0002', undefined, 404), 'error', 'invalid_reference'],
      [refused('55000'), 'error', 'invalid_state'],
      [refused('PGRST202', undefined, 404), 'error', 'contract_unavailable'],
      [refused('XX000', undefined, 500), 'error', 'temporarily_unavailable'],
    ]
    for (const [response, status, code] of cases) {
      const { gateway } = gatewayWith(async () => response)
      for (const outcome of [
        await gateway.getProgramReviews!(),
        await gateway.reviewProgram!({ programId: 'p-1', decision: 'approve' }),
        await gateway.setProgramStatus!({ programId: 'p-1', status: 'live' }),
      ]) {
        expect(outcome).toMatchObject({ data: null, status, error: { code } })
      }
    }
    const { gateway } = gatewayWith(async () => refused('22023', 'stripe_not_connected'))
    const outcome = await gateway.reviewProgram!({ programId: 'p-1', decision: 'approve' })
    expect(outcome.error?.message).toMatch(/no longer has Stripe connected/)
  })

  it('treats a dropped connection as temporary', async () => {
    const { gateway } = gatewayWith(async () => {
      throw new Error('network')
    })
    await expect(
      gateway.reviewProgram!({ programId: 'p-1', decision: 'approve' }),
    ).resolves.toMatchObject({
      data: null,
      error: { code: 'temporarily_unavailable', retryable: true },
    })
  })
})
