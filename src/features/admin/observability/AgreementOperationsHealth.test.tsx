import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdminGateway } from '../api'
import { AgreementOperationsHealth } from './AgreementOperationsHealth'
import { mapAdminAgreementOperationsHealth } from '../api/observabilityMappers'

const row = {
  pending: 1,
  processing: 0,
  failed: 2,
  sent: 3,
  oldest_pending_at: null,
  cleanup_pending: 1,
  cleanup_processing: 0,
  cleanup_failed: 0,
  cleanup_done: 4,
}
const healthyResult = { status: 'ready', data: mapAdminAgreementOperationsHealth(row), error: null }
describe('agreement operations visibility', () => {
  it('validates every count rather than defaulting missing data to healthy zeroes', () => {
    expect(mapAdminAgreementOperationsHealth(row)).toMatchObject({ failed: 2, cleanupDone: 4 })
    expect(() => mapAdminAgreementOperationsHealth({ ...row, failed: -1 })).toThrow()
    expect(() => mapAdminAgreementOperationsHealth({ pending: 0 })).toThrow()
  })
  it('surfaces exhausted jobs and distinguishes provider acceptance from delivery', async () => {
    render(
      <AgreementOperationsHealth
        gateway={
          {
            getAgreementOperationsHealth: vi.fn(async () => healthyResult),
          } as unknown as AdminGateway
        }
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Some jobs need operator review')
    expect(screen.getByText(/Sent does not confirm inbox delivery/)).toBeVisible()
    expect(screen.getByText(/do not prove the scheduler is running/)).toBeVisible()
  })
  it('reports a loading failure and permits a successful retry', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(healthyResult)
    render(
      <AgreementOperationsHealth
        gateway={{ getAgreementOperationsHealth: load } as unknown as AdminGateway}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh agreement jobs' }))
    expect(
      await screen.findByText('Some jobs need operator review.', { exact: false }),
    ).toBeVisible()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
