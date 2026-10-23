import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { CreatorConnectCard } from '../src/features/creator-settlements/CreatorConnectCard'
import { createConnectGateway } from '../src/features/creator-settlements/connect'
import { logoutEmbeddedConnectSessions } from '../src/features/creator-settlements/embedded-connect'
import '../src/brand.css'

const gateway = createConnectGateway({
  functions: {
    invoke: async (name, options) => {
      if (name !== 'creator-connect') throw Error('Unsupported local function.')
      const response = await fetch('/__creator/connect', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.body),
      })
      const errorContext = response.clone()
      const data = await response.json()
      return response.ok
        ? { data, error: null }
        : {
            data: null,
            error: { message: 'Local onboarding request failed.', context: errorContext },
          }
    },
  },
})

export function LocalCreatorAcceptance() {
  const [signedIn, setSignedIn] = useState(true)
  const [signOutStatus, setSignOutStatus] = useState<'pending' | 'complete' | 'failed'>('pending')
  return (
    <main style={{ maxWidth: 1000, margin: '32px auto', padding: 24 }}>
      <h1>KissMyApps · creator payout setup</h1>
      <p>Local acceptance · synthetic signed-in creator · Stripe test mode only.</p>
      <p>
        Authentication freshness is simulated here. Real password confirmation and MFA are tested
        separately.
      </p>
      <p>
        Use Stripe’s test identity and bank details. This runner cannot create payments, transfers
        or payouts.
      </p>
      {signedIn ? (
        <>
          <CreatorConnectCard gateway={gateway} />
          <button
            type="button"
            onClick={async () => {
              setSignedIn(false)
              setSignOutStatus('pending')
              const cleanup = logoutEmbeddedConnectSessions()
              try {
                const response = await fetch('/__creator/signout', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                  signal: AbortSignal.timeout(10000),
                })
                setSignOutStatus(response.ok ? 'complete' : 'failed')
              } catch {
                setSignOutStatus('failed')
              } finally {
                await cleanup
              }
            }}
          >
            Sign out of local creator
          </button>
        </>
      ) : (
        <p role="status">
          {signOutStatus === 'pending'
            ? 'Signing out of the local creator…'
            : signOutStatus === 'failed'
              ? 'The payout form is closed, but local sign-out could not be confirmed. Reload and try again.'
              : 'Local creator signed out. Reload this page to sign in to the same disposable fixture.'}
        </p>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<LocalCreatorAcceptance />)
