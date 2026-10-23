import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type { AdminGateway, AdminProduct } from '../api'
import { mapAdminSubscriptionPage } from '../api/subscriptions'
import { SubscriptionsPage } from './SubscriptionsPage'
import { checkoutListPrice } from './presentation'
// Synthetic test data only. Not a production import.
import { subscriptionResponse } from './fixtures'

const product = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'BC Learn fixture',
} as AdminProduct
const ready = () => ({
  status: 'ready' as const,
  data: mapAdminSubscriptionPage(subscriptionResponse()),
  error: null,
})
function setup(get = vi.fn(async () => ready()), role: 'owner' | 'support' = 'owner') {
  const gateway = { getSubscriptions: get } as unknown as AdminGateway
  const view = render(
    <div className="admin-portal">
      <SubscriptionsPage gateway={gateway} role={role} products={[product]} />
    </div>,
  )
  return { get, ...view }
}
describe('Admin subscriptions', () => {
  it('shows normalized records and truthful free-checkout details; Escape restores focus', async () => {
    setup()
    const user = userEvent.setup()
    const open = await screen.findByRole('button', { name: 'View subscription sub_fixture_00001' })
    expect(screen.getByText('Zero-total initial checkout')).toBeVisible()
    await user.click(open)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Verified zero-total checkout')).toBeVisible()
    expect(within(dialog).getByText('USD 1.00')).toBeVisible()
    expect(within(dialog).getByText('profile')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: /cancel subscription|refund/i })).toBeNull()
    await user.keyboard('{Escape}')
    expect(open).toHaveFocus()
  })
  it('runs search and product/status filters without reloading the document', async () => {
    const { get } = setup()
    const user = userEvent.setup()
    await screen.findByText('sub_fixture_00001')
    await user.type(screen.getByLabelText('Search subscriptions'), 'Fixture Partner')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'Fixture Partner', offset: 0 }),
      ),
    )
    await user.selectOptions(screen.getByLabelText('Status'), 'cancelled')
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'cancelled', offset: 0 }),
      ),
    )
    await user.selectOptions(screen.getByLabelText('Product'), product.id)
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ productId: product.id })),
    )
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByLabelText('Search subscriptions')).toHaveValue('')
  })
  it('does not fetch for Support even on a direct route', () => {
    const { get } = setup(undefined, 'support')
    expect(get).not.toHaveBeenCalled()
    expect(screen.getByText('Subscription access restricted')).toBeVisible()
  })
  it('distinguishes an empty directory from a service failure and supports retry', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error', data: null, error: null })
      .mockResolvedValue({
        status: 'ready',
        error: null,
        data: {
          ...ready().data,
          total: 0,
          summary: { active: 0, trialing: 0, paymentAttention: 0, cancelled: 0 },
          items: [],
        },
      })
    setup(get)
    await screen.findByRole('alert')
    expect(screen.queryByText('No matching subscriptions')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh subscriptions' }))
    await screen.findByText('No matching subscriptions')
  })
  it('keeps content mounted during refresh, then removes outdated data if refresh fails', async () => {
    let resolve!: (v: unknown) => void
    const get = vi
      .fn()
      .mockResolvedValueOnce(ready())
      .mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
    setup(get)
    await screen.findByText('sub_fixture_00001')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh subscriptions' }))
    expect(screen.getByText('sub_fixture_00001')).toBeVisible()
    await act(async () => resolve({ status: 'unauthorized', data: null, error: null }))
    expect(screen.queryByText('sub_fixture_00001')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('password-authenticated')
  })
  it('labels a stale snapshot and unfinished Stripe processing', async () => {
    const result = ready()
    result.data.stripeWorkPending = true
    result.data.generatedAt = '2020-01-01T00:00:00Z'
    setup(vi.fn(async () => result))
    await screen.findByText(/Stripe events are still awaiting/)
    expect(screen.getByRole('alert')).toHaveTextContent('snapshot')
  })
  it('paginates on the server and resets the offset when filtering', async () => {
    const result = ready()
    result.data.total = 26
    result.data.summary.active = 26
    const { get } = setup(vi.fn(async () => result))
    await screen.findByText('sub_fixture_00001')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25, limit: 25 })),
    )
    await user.selectOptions(screen.getByLabelText('Status'), 'active')
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })),
    )
  })
  it('has no automated accessibility violations in the loaded directory and dialog', async () => {
    const { container } = setup()
    await screen.findByText('sub_fixture_00001')
    const options = { rules: { 'color-contrast': { enabled: false } } }
    expect((await axe.run(container, options)).violations).toEqual([])
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'View subscription sub_fixture_00001' }))
    expect((await axe.run(screen.getByRole('dialog'), options)).violations).toEqual([])
  })
  it('does not assume all currencies have two decimal minor units', () => {
    expect(checkoutListPrice(100, 'USD')).toBe('USD 1.00')
    expect(checkoutListPrice(100, 'JPY')).toBe('JPY 100 minor units')
    expect(checkoutListPrice(null, 'USD')).toBeNull()
  })
})
