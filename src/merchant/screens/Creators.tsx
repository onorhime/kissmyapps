import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ChevronDown, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react'
import {
  canApproveAgain,
  channelList,
  checkNote,
  creators,
  describeProblem,
  endedLabels,
  groupCreators,
  inviteLink,
  inviteSummary,
  websiteLink,
  withDecision,
} from '../creators'
import type {
  Creator,
  CreatorAction,
  CreatorProblem,
  CreatorsProgram,
  CreatorsState,
} from '../creators'
import { countryName, formatAgo, formatCount } from '../format'
import { formatDay } from '../programs'
import { href } from '../routes'
import { useStore } from '../store'
import { Avatar, CopyButton, Dialog, Field, PageHeader, Pill, Skeleton } from '../ui/Primitives'

const REFRESH_MS = 60_000
const PROGRAM = href({ name: 'program' })

/** The one decision the page is sending, and for whom. */
type Busy = { memberId: string; action: CreatorAction } | null

/** A decision that asks first: declining a request or removing a creator, with a note. */
type Ask = { action: 'decline' | 'remove'; creator: Creator }

type Notice =
  | {
      tone: 'problem'
      problem: CreatorProblem
      again?: { creator: Creator; action: CreatorAction; note?: string }
    }
  | { tone: 'news'; message: string }

const doneMessages: Record<CreatorAction, string> = {
  approve: 'approved',
  decline: 'declined',
  remove: 'removed',
}

export function CreatorsScreen() {
  const { workspace } = useStore()
  return workspace ? (
    <CreatorsPage workspaceId={workspace.id} workspaceName={workspace.name} />
  ) : null
}

