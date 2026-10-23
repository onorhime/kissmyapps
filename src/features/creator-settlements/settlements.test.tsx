import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CreatorConnectCard } from './CreatorConnectCard'
import { CreatorEarningsPanel } from './CreatorEarningsPanel'
import { AdminSettlementsPanel } from './AdminSettlementsPanel'
import { BankPayouts } from './BankPayouts'
import { BalanceSummary } from './BalanceSummary'
import {
  createConnectGateway,
  mapConnectStatus,
  ConnectReauthenticationRequired,
  ConnectMfaRequired,
  type ConnectStatus,
} from './connect'
import {
  createSettlementGateway,
  mapSettlementWorkspace,
  moneyInputToMinor,
  settlementMoney,
  type SettlementBatch,
  type ExternalCommission,
  type CommissionTerms,
  type SettlementWorkspace,
} from './gateway'

vi.mock('./EmbeddedPayoutSetup', () => ({
  EmbeddedPayoutSetup: ({ onExit }: { onExit(): void }) => (
    <section aria-label="Secure payout setup">
      <button onClick={onExit}>Close for now</button>
    </section>
  ),
}))

const workspace = (): SettlementWorkspace => ({
  agreements: [
    {
      id: 'agreement-one',
      version: 2,
      product_id: 'product-one',
      affiliate_id: 'creator-one',
      status: 'active',
      model: 'revenue_share',
      payout_currency: 'USD',
      attribution_window_days: 30,
      renewal_duration_days: null,
      payout_frequency_days: 14,
      minimum_payout_minor: 2000,
      starts_at: null,
      ends_at: null,
      signed_document_id: 'document-one',
      terms_sha256: 'a'.repeat(64),
      eligible: true,
      rules: [
        {
          id: 'rule-one',
          version: 1,
          name: 'Signed purchase share',
          model: 'revenue_share',
          status: 'active',
          trigger_event: 'purchase.completed',
          fixed_amount_minor: null,
          rate_basis_points: 2000,
          currency: null,
          validation_window_hours: 72,
          refund_cutoff_days: null,
          commission_basis_policy: 'net_after_fees',
          policy_version: 2,
        },
      ],
    },
  ],
  scopes: [
    {
      product_id: 'product-one',
      product_name: 'Course',
      funnel_id: 'funnel-one',
      funnel_name: 'Launch',
      affiliate_id: 'creator-one',
      affiliate_name: 'Creator',
      stripe_account_id: 'acct_platform',
      platform_account_id: 'acct_platform',
      livemode: false,
      currency: 'USD',
    },
  ],
  platforms: [],
  terms: [],
  commissions: [],
  batches: [],
  accounts: [],
  balances: [],
  bank_payouts: [],
  truncated: false,
})
const connection = (): ConnectStatus => ({
  enabled: true,
  bindings: [
    {
      binding_id: 'course-sandbox',
      platform_account_id: 'acct_platform',
      livemode: false,
      allowed_countries: ['US', 'CA'],
      eligibility: {
        source: 'stripe_country_specs',
        verified_at: '2026-10-15T00:00:00Z',
        platform_country: 'US',
        countries: [
          { country: 'US', settlement_currencies: ['USD'] },
          { country: 'CA', settlement_currencies: ['CAD', 'USD'] },
        ],
      },
      allowed_transfer_currencies: [],
      eligibility_reason: null,
      connected_account_id: null,
      status: 'not_connected',
      details_submitted: false,
      transfers_enabled: false,
      payouts_enabled: false,
      requirements_due: [],
      disabled_reason: null,
      verified_at: null,
    },
  ],
})
const gateway = (data = workspace()) => ({
  workspace: vi.fn(async () => data),
  configure: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  action: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
})
const batch = (): SettlementBatch => ({
  id: 'batch-one',
  revision: 2,
  status: 'held',
  product_id: 'product-one',
  funnel_id: 'funnel-one',
  affiliate_id: 'creator-one',
  platform_account_id: 'acct_platform',
  livemode: false,
  currency: 'USD',
  amount_minor: 2500,
  created_at: '2026-10-14T00:00:00Z',
  reviewed_at: null,
  approved_at: null,
  transferred_at: null,
  reason: 'Review required',
  provider_jobs: [],
  items: [
    {
      award_id: 'award-one',
      order_id: 'order-one',
      amount_minor: 2500,
      status: 'eligible',
      eligible_at: null,
    },
  ],
})
const scheduledCommission = (): ExternalCommission => ({
  id: 'scheduled-award',
  order_id: 'scheduled-order',
  product_id: 'product-one',
  funnel_id: 'funnel-one',
  affiliate_id: 'creator-one',
  livemode: false,
  currency: 'USD',
  commission_minor: 2500,
  basis_minor: 12500,
  status: 'eligible',
  blocker: null,
  eligible_at: '2026-10-13T12:00:00Z',
  terms_id: 'signed-terms',
  revision: 1,
  payout_blocker: 'next_agreed_payout_period',
  payout_period_end: '2026-10-10T00:00:00Z',
  payout_next_at: '2026-10-24T00:00:00Z',
})
const signedMapping = (overrides: Partial<CommissionTerms> = {}): CommissionTerms => ({
  id: 'direct-terms',
  version: 1,
  revision: 1,
  status: 'approved',
  product_id: 'product-one',
  funnel_id: 'funnel-one',
  affiliate_id: 'creator-one',
  stripe_account_id: 'acct_platform',
  platform_account_id: 'acct_platform',
  livemode: false,
  currency: 'USD',
  calculation: 'percentage',
  basis_points: 2000,
  fixed_minor: null,
  hold_days: 3,
  attribution_window_days: 30,
  effective_from: '2026-10-15T00:00:00Z',
  effective_until: null,
  approved_at: '2026-10-15T00:00:00Z',
  reason: null,
  agreement_id: 'agreement-one',
  agreement_version: 2,
  commission_rule_id: 'rule-one',
  commission_rule_version: 1,
  signed_document_id: 'document-one',
  terms_sha256: 'a'.repeat(64),
  validation_window_hours: 72,
  refund_cutoff_days: 30,
  commission_basis_policy: 'net_after_fees',
  minimum_payout_minor: 2000,
  payout_frequency_days: 14,
  funding_model: 'merchant_direct',
  ...overrides,
})

