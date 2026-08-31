import { useEffect, useState } from 'react'
import type { AuthChangeEvent, Session, SupabaseClient, User } from '@supabase/supabase-js'
import { getSupabaseConfigurationIssue, supabase } from '../../lib/supabase'

export type AuthSessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unconfigured' | 'error'

export type AuthSessionState = {
  status: AuthSessionStatus
  session: Session | null
  user: User | null
  recoveryMode: boolean
  message: string | null
}

function stateFromSession(session: Session | null, recoveryMode = false): AuthSessionState {
  return {
    status: session ? 'authenticated' : 'anonymous',
    session,
    user: session?.user ?? null,
    recoveryMode,
    message: null,
  }
}

export function useAuthSession(client: SupabaseClient | null = supabase): AuthSessionState {
  const [state, setState] = useState<AuthSessionState>(() =>
    client
      ? { status: 'loading', session: null, user: null, recoveryMode: false, message: null }
      : {
          status: 'unconfigured',
          session: null,
          user: null,
          recoveryMode: false,
          message: getSupabaseConfigurationIssue(),
        },
  )

  useEffect(() => {
    if (!client) return

    let active = true
    const applySession = (event: AuthChangeEvent | null, session: Session | null) => {
      if (!active) return
      setState((current) =>
        stateFromSession(
          session,
          event === 'PASSWORD_RECOVERY' || (Boolean(session) && current.recoveryMode),
        ),
      )
    }

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => applySession(event, session))

    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        setState({
          status: 'error',
          session: null,
          user: null,
          recoveryMode: false,
          message: 'We could not verify your account session. Refresh the page to try again.',
        })
        return
      }
      applySession(null, data.session)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [client])

  return client
    ? state
    : {
        status: 'unconfigured',
        session: null,
        user: null,
        recoveryMode: false,
        message: getSupabaseConfigurationIssue(),
      }
}
