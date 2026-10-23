import { createContext, useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Dialog } from './Dialog'

export const NavigationGuardContext = createContext<(action: () => void) => void>((action) =>
  action(),
)

function values(form: HTMLFormElement) {
  return JSON.stringify(
    Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea',
      ),
    ).map((field) => {
      if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type))
        return field.checked
      if (field instanceof HTMLInputElement && field.type === 'password') return field.value.length
      return field.value
    }),
  )
}

/** Capture a create form before an inline editor temporarily replaces its fields. */
export function observeForm(form: HTMLFormElement | null) {
  form?.dispatchEvent(new Event('kma:form-observed', { bubbles: true }))
}

/** Mark only the submitted form clean, after the successful handler resets its fields. */
export function markFormSaved(form: HTMLFormElement | null) {
  window.setTimeout(() => {
    if (form?.isConnected) form.dispatchEvent(new Event('kma:form-saved', { bubbles: true }))
  }, 0)
}

export function discardScopeDrafts(scope: HTMLElement | null) {
  scope?.dispatchEvent(new Event('kma:discard-scope', { bubbles: true }))
}

export function useFormNavigationGuard(enabled = true, scope = '') {
  const forms = useRef(new Map<HTMLFormElement, string>())
  const root = useRef<HTMLElement | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [destination, setDestination] = useState<(() => void) | null>(null)
  const dirty = useCallback(() => {
    for (const [form, baseline] of forms.current) {
      if (!form.isConnected) {
        forms.current.delete(form)
        continue
      }
      if (values(form) !== baseline) return true
    }
    return false
  }, [])
  const pending = useCallback(
    () =>
      Boolean(
        root.current?.querySelector(
          '[data-navigation-pending="true"], form[aria-busy="true"], form [aria-busy="true"]',
        ),
      ),
    [],
  )
  useEffect(() => {
    forms.current.clear()
    // Drop pending navigation together with the external account's tracked DOM forms.
    // eslint-disable-next-line react/set-state-in-effect
    setDestination(null)
    setWaiting(false)
  }, [enabled, scope])
  useEffect(() => {
    if (!enabled) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty() && !pending()) return
      event.preventDefault()
      event.returnValue = ''
    }
    const saved = (event: Event) => {
      if (event.target instanceof HTMLFormElement && forms.current.has(event.target))
        forms.current.set(event.target, values(event.target))
    }
    const observed = (event: Event) => {
      if (event.target instanceof HTMLFormElement && !forms.current.has(event.target))
        forms.current.set(event.target, values(event.target))
    }
    const discard = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return
      for (const form of forms.current.keys())
        if (event.target.contains(form)) forms.current.delete(form)
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('kma:form-saved', saved)
    document.addEventListener('kma:form-observed', observed)
    document.addEventListener('kma:discard-scope', discard)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('kma:form-saved', saved)
      document.removeEventListener('kma:form-observed', observed)
      document.removeEventListener('kma:discard-scope', discard)
    }
  }, [enabled, dirty, pending])
  const capture = (event: SyntheticEvent<HTMLElement>) => {
    if (!enabled || !(event.target instanceof HTMLElement)) return
    root.current = event.currentTarget
    const form = event.target.closest('form')
    if (
      form &&
      form.getAttribute('role') !== 'search' &&
      !form.className.includes('filter') &&
      !forms.current.has(form)
    )
      forms.current.set(form, values(form))
  }
  const request = useCallback(
    (action: () => void) => {
      if (enabled && pending()) setWaiting(true)
      else if (enabled && dirty()) setDestination(() => action)
      else action()
    },
    [enabled, dirty, pending],
  )
  const dialog = waiting ? (
    <Dialog
      open
      onOpenChange={setWaiting}
      title="Save in progress"
      description="Please wait for the save result before leaving this page. Closing this notice does not cancel the save."
    >
      <div className="dialog-actions">
        <button type="button" className="button button-white" onClick={() => setWaiting(false)}>
          Stay on this page
        </button>
      </div>
    </Dialog>
  ) : (
    <Dialog
      open={Boolean(destination)}
      onOpenChange={(open) => {
        if (!open) setDestination(null)
      }}
      title="Leave unsaved changes?"
      description="Your unsaved form changes will be discarded. Saved records will not be changed."
    >
      <div className="dialog-actions">
        <button type="button" className="button button-white" onClick={() => setDestination(null)}>
          Keep editing
        </button>
        <button
          type="button"
          className="button button-green"
          onClick={() => {
            const next = destination
            forms.current.clear()
            setDestination(null)
            next?.()
          }}
        >
          Discard changes and leave
        </button>
      </div>
    </Dialog>
  )
  return { capture, request, dialog }
}
