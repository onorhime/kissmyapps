import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, it, expect, vi } from 'vitest'
import type { AdminGateway, AdminRole } from '../api/types'
import type { PayoutActionInput, PayoutWorkspace } from '../api/payouts'
import { PayoutsPage } from './PayoutsPage'
import { workspaceFixture, statementFixture, fixtureId } from './fixtures'
const ready = (data: PayoutWorkspace) => ({ status: 'ready' as const, data, error: null })
function setup(role: AdminRole = 'owner', get = vi.fn(async () => ready(workspaceFixture()))) {
  const action = vi.fn(async (input: PayoutActionInput) => ({
    status: 'ready' as const,
    data: {
      request_id: input.request_id,
      id: input.id ?? fixtureId,
      action: input.action,
      external_transfer: false as const,
    },
    error: null,
  }))
  const detail = vi.fn(async () => ({
    status: 'ready' as const,
    data: statementFixture(),
    error: null,
  }))
  const gateway = {
    getPayoutWorkspace: get,
    getPayoutStatement: detail,
    performPayoutAction: action,
  } as unknown as AdminGateway
  const rendered = render(
    <div className="admin-portal">
      <PayoutsPage role={role} gateway={gateway} />
    </div>,
  )
  return { get, action, detail, gateway, ...rendered }
}
describe('Admin Payouts', () => {
  it('shows real blockers with approval disabled, and statement detail restores focus', async () => {
    setup()
    const user = userEvent.setup()
    const open = await screen.findByRole('button', { name: 'Review statement' })
    expect(screen.getByRole('button', { name: 'Approve statement' })).toBeDisabled()
    expect(screen.getByText(/verified payment destination with/)).toBeVisible()
    expect(screen.getByText(/Approved is not paid/)).toBeVisible()
    await user.click(open)
    const dialog = screen.getByRole('dialog')
    expect(
      await within(dialog).findByText('Synthetic fixture, not a production earning', {
        exact: false,
      }),
    ).toBeVisible()
    await user.keyboard('{Escape}')
    expect(open).toHaveFocus()
  })
  it.each(['operations', 'analyst'] as const)('keeps %s read-only', async (role) => {
    const { action } = setup(role)
    await screen.findByText('Example partner')
    expect(screen.queryByRole('button', { name: 'Create period' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Place on hold' })).not.toBeInTheDocument()
    expect(action).not.toHaveBeenCalled()
  })
  it('does not fetch payout data for Support', () => {
    const { get } = setup('support')
    expect(screen.getByText('Payout access restricted')).toBeVisible()
    expect(get).not.toHaveBeenCalled()
  })
  it('distinguishes unavailable data from an empty ledger', async () => {
    setup(
      'owner',
      vi.fn(async () => {
        throw Error('Temporary failure')
      }),
    )
    expect(await screen.findByText('Payout records unavailable')).toBeVisible()
    expect(screen.queryByText('No matching statements')).not.toBeInTheDocument()
  })
  it('has a truthful no-period state with no manufactured balances', async () => {
    setup(
      'owner',
      vi.fn(async () =>
        ready({
          ...workspaceFixture(),
          periods: [],
          selected_period_id: null,
          items: [],
          total: 0,
        }),
      ),
    )
    expect(await screen.findByText('No payout periods yet')).toBeVisible()
    expect(screen.queryByText('$25.00')).not.toBeInTheDocument()
  })
  it('requires an audit reason, preserves request identity after an uncertain result, and refreshes without clearing the page', async () => {
    const { action, get } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Place on hold' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Confirm place on hold' })
    expect(confirm).toBeDisabled()
    await user.type(
      within(dialog).getByLabelText('Audit reason'),
      'Investigate missing reconciliation',
    )
    action.mockRejectedValueOnce(Error('Connection interrupted'))
    await user.click(confirm)
    expect(await within(dialog).findByText('Connection interrupted')).toBeVisible()
    expect(within(dialog).getByLabelText('Audit reason')).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Retry same request' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(action.mock.calls[0]![0]).toEqual(action.mock.calls[1]![0])
    expect(action.mock.calls[0]![0]).not.toHaveProperty('amount_minor')
    expect(await screen.findByText('Place on hold completed. No money was sent.')).toBeVisible()
    expect(screen.getByText('Example partner')).toBeVisible()
    expect(get).toHaveBeenCalledTimes(2)
  })
  it('blocks duplicate submissions and dismissal while a save is pending', async () => {
    const { action } = setup()
    const user = userEvent.setup()
    let finish: () => void = () => {}
    action.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              status: 'ready',
              data: {
                request_id: input.request_id,
                id: input.id!,
                action: input.action,
                external_transfer: false,
              },
              error: null,
            })
        }),
    )
    await user.click(await screen.findByRole('button', { name: 'Place on hold' }))
    await user.type(screen.getByLabelText('Audit reason'), 'Review this statement')
    await user.dblClick(screen.getByRole('button', { name: 'Confirm place on hold' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('creates explicit UTC periods with the end computed at 14 days', async () => {
    const { action } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Create period' }))
    const start = screen.getByLabelText('Period start'),
      review = screen.getByLabelText('Review starts (UTC)'),
      due = screen.getByLabelText('Payout due (UTC)')
    // Native date/time controls are set through their real input events.
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(start, { target: { value: '2026-09-01' } })
    fireEvent.change(review, { target: { value: '2026-09-15T12:00' } })
    fireEvent.change(due, { target: { value: '2026-09-16T12:00' } })
    await user.type(screen.getByLabelText('Audit reason'), 'September payout schedule')
    await user.click(screen.getByRole('button', { name: 'Confirm create period' }))
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1))
    expect(action.mock.calls[0]![0]).toMatchObject({
      starts_at: '2026-09-01T00:00:00.000Z',
      ends_at: '2026-09-15T00:00:00.000Z',
      review_starts_at: '2026-09-15T12:00:00.000Z',
    })
  })
  it('keeps rows mounted while refreshing', async () => {
    const { get } = setup()
    await screen.findByText('Example partner')
    get.mockImplementationOnce(() => new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Refreshing payout records…')).toBeVisible()
    expect(screen.getByText('Example partner')).toBeVisible()
  })
  it('has no automated accessibility violations in the workspace', async () => {
    const { container } = setup()
    await screen.findByText('Example partner')
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
