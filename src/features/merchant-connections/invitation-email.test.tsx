import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MerchantConnectionsSection } from './MerchantConnectionsSection'
import {
  createMerchantGateway,
  type MerchantGateway,
  type MerchantInvitation,
  type MerchantStatus,
} from './gateway'

const invitation: MerchantInvitation = {
  invitation_id: 'invite-1',
  merchant_id: 'merchant-1',
  expires_at: '2099-01-01T00:00:00Z',
  status: 'invited',
  can_copy: true,
  invitation_url: `https://partners.kissmyapps.dev/merchant/connect#invite=${'a'.repeat(64)}`,
  delivery: { status: 'sent', recipient: 'owner@example.test', retry_at: null, can_retry: true },
}
function workspace(latest = invitation): MerchantStatus {
  return {
    enabled: true,
    bindings: [{ id: 'test', platform_account_id: 'acct_Platform', livemode: false }],
    workspace: {
      merchants: [
        {
          id: 'merchant-1',
          business_name: 'Merchant',
          email: 'owner@example.test',
          connections: [
            {
              id: 'connection-1',
              merchant_id: 'merchant-1',
              platform_account_id: 'acct_Platform',
              livemode: false,
              account_id: '',
              business_name: '',
              country: null,
              charges_enabled: false,
              payouts_enabled: false,
              details_submitted: false,
              status: 'pending',
              verified_at: null,
              latest_invitation: latest,
            },
          ],
        },
      ],
      assignments: [],
    },
  }
}
function service(latest = invitation): MerchantGateway {
  return {
    requestInvitationCode: vi.fn(),
    status: vi.fn(async () => workspace(latest)),
    createInvitation: vi.fn(async () => latest),
    resendInvitation: vi.fn(async () => latest),
    invitationLink: vi.fn(async () => latest),
    assignProduct: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    inspectInvitation: vi.fn(),
    startConnection: vi.fn(),
    completeConnection: vi.fn(),
    connectionStatus: vi.fn(),
    refreshConnection: vi.fn(),
    confirmConnection: vi.fn(),
  }
}
afterEach(() => vi.useRealTimers())

async function create(gateway: MerchantGateway) {
  const user = userEvent.setup()
  render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
  await user.type(await screen.findByLabelText('Business name'), 'Merchant')
  await user.type(screen.getByLabelText('Merchant contact email'), 'owner@example.test')
  await user.selectOptions(screen.getByLabelText('Stripe environment'), 'test')
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
  return user
}

