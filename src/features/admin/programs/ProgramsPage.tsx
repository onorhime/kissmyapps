import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { ChevronDown, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { ActionNotice, type ActionMessage } from '../../../components/ActionNotice'
import { Dialog } from '../../../components/Dialog'
import type { AdminDataError, AdminDataResult, AdminGateway, AdminRole } from '../api/types'
import {
  PROGRAM_NOTE_MAX,
  PROGRAM_NOTE_MIN,
  type AdminProgramAgreement,
  type AdminProgramReview,
  type AdminProgramReviews,
  type AdminProgramStatusResult,
} from '../api/programs'
import {
  categoryLabel,
  commissionLine,
  countryName,
  earnFromLabel,
  fullDate,
  landingLink,
  monogram,
  programMoney,
  programStatus,
  relativeTime,
} from './programPresentation'
import './ProgramsPage.css'

export type ProgramsPageProps = Readonly<{
  gateway: AdminGateway
  role: AdminRole
}>

type ActionKind = 'approve' | 'request_changes' | 'pause' | 'lift'
type PendingAction = Readonly<{ kind: ActionKind; program: AdminProgramReview }>

type LoadState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; data: AdminProgramReviews; loadedAt: number }>
  | Readonly<{ status: 'unauthorized'; signedOut: boolean }>
  | Readonly<{ status: 'error'; message: string }>

const LOAD_FAILED = 'Programs could not be loaded. This is not an empty queue.'

/** Errors that mean the list on screen is out of date, so the action cannot be retried as is. */
const STALE_CODES = ['conflict', 'invalid_state', 'invalid_reference', 'invalid_response']

function actionFailure(error: AdminDataError | null): string {
  if (error?.code === 'not_authenticated')
    return 'Your session ended. Sign in again, then come back to this program. Nothing was changed.'
  if (error?.code === 'not_authorized')
    return 'This needs a password sign-in. Sign out, sign in again with your password, then try again. Nothing was changed.'
  if (error?.code === 'invalid_response')
    return 'We could not confirm that. The list has been refreshed, so check the program before trying again.'
  if (error?.code === 'temporarily_unavailable' || !error)
    return 'That did not go through. Check your connection and try again.'
  return error.message
}

type ActionCopy = Readonly<{
  title: (name: string) => string
  description: (program: AdminProgramReview) => string
  confirm: string
  busy: string
  done: (name: string, result: AdminProgramStatusResult) => Readonly<[string, string]>
  note: null | Readonly<{ label: string; hint: string; required: boolean }>
}>

const ACTIONS: Readonly<Record<ActionKind, ActionCopy>> = {
  approve: {
    title: (name) => `Approve ${name}?`,
    description: () => 'The program goes live with the terms in its agreement.',
    confirm: 'Approve program',
    busy: 'Approving…',
    done: (name) => ['Approved', `${name} is live.`],
    note: null,
  },
  request_changes: {
    title: () => 'Request changes',
    description: () => 'The program goes back to the merchant with your note.',
    confirm: 'Send to merchant',
    busy: 'Sending…',
    done: (name) => ['Changes requested', `${name} was sent back to the merchant.`],
    note: {
      label: 'What needs to change',
      hint: 'The merchant sees this note.',
      required: true,
    },
  },
  pause: {
    title: (name) => `Pause ${name}?`,
    description: () => 'The merchant cannot resume the program until you lift the pause.',
    confirm: 'Pause program',
    busy: 'Pausing…',
    done: (name) => ['Paused', `${name} is paused.`],
    note: {
      label: 'Reason for the pause (optional)',
      hint: 'The merchant sees this note.',
      required: false,
    },
  },
  lift: {
    title: (name) => `Lift the pause on ${name}?`,
    description: (program) =>
      program.stripeAccountId
        ? 'The program goes live again.'
        : 'Stripe is disconnected for this workspace, so the program stays paused until the merchant reconnects Stripe and resumes it.',
    confirm: 'Lift pause',
    busy: 'Lifting pause…',
    // The function answers with where the program really ended up.
    done: (name, result) =>
      result.status === 'live'
        ? ['Pause lifted', `${name} is live again.`]
        : [
            'Still paused',
            `Your pause is lifted, but ${name} stays paused because Stripe is disconnected. The merchant has to reconnect Stripe and resume it.`,
          ],
    note: null,
  },
}

