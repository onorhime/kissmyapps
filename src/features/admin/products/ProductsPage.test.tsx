import { render, screen, waitFor, within } from '@testing-library/react'
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

/** The product a program got when its first listing was approved. */
const programProduct: AdminProduct = {
  ...createdProduct,
  id: 'product-program',
  name: 'SpeakSix',
  slug: 'speaksix',
  status: 'active',
  programId: 'program-1',
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
    expect(
      await screen.findByText('Daily Planner was created as a draft. Open Setup to configure it.'),
    ).toBeVisible()
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

  it('says in one sentence that the form is only for a custom deal', () => {
    render(<ProductsPage context={ownerContext} products={[]} onCreate={vi.fn()} />)

    expect(
      screen.getByText('Merchants publish programs themselves, so this is only for a custom deal.'),
    ).toBeVisible()
  })

  it('marks a program product and opens program review instead of setup', async () => {
    const user = userEvent.setup()
    const handlers = { onConfigure: vi.fn(), onViewStats: vi.fn(), onOpenPrograms: vi.fn() }
    render(
      <ProductsPage
        context={ownerContext}
        products={[programProduct, createdProduct]}
        programProducts={new Set([programProduct.id])}
        onCreate={vi.fn()}
        {...handlers}
      />,
    )

    const program = screen.getByRole('row', { name: /SpeakSix/ })
    expect(within(program).getByText('Program')).toBeVisible()
    expect(within(program).queryByRole('button', { name: /set ?up/i })).toBeNull()
    await user.click(within(program).getByRole('button', { name: 'Open SpeakSix in Programs' }))
    expect(handlers.onOpenPrograms).toHaveBeenCalledOnce()
    expect(handlers.onConfigure).not.toHaveBeenCalled()
    await user.click(within(program).getByRole('button', { name: 'View stats for SpeakSix' }))
    expect(handlers.onViewStats).toHaveBeenCalledWith(programProduct.id)

    // The custom deal next to it is untouched: no mark, and Setup opens the wizard.
    const customDeal = screen.getByRole('row', { name: /Daily Planner/ })
    expect(within(customDeal).queryByText('Program')).toBeNull()
    expect(within(customDeal).queryByRole('button', { name: /Programs/ })).toBeNull()
    await user.click(within(customDeal).getByRole('button', { name: 'Set up Daily Planner' }))
    expect(handlers.onConfigure).toHaveBeenCalledWith(createdProduct.id)
  })

  it('offers a program product no setup to a role that cannot review programs', () => {
    render(
      <ProductsPage
        context={{ ...ownerContext, role: 'finance' }}
        products={[programProduct, createdProduct]}
        programProducts={new Set([programProduct.id])}
        onCreate={vi.fn()}
        onConfigure={vi.fn()}
        onViewStats={vi.fn()}
      />,
    )

    const program = screen.getByRole('row', { name: /SpeakSix/ })
    expect(within(program).getByText('Program')).toBeVisible()
    expect(within(program).getAllByRole('button')).toHaveLength(1)
    expect(within(program).getByRole('button', { name: 'View stats for SpeakSix' })).toBeVisible()
    expect(
      within(screen.getByRole('row', { name: /Daily Planner/ })).getByRole('button', {
        name: 'View setup for Daily Planner',
      }),
    ).toBeVisible()
  })

  it('treats every product as today when no product belongs to a program', async () => {
    const user = userEvent.setup()
    const onConfigure = vi.fn()
    render(
      <ProductsPage
        context={ownerContext}
        products={[{ ...programProduct, programId: null }, createdProduct]}
        onCreate={vi.fn()}
        onConfigure={onConfigure}
        onViewStats={vi.fn()}
        onOpenPrograms={vi.fn()}
      />,
    )

    expect(screen.queryByText('Program')).toBeNull()
    expect(screen.queryByRole('button', { name: /Programs/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Set up SpeakSix' }))
    expect(onConfigure).toHaveBeenCalledWith(programProduct.id)
    expect(screen.getByRole('button', { name: 'Set up Daily Planner' })).toBeVisible()
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
