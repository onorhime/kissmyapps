import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import {
  createConnectGateway,
  ConnectReauthenticationRequired,
  ConnectMfaRequired,
  type ConnectClient,
  type ConnectGateway,
  type ConnectStatus,
  type ConnectSession,
} from './connect'
import { EmbeddedPayoutSetup } from './EmbeddedPayoutSetup'
import './settlements.css'

export function CreatorConnectCard({
  client,
  gateway: supplied,
}: {
  client?: ConnectClient | null
  gateway?: ConnectGateway
}) {
  const gateway = useMemo(() => supplied ?? createConnectGateway(client), [client, supplied])
  const [data, setData] = useState<ConnectStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [countries, setCountries] = useState<Record<string, string>>({})
  const [session, setSession] = useState<ConnectSession | null>(null)
  const [confirmation, setConfirmation] = useState<{
    bindingId: string
    country?: string
    accountId?: string
    step: 'password' | 'mfa'
  } | null>(null)
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setBusy('status')
      setError(null)
      try {
        const value = await gateway.status()
        if (active) setData(value)
      } catch (e) {
        if (active) {
          setData(null)
          setError(e instanceof Error ? e.message : 'Payout setup is unavailable.')
        }
      } finally {
        if (active) setBusy(null)
      }
    })
    return () => {
      active = false
    }
  }, [gateway, revision])
  const openSession = async (bindingId: string, country?: string, accountId?: string) => {
    const result = await gateway.session(bindingId, country)
    if (accountId && result.connected_account_id !== accountId)
      throw Error('The payout account changed. Refresh the page before continuing.')
    if (active.current) {
      setSession(result)
      setConfirmation(null)
    }
  }
  const onboard = async (bindingId: string) => {
    setBusy(bindingId)
    setError(null)
    try {
      await openSession(bindingId, countries[bindingId])
    } catch (e) {
      if (active.current) {
        if (e instanceof ConnectReauthenticationRequired || e instanceof ConnectMfaRequired)
          setConfirmation({
            bindingId,
            country: countries[bindingId],
            step: e instanceof ConnectMfaRequired ? 'mfa' : 'password',
          })
        else setError(e instanceof Error ? e.message : 'Payout setup could not be opened.')
      }
    } finally {
      if (active.current) setBusy(null)
    }
  }
  const confirmIdentity = async () => {
    if (!confirmation) return
    setBusy('reauthenticate')
    setError(null)
    try {
      if (confirmation.step === 'mfa') {
        if (!gateway.verifyMfa)
          throw Error('Sign in again with your verification code, then reopen payout setup.')
        await gateway.verifyMfa(verificationCode)
      } else {
        if (!gateway.reauthenticate)
          throw Error('Sign in again to confirm your identity, then reopen payout setup.')
        await gateway.reauthenticate(password)
      }
      if (active.current)
        await openSession(confirmation.bindingId, confirmation.country, confirmation.accountId)
    } catch (e) {
      if (active.current) {
        if (e instanceof ConnectMfaRequired)
          setConfirmation((current) => (current ? { ...current, step: 'mfa' } : null))
        else if (e instanceof ConnectReauthenticationRequired)
          setConfirmation((current) => (current ? { ...current, step: 'password' } : null))
        else setError(e instanceof Error ? e.message : 'Your identity could not be confirmed.')
      }
    } finally {
      if (active.current) {
        setPassword('')
        setVerificationCode('')
        setBusy(null)
      }
    }
  }
  const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
  return (
    <section className="creator-settlements panel" aria-label="Stripe payout connection">
      <header>
        <div>
          <h2>Your payout account</h2>
          <p>Set up your identity and bank details securely, without leaving KissMyApps.</p>
        </div>
        <button
          type="button"
          disabled={!!busy || !!session || !!confirmation}
          onClick={() => setRevision((n) => n + 1)}
        >
          {busy === 'status' ? 'Checking…' : 'Refresh status'}
        </button>
      </header>
      {busy === 'status' && (
        <p role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking payout connection…
        </p>
      )}
      {error && (
        <p role="alert" className="settlement-error">
          {error}
        </p>
      )}
      {confirmation && (
        <form
          className="settlement-card"
          aria-label="Confirm payout setup"
          onSubmit={(event) => {
            event.preventDefault()
            void confirmIdentity()
          }}
        >
          <h3>Confirm it’s you</h3>
          <p>
            {confirmation.step === 'mfa'
              ? 'Enter the six-digit code from your authenticator app.'
              : 'Enter your KissMyApps password to continue.'}{' '}
            Your bank and identity details are collected securely inside the payout form.
          </p>
          {(confirmation.step === 'mfa' ? gateway.verifyMfa : gateway.reauthenticate) ? (
            <>
              {confirmation.step === 'mfa' ? (
                <label>
                  Authenticator code
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={verificationCode}
                    onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, ''))}
                    disabled={!!busy}
                    required
                  />
                </label>
              ) : (
                <label>
                  KissMyApps password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={!!busy}
                    required
                  />
                </label>
              )}
              <div className="settlement-actions">
                <button
                  type="submit"
                  disabled={
                    !!busy ||
                    (confirmation.step === 'mfa' ? !/^\d{6}$/.test(verificationCode) : !password)
                  }
                >
                  {busy === 'reauthenticate' ? 'Confirming…' : 'Confirm and continue'}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmation(null)
                    setPassword('')
                    setVerificationCode('')
                    setError(null)
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p role="alert">Sign in again to confirm your identity, then reopen payout setup.</p>
          )}
        </form>
      )}
      {session && (
        <EmbeddedPayoutSetup
          session={session}
          gateway={gateway}
          onReauthenticate={(mfa) => {
            setConfirmation({
              bindingId: session.binding_id,
              accountId: session.connected_account_id,
              step: mfa ? 'mfa' : 'password',
            })
            setSession(null)
            setError(null)
          }}
          onExit={() => {
            setSession(null)
            setRevision((value) => value + 1)
          }}
        />
      )}
      {data && !data.enabled && (
        <p>
          Payout setup is not enabled in this environment. Your recorded earnings are preserved.
        </p>
      )}
      {data?.enabled && !data.bindings.length && (
        <p>
          No approved funding connection is available yet. Your administrator needs to configure it
          first.
        </p>
      )}
      {data?.enabled &&
        data.bindings.map((binding) => (
          <article className="settlement-card" key={binding.binding_id}>
            <h3>
              {binding.livemode ? 'Live payouts' : 'Test payouts'}{' '}
              <small>· {binding.platform_account_id}</small>
            </h3>
            <p>
              {
                {
                  not_connected: 'Connect your account to receive approved earnings.',
                  needs_information: 'Stripe needs more information before payouts can proceed.',
                  pending_verification:
                    'Your details are submitted. Payout setup is not ready yet.',
                  ready: 'Your payout account is ready. Earnings still need payout approval.',
                }[binding.status]
              }
            </p>
            <dl>
              <div>
                <dt>Transfers to Stripe</dt>
                <dd>{binding.transfers_enabled ? 'Enabled' : 'Not ready'}</dd>
              </div>
              <div>
                <dt>Bank payouts</dt>
                <dd>{binding.payouts_enabled ? 'Enabled' : 'Not ready'}</dd>
              </div>
            </dl>
            {binding.requirements_due.length > 0 && (
              <p>
                Required by Stripe:{' '}
                {binding.requirements_due
                  .map((name) => name.replaceAll('_', ' ').replaceAll('.', ' · '))
                  .join(', ')}
                .
              </p>
            )}
            {binding.disabled_reason && (
              <p>
                Stripe status: {binding.disabled_reason.replaceAll('_', ' ').replaceAll('.', ' · ')}
                .
              </p>
            )}
            {!binding.connected_account_id && (
              <label>
                Your account country
                <select
                  value={countries[binding.binding_id] ?? ''}
                  onChange={(event) =>
                    setCountries((current) => ({
                      ...current,
                      [binding.binding_id]: event.target.value,
                    }))
                  }
                  disabled={!!busy}
                >
                  <option value="">Choose your country</option>
                  {binding.allowed_countries.map((country) => (
                    <option key={country} value={country}>
                      {regionNames.of(country) ?? country}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {countries[binding.binding_id] && !binding.connected_account_id && (
              <p className="settlement-muted">
                Provider-supported settlement currencies for this country:{' '}
                {binding.eligibility.countries
                  .find((entry) => entry.country === countries[binding.binding_id])
                  ?.settlement_currencies.join(', ') || 'Unavailable'}
                . Final transfer eligibility is checked after connection.
              </p>
            )}
            {binding.connected_account_id && (
              <p>
                Verified transfer currencies:{' '}
                {binding.allowed_transfer_currencies.length
                  ? binding.allowed_transfer_currencies.join(', ')
                  : 'None available yet'}
                .
              </p>
            )}
            {binding.eligibility_reason && <p role="status">{binding.eligibility_reason}</p>}
            <p className="settlement-muted">
              Country eligibility checked{' '}
              {new Date(binding.eligibility.verified_at).toLocaleString()}. Availability depends on
              your country, account and funding route; automatic currency conversion is not assumed.
            </p>
            <button
              type="button"
              disabled={
                !!busy ||
                !!session ||
                !!confirmation ||
                (!binding.connected_account_id &&
                  (!countries[binding.binding_id] ||
                    !binding.allowed_countries.includes(countries[binding.binding_id])))
              }
              onClick={() => void onboard(binding.binding_id)}
            >
              {busy === binding.binding_id
                ? 'Opening payout setup…'
                : binding.connected_account_id
                  ? 'Review payout details'
                  : 'Set up payouts'}
            </button>
            {binding.verified_at && (
              <p className="settlement-muted">
                Last checked: {new Date(binding.verified_at).toLocaleString()}
              </p>
            )}
          </article>
        ))}
      <p className="settlement-muted">
        Closing the form checks your current verification status. Stripe may ask for more
        information later. A transfer into Stripe and a payout to your bank are shown separately.
      </p>
    </section>
  )
}
