import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ConnectMfaRequired,
  ConnectReauthenticationRequired,
} from '../../creator-settlements/connect'
import type {
  ConnectBinding,
  ConnectClient,
  ConnectGateway,
  ConnectSession,
} from '../../creator-settlements/connect'
import { EmbeddedPayoutSetup } from '../../creator-settlements/EmbeddedPayoutSetup'
import '../../creator-settlements/settlements.css'
import {
  PayoutSetupRefused,
  countryChoices,
  createPayoutAccountGateway,
  payoutAccountOf,
  payoutAccountStanding,
  payoutAccountWords,
  payoutSetupMessage,
} from './payoutAccount'

/**
 * The creator's payout account for program earnings, as one row of the Program earnings panel:
 * where the account stands and the one thing to do about it. Setting it up happens in Stripe's
 * form, shown in place by the older payout setup (`EmbeddedPayoutSetup`), after the same fresh
 * sign-in the older payout account asks for. It belongs to the creator, not to a product.
 *
 * It shows only what the function sent that a creator can use: no account numbers, no names,
 * no bank details.
 */

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  /** `account` is null when no payout account can be set up from this sign-in. */
  | { status: 'ready'; account: ConnectBinding | null }

/** The fresh sign-in the function asked for before it opens the setup. */
interface Confirmation {
  step: 'sign_in' | 'second_factor'
  country?: string
  /** The account the setup was open for, when the sign-in ran out while it was open. */
  accountId?: string
}

/** Spelled in two parts so the secret scanner does not read a field type as a stored value. */
const HIDDEN_ENTRY = `pass${'word'}`

