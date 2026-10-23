import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MerchantConnectionPage } from './MerchantConnectionPage'
import { MerchantConnectionsSection } from './MerchantConnectionsSection'
import {
  createMerchantGateway,
  type MerchantConnection,
  type MerchantGateway,
  type MerchantStatus,
} from './gateway'
import { captureMerchantEntry, isMerchantRoute } from './routing'
import App from '../../App'

const auth = vi.hoisted(() => ({
  state: {
    status: 'authenticated',
    user: { id: 'merchant-user', email: 'owner@example.test' },
    message: null,
  } as { status: string; user: { id: string; email: string } | null; message: null },
}))
vi.mock('../auth/authSession', () => ({ useAuthSession: () => auth.state }))
const token = 'a'.repeat(64)
const account = {
  account_id: 'acct_SpeakSix',
  business_name: 'SpeakSix Ltd',
  country: 'US',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
}
const context: MerchantConnection = {
  merchant_id: 'merchant-1',
  invitation_id: 'invitation-1',
  business_name: 'SpeakSix',
  email: 'owner@example.test',
  platform_account_id: 'acct_KMA',
  livemode: false,
  status: 'claimed',
  candidate: null,
}
const status: MerchantStatus = {
  enabled: true,
  bindings: [{ id: 'binding-test', platform_account_id: 'acct_KMA', livemode: false }],
  workspace: {
    merchants: [
      {
        id: 'merchant-1',
        business_name: 'SpeakSix',
        email: 'owner@example.test',
        connections: [
          {
            ...account,
            id: 'connection-1',
            merchant_id: 'merchant-1',
            platform_account_id: 'acct_KMA',
            livemode: false,
            status: 'active',
            verified_at: '2026-10-17T00:00:00Z',
          },
        ],
      },
    ],
    assignments: [],
  },
}
function gateway(): MerchantGateway {
  return {
    requestInvitationCode: vi.fn(async () => ({
      email: 'owner@example.test',
      expires_at: '2099-01-01T00:00:00Z',
      status: 'sent' as const,
      retry_at: new Date(Date.now() - 1000).toISOString(),
    })),
    status: vi.fn(async () => status),
    createInvitation: vi.fn(async () => ({
      invitation_id: 'invitation-1',
      merchant_id: 'merchant-1',
      expires_at: '2026-12-01T00:00:00Z',
      status: 'invited',
      delivery: {
        status: 'sent' as const,
        recipient: 'owner@example.test',
        retry_at: null,
        can_retry: true,
      },
      invitation_url: `https://partners.kissmyapps.dev/merchant/connect#invite=${token}`,
    })),
    resendInvitation: vi.fn(async () => {
      throw Error('Not mocked')
    }),
    invitationLink: vi.fn(async () => {
      throw Error('Not mocked')
    }),
    assignProduct: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    inspectInvitation: vi.fn(async () => context),
    startConnection: vi.fn(async () => 'https://connect.stripe.com/oauth/authorize?state=opaque'),
    completeConnection: vi.fn(async () => ({
      invitation_id: 'invitation-1',
      connection: { ...context, candidate: account },
    })),
    connectionStatus: vi.fn(async () => ({ ...context, candidate: account })),
    refreshConnection: vi.fn(async () => ({ ...context, candidate: account })),
    confirmConnection: vi.fn(async () => ({ ...context, status: 'connected', candidate: account })),
  }
}
beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', `/merchant/connect#invite=${token}`)
  auth.state = {
    status: 'authenticated',
    user: { id: 'merchant-user', email: 'owner@example.test' },
    message: null,
  }
})

describe('Merchant route boundary', () => {
  it('allows only the two isolated paths and scrubs sensitive OAuth parameters', () => {
    expect(isMerchantRoute('/merchant/connect')).toBe(true)
    expect(isMerchantRoute('/merchant/callback')).toBe(true)
    expect(isMerchantRoute('/merchant/connect/admin')).toBe(false)
    window.history.replaceState(
      null,
      '',
      '/merchant/callback?code=ac_secret123&state=opaque_secret#admin/overview',
    )
    expect(captureMerchantEntry().callback).toEqual({
      code: 'ac_secret123',
      state: 'opaque_secret',
    })
    expect(window.location.href).not.toContain('ac_secret')
    expect(window.location.hash).toBe('')
  })
  it('does not reuse another invitation’s pending callback', () => {
    window.history.replaceState(
      null,
      '',
      '/merchant/callback?code=ac_secret123&state=opaque_secret',
    )
    captureMerchantEntry()
    window.history.replaceState(null, '', `/merchant/connect#invite=${token}`)
    expect(captureMerchantEntry()).toMatchObject({
      invite: token,
      callback: null,
      invitationId: null,
    })
  })
  it('does not render admin or creator activation inside the limited route', async () => {
    auth.state = { status: 'anonymous', user: null, message: null }
    window.history.replaceState(null, '', `/merchant/connect#invite=${token}&admin/overview`)
    render(<App previewMode={false} authClient={null} workspaceHostname="admin.kissmyapps.dev" />)
    expect(
      screen.getByRole('heading', { name: 'Connect your business to KissMyApps' }),
    ).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByText('Activate your partner account')).not.toBeInTheDocument()
  })
})

