import type { ReactNode } from 'react'
import { AlertCircle, ArrowRight, CircleDashed, Inbox, RefreshCw } from 'lucide-react'

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string
  description: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-art">
        <span />
        <span />
        <span />
        <div>{icon ?? <Inbox size={28} />}</div>
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="skeleton-metrics">
        {[0, 1, 2, 3].map((item) => (
          <div key={item}>
            <i />
            <b />
            <i />
          </div>
        ))}
      </div>
      <div className="skeleton-panel">
        <i />
        <div />
      </div>
      <div className="skeleton-panel skeleton-rows">
        {[0, 1, 2, 3].map((item) => (
          <i key={item} />
        ))}
      </div>
    </div>
  )
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="panel">
      <EmptyState
        icon={<AlertCircle size={28} />}
        title="This report is temporarily unavailable"
        description="We couldn’t load the data. Unavailable values stay blank instead of appearing as zero."
        action={
          <button className="button button-green" onClick={onRetry}>
            <RefreshCw size={15} /> Retry preview
          </button>
        }
      />
      <div className="panel-footnote">
        <AlertCircle size={13} /> Simulated error state · No live connection has been attempted.
      </div>
    </div>
  )
}

export function PartialNotice() {
  return (
    <div className="partial-notice" role="status">
      <CircleDashed size={17} />
      <div>
        <strong>Some attribution data is unavailable in this preview.</strong>
        <p>
          Confirmed installs and activations are shown as “—”. Available reporting remains visible.
        </p>
      </div>
    </div>
  )
}

export function PreviewActionNote({ children }: { children: ReactNode }) {
  return (
    <div className="preview-action-note">
      <ArrowRight size={14} />
      <span>{children}</span>
    </div>
  )
}
