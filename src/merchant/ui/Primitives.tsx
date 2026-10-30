import { useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, ChevronDown, Copy, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type { Platform, Project, Traits } from '../api'
import { formatAgo, personHue, personLabel, platformLabels } from '../format'
import { useStore } from '../store'

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: ReactNode }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="mc-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  mono = false,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; group?: string }>
  onChange: (value: T) => void
  hideLabel?: boolean
  mono?: boolean
}) {
  const id = useId()
  // Neighbouring options with the same group go under one heading.
  const runs: Array<{ group?: string; options: typeof options }> = []
  for (const option of options) {
    const last = runs.at(-1)
    if (last && last.group === option.group) last.options.push(option)
    else runs.push({ group: option.group, options: [option] })
  }
  const list = (items: typeof options) =>
    items.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ))
  return (
    <span className={hideLabel ? 'mc-select is-bare' : 'mc-select'}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </label>
      <span className="mc-select-box">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          className={mono ? 'mc-mono' : undefined}
        >
          {runs.map((run, index) =>
            run.group ? (
              <optgroup key={`${run.group}-${index}`} label={run.group}>
                {list(run.options)}
              </optgroup>
            ) : (
              list(run.options)
            ),
          )}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </span>
  )
}

export type PillTone = 'positive' | 'negative' | 'warning' | 'neutral' | 'info'

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`mc-pill is-${tone}`}>{children}</span>
}

const projectHues = ['blue', 'amber', 'pink', 'green', 'violet', 'teal'] as const

export function ProjectMark({
  project,
  size = 32,
}: {
  project: Pick<Project, 'id' | 'name'>
  size?: number
}) {
  const letters = project.name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+|(?<=[a-z])(?=[A-Z0-9])/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className={`mc-project-mark is-${projectHues[personHue(project.id)]}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
    >
      {letters || '·'}
    </span>
  )
}

export function PlatformList({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="mc-platforms">
      {platforms.map((platform) => platformLabels[platform]).join(', ')}
    </span>
  )
}

/** A person's initial on their own pale tint; the same person always gets the same one. */
export function Avatar({ id, name, size = 32 }: { id: string; name: string; size?: number }) {
  const initial =
    name
      .replace(/^Anonymous /, '')
      .match(/[\p{L}\p{N}]/u)?.[0]
      ?.toUpperCase() ?? '?'
  return (
    <span
      className={`mc-person-avatar is-tint-${personHue(id)}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}

export function PersonCell({
  person,
  href,
  online,
}: {
  person: {
    distinct_id: string
    user_id?: string | null
    traits?: Traits | null
    id?: string
    person_id?: string
  }
  href?: string
  online?: boolean
}) {
  const label = personLabel(person)
  const id = person.id ?? person.person_id ?? person.distinct_id
  const body = (
    <>
      <span className="mc-person-avatar-wrap">
        <Avatar id={id} name={label.name} />
        {online && <span className="mc-online-badge" aria-label="Online now" />}
      </span>
      <span className="mc-person-text">
        <strong className="mc-truncate">{label.name}</strong>
        <span className="mc-truncate mc-muted">
          {label.anonymous ? 'Not signed in' : (label.detail ?? 'Signed in')}
        </span>
      </span>
    </>
  )
  return href ? (
    <a className="mc-person" href={href}>
      {body}
    </a>
  ) : (
    <span className="mc-person">{body}</span>
  )
}

export function LiveDot({ label = 'Live' }: { label?: string }) {
  return <span className="mc-live-dot" role="img" aria-label={label} />
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

export function CopyButton({
  value,
  label,
  compact = false,
  text = 'Copy',
}: {
  value: string
  label: string
  compact?: boolean
  /** The button's words when not compact. */
  text?: string
}) {
  const { notify } = useStore()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={compact ? 'mc-icon-btn' : 'mc-btn mc-btn-quiet'}
      aria-label={compact ? `Copy ${label}` : undefined}
      onClick={async () => {
        const ok = await copyText(value)
        notify(ok ? `Copied ${label}` : 'Copy failed. Select the text and copy it yourself.')
        if (ok) {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1_600)
        }
      }}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {!compact && <span>{copied ? 'Copied' : text}</span>}
    </button>
  )
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="mc-code">
      <div className="mc-code-head">
        <span>{label}</span>
        <CopyButton value={code} label={label.toLowerCase()} compact />
      </div>
      <pre tabIndex={0} aria-label={label}>
        <code>
          {code.split('\n').map((line, index) => {
            const trimmed = line.trim()
            const comment =
              trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('<!--')
            return (
              <span key={index} className={comment ? 'mc-code-comment' : undefined}>
                {line}
                {'\n'}
              </span>
            )
          })}
        </code>
      </pre>
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: (props: {
    id: string
    'aria-describedby'?: string
    'aria-invalid'?: boolean
  }) => ReactElement
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={error ? 'mc-field has-error' : 'mc-field'}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && (
        <p id={hintId} className="mc-field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mc-field-error">
          {error}
        </p>
      )}
    </div>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="mc-dialog-overlay" />
        <DialogPrimitive.Content className="mc-dialog mc-app-tokens">
          <div className="mc-dialog-head">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="mc-icon-btn" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useStore()
  return (
    <div className="mc-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="mc-toast">
          <span>{toast.message}</span>
          <button
            type="button"
            className="mc-icon-btn"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mc-page-head">
      <div className="mc-page-title">
        <h1 tabIndex={-1} id="mc-page-title">
          {title}
        </h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="mc-page-actions">{actions}</div>}
    </header>
  )
}

