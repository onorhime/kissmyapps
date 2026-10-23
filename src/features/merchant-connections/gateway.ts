import { supabase } from '../../lib/supabase'
import type { InvitationDeliveryStatus } from './invitationDelivery'

export type MerchantBinding = { id: string; platform_account_id: string; livemode: boolean }
export type MerchantAccount = {
  account_id: string
  business_name: string
  country: string | null
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
}
export type MerchantConnection = {
  merchant_id: string
  business_name: string
  email: string
  platform_account_id: string
  livemode: boolean
  status: string
  candidate: MerchantAccount | null
  account_id?: string | null
  expires_at?: string
  invitation_id?: string
}
export type MerchantWorkspace = {
  merchants: {
    id: string
    business_name: string
    email: string
    connections: (MerchantAccount & {
      id: string
      merchant_id: string
      status: 'pending' | 'active' | 'revoked'
      platform_account_id: string
      livemode: boolean
      verified_at: string | null
      latest_invitation?: MerchantInvitationSummary | null
    })[]
  }[]
  assignments: { product_id: string; connection_id: string; livemode: boolean }[]
}
export type MerchantStatus = {
  enabled: boolean
  bindings: MerchantBinding[]
  workspace: MerchantWorkspace
}
export type MerchantInvitationDelivery = {
  status: InvitationDeliveryStatus
  recipient: string
  retry_at: string | null
  can_retry: boolean
}
export type MerchantInvitationSummary = {
  invitation_id: string
  expires_at: string
  status: string
  delivery: MerchantInvitationDelivery
  can_copy?: boolean
}
export type MerchantInvitation = MerchantInvitationSummary & {
  merchant_id: string
  invitation_url: string
}

export type MerchantInvitationCode = {
  email: string
  expires_at: string
  status: 'sent' | 'cooldown' | 'unknown' | 'failed'
  retry_at: string
}
export class MerchantGatewayError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'MerchantGatewayError'
    this.code = code
  }
}

export type MerchantGateway = {
  requestInvitationCode(token: string, requestId: string): Promise<MerchantInvitationCode>
  status(): Promise<MerchantStatus>
  createInvitation(input: {
    binding_id: string
    business_name: string
    email: string
    merchant_id?: string
  }): Promise<MerchantInvitation>
  resendInvitation(invitationId: string): Promise<MerchantInvitation>
  invitationLink(invitationId: string): Promise<MerchantInvitation>
  assignProduct(productId: string, merchantId: string, livemode: boolean): Promise<void>
  revoke(merchantId: string, livemode: boolean): Promise<void>
  inspectInvitation(token: string): Promise<MerchantConnection>
  startConnection(token: string): Promise<string>
  completeConnection(
    state: string,
    code: string,
  ): Promise<{ invitation_id: string; connection: MerchantConnection }>
  connectionStatus(invitationId: string): Promise<MerchantConnection>
  refreshConnection(invitationId: string): Promise<MerchantConnection>
  confirmConnection(invitationId: string): Promise<MerchantConnection>
}

export type MerchantClient = {
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> },
    ): PromiseLike<{ data: unknown; error: { context?: unknown } | null }>
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('The merchant connection response could not be verified.')
  return value as Record<string, unknown>
}
const string = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim())
    throw Error('The merchant connection response is incomplete.')
  return value
}
function readInvitationSummary(value: unknown): MerchantInvitationSummary {
  const response = record(value)
  string(response.invitation_id)
  string(response.status)
  if (!Number.isFinite(Date.parse(string(response.expires_at))))
    throw Error('The merchant invitation expiry could not be verified.')
  const delivery = record(response.delivery)
  if (
    !['not_sent', 'sending', 'sent', 'failed', 'unknown', 'disabled'].includes(
      string(delivery.status),
    ) ||
    typeof delivery.can_retry !== 'boolean' ||
    (delivery.retry_at !== null &&
      (typeof delivery.retry_at !== 'string' || !Number.isFinite(Date.parse(delivery.retry_at)))) ||
    (response.can_copy !== undefined && typeof response.can_copy !== 'boolean')
  )
    throw Error('The invitation email status could not be verified.')
  string(delivery.recipient)
  return response as unknown as MerchantInvitationSummary
}
function readInvitation(value: unknown): MerchantInvitation {
  const response = record(value)
  readInvitationSummary(response)
  const url = new URL(string(response.invitation_url))
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.pathname !== '/merchant/connect' ||
    !/^#invite=[A-Za-z0-9_-]{32,256}$/.test(url.hash)
  )
    throw Error('The merchant invitation link could not be verified.')
  string(response.merchant_id)
  return response as unknown as MerchantInvitation
}
export function readConnection(value: unknown): MerchantConnection {
  const row = record(value)
  string(row.status)
  if (typeof row.livemode !== 'boolean')
    throw Error('The Stripe environment could not be verified.')
  if (row.candidate != null) {
    const candidate = record(row.candidate)
    if (
      !/^acct_[A-Za-z0-9]+$/.test(string(candidate.account_id)) ||
      typeof candidate.business_name !== 'string' ||
      ['charges_enabled', 'payouts_enabled', 'details_submitted'].some(
        (key) => typeof candidate[key] !== 'boolean',
      )
    ) {
      throw Error('The Stripe business account could not be verified.')
    }
  }
  return row as unknown as MerchantConnection
}

