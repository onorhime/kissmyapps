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
  bothProgramRow,
  eventsProgramRow,
  fixedProgramRow,
  programRow,
  programWorkspaceId,
  reviewsResponse,
  rewardRows,
  salesProgramRow,
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
      submittedAt: '2026-11-14T08:00:00.550058+00:00',
      reviewedAt: null,
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
    expect(result.data!.reviewed[1].reviewedAt).toBe('2026-11-10T10:00:00.300127+00:00')
    // The brand's own terms come back exactly as typed.
    expect(result.data!.waiting[1].agreement).toMatchObject({
      extraTerms: 'No discount codes in paid ads.',
    })
    expect(result.data!.waiting[1].agreement!.sections.at(-1)!.heading).toBe(
      '12. Additional terms from Ledgerly Inc',
    )
  })

  it('reads a program whose Stripe account was disconnected, and one too incomplete for an agreement', () => {
    const { reviewed } = mapAdminProgramReviews(
      reviewsResponse(
        [],
        [
          programRow({
            status: 'paused',
            pause_reason: 'stripe_disconnected',
            brand_name: null,
            stripe_account_id: null,
            stripe_country: null,
            reviewed_at: '2026-11-13T12:34:21.550058+00:00',
          }),
          programRow({
            id: 'a1b2c3d4-0000-4000-8000-000000000099',
            status: 'changes_requested',
            landing_url: null,
            agreement: null,
          }),
        ],
      ),
      storage,
    )
    expect(reviewed[0]).toMatchObject({
      status: 'paused',
      pauseReason: 'stripe_disconnected',
      brandName: null,
      stripeAccountId: null,
      stripeCountry: null,
    })
    expect(reviewed[1]).toMatchObject({ status: 'changes_requested', agreement: null })
  })

  it('keeps line breaks in the extra terms of an agreement', () => {
    const program = mapAdminProgramReview(
      programRow({
        agreement: { title: 'A', sections: [], summary: [], extra_terms: 'One.\n\nTwo.\n' },
      }),
    )
    expect(program.agreement!.extraTerms).toBe('One.\n\nTwo.\n')
    expect(
      mapAdminProgramReview(programRow({ agreement: { title: 'A', extra_terms: '  ' } })).agreement!
        .extraTerms,
    ).toBeNull()
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

  it('reads an answer from before programs could pay per event as a sales program', () => {
    const old = mapAdminProgramReview(programRow())
    expect(old).toMatchObject({ earnFrom: 'sales', rewards: [], rewardBudgetMinor: null })
    expect(mapAdminProgramReview(salesProgramRow())).toEqual(old)
    expect(
      mapAdminProgramReview(
        programRow({ earn_from: null, rewards: null, reward_budget_minor: null }),
      ),
    ).toEqual(old)
  })

  it('reads what an events program and a both program pay, and the monthly budget', () => {
    expect(mapAdminProgramReview(eventsProgramRow())).toMatchObject({
      name: 'Fluent',
      earnFrom: 'events',
      // The stored commission stays in the row, as the database sends it.
      commissionType: 'percent',
      rewards: [
        { key: 'signup_completed', label: 'Account created', amountMinor: 200 },
        { key: 'trial_started', label: 'Trial started', amountMinor: 500 },
      ],
      rewardBudgetMinor: 50000,
    })
    expect(mapAdminProgramReview(bothProgramRow())).toMatchObject({
      earnFrom: 'both',
      commissionType: 'percent',
      commissionRateBps: 2000,
      rewards: [{ key: 'signup_completed', label: 'Account created', amountMinor: 150 }],
      rewardBudgetMinor: 120000,
    })
  })

  it('keeps every reward of a listing, with the parts it cannot read as not set', () => {
    const program = mapAdminProgramReview(
      eventsProgramRow({
        rewards: [
          rewardRows[0],
          { key: 'trial_started', label: '   ', amount_minor: 0 },
          { key: 7, label: ' Subscribed ', amount_minor: '500', person_id: 'p-1' },
          {},
        ],
        reward_budget_minor: 0,
      }),
    )
    expect(program.rewards).toEqual([
      { key: 'signup_completed', label: 'Account created', amountMinor: 200 },
      { key: 'trial_started', label: null, amountMinor: null },
      { key: null, label: 'Subscribed', amountMinor: null },
      { key: null, label: null, amountMinor: null },
    ])
    expect(program.rewardBudgetMinor).toBeNull()
    // A draft that says events before any reward is listed.
    expect(mapAdminProgramReview(eventsProgramRow({ rewards: [] })).rewards).toEqual([])
  })

  it('refuses a row whose earn-from it does not know or whose rewards are not a list', () => {
    expect(() => mapAdminProgramReview(programRow({ earn_from: 'installs' }))).toThrow(
      'Invalid earn_from.',
    )
    expect(() => mapAdminProgramReview(programRow({ earn_from: ['events'] }))).toThrow()
    expect(() => mapAdminProgramReview(eventsProgramRow({ rewards: 'signup_completed' }))).toThrow(
      'Invalid rewards.',
    )
    expect(() =>
      mapAdminProgramReview(eventsProgramRow({ rewards: { 0: rewardRows[0] } })),
    ).toThrow()
    expect(() =>
      mapAdminProgramReview(eventsProgramRow({ rewards: ['signup_completed'] })),
    ).toThrow()
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
    ).resolves.toEqual({
      data: { programId: 'p-1', status: 'live', pauseReason: null },
      status: 'ready',
      error: null,
    })
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
    const { gateway, rpc } = gatewayWith(async (_name, args) => {
      const status = (args!.p_input as { status: string }).status
      return ok({
        program_id: 'p-1',
        status,
        pause_reason: status === 'paused' ? 'admin' : null,
      })
    })
    await expect(
      gateway.setProgramStatus!({ programId: 'p-1', status: 'paused', note: ' Misleading ads. ' }),
    ).resolves.toEqual({
      data: { programId: 'p-1', status: 'paused', pauseReason: 'admin' },
      status: 'ready',
      error: null,
    })
    expect(rpc).toHaveBeenLastCalledWith('set_admin_program_status', {
      p_input: { program_id: 'p-1', status: 'paused', note: 'Misleading ads.' },
    })
    await expect(
      gateway.setProgramStatus!({ programId: 'p-1', status: 'live' }),
    ).resolves.toMatchObject({
      data: { programId: 'p-1', status: 'live', pauseReason: null },
      status: 'ready',
    })
    expect(rpc).toHaveBeenLastCalledWith('set_admin_program_status', {
      p_input: { program_id: 'p-1', status: 'live', note: null },
    })
    // A pause may be sent without a reason.
    await gateway.setProgramStatus!({ programId: 'p-1', status: 'paused', note: '   ' })
    expect(rpc).toHaveBeenLastCalledWith('set_admin_program_status', {
      p_input: { program_id: 'p-1', status: 'paused', note: null },
    })
  })

  it('reports a lifted pause that left the program paused because Stripe is disconnected', async () => {
    const { gateway } = gatewayWith(async () =>
      ok({ program_id: 'p-1', status: 'paused', pause_reason: 'stripe_disconnected' }),
    )
    await expect(gateway.setProgramStatus!({ programId: 'p-1', status: 'live' })).resolves.toEqual({
      data: { programId: 'p-1', status: 'paused', pauseReason: 'stripe_disconnected' },
      status: 'ready',
      error: null,
    })
  })

  it('does not report a status change it cannot confirm', async () => {
    const cases: [unknown, 'paused' | 'live'][] = [
      [null, 'paused'],
      [{ status: 'paused', pause_reason: 'admin' }, 'paused'],
      [{ program_id: 'p-2', status: 'paused', pause_reason: 'admin' }, 'paused'],
      [{ program_id: 'p-1', status: 'live', pause_reason: null }, 'paused'],
      [{ program_id: 'p-1', status: 'archived', pause_reason: null }, 'live'],
      // A lifted pause cannot leave KissMyApps's own pause in place.
      [{ program_id: 'p-1', status: 'paused', pause_reason: 'admin' }, 'live'],
    ]
    for (const [data, requested] of cases) {
      expect(() => mapAdminProgramStatusChange(data, 'p-1', requested)).toThrow()
      const { gateway } = gatewayWith(async () => ok(data))
      await expect(
        gateway.setProgramStatus!({ programId: 'p-1', status: requested }),
      ).resolves.toMatchObject({ data: null, error: { code: 'invalid_response' } })
    }
  })

  it('maps refusals to the admin result conventions', async () => {
    const cases: [AdminBackendResponse, string, string][] = [
      // The admin gate: 42501 with no detail.
      [refused('42501', undefined, 403), 'unauthorized', 'not_authorized'],
      [refused('42501'), 'unauthorized', 'not_authorized'],
      [refused('28000', undefined, 401), 'unauthorized', 'not_authenticated'],
      // A detail never hides an access failure.
      [refused('42501', 'stripe_not_connected', 403), 'unauthorized', 'not_authorized'],
      [refused('22023', 'stripe_not_connected'), 'error', 'invalid_state'],
      [refused('22023', 'agreement_not_read'), 'error', 'invalid_state'],
      [refused('22023', 'status_not_allowed'), 'error', 'invalid_state'],
      [refused('P0002', 'program_not_found'), 'error', 'invalid_reference'],
      [refused('22023', 'invalid_note'), 'error', 'invalid_input'],
      [refused('22023', 'invalid_input'), 'error', 'invalid_input'],
      [refused('22023', 'invalid_decision'), 'error', 'invalid_input'],
      [refused('22023', 'invalid_program_id'), 'error', 'invalid_input'],
      [refused('22023', 'invalid_status'), 'error', 'invalid_input'],
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
  })

  it('gives each known refusal a short message of its own', async () => {
    const messages: [string, RegExp][] = [
      ['stripe_not_connected', /^Stripe is no longer connected for this workspace/],
      ['agreement_not_read', /changed after the merchant read it\. Request changes/],
      ['status_not_allowed', /has changed since the list was loaded/],
      ['program_not_found', /no longer available/],
      ['invalid_note', /^Write a note of 5 to 1000 characters\.$/],
      ['invalid_decision', /^That request was not accepted\. Nothing was changed\.$/],
    ]
    for (const [detail, message] of messages) {
      const { gateway } = gatewayWith(async () =>
        refused(detail === 'program_not_found' ? 'P0002' : '22023', detail),
      )
      const outcome = await gateway.reviewProgram!({ programId: 'p-1', decision: 'approve' })
      expect(outcome.error?.message).toMatch(message)
      expect(outcome.error?.message).not.toContain('—')
    }
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