describe('creator settlement contracts', () => {
  it('accepts legacy schedules and rejects malformed payout schedule evidence', () => {
    const legacy = scheduledCommission()
    delete legacy.payout_blocker
    delete legacy.payout_period_end
    delete legacy.payout_next_at
    expect(
      mapSettlementWorkspace({ ...workspace(), commissions: [legacy] }).commissions[0]
        .payout_next_at,
    ).toBeUndefined()
    expect(
      mapSettlementWorkspace({ ...workspace(), commissions: [scheduledCommission()] })
        .commissions[0].payout_next_at,
    ).toBe('2026-10-24T00:00:00Z')
    for (const invalid of [
      { ...scheduledCommission(), payout_blocker: false },
      { ...scheduledCommission(), payout_period_end: 'not-a-date' },
      { ...scheduledCommission(), payout_next_at: 2026 },
    ])
      expect(() => mapSettlementWorkspace({ ...workspace(), commissions: [invalid] })).toThrow(
        /payout/,
      )
  })
  it('supports currency exponents without floating point commission input', () => {
    expect(moneyInputToMinor('12.34', 'USD')).toBe(1234)
    expect(moneyInputToMinor('1250', 'JPY')).toBe(1250)
    expect(moneyInputToMinor('1.234', 'KWD')).toBe(1234)
    expect(() => moneyInputToMinor('12.34', 'JPY')).toThrow()
    expect(() => moneyInputToMinor('1.234', 'USD')).toThrow()
    expect(() => moneyInputToMinor('9007199254740993', 'USD')).toThrow()
    expect(settlementMoney(1250, 'JPY')).toContain('1,250')
  })
  it('does not fabricate missing balances, mode or response coverage', () => {
    expect(mapSettlementWorkspace(workspace()).balances).toEqual([])
    expect(() =>
      mapSettlementWorkspace({ ...workspace(), balances: [{ currency: 'USD', livemode: false }] }),
    ).toThrow()
    expect(() => mapSettlementWorkspace({ ...workspace(), truncated: undefined })).toThrow()
    expect(() =>
      mapSettlementWorkspace({
        ...workspace(),
        scopes: [{ ...workspace().scopes[0], livemode: undefined }],
      }),
    ).toThrow()
    expect(
      mapSettlementWorkspace({
        ...workspace(),
        scopes: [{ ...workspace().scopes[0], currency: null }],
      }).scopes[0].currency,
    ).toBeNull()
  })
  it('rejects unrelated product data and unauthorized errors', async () => {
    const rpc = vi.fn(async () => ({ data: workspace(), error: null }))
    const service = createSettlementGateway({ rpc })
    await expect(service.workspace(false, { product_id: 'foreign' })).rejects.toThrow('scope')
    expect(rpc).toHaveBeenCalledWith('get_partner_external_settlement_workspace', {
      p_input: { product_id: 'foreign' },
    })
    const denied = createSettlementGateway({
      rpc: async () => ({ data: null, error: { code: '42501' } }),
    })
    await expect(denied.action({})).rejects.toThrow('does not have access')
  })
  it('requires complete unique frozen items that sum to the batch amount', () => {
    expect(
      mapSettlementWorkspace({ ...workspace(), batches: [batch()] }).batches[0].items,
    ).toHaveLength(1)
    for (const invalid of [
      { ...batch(), items: undefined },
      { ...batch(), items: [] },
      { ...batch(), amount_minor: 5000 },
      { ...batch(), amount_minor: 5000, items: [batch().items[0], batch().items[0]] },
    ])
      expect(() => mapSettlementWorkspace({ ...workspace(), batches: [invalid] })).toThrow(/Frozen/)
  })
  it('shows eligibility blocks as actionable errors rather than suggesting a network retry', async () => {
    const blocked = createSettlementGateway({
      rpc: async () => ({
        data: null,
        error: { code: '55000', message: 'Settlement blocked by refund or debt' },
      }),
    })
    await expect(blocked.action({})).rejects.toThrow('Settlement blocked by refund or debt')
  })
  it('lets an administrator review a held batch with every frozen line visible', async () => {
    const user = userEvent.setup(),
      data = workspace()
    data.batches.push(batch())
    const service = gateway(data)
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    await user.click(await screen.findByText('Frozen items (1)'))
    expect(screen.getByText('order-one')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Review batch' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(
      within(dialog).getByLabelText('Audit reason'),
      'Refund review completed in fixture',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Confirm review batch' }))
    await waitFor(() =>
      expect(service.action).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'review_batch',
          id: 'batch-one',
          expected_revision: 2,
        }),
      ),
    )
  })
  it('does not expose hosted onboarding links in the active gateway', async () => {
    const invoke = vi.fn(async () => ({
      data: { ...connection(), onboarding_url: 'https://connect.stripe.com/setup/fixture' },
      error: null,
    }))
    const service = createConnectGateway({ functions: { invoke } })
    expect('onboard' in service).toBe(false)
    expect(await service.status()).not.toHaveProperty('onboarding_url')
    expect(() => mapConnectStatus({ enabled: true, bindings: [{ status: 'ready' }] })).toThrow()
  })
})

