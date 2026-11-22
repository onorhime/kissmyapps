import { useSyncExternalStore } from 'react'
import type { Range } from '../api'
import { isCustomRange } from '../ranges'

const eventName = 'kma-report-period'
function subscribe(notify: () => void) {
  window.addEventListener('hashchange', notify)
  window.addEventListener(eventName, notify)
  return () => {
    window.removeEventListener('hashchange', notify)
    window.removeEventListener(eventName, notify)
  }
}
function routeParams() {
  const [route, query] = window.location.hash.split('?')
  return { route, params: new URLSearchParams(query) }
}
/** Store the selected report period in the dashboard route so a shared URL opens the same period. */
export function useReportPeriod<T extends Range>(
  fallback: T,
  options: ReadonlyArray<{ value: T }>,
): [T, (next: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => routeParams().params.get('range'),
    () => null,
  )
  const range =
    options.find((item) => item.value === raw)?.value ??
    (raw && isCustomRange(raw) ? (raw as T) : fallback)
  function change(next: T) {
    const { route, params } = routeParams()
    params.set('range', next)
    window.history.replaceState(window.history.state, '', `${route}?${params.toString()}`)
    window.dispatchEvent(new Event(eventName))
  }
  return [range, change]
}