export function Panel({
  title,
  description,
  actions,
  className = '',
  flush = false,
  children,
  id,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
  flush?: boolean
  children: ReactNode
  id?: string
}) {
  return (
    <section
      className={`mc-panel ${flush ? 'mc-panel-flush' : ''} ${className}`}
      aria-labelledby={id}
    >
      <div className="mc-panel-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** One sentence where data will appear; the block keeps its frame. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="mc-empty-line">{children}</p>
}

/** A failure inside the block that failed, with when the data was last good. */
export function ErrorNote({
  message,
  updatedAt,
  onRetry,
  timezoneClock,
}: {
  message: string
  updatedAt?: number | null
  onRetry?: () => void
  timezoneClock?: (time: number) => string
}) {
  return (
    <p className="mc-error-note" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>
        {message}
        {updatedAt && timezoneClock ? ` Showing data from ${timezoneClock(updatedAt)}.` : ''}
      </span>
      {onRetry && (
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </p>
  )
}

/** A flat grey bar at the size of the value it stands for. */
export function Skeleton({
  width = '60%',
  height = 14,
}: {
  width?: number | string
  height?: number
}) {
  return <span className="mc-skeleton" style={{ width, height }} aria-hidden="true" />
}

export function Freshness({
  updatedAt,
  loading,
  onRefresh,
  now,
}: {
  updatedAt: number | null
  loading: boolean
  onRefresh: () => void
  now: number
}) {
  return (
    <span className="mc-freshness">
      <span className="mc-muted">
        {updatedAt ? `Updated ${formatAgo(updatedAt, Math.max(now, updatedAt))}` : 'Loading'}
      </span>
      <button
        type="button"
        className="mc-icon-btn"
        aria-label="Refresh"
        onClick={onRefresh}
        disabled={loading}
      >
        <RefreshCw size={16} aria-hidden="true" className={loading ? 'mc-spin' : undefined} />
      </button>
    </span>
  )
}

export function ShowMore({
  shown,
  total,
  onMore,
  noun,
}: {
  shown: number
  total: number
  onMore: () => void
  noun: string
}) {
  if (total <= shown)
    return total > 0 ? (
      <p className="mc-list-foot mc-muted">
        {total === 1 ? 'The only match is shown' : `All ${total} ${noun} shown`}
      </p>
    ) : null
  return (
    <div className="mc-list-foot">
      <span className="mc-muted">
        Showing {shown} of {total} {noun}
      </span>
      <button type="button" className="mc-btn mc-btn-secondary" onClick={onMore}>
        Show more
      </button>
    </div>
  )
}
