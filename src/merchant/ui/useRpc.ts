import type { ReportCursor } from '../api'
import { useCallback, useEffect, useRef, useState } from 'react'

export type RpcState<T> = {
  data: T | undefined
  error: string | null
  loading: boolean
  updatedAt: number | null
  refresh: () => Promise<void>
}

/**
 * Loads data and keeps it fresh. A refresh keeps the values on screen and only
 * swaps them when the new ones arrive; a failed refresh keeps the last good data.
 */
export function useRpc<T>(
  key: string,
  load: () => Promise<T>,
  options: { pollMs?: number; enabled?: boolean } = {},
): RpcState<T> {
  const { pollMs, enabled = true } = options
  const [state, setState] = useState<{
    key: string | null
    data?: T
    error: string | null
    refreshing: boolean
    updatedAt: number | null
  }>({
    key: null,
    error: null,
    refreshing: false,
    updatedAt: null,
  })
  const loader = useRef(load)
  const generation = useRef(0)

  useEffect(() => {
    loader.current = load
  })

  // Every state change happens after the request settles, so loading the first
  // time is derived from the key rather than set before the request.
  const fetchNow = useCallback(async () => {
    const run = ++generation.current
    try {
      const data = await loader.current()
      if (run !== generation.current) return
      setState({ key, data, error: null, refreshing: false, updatedAt: Date.now() })
    } catch (problem) {
      if (run !== generation.current) return
      setState((current) => ({
        ...(current.key === key ? current : { data: undefined, updatedAt: null }),
        key,
        error: problem instanceof Error ? problem.message : 'Could not load this.',
        refreshing: false,
      }))
    }
  }, [key])

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, refreshing: true }))
    await fetchNow()
  }, [fetchNow])

  useEffect(() => {
    if (!enabled) return
    void fetchNow()
    if (!pollMs) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void fetchNow()
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [enabled, pollMs, fetchNow])

  const current = state.key === key
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    loading: current ? state.refreshing : enabled,
    updatedAt: current ? state.updatedAt : null,
    refresh,
  }
}

/** Keep the pages already read while a bounded request loads the next page. */
export function usePagedRpc<
  T extends { rows: { id: string }[]; total: number; next_cursor?: ReportCursor | null },
>(key: string, load: (offset: number, cursor?: ReportCursor) => Promise<T>, pollMs: number) {
  const [history, setHistory] = useState<{ key: string; offset: number; page: T }>()
  const previous = history?.key === key ? history : undefined
  const offset = previous?.offset ?? 0
  const current = useRpc(
    `${key}:${offset}`,
    () => load(offset, previous?.page.next_cursor ?? undefined),
    {
      pollMs: offset ? undefined : pollMs,
    },
  )
  const latest = current.data
  const ids = new Set(previous?.page.rows.map((row) => row.id))
  const data =
    latest && previous
      ? ({
          ...latest,
          rows: [...previous.page.rows, ...latest.rows.filter((row) => !ids.has(row.id))],
        } as T)
      : (latest ?? previous?.page)
  const hasNext = Boolean(
    latest?.rows.length &&
    (latest.next_cursor === undefined
      ? offset + latest.rows.length < latest.total
      : latest.next_cursor),
  )
  const more = () => {
    if (data && latest && hasNext) {
      setHistory({ key, offset: offset + latest.rows.length, page: data })
    }
  }
  return {
    ...current,
    data,
    more,
    canLoadMore: hasNext,
  }
}
