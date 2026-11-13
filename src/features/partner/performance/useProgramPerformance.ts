import { useEffect, useState } from 'react'
import type { PartnerDataError, PartnerDataGateway } from '../api'
import { nothingToShow } from './performance'
import type {
  PerformanceDays,
  PerformanceQuery,
  ProgramPerformance,
  ProgramPerformanceResult,
} from './performance'

export type ProgramPerformanceState =
  /** The first answer is on its way: there is nothing to show yet. */
  | { status: 'loading' }
  /** Program results do not exist for this account or this deployment: show nothing. */
  | { status: 'hidden' }
  | { status: 'error'; error: PartnerDataError | null }
  | {
      status: 'ready'
      /** The last answer that arrived. It stays on screen while another one loads. */
      performance: ProgramPerformance
      /** Another program or number of days was asked for and has not arrived. */
      loading: boolean
      /** The last thing asked for did not arrive: `performance` is still the one before. */
      failed: PartnerDataError | null
    }

export interface ProgramPerformanceHandle {
  state: ProgramPerformanceState
  /** What the pickers show: what was asked for while it loads, otherwise what is on screen. */
  picked: PerformanceQuery
  selectProgram: (slug: string) => void
  selectDays: (days: PerformanceDays) => void
  /** Asks again for what did not arrive. */
  retry: () => void
}

const missing: ProgramPerformanceResult = {
  data: null,
  status: 'error',
  error: { code: 'contract_unavailable', message: 'Not available yet.', retryable: false },
}

const thrown: ProgramPerformanceResult = {
  data: null,
  status: 'error',
  error: { code: 'temporarily_unavailable', message: 'Temporarily unavailable.', retryable: true },
}

function after(
  before: ProgramPerformanceState,
  result: ProgramPerformanceResult,
): ProgramPerformanceState {
  if (result.data)
    return { status: 'ready', performance: result.data, loading: false, failed: null }
  // An answer is on screen: it stays, and the page says the new one did not arrive.
  if (before.status === 'ready')
    return { ...before, loading: false, failed: result.error ?? thrown.error }
  if (nothingToShow(result)) return { status: 'hidden' }
  return { status: 'error', error: result.error }
}

/**
 * Reads the creator's results for one program over 7, 30 or 90 days, starting with their first
 * program and 30 days, and again whenever another program or number of days is picked. The
 * answer on screen stays there until the next one arrives.
 *
 * `active` is false while the page is not the one being shown, so nothing is read for it.
 */
export function useProgramPerformance(
  gateway: PartnerDataGateway,
  active = true,
): ProgramPerformanceHandle {
  const [query, setQuery] = useState<PerformanceQuery>({ slug: null, days: 30 })
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ProgramPerformanceState>(() =>
    gateway.getProgramPerformance ? { status: 'loading' } : { status: 'hidden' },
  )

  useEffect(() => {
    if (!active) return
    let current = true
    const request = gateway.getProgramPerformance
      ? gateway.getProgramPerformance(query)
      : Promise.resolve(missing)
    void request
      .catch(() => thrown)
      .then((result) => {
        if (!current) return
        // The program asked for is no longer one of theirs: go back to their first program.
        if (result.error?.code === 'not_found' && query.slug !== null) {
          setQuery({ slug: null, days: query.days })
          return
        }
        setState((before) => after(before, result))
      })
    return () => {
      current = false
    }
  }, [gateway, active, query, attempt])

  const shown: PerformanceQuery | null =
    state.status === 'ready'
      ? { slug: state.performance.program?.slug ?? null, days: state.performance.days }
      : null
  const picked = state.status === 'ready' && state.loading ? query : (shown ?? query)

  function ask(next: PerformanceQuery) {
    if (state.status !== 'ready') return
    if (next.slug === picked.slug && next.days === picked.days) {
      // Picking what is already on screen: nothing to read, and nothing left to complain about.
      if (state.failed) setState({ ...state, failed: null })
      return
    }
    setQuery(next)
    setState({ ...state, loading: true, failed: null })
  }

  return {
    state,
    picked,
    selectProgram: (slug) => ask({ slug, days: picked.days }),
    selectDays: (days) => ask({ slug: picked.slug, days }),
    retry: () => {
      setState((before) =>
        before.status === 'ready'
          ? { ...before, loading: true, failed: null }
          : { status: 'loading' },
      )
      setAttempt((value) => value + 1)
    },
  }
}
