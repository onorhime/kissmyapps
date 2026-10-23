import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link2, LoaderCircle, Mail } from 'lucide-react'
import {
  merchantGateway,
  type MerchantGateway,
  type MerchantInvitation,
  type MerchantInvitationSummary,
  type MerchantStatus,
} from './gateway'
import { invitationCooldownSeconds, invitationDeliveryMessage } from './invitationDelivery'
import './merchant-connections.css'

export function MerchantConnectionsSection({
  productId,
  canManage,
  gateway = merchantGateway,
}: {
  productId: string
  canManage: boolean
  gateway?: MerchantGateway
}) {
  const [status, setStatus] = useState<MerchantStatus | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [binding, setBinding] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [invitation, setInvitation] = useState<MerchantInvitation | null>(null)
  const [invitationEmail, setInvitationEmail] = useState('')
  const [revealInvitation, setRevealInvitation] = useState(0)
  const invitationPanel = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now)
  const [review, setReview] = useState<{
    merchantId: string
    connectionId: string
    accountId: string
    name: string
    livemode: boolean
    revoke?: boolean
    renewal?: { email: string; bindingId: string }
  } | null>(null)
  useEffect(() => {
    let active = true
    void gateway
      .status()
      .then((value) => {
        if (active) {
          setStatus(value)
          setInvitation((current) => {
            if (!current) return current
            const latest = value.workspace.merchants
              .flatMap((merchant) => merchant.connections)
              .map((connection) => connection.latest_invitation)
              .find((entry) => entry?.invitation_id === current.invitation_id)
            if (!latest) return current
            return latest.can_copy === false ? null : { ...current, ...latest }
          })
          setError('')
        }
      })
      .catch((reason) => {
        if (active) {
          setStatus(null)
          setError(
            reason instanceof Error ? reason.message : 'Merchant connections could not be loaded.',
          )
        }
      })
    return () => {
      active = false
    }
  }, [gateway, reload])

  useEffect(() => {
    if (!revealInvitation || !invitationPanel.current) return
    invitationPanel.current.focus({ preventScroll: true })
    invitationPanel.current.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [revealInvitation])

  const coolingDown = [
    invitation?.delivery?.retry_at,
    ...(status?.workspace.merchants.flatMap((merchant) =>
      merchant.connections.map((connection) => connection.latest_invitation?.delivery?.retry_at),
    ) ?? []),
  ].some((retryAt) => invitationCooldownSeconds(retryAt, now) > 0)
  useEffect(() => {
    if (!coolingDown) return
    const timer = window.setInterval(() => setNow(Date.now), 1000)
    return () => window.clearInterval(timer)
  }, [coolingDown])

  useEffect(() => {
    const nextRetry = [
      invitation?.delivery.retry_at,
      ...(status?.workspace.merchants.flatMap((merchant) =>
        merchant.connections.map((connection) => connection.latest_invitation?.delivery.retry_at),
      ) ?? []),
    ]
      .map((date) => (date ? Date.parse(date) : 0))
      .filter((date) => date > Date.now())
    if (!nextRetry.length) return
    const timer = window.setTimeout(
      () => setReload((value) => value + 1),
      Math.min(...nextRetry) - Date.now() + 100,
    )
    return () => window.clearTimeout(timer)
  }, [invitation, status])

  function canResend(value: MerchantInvitationSummary) {
    return (
      !['expired', 'revoked', 'connected', 'confirmed'].includes(value.status) &&
      Date.parse(value.expires_at) > now &&
      invitationCooldownSeconds(value.delivery?.retry_at, now) === 0 &&
      value.delivery.can_retry &&
      value.delivery.status !== 'sending'
    )
  }
  function showInvitation(value: MerchantInvitation, recipient: string) {
    setInvitation(value)
    setRevealInvitation((current) => current + 1)
    setInvitationEmail(value.delivery.recipient || recipient)
    setNow(Date.now)
    setStatus((current) =>
      current
        ? {
            ...current,
            workspace: {
              ...current.workspace,
              merchants: current.workspace.merchants.map((merchant) => ({
                ...merchant,
                connections: merchant.connections.map((connection) =>
                  connection.latest_invitation?.invitation_id === value.invitation_id
                    ? {
                        ...connection,
                        latest_invitation: { ...connection.latest_invitation, ...value },
                      }
                    : connection,
                ),
              })),
            },
          }
        : current,
    )
  }

  async function run(action: () => Promise<void>) {
    if (!canManage || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The merchant connection was not changed.',
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      setInvitation(null)
      const created = await gateway.createInvitation({
        binding_id: binding,
        business_name: name.trim(),
        email: email.trim(),
      })
      showInvitation(created, email.trim())
      setName('')
      setEmail('')
      setBinding('')
      setReload((value) => value + 1)
    })
  }
  async function confirm() {
    if (!review) return
    await run(async () => {
      if (review.renewal) {
        setInvitation(null)
        const created = await gateway.createInvitation({
          merchant_id: review.merchantId,
          binding_id: review.renewal.bindingId,
          business_name: review.name,
          email: review.renewal.email,
        })
        showInvitation(created, review.renewal.email)
      } else if (review.revoke) await gateway.revoke(review.merchantId, review.livemode)
      else await gateway.assignProduct(productId, review.merchantId, review.livemode)
      setNotice(
        review.renewal
          ? 'A new invitation link was created. Previous unfinished links no longer work. Its email status is shown below.'
          : review.revoke
            ? 'Merchant connection revoked. New payments through this connection are blocked.'
            : 'Merchant assigned to this product. Checkout and payouts have not been enabled.',
      )
      setReview(null)
      setReload((value) => value + 1)
    })
  }

  async function resend(value: MerchantInvitationSummary, recipient: string) {
    if (!canResend(value) || !status?.enabled) return
    await run(async () => {
      showInvitation(await gateway.resendInvitation(value.invitation_id), recipient)
      setReload((current) => current + 1)
    })
  }

  async function refreshEmailStatus() {
    await run(async () => {
      const value = await gateway.status()
      setStatus(value)
      setNow(Date.now)
      const latest = value.workspace.merchants
        .flatMap((merchant) => merchant.connections)
        .map((connection) => connection.latest_invitation)
        .find((entry) => entry?.invitation_id === invitation?.invitation_id)
      if (latest)
        setInvitation((current) =>
          current && latest.can_copy !== false ? { ...current, ...latest } : null,
        )
    })
  }

  async function viewInvitation(value: MerchantInvitationSummary, recipient: string) {
    await run(async () => {
      showInvitation(await gateway.invitationLink(value.invitation_id), recipient)
    })
  }

  return (
    <section
      className="admin-config-section merchant-config"
      aria-labelledby="merchant-connections-title"
    >
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <Link2 size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">PAYMENT ACCOUNT</p>
          <h2 id="merchant-connections-title">Merchant Stripe connection</h2>
          <p>
            Connect the business that receives this product’s payments. Its funnels reuse the same
            connection. Creator payout accounts are managed separately.
          </p>
          <p>
            Connecting or assigning an account does not enable checkout or payouts. Existing signed
            commission rules apply; unsupported funding policies stop checkout instead of changing
            the agreed terms.
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="merchant-notice merchant-notice-error">
          {error}
          <button
            type="button"
            className="admin-text-button"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload connections
          </button>
        </div>
      )}
      {notice && (
        <p role="status" aria-label="Merchant action result" className="merchant-notice">
          {notice}
        </p>
      )}
      {!status && !error && <p role="status">Loading merchant connections…</p>}
      {status && !status.enabled && (
        <p className="merchant-notice">
          Merchant connections are currently disabled. Saved connections are shown for review;
          connecting an account does not enable checkout.
        </p>
      )}
      {status && (
        <>
          <div className="merchant-account-list">
            {status.workspace.merchants.length === 0 && <p>No merchant accounts connected yet.</p>}
            {status.workspace.merchants.map((merchant) => (
              <article className="merchant-account" key={merchant.id}>
                <h3>{merchant.business_name}</h3>
                <p>{merchant.email}</p>
                {merchant.connections.length === 0 && <p>Awaiting a verified Stripe connection.</p>}
                {merchant.connections.map((connection) => {
                  const assigned = status.workspace.assignments.some(
                    (value) =>
                      value.product_id === productId &&
                      value.connection_id === connection.id &&
                      value.livemode === connection.livemode,
                  )
                  const renewalBinding = status.bindings.find(
                    (value) =>
                      value.platform_account_id === connection.platform_account_id &&
                      value.livemode === connection.livemode,
                  )
                  const eligible =
                    connection.status === 'active' &&
                    connection.charges_enabled &&
                    connection.details_submitted
                  const latest = connection.latest_invitation
                  const remaining = invitationCooldownSeconds(latest?.delivery?.retry_at, now)
                  return (
                    <div className="merchant-account-row" key={connection.id}>
                      <div>
                        <strong>{connection.business_name || merchant.business_name}</strong>
                        <p>
                          <span className="merchant-mode">
                            {connection.livemode ? 'Live' : 'Test'}
                          </span>{' '}
                          <code>{connection.account_id || 'Account not selected'}</code> ·{' '}
                          {connection.status}
                        </p>
                        {latest?.delivery && (
                          <p
                            className={`merchant-delivery-summary merchant-delivery-${latest.delivery.status}`}
                          >
                            {
                              invitationDeliveryMessage(latest.delivery.status, merchant.email)
                                .title
                            }
                          </p>
                        )}
                        {latest &&
                          !latest.can_copy &&
                          !['connected', 'expired', 'revoked'].includes(latest.status) && (
                            <p>
                              This older invitation cannot be copied or resent. Create a new
                              invitation to email this merchant.
                            </p>
                          )}
                        {latest?.can_copy &&
                          latest.delivery.status === 'unknown' &&
                          !latest.delivery.can_retry &&
                          remaining === 0 && (
                            <p>
                              This email attempt can no longer be safely retried. Create a new
                              invitation if another email is needed.
                            </p>
                          )}
                        <p>
                          {assigned
                            ? 'Assigned to this product'
                            : eligible
                              ? 'Available to assign'
                              : connection.status === 'revoked'
                                ? 'Connection revoked'
                                : 'Stripe verification or account confirmation is required'}
                        </p>
                      </div>
                      {canManage && (
                        <div className="merchant-row-actions">
                          {latest &&
                            latest.can_copy &&
                            !['expired', 'revoked', 'connected', 'confirmed'].includes(
                              latest.status,
                            ) &&
                            Date.parse(latest.expires_at) > now && (
                              <>
                                <button
                                  type="button"
                                  className="admin-secondary-button"
                                  disabled={busy || !status.enabled || !canResend(latest)}
                                  onClick={() => void resend(latest, merchant.email)}
                                >
                                  Resend invitation
                                </button>
                                <button
                                  type="button"
                                  className="admin-text-button"
                                  disabled={busy || !latest.can_copy}
                                  onClick={() => void viewInvitation(latest, merchant.email)}
                                >
                                  View invitation link
                                </button>
                                {remaining > 0 && (
                                  <span className="merchant-cooldown">
                                    You can resend in {remaining}s.
                                  </span>
                                )}
                              </>
                            )}
                          <button
                            type="button"
                            className="admin-secondary-button"
                            disabled={busy || !eligible || assigned || !status.enabled}
                            onClick={() =>
                              setReview({
                                merchantId: merchant.id,
                                connectionId: connection.id,
                                accountId: connection.account_id,
                                name: merchant.business_name,
                                livemode: connection.livemode,
                              })
                            }
                          >
                            Assign to this product
                          </button>
                          <button
                            type="button"
                            className="admin-secondary-button"
                            disabled={busy || !status.enabled || !renewalBinding || remaining > 0}
                            onClick={() => {
                              if (!renewalBinding) return
                              setReview({
                                merchantId: merchant.id,
                                connectionId: connection.id,
                                accountId: connection.account_id,
                                name: merchant.business_name,
                                livemode: connection.livemode,
                                renewal: { email: merchant.email, bindingId: renewalBinding.id },
                              })
                            }}
                          >
                            Create new invitation
                          </button>
                          {connection.status !== 'revoked' && (
                            <button
                              type="button"
                              className="admin-text-button"
                              disabled={busy}
                              onClick={() =>
                                setReview({
                                  merchantId: merchant.id,
                                  connectionId: connection.id,
                                  accountId: connection.account_id,
                                  name: merchant.business_name,
                                  livemode: connection.livemode,
                                  revoke: true,
                                })
                              }
                            >
                              Revoke connection
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </article>
            ))}
          </div>
          {review && (
            <div className="merchant-review" role="region" aria-label="Review merchant change">
              <h3>
                {review.renewal
                  ? 'Create a new invitation for this merchant?'
                  : review.revoke
                    ? 'Revoke this merchant connection?'
                    : 'Confirm the payment account'}
              </h3>
              <p>
                <strong>{review.name}</strong> · {review.livemode ? 'Live' : 'Test'} ·{' '}
                <code>{review.accountId}</code>
              </p>
              <p>
                {review.renewal
                  ? `We will create and email a new secure link to ${review.renewal.email}. Previous unfinished links will stop working. Use Resend invitation to keep a current link instead. Checkout and payouts stay under their separate controls.`
                  : review.revoke
                    ? 'This blocks new payments for every product using this connection. Existing payment records remain available.'
                    : 'This product’s funnels will use this merchant account. Existing commission settings stay in place. Checkout and payouts remain controlled by their separate release settings.'}
              </p>
              <div className="merchant-row-actions">
                <button
                  type="button"
                  className="admin-primary-button"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {review.renewal
                    ? 'Confirm new invitation'
                    : review.revoke
                      ? 'Confirm revocation'
                      : 'Confirm assignment'}
                </button>
                <button
                  type="button"
                  className="admin-secondary-button"
                  disabled={busy}
                  onClick={() => setReview(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {invitation && canManage && (
            <div
              className="merchant-review"
              role="region"
              aria-label="Invitation details"
              tabIndex={-1}
              ref={invitationPanel}
            >
              <div
                role="status"
                aria-label="Invitation email status"
                className={`merchant-delivery merchant-delivery-${invitationDeliveryMessage(invitation.delivery.status, invitationEmail).tone}`}
              >
                <h3>
                  {invitationDeliveryMessage(invitation.delivery.status, invitationEmail).title}
                </h3>
                <p>
                  {invitationDeliveryMessage(invitation.delivery.status, invitationEmail).detail}
                </p>
              </div>
              <label className="admin-field">
                <span>Secure invitation link</span>
                <input
                  readOnly
                  value={invitation.invitation_url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <p>
                Expires {new Date(invitation.expires_at).toLocaleString()}. Share only with the
                invited merchant.
              </p>
              <div className="merchant-row-actions">
                <button
                  type="button"
                  className="admin-secondary-button"
                  disabled={busy || Date.parse(invitation.expires_at) <= now}
                  onClick={() => {
                    if (!navigator.clipboard) {
                      setError('Copy is unavailable. Select and copy the invitation link above.')
                      return
                    }
                    void navigator.clipboard
                      .writeText(invitation.invitation_url)
                      .then(() => setNotice('Invitation link copied.'))
                      .catch(() =>
                        setError('Copy is unavailable. Select and copy the invitation link above.'),
                      )
                  }}
                >
                  Copy invitation link
                </button>
                <button
                  type="button"
                  className="admin-secondary-button"
                  disabled={busy || !status.enabled || !canResend(invitation)}
                  onClick={() => void resend(invitation, invitationEmail)}
                >
                  Resend this invitation
                </button>
                <button
                  type="button"
                  className="admin-text-button"
                  disabled={busy}
                  onClick={() => void refreshEmailStatus()}
                >
                  Refresh email status
                </button>
                {invitationCooldownSeconds(invitation.delivery?.retry_at, now) > 0 && (
                  <span className="merchant-cooldown">
                    You can resend in{' '}
                    {invitationCooldownSeconds(invitation.delivery?.retry_at, now)}s.
                  </span>
                )}
              </div>
            </div>
          )}
          {canManage && (
            <form className="merchant-invitation-form" onSubmit={(event) => void create(event)}>
              <h3>Invite a merchant</h3>
              <p>
                We email the merchant a secure invitation. They verify their email, choose their
                Stripe business account and confirm its identity. They do not receive admin access.
              </p>
              <div className="merchant-form-grid">
                <label className="admin-field">
                  <span>Business name</span>
                  <input
                    required
                    maxLength={160}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={busy}
                    autoComplete="organization"
                  />
                </label>
                <label className="admin-field">
                  <span>Merchant contact email</span>
                  <input
                    required
                    type="email"
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                    autoComplete="email"
                  />
                </label>
                <label className="admin-field">
                  <span>Stripe environment</span>
                  <select
                    required
                    value={binding}
                    onChange={(event) => setBinding(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">Select a platform account</option>
                    {status.bindings.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.livemode ? 'Live' : 'Test'} · {value.platform_account_id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="admin-primary-button"
                type="submit"
                disabled={busy || !status.enabled || !binding}
              >
                {busy ? (
                  <LoaderCircle size={16} className="admin-spin" aria-hidden="true" />
                ) : (
                  <Mail size={16} aria-hidden="true" />
                )}
                Send invitation
              </button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