describe('creator settlement UI', () => {
  it('requires the enrolled authenticator code before resuming payout setup', async () => {
    const user = userEvent.setup(),
      reauthenticate = vi.fn(async () => {
        throw new ConnectMfaRequired()
      }),
      verifyMfa = vi.fn(async () => {})
    const session = vi
      .fn()
      .mockRejectedValueOnce(new ConnectReauthenticationRequired())
      .mockResolvedValueOnce({
        binding_id: 'course-sandbox',
        platform_account_id: 'acct_platform',
        connected_account_id: 'acct_creator',
        livemode: false,
        publishable_key: 'pk_test_fixture',
        client_secret: 'local_secret',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
    render(
      <CreatorConnectCard
        gateway={{ status: async () => connection(), session, reauthenticate, verifyMfa }}
      />,
    )
    await user.selectOptions(await screen.findByLabelText('Your account country'), 'CA')
    await user.click(screen.getByRole('button', { name: 'Set up payouts' }))
    await user.type(await screen.findByLabelText('KissMyApps password'), 'example-password')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(await screen.findByLabelText('Authenticator code')).toBeVisible()
    expect(screen.queryByLabelText('KissMyApps password')).not.toBeInTheDocument()
    expect(session).toHaveBeenCalledOnce()
    await user.type(screen.getByLabelText('Authenticator code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(verifyMfa).toHaveBeenCalledWith('123456')
    expect(await screen.findByRole('region', { name: 'Secure payout setup' })).toBeVisible()
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument()
  })
  it('confirms the password inline and resumes the selected country after stale authentication', async () => {
    const user = userEvent.setup(),
      reauthenticate = vi.fn(async () => {})
    const session = vi
      .fn()
      .mockRejectedValueOnce(new ConnectReauthenticationRequired())
      .mockResolvedValueOnce({
        binding_id: 'course-sandbox',
        platform_account_id: 'acct_platform',
        connected_account_id: 'acct_creator',
        livemode: false,
        publishable_key: 'pk_test_fixture',
        client_secret: 'local_secret',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
    render(
      <CreatorConnectCard
        gateway={{ status: async () => connection(), session, reauthenticate }}
      />,
    )
    await user.selectOptions(await screen.findByLabelText('Your account country'), 'CA')
    await user.click(screen.getByRole('button', { name: 'Set up payouts' }))
    expect(await screen.findByRole('form', { name: 'Confirm payout setup' })).toBeVisible()
    await user.type(screen.getByLabelText('KissMyApps password'), 'example-password')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(reauthenticate).toHaveBeenCalledWith('example-password')
    expect(session).toHaveBeenNthCalledWith(2, 'course-sandbox', 'CA')
    expect(await screen.findByRole('region', { name: 'Secure payout setup' })).toBeVisible()
    expect(screen.queryByLabelText('KissMyApps password')).not.toBeInTheDocument()
  })
  it('clears a failed password without retrying payout setup or navigating away', async () => {
    const user = userEvent.setup(),
      session = vi.fn(async () => {
        throw new ConnectReauthenticationRequired()
      })
    const reauthenticate = vi.fn(async () => {
      throw Error('Your password could not be verified. Please try again.')
    })
    render(
      <CreatorConnectCard
        gateway={{ status: async () => connection(), session, reauthenticate }}
      />,
    )
    await user.selectOptions(await screen.findByLabelText('Your account country'), 'CA')
    await user.click(screen.getByRole('button', { name: 'Set up payouts' }))
    await user.type(await screen.findByLabelText('KissMyApps password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Confirm and continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('password could not be verified')
    expect(screen.getByLabelText('KissMyApps password')).toHaveValue('')
    expect(session).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()
  })
  it('requires an allowed country and uses refreshed provider status, not form exit, to mark setup ready', async () => {
    const user = userEvent.setup()
    const pending = connection()
    Object.assign(pending.bindings[0], {
      connected_account_id: 'acct_creator',
      details_submitted: true,
      status: 'pending_verification',
      requirements_due: [],
    })
    const ready = connection()
    Object.assign(ready.bindings[0], {
      connected_account_id: 'acct_creator',
      details_submitted: true,
      status: 'ready',
      requirements_due: [],
      transfers_enabled: true,
      payouts_enabled: true,
    })
    let refreshed!: (value: ConnectStatus) => void
    const status = vi
      .fn()
      .mockResolvedValueOnce(connection())
      .mockImplementationOnce(
        () =>
          new Promise<ConnectStatus>((resolve) => {
            refreshed = resolve
          }),
      )
      .mockResolvedValueOnce(ready)
    const session = vi.fn(async () => ({
      binding_id: 'course-sandbox',
      platform_account_id: 'acct_platform',
      connected_account_id: 'acct_creator',
      livemode: false,
      publishable_key: 'pk_test_fixture',
      client_secret: 'local_secret',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }))
    render(<CreatorConnectCard gateway={{ status, session }} />)
    const button = await screen.findByRole('button', { name: 'Set up payouts' })
    expect(button).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Your account country'), 'CA')
    await user.click(button)
    expect(session).toHaveBeenCalledWith('course-sandbox', 'CA')
    expect(await screen.findByRole('region', { name: 'Secure payout setup' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close for now' }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('region', { name: 'Secure payout setup' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Your payout account is ready/)).not.toBeInTheDocument()
    refreshed(pending)
    expect(
      await screen.findByText('Your details are submitted. Payout setup is not ready yet.'),
    ).toBeVisible()
    expect(screen.queryByText(/Your payout account is ready/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh status' }))
    expect(
      await screen.findByText('Your payout account is ready. Earnings still need payout approval.'),
    ).toBeVisible()
    expect(
      screen.getByText(/Closing the form checks your current verification status/),
    ).toBeVisible()
  })
  it('shows session failures and allows retry without redirecting', async () => {
    const user = userEvent.setup()
    const session = vi.fn(async () => {
      throw Error('Payout setup is unavailable.')
    })
    render(<CreatorConnectCard gateway={{ status: async () => connection(), session }} />)
    await user.selectOptions(await screen.findByLabelText('Your account country'), 'CA')
    await user.click(screen.getByRole('button', { name: 'Set up payouts' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Payout setup is unavailable.')
    expect(screen.getByRole('button', { name: 'Set up payouts' })).toBeEnabled()
  })
  it('keeps disabled connections visibly disabled and makes no onboarding call', async () => {
    const session = vi.fn()
    render(
      <CreatorConnectCard
        gateway={{
          status: async () => ({ enabled: false, bindings: [] }),
          session,
        }}
      />,
    )
    expect(await screen.findByText(/Payout setup is not enabled/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Set up payouts' })).not.toBeInTheDocument()
    expect(session).not.toHaveBeenCalled()
  })
  it('keeps read-only admins out of configuration actions', async () => {
    const service = gateway()
    render(<AdminSettlementsPanel canWrite={false} gateway={service} />)
    await screen.findByText('No commission terms have been configured. Purchases remain on hold.')
    expect(screen.queryByText('Connect a signed agreement to funding')).not.toBeInTheDocument()
    expect(service.configure).not.toHaveBeenCalled()
  })
  it('reuses signed terms, reviews funding and repeats the same uncertain request', async () => {
    const service = gateway(),
      user = userEvent.setup()
    service.configure.mockRejectedValueOnce(Error('Connection interrupted'))
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    await screen.findByText('No commission terms have been configured. Purchases remain on hold.')
    const scopeSelect = screen.getByLabelText('Creator and product scope')
    await user.selectOptions(scopeSelect, (scopeSelect as HTMLSelectElement).options[1].value)
    await user.click(screen.getByText('Connect a signed agreement to funding'))
    expect(screen.queryByLabelText('Commission percentage')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Attribution window (days)')).not.toBeInTheDocument()
    await user.selectOptions(
      screen.getByLabelText('Signed agreement and rule'),
      'agreement-one:rule-one',
    )
    await user.selectOptions(screen.getByLabelText('Funding model'), 'merchant_direct')
    await user.type(screen.getByLabelText('Effective from (UTC)'), '2026-10-15')
    await user.click(screen.getByRole('button', { name: 'Review funding mapping' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', {
      name: 'Confirm save funding mapping draft',
    })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Audit reason'), 'Local fixture agreement only')
    await user.click(confirm)
    await within(dialog).findByText('Connection interrupted')
    expect(within(dialog).getByLabelText('Audit reason')).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Retry same request' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(service.configure.mock.calls).toHaveLength(2)
    expect(service.configure.mock.calls[0]).toEqual(service.configure.mock.calls[1])
    expect(service.configure.mock.calls[0][0]).toMatchObject({
      expected_version: 0,
      agreement_id: 'agreement-one',
      commission_rule_id: 'rule-one',
      funding_model: 'merchant_direct',
      livemode: false,
      reason: 'Local fixture agreement only',
    })
    expect(service.configure.mock.calls[0][0]).not.toHaveProperty('basis_points')
    expect(service.configure.mock.calls[0][0]).not.toHaveProperty('hold_days')
    expect(service.action).not.toHaveBeenCalled()
  })
  it('collects merchant checkout fees into the bound platform using the existing signed rules', async () => {
    const data = workspace()
    data.scopes[0] = {
      ...data.scopes[0],
      stripe_account_id: 'acct_merchant',
      platform_account_id: 'acct_KMA',
    }
    const service = gateway(data),
      user = userEvent.setup()
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    const scopes = await screen.findByLabelText('Creator and product scope')
    await user.selectOptions(scopes, (scopes as HTMLSelectElement).options[1].value)
    await user.click(screen.getByText('Connect a signed agreement to funding'))
    await user.selectOptions(
      screen.getByLabelText('Signed agreement and rule'),
      'agreement-one:rule-one',
    )
    await user.selectOptions(screen.getByLabelText('Funding model'), 'application_fee')
    expect(screen.queryByLabelText('Commission percentage')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Reviewed platform account ID')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Effective from (UTC)'), '2026-10-17')
    await user.click(screen.getByRole('button', { name: 'Review funding mapping' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Collected as a Stripe application fee')
    await user.type(
      within(dialog).getByLabelText('Audit reason'),
      'Test connected merchant funding',
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm save funding mapping draft' }),
    )
    await waitFor(() => expect(service.configure).toHaveBeenCalled())
    expect(service.configure.mock.calls[0][0]).toMatchObject({
      funding_model: 'application_fee',
      platform_account_id: 'acct_KMA',
      stripe_account_id: 'acct_merchant',
      agreement_id: 'agreement-one',
      commission_rule_id: 'rule-one',
    })
    expect(service.configure.mock.calls[0][0]).not.toHaveProperty('basis_points')
    expect(service.action).not.toHaveBeenCalled()
    expect(
      mapSettlementWorkspace({
        ...data,
        terms: [signedMapping({ funding_model: 'application_fee' })],
      }).terms[0].funding_model,
    ).toBe('application_fee')
  })
  it('distinguishes funding scopes and retains the merchant-wide binding revision when switching accounts', async () => {
    const user = userEvent.setup(),
      data = workspace()
    data.scopes.push({ ...data.scopes[0], platform_account_id: 'acct_funding' })
    data.terms.push(
      signedMapping(),
      signedMapping({
        id: 'platform-terms',
        version: 2,
        platform_account_id: 'acct_funding',
        funding_model: 'prefunded_platform',
        status: 'draft',
        approved_at: null,
      }),
    )
    const service = gateway(data)
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    const scopes = await screen.findByLabelText('Creator and product scope')
    const direct = within(scopes).getByRole('option', {
      name: /Funding acct_platform · Merchant direct/,
    }) as HTMLOptionElement
    const prefunded = within(scopes).getByRole('option', {
      name: /Funding acct_funding · Pre-funded platform/,
    }) as HTMLOptionElement
    expect(direct.value).not.toBe(prefunded.value)
    await user.selectOptions(scopes, prefunded.value)
    await user.click(screen.getByRole('button', { name: 'Prepare eligible earnings' }))
    let dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Funding acct_funding/)).toBeVisible()
    await user.type(within(dialog).getByLabelText('Audit reason'), 'Review correct funding scope')
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm prepare settlement batch' }),
    )
    await waitFor(() =>
      expect(service.action).toHaveBeenCalledWith(
        expect.objectContaining({ platform_account_id: 'acct_funding' }),
      ),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.selectOptions(screen.getByLabelText('Creator and product scope'), direct.value)
    await user.click(screen.getByText('Connect a signed agreement to funding'))
    await user.selectOptions(
      screen.getByLabelText('Signed agreement and rule'),
      'agreement-one:rule-one',
    )
    await user.selectOptions(screen.getByLabelText('Funding model'), 'merchant_direct')
    await user.type(screen.getByLabelText('Effective from (UTC)'), '2026-11-15')
    await user.click(screen.getByRole('button', { name: 'Review funding mapping' }))
    dialog = screen.getByRole('dialog')
    await user.type(
      within(dialog).getByLabelText('Audit reason'),
      'Return to reviewed merchant funding',
    )
    await user.click(
      within(dialog).getByRole('button', { name: 'Confirm save funding mapping draft' }),
    )
    await waitFor(() =>
      expect(service.configure).toHaveBeenCalledWith(
        expect.objectContaining({ platform_account_id: 'acct_platform', expected_version: 2 }),
      ),
    )
  })
  it('reviews the exact funding destination and frozen signed policy before approval', async () => {
    const user = userEvent.setup(),
      data = workspace()
    data.scopes.push({ ...data.scopes[0], platform_account_id: 'acct_funding' })
    data.terms.push(
      signedMapping({
        id: 'platform-terms',
        version: 2,
        platform_account_id: 'acct_funding',
        funding_model: 'prefunded_platform',
        status: 'draft',
        approved_at: null,
      }),
    )
    const service = gateway(data)
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    expect(
      await screen.findByText(
        'Pre-funded platform · Funding account acct_funding · Receiving merchant acct_platform',
      ),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Review funding mapping approval' }))
    const dialog = screen.getByRole('dialog', { name: 'Approve funding mapping' })
    const description = within(dialog).getByText(
      /Signed agreement agreement-one v2; rule rule-one v1/,
    )
    expect(description).toHaveTextContent('Funding account acct_funding')
    expect(description).toHaveTextContent('Receiving merchant acct_platform')
    expect(description).toHaveTextContent('Pre-funded platform')
    expect(description).toHaveTextContent('Ordinary refund cutoff: 30 days')
    expect(description).toHaveTextContent('Basis: net after payment fees')
    expect(description).toHaveTextContent('Minimum payout: $20.00; cadence: 14 days')
    expect(service.action).not.toHaveBeenCalled()
  })
  it('separates not-calculated earnings, transferred batches and bank payouts', async () => {
    const data = workspace()
    data.commissions.push({
      id: 'award',
      order_id: 'order',
      product_id: 'product-one',
      funnel_id: 'funnel-one',
      affiliate_id: 'creator-one',
      livemode: false,
      currency: 'USD',
      commission_minor: 0,
      basis_minor: null,
      status: 'unconfigured',
      blocker: 'terms_unconfigured',
      eligible_at: null,
      terms_id: null,
      revision: 1,
    })
    data.commissions.push({
      ...data.commissions[0],
      id: 'missing-basis',
      status: 'held',
      blocker: 'verified_basis_missing',
    })
    data.commissions.push({
      ...data.commissions[0],
      id: 'verified-zero',
      status: 'held',
      basis_minor: 0,
      blocker: 'zero_eligible_basis',
    })
    render(<CreatorEarningsPanel productId="product-one" gateway={gateway(data)} client={null} />)
    expect(await screen.findAllByText('Not calculated')).toHaveLength(2)
    expect(screen.getByText('$0.00')).toBeVisible()
    expect(screen.getByText('No bank payout events have been received yet.')).toBeVisible()
    expect(screen.getByText(/Approval does not mean money has been sent/)).toBeVisible()
  })
  it('shows payout cadence separately from the validation hold for admins and creators', async () => {
    const data = workspace()
    data.commissions.push(scheduledCommission())
    const admin = render(<AdminSettlementsPanel canWrite={false} gateway={gateway(data)} />)
    expect(
      await screen.findByText('Waiting for the next agreed payout period.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Next agreed payout boundary:/).querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-10-24T00:00:00Z',
    )
    expect(screen.getByText(/does not guarantee payment/)).toBeInTheDocument()
    admin.unmount()
    render(<CreatorEarningsPanel productId="product-one" gateway={gateway(data)} client={null} />)
    expect(await screen.findByText('Waiting for the next agreed payout period.')).toBeVisible()
    expect(screen.getByRole('columnheader', { name: 'Hold ends' })).toBeVisible()
    expect(screen.getByText(/Next agreed payout boundary:/).querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-10-24T00:00:00Z',
    )
    expect(screen.queryByText(/^Payout period boundary:/)).not.toBeInTheDocument()
  })
  it('shows provider failure and queues a lookup without requesting another payment', async () => {
    const user = userEvent.setup(),
      data = workspace(),
      item = batch()
    item.status = 'processing'
    item.provider_jobs = [
      {
        kind: 'transfer',
        state: 'failed',
        last_error: 'provider_balance_or_account_unavailable',
        attempts: 1,
        first_attempt_at: '2026-10-14T00:00:00Z',
      },
    ]
    data.batches.push(item)
    const service = gateway(data)
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    await user.click(await screen.findByRole('button', { name: 'Check provider outcome' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/does not authorize another payment/)).toBeVisible()
    await user.type(
      within(dialog).getByLabelText('Audit reason'),
      'Verify interrupted fixture transfer',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Confirm check provider outcome' }))
    await waitFor(() =>
      expect(service.action).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reconcile_batch',
          id: 'batch-one',
          expected_revision: 2,
        }),
      ),
    )
    expect(service.configure).not.toHaveBeenCalled()
  })
  it('labels bank payouts as account-wide and exposes failure instead of calling it paid', () => {
    render(
      <BankPayouts
        items={[
          {
            platform_account_id: 'acct_platform',
            livemode: false,
            connected_account_id: 'acct_creator',
            payout_id: 'po_fixture',
            status: 'failed',
            amount_minor: 5000,
            currency: 'USD',
            arrival_date: null,
            failure_code: 'bank_account_closed',
            observed_at: new Date().toISOString(),
          },
        ]}
      />,
    )
    expect(screen.getByText('failed')).toBeVisible()
    expect(screen.getByText('bank account closed')).toBeVisible()
    expect(screen.getByText(/account-level Stripe payouts across products/)).toBeVisible()
  })
  it('does not describe an account balance or refund debt as withdrawable product earnings', () => {
    render(
      <BalanceSummary
        items={[
          {
            affiliate_id: 'creator-one',
            platform_account_id: 'acct_platform',
            livemode: false,
            currency: 'USD',
            earned_minor: 4000,
            reversed_minor: 2000,
            transferred_minor: 2000,
            recovered_minor: 0,
            balance_minor: 0,
            debt_minor: 2000,
            review_required: true,
          },
        ]}
      />,
    )
    expect(screen.getByText(/all products sharing this funding account/)).toBeVisible()
    expect(screen.getByText(/not an amount available to withdraw/)).toBeVisible()
    expect(screen.getByText('Recovery hold').nextElementSibling).toHaveTextContent('$20.00')
    expect(screen.getByText('Recorded balance').nextElementSibling).toHaveTextContent('$0.00')
    expect(screen.getByText(/partial refund or dispute needs finance review/)).toBeVisible()
  })
})

describe('single-source signed commission settings', () => {
  it('blocks unsigned or unrelated agreement selection and links back to existing configuration', async () => {
    const data = workspace()
    data.agreements = [
      { ...data.agreements![0], eligible: false, signed_document_id: null },
      { ...data.agreements![0], id: 'unrelated', product_id: 'other-product' },
    ]
    const user = userEvent.setup(),
      service = gateway(data)
    render(<AdminSettlementsPanel canWrite gateway={service} />)
    const scope = await screen.findByLabelText('Creator and product scope')
    await user.selectOptions(scope, (scope as HTMLSelectElement).options[1].value)
    await user.click(screen.getByText('Connect a signed agreement to funding'))
    expect(screen.getByText(/No eligible signed agreement matches/)).toBeVisible()
    expect(screen.queryByLabelText('Signed agreement and rule')).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Manage agreements and commission rules' }),
    ).toHaveAttribute('href', '#admin/products/product-one/configuration')
    expect(service.configure).not.toHaveBeenCalled()
  })
  it('rejects invented signed evidence and missing country verification', () => {
    const data = workspace()
    expect(() =>
      mapSettlementWorkspace({
        ...data,
        agreements: [{ ...data.agreements![0], terms_sha256: null }],
      }),
    ).toThrow(/evidence/)
    expect(() =>
      mapConnectStatus({
        ...connection(),
        bindings: [{ ...connection().bindings[0], eligibility: undefined }],
      }),
    ).toThrow()
    expect(() =>
      mapConnectStatus({
        ...connection(),
        bindings: [{ ...connection().bindings[0], allowed_countries: ['NG'] }],
      }),
    ).toThrow(/inconsistent/)
  })
  it('explains available country currencies without promising automatic conversion', async () => {
    const user = userEvent.setup()
    render(<CreatorConnectCard gateway={{ status: async () => connection(), session: vi.fn() }} />)
    await user.selectOptions(await screen.findByLabelText('Your account country'), 'CA')
    expect(screen.getByText(/Provider-supported settlement currencies/)).toHaveTextContent(
      'CAD, USD',
    )
    expect(screen.getByText(/automatic currency conversion is not assumed/)).toBeVisible()
  })
  it('renders a frozen hybrid agreement and exact hourly hold in the existing creator payout panel', async () => {
    const data = workspace()
    data.terms = [
      {
        id: 'terms-one',
        version: 1,
        revision: 1,
        status: 'approved',
        product_id: 'product-one',
        funnel_id: 'funnel-one',
        affiliate_id: 'creator-one',
        stripe_account_id: 'acct_platform',
        platform_account_id: 'acct_platform',
        livemode: false,
        currency: 'USD',
        calculation: 'hybrid',
        basis_points: 1500,
        fixed_minor: 500,
        hold_days: 1,
        attribution_window_days: 30,
        effective_from: '2026-10-15T00:00:00Z',
        effective_until: null,
        approved_at: '2026-10-15T00:00:00Z',
        reason: null,
        agreement_id: 'agreement-one',
        agreement_version: 2,
        commission_rule_id: 'rule-one',
        commission_rule_version: 3,
        signed_document_id: 'document-one',
        terms_sha256: 'a'.repeat(64),
        validation_window_hours: 12,
        refund_cutoff_days: null,
        commission_basis_policy: 'net_after_fees',
        minimum_payout_minor: 2000,
        payout_frequency_days: 14,
        funding_model: 'merchant_direct',
      },
    ]
    expect(mapSettlementWorkspace(data).terms[0].calculation).toBe('hybrid')
    const user = userEvent.setup()
    render(<CreatorEarningsPanel productId="product-one" gateway={gateway(data)} client={null} />)
    await user.click(await screen.findByText(/Signed agreement v2 · rule v3/))
    expect(screen.getByText(/12-hour validation hold/)).toHaveTextContent('15% + $5.00')
    expect(screen.getByText(/Ordinary refund cutoff: unlimited/)).toBeVisible()
    expect(screen.getByText('document-one')).toBeVisible()
    expect(screen.getByText('a'.repeat(64))).toBeVisible()
  })
})
