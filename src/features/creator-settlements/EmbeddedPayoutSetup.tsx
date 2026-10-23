import { useEffect, useRef, useState } from 'react'
import {
  ConnectReauthenticationRequired,
  ConnectMfaRequired,
  type ConnectGateway,
  type ConnectSession,
} from './connect'
import { rememberEmbeddedConnectSession } from './embedded-connect'

export function EmbeddedPayoutSetup({
  session,
  gateway,
  onExit,
  onReauthenticate,
}: {
  session: ConnectSession
  gateway: ConnectGateway
  onExit(): void
  onReauthenticate?(mfa: boolean): void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'failed' | 'slow' | null>(null)
  const [attempt, setAttempt] = useState(0)
  // One-use initial response stays in memory only. Refreshes always authenticate
  // again on the server and must retain the same creator/account/mode scope.
  const initial = useRef<ConnectSession | null>(session)
  const exit = useRef(onExit)
  const reauthenticate = useRef(onReauthenticate)
  useEffect(() => {
    exit.current = onExit
    reauthenticate.current = onReauthenticate
  }, [onExit, onReauthenticate])
  useEffect(() => {
    let active = true
    let component: HTMLElement | undefined
    const timer = window.setTimeout(() => {
      if (active) {
        setLoading(false)
        setError('slow')
      }
    }, 30_000)
    const fail = () => {
      if (!active) return
      window.clearTimeout(timer)
      setLoading(false)
      setError('failed')
    }
    void import('@stripe/connect-js/pure')
      .then(({ loadConnectAndInitialize }) => {
        if (!active) return
        const instance = loadConnectAndInitialize({
          publishableKey: session.publishable_key,
          fetchClientSecret: async () => {
            try {
              if (!active) throw Error('Payout setup closed.')
              let next = initial.current
              initial.current = null
              if (!next || next.expires_at <= Math.floor(Date.now() / 1000) + 30) {
                next = await gateway.session(session.binding_id)
              }
              if (
                !active ||
                next.binding_id !== session.binding_id ||
                next.platform_account_id !== session.platform_account_id ||
                next.connected_account_id !== session.connected_account_id ||
                next.publishable_key !== session.publishable_key ||
                next.livemode !== session.livemode
              ) {
                throw Error('Payout setup scope changed.')
              }
              return next.client_secret
            } catch (error) {
              if (
                active &&
                (error instanceof ConnectReauthenticationRequired ||
                  error instanceof ConnectMfaRequired) &&
                reauthenticate.current
              )
                reauthenticate.current(error instanceof ConnectMfaRequired)
              else fail()
              throw Error('Secure payout setup could not be refreshed. Please reopen it.')
            }
          },
          appearance: { variables: { colorPrimary: '#176b58', borderRadius: '10px' } },
        })
        rememberEmbeddedConnectSession(instance)
        const onboarding = instance.create('account-onboarding')
        onboarding.setCollectionOptions({ fields: 'currently_due', futureRequirements: 'omit' })
        onboarding.setOnExit(() => {
          if (active) exit.current()
        })
        onboarding.setOnLoadError(fail)
        onboarding.setOnLoaderStart(() => {
          if (!active) return
          window.clearTimeout(timer)
          setLoading(false)
          setError(null)
        })
        component = onboarding
        container.current?.appendChild(onboarding)
      })
      .catch(fail)
    return () => {
      active = false
      window.clearTimeout(timer)
      component?.remove()
    }
  }, [gateway, session, attempt])
  return (
    <section className="embedded-payout-setup" aria-label="Secure payout setup">
      <header>
        <div>
          <h3>Set up your payouts</h3>
          <p>
            Review your details and add what’s required now. Stripe securely verifies your identity
            and bank information here.
          </p>
        </div>
        <button type="button" onClick={onExit}>
          Close for now
        </button>
      </header>
      <p className="settlement-muted">
        Stripe keeps details you submit. Unsubmitted entries may need to be entered again when you
        return. Stripe may request more information later; saved details do not mean payouts are
        approved.
      </p>
      {loading && <p role="status">Loading secure payout setup…</p>}
      {error && (
        <div role="alert">
          <p>
            {error === 'slow'
              ? 'Secure payout setup is taking longer than expected. You can keep waiting or retry. Your submitted details are kept by Stripe.'
              : 'Secure payout setup could not load. Your submitted details are kept by Stripe. Try again to continue.'}
          </p>
          <button
            type="button"
            onClick={() => {
              // A retry is a new attempt even if the failed SDK never consumed
              // the prefetched token. Never hand it that earlier token again.
              initial.current = null
              setLoading(true)
              setError(null)
              setAttempt((value) => value + 1)
            }}
          >
            Retry payout setup
          </button>
        </div>
      )}
      {/* Keep Stripe mounted and visible while it recovers. A timeout or an
          early load error must not conceal a later successful loader event. */}
      <div ref={container} className="embedded-payout-container" />
    </section>
  )
}
