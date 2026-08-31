import { useRef, type FocusEvent, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
  wide?: boolean
}

function isVisibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.hasAttribute('disabled')) return false
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
  else if (control.bottom > viewport.bottom - 16)
    dialog.scrollTop += control.bottom - viewport.bottom + 16
}

export function Dialog({ open, onOpenChange, title, description, children, wide }: Props) {
  const opener = useRef<HTMLElement | null>(null)
  const openedHash = useRef('')
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''}`}
          onFocusCapture={revealFocusedControl}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement as HTMLElement | null
            openedHash.current = window.location.hash
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (
              window.location.hash !== openedHash.current ||
              !isVisibleFocusTarget(opener.current)
            )
              document.getElementById('main-content')?.focus({ preventScroll: true })
            else opener.current.focus({ preventScroll: true })
          }}
        >
          <div className="dialog-heading">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="icon-button" aria-label="Close dialog">
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
