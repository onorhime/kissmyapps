import { useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, ChevronDown, Copy, X } from 'lucide-react'
import type { Platform, Project } from '../data/sample'
import { platformLabels } from '../data/sample'
import { useStore } from '../store'

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
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
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  hideLabel?: boolean
  mono?: boolean
}) {
  const id = useId()
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
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
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

export function ProjectMark({
  project,
  size = 32,
}: {
  project: Pick<Project, 'name' | 'hue'>
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
      className={`mc-project-mark is-${project.hue}`}
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
}: {
  value: string
  label: string
  compact?: boolean
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
      {!compact && <span>{copied ? 'Copied' : 'Copy'}</span>}
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
            const comment = trimmed.startsWith('//') || trimmed.startsWith('#')
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
