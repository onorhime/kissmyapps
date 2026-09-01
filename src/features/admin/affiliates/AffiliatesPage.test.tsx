import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'
import type {
  AdminAffiliateDirectoryPage,
  AdminAffiliateDirectoryRecord,
  AdminAffiliateDirectorySummary,
  AdminAffiliateStatusChange,
  AdminContext,
  AdminDataResult,
  AdminGateway,
} from '../api'
import { AffiliatesPage } from './AffiliatesPage'

const ownerContext: AdminContext = {
  userId: 'admin-owner',
  email: 'owner@example.test',
  fullName: 'Platform Owner',
  role: 'owner',
  active: true,
}

const affiliate: AdminAffiliateDirectoryRecord = {
  id: '10000000-0000-4000-8000-000000000001',
  publicName: 'North Star Media',
  legalName: 'North Star Media Limited',
  slug: 'north-star',
  status: 'active',
  entityType: 'company',
  countryCode: 'NG',
  reportingTimezone: 'Africa/Lagos',
  preferredCurrency: 'USD',
  websiteUrl: 'https://north-star.example.test',
  category: 'Creator',
  audienceDescription: 'Mobile app customers',
  audienceCountries: ['NG', 'GB'],
  channels: ['tiktok'],
  channelDetails: null,
  primaryUserId: '20000000-0000-4000-8000-000000000001',
  primaryUserRole: 'owner',
  primaryFullName: 'North Star Owner',
  primaryEmail: 'owner@north-star.example.test',
  registrationKind: 'public',
  registeredAt: '2026-08-31T10:00:00.000Z',
  emailConfirmationStatus: 'confirmed',
  emailConfirmedAt: '2026-08-31T10:05:00.000Z',
  activationStatus: 'active',
  membershipActive: true,
  activationPending: false,
  activatedAt: '2026-08-31T10:05:00.000Z',
  memberCount: 1,
  activeMemberCount: 1,
  termsVersion: '2026-08-31',
  termsUrl: 'https://kissmyapps.dev/terms',
  privacyVersion: '2026-08-31',
  privacyUrl: 'https://kissmyapps.dev/privacy',
  ageConfirmed: true,
  legalAcceptedAt: '2026-08-31T10:00:00.000Z',
  productCount: 2,
  agreementCount: 3,
  activeAgreementCount: 0,
  blockingAgreementCount: 0,
  blockingDocumentCount: 0,
  linkCount: 4,
  activeLinkCount: 2,
  unsettledPayoutCount: 0,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:05:00.000Z',
}

const summary: AdminAffiliateDirectorySummary = {
  totalCount: 1,
  draftCount: 0,
  invitedCount: 0,
  activeCount: 1,
  pausedCount: 0,
  terminatedCount: 0,
  pendingConfirmationCount: 0,
  pendingActivationCount: 0,
}