function ProgramActionDialog({
  action,
  gateway,
  onClose,
  onDone,
  onStale,
}: {
  action: PendingAction
  gateway: AdminGateway
  onClose: () => void
  onDone: (notice: ActionMessage) => void
  onStale: (notice: ActionMessage) => void
}) {
  const copy = ACTIONS[action.kind]
  const { program } = action
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const noteId = useId()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const trimmed = note.trim()
    const tooShort = trimmed.length < PROGRAM_NOTE_MIN
    if (copy.note && tooShort && (copy.note.required || trimmed.length > 0)) {
      setNoteError(
        copy.note.required
          ? `Write at least ${PROGRAM_NOTE_MIN} characters.`
          : `Write at least ${PROGRAM_NOTE_MIN} characters, or leave it empty.`,
      )
      noteRef.current?.focus()
      return
    }
    setNoteError(null)
    setError(null)
    setBusy(true)
    try {
      const sentNote = copy.note && trimmed ? trimmed : null
      const result: AdminDataResult<AdminProgramStatusResult | null> | undefined =
        action.kind === 'approve' || action.kind === 'request_changes'
          ? await gateway.reviewProgram?.({
              programId: program.id,
              decision: action.kind,
              note: sentNote,
            })
          : await gateway.setProgramStatus?.({
              programId: program.id,
              status: action.kind === 'pause' ? 'paused' : 'live',
              note: sentNote,
            })
      if (!alive.current) return
      if (result?.status === 'ready' && result.data) {
        const [title, message] = copy.done(program.name, result.data)
        onDone({ kind: 'success', title, message })
        return
      }
      const message = actionFailure(result?.error ?? null)
      if (result?.error && STALE_CODES.includes(result.error.code)) {
        onStale({
          kind: 'error',
          title: result.error.code === 'invalid_response' ? 'Not confirmed' : 'Nothing was changed',
          message,
        })
      } else setError(message)
    } catch {
      if (alive.current) setError(actionFailure(null))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      dismissible={!busy}
      title={copy.title(program.name)}
      description={copy.description(program)}
      initialFocusRef={copy.note ? noteRef : confirmRef}
    >
      <form className="admin-prog-dialog" onSubmit={(event) => void submit(event)} noValidate>
        {copy.note && (
          <div className="admin-prog-field">
            <label htmlFor={noteId}>{copy.note.label}</label>
            <textarea
              id={noteId}
              ref={noteRef}
              value={note}
              maxLength={PROGRAM_NOTE_MAX}
              rows={5}
              disabled={busy}
              required={copy.note.required}
              aria-invalid={Boolean(noteError)}
              aria-describedby={`${noteId}-hint`}
              onChange={(event) => {
                setNote(event.target.value)
                const length = event.target.value.trim().length
                if (noteError && (length >= PROGRAM_NOTE_MIN || (!copy.note?.required && !length)))
                  setNoteError(null)
              }}
            />
            <p
              className={`admin-prog-field-hint${noteError ? ' admin-prog-field-error' : ''}`}
              id={`${noteId}-hint`}
              role={noteError ? 'alert' : undefined}
            >
              <span>{noteError ?? copy.note.hint}</span>
              <span aria-hidden="true">
                {note.length}/{PROGRAM_NOTE_MAX}
              </span>
            </p>
          </div>
        )}
        {error && (
          <p className="admin-prog-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="admin-prog-dialog-actions">
          <button
            className="admin-secondary-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="admin-primary-button" type="submit" disabled={busy} ref={confirmRef}>
            {busy && <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />}
            {busy ? copy.busy : copy.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function Logo({ program }: { program: AdminProgramReview }) {
  const [failed, setFailed] = useState(false)
  return program.logoUrl && !failed ? (
    <img
      className="admin-prog-logo"
      src={program.logoUrl}
      alt=""
      width={48}
      height={48}
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="admin-prog-logo admin-prog-logo-empty" aria-hidden="true">
      {monogram(program.name)}
    </span>
  )
}

/**
 * The agreement as creators will read it: the sections in order, then the brand's own terms
 * straight after the last one, whose heading already introduces them.
 */
function Agreement({ agreement }: { agreement: AdminProgramAgreement }) {
  const last = agreement.sections.length - 1
  const extraTerms = agreement.extraTerms && (
    <p className="admin-prog-extra-terms">{agreement.extraTerms}</p>
  )
  return (
    <div className="admin-prog-agreement-body">
      <h3>{agreement.title}</h3>
      {agreement.summary.length > 0 && (
        <dl className="admin-prog-agreement-summary">
          {agreement.summary.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {agreement.sections.map((section, index) => (
        <section key={`${index}:${section.heading}`}>
          <h4>{section.heading}</h4>
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{paragraph}</p>
          ))}
          {index === last && extraTerms}
        </section>
      ))}
      {last < 0 && extraTerms}
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const notSet = <span className="admin-prog-missing">Not set</span>

/**
 * The rewards of a program that pays per event: what creators read, the merchant's event it
 * stands for, and what it pays. The three columns sit under the three facts above them.
 */
function Rewards({ program }: { program: AdminProgramReview }) {
  if (program.rewards.length === 0)
    return <p className="admin-prog-rewards admin-prog-warning">No rewards set</p>
  return (
    <div className="admin-prog-rewards" role="table" aria-label={`Rewards of ${program.name}`}>
      <div className="admin-prog-reward-row admin-prog-reward-head" role="row">
        <span role="columnheader">Shown to creators</span>
        <span className="admin-prog-reward-event" role="columnheader">
          Event
        </span>
        <span className="admin-prog-reward-amount" role="columnheader">
          Amount
        </span>
      </div>
      {program.rewards.map((reward, index) => (
        <div className="admin-prog-reward-row" role="row" key={index}>
          <span role="cell">{reward.label ?? notSet}</span>
          <span className="admin-prog-reward-event" role="cell">
            {reward.key ? <code>{reward.key}</code> : notSet}
          </span>
          <span className="admin-prog-reward-amount" role="cell">
            {reward.amountMinor ? programMoney(reward.amountMinor, program.currency) : notSet}
          </span>
        </div>
      ))}
    </div>
  )
}

function ReviewCard({
  program,
  now,
  disabled,
  onAction,
}: {
  program: AdminProgramReview
  now: number
  disabled: boolean
  onAction: (kind: ActionKind) => void
}) {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const titleId = useId()
  const link = landingLink(program.landingUrl)
  const submitted = relativeTime(program.submittedAt, now)
  const country = countryName(program.stripeCountry)
  const earnFrom = earnFromLabel(program.earnFrom)
  const listing = (
    <>
      <Fact label="Landing page">
        {link ? (
          <a href={link.href} title={link.href} target="_blank" rel="noopener noreferrer">
            <span>{link.label}</span>
            <ExternalLink size={14} aria-hidden="true" />
            <span className="admin-prog-sr">(opens in a new tab)</span>
          </a>
        ) : (
          (program.landingUrl ?? notSet)
        )}
      </Fact>
      <Fact label="Category">{categoryLabel(program.category) ?? notSet}</Fact>
      <Fact label="Workspace">{program.workspaceName ?? notSet}</Fact>
      <Fact label="Stripe account">
        {program.stripeAccountId ? (
          <>
            {program.brandName && <span>{program.brandName}</span>}
            <span className="admin-prog-fact-sub">
              <code>{program.stripeAccountId}</code>
              {country && <span>{country}</span>}
            </span>
          </>
        ) : (
          <span className="admin-prog-warning">Not connected</span>
        )}
      </Fact>
      <Fact label="Marketplace">
        {program.marketplaceListed === null
          ? notSet
          : program.marketplaceListed
            ? 'Listed'
            : 'Not listed'}
      </Fact>
    </>
  )
  return (
    <article className="admin-panel admin-prog-card" aria-labelledby={titleId}>
      <header className="admin-prog-card-head">
        <Logo program={program} />
        <div className="admin-prog-card-title">
          <h2 id={titleId}>{program.name}</h2>
          {program.tagline && <p>{program.tagline}</p>}
        </div>
        {submitted && program.submittedAt && (
          <p className="admin-prog-submitted" title={fullDate(program.submittedAt)}>
            Submitted {submitted}
          </p>
        )}
      </header>

      {earnFrom ? (
        <>
          {/* What it pays first: a program that pays per event is judged on its rewards. */}
          <dl className="admin-prog-facts">
            <Fact label="Creators earn from">{earnFrom}</Fact>
            <Fact label="Commission">
              {program.earnFrom === 'events' ? 'None' : (commissionLine(program) ?? notSet)}
            </Fact>
            <Fact label="Monthly budget">
              {program.rewardBudgetMinor
                ? programMoney(program.rewardBudgetMinor, program.currency)
                : notSet}
            </Fact>
          </dl>
          <Rewards program={program} />
          <dl className="admin-prog-facts">{listing}</dl>
        </>
      ) : (
        <dl className="admin-prog-facts">
          <Fact label="Commission">{commissionLine(program) ?? notSet}</Fact>
          {listing}
        </dl>
      )}

      <div className="admin-prog-card-foot">
        <div className="admin-prog-agreement-toggle">
          {program.agreement ? (
            <button
              className="admin-text-button"
              type="button"
              aria-expanded={open}
              aria-controls={regionId}
              aria-label={`${open ? 'Hide' : 'Read'} agreement for ${program.name}`}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown
                className={open ? 'admin-prog-chevron-open' : undefined}
                size={16}
                aria-hidden="true"
              />
              {open ? 'Hide agreement' : 'Read agreement'}
            </button>
          ) : (
            <span className="admin-prog-missing">Agreement not available</span>
          )}
          {program.extraTerms && <span className="admin-prog-note">Has extra terms</span>}
        </div>
        <div className="admin-prog-actions">
          <button
            className="admin-secondary-button"
            type="button"
            disabled={disabled}
            aria-label={`Request changes to ${program.name}`}
            onClick={() => onAction('request_changes')}
          >
            Request changes
          </button>
          <button
            className="admin-primary-button"
            type="button"
            disabled={disabled}
            aria-label={`Approve ${program.name}`}
            onClick={() => onAction('approve')}
          >
            Approve
          </button>
        </div>
      </div>

      {program.agreement && open && (
        <div
          className="admin-prog-agreement"
          id={regionId}
          role="region"
          aria-label={`Agreement for ${program.name}`}
          tabIndex={0}
        >
          <Agreement agreement={program.agreement} />
        </div>
      )}
    </article>
  )
}

function ReviewedRow({
  program,
  now,
  disabled,
  onAction,
}: {
  program: AdminProgramReview
  now: number
  disabled: boolean
  onAction: (kind: ActionKind) => void
}) {
  const status = programStatus(program)
  const adminPause = program.status === 'paused' && program.pauseReason === 'admin'
  const workspace =
    program.workspaceName && program.workspaceName !== program.name ? program.workspaceName : null
  // The list's heading already says "reviewed", so the row only says when.
  const reviewed = relativeTime(program.reviewedAt, now)?.replace(/^on /, '')
  return (
    <li className="admin-prog-reviewed-row">
      <div>
        <strong>{program.name}</strong>
        {(workspace || reviewed) && (
          <span className="admin-prog-reviewed-workspace">
            {workspace}
            {workspace && reviewed && ' · '}
            {reviewed && program.reviewedAt && (
              <span className="admin-prog-reviewed-when" title={fullDate(program.reviewedAt)}>
                <span className="admin-prog-sr">Reviewed </span>
                {reviewed}
              </span>
            )}
          </span>
        )}
        <span className={`admin-prog-pill admin-prog-pill-${status.tone}`}>{status.label}</span>
      </div>
      {program.status === 'live' && (
        <button
          className="admin-text-button"
          type="button"
          disabled={disabled}
          aria-label={`Pause ${program.name}`}
          onClick={() => onAction('pause')}
        >
          Pause
        </button>
      )}
      {adminPause && (
        <button
          className="admin-text-button"
          type="button"
          disabled={disabled}
          aria-label={`Lift pause on ${program.name}`}
          onClick={() => onAction('lift')}
        >
          Lift pause
        </button>
      )}
    </li>
  )
}

function LoadingCard() {
  return (
    <div className="admin-panel admin-prog-card admin-prog-skeleton" aria-hidden="true">
      <div className="admin-prog-card-head">
        <span className="admin-prog-logo admin-prog-bar" />
        <div className="admin-prog-card-title">
          <span className="admin-prog-bar" style={{ width: 180, height: 20 }} />
          <span className="admin-prog-bar" style={{ width: 320, height: 14 }} />
        </div>
      </div>
      <div className="admin-prog-facts">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index}>
            <span className="admin-prog-bar" style={{ width: 72, height: 12 }} />
            <span className="admin-prog-bar" style={{ width: 150, height: 16 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProgramsPage({ gateway, role }: ProgramsPageProps) {
  const canReview = role === 'owner' || role === 'operations'
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // True from the first render: the page opens by loading.
  const [refreshing, setRefreshing] = useState(true)
  const [action, setAction] = useState<PendingAction | null>(null)
  const [notice, setNotice] = useState<ActionMessage | null>(null)
  const request = useRef(0)

  const load = useCallback(async () => {
    const current = ++request.current
    let next: LoadState
    try {
      const result = await gateway.getProgramReviews?.()
      if (result?.status === 'ready' && result.data) {
        next = { status: 'ready', data: result.data, loadedAt: Date.now() }
      } else if (result?.status === 'unauthorized') {
        next = { status: 'unauthorized', signedOut: result.error?.code === 'not_authenticated' }
      } else {
        next = { status: 'error', message: LOAD_FAILED }
      }
    } catch {
      next = { status: 'error', message: LOAD_FAILED }
    }
    if (current !== request.current) return
    setState(next)
    setRefreshing(false)
  }, [gateway])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void load()
  }, [load])

  useEffect(() => {
    if (!canReview) return
    void load()
    return () => {
      request.current += 1
    }
  }, [canReview, load])

  if (!canReview) {
    return (
      <section className="admin-programs" aria-labelledby="admin-programs-title">
        <div className="admin-prog-message">
          <h1 id="admin-programs-title">Program review is restricted</h1>
          <p>Only Owner and Operations admins can review programs.</p>
        </div>
      </section>
    )
  }

  const data = state.status === 'ready' ? state.data : null
  const waiting = data?.waiting ?? []
  const reviewed = data?.reviewed ?? []
  const loadedAt = state.status === 'ready' ? state.loadedAt : 0
  const busy = refreshing || action !== null

  return (
    <section className="admin-programs" aria-labelledby="admin-programs-title">
      <header className="admin-prog-heading">
        <div>
          <h1 id="admin-programs-title">Programs</h1>
          {data && (
            <p>
              {waiting.length === 0
                ? 'Nothing waiting for review'
                : `${waiting.length} waiting for review`}
            </p>
          )}
          {state.status === 'loading' && (
            <p aria-hidden="true">
              <span className="admin-prog-bar" style={{ width: 150, height: 14 }} />
            </p>
          )}
        </div>
        {state.status !== 'unauthorized' && (
          <button
            className="admin-secondary-button"
            type="button"
            disabled={refreshing}
            onClick={refresh}
          >
            {refreshing ? (
              <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
            ) : (
              <RefreshCw size={16} aria-hidden="true" />
            )}
            {refreshing && state.status !== 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </header>

      {state.status === 'loading' && (
        <div className="admin-prog-layout" role="status">
          <div className="admin-prog-queue">
            <span className="admin-prog-sr">Loading programs…</span>
            <LoadingCard />
          </div>
          <div className="admin-panel admin-prog-reviewed admin-prog-skeleton" aria-hidden="true">
            <span className="admin-prog-bar" style={{ width: 140, height: 18 }} />
            {[0, 1, 2].map((index) => (
              <div className="admin-prog-reviewed-row" key={index}>
                <div>
                  <span className="admin-prog-bar" style={{ width: 110, height: 16 }} />
                  <span className="admin-prog-bar" style={{ width: 64, height: 22 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {state.status === 'unauthorized' && (
        <div className="admin-prog-message">
          <h2>{state.signedOut ? 'Sign in to review programs' : 'Sign in with your password'}</h2>
          <p>
            {state.signedOut
              ? 'Your session ended. Sign in again to see the programs waiting for review.'
              : 'Program review needs an Owner or Operations session that was started with a password. Sign out, then sign in again with your password.'}
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="admin-prog-message" role="alert">
          <h2>Programs are unavailable</h2>
          <p>{state.message}</p>
          <button
            className="admin-secondary-button"
            type="button"
            disabled={refreshing}
            onClick={refresh}
          >
            Try again
          </button>
        </div>
      )}

      {data && (
        <div className="admin-prog-layout">
          <section className="admin-prog-queue" aria-label="Waiting for review">
            {waiting.length === 0 ? (
              <div className="admin-prog-empty">
                <h2>Nothing to review</h2>
                <p>A program appears here when a merchant publishes it for the first time.</p>
              </div>
            ) : (
              waiting.map((program) => (
                <ReviewCard
                  key={program.id}
                  program={program}
                  now={loadedAt}
                  disabled={busy}
                  onAction={(kind) => setAction({ kind, program })}
                />
              ))
            )}
          </section>

          <aside className="admin-panel admin-prog-reviewed" aria-labelledby="admin-prog-reviewed">
            <h2 id="admin-prog-reviewed">Recently reviewed</h2>
            {reviewed.length === 0 ? (
              <p className="admin-prog-reviewed-empty">No programs have been reviewed yet.</p>
            ) : (
              <ul>
                {reviewed.map((program) => (
                  <ReviewedRow
                    key={program.id}
                    program={program}
                    now={loadedAt}
                    disabled={busy}
                    onAction={(kind) => setAction({ kind, program })}
                  />
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {action && (
        <ProgramActionDialog
          key={`${action.kind}:${action.program.id}`}
          action={action}
          gateway={gateway}
          onClose={() => setAction(null)}
          onDone={(message) => {
            setAction(null)
            setNotice(message)
            refresh()
          }}
          onStale={(message) => {
            setAction(null)
            setNotice(message)
            refresh()
          }}
        />
      )}
      <ActionNotice notice={notice} onDismiss={() => setNotice(null)} />
    </section>
  )
}

export default ProgramsPage