function CreatorsPage({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  workspaceName: string
}) {
  const { signOut, notify, now } = useStore()
  const [state, setState] = useState<CreatorsState>()
  const [loadProblem, setLoadProblem] = useState<CreatorProblem>()
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState<Notice>()
  const [ask, setAsk] = useState<Ask>()
  const [note, setNote] = useState('')
  const [askProblem, setAskProblem] = useState<CreatorProblem>()
  const [endedOpen, setEndedOpen] = useState(false)
  // Whoever was just decided on: focus follows them to the list they moved to.
  const moved = useRef<string | null>(null)
  const [movedCount, setMovedCount] = useState(0)
  // The button that opened the dialog: closing it without deciding gives focus back.
  const opener = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const run = ++latest.current
      let next: CreatorsState
      try {
        next = await creators.list(workspaceId)
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return
        setLoadProblem(describeProblem(problem, 'load'))
        return
      }
      if (run !== latest.current) return
      setState(next)
      setLoadProblem(undefined)
    },
    [workspaceId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Requests arrive without the person doing anything, so the page looks for them itself.
  const settled = Boolean(state) && !busy && !ask
  useEffect(() => {
    if (!settled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [settled, load])

  // Back online: read the list again without being asked.
  useEffect(() => {
    if (!loadProblem) return
    const retry = () => void load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [loadProblem, load])

  useEffect(() => {
    if (!movedCount) return
    const rows = root.current?.querySelectorAll<HTMLElement>('[data-member]') ?? []
    for (const row of rows) if (row.dataset.member === moved.current) row.focus()
  }, [movedCount])

  const asking = Boolean(ask)
  useEffect(() => {
    if (asking) return
    const button = opener.current
    opener.current = null
    if (button?.isConnected) button.focus()
  }, [asking])

  const closeAsk = () => {
    setAsk(undefined)
    setNote('')
    setAskProblem(undefined)
  }

  /** Sends one decision. Says what went wrong where the person is looking. */
  const decide = async (creator: Creator, action: CreatorAction, typed?: string) => {
    if (busy) return
    const asked = action !== 'approve'
    setNotice(undefined)
    setAskProblem(undefined)
    setBusy({ memberId: creator.member_id, action })
    try {
      const decided = await creators.decide(workspaceId, creator.member_id, action, typed)
      // A refresh that was already on its way would show the list from before this.
      latest.current += 1
      setState((current) => current && withDecision(current, decided))
      if (asked) {
        closeAsk()
        setEndedOpen(true)
      }
      moved.current = decided.member_id
      setMovedCount((count) => count + 1)
      notify(`${decided.name} ${doneMessages[action]}`)
    } catch (problem) {
      const described = describeProblem(problem, action)
      if (described.recovery === 'reload') {
        // The page no longer matched the server, so it reads the list again and says so.
        closeAsk()
        await load(true)
        setNotice({ tone: 'news', message: described.message })
      } else if (asked && described.code !== 'not_allowed') {
        // The dialog stays open with what was typed; its own button tries again.
        setAskProblem(described)
      } else {
        closeAsk()
        // The server knows better than the page whether this person may decide.
        if (described.code === 'not_allowed')
          setState((current) => current && { ...current, can_manage: false })
        setNotice({
          tone: 'problem',
          problem: described,
          again: described.recovery === 'retry' ? { creator, action, note: typed } : undefined,
        })
      }
    } finally {
      setBusy(null)
    }
  }

  const submitAsk = (event: FormEvent) => {
    event.preventDefault()
    if (!ask || busy) return
    const refusal = checkNote(note)
    if (refusal) {
      setAskProblem({ code: 'invalid_note', message: refusal, recovery: 'none', field: 'note' })
      return
    }
    void decide(ask.creator, ask.action, note)
  }

  const program = state?.program ?? null
  const open = program?.status === 'live' || program?.status === 'paused'
  const groups = groupCreators(state?.creators ?? [])
  const canManage = Boolean(state?.can_manage)
  const canApprove = canManage && program?.status === 'live'
  const anyone = Boolean(state?.creators.length)
  const total = state ? state.counts.pending + state.counts.active + state.counts.ended : 0

  return (
    <div className="mc-page mc-crt" ref={root}>
      <PageHeader
        title="Creators"
        description="The people promoting your product with their own links."
      />

      {!state && !loadProblem && <Loading />}

      {loadProblem && !state && (
        <section className="mc-panel" aria-label="Creators">
          <Problem
            problem={loadProblem}
            onRetry={() => {
              setLoadProblem(undefined)
              void load()
            }}
            onSignIn={() => void signOut()}
          />
        </section>
      )}

      {state && !program && (
        <section className="mc-panel" aria-label="Creators">
          <p className="mc-crt-none">
            {workspaceName} has no affiliate program yet.{' '}
            <a className="mc-link" href={PROGRAM}>
              {canManage ? 'Set up your program' : 'Open Program'}
            </a>
          </p>
        </section>
      )}

      {state && program && !open && (
        <section className="mc-panel" aria-label="Creators">
          <p className="mc-crt-none">
            {program.status === 'in_review'
              ? 'Your program is in review. Creators can join once it is live.'
              : 'Creators can join once your program is live.'}{' '}
            <a className="mc-link" href={PROGRAM}>
              {program.status === 'in_review' || !canManage
                ? 'Open Program'
                : 'Finish your program'}
            </a>
          </p>
        </section>
      )}

      {state && program && open && (
        <>
          {program.status === 'paused' && (
            <p className="mc-crt-banner" role="status">
              <span>
                This program is paused. Creator links still open your page, but nothing is credited
                and no one can be approved until it is live again.
              </span>{' '}
              <a className="mc-link" href={PROGRAM}>
                Open Program
              </a>
            </p>
          )}

          {notice?.tone === 'problem' && (
            <Problem
              problem={notice.problem}
              onRetry={
                notice.again
                  ? () =>
                      void decide(notice.again!.creator, notice.again!.action, notice.again!.note)
                  : undefined
              }
              onSignIn={() => void signOut()}
            />
          )}
          {notice?.tone === 'news' && (
            <p className="mc-crt-note" role="status">
              {notice.message}
            </p>
          )}

          {program.slug && <Invite program={program} first={!anyone} />}

          {!canManage && anyone && (
            <p className="mc-crt-note">
              Only an owner or admin of {workspaceName} can approve or remove creators.
            </p>
          )}

          {groups.pending.length > 0 && (
            <section className="mc-panel mc-panel-flush" aria-labelledby="mc-crt-waiting">
              <div className="mc-panel-head is-padded">
                <h2 id="mc-crt-waiting">
                  Waiting for you{' '}
                  <span className="mc-crt-count mc-num">{formatCount(state.counts.pending)}</span>
                </h2>
              </div>
              <ul className="mc-crt-list">
                {groups.pending.map((creator) => {
                  const mine = busy?.memberId === creator.member_id
                  return (
                    <li key={creator.member_id} data-member={creator.member_id} tabIndex={-1}>
                      <Person creator={creator} />
                      <Facts creator={creator} now={now} />
                      {canManage && (
                        <div className="mc-crt-actions">
                          <button
                            type="button"
                            className="mc-text-btn mc-crt-quiet"
                            disabled={Boolean(busy)}
                            aria-label={`Decline ${creator.name}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget
                              setAsk({ action: 'decline', creator })
                            }}
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            className="mc-btn mc-btn-secondary"
                            disabled={Boolean(busy) || !canApprove}
                            aria-label={`Approve ${creator.name}`}
                            onClick={() => void decide(creator, 'approve')}
                          >
                            {mine && busy?.action === 'approve' ? (
                              <Working>Approving</Working>
                            ) : (
                              'Approve'
                            )}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {anyone && (
            <section className="mc-panel mc-panel-flush" aria-labelledby="mc-crt-active">
              <div className="mc-panel-head is-padded">
                <h2 id="mc-crt-active">
                  Creators{' '}
                  <span className="mc-crt-count mc-num">{formatCount(state.counts.active)}</span>
                </h2>
              </div>
              {groups.active.length === 0 ? (
                <p className="mc-empty-line">
                  {groups.pending.length
                    ? 'No one is promoting yet. Creators you approve appear here.'
                    : 'No one is promoting right now.'}
                </p>
              ) : (
                <table className="mc-table mc-crt-table">
                  <thead>
                    <tr>
                      <th scope="col">Creator</th>
                      <th scope="col">Joined</th>
                      <th scope="col" className="mc-num-col">
                        Clicks
                      </th>
                      <th scope="col" className="mc-num-col">
                        Sales
                      </th>
                      <th scope="col">Last click</th>
                      {canManage && (
                        <th scope="col">
                          <span className="sr-only">Action</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.active.map((creator) => (
                      <tr key={creator.member_id} data-member={creator.member_id} tabIndex={-1}>
                        <td>
                          <Person creator={creator}>
                            {creator.needs_new_terms && (
                              <Pill tone="warning">New terms not yet accepted</Pill>
                            )}
                          </Person>
                        </td>
                        <td data-label="Joined" className="mc-num">
                          {creator.activated_at ? formatDay(creator.activated_at) : <Dash />}
                        </td>
                        <td data-label="Clicks" className="mc-num-col mc-num">
                          {formatCount(creator.clicks)}
                        </td>
                        <td data-label="Sales" className="mc-num-col mc-num">
                          {formatCount(creator.sales)}
                        </td>
                        <td data-label="Last click" className="mc-num">
                          {creator.last_click_at ? (
                            formatAgo(
                              creator.last_click_at,
                              Math.max(now, Date.parse(creator.last_click_at)),
                            )
                          ) : (
                            <Dash />
                          )}
                        </td>
                        {canManage && (
                          <td className="is-action">
                            <button
                              type="button"
                              className="mc-text-btn mc-crt-quiet"
                              disabled={Boolean(busy)}
                              aria-label={`Remove ${creator.name}`}
                              onClick={(event) => {
                                opener.current = event.currentTarget
                                setAsk({ action: 'remove', creator })
                              }}
                            >
                              Remove
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {groups.ended.length > 0 && (
            <section className="mc-crt-ended" aria-label="Ended creators">
              <button
                type="button"
                className="mc-text-btn mc-crt-toggle"
                aria-expanded={endedOpen}
                aria-controls="mc-crt-ended"
                onClick={() => setEndedOpen((value) => !value)}
              >
                <ChevronDown size={16} aria-hidden="true" />
                <span>
                  Ended{' '}
                  <span className="mc-crt-count mc-num">{formatCount(state.counts.ended)}</span>
                </span>
              </button>
              {endedOpen && (
                <ul id="mc-crt-ended" className="mc-panel mc-panel-flush mc-crt-list">
                  {groups.ended.map((creator) => {
                    const mine = busy?.memberId === creator.member_id
                    return (
                      <li key={creator.member_id} data-member={creator.member_id} tabIndex={-1}>
                        <Person creator={creator} />
                        <p className="mc-crt-facts">
                          <span className="mc-num">{endedLine(creator)}</span>
                          {creator.decision_note && (
                            <span className="mc-crt-said">Your note: {creator.decision_note}</span>
                          )}
                        </p>
                        {canManage && canApproveAgain(creator) && (
                          <div className="mc-crt-actions">
                            <button
                              type="button"
                              className="mc-btn mc-btn-quiet"
                              disabled={Boolean(busy) || !canApprove}
                              aria-label={`Approve ${creator.name} again`}
                              onClick={() => void decide(creator, 'approve')}
                            >
                              {mine ? <Working>Approving</Working> : 'Approve again'}
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}

          {total > state.creators.length && (
            <p className="mc-page-foot mc-muted mc-num">
              Showing the first {formatCount(state.creators.length)} of {formatCount(total)}.
            </p>
          )}
        </>
      )}

      <Dialog
        open={Boolean(ask)}
        onOpenChange={(next) => !next && !busy && closeAsk()}
        title={ask ? `${ask.action === 'decline' ? 'Decline' : 'Remove'} ${ask.creator.name}?` : ''}
        description={
          ask?.action === 'decline'
            ? 'They will not get a link. You can approve them later.'
            : 'Their link will still open your page, but new clicks and sales will not be credited to them.'
        }
      >
        <form className="mc-form-stack" noValidate onSubmit={submitAsk}>
          <Field
            label="Note to the creator (optional)"
            hint="They will see this."
            error={askProblem?.field === 'note' ? askProblem.message : undefined}
          >
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value)
                  if (askProblem?.field === 'note') setAskProblem(undefined)
                }}
              />
            )}
          </Field>
          {askProblem && !askProblem.field && (
            <Problem problem={askProblem} onSignIn={() => void signOut()} />
          )}
          <div className="mc-form-actions">
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              disabled={Boolean(busy)}
              onClick={closeAsk}
            >
              Cancel
            </button>
            {ask?.action === 'remove' ? (
              <button type="submit" className="mc-btn mc-btn-danger-solid" disabled={Boolean(busy)}>
                {busy ? <Working>Removing</Working> : 'Remove creator'}
              </button>
            ) : (
              <button type="submit" className="mc-btn mc-btn-primary" disabled={Boolean(busy)}>
                {busy ? <Working>Declining</Working> : 'Decline'}
              </button>
            )}
          </div>
        </form>
      </Dialog>
    </div>
  )
}

/** "Removed 5 Nov 2026": how a creator stopped being part of the program, and when. */
function endedLine(creator: Creator): string {
  const how =
    creator.status === 'pending' || creator.status === 'active'
      ? 'Ended'
      : endedLabels[creator.status]
  return creator.ended_at ? `${how} ${formatDay(creator.ended_at)}` : how
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** A value the creator has not produced yet: no click, no date. */
function Dash() {
  return (
    <span className="mc-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">None yet</span>
    </span>
  )
}

/** A failure where it happened, with the one thing that gets past it. */
function Problem({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: CreatorProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-crt-problem" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{problem.message}</span>
      {problem.recovery === 'retry' && onRetry && (
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      {problem.recovery === 'sign-in' && (
        <button type="button" className="mc-text-btn" onClick={onSignIn}>
          Sign in again
        </button>
      )}
    </p>
  )
}

/** Who a creator is: their initial on their own tint, the name they go by and their handle. */
function Person({ creator, children }: { creator: Creator; children?: ReactNode }) {
  return (
    <div className="mc-person mc-crt-person">
      <Avatar id={creator.member_id} name={creator.name} />
      <span className="mc-person-text">
        <span className="mc-crt-name">
          <strong>{creator.name}</strong>
          {children}
        </span>
        {creator.handle && <span className="mc-muted mc-truncate">@{creator.handle}</span>}
      </span>
    </div>
  )
}

/** What a merchant weighs before letting someone in: where they are, where they post, when they asked. */
function Facts({ creator, now }: { creator: Creator; now: number }) {
  const channels = channelList(creator.channels)
  const site = websiteLink(creator.website_url)
  return (
    <p className="mc-crt-facts">
      {creator.country_code && <span>{countryName(creator.country_code)}</span>}
      {channels && <span>{channels}</span>}
      {site && (
        <a className="mc-link" href={site.href} target="_blank" rel="noreferrer noopener">
          <span className="mc-truncate">{site.label}</span>
          <ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
      {creator.requested_at && (
        <span className="mc-num">
          Asked {formatAgo(creator.requested_at, Math.max(now, Date.parse(creator.requested_at)))}
        </span>
      )}
    </p>
  )
}

/** The address a merchant sends to creators. With no creators yet, it is the whole page. */
function Invite({ program, first }: { program: CreatorsProgram; first: boolean }) {
  const id = useId()
  const link = inviteLink(program.slug ?? '')
  return (
    <section className="mc-panel mc-crt-invite" aria-labelledby={id}>
      <div className="mc-crt-invite-text">
        <h2 id={id}>{first ? 'Invite your first creator' : 'Invite link'}</h2>
        {first && <p>Send this link to creators. They read your terms there and join.</p>}
        <p className="mc-crt-terms">
          {inviteSummary(program).map((part) => (
            <span key={part}>{part}</span>
          ))}
          <a className="mc-link" href={PROGRAM}>
            Change
          </a>
        </p>
      </div>
      <div className="mc-crt-link">
        <span className="mc-mono">
          {/* A narrow screen breaks the address after a slash, not inside a word. */}
          {link.split(/(?<=\/)(?=[^/])/).map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <wbr />}
              {part}
            </Fragment>
          ))}
        </span>
        <CopyButton value={link} label="invite link" />
      </div>
    </section>
  )
}

function Loading() {
  return (
    <div className="mc-crt-loading" role="status" aria-label="Loading your creators">
      <div className="mc-panel mc-crt-invite">
        <div className="mc-crt-invite-text">
          <Skeleton width={120} height={18} />
          <Skeleton width="min(320px, 100%)" />
        </div>
        <Skeleton width="100%" height={52} />
      </div>
      <div className="mc-panel">
        <Skeleton width={96} height={18} />
        {[0, 1, 2].map((row) => (
          <div className="mc-crt-loading-row" key={row}>
            <Skeleton width={32} height={32} />
            <Skeleton width="min(240px, 60%)" />
          </div>
        ))}
      </div>
    </div>
  )
}