function affiliateGateway(record: AdminAffiliateDirectoryRecord = affiliate): AdminGateway {
  const page: AdminAffiliateDirectoryPage = { items: [record], totalCount: 1 }
  const summaryResult: AdminDataResult<AdminAffiliateDirectorySummary | null> = {
    data: summary,
    status: 'ready',
    error: null,
  }
  const pageResult: AdminDataResult<AdminAffiliateDirectoryPage | null> = {
    data: page,
    status: 'ready',
    error: null,
  }
  const detailResult: AdminDataResult<AdminAffiliateDirectoryRecord | null> = {
    data: record,
    status: 'ready',
    error: null,
  }
  return {
    getAdminContext: vi.fn(),
    getProducts: vi.fn(),
    createProduct: vi.fn(),
    getAffiliateSummary: vi.fn(async () => summaryResult),
    getAffiliateDirectory: vi.fn(async () => pageResult),
    getAffiliateDetail: vi.fn(async () => detailResult),
    setAffiliateStatus: vi.fn(async (input) => {
      const result: AdminDataResult<AdminAffiliateStatusChange | null> = {
        data: {
          id: record.id,
          status: input.status,
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
        status: 'ready',
        error: null,
      }
      return result
    }),
    terminateAffiliate: vi.fn(async () => {
      const result: AdminDataResult<AdminAffiliateStatusChange | null> = {
        data: {
          id: record.id,
          status: 'terminated',
          updatedAt: '2026-09-01T12:00:00.000Z',
        },
        status: 'ready',
        error: null,
      }
      return result
    }),
  }
}

function RouteHarness({
  gateway,
  context = ownerContext,
}: {
  gateway: AdminGateway
  context?: AdminContext
}) {
  const [affiliateId, setAffiliateId] = useState<string | null>(null)
  return (
    <AffiliatesPage
      context={context}
      gateway={gateway}
      affiliateId={affiliateId}
      onOpenAffiliate={setAffiliateId}
      onCloseAffiliate={() => setAffiliateId(null)}
    />
  )
}

describe('Admin Affiliate directory', () => {
  it('renders protected lifecycle data, filters the directory, and opens route-controlled details', async () => {
    const user = userEvent.setup()
    const gateway = affiliateGateway()
    render(<RouteHarness gateway={gateway} />)

    expect(await screen.findByRole('heading', { name: 'Affiliate directory' })).toBeVisible()
    expect(screen.getByText('North Star Media')).toBeVisible()
    expect(screen.getByText('owner@north-star.example.test')).toBeVisible()
    expect(
      screen.getByText('Confirmed', { selector: '.admin-affiliate-confirmation' }),
    ).toBeVisible()
    const allAffiliatesCard = screen.getByText('All affiliates').closest('article')
    expect(allAffiliatesCard).not.toBeNull()
    expect(within(allAffiliatesCard!).getByText('1')).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: 'Search affiliates' }), 'north')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Affiliate status' }), 'active')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() =>
      expect(gateway.getAffiliateDirectory).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: 'north', status: 'active', offset: 0 }),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'View North Star Media' }))
    expect(await screen.findByRole('dialog', { name: 'Affiliate details' })).toBeVisible()
    expect(gateway.getAffiliateDetail).toHaveBeenCalledWith(affiliate.id)
    expect(screen.getByText('Public registration')).toBeVisible()
    expect(screen.getByText('3 total · 0 active')).toBeVisible()
    expect(screen.getByText('4 total · 2 configured active')).toBeVisible()
  })

  it('requires an audit reason and submits a protected pause action', async () => {
    const user = userEvent.setup()
    const gateway = affiliateGateway()
    render(<RouteHarness gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'View North Star Media' }))
    await user.click(await screen.findByRole('button', { name: 'Pause affiliate' }))
    const actionDialog = screen.getByRole('dialog', { name: 'Pause North Star Media?' })
    const auditReason = within(actionDialog).getByRole('textbox', { name: 'Audit reason' })
    expect(auditReason).toHaveFocus()
    await user.type(auditReason, 'short')
    await user.click(within(actionDialog).getByRole('button', { name: 'Pause affiliate' }))
    expect(within(actionDialog).getByRole('alert')).toHaveTextContent('at least 10 characters')
    expect(auditReason).toHaveFocus()
    expect(gateway.setAffiliateStatus).not.toHaveBeenCalled()

    await user.clear(auditReason)
    await user.type(auditReason, 'Pause while compliance checks are completed.')
    await user.click(within(actionDialog).getByRole('button', { name: 'Pause affiliate' }))

    await waitFor(() =>
      expect(gateway.setAffiliateStatus).toHaveBeenCalledWith({
        affiliateId: affiliate.id,
        status: 'paused',
        reason: 'Pause while compliance checks are completed.',
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('North Star Media is now paused')
  })

  it('keeps irreversible termination owner-only and exposes commercial blockers', async () => {
    const user = userEvent.setup()
    const blocked = {
      ...affiliate,
      activeAgreementCount: 1,
      blockingAgreementCount: 1,
      blockingDocumentCount: 1,
      unsettledPayoutCount: 1,
    }
    const gateway = affiliateGateway(blocked)
    render(<RouteHarness gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'View North Star Media' }))
    expect(await screen.findByRole('button', { name: 'Terminate affiliate access' })).toBeDisabled()
    expect(
      screen.getByText(/resolve all active or awaiting-signature agreements/i),
    ).toHaveTextContent('current legal documents')

    cleanup()
    const operationsContext = { ...ownerContext, role: 'operations' as const }
    const secondGateway = affiliateGateway()
    render(<RouteHarness gateway={secondGateway} context={operationsContext} />)
    await user.click(await screen.findByRole('button', { name: 'View North Star Media' }))
    const dialog = await screen.findByRole('dialog', { name: 'Affiliate details' })
    expect(within(dialog).queryByRole('button', { name: 'Terminate affiliate access' })).toBeNull()
  })

  it('requires the exact affiliate slug before an owner can terminate access', async () => {
    const user = userEvent.setup()
    const gateway = affiliateGateway()
    render(<RouteHarness gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'View North Star Media' }))
    await user.click(await screen.findByRole('button', { name: 'Terminate affiliate access' }))
    const actionDialog = screen.getByRole('dialog', { name: 'Terminate North Star Media?' })
    const auditReason = within(actionDialog).getByRole('textbox', { name: 'Audit reason' })
    const confirmation = within(actionDialog).getByRole('textbox', {
      name: /type north-star to confirm/i,
    })

    await user.type(auditReason, 'Close this duplicate partner workspace.')
    await user.type(confirmation, 'wrong-slug')
    await user.click(within(actionDialog).getByRole('button', { name: 'Terminate access' }))

    expect(within(actionDialog).getByRole('alert')).toHaveTextContent(
      'Type north-star exactly to confirm termination.',
    )
    expect(confirmation).toHaveFocus()
    expect(gateway.terminateAffiliate).not.toHaveBeenCalled()

    await user.clear(confirmation)
    await user.type(confirmation, 'north-star')
    await user.click(within(actionDialog).getByRole('button', { name: 'Terminate access' }))

    await waitFor(() =>
      expect(gateway.terminateAffiliate).toHaveBeenCalledWith({
        affiliateId: affiliate.id,
        reason: 'Close this duplicate partner workspace.',
        confirmation: 'north-star',
      }),
    )
  })

  it('renders a safe unconfigured state without preview affiliate data', async () => {
    const gateway: AdminGateway = {
      getAdminContext: vi.fn(),
      getProducts: vi.fn(),
      createProduct: vi.fn(),
    }
    render(<RouteHarness gateway={gateway} />)

    expect(
      await screen.findByRole('heading', { name: 'Affiliate management is not configured' }),
    ).toBeVisible()
    expect(screen.queryByText('North Star Media')).not.toBeInTheDocument()
  })

  it('has no automated accessibility violations in the populated directory', async () => {
    const { container } = render(<RouteHarness gateway={affiliateGateway()} />)
    await screen.findByRole('button', { name: 'View North Star Media' })

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
  })
})
