import { useContext, useEffect, useRef, type ReactNode } from 'react'
import { Dialog } from '../../../components/Dialog'
import { revealInvalidField } from '../../../components/formFeedback'

import { ConfigurationErrorContext } from './configurationErrorContext'

export function ConfigurationReview({
  title,
  description,
  busy,
  onCancel,
  children,
}: {
  title: string
  description: string
  busy: boolean
  onCancel: () => void
  children: ReactNode
}) {
  const titleFocus = useRef<HTMLDivElement>(null)
  const { error, clear } = useContext(ConfigurationErrorContext)
  useEffect(() => {
    clear()
  }, [clear])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
      title={title}
      description={description}
      initialFocusRef={titleFocus}
      className="admin-portal admin-review-dialog"
      dismissible={!busy}
    >
      <div
        ref={titleFocus}
        tabIndex={-1}
        className="admin-review-body"
        onSubmitCapture={revealInvalidField}
      >
        {error && (
          <p className="admin-feedback-error" role="alert">
            {error}
          </p>
        )}
        {children}
        {busy && (
          <p className="admin-field-hint" role="status">
            Saving… Please keep this review open.
          </p>
        )}
      </div>
    </Dialog>
  )
}
