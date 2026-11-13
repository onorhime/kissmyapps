import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AdminProduct } from './api'
import { AdminOverview } from './AdminOverview'
import { programProductsOf } from './products/programProducts.fixture'

function product(id: string, status: AdminProduct['status']): AdminProduct {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    status,
    trackingMode: 'commercial',
    trackingOnlyApprovedAt: null,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
  }
}

const customDeal = product('deal', 'draft')
const programOne = product('one', 'active')
const programTwo = product('two', 'active')

describe('Admin overview', () => {
  it('keeps the setup prompts as they are when no product belongs to a program', () => {
    render(<AdminOverview products={[customDeal]} onOpenProducts={vi.fn()} />)

    expect(
      screen.getByText(
        'Create the product foundation now. Funnels and attribution can be connected later.',
      ),
    ).toBeVisible()
    expect(screen.getByText('All product records')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Your product catalog is underway' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Connect the launch journey' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Manage products' })).toBeVisible()
    expect(screen.queryByText(/program/i)).toBeNull()
  })

  it('shows no setup prompt when every product belongs to a program', async () => {
    const user = userEvent.setup()
    const onOpenPrograms = vi.fn()
    render(
      <AdminOverview
        products={[programOne, programTwo]}
        programProducts={programProductsOf(programOne.id, programTwo.id)}
        onOpenProducts={vi.fn()}
        onOpenPrograms={onOpenPrograms}
      />,
    )

    expect(screen.getByText('2 from programs')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Nothing to set up here' })).toBeVisible()
    expect(screen.getByText(/All 2 products here belong to programs\./)).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Connect the launch journey' })).toBeNull()
    expect(
      screen.queryByText(/Add a funnel|Configure partner terms|Validate attribution/),
    ).toBeNull()
    expect(screen.queryByText(/Create the product foundation/)).toBeNull()
    expect(
      screen.queryByRole('button', { name: /Manage products|Create draft product/ }),
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open Programs' }))
    expect(onOpenPrograms).toHaveBeenCalledOnce()
  })

  it('says the same without a way into Programs for a role that cannot review them', () => {
    render(
      <AdminOverview
        products={[programOne]}
        programProducts={programProductsOf(programOne.id)}
        onOpenProducts={vi.fn()}
      />,
    )

    expect(screen.getByText(/The product here belongs to a program\./)).toBeVisible()
    expect(screen.queryByText(/you review it in Programs/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Programs' })).toBeNull()
  })

  it('keeps the prompts for the custom deals that sit next to programs', () => {
    render(
      <AdminOverview
        products={[customDeal, programOne]}
        programProducts={programProductsOf(programOne.id)}
        onOpenProducts={vi.fn()}
        onOpenPrograms={vi.fn()}
      />,
    )

    expect(screen.getByText('1 from programs')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Connect the launch journey' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Manage products' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Nothing to set up here' })).toBeNull()
  })
})
