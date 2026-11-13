import { useCallback, useEffect, useState } from 'react'
import type { PartnerDataError, PartnerDataGateway } from '../api'
import { nothingToShow } from './earnings'
import type { ProgramEarnings, ProgramEarningsResult } from './earnings'

export type ProgramEarningsState =
  | { status: 'loading' }
  /** Program money does not exist for this account or this deployment: show nothing. */
  | { status: 'hidden' }
  | { status: 'ready'; earnings: ProgramEarnings }
  | { status: 'error'; error: PartnerDataError | null }

const missing: ProgramEarningsResult = {
  data: null,
  status: 'error',
  error: { code: 'contract_unavailable', message: 'Not available yet.', retryable: false },
}

const thrown: ProgramEarningsResult = {
  data: null,
  status: 'error',
  error: { code: 'temporarily_unavailable', message: 'Temporarily unavailable.', retryable: true },
}

function stateOf(result: ProgramEarningsResult): ProgramEarningsState {
  if (result.data) return { status: 'ready', earnings: result.data }
  if (nothingToShow(result)) return { status: 'hidden' }
  return { status: 'error', error: result.error }
}

/** Reads the creator's program earnings once, and again on `retry`. */
export function useProgramEarnings(gateway: PartnerDataGateway) {
  const [state, setState] = useState<ProgramEarningsState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    const request = gateway.getProgramEarnings
      ? gateway.getProgramEarnings()
      : Promise.resolve(missing)
    void request
      .catch(() => thrown)
      .then((result) => {
        if (current) setState(stateOf(result))
      })
    return () => {
      current = false
    }
  }, [gateway, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  return { state, retry }
}