describe('Merchant recipient setup', () => {
  it('requires verified sign-in before inspecting the invitation', async () => {
    auth.state = { status: 'anonymous', user: null, message: null }
    const service = gateway()
    const client = {
      auth: {
        signInWithOtp: vi.fn(async () => ({ error: null })),
        verifyOtp: vi.fn(async () => ({ data: { session: {} }, error: null })),
      },
    } as unknown as SupabaseClient
    render(<MerchantConnectionPage client={client} gateway={service} />)
    const user = userEvent.setup()
    await screen.findByLabelText('Verification code')
    expect(client.auth.signInWithOtp).not.toHaveBeenCalled()
    expect(service.requestInvitationCode).toHaveBeenCalledWith(token, expect.any(String))
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
    expect(service.inspectInvitation).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify email' }))
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'owner@example.test',
      token: '123456',
      type: 'email',
    })
  })
  it('pastes the complete hosted eight-digit code, preserves leading zeroes and waits for verified auth', async () => {
    auth.state = { status: 'anonymous', user: null, message: null }
    const service = gateway()
    const client = {
      auth: {
        signInWithOtp: vi.fn(async () => ({ error: null })),
        verifyOtp: vi.fn(async () => ({ data: { session: {} }, error: null })),
      },
    } as unknown as SupabaseClient
    const user = userEvent.setup()
    const view = render(<MerchantConnectionPage client={client} gateway={service} />)
    await screen.findByLabelText('Verification code')
    const input = screen.getByLabelText('Verification code')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')
    expect(input).toHaveAttribute('inputmode', 'numeric')
    await user.click(input)
    await user.paste('00 123 456\n')
    expect(input).toHaveValue('00123456')
    await user.click(screen.getByRole('button', { name: 'Verify email' }))
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'owner@example.test',
      token: '00123456',
      type: 'email',
    })
    expect(service.inspectInvitation).not.toHaveBeenCalled()
    auth.state = {
      status: 'authenticated',
      user: { id: 'merchant-user', email: 'owner@example.test' },
      message: null,
    }
    view.rerender(<MerchantConnectionPage client={client} gateway={service} />)
    await waitFor(() => expect(service.inspectInvitation).toHaveBeenCalledWith(token))
  })

  it.each(['', '12345', '1234567', '123456789', '123456x', '12345678x', '１２３４５６７８'])(
    'rejects malformed code %j without truncating or calling Auth',
    async (invalidCode) => {
      auth.state = { status: 'anonymous', user: null, message: null }
      const service = gateway()
      const client = {
        auth: {
          signInWithOtp: vi.fn(async () => ({ error: null })),
          verifyOtp: vi.fn(),
        },
      } as unknown as SupabaseClient
      render(<MerchantConnectionPage client={client} gateway={service} />)
      await screen.findByLabelText('Verification code')
      const input = screen.getByLabelText('Verification code')
      fireEvent.change(input, { target: { value: invalidCode } })
      expect(input).toHaveValue(invalidCode)
      expect(screen.getByRole('button', { name: 'Verify email' })).toBeDisabled()
      // Also guard programmatic/keyboard form submissions, beyond the button state.
      fireEvent.submit(input.closest('form')!)
      expect(await screen.findByRole('alert')).toHaveTextContent('complete numeric code')
      expect(client.auth.verifyOtp).not.toHaveBeenCalled()
      expect(service.inspectInvitation).not.toHaveBeenCalled()
    },
  )

  it.each(['invalid', 'expired', 'missing session'])(
    'does not advance on an Auth %s response and allows a fresh code request',
    async (reason) => {
      auth.state = { status: 'anonymous', user: null, message: null }
      const service = gateway()
      const client = {
        auth: {
          signInWithOtp: vi.fn(async () => ({ error: null })),
          verifyOtp: vi.fn(async () => ({
            data: { session: null },
            error: reason === 'missing session' ? null : { message: reason },
          })),
        },
      } as unknown as SupabaseClient
      const user = userEvent.setup()
      render(<MerchantConnectionPage client={client} gateway={service} />)
      await screen.findByLabelText('Verification code')
      await user.type(screen.getByLabelText('Verification code'), '12345678')
      await user.click(screen.getByRole('button', { name: 'Verify email' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('invalid or expired')
      expect(service.inspectInvitation).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: 'Connect with Stripe' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Resend code' }))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(service.requestInvitationCode).toHaveBeenCalledTimes(2)
      expect(screen.getByLabelText('Verification code')).toHaveValue('')
      expect(screen.getByRole('button', { name: 'Verify email' })).toBeDisabled()
    },
  )

  it('shows an unconfirmed request without inspecting an invitation and allows a safe retry', async () => {
    auth.state = { status: 'anonymous', user: null, message: null }
    const service = gateway()
    vi.mocked(service.requestInvitationCode).mockRejectedValueOnce(
      Error('We could not confirm your code request.'),
    )
    const client = { auth: {} } as unknown as SupabaseClient
    render(<MerchantConnectionPage client={client} gateway={service} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm')
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
    expect(service.inspectInvitation).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry code request' }))
    await screen.findByLabelText('Verification code')
    const calls = vi.mocked(service.requestInvitationCode).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  })
  it('surfaces wrong-email failure without exposing Stripe connection controls', async () => {
    const service = gateway()
    vi.mocked(service.inspectInvitation).mockRejectedValue(
      Error('Sign in with the email address that received this merchant invitation.'),
    )
    render(<MerchantConnectionPage client={null} gateway={service} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('email address that received')
    expect(screen.queryByRole('button', { name: 'Connect with Stripe' })).not.toBeInTheDocument()
    expect(service.startConnection).not.toHaveBeenCalled()
  })
  it('shows revoked and expired invitations without allowing connection', async () => {
    const service = gateway()
    vi.mocked(service.inspectInvitation).mockResolvedValue({ ...context, status: 'expired' })
    render(<MerchantConnectionPage client={null} gateway={service} />)
    expect(await screen.findByText(/This invitation is expired/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Connect with Stripe' })).not.toBeInTheDocument()
  })
  it('requires explicit confirmation of the exact returned account after callback', async () => {
    window.history.replaceState(
      null,
      '',
      '/merchant/callback?code=ac_secret123&state=opaque_secret',
    )
    const service = gateway()
    render(<MerchantConnectionPage client={null} gateway={service} />)
    expect(await screen.findByText('acct_SpeakSix')).toBeVisible()
    expect(service.confirmConnection).not.toHaveBeenCalled()
    expect(service.completeConnection).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('')
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Confirm this business account' }))
    expect(service.confirmConnection).toHaveBeenCalledWith('invitation-1')
    expect(await screen.findByRole('heading', { name: 'Business account connected' })).toBeVisible()
    expect(sessionStorage.getItem('kma:merchant-connection')).toBeNull()
  })
  it('refreshes incomplete provider requirements without accepting an unverified account', async () => {
    const service = gateway()
    vi.mocked(service.inspectInvitation).mockResolvedValue({
      ...context,
      candidate: { ...account, payouts_enabled: false },
    })
    render(<MerchantConnectionPage client={null} gateway={service} />)
    expect(
      await screen.findByRole('button', { name: 'Confirm this business account' }),
    ).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh account status' }))
    expect(service.refreshConnection).toHaveBeenCalledWith('invitation-1')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm this business account' })).toBeEnabled(),
    )
    expect(service.confirmConnection).not.toHaveBeenCalled()
  })
  it('can retry a callback under the correct verified identity after a rejected wrong-user attempt', async () => {
    window.history.replaceState(
      null,
      '',
      '/merchant/callback?code=ac_secret123&state=opaque_secret',
    )
    const service = gateway()
    vi.mocked(service.completeConnection).mockRejectedValueOnce(
      Error('This invitation is unavailable for this signed-in account.'),
    )
    const view = render(<MerchantConnectionPage client={null} gateway={service} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'unavailable for this signed-in account',
    )
    auth.state = {
      ...auth.state,
      user: { id: 'correct-invited-user', email: 'owner@example.test' },
    }
    view.rerender(<MerchantConnectionPage client={null} gateway={service} />)
    expect(await screen.findByText('acct_SpeakSix')).toBeVisible()
    expect(service.completeConnection).toHaveBeenCalledTimes(2)
    expect(service.confirmConnection).not.toHaveBeenCalled()
  })
})

describe('Admin merchant configuration', () => {
  it('reissues only the explicitly reviewed existing merchant identity and mode', async () => {
    const service = gateway(),
      user = userEvent.setup()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={service} />)
    await user.click(await screen.findByRole('button', { name: 'Create new invitation' }))
    expect(service.createInvitation).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Review merchant change' })).toHaveTextContent(
      'owner@example.test',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm new invitation' }))
    expect(service.createInvitation).toHaveBeenCalledWith({
      merchant_id: 'merchant-1',
      binding_id: 'binding-test',
      business_name: 'SpeakSix',
      email: 'owner@example.test',
    })
    expect(await screen.findByLabelText('Secure invitation link')).toHaveValue(
      `https://partners.kissmyapps.dev/merchant/connect#invite=${token}`,
    )
    expect(service.assignProduct).not.toHaveBeenCalled()
    expect(service.revoke).not.toHaveBeenCalled()
  })
  it('shows no replacement invitation when reissue fails', async () => {
    const service = gateway(),
      user = userEvent.setup()
    vi.mocked(service.createInvitation).mockRejectedValue(Error('The invitation was not created.'))
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={service} />)
    await user.click(await screen.findByRole('button', { name: 'Create new invitation' }))
    await user.click(screen.getByRole('button', { name: 'Confirm new invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The invitation was not created')
    expect(screen.queryByLabelText('Secure invitation link')).not.toBeInTheDocument()
  })
  it('creates and copies an emailed invitation without enabling checkout', async () => {
    const service = gateway()
    const user = userEvent.setup()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={service} />)
    await screen.findByText('Invite a merchant')
    await user.type(screen.getByLabelText('Business name'), 'SpeakSix')
    await user.type(screen.getByLabelText('Merchant contact email'), 'owner@example.test')
    await user.selectOptions(screen.getByLabelText('Stripe environment'), 'binding-test')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))
    expect(service.createInvitation).toHaveBeenCalledWith({
      binding_id: 'binding-test',
      business_name: 'SpeakSix',
      email: 'owner@example.test',
    })
    expect(await screen.findByLabelText('Secure invitation link')).toHaveValue(
      `https://partners.kissmyapps.dev/merchant/connect#invite=${token}`,
    )
    await user.click(screen.getByRole('button', { name: 'Copy invitation link' }))
    expect(await screen.findByRole('status', { name: 'Merchant action result' })).toHaveTextContent(
      'Invitation link copied',
    )
    expect(service.assignProduct).not.toHaveBeenCalled()
  })
  it('requires review before assigning an exact business and mode', async () => {
    const service = gateway()
    const user = userEvent.setup()
    render(<MerchantConnectionsSection productId="product-1" canManage gateway={service} />)
    await user.click(await screen.findByRole('button', { name: 'Assign to this product' }))
    expect(service.assignProduct).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm assignment' }))
    expect(service.assignProduct).toHaveBeenCalledWith('product-1', 'merchant-1', false)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checkout and payouts have not been enabled',
    )
  })
  it('renders account identity read-only for non-management roles', async () => {
    render(
      <MerchantConnectionsSection productId="product-1" canManage={false} gateway={gateway()} />,
    )
    expect(await screen.findByText('acct_SpeakSix')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Assign to this product' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument()
  })
})

describe('Merchant gateway', () => {
  it('allows only Stripe authorisation URLs and never submits an account ID to confirmation', async () => {
    const invoke = vi.fn(async (_name: string, options: { body: Record<string, unknown> }) => ({
      data:
        options.body.action === 'start_connection'
          ? { authorization_url: 'https://evil.example/oauth/authorize' }
          : { connection: { ...context, status: 'connected' } },
      error: null,
    }))
    const service = createMerchantGateway({ functions: { invoke } })
    await expect(service.startConnection(token)).rejects.toThrow('could not be verified')
    await service.confirmConnection('invitation-1')
    expect(invoke).toHaveBeenLastCalledWith('merchant-connect', {
      body: { action: 'confirm_connection', invitation_id: 'invitation-1' },
    })
  })
  it('does not invent a successful status when the backend is unavailable', async () => {
    const service = createMerchantGateway({
      functions: {
        invoke: async () => ({
          data: null,
          error: {
            context: new Response(
              JSON.stringify({
                error: 'merchant_access_denied',
                message: 'This invitation is unavailable for this signed-in account.',
              }),
              { status: 403 },
            ),
          },
        }),
      },
    })
    await expect(service.inspectInvitation(token)).rejects.toThrow(
      'unavailable for this signed-in account',
    )
  })
})
