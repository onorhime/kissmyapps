import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import './ActionNotice.css'

export type ActionMessage = Readonly<{ kind: 'success' | 'error'; message: string }>

export function StatusNotice({
  success,
  error,
}: {
  success?: string | null
  error?: string | null
}) {
  const notice = useMemo<ActionMessage | null>(
    () =>
      error
        ? { kind: 'error', message: error }
        : success
          ? { kind: 'success', message: success }
          : null,
    [success, error],
  )
  const [dismissed, setDismissed] = useState<ActionMessage | null>(null)
  return (
    <ActionNotice
      notice={notice === dismissed ? null : notice}
      onDismiss={() => setDismissed(notice)}
    />
  )
}

/** Each surface owns its messages; a shared portal stacks them without layout shift. */
export function ActionNotice({
  notice,
  onDismiss,
}: {
  notice: ActionMessage | null
  onDismiss: () => void
}) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const [announcedNotice, setAnnouncedNotice] = useState<ActionMessage | null>(null)
  const visible = announcedNotice === notice
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    let element = document.getElementById('action-notice-stack')
    if (!element) {
      element = document.createElement('div')
      element.id = 'action-notice-stack'
      element.className = 'action-notice-stack'
      document.body.append(element)
    }
    // Synchronize with the shared DOM portal, which may be created by another surface.
    // eslint-disable-next-line react/set-state-in-effect
    setHost(element)
    // Retain the empty shared host across StrictMode effect replays. Each portal
    // removes only its own messages when its account/page unmounts.
  }, [])
  useEffect(() => {
    // Insert the live region empty first, then announce even repeated messages.
    const timer = window.setTimeout(() => setAnnouncedNotice(notice), 0)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!notice || notice.kind !== 'success' || paused) return
    const timer = window.setTimeout(() => dismiss.current(), 6000)
    return () => window.clearTimeout(timer)
  }, [notice, paused])
  if (!host || !notice) return null
  return createPortal(
    <div
      className={`action-notice action-notice-${notice.kind}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      {notice.kind === 'success' ? (
        <CheckCircle2 size={20} aria-hidden="true" />
      ) : (
        <CircleAlert size={20} aria-hidden="true" />
      )}
      <p role={notice.kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
        {visible ? notice.message : ''}
      </p>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </button>
    </div>,
    host,
  )
}
