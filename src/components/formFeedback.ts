import type { FormEvent } from 'react'

/** Run after custom validation commits. Successful submits never move focus. */
export function revealInvalidField(event: FormEvent<HTMLElement>) {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  window.setTimeout(() => {
    if (!form.isConnected) return
    form.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)')?.focus()
  }, 0)
}
