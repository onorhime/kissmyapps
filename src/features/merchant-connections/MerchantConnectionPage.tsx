import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ArrowRight, CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react'
import { Brand } from '../../components/Brand'
import { supabase } from '../../lib/supabase'
import { useAuthSession } from '../auth/authSession'
import {
  createMerchantGateway,
  merchantGateway,
  MerchantGatewayError,
  type MerchantInvitationCode,
  type MerchantConnection,
  type MerchantGateway,
} from './gateway'
import { captureMerchantEntry, clearMerchantEntry, saveMerchantEntry } from './routing'
import { isMerchantEmailCode, normalizeMerchantEmailCode } from './emailCode'
import { clearInvitationCodeRequest, invitationCodeRequestId } from './invitationCodeRequest'
import { invitationCooldownSeconds } from './invitationDelivery'
import './merchant-connections.css'

export function MerchantConnectionPage({
  client = supabase,
  gateway,
  navigate = (url: string) => window.location.assign(url),
}: {
  client?: SupabaseClient | null
  gateway?: MerchantGateway
  navigate?: (url: string) => void
}) {
  const [service] = useState(
    () => gateway ?? (client === supabase ? merchantGateway : createMerchantGateway(client)),
  )
  const [entry, setEntry] = useState(captureMerchantEntry)
  const auth = useAuthSession(client)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const [codeDelivery, setCodeDelivery] = useState<MerchantInvitationCode | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeUnavailable, setCodeUnavailable] = useState(false)
  const [codeUnconfirmed, setCodeUnconfirmed] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [now, setNow] = useState(Date.now)
  const codeAttempt = useRef<{ token: string; promise: Promise<MerchantInvitationCode> } | null>(
    null,
  )
  const [connection, setConnection] = useState<MerchantConnection | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(entry.error ?? '')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const callbackAttempt = useRef<Promise<{
    invitation_id: string
    connection: MerchantConnection
  }> | null>(null)
  const callbackUser = useRef<string | null>(null)
  const [reload, setReload] = useState(0)
  const hasEntry = Boolean(entry.invite || entry.callback || entry.invitationId)

  useEffect(() => {
    document.title = 'Connect your business · KissMyApps'
  }, [])
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])

  const applyCodeResult = useCallback((result: MerchantInvitationCode) => {
    setCodeDelivery(result)
    setSentEmail(result.email)
    setNow(Date.now)
    setCodeUnavailable(false)
    setCodeUnconfirmed(false)
    setCode('')
    setError(
      result.status === 'failed'
        ? 'We could not send your verification code. You can request another after the timer below.'
        : '',
    )
    setNotice(
      result.status === 'sent'
        ? 'Check your email for your one-time sign-in code. Enter it here to continue.'
        : result.status === 'cooldown'
          ? 'A code was requested recently. Use the latest code from your email, or request another when the timer ends.'
          : result.status === 'unknown'
            ? 'We could not confirm whether the code was sent. If it arrives, enter it below. Otherwise, request another when the timer ends.'
            : '',
    )
  }, [])

  useEffect(() => {
    if (auth.status !== 'anonymous' || !entry.invite || !client || !visible || codeDelivery) return
    let active = true
    const token = entry.invite
    // StrictMode reuses the promise; refresh reuses the persisted operation ID.
    if (codeAttempt.current?.token !== token) {
      codeAttempt.current = {
        token,
        promise: invitationCodeRequestId(token).then((id) =>
          service.requestInvitationCode(token, id),
        ),
      }
    }
    // eslint-disable-next-line react/set-state-in-effect
    setCodeLoading(true)
    setError('')
    void (async () => {
      try {
        const result = await codeAttempt.current!.promise
        if (active) applyCodeResult(result)
      } catch (reason) {
        if (active) {
          setCodeUnconfirmed(true)
          setCodeUnavailable(
            reason instanceof MerchantGatewayError &&
              ['invitation_unavailable', 'invalid_input'].includes(reason.code),
          )
          setError(
            reason instanceof Error
              ? reason.message
              : 'We could not confirm your code request. Please try again.',
          )
        }
      } finally {
        if (active) setCodeLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [auth.status, entry.invite, client, service, visible, codeDelivery, applyCodeResult])

  const resendWait = invitationCooldownSeconds(codeDelivery?.retry_at, now)
  useEffect(() => {
    if (!resendWait) return
    const timer = window.setInterval(() => setNow(Date.now), 1000)
    return () => window.clearInterval(timer)
  }, [resendWait])

  useEffect(() => {
    if (auth.status !== 'authenticated' || !hasEntry) return
    if (callbackUser.current !== auth.user?.id) {
      callbackAttempt.current = null
      callbackUser.current = auth.user?.id ?? null
    }
    let active = true
    // This reset follows the authenticated identity or invitation changing.
    // eslint-disable-next-line react/set-state-in-effect
    setLoading(true)
    setConnection(null)
    setError('')
    void (async () => {
      try {
        let result: MerchantConnection
        if (entry.callback) {
          callbackAttempt.current ??= service.completeConnection(
            entry.callback.state,
            entry.callback.code,
          )
          const response = await callbackAttempt.current
          result = response.connection
          if (active) {
            const next = { ...entry, callback: null, invitationId: response.invitation_id }
            saveMerchantEntry(next)
            setEntry(next)
          }
        } else if (entry.invitationId) result = await service.connectionStatus(entry.invitationId)
        else result = await service.inspectInvitation(entry.invite!)
        if (active) setConnection(result)
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : 'The merchant invitation could not be verified.',
          )
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [auth.status, auth.user?.id, service, entry, hasEntry, reload])

  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'This step could not be completed. Please try again.',
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  async function requestCodeAgain(renew: boolean) {
    if (
      auth.status !== 'anonymous' ||
      !entry.invite ||
      codeLoading ||
      (renew && resendWait > 0) ||
      codeUnavailable
    )
      return
    const token = entry.invite
    await run(async () => {
      const promise = invitationCodeRequestId(token, renew).then((id) =>
        service.requestInvitationCode(token, id),
      )
      codeAttempt.current = { token, promise }
      try {
        applyCodeResult(await promise)
      } catch (reason) {
        setCodeUnconfirmed(true)
        setCodeUnavailable(
          reason instanceof MerchantGatewayError &&
            ['invitation_unavailable', 'invalid_input'].includes(reason.code),
        )
        throw reason
      }
    })
  }
  async function sendCode(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      if (!client) throw Error('Merchant sign-in is not configured yet.')
      saveMerchantEntry(entry)
      const address = email.trim().toLowerCase()
      const result = await client.auth.signInWithOtp({
        email: address,
        options: {
          shouldCreateUser: true,
          data: { registration_flow: 'merchant_v1' },
          emailRedirectTo: `${window.location.origin}/merchant/connect`,
        },
      })
      if (result.error)
        throw Error(
          'We could not send your verification code. Check the email address and try again shortly.',
        )
      setCode('')
      setSentEmail(address)
      setNotice('Check your email for your one-time sign-in code. Enter it here to continue.')
    })
  }
  async function verifyCode(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const token = normalizeMerchantEmailCode(code)
      if (!sentEmail || !isMerchantEmailCode(token))
        throw Error('Enter the complete numeric code from your latest email.')
      const result = await client?.auth.verifyOtp({
        email: sentEmail,
        token,
        type: 'email',
      })
      if (!result || result.error || !result.data.session)
        throw Error(
          'This verification code is invalid or expired. Request a new code and try again.',
        )
      setCode('')
      if (entry.invite) await clearInvitationCodeRequest(entry.invite)
    })
  }
  async function start() {
    await run(async () => {
      if (!entry.invite)
        throw Error('Open your original invitation link to choose a Stripe account again.')
      const url = await service.startConnection(entry.invite)
      const next = { ...entry, callback: null }
      saveMerchantEntry(next)
      navigate(url)
    })
  }
  async function confirm() {
    await run(async () => {
      const invitationId = entry.invitationId ?? connection?.invitation_id
      if (!invitationId)
        throw Error('The invitation could not be verified. Reopen your original invitation link.')
      const result = await service.confirmConnection(invitationId)
      setConnection(result)
      if (result.status === 'connected') {
        clearMerchantEntry()
        setNotice(
          'This Stripe business account is connected. Your KMA administrator can now assign it to the product.',
        )
      }
    })
  }
  async function refreshConnection() {
    await run(async () => {
      const invitationId = entry.invitationId ?? connection?.invitation_id
      if (!invitationId) throw Error('Reopen the merchant invitation before refreshing.')
      setConnection(await service.refreshConnection(invitationId))
    })
  }
  const candidate = connection?.candidate
  const confirmed = connection?.status === 'connected'
  const unavailable = connection?.status === 'expired' || connection?.status === 'revoked'

  return (
    <main className="merchant-page">
      <header className="merchant-page-header">
        <Brand context="Merchant connection" />
        <span className="merchant-security-label">
          <ShieldCheck size={17} aria-hidden="true" /> Secure setup
        </span>
      </header>
      <section className="merchant-page-card" aria-labelledby="merchant-title">
        <p className="merchant-eyebrow">YOUR BUSINESS · YOUR STRIPE ACCOUNT</p>
        <h1 id="merchant-title">Connect your business to KissMyApps</h1>
        <p className="merchant-intro">
          Verify your email, choose your Stripe business account, then confirm the account shown
          here. You do not need access to the KMA admin dashboard.
        </p>
        {error && (
          <div className="merchant-notice merchant-notice-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p className="merchant-notice" role="status">
            {notice}
          </p>
        )}
        {!hasEntry ? (
          <p className="merchant-notice">
            Open the secure invitation link your KMA administrator shared with you. An invitation is
            required to connect a business.
          </p>
        ) : (
          <>
            {auth.status === 'loading' && (
              <p role="status">
                <LoaderCircle className="admin-spin" size={18} /> Checking your sign-in…
              </p>
            )}
            {(auth.status === 'unconfigured' || auth.status === 'error') && (
              <p role="alert">
                {auth.message ?? 'Merchant sign-in is unavailable. Please try again later.'}
              </p>
            )}
            {auth.status === 'anonymous' && (
              <div className="merchant-auth">
                <h2>1. Verify the invited email address</h2>
                <p>
                  {entry.invite
                    ? 'We’ll send a code to the email address on your invitation. Enter it below to continue.'
                    : 'Use the email address your administrator invited to resume connecting your business.'}
                </p>
                {!sentEmail && entry.invite ? (
                  <div>
                    {codeLoading ? (
                      <p role="status">
                        <LoaderCircle className="admin-spin" size={18} aria-hidden="true" /> Sending
                        your verification code…
                      </p>
                    ) : codeUnavailable ? (
                      <p className="merchant-notice">
                        Ask your KMA administrator for a new invitation link. No sign-in code can be
                        sent from this invitation.
                      </p>
                    ) : (
                      <button
                        className="merchant-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCodeAgain(false)}
                      >
                        {busy ? 'Checking code request…' : 'Retry code request'}
                      </button>
                    )}
                  </div>
                ) : !sentEmail ? (
                  <form onSubmit={(event) => void sendCode(event)}>
                    <label className="merchant-field">
                      <span>Email address</span>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="email"
                        disabled={busy}
                      />
                    </label>
                    <button className="merchant-primary" disabled={busy} type="submit">
                      {busy ? 'Sending code…' : 'Send verification code'}
                      <ArrowRight size={17} aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <form onSubmit={(event) => void verifyCode(event)}>
                    <p>
                      {entry.invite ? 'Invited email: ' : 'Code sent to '}
                      <strong>{sentEmail}</strong>.
                    </p>
                    <label className="merchant-field">
                      <span>Verification code</span>
                      <input
                        required
                        inputMode="numeric"
                        autoFocus
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}([0-9]{2})?"
                        aria-describedby="merchant-code-help"
                        value={code}
                        onChange={(event) =>
                          setCode(normalizeMerchantEmailCode(event.target.value))
                        }
                        disabled={busy}
                      />
                    </label>
                    <p id="merchant-code-help">Enter the complete code from your latest email.</p>
                    <div className="merchant-row-actions">
                      <button
                        type="submit"
                        className="merchant-primary"
                        disabled={busy || codeLoading || !isMerchantEmailCode(code)}
                      >
                        Verify email
                      </button>
                      {entry.invite ? (
                        <button
                          type="button"
                          className="merchant-secondary"
                          disabled={busy || codeLoading || resendWait > 0 || codeUnavailable}
                          onClick={() => void requestCodeAgain(!codeUnconfirmed)}
                        >
                          {codeUnconfirmed ? 'Retry code request' : 'Resend code'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="merchant-secondary"
                          disabled={busy}
                          onClick={() => {
                            setSentEmail('')
                            setCode('')
                            setError('')
                            setNotice('')
                          }}
                        >
                          Change email or resend
                        </button>
                      )}
                      {entry.invite && resendWait > 0 && (
                        <p className="merchant-code-cooldown">
                          You can resend a code in {resendWait} seconds.
                        </p>
                      )}
                    </div>
                  </form>
                )}
              </div>
            )}
            {auth.status === 'authenticated' && (
              <>
                <div className="merchant-signed-in">
                  <span>
                    Signed in as <strong>{auth.user?.email}</strong>
                  </span>
                  <button
                    className="merchant-text"
                    disabled={busy || loading}
                    onClick={() =>
                      void run(async () => {
                        const result = await client?.auth.signOut({ scope: 'local' })
                        if (result?.error) throw Error('Sign-out failed. Please retry.')
                        setConnection(null)
                        setSentEmail('')
                        setCodeDelivery(null)
                        setCodeUnavailable(false)
                        setCodeUnconfirmed(false)
                        codeAttempt.current = null
                        callbackAttempt.current = null
                      })
                    }
                    type="button"
                  >
                    Switch account
                  </button>
                </div>
                {loading && <p role="status">Verifying your merchant invitation…</p>}
                {!loading && error && (
                  <button
                    type="button"
                    className="merchant-secondary"
                    onClick={() => {
                      callbackAttempt.current = null
                      setReload((value) => value + 1)
                    }}
                  >
                    Check invitation again
                  </button>
                )}
                {!loading && error && entry.callback && entry.invite && (
                  <button
                    type="button"
                    className="merchant-text"
                    onClick={() => {
                      const next = { ...entry, callback: null, invitationId: null }
                      callbackAttempt.current = null
                      saveMerchantEntry(next)
                      setEntry(next)
                    }}
                  >
                    Return to the invitation and start again
                  </button>
                )}
                {!loading && connection && (
                  <>
                    <div className="merchant-business">
                      <h2>{connection.business_name}</h2>
                      <p>
                        <span className="merchant-mode">
                          {connection.livemode ? 'Live connection' : 'Test connection'}
                        </span>
                      </p>
                    </div>
                    {unavailable ? (
                      <p className="merchant-notice">
                        This invitation is {connection.status}. Ask your KMA administrator for a new
                        invitation link.
                      </p>
                    ) : confirmed ? (
                      <div className="merchant-complete">
                        <CheckCircle2 size={32} />
                        <h2>Business account connected</h2>
                        <p>{candidate?.business_name ?? connection.business_name}</p>
                        <code>{candidate?.account_id ?? connection.account_id}</code>
                        <p>
                          Connection does not enable checkout or creator payouts. Your administrator
                          controls those separately.
                        </p>
                      </div>
                    ) : candidate ? (
                      <div className="merchant-review">
                        <h2>3. Confirm this Stripe business</h2>
                        <dl>
                          <div>
                            <dt>Business</dt>
                            <dd>{candidate.business_name || 'Unnamed Stripe business'}</dd>
                          </div>
                          <div>
                            <dt>Stripe account</dt>
                            <dd>
                              <code>{candidate.account_id}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Country</dt>
                            <dd>{candidate.country ?? 'Not provided'}</dd>
                          </div>
                          <div>
                            <dt>Environment</dt>
                            <dd>{connection.livemode ? 'Live' : 'Test'}</dd>
                          </div>
                        </dl>
                        <p>
                          Confirm that this is the business that should receive payments. Only
                          eligible payments created through KMA will collect the agreed application
                          fee.
                        </p>
                        {(!candidate.charges_enabled ||
                          !candidate.payouts_enabled ||
                          !candidate.details_submitted) && (
                          <p className="merchant-notice">
                            Stripe still requires business details or approval before this account
                            can accept payments and receive payouts. Complete those requirements in
                            Stripe, then check again.
                          </p>
                        )}
                        <div className="merchant-row-actions">
                          <button
                            type="button"
                            className="merchant-primary"
                            disabled={
                              busy ||
                              !candidate.charges_enabled ||
                              !candidate.payouts_enabled ||
                              !candidate.details_submitted
                            }
                            onClick={() => void confirm()}
                          >
                            Confirm this business account
                          </button>
                          <button
                            type="button"
                            className="merchant-secondary"
                            disabled={busy}
                            onClick={() => void refreshConnection()}
                          >
                            Refresh account status
                          </button>
                          {entry.invite && (
                            <button
                              type="button"
                              className="merchant-text"
                              disabled={busy}
                              onClick={() => void start()}
                            >
                              Choose a different Stripe account
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="merchant-review">
                        <h2>2. Choose your Stripe business account</h2>
                        <p>
                          Continue to Stripe to sign in and authorise the connection. If your login
                          has several business accounts, choose the one for{' '}
                          {connection.business_name}. You will confirm its exact identity here
                          before it is connected.
                        </p>
                        <button
                          type="button"
                          className="merchant-primary"
                          disabled={busy || !entry.invite}
                          onClick={() => void start()}
                        >
                          {busy ? 'Opening Stripe…' : 'Connect with Stripe'}
                          <ArrowRight size={17} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  )
}
