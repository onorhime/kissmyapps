import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MerchantConnectionPage } from './MerchantConnectionPage'
import {
  createMerchantGateway,
  MerchantGatewayError,
  type MerchantGateway,
  type MerchantInvitationCode,
} from './gateway'
import { clearInvitationCodeRequest, invitationCodeRequestId } from './invitationCodeRequest'

const auth = vi.hoisted(() => ({
  state: { status: 'anonymous', user: null as { id: string; email: string } | null, message: null },
}))
vi.mock('../auth/authSession', () => ({ useAuthSession: () => auth.state }))
let token = ''
let sequence = 0
function delivery(
  status: MerchantInvitationCode['status'] = 'sent',
  delay = 0,
): MerchantInvitationCode {
  return {
    email: 'invited@example.test',
    expires_at: '2099-01-01T00:00:00Z',
    status,
    retry_at: new Date(Date.now() + delay).toISOString(),
  }
}
function setup(result = delivery()) {
  const gateway = {
    requestInvitationCode: vi.fn(async () => result),
    inspectInvitation: vi.fn(async () => ({
      merchant_id: 'merchant',
      invitation_id: 'invitation',
      business_name: 'Example',
      email: result.email,
      platform_account_id: 'acct_Platform',
      livemode: false,
      status: 'claimed',
      candidate: null,
    })),
    startConnection: vi.fn(),
    completeConnection: vi.fn(),
    connectionStatus: vi.fn(),
    refreshConnection: vi.fn(),
    confirmConnection: vi.fn(),
  } as unknown as MerchantGateway
  const client = {
    auth: {
      signInWithOtp: vi.fn(async () => ({ error: null })),
      verifyOtp: vi.fn(async () => ({ data: { session: {} }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient
  return { gateway, client }
}
beforeEach(() => {
  token = `test-${++sequence}-`.padEnd(64, 'a')
  sessionStorage.clear()
  history.replaceState(null, '', `/merchant/connect#invite=${token}`)
  auth.state = { status: 'anonymous', user: null, message: null }
})

describe('Invitation-bound automatic email verification', () => {
  it('automatically requests the invited address once under StrictMode and scrubs the link', async () => {
    const { client, gateway } = setup(delivery('sent', 60000))
    render(
      <StrictMode>
        <MerchantConnectionPage client={client} gateway={gateway} />
      </StrictMode>,
    )
    expect(await screen.findByLabelText('Verification code')).toBeVisible()
    expect(screen.getByText('invited@example.test')).toBeVisible()
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
    expect(gateway.requestInvitationCode).toHaveBeenCalledTimes(1)
    expect(gateway.requestInvitationCode).toHaveBeenCalledWith(
      token,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    )
    expect(client.auth.signInWithOtp).not.toHaveBeenCalled()
    expect(gateway.inspectInvitation).not.toHaveBeenCalled()
    expect(location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeDisabled()
  })

  it('reuses the persisted operation on a page remount and only renews for an explicit resend', async () => {
    const { client, gateway } = setup()
    const first = render(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByLabelText('Verification code')
    first.unmount()
    render(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByLabelText('Verification code')
    const calls = vi.mocked(gateway.requestInvitationCode).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resend code' }))
    expect(calls).toHaveLength(3)
    expect(calls[2][1]).not.toBe(calls[1][1])
  })

  it('waits for anonymous auth and a visible page, then retains a typed code through tab visibility changes', async () => {
    auth.state.status = 'loading'
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const { client, gateway } = setup()
    const view = render(<MerchantConnectionPage client={client} gateway={gateway} />)
    expect(gateway.requestInvitationCode).not.toHaveBeenCalled()
    auth.state.status = 'anonymous'
    view.rerender(<MerchantConnectionPage client={client} gateway={gateway} />)
    expect(gateway.requestInvitationCode).not.toHaveBeenCalled()
    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    const input = await screen.findByLabelText('Verification code')
    fireEvent.change(input, { target: { value: '1234' } })
    visibility = 'hidden'
    fireEvent(document, new Event('visibilitychange'))
    visibility = 'visible'
    fireEvent(document, new Event('visibilitychange'))
    expect(input).toHaveValue('1234')
    expect(gateway.requestInvitationCode).toHaveBeenCalledTimes(1)
  })

  it('does not request a code for a signed-in wrong account until it is switched', async () => {
    auth.state = {
      status: 'authenticated',
      user: { id: 'wrong', email: 'wrong@example.test' },
      message: null,
    }
    const { client, gateway } = setup()
    vi.mocked(gateway.inspectInvitation).mockRejectedValueOnce(
      Error('Sign in with the email address that received this merchant invitation.'),
    )
    const view = render(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByRole('alert')
    expect(gateway.requestInvitationCode).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Switch account' }))
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    auth.state = { status: 'anonymous', user: null, message: null }
    view.rerender(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByLabelText('Verification code')
    expect(gateway.requestInvitationCode).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('wrong@example.test')).not.toBeInTheDocument()
  })

  it.each(['unknown', 'cooldown', 'failed'] as const)(
    'keeps code entry and a fixed address for %s while obeying server cooldown',
    async (status) => {
      const { client, gateway } = setup(delivery(status, 3600000))
      render(<MerchantConnectionPage client={client} gateway={gateway} />)
      await screen.findByLabelText('Verification code')
      expect(screen.getByText('invited@example.test')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Resend code' })).toBeDisabled()
      expect(screen.getByText(/You can resend a code in 3600 seconds/)).toBeVisible()
      expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
      if (status === 'unknown')
        expect(screen.getByRole('status')).toHaveTextContent('could not confirm whether')
      if (status === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('could not send')
    },
  )

  it('unlocks resend at the server retry time and blocks duplicate clicks while sending', async () => {
    const { client, gateway } = setup(delivery('sent', 600))
    render(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByLabelText('Verification code')
    const button = screen.getByRole('button', { name: 'Resend code' })
    expect(button).toBeDisabled()
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2000 })
    let finish!: (value: MerchantInvitationCode) => void
    vi.mocked(gateway.requestInvitationCode).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(gateway.requestInvitationCode).toHaveBeenCalledTimes(2))
    expect(button).toBeDisabled()
    await act(async () => finish(delivery('sent', 60000)))
    expect(gateway.requestInvitationCode).toHaveBeenCalledTimes(2)
  })

  it('retries an ambiguous resend with the same operation instead of sending another email', async () => {
    const { client, gateway } = setup()
    render(<MerchantConnectionPage client={client} gateway={gateway} />)
    await screen.findByLabelText('Verification code')
    vi.mocked(gateway.requestInvitationCode).mockRejectedValueOnce(
      Error('The request could not be confirmed.'),
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resend code' }))
    await screen.findByRole('alert')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry code request' }))
    const calls = vi.mocked(gateway.requestInvitationCode).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[1]).toEqual(calls[2])
    expect(calls[0][1]).not.toBe(calls[1][1])
  })

  it.each(['invitation_unavailable', 'invalid_input'])(
    'requires a new link for terminal %s without a retry loop',
    async (code) => {
      const { client, gateway } = setup()
      vi.mocked(gateway.requestInvitationCode).mockRejectedValue(
        new MerchantGatewayError('This invitation is unavailable.', code),
      )
      render(<MerchantConnectionPage client={client} gateway={gateway} />)
      expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
      expect(screen.getByText(/No sign-in code can be sent/)).toBeVisible()
      expect(screen.queryByRole('button', { name: /Retry code|Resend/ })).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
      expect(gateway.inspectInvitation).not.toHaveBeenCalled()
    },
  )

  it('retains manual email recovery for a signed-out OAuth callback that has no invitation token', async () => {
    history.replaceState(null, '', '/merchant/callback?state=state123&code=code123')
    const { client, gateway } = setup()
    render(<MerchantConnectionPage client={client} gateway={gateway} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email address'), 'owner@example.test')
    await user.click(screen.getByRole('button', { name: 'Send verification code' }))
    expect(client.auth.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.test' }),
    )
    expect(gateway.requestInvitationCode).not.toHaveBeenCalled()
    expect(location.search).toBe('')
  })
})

describe('Invitation code request boundary', () => {
  it('stores a hashed invitation key with only an operation ID and expiry', async () => {
    const id = await invitationCodeRequestId(token)
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith('kma:merchant-code-request:'),
    )!
    expect(key).toMatch(/^kma:merchant-code-request:[0-9a-f]{64}$/)
    expect(key).not.toContain(token)
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      requestId: id,
      expiresAt: expect.any(Number),
    })
    expect(await invitationCodeRequestId(token)).toBe(id)
    await clearInvitationCodeRequest(token)
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(await invitationCodeRequestId(token)).not.toBe(id)
  })

  it('sends no editable email and validates the anonymous response', async () => {
    const invoke = vi.fn(async () => ({ data: delivery(), error: null }))
    const gateway = createMerchantGateway({ functions: { invoke } })
    const requestId = crypto.randomUUID()
    await expect(gateway.requestInvitationCode(token, requestId)).resolves.toMatchObject({
      email: 'invited@example.test',
    })
    expect(invoke).toHaveBeenCalledWith('merchant-connect', {
      body: { action: 'request_invitation_code', invite_token: token, request_id: requestId },
    })
    invoke.mockResolvedValueOnce({ data: { ...delivery(), email: '' }, error: null })
    await expect(gateway.requestInvitationCode(token, requestId)).rejects.toThrow('incomplete')
  })

  it('preserves terminal server error identity for the new-link recovery UI', async () => {
    const invoke = vi.fn(async () => ({
      data: null,
      error: {
        context: new Response(JSON.stringify({ error: 'invitation_unavailable' }), { status: 403 }),
      },
    }))
    const gateway = createMerchantGateway({ functions: { invoke } })
    await expect(gateway.requestInvitationCode(token, crypto.randomUUID())).rejects.toMatchObject({
      code: 'invitation_unavailable',
      message: expect.stringContaining('new link'),
    })
  })
})
