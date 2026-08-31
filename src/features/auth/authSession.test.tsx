import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { useAuthSession } from './authSession'

describe('auth session state', () => {
  it('loads the current session, follows auth events, and unsubscribes', async () => {
    let listener!: (event: AuthChangeEvent, session: Session | null) => void
    const unsubscribe = vi.fn()
    const getSession = vi.fn().mockResolvedValue({ data: { session: null }, error: null })
    const onAuthStateChange = vi.fn((callback) => {
      listener = callback
      return { data: { subscription: { unsubscribe } } }
    })
    const client = { auth: { getSession, onAuthStateChange } } as unknown as SupabaseClient

    const { result, unmount } = renderHook(() => useAuthSession(client))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('anonymous'))

    const session = { user: { id: 'partner-user' } } as Session
    act(() => listener('PASSWORD_RECOVERY', session))
    expect(result.current.status).toBe('authenticated')
    expect(result.current.user?.id).toBe('partner-user')
    expect(result.current.recoveryMode).toBe(true)

    act(() => listener('SIGNED_OUT', null))
    expect(result.current.status).toBe('anonymous')
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports session lookup failures without exposing provider details', async () => {
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: null },
          error: { message: 'secret database topology' },
        }),
        onAuthStateChange: vi.fn(() => ({
          data: { subscription: { unsubscribe: vi.fn() } },
        })),
      },
    } as unknown as SupabaseClient

    const { result } = renderHook(() => useAuthSession(client))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.message).toBe(
      'We could not verify your account session. Refresh the page to try again.',
    )
  })
})
