// Regression acceptance tests for the interaction audit fixes. Synthetic records only.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProductConfigurationPage } from '../../src/features/admin/configuration/ProductConfigurationPage'
import { auditGateway, configuration, owner, ready, unavailable } from './fixture'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mount(gateway = auditGateway()) {
  const user = userEvent.setup()
  render(
    <ProductConfigurationPage
      productId={configuration.product.id}
      context={owner}
      gateway={gateway}
      onBack={vi.fn()}
    />,
  )
  await screen.findByRole('heading', { name: configuration.product.name, level: 1 })
  await user.click(screen.getByRole('button', { name: 'Expand billing offers' }))
  return { user, gateway }
}

describe('2026-09-05 UI audit - preservation and feedback', () => {
  it('UI-01: saving billing preserves unrelated draft DOM and expanded sections', async () => {
    const { user, gateway } = await mount()
    const refresh = deferred<ReturnType<typeof ready<typeof configuration>>>()
    gateway.getProductConfiguration = vi.fn(() => refresh.promise)
    const originalInput = screen.getByRole('textbox', { name: 'Funnel name' })
    await user.type(originalInput, 'Unsaved work that must survive')
    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(await screen.findByText(/Refreshing configuration/)).toBeInTheDocument()
    expect(originalInput.isConnected).toBe(true)
    expect(originalInput).toHaveValue('Unsaved work that must survive')
    await act(async () => {
      refresh.resolve(ready(configuration))
    })
    expect(await screen.findByRole('textbox', { name: 'Funnel name' })).toBe(originalInput)
    expect(screen.getByRole('button', { name: 'Collapse billing offers' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('UI-02: review opens a focused modal and restores focus on cancellation', async () => {
    const { user } = await mount()
    const opener = screen.getByRole('button', { name: 'Review activation' })
    await user.click(opener)
    const confirmation = screen.getByRole('dialog', { name: /Review activation/ })
    expect(confirmation).toContainElement(document.activeElement as HTMLElement)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('UI-03: a successful write followed by a failed refresh retains the draft and offers a read-only retry', async () => {
    const { user, gateway } = await mount()
    gateway.getProductConfiguration = vi.fn(async () => unavailable())
    await user.type(screen.getByRole('textbox', { name: 'Funnel name' }), 'Unrelated unsaved draft')
    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(await screen.findByRole('button', { name: 'Retry refresh' })).toBeEnabled()
    expect(await screen.findByText('Audit monthly offer is now active.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Funnel name' })).toHaveValue(
      'Unrelated unsaved draft',
    )
    expect(screen.getByRole('button', { name: 'Review activation' })).toBeDisabled()
    const write = vi.spyOn(gateway, 'setBillingOfferStatus')
    gateway.getProductConfiguration = vi.fn(async () => ready(configuration))
    await user.click(screen.getByRole('button', { name: 'Retry refresh' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review activation' })).toBeEnabled(),
    )
    expect(write).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Funnel name' })).toHaveValue(
      'Unrelated unsaved draft',
    )
  })

  it('UI-04: conflicting sections and modal dismissal are visibly disabled during a write', async () => {
    const { user, gateway } = await mount()
    const save = deferred<ReturnType<typeof ready<(typeof configuration.billingOffers)[number]>>>()
    gateway.setBillingOfferStatus = vi.fn(() => save.promise)
    const create = vi.spyOn(gateway, 'createFunnel')
    await user.type(screen.getByRole('textbox', { name: 'Funnel name' }), 'Another draft')
    await user.type(screen.getByRole('textbox', { name: 'Funnel key' }), 'another-draft')
    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    const otherAction = screen.getByRole('button', { name: 'Create draft funnel', hidden: true })
    expect(otherAction).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(gateway.setBillingOfferStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => {
      save.resolve(ready(configuration.billingOffers[0]))
    })
    await waitFor(() =>
      expect(screen.queryByText('Loading production configuration')).not.toBeInTheDocument(),
    )
  })

  it('UI-05: invalid billing submission reveals and focuses the first invalid field', async () => {
    const { user } = await mount()
    const submit = screen.getByRole('button', { name: 'Create draft offer' })
    await user.click(submit)
    expect(screen.getByRole('textbox', { name: /Offer name/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Offer name/ })).toHaveFocus())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a separate create-offer draft when editing an existing offer is cancelled', async () => {
    const { user } = await mount()
    await user.type(screen.getByRole('textbox', { name: 'Offer name' }), 'New offer draft')
    await user.click(screen.getByRole('button', { name: 'Edit draft' }))
    expect(screen.getByRole('textbox', { name: 'Offer name' })).toHaveValue('Audit monthly offer')
    expect(screen.getByRole('textbox', { name: 'Offer name' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }))
    expect(screen.getByRole('textbox', { name: 'Offer name' })).toHaveValue('New offer draft')
  })

  it('clears private configuration and drafts when a refresh loses authorization', async () => {
    const { user, gateway } = await mount()
    gateway.getProductConfiguration = vi.fn(async () => ({
      status: 'unauthorized' as const,
      data: null,
      error: { code: 'not_authorized' as const, message: 'Access was removed.', retryable: false },
    }))
    await user.type(screen.getByRole('textbox', { name: 'Funnel name' }), 'Private draft')
    await user.click(screen.getByRole('button', { name: 'Review activation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm active' }))
    expect(await screen.findByText('Access was removed.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Funnel name' })).not.toBeInTheDocument()
  })
})