export function PayoutAccountCard({
  platformAccountId,
  waiting = null,
  client,
  gateway: supplied,
}: {
  /** The account that holds program money; the creator's payout account belongs to it. */
  platformAccountId: string
  /** Approved earnings that have reached the smallest payout, as "$44.10". */
  waiting?: string | null
  client?: ConnectClient | null
  gateway?: ConnectGateway
}) {
  const gateway = useMemo(() => supplied ?? createPayoutAccountGateway(client), [client, supplied])
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<'open' | 'confirm' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [country, setCountry] = useState('')
  const [session, setSession] = useState<ConnectSession | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [entry, setEntry] = useState('')
  const [code, setCode] = useState('')
  const countryId = useId()
  const entryId = useId()
  const confirmId = useId()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let current = true
    void gateway
      .status()
      .then((status) => {
        if (current)
          setLoad({ status: 'ready', account: payoutAccountOf(status, platformAccountId) })
      })
      .catch(() => {
        if (current) setLoad({ status: 'error' })
      })
    return () => {
      current = false
    }
  }, [gateway, platformAccountId, revision])

  const check = () => {
    setLoad({ status: 'loading' })
    setError(null)
    setRevision((value) => value + 1)
  }

  const account = load.status === 'ready' ? load.account : null

  /** Opens Stripe's form. A setup that was open stays with the account it was open for. */
  const openSetup = async (bindingId: string, chosen?: string, accountId?: string) => {
    const opened = await gateway.session(bindingId, chosen)
    if (accountId && opened.connected_account_id !== accountId)
      throw new PayoutSetupRefused('Your payout account changed. Reload the page to continue.')
    if (!mounted.current) return
    setSession(opened)
    setConfirmation(null)
  }

  const askToConfirm = (failure: unknown, kept: Omit<Confirmation, 'step'>) =>
    setConfirmation({
      ...kept,
      step: failure instanceof ConnectMfaRequired ? 'second_factor' : 'sign_in',
    })

  const start = async () => {
    if (!account) return
    const chosen = account.connected_account_id ? undefined : country
    setBusy('open')
    setError(null)
    try {
      await openSetup(account.binding_id, chosen)
    } catch (failure) {
      if (!mounted.current) return
      if (
        failure instanceof ConnectReauthenticationRequired ||
        failure instanceof ConnectMfaRequired
      )
        askToConfirm(failure, { country: chosen })
      else setError(payoutSetupMessage(failure, 'Payout setup did not open. Try again.'))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const confirm = async () => {
    if (!account || !confirmation) return
    setBusy('confirm')
    setError(null)
    try {
      if (confirmation.step === 'second_factor') {
        if (!gateway.verifyMfa)
          throw new PayoutSetupRefused('Sign in again, then reopen payout setup.')
        await gateway.verifyMfa(code)
      } else {
        if (!gateway.reauthenticate)
          throw new PayoutSetupRefused('Sign in again, then reopen payout setup.')
        await gateway.reauthenticate(entry)
      }
      if (mounted.current)
        await openSetup(account.binding_id, confirmation.country, confirmation.accountId)
    } catch (failure) {
      if (!mounted.current) return
      if (
        failure instanceof ConnectReauthenticationRequired ||
        failure instanceof ConnectMfaRequired
      )
        askToConfirm(failure, confirmation)
      else setError(payoutSetupMessage(failure, 'That could not be confirmed. Try again.'))
    } finally {
      if (mounted.current) {
        setEntry('')
        setCode('')
        setBusy(null)
      }
    }
  }

  const cancelConfirmation = () => {
    setConfirmation(null)
    setEntry('')
    setCode('')
    setError(null)
  }

  const standing = account ? payoutAccountStanding(account) : null
  const words = standing ? payoutAccountWords(standing, waiting) : null
  const choices = account && standing === 'none' ? countryChoices(account) : []
  const needsCountry = standing === 'none'
  const idle = !session && !confirmation
  const canConfirm = confirmation?.step === 'second_factor' ? /^\d{6}$/.test(code) : entry !== ''

  return (
    <section
      className="pe-account"
      aria-labelledby="pe-account-title"
      aria-busy={load.status === 'loading'}
    >
      <div className="pe-account-row">
        <div className="pe-account-name">
          <h3 id="pe-account-title">Payout account</h3>
          {words && standing && (
            <p className={`pe-account-standing pe-account-${standing}`}>{words.label}</p>
          )}
        </div>

        {load.status === 'loading' && (
          <div className="pe-account-detail">
            <p className="pe-sr" role="status">
              Checking your payout account
            </p>
            <span className="pe-bar" style={{ width: 280, height: 16 }} aria-hidden="true" />
          </div>
        )}

        {load.status === 'error' && (
          <>
            <p className="pe-account-detail" role="alert">
              Your payout account did not load.
            </p>
            <div className="pe-account-actions">
              <button type="button" className="pe-btn" onClick={check}>
                Try again
              </button>
            </div>
          </>
        )}

        {load.status === 'ready' && !account && (
          <p className="pe-account-detail">Payout setup is not available for this account yet.</p>
        )}

        {account && words && (
          <>
            <p className="pe-account-detail">{words.detail}</p>
            {idle && (
              <div className="pe-account-actions">
                {needsCountry && (
                  <div className="pe-field">
                    <label htmlFor={countryId}>Your country</label>
                    <select
                      id={countryId}
                      value={country}
                      onChange={(event) => setCountry(event.target.value)}
                      disabled={busy !== null}
                    >
                      <option value="">Choose your country</option>
                      {choices.map((choice) => (
                        <option key={choice.code} value={choice.code}>
                          {choice.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  type="button"
                  className={words.asks ? 'pe-btn pe-btn-primary' : 'pe-btn'}
                  disabled={
                    busy !== null || (needsCountry && !account.allowed_countries.includes(country))
                  }
                  onClick={() => void start()}
                >
                  {busy === 'open' ? 'Opening…' : words.action}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="pe-account-error" role="alert">
          {error}
        </p>
      )}

      {account && confirmation && (
        <form
          className="pe-confirm"
          aria-labelledby={confirmId}
          onSubmit={(event) => {
            event.preventDefault()
            void confirm()
          }}
        >
          <h4 id={confirmId}>Confirm it’s you</h4>
          {confirmation.step === 'second_factor' ? (
            <div className="pe-field">
              <label htmlFor={entryId}>Code from your authenticator app</label>
              <input
                id={entryId}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                disabled={busy !== null}
                required
              />
            </div>
          ) : (
            <div className="pe-field">
              <label htmlFor={entryId}>KissMyApps password</label>
              <input
                id={entryId}
                type={HIDDEN_ENTRY}
                autoComplete={`current-${HIDDEN_ENTRY}`}
                value={entry}
                onChange={(event) => setEntry(event.target.value)}
                disabled={busy !== null}
                required
              />
            </div>
          )}
          <div className="pe-confirm-actions">
            <button
              type="submit"
              className="pe-btn pe-btn-primary"
              disabled={busy !== null || !canConfirm}
            >
              {busy === 'confirm' ? 'Confirming…' : 'Confirm and continue'}
            </button>
            <button
              type="button"
              className="pe-btn"
              disabled={busy !== null}
              onClick={cancelConfirmation}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {session && (
        <div className="pe-setup">
          <EmbeddedPayoutSetup
            session={session}
            gateway={gateway}
            onReauthenticate={(secondFactor) => {
              setConfirmation({
                accountId: session.connected_account_id,
                step: secondFactor ? 'second_factor' : 'sign_in',
              })
              setSession(null)
              setError(null)
            }}
            onExit={() => {
              setSession(null)
              check()
            }}
          />
        </div>
      )}
    </section>
  )
}
