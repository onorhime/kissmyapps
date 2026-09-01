import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdminContext, AdminDataResult, AdminProduct, AdminProductCreate } from '../api'
import { ProductsPage } from './ProductsPage'

const ownerContext: AdminContext = {
  userId: 'admin-1',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const createdProduct: AdminProduct = {
  id: 'product-1',
  name: 'Daily Planner',
  slug: 'daily-planner',
  status: 'draft',
  trackingMode: 'commercial',
  trackingOnlyApprovedAt: null,
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
}

function readyCreation(product = createdProduct): AdminDataResult<AdminProduct | null> {
  return { data: product, status: 'ready', error: null }
}

describe('Admin Products page', () => {
  it('renders the funnel-independent empty state', () => {
    render(<ProductsPage context={ownerContext} products={[]} onCreate={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'No products have been created' })).toBeVisible()
    expect(screen.getByText(/A funnel is not required\.$/)).toBeVisible()
    expect(screen.getByText('Draft', { selector: 'strong' })).toBeVisible()
  })

  it('auto-generates a slug and submits only a draft product name and slug', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async (_input: AdminProductCreate) => readyCreation())
    render(<ProductsPage context={ownerContext} products={[]} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Product name'), 'Daily Planner')
    expect(screen.getByLabelText('Product slug')).toHaveValue('daily-planner')
    await user.click(screen.getByRole('button', { name: 'Create draft product' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    const input = onCreate.mock.calls[0]?.[0]
    expect(input).toEqual({ name: 'Daily Planner', slug: 'daily-planner' })
    expect(Object.keys(input ?? {})).toEqual(['name', 'slug'])
    expect(await screen.findByText('Daily Planner was created as a draft product.')).toBeVisible()
  })

  it('focuses the first invalid field and exposes the validation error', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<ProductsPage context={ownerContext} products={[]} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Product name'), 'Daily Planner')
    const slug = screen.getByLabelText('Product slug')
    await user.clear(slug)
    await user.type(slug, 'Bad slug')
    await user.click(screen.getByRole('button', { name: 'Create draft product' }))

    expect(
      await screen.findByText('Use lowercase letters, numbers, and single hyphens only.'),
    ).toBeVisible()
    await waitFor(() => expect(slug).toHaveFocus())
    expect(slug).toHaveAttribute('aria-invalid', 'true')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('disables product creation for read-only admin roles', () => {
    render(
      <ProductsPage
        context={{ ...ownerContext, role: 'analyst' }}
        products={[]}
        onCreate={vi.fn()}
      />,
    )

    expect(
      screen.getByText('Only Owner and Operations administrators can create products.'),
    ).toBeVisible()
    expect(screen.getByLabelText('Product name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create draft product' })).toBeDisabled()
  })

  it('shows a safe fallback when creation throws', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn(async () => {
      throw new Error('database credentials and policy internals')
    })
    render(<ProductsPage context={ownerContext} products={[]} onCreate={onCreate} />)

    await user.type(screen.getByLabelText('Product name'), 'Daily Planner')
    await user.click(screen.getByRole('button', { name: 'Create draft product' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Admin data is temporarily unavailable.',
    )
    expect(screen.queryByText(/database credentials/i)).not.toBeInTheDocument()
  })
})
