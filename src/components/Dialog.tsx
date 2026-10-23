import { useRef, type FocusEvent, type ReactNode, type RefObject } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
  wide?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
  dismissible?: boolean
  restoreFocusAcrossRoutes?: boolean
}

function isVisibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (
    !element?.isConnected ||
    element === document.body ||
    element === document.documentElement ||
    element.matches(':disabled')
  )
    return false
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (
      current.hidden ||
      current.inert ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    )
      return false
  }
  return true
}

function revealFocusedControl(event: FocusEvent<HTMLDivElement>) {
  const dialog = event.currentTarget
  const target = event.target
  if (target === dialog || !(target instanceof HTMLElement)) return
  const viewport = dialog.getBoundingClientRect()
  const control = target.getBoundingClientRect()
  if (viewport.height <= 0) return
  // Radix intentionally prevents document scrolling when focus loops. Reveal
  // that control inside this scrollable dialog without moving the page behind it.
  if (control.top < viewport.top + 16) dialog.scrollTop += control.top - viewport.top - 16
  else if (control.height < viewport.height - 32 && control.bottom > viewport.bottom - 16)
    dialog.scrollTop += control.bottom - viewport.bottom + 16
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
  initialFocusRef,
  className = '',
  dismissible = true,
  restoreFocusAcrossRoutes = false,
}: Props) {
  const opener = useRef<HTMLElement | null>(null)
  const openerContainer = useRef<HTMLElement | null>(null)
  const openedHash = useRef('')
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''} ${className}`}
          onFocusCapture={revealFocusedControl}
          onOpenAutoFocus={(event) => {
            opener.current = document.activeElement as HTMLElement | null
            openerContainer.current = opener.current?.closest('article, section') ?? null
            openedHash.current = window.location.hash
            if (initialFocusRef?.current) {
              event.preventDefault()
              initialFocusRef.current.focus()
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const sameRoute =
              restoreFocusAcrossRoutes || window.location.hash === openedHash.current
            if (sameRoute && isVisibleFocusTarget(opener.current)) {
              opener.current.focus({ preventScroll: true })
              return
            }
            if (sameRoute && openerContainer.current?.isConnected) {
              const heading = openerContainer.current.querySelector<HTMLElement>('h2, h3')
              if (heading) {
                heading.tabIndex = -1
                heading.focus({ preventScroll: true })
                return
              }
            }
            ;(
              document.getElementById('main-content') ??
              document.getElementById('admin-main-content')
            )?.focus({ preventScroll: true })
          }}
        >
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="icon-button"
              aria-label="Close dialog"
              disabled={!dismissible}
            >
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
