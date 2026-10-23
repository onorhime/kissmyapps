// Partner pending and error preservation regression acceptance.
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { PartnerDataResult, PartnerLink, PartnerProduct } from '../../src/features/partner/api'
import { LiveLinksPage } from '../../src/features/partner/live/LiveLinksPage'
import { createLoadingPartnerLiveSnapshot } from '../../src/features/partner/live/loader'
import type { PartnerLiveWorkspaceValue } from '../../src/features/partner/live/types'

it('UI-07: partner cancellation is disabled while creating and failure preserves the visible draft', async () => {
  const user = userEvent.setup()
  const product: PartnerProduct = {
    id: 'audit-product',
    slug: 'audit-product',
    name: 'Audit product',
    status: 'active',
    trackingMode: 'tracking_only',
    agreementStatus: null,
    commercialModel: null,
    payoutCurrency: null,
    hasLiveFunnel: true,
    mainLinkId: 'audit-main-link',
    mainTrackingUrl: 'https://go.example.test/r/audit',
  }
  let resolve!: (result: PartnerDataResult<PartnerLink | null>) => void
  const createLink = vi.fn(
    () =>
      new Promise<PartnerDataResult<PartnerLink | null>>((done) => {
        resolve = done
      }),
  )
  const snapshot = createLoadingPartnerLiveSnapshot(product.id)
  const workspace = {
    snapshot: {
      ...snapshot,
      resources: {
        ...snapshot.resources,
        links: { status: 'empty', data: [], error: null },
        linkDirectory: {
          status: 'ready',
          error: null,
          data: {
            products: [product],
            campaigns: [],
            funnels: [
              {
                id: 'audit-funnel',
                productId: product.id,
                key: 'audit',
                kind: 'funnel',
                name: 'Audit funnel',
                available: true,
              },
            ],
            sources: [
              {
                id: 'audit-source',
                productId: null,
                key: 'audit',
                kind: 'source',
                name: 'Audit source',
                available: true,
              },
            ],
          },
        },
      },
    },
    mutation: { status: 'idle', operation: null, error: null },
    actions: { createLink, refresh: vi.fn() },
    isRefreshing: false,
  } as unknown as PartnerLiveWorkspaceValue
  const { rerender } = render(<LiveLinksPage product={product} workspace={workspace} />)
  await user.click(screen.getByRole('button', { name: 'Create tracked link' }))
  await user.type(screen.getByRole('textbox', { name: 'Link name' }), 'Audit link')
  await user.type(screen.getByRole('textbox', { name: /Link placement \(Sub 1/ }), 'profile')
  await user.click(screen.getByRole('button', { name: 'Create live link' }))
  expect(createLink).toHaveBeenCalledTimes(1)
  rerender(
    <LiveLinksPage
      product={product}
      workspace={{
        ...workspace,
        mutation: { status: 'pending', operation: 'create-link', error: null },
      }}
    />,
  )
  expect(screen.getByRole('textbox', { name: 'Link name' })).toBeDisabled()
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  expect(cancel).toBeDisabled()
  await user.click(cancel)
  const error = {
    code: 'temporarily_unavailable' as const,
    message: 'Synthetic creation failed.',
    retryable: true,
  }
  await act(async () => {
    resolve({ status: 'error', data: null, error })
  })
  rerender(
    <LiveLinksPage
      product={product}
      workspace={{ ...workspace, mutation: { status: 'failed', operation: 'create-link', error } }}
    />,
  )
  expect(screen.getAllByText(error.message).length).toBeGreaterThan(0)
  expect(screen.getByRole('textbox', { name: 'Link name' })).toHaveValue('Audit link')
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
})
