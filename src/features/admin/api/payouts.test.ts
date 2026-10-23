import { describe, it, expect, vi } from 'vitest'
import { mapPayout, mapPayoutWorkspace, mapPayoutStatement, mapPayoutActionResult } from './payouts'
import { payoutFixture, workspaceFixture, statementFixture, fixtureId } from '../payouts/fixtures'
import { createAdminGateway } from './gateway'
describe('payout contracts', () => {
  it('accepts direct and RPC-wrapped results without carrying secret fields', () => {
    expect(mapPayoutWorkspace([{ get_admin_payout_workspace: workspaceFixture() }])).toEqual(
      workspaceFixture(),
    )
    expect(mapPayoutStatement({ get_admin_payout_statement: statementFixture() })).toEqual(
      statementFixture(),
    )
    expect(
      mapPayout({ ...payoutFixture(), provider_reference: 'must-not-survive' }),
    ).not.toHaveProperty('provider_reference')
  })
  it.each([
    { final_payout_minor: 1 },
    { earnings_minor: '9007199254740992' },
    { status: 'invented' },
    { updated_at: 'yesterday' },
    { external_transfer_enabled: true },
    { approval_blockers: ['unknown'] },
    { currency: 'usd' },
    { id: 'not-a-uuid' },
    { minimum_minor: undefined },
  ])('rejects unsafe or incomplete statement %j', (patch) =>
    expect(() => mapPayout({ ...payoutFixture(), ...patch })).toThrow(),
  )
  it('handles negative carry-out without losing the signed balance', () => {
    expect(
      mapPayout({
        ...payoutFixture(),
        adjustments_minor: -500,
        carry_out_minor: -500,
        final_payout_minor: 0,
      }).carry_out_minor,
    ).toBe(-500)
  })
  it('rejects cross-period, oversized and inconsistent pages', () => {
    expect(() =>
      mapPayoutWorkspace({ ...workspaceFixture(), selected_period_id: fixtureId }),
    ).toThrow()
    expect(() => mapPayoutWorkspace({ ...workspaceFixture(), total: 0 })).toThrow()
    expect(() =>
      mapPayoutWorkspace({ ...workspaceFixture(), items: Array(101).fill(payoutFixture()) }),
    ).toThrow()
    expect(() => mapPayoutStatement({ ...statementFixture(), ledger: [] })).toThrow()
    expect(() => mapPayoutStatement({ ...statementFixture(), ledger_truncated: true })).toThrow()
    expect(() => mapPayout({ ...payoutFixture(), status: 'paid' })).toThrow()
    expect(() => mapPayout({ ...payoutFixture(), status: 'approved' })).toThrow()
    expect(() => mapPayout({ ...payoutFixture(), status: 'on_hold' })).toThrow()
  })
  it('does not permit a transfer receipt', () =>
    expect(() =>
      mapPayoutActionResult({
        request_id: fixtureId,
        id: fixtureId,
        action: 'approve',
        external_transfer: true,
      }),
    ).toThrow())
  it('maps the exact RPC filters and idempotent action input', async () => {
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === 'get_admin_payout_workspace'
          ? workspaceFixture()
          : name === 'get_admin_payout_statement'
            ? statementFixture()
            : { request_id: fixtureId, id: fixtureId, action: 'hold', external_transfer: false },
      error: null,
    }))
    const gateway = createAdminGateway({ rpc })
    expect(
      (
        await gateway.getPayoutWorkspace?.({
          query: ' Example ',
          status: 'review',
          periodId: fixtureId,
          offset: 25,
        })
      )?.data?.total,
    ).toBe(1)
    expect(rpc).toHaveBeenLastCalledWith('get_admin_payout_workspace', {
      p_query: 'Example',
      p_status: 'review',
      p_period_id: fixtureId,
      p_offset: 25,
      p_limit: 25,
    })
    await gateway.getPayoutStatement?.(fixtureId)
    expect(rpc).toHaveBeenLastCalledWith('get_admin_payout_statement', { p_payout_id: fixtureId })
    const input = {
      request_id: fixtureId,
      action: 'hold' as const,
      reason: 'Investigate first',
      id: fixtureId,
      expected_updated_at: '2026-09-07T12:00:00Z',
    }
    await gateway.performPayoutAction?.(input)
    expect(rpc).toHaveBeenLastCalledWith('perform_admin_payout_action', { p_input: input })
  })
  it('reports unconfigured and invalid response, never fake zero', async () => {
    expect((await createAdminGateway(null).getPayoutWorkspace?.({}))?.data).toBeNull()
    const result = await createAdminGateway({
      rpc: async () => ({ data: {}, error: null }),
    }).getPayoutWorkspace?.({})
    expect(result?.error).toBeTruthy()
    expect(result?.data).toBeNull()
  })
})

it('accepts the canonical validation hold blocker independently of refund eligibility', () => {
  expect(
    mapPayout({ ...payoutFixture(), approval_blockers: ['validation_window_pending'] })
      .approval_blockers,
  ).toEqual(['validation_window_pending'])
})
