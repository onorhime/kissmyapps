import { supabase } from '../../lib/supabase'

type SessionInstance = { logout(): Promise<void> }
const sessions = new Set<SessionInstance>()

export function rememberEmbeddedConnectSession(instance: SessionInstance) {
  sessions.add(instance)
}

export async function logoutEmbeddedConnectSessions() {
  const current = [...sessions]
  sessions.clear()
  await Promise.allSettled(
    current.map(async (instance) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A failed Stripe iframe can leave logout pending forever. KMA sign-out
        // must finish even when that third-party cleanup never responds.
        await Promise.race([
          Promise.resolve().then(() => instance.logout()),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }),
  )
}

// Connect sessions outlive a page component. Only invalidate them at sign-out,
// not on navigation/closing onboarding, as required by the Connect SDK.
supabase?.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') void logoutEmbeddedConnectSessions()
})