describe('Merchant invitation email actions', () => {
  it.each(['sent', 'failed', 'unknown', 'disabled'] as const)(
    'keeps the created link available and reports %s truthfully',
    async (status) => {
      const value = { ...invitation, delivery: { ...invitation.delivery, status } }
      const gateway = service(value)
      await create(gateway)
      const result = await screen.findByRole('status', { name: 'Invitation email status' })
      expect(result).toHaveTextContent(
        {
          sent: 'The email provider accepted the message',
          failed: 'email was not sent',
          unknown: 'email status is not confirmed',
          disabled: 'Email sending is currently disabled',
        }[status],
      )
      expect(result).not.toHaveTextContent('delivered')
      expect(screen.getByLabelText('Secure invitation link')).toHaveValue(invitation.invitation_url)
      expect(screen.getByLabelText('Business name')).toHaveValue('')
      expect(gateway.assignProduct).not.toHaveBeenCalled()
      expect(gateway.revoke).not.toHaveBeenCalled()
    },
  )
  it('resends the same valid invitation and retrieves its copy link after reload without renewing it', async () => {
    const gateway = service(),
      user = userEvent.setup()
    const linkResponse = { ...invitation }
    delete linkResponse.can_copy
    vi.mocked(gateway.invitationLink).mockResolvedValue(linkResponse)
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'View invitation link' }))
    expect(gateway.invitationLink).toHaveBeenCalledWith('invite-1')
    expect(screen.getByRole('button', { name: 'View invitation link' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeEnabled()
    expect(screen.getByRole('region', { name: 'Invitation details' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Copy invitation link' }))
    expect(await navigator.clipboard.readText()).toBe(invitation.invitation_url)
    await user.click(screen.getByRole('button', { name: 'Resend this invitation' }))
    expect(gateway.resendInvitation).toHaveBeenCalledWith('invite-1')
    expect(gateway.createInvitation).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Secure invitation link')).toHaveValue(invitation.invitation_url)
  })
  it('refreshes email status without sending or replacing the invitation', async () => {
    const pending = {
      ...invitation,
      delivery: { ...invitation.delivery, status: 'sending' as const, can_retry: false },
    }
    const gateway = service(pending),
      user = userEvent.setup()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'View invitation link' }))
    expect(screen.getByRole('status', { name: 'Invitation email status' })).toHaveTextContent(
      'being processed',
    )
    vi.mocked(gateway.status).mockResolvedValue(workspace(invitation))
    await user.click(screen.getByRole('button', { name: 'Refresh email status' }))
    expect(screen.getByRole('status', { name: 'Invitation email status' })).toHaveTextContent(
      'provider accepted',
    )
    expect(gateway.createInvitation).not.toHaveBeenCalled()
    expect(gateway.resendInvitation).not.toHaveBeenCalled()
  })
  it('locks duplicate resend clicks while awaiting the backend', async () => {
    const gateway = service()
    let resolve!: (value: MerchantInvitation) => void
    vi.mocked(gateway.resendInvitation).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    const button = await screen.findByRole('button', { name: 'Resend invitation' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(gateway.resendInvitation).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    await act(async () => resolve(invitation))
  })
  it('enforces cooldown then refreshes server eligibility before allowing another send', async () => {
    vi.useFakeTimers()
    const pending = {
      ...invitation,
      delivery: {
        ...invitation.delivery,
        can_retry: false,
        retry_at: new Date(Date.now() + 2000).toISOString(),
      },
    }
    const gateway = service(pending)
    vi.mocked(gateway.status)
      .mockResolvedValueOnce(workspace(pending))
      .mockResolvedValue(workspace(invitation))
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    await act(async () => {})
    const button = screen.getByRole('button', { name: 'Resend invitation' })
    expect(button).toBeDisabled()
    expect(screen.getByText('You can resend in 2s.')).toBeVisible()
    fireEvent.click(button)
    expect(gateway.resendInvitation).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200)
    })
    expect(gateway.status).toHaveBeenCalledTimes(2)
    expect(button).toBeEnabled()
  })
  it.each(['sending', 'unknown'] as const)(
    'does not retry %s when the server denies another attempt',
    async (status) => {
      const gateway = service({
        ...invitation,
        delivery: { ...invitation.delivery, status, can_retry: false },
      })
      render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
      expect(await screen.findByRole('button', { name: 'Resend invitation' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'View invitation link' })).toBeEnabled()
    },
  )
  it('gives a legacy manual invitation an explicit renewal path instead of unusable copy or resend actions', async () => {
    const gateway = service({
      ...invitation,
      can_copy: false,
      delivery: { ...invitation.delivery, status: 'not_sent', can_retry: false },
    })
    const user = userEvent.setup()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    expect(await screen.findByText(/older invitation cannot be copied or resent/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View invitation link' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create new invitation' }))
    expect(screen.getByRole('region', { name: 'Review merchant change' })).toHaveTextContent(
      'Previous unfinished links will stop working',
    )
    expect(gateway.createInvitation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm new invitation' }))
    expect(gateway.createInvitation).toHaveBeenCalledWith({
      merchant_id: 'merchant-1',
      binding_id: 'test',
      business_name: 'Merchant',
      email: 'owner@example.test',
    })
  })
  it('keeps all email actions unavailable without management permission or enabled connections', async () => {
    const gateway = service()
    const view = render(
      <MerchantConnectionsSection productId="product-1" canManage={false} gateway={gateway} />,
    )
    await screen.findByText('owner@example.test')
    expect(screen.queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument()
    vi.mocked(gateway.status).mockResolvedValue({ ...workspace(), enabled: false })
    view.unmount()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={gateway} />)
    expect(await screen.findByRole('button', { name: 'Resend invitation' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create new invitation' })).toBeDisabled()
  })
  it('never invents successful delivery after a transport error', async () => {
    const gateway = service()
    vi.mocked(gateway.createInvitation).mockRejectedValue(
      Error('The invitation request could not be confirmed. It may already have been processed.'),
    )
    await create(gateway)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed')
    expect(
      screen.queryByRole('status', { name: 'Invitation email status' }),
    ).not.toBeInTheDocument()
  })
})

describe('Invitation gateway request identity and validation', () => {
  const input = { binding_id: 'test', business_name: 'Merchant', email: 'owner@example.test' }
  it('reuses creation request ID after network uncertainty, then starts a new operation after a valid response', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(Error('network'))
      .mockResolvedValue({ data: invitation, error: null })
    const gateway = createMerchantGateway({ functions: { invoke } })
    await expect(gateway.createInvitation(input)).rejects.toThrow('may already have been processed')
    await gateway.createInvitation(input)
    await gateway.createInvitation(input)
    const bodies = invoke.mock.calls.map((call) => call[1].body)
    expect(bodies[0].request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(bodies[1].request_id).toBe(bodies[0].request_id)
    expect(bodies[2].request_id).not.toBe(bodies[0].request_id)
  })
  it('resends with one stable request identity across a lost response, and copy lookup sends no email action', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: {} })
      .mockResolvedValue({ data: invitation, error: null })
    const gateway = createMerchantGateway({ functions: { invoke } })
    await expect(gateway.resendInvitation('invite-1')).rejects.toThrow('could not be confirmed')
    await gateway.resendInvitation('invite-1')
    expect(invoke.mock.calls[0][1].body).toEqual(invoke.mock.calls[1][1].body)
    expect(invoke.mock.calls[1][1].body).toMatchObject({
      action: 'resend_invitation',
      invitation_id: 'invite-1',
    })
    await gateway.invitationLink('invite-1')
    expect(invoke).toHaveBeenLastCalledWith('merchant-connect', {
      body: { action: 'get_invitation_link', invitation_id: 'invite-1' },
    })
  })
  it.each([
    { delivery: { ...invitation.delivery, status: 'delivered' } },
    { delivery: { ...invitation.delivery, retry_at: 'invalid' } },
    { delivery: { ...invitation.delivery, can_retry: 'true' } },
    {
      invitation_url: `https://partners.kissmyapps.dev/merchant/connect#invite=${'a'.repeat(64)}&next=admin`,
    },
  ])('rejects malformed invitation response %j', async (patch) => {
    const gateway = createMerchantGateway({
      functions: {
        invoke: vi.fn(async () => ({ data: { ...invitation, ...patch }, error: null })),
      },
    })
    await expect(gateway.createInvitation(input)).rejects.toThrow('could not be verified')
  })
  it('validates persisted workspace email state before rendering it', async () => {
    const value = workspace({
      ...invitation,
      delivery: { ...invitation.delivery, status: 'delivered' as 'sent' },
    })
    const gateway = createMerchantGateway({
      functions: { invoke: vi.fn(async () => ({ data: value, error: null })) },
    })
    await expect(gateway.status()).rejects.toThrow('email status could not be verified')
  })
})
