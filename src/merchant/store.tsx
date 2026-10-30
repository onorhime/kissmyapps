/* eslint-disable react/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { getSupabaseConfigurationIssue, supabase } from '../lib/supabase'
import { api, ApiError } from './api'
import type { Context, Project, Workspace } from './api'
import { navigate } from './routes'

type Status = 'loading' | 'signed-out' | 'ready' | 'error' | 'unconfigured'
type Toast = { id: number; message: string }

type Store = {
  status: Status
  error: string | null
  user: Context['user'] | null
  workspaces: Workspace[]
  workspace: Workspace | null
  projects: Project[]
  now: number
  toasts: Toast[]
  refreshContext: () => Promise<void>
  selectWorkspace: (id: string) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (details: {
    name: string
    company: string
    email: string
    password: string
  }) => Promise<'signed-in' | 'confirm-email'>
  recover: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  signOut: () => Promise<void>
  notify: (message: string) => void
  dismissToast: (id: number) => void
}

const StoreContext = createContext<Store | null>(null)
const WORKSPACE_KEY = 'kma:merchant:workspace'

function readWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null
  }
}

function authMessage(error: { message?: string; status?: number; code?: string } | null): string {
  const message = error?.message ?? ''
  if (/invalid login credentials/i.test(message))
    return 'That email and password do not match an account.'
  if (/email not confirmed/i.test(message))
    return 'Confirm your email first: open the link we sent you.'
  if (/already registered|already exists/i.test(message))
    return 'An account with this email already exists. Sign in instead.'
  if (/rate limit|too many/i.test(message) || error?.status === 429)
    return 'Too many attempts. Wait a minute and try again.'
  if (/password/i.test(message) && /(weak|short|least|characters)/i.test(message)) return message
  return message || 'Something went wrong. Try again.'
}

/** The URL GoTrue sends people back to after a confirmation or reset email. */
function returnUrl(hash: string): string {
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}${hash}`
}

export function MerchantStoreProvider({ children }: { children: ReactNode }) {
  const configurationIssue = getSupabaseConfigurationIssue()
  const [status, setStatus] = useState<Status>(configurationIssue ? 'unconfigured' : 'loading')
  const [error, setError] = useState<string | null>(configurationIssue)
  const [context, setContext] = useState<Context | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(readWorkspace)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [now, setNow] = useState(() => Date.now())
  const nextToast = useRef(1)
  const bootstrapped = useRef<string | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const load = useCallback(async (bootstrap: boolean) => {
    try {
      const next = bootstrap ? await api.bootstrap() : await api.context()
      setContext(next)
      setError(null)
      setStatus('ready')
    } catch (problem) {
      if (problem instanceof ApiError && /expired|sign in/i.test(problem.message)) {
        await supabase?.auth.signOut()
        return
      }
      setError(problem instanceof Error ? problem.message : 'The workspace could not load.')
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    if (!supabase) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Supabase calls must not run inside this callback, so they are deferred.
      window.setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') navigate({ name: 'new-password' }, true)
        if (!session) {
          bootstrapped.current = null
          setContext(null)
          setStatus('signed-out')
          return
        }
        if (bootstrapped.current === session.user.id) return
        bootstrapped.current = session.user.id
        void load(true)
      }, 0)
    })
    return () => subscription.unsubscribe()
  }, [load])

  const notify = useCallback((message: string) => {
    const id = nextToast.current++
    setToasts((current) => [...current.slice(-2), { id, message }])
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      4_500,
    )
  }, [])

  const value = useMemo<Store>(() => {
    const workspaces = context?.workspaces ?? []
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? workspaces[0] ?? null
    const client = () => {
      if (!supabase) throw new Error(configurationIssue ?? 'Sign-in is not configured.')
      return supabase
    }
    return {
      status,
      error,
      user: context?.user ?? null,
      workspaces,
      workspace,
      projects: workspace?.projects ?? [],
      now,
      toasts,
      refreshContext: () => load(false),
      selectWorkspace: (id) => {
        setWorkspaceId(id)
        try {
          localStorage.setItem(WORKSPACE_KEY, id)
        } catch {
          /* The choice then lasts for this page only. */
        }
      },
      signIn: async (email, password) => {
        const { error: problem } = await client().auth.signInWithPassword({ email, password })
        if (problem) throw new Error(authMessage(problem))
      },
      signUp: async ({ name, company, email, password }) => {
        const { data, error: problem } = await client().auth.signUp({
          email,
          password,
          options: { data: { full_name: name, company }, emailRedirectTo: returnUrl('') },
        })
        if (problem) throw new Error(authMessage(problem))
        // An existing address comes back without identities when confirmation is on.
        if (data.user && data.user.identities?.length === 0) {
          throw new Error('An account with this email already exists. Sign in instead.')
        }
        return data.session ? 'signed-in' : 'confirm-email'
      },
      recover: async (email) => {
        const { error: problem } = await client().auth.resetPasswordForEmail(email, {
          redirectTo: returnUrl('#new-password'),
        })
        if (problem) throw new Error(authMessage(problem))
      },
      updatePassword: async (password) => {
        const { error: problem } = await client().auth.updateUser({ password })
        if (problem) throw new Error(authMessage(problem))
      },
      signOut: async () => {
        await client().auth.signOut()
        navigate({ name: 'sign-in' }, true)
      },
      notify,
      dismissToast: (id) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    }
  }, [configurationIssue, context, error, load, notify, now, status, toasts, workspaceId])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore needs MerchantStoreProvider')
  return store
}

/** Whether the signed-in member's role reaches the given one. */
export function canDo(
  role: string | undefined,
  needed: 'admin' | 'developer' | 'analyst',
): boolean {
  const rank: Record<string, number> = { owner: 4, admin: 3, developer: 2, analyst: 1 }
  return (rank[role ?? ''] ?? 0) >= rank[needed]
}
