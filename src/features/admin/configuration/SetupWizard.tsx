import type { ReactNode, RefObject } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleDashed, Settings2 } from 'lucide-react'
import { setupProgress, type SetupStep, type SetupStepId } from './setupSteps'

export function SetupProgress({ steps }: { steps: readonly SetupStep[] }) {
  const { complete, total } = setupProgress(steps)
  const percent = total ? Math.round((complete / total) * 100) : 0
  const finished = total > 0 && complete === total
  return (
    <div className="admin-setup-progress">
      <div className="admin-setup-progress-copy">
        <strong>
          {finished ? 'Setup complete' : `${complete} of ${total} required steps complete`}
        </strong>
        <span>
          {finished
            ? 'This product is live and partners have links. Changes you make here apply right away.'
            : 'Work through the steps in order. Your drafts are kept when you switch steps.'}
        </span>
      </div>
      <div
        className="admin-setup-progress-track"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={complete}
        aria-valuetext={`${complete} of ${total} required steps complete`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function StepMarker({ step }: { step: SetupStep }) {
  if (step.number === null) return <Settings2 size={15} aria-hidden="true" />
  if (step.state === 'complete') return <Check size={15} aria-hidden="true" />
  return <span aria-hidden="true">{step.number}</span>
}

function stepStateLabel(step: SetupStep) {
  if (step.number === null) return ''
  if (step.state === 'complete') return 'Complete'
  if (step.state === 'optional') return 'Optional'
  return 'To do'
}

export function SetupStepList({
  steps,
  activeId,
  onSelect,
}: {
  steps: readonly SetupStep[]
  activeId: SetupStepId
  onSelect: (id: SetupStepId) => void
}) {
  const numbered = steps.filter((step) => step.number !== null)
  const extra = steps.filter((step) => step.number === null)
  const item = (step: SetupStep) => (
    <li key={step.id}>
      <button
        type="button"
        className={`admin-setup-step-link admin-setup-step-${step.state}`}
        aria-current={step.id === activeId ? 'step' : undefined}
        onClick={() => onSelect(step.id)}
      >
        <span className="admin-setup-step-marker">
          <StepMarker step={step} />
        </span>
        <span className="admin-setup-step-text">
          <strong>{step.title}</strong>
          <small>{step.status || step.caption}</small>
        </span>
        {stepStateLabel(step) && <span className="sr-only">{`, ${stepStateLabel(step)}`}</span>}
      </button>
    </li>
  )
  return (
    <nav className="admin-setup-rail" aria-label="Setup steps">
      <ol className="admin-setup-step-list">{numbered.map(item)}</ol>
      <ul className="admin-setup-step-list admin-setup-step-list-extra">{extra.map(item)}</ul>
    </nav>
  )
}

export function SetupStepPanel({
  step,
  total,
  active,
  single,
  headingRef,
  children,
  footer,
}: {
  step: SetupStep
  total: number
  active: boolean
  /** Hide the embedded section's own heading when it would repeat the step title. */
  single: boolean
  headingRef?: RefObject<HTMLHeadingElement | null>
  children: ReactNode
  footer: ReactNode
}) {
  const titleId = `admin-setup-step-${step.id}-title`
  return (
    <section
      className={`admin-setup-step${single ? ' admin-setup-step-single' : ''}`}
      aria-labelledby={titleId}
      hidden={!active}
      data-step={step.id}
    >
      <header className="admin-setup-step-header">
        <div>
          <p className="admin-eyebrow">
            {step.number === null ? 'SETTINGS' : `STEP ${step.number} OF ${total}`}
          </p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {step.title}
          </h2>
          <p>{step.intro}</p>
        </div>
        {step.number !== null && (
          <span className={`admin-setup-state-pill admin-setup-state-${step.state}`}>
            {step.state === 'complete' ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <CircleDashed size={14} aria-hidden="true" />
            )}
            {step.state === 'complete' ? 'Complete' : step.status}
          </span>
        )}
      </header>
      <div className="admin-setup-step-body">{children}</div>
      {footer}
    </section>
  )
}

export function SetupStepFooter({
  step,
  previous,
  next,
  completedHere,
  onSelect,
}: {
  step: SetupStep
  previous: SetupStep | null
  next: SetupStep | null
  /** True when this step became complete while the admin was on it. */
  completedHere: boolean
  onSelect: (id: SetupStepId) => void
}) {
  const pending = step.number !== null && step.state === 'incomplete'
  return (
    <footer className="admin-setup-footer">
      {completedHere && (
        <p className="admin-setup-done-note" role="status">
          <Check size={16} aria-hidden="true" />
          <span>
            <strong>Step complete.</strong>
            {next ? ` Next up: ${next.title}.` : ' Everything here is done.'}
          </span>
        </p>
      )}
      {pending && !completedHere && next && (
        <p className="admin-setup-footer-hint">
          You can move on and come back later. Go live unlocks once every required step is complete.
        </p>
      )}
      <div className="admin-setup-footer-actions">
        {previous ? (
          <button
            type="button"
            className="admin-secondary-button"
            onClick={() => onSelect(previous.id)}
          >
            <ArrowLeft size={16} aria-hidden="true" /> {previous.title}
          </button>
        ) : (
          <span />
        )}
        {next && (
          <button
            type="button"
            className={pending ? 'admin-secondary-button' : 'admin-primary-button'}
            onClick={() => onSelect(next.id)}
          >
            {pending ? 'Skip to' : 'Continue to'} {next.title}{' '}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </footer>
  )
}
