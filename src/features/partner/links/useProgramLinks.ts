import { useCallback, useEffect, useRef, useState } from 'react'
import type { PartnerDataGateway } from '../api'
import { linkError, linksUnavailable, staleAfter, withProgram } from './links'
import type { LinkProgram, ProgramLinks, ProgramLinksError, ProgramLinksResult } from './links'

export type ProgramLinksState =
  | { status: 'loading' }
  /** Program links do not exist for this account or this deployment. */
  | { status: 'unavailable'; error: ProgramLinksError | null }
  | { status: 'ready'; links: ProgramLinks }
  | { status: 'error'; error: ProgramLinksError | null }

/** What adding or removing a link came to: the program as it is now, or why it did not go. */
export type LinkChange =
  { program: LinkProgram; error: null } | { program: null; error: ProgramLinksError }

function missing<T>(): Promise<ProgramLinksResult<T | null>> {
  return Promise.resolve({
    data: null,
    status: 'error',
    error: linkError('contract_unavailable'),
  })
}

function thrown<T>(): ProgramLinksResult<T | null> {
  return { data: null, status: 'error', error: linkError('temporarily_unavailable') }
}

function stateOf(result: ProgramLinksResult<ProgramLinks | null>): ProgramLinksState {
  if (result.data) return { status: 'ready', links: result.data }
  if (result.status === 'unconfigured' || linksUnavailable(result.error))
    return { status: 'unavailable', error: result.error }
  return { status: 'error', error: result.error }
}

/**
 * Reads the creator's program links once and again on `retry`, and adds and removes custom
 * links. A change answers with the program as it is afterwards, which replaces the one on the
 * page; a change that failed because the page was out of date reads everything again quietly.
 */
export function useProgramLinks(gateway: PartnerDataGateway) {
  const [state, setState] = useState<ProgramLinksState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const read = useCallback(
    () =>
      (gateway.getProgramLinks ? gateway.getProgramLinks() : missing<ProgramLinks>()).catch(() =>
        thrown<ProgramLinks>(),
      ),
    [gateway],
  )

  useEffect(() => {
    let current = true
    void read().then((result) => {
      if (current) setState(stateOf(result))
    })
    return () => {
      current = false
    }
  }, [read, attempt])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  /** Reads again without clearing the page. What is on screen stays if the read fails. */
  const refresh = useCallback(async () => {
    const result = await read()
    if (mounted.current && result.data) setState({ status: 'ready', links: result.data })
  }, [read])

  const settle = useCallback(
    (result: ProgramLinksResult<LinkProgram | null>): LinkChange => {
      const program = result.data
      if (program) {
        if (mounted.current)
          setState((current) =>
            current.status === 'ready'
              ? { status: 'ready', links: withProgram(current.links, program) }
              : current,
          )
        return { program, error: null }
      }
      const error = result.error ?? linkError('unknown')
      if (staleAfter(error)) void refresh()
      return { program: null, error }
    },
    [refresh],
  )

  const addLink = useCallback(
    async (slug: string, name: string): Promise<LinkChange> =>
      settle(
        await (
          gateway.createProgramLink
            ? gateway.createProgramLink({ slug, name })
            : missing<LinkProgram>()
        ).catch(() => thrown<LinkProgram>()),
      ),
    [gateway, settle],
  )

  const removeLink = useCallback(
    async (linkId: string): Promise<LinkChange> =>
      settle(
        await (
          gateway.removeProgramLink ? gateway.removeProgramLink(linkId) : missing<LinkProgram>()
        ).catch(() => thrown<LinkProgram>()),
      ),
    [gateway, settle],
  )

  return { state, retry, addLink, removeLink }
}