const messages: Record<string, string> = {
  invitation_unavailable:
    'This invitation is unavailable. Ask your KMA administrator for a new link.',
  merchant_binding_unavailable:
    'Merchant sign-in is temporarily unavailable. Contact your KMA administrator.',
  origin_rejected: 'Open your secure invitation on the KissMyApps website to continue.',
  invitation_expired: 'This invitation has expired. Ask your KMA administrator for a new link.',
  invitation_revoked: 'This invitation was revoked. Ask your KMA administrator for a new link.',
  invite_email_mismatch: 'Sign in with the email address that received this merchant invitation.',
  email_mismatch: 'Sign in with the email address that received this merchant invitation.',
  not_authenticated: 'Verify your email address to continue.',
  not_authorized: 'This account cannot manage this merchant connection.',
  email_not_verified: 'Verify your email address before connecting Stripe.',
  oauth_state_invalid:
    'This Stripe connection attempt expired or was already used. Open the invitation and start again.',
  not_configured: 'Merchant connections are not configured yet. Contact your KMA administrator.',
}

export function createMerchantGateway(client: MerchantClient | null = supabase): MerchantGateway {
  const pendingRequests = new Map<string, string>()
  async function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!client) throw new MerchantGatewayError(messages.not_configured, 'not_configured')
    const invitationWrite = ['create_invitation', 'resend_invitation'].includes(String(body.action))
    const codeWrite = body.action === 'request_invitation_code'
    const uncertainMessage = codeWrite
      ? 'We could not confirm your code request. Try again to check the same request safely.'
      : 'The invitation request could not be confirmed. It may already have been processed. Retry the same action to check it safely, or reload connections.'
    let response
    try {
      response = await client.functions.invoke('merchant-connect', { body })
    } catch (reason) {
      if (invitationWrite || codeWrite) throw Error(uncertainMessage)
      throw reason
    }
    if (response.error) {
      let failure: Record<string, unknown> = {}
      if (response.error.context instanceof Response) {
        try {
          failure = record(await response.error.context.clone().json())
        } catch {
          /* Generic error below. */
        }
      }
      if ((invitationWrite || codeWrite) && !failure.error && !failure.message)
        throw Error(uncertainMessage)
      throw new MerchantGatewayError(
        messages[String(failure.error)] ??
          (typeof failure.message === 'string'
            ? failure.message
            : 'The merchant connection could not be updated. Please retry.'),
        typeof failure.error === 'string' ? failure.error : 'request_unconfirmed',
      )
    }
    return record(response.data)
  }
  async function invitationRequest(body: Record<string, unknown>): Promise<MerchantInvitation> {
    const key = JSON.stringify(body)
    const requestId = pendingRequests.get(key) ?? crypto.randomUUID()
    pendingRequests.set(key, requestId)
    const response = readInvitation(await request({ ...body, request_id: requestId }))
    pendingRequests.delete(key)
    return response
  }
  return {
    async requestInvitationCode(token, requestId) {
      const response = await request({
        action: 'request_invitation_code',
        invite_token: token,
        request_id: requestId,
      })
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(string(response.email)) ||
        !['sent', 'cooldown', 'unknown', 'failed'].includes(string(response.status)) ||
        !Number.isFinite(Date.parse(string(response.expires_at))) ||
        !Number.isFinite(Date.parse(string(response.retry_at)))
      )
        throw Error('The invitation verification response could not be verified.')
      return response as unknown as MerchantInvitationCode
    },
    async status() {
      const response = await request({ action: 'status' })
      const workspace = record(response.workspace)
      if (
        typeof response.enabled !== 'boolean' ||
        !Array.isArray(response.bindings) ||
        !Array.isArray(workspace.merchants) ||
        !Array.isArray(workspace.assignments)
      )
        throw Error('Merchant connections could not be verified.')
      for (const merchant of workspace.merchants) {
        const row = record(merchant)
        if (!Array.isArray(row.connections))
          throw Error('Merchant connections could not be verified.')
        for (const connection of row.connections) {
          const latest = record(connection).latest_invitation
          if (latest != null) readInvitationSummary(latest)
        }
      }
      return response as unknown as MerchantStatus
    },
    async createInvitation(input) {
      return invitationRequest({ action: 'create_invitation', ...input })
    },
    async resendInvitation(invitationId) {
      return invitationRequest({ action: 'resend_invitation', invitation_id: invitationId })
    },
    async invitationLink(invitationId) {
      return readInvitation(
        await request({ action: 'get_invitation_link', invitation_id: invitationId }),
      )
    },
    async assignProduct(productId, merchantId, livemode) {
      await request({
        action: 'assign_product',
        product_id: productId,
        merchant_id: merchantId,
        livemode,
      })
    },
    async revoke(merchantId, livemode) {
      await request({ action: 'revoke', merchant_id: merchantId, livemode })
    },
    async inspectInvitation(token) {
      return readConnection(
        (await request({ action: 'inspect_invitation', invite_token: token })).invitation,
      )
    },
    async startConnection(token) {
      const response = await request({ action: 'start_connection', invite_token: token })
      const url = new URL(string(response.authorization_url))
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'connect.stripe.com' ||
        url.pathname !== '/oauth/authorize'
      )
        throw Error('The Stripe authorisation link could not be verified.')
      return url.toString()
    },
    async completeConnection(state, code) {
      const response = await request({ action: 'complete_connection', state, code })
      return {
        invitation_id: string(response.invitation_id),
        connection: readConnection(response.connection),
      }
    },
    async connectionStatus(invitationId) {
      return readConnection(
        (await request({ action: 'connection_status', invitation_id: invitationId })).connection,
      )
    },
    async refreshConnection(invitationId) {
      return readConnection(
        (await request({ action: 'refresh_connection', invitation_id: invitationId })).connection,
      )
    },
    async confirmConnection(invitationId) {
      return readConnection(
        (await request({ action: 'confirm_connection', invitation_id: invitationId })).connection,
      )
    },
  }
}

export const merchantGateway = createMerchantGateway()
