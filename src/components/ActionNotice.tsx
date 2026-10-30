import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import './ActionNotice.css'

export type ActionMessage = Readonly<{
  kind: 'success' | 'error'
  message: string
  /** A few words naming the outcome. Defaults to a generic title for the kind. */
  title?: string
  /** What to do next, shown under the message. */
  hint?: string
}>

const SUCCESS_DISMISS_MS = 6000

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
    const timer = window.setTimeout(() => dismiss.current(), SUCCESS_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [notice, paused])
  if (!host || !notice) return null
  const title = notice.title ?? (notice.kind === 'success' ? 'Done' : 'That did not work')
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
      <span className="action-notice-icon">
        {notice.kind === 'success' ? (
          <CheckCircle2 size={18} aria-hidden="true" />
        ) : (
          <CircleAlert size={18} aria-hidden="true" />
        )}
      </span>
      <p role={notice.kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
        {visible ? (
          <>
            <strong>{title}</strong> <span>{notice.message}</span>
            {notice.hint && (
              <>
                {' '}
                <span className="action-notice-hint">{notice.hint}</span>
              </>
            )}
          </>
        ) : (
          ''
        )}
      </p>
      <button type="button" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={18} aria-hidden="true" />
      </button>
      {notice.kind === 'success' && (
        <span
          key={paused ? 'paused' : 'running'}
          className={`action-notice-timer${paused ? ' action-notice-timer-paused' : ''}`}
          style={{ animationDuration: `${SUCCESS_DISMISS_MS}ms` }}
          aria-hidden="true"
        />
      )}
    </div>,
    host,
  )
}
