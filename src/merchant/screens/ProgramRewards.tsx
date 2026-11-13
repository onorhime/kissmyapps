import { useEffect, useId, useRef } from 'react'
import { ChevronDown, Plus, TriangleAlert, X } from 'lucide-react'
import { INSTALL_EVENT, MAX_REWARDS, rewardEventChoice, rewardField } from '../programs'
import type { DraftErrors, RewardEvent, RewardPart, RewardRow } from '../programs'
import { Field, Skeleton } from '../ui/Primitives'

/** The events a reward can be tied to: still loading, the list, or that it could not be read. */
export type RewardEvents =
  { status: 'loading' } | { status: 'ready'; events: RewardEvent[] } | { status: 'failed' }

const parts: RewardPart[] = ['key', 'label', 'amount']

/**
 * The rewards of a program that pays for events: up to five rows of an event, the words
 * creators read for it and an amount, then the monthly budget they all share.
 */
export function RewardFields({
  rows,
  budget,
  currency,
  errors,
  events,
  editable,
  installHref,
  app = false,
  onRow,
  onAdd,
  onRemove,
  onBudget,
  onRetryEvents,
}: {
  rows: RewardRow[]
  budget: string
  currency: string
  errors: DraftErrors
  events: RewardEvents
  editable: boolean
  /** Where the tracking code is set up, when the workspace has a project to set it up for. */
  installHref?: string
  /** The program sends people to an app, so the install is always offered first. */
  app?: boolean
  onRow: (index: number, patch: Partial<RewardRow>) => void
  onAdd: () => void
  onRemove: (index: number) => void
  onBudget: (value: string) => void
  onRetryEvents: () => void
}) {
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  const moved = useRef<'added' | 'removed' | null>(null)
  const dollars = currency === 'USD'
  const received = events.status === 'ready' ? events.events.map((event) => event.name) : []
  // An app program pays for installs above all, so the install is there before the app has sent one.
  const names =
    app && received.length
      ? [INSTALL_EVENT, ...received.filter((name) => name !== INSTALL_EVENT)]
      : received
  // With nothing to pick from, the name is typed: before any event has arrived, or when
  // the list could not be read.
  const typed = events.status === 'failed' || (events.status === 'ready' && received.length === 0)
  const empty = rows.every((row) => !row.key && !row.label && !row.amount)
  const listErrorId = `${id}-list-error`

  // The control that was pressed is gone or has moved, so focus goes where the work continues.
  useEffect(() => {
    if (moved.current === 'added')
      list.current
        ?.querySelector<HTMLElement>('.mc-pgr-item:last-child :is(select, input)')
        ?.focus()
    else if (moved.current === 'removed') add.current?.focus()
    moved.current = null
  }, [rows.length])

  return (
    <>
      {events.status === 'ready' && received.length === 0 && editable && (
        <p className="mc-prog-about">
          {app
            ? 'No events have arrived from your app yet. They come from the KissMyApps SDK, so for now type the name your app will send.'
            : 'No events have arrived from your site yet. They come from the KissMyApps tracking code, so for now type the name your site will send.'}
          {installHref && (
            <>
              {' '}
              <a className="mc-link" href={installHref}>
                Set up tracking
              </a>
            </>
          )}
        </p>
      )}
      {events.status === 'failed' && editable && (
        <p className="mc-error-note mc-prog-problem" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>The events from your site could not be loaded. Type the event name, or retry.</span>
          <button type="button" className="mc-text-btn" onClick={onRetryEvents}>
            Retry
          </button>
        </p>
      )}

      {!editable && empty ? (
        <p className="mc-prog-about">No rewards yet.</p>
      ) : (
        <div className="mc-pgr-list" ref={list}>
          {rows.map((row, index) => {
            const number = index + 1
            const found = parts.flatMap((part) => {
              const message = errors[rewardField(index, part)]
              return message ? [{ part, message, id: `${id}-${index}-${part}-error` }] : []
            })
            const errorId = (part: RewardPart) => found.find((error) => error.part === part)?.id
            // A mistake in the list as a whole is said once, and marked at its first row.
            const listError = index === 0 && errors.rewards && found.length === 0
            const keyProps = {
              id: `${id}-${index}-key`,
              'aria-invalid': errorId('key') || listError ? true : undefined,
              'aria-describedby': errorId('key') ?? (listError ? listErrorId : undefined),
            }
            // The row's own event stays selectable when it is no longer in the list.
            const choices = row.key && !names.includes(row.key) ? [row.key, ...names] : names
            const taken = new Set(rows.filter((_, other) => other !== index).map((r) => r.key))
            return (
              <div
                key={index}
                className={found.length || listError ? 'mc-pgr-item has-error' : 'mc-pgr-item'}
                role="group"
                aria-label={`Reward ${number}`}
              >
                <div
                  className={
                    keyProps['aria-invalid']
                      ? 'mc-field mc-pgr-event has-error'
                      : 'mc-field mc-pgr-event'
                  }
                >
                  <label htmlFor={keyProps.id}>Event</label>
                  {events.status === 'loading' ? (
                    <span role="status" aria-label="Loading your events">
                      <Skeleton width="100%" height={40} />
                    </span>
                  ) : typed ? (
                    <input
                      {...keyProps}
                      className="mc-mono"
                      value={row.key}
                      placeholder={app ? INSTALL_EVENT : 'signup_completed'}
                      maxLength={80}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      onChange={(event) => onRow(index, { key: event.target.value })}
                    />
                  ) : (
                    <span className="mc-select-box">
                      <select
                        {...keyProps}
                        // The install is named in words, so it is not set as code.
                        className={row.key === INSTALL_EVENT ? undefined : 'mc-mono'}
                        value={row.key}
                        onChange={(event) => onRow(index, { key: event.target.value })}
                      >
                        <option value="">Choose an event</option>
                        {choices.map((name) => (
                          <option key={name} value={name} disabled={taken.has(name)}>
                            {rewardEventChoice(name)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} aria-hidden="true" />
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="mc-icon-btn mc-pgr-remove"
                  aria-label={`Remove reward ${number}`}
                  disabled={rows.length === 1 && empty}
                  onClick={() => {
                    moved.current = 'removed'
                    onRemove(index)
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
                <div
                  className={
                    errorId('label') ? 'mc-field mc-pgr-words has-error' : 'mc-field mc-pgr-words'
                  }
                >
                  <label htmlFor={`${id}-${index}-label`}>What creators read</label>
                  <input
                    id={`${id}-${index}-label`}
                    value={row.label}
                    placeholder="Account created"
                    maxLength={40}
                    autoComplete="off"
                    aria-invalid={errorId('label') ? true : undefined}
                    aria-describedby={errorId('label')}
                    onChange={(event) => onRow(index, { label: event.target.value })}
                  />
                </div>
                <div
                  className={
                    errorId('amount')
                      ? 'mc-field mc-pgr-amount has-error'
                      : 'mc-field mc-pgr-amount'
                  }
                >
                  <label htmlFor={`${id}-${index}-amount`}>Amount</label>
                  <div className={dollars ? 'mc-affix is-prefix' : 'mc-affix'}>
                    {dollars && <span aria-hidden="true">$</span>}
                    <input
                      id={`${id}-${index}-amount`}
                      inputMode="decimal"
                      value={row.amount}
                      placeholder="2.00"
                      autoComplete="off"
                      aria-invalid={errorId('amount') ? true : undefined}
                      aria-describedby={errorId('amount')}
                      onChange={(event) => onRow(index, { amount: event.target.value })}
                    />
                    {!dollars && <span aria-hidden="true">{currency}</span>}
                  </div>
                </div>
                {found.length > 0 && (
                  <div className="mc-pgr-errors">
                    {found.map((error) => (
                      <p key={error.part} id={error.id} className="mc-field-error">
                        {error.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {errors.rewards && (
        <p id={listErrorId} className="mc-field-error" role="alert">
          {errors.rewards}
        </p>
      )}
      {!editable ? null : rows.length < MAX_REWARDS ? (
        <button
          ref={add}
          type="button"
          className="mc-btn mc-btn-quiet mc-pgr-add"
          onClick={() => {
            moved.current = 'added'
            onAdd()
          }}
        >
          <Plus size={16} aria-hidden="true" /> Add reward
        </button>
      ) : (
        <p className="mc-field-hint mc-pgr-full">A program can have up to five rewards.</p>
      )}

      <div className="mc-pgr-budget">
        <Field
          label="Monthly budget"
          hint="The KissMyApps fee comes on top. One creator can earn at most a tenth of it per day."
          error={errors.budget}
        >
          {(props) => (
            <div className={dollars ? 'mc-affix is-prefix' : 'mc-affix'}>
              {dollars && <span aria-hidden="true">$</span>}
              <input
                {...props}
                inputMode="decimal"
                value={budget}
                placeholder="500.00"
                autoComplete="off"
                onChange={(event) => onBudget(event.target.value)}
              />
              {!dollars && <span aria-hidden="true">{currency}</span>}
            </div>
          )}
        </Field>
      </div>
    </>
  )
}
