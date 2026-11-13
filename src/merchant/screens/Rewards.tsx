import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { CircleCheck, Flag, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { formatAmount } from '../balance'
import { formatWhen } from '../connections'
import { creators as creatorList } from '../creators'
import { formatCount, plural } from '../format'
import { href, navigate } from '../routes'
import {
  awardStatus,
  budgetLeft,
  budgetLine,
  budgetNotes,
  budgetStanding,
  checkNote,
  confirmLine,
  creatorsInOrder,
  describeProblem,
  doneLine,
  earns,
  emptyNames,
  goingBack,
  monthName,
  reasonMessage,
  REJECT_MAX,
  REJECT_REASONS,
  rejectReasonNames,
  rejectTitle,
  rewards,
  STALE_LINE,
  standsOut,
  standsOutLine,
  STATUS_FILTERS,
  statusNames,
  UNAVAILABLE,
  USED_UP_LINE,
  wentFurther,
  withFreshFigures,
  withNextPage,
  withoutRejecting,
  withRejected,
} from '../rewards'
import type {
  Award,
  RejectReason,
  Reward,
  RewardCreator,
  RewardsBudget,
  RewardsProblem,
  RewardsState,
  StatusFilter,
} from '../rewards'
import { useStore } from '../store'
import { Dialog, Field, PageHeader, Pill, Segmented, Skeleton } from '../ui/Primitives'

const REFRESH_MS = 60_000
/** How many creators the table shows before it is asked for all of them. */
const CREATORS_SHOWN = 8
const PROGRAM = href({ name: 'program' })
const CREATORS = href({ name: 'creators' })
const ALL_REWARDS = href({ name: 'rewards' })

type Notice =
  | { tone: 'done' | 'news'; message: string }
  | { tone: 'problem'; problem: RewardsProblem; again?: () => void }

const filterOptions: Array<{ value: 'all' | StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  ...STATUS_FILTERS.map((value) => ({ value, label: statusNames[value] })),
]

export function RewardsScreen({ creator }: { creator?: string }) {
  const { workspace } = useStore()
  return workspace ? (
    <RewardsPage workspaceId={workspace.id} workspaceName={workspace.name} memberId={creator} />
  ) : null
}

function RewardsPage({
  workspaceId,
  workspaceName,
  memberId,
}: {
  workspaceId: string
  workspaceName: string
  memberId?: string
}) {
  const { signOut, now } = useStore()
  const listId = useId()
  const reasonId = useId()
  const [state, setState] = useState<RewardsState>()
  const [loadProblem, setLoadProblem] = useState<RewardsProblem>()
  // A database that has no rewards yet is not a failure: the page says so and stays calm.
  const [unavailable, setUnavailable] = useState(false)
  const [filter, setFilter] = useState<StatusFilter | null>(null)
  // The status the list on screen was asked with: it trails `filter` while the next one loads.
  const [shown, setShown] = useState<StatusFilter | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreProblem, setMoreProblem] = useState<RewardsProblem>()
  // Once "Show more" has added a page, the list is the person's own and is not refreshed under them.
  const [pages, setPages] = useState(1)
  // The filtered creator's name when nothing on the page carries it.
  const [lookedUp, setLookedUp] = useState<string>()
  const [everyCreator, setEveryCreator] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState<RejectReason | null>(null)
  const [note, setNote] = useState('')
  const [askProblem, setAskProblem] = useState<RewardsProblem>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  // Set before the button can be drawn disabled, so two quick presses send one rejection.
  const sending = useRef(false)
  // The first reward of the page "Show more" just added: focus follows the list down.
  const added = useRef<string | null>(null)
  const [addedCount, setAddedCount] = useState(0)
  // What the page just said about a rejection: focus goes there, where the list changed.
  const said = useRef<HTMLParagraphElement>(null)
  const [saidCount, setSaidCount] = useState(0)
  // The button that opened the dialog: closing it without rejecting gives focus back.
  const opener = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false): Promise<boolean> => {
      const run = ++latest.current
      let next: RewardsState
      try {
        next = await rewards.list(workspaceId, { memberId, status: filter })
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return false
        const described = describeProblem(problem, 'load')
        setUnavailable(described.code === UNAVAILABLE)
        setLoadProblem(described.code === UNAVAILABLE ? undefined : described)
        return false
      }
      if (run !== latest.current) return false
      setState(next)
      setShown(filter)
      setPages(1)
      setLoadProblem(undefined)
      setUnavailable(false)
      return true
    },
    [workspaceId, memberId, filter],
  )

  useEffect(() => {
    void load()
  }, [load])

  const rows = state?.awards ?? []
  const rejectable = rows.filter((award) => award.can_reject)
  const picked = rejectable.filter((award) => selected.has(award.award_id))
  const switching = Boolean(state) && shown !== filter && !loadProblem

  // Rewards arrive without the person doing anything, so the first page looks for them itself.
  // It waits while rows are selected: a list that moves under a selection is how mistakes happen.
  const settled =
    Boolean(state) &&
    pages === 1 &&
    !moreBusy &&
    !busy &&
    !asking &&
    !switching &&
    !loadProblem &&
    picked.length === 0
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
    if (!addedCount) return
    const found = root.current?.querySelectorAll<HTMLElement>('[data-award]') ?? []
    for (const row of found) if (row.dataset.award === added.current) row.focus()
  }, [addedCount])

  useEffect(() => {
    if (saidCount) said.current?.focus()
  }, [saidCount])

  useEffect(() => {
    if (asking) return
    const button = opener.current
    opener.current = null
    if (button?.isConnected) button.focus()
  }, [asking])

  const program = state?.program ?? null
  // A program that went back to sales still lists its rewards, without this month's budget.
  const backToSales = program?.earn_from === 'sales'
  const nameOnPage = memberId
    ? (rows.find((award) => award.member_id === memberId)?.creator_name ??
      state?.creators.find((creator) => creator.member_id === memberId)?.name ??
      undefined)
    : undefined
  // A creator with no rewards is on no row, so their name comes from the list of creators.
  const nameless = Boolean(memberId && program && !nameOnPage)
  useEffect(() => {
    if (!nameless) return
    let current = true
    creatorList
      .list(workspaceId)
      .then((everyone) => {
        const found = everyone.creators.find((item) => item.member_id === memberId)
        if (current && found) setLookedUp(found.name)
      })
      .catch(() => {
        /* The filter still works without the name. */
      })
    return () => {
      current = false
    }
  }, [nameless, workspaceId, memberId])

  const more = async () => {
    const before = state?.next_before
    if (moreBusy || !state || !before) return
    setMoreProblem(undefined)
    setMoreBusy(true)
    try {
      const next = await rewards.list(workspaceId, { before, memberId, status: filter })
      // A refresh that was already on its way would put the first page back alone.
      latest.current += 1
      const known = new Set(state.awards.map((award) => award.award_id))
      added.current = next.awards.find((award) => !known.has(award.award_id))?.award_id ?? null
      setState((current) => current && withNextPage(current, next))
      setPages((count) => count + 1)
      setAddedCount((count) => count + 1)
    } catch (problem) {
      setMoreProblem(describeProblem(problem, 'more'))
    } finally {
      setMoreBusy(false)
    }
  }

  const chooseFilter = (next: StatusFilter | null) => {
    if (next === filter) return
    setFilter(next)
    setSelected(new Set())
    setMoreProblem(undefined)
    setLoadProblem(undefined)
    setNotice(undefined)
  }

  const full = picked.length >= REJECT_MAX
  const toggle = (award: Award) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(award.award_id)) next.delete(award.award_id)
      else if (!full) next.add(award.award_id)
      return next
    })
  const pickAll = () =>
    setSelected(new Set(rejectable.slice(0, REJECT_MAX).map((award) => award.award_id)))

  const closeAsk = () => {
    setAsking(false)
    setReason(null)
    setNote('')
    setAskProblem(undefined)
  }

  const say = (next: Notice) => {
    setNotice(next)
    setSaidCount((count) => count + 1)
  }

  /** The figures above the list, read again around a list that stays where the person left it. */
  const refreshFigures = async () => {
    try {
      const fresh = await rewards.list(workspaceId, { memberId, status: filter })
      setState((current) => current && withFreshFigures(current, fresh))
    } catch {
      /* The list is already right; the figures follow with the next refresh. */
    }
  }

  /** Sends one rejection: every selected reward, or none. */
  const reject = async (event: FormEvent) => {
    event.preventDefault()
    if (sending.current || busy || picked.length === 0) return
    if (!reason) {
      setAskProblem({
        code: 'no_reason',
        message: reasonMessage,
        recovery: 'none',
        field: 'reason',
      })
      return
    }
    const refusal = checkNote(note)
    if (refusal) {
      setAskProblem({ code: 'invalid_note', message: refusal, recovery: 'none', field: 'note' })
      return
    }
    const awardIds = picked.map((award) => award.award_id)
    sending.current = true
    setBusy(true)
    setAskProblem(undefined)
    setNotice(undefined)
    try {
      const done = await rewards.reject(workspaceId, { awardIds, reason, note })
      // A refresh that was already on its way would show the list from before this.
      latest.current += 1
      setState((current) => current && withRejected(current, awardIds, reason, filter))
      setSelected(new Set())
      closeAsk()
      say({
        tone: 'done',
        message: doneLine(
          done.rejected ?? awardIds.length,
          done.returned_minor,
          state?.currency ?? 'USD',
        ),
      })
      // The budget, the counts and the creators changed with it.
      if (pages === 1) void load(true)
      else void refreshFigures()
    } catch (problem) {
      const described = describeProblem(problem, 'reject')
      if (described.recovery === 'reload') {
        // The page no longer matched the database, so it reads the list again and says so.
        closeAsk()
        setSelected(new Set())
        const read = await load(true)
        say(
          read
            ? { tone: 'news', message: described.message }
            : {
                tone: 'problem',
                problem: { code: described.code, message: STALE_LINE, recovery: 'retry' },
                again: () => {
                  setNotice(undefined)
                  void load()
                },
              },
        )
      } else if (described.code === 'not_allowed') {
        // The database knows better than the page whether this person may reject.
        closeAsk()
        setSelected(new Set())
        setState((current) => current && withoutRejecting(current))
        say({ tone: 'problem', problem: described })
      } else {
        // The dialog stays open with what was chosen; its own button tries again.
        setAskProblem(described)
      }
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const currency = state?.currency ?? 'USD'
  const canManage = Boolean(state?.can_manage)
  const filterName = memberId ? (nameOnPage ?? lookedUp) : undefined
  const open = program?.status === 'live' || program?.status === 'paused'
  const back = goingBack(picked, state?.budget?.fee_bps ?? null)
  const everyone = state?.creators ?? []
  const listed = memberId ? everyone.filter((item) => item.member_id === memberId) : everyone
  const allPicked = picked.length > 0 && picked.length === Math.min(rejectable.length, REJECT_MAX)
  const waiting = rows.some((award) => award.status === 'pending')

  return (
    <div className="mc-page mc-rw" ref={root}>
      <PageHeader
        title="Rewards"
        description="What creators earned for events, and what you can still reject."
      />

      {!state && !loadProblem && !unavailable && <Loading />}

      {unavailable && !state && (
        <section className="mc-panel" aria-label="Rewards">
          <p className="mc-rw-none">
            Rewards are not available yet. There is nothing you need to do here.
          </p>
        </section>
      )}

      {loadProblem && !state && (
        <section className="mc-panel mc-rw-failed" aria-label="Rewards">
          {memberId && <Chip name={filterName} />}
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
        <section className="mc-panel" aria-label="Rewards">
          <p className="mc-rw-none">
            Rewards appear here once your program pays creators for events.{' '}
            <a className="mc-link" href={PROGRAM}>
              Open Program
            </a>
          </p>
        </section>
      )}

      {state && program && (
        <>
          {(program.status === 'paused' || backToSales) && (
            <p className="mc-rw-banner" role="status">
              <span>
                {backToSales
                  ? 'Your program pays for sales now, so events earn nothing new. Earlier rewards stay here, and pending ones can still be rejected.'
                  : 'This program is paused, so events earn nothing until it is live again.'}
              </span>{' '}
              <a className="mc-link" href={PROGRAM}>
                Open Program
              </a>
            </p>
          )}

          {!backToSales && (
            <Month
              budget={state.budget}
              list={state.rewards}
              currency={currency}
              canManage={canManage}
            />
          )}

          {listed.length > 0 && (
            <Creators
              listed={listed}
              everyone={everyone}
              list={state.rewards}
              currency={currency}
              linked={!memberId}
              whole={everyCreator}
              onWhole={() => setEveryCreator(true)}
            />
          )}

          <section className="mc-panel mc-panel-flush mc-rw-list" aria-labelledby={listId}>
            <div className="mc-panel-head is-padded mc-rw-head">
              <div className="mc-rw-title">
                <h2 id={listId}>{memberId ? 'Rewards from' : 'All rewards'}</h2>
                {memberId && <Chip name={filterName} />}
              </div>
              <Segmented
                label="Status"
                options={filterOptions}
                value={filter ?? 'all'}
                onChange={(value) => chooseFilter(value === 'all' ? null : value)}
              />
            </div>

            {notice?.tone === 'problem' && (
              <Problem
                problem={notice.problem}
                onRetry={notice.again}
                onSignIn={() => void signOut()}
              />
            )}
            {notice && notice.tone !== 'problem' && (
              <p className="mc-rw-said" role="status" tabIndex={-1} ref={said}>
                {notice.tone === 'done' && <CircleCheck size={16} aria-hidden="true" />}
                <span className="mc-num">{notice.message}</span>
              </p>
            )}

            {!canManage && waiting && !switching && (
              <p className="mc-rw-said">
                <span>Only an owner or admin of {workspaceName} can reject rewards.</span>
              </p>
            )}

            {loadProblem ? (
              <Problem
                problem={loadProblem}
                onRetry={() => {
                  setLoadProblem(undefined)
                  void load()
                }}
                onSignIn={() => void signOut()}
              />
            ) : switching ? (
              <div className="mc-table-loading" role="status" aria-label="Loading rewards">
                {[0, 1, 2, 3].map((row) => (
                  <Skeleton key={row} width="100%" height={36} />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="mc-empty-line">
                {shown ? (
                  <>
                    {emptyNames[shown]}
                    {memberId && filterName ? ` from ${filterName}` : ''}.{' '}
                    <button type="button" className="mc-link" onClick={() => chooseFilter(null)}>
                      Show every status
                    </button>
                  </>
                ) : memberId ? (
                  <>
                    {filterName
                      ? `No rewards from ${filterName} yet.`
                      : 'No rewards from them yet.'}{' '}
                    <a className="mc-link" href={ALL_REWARDS}>
                      Show all rewards
                    </a>
                  </>
                ) : open ? (
                  <>
                    No rewards yet. One appears here each time someone from a creator’s link does
                    one of your events.{' '}
                    <a className="mc-link" href={CREATORS}>
                      Open Creators
                    </a>
                  </>
                ) : (
                  <>
                    Events earn rewards once your program is live.{' '}
                    <a className="mc-link" href={PROGRAM}>
                      Open Program
                    </a>
                  </>
                )}
              </p>
            ) : (
              <>
                {rejectable.length > 0 && (
                  <div className="mc-rw-pick">
                    <button
                      type="button"
                      className="mc-text-btn"
                      disabled={busy}
                      onClick={allPicked ? () => setSelected(new Set()) : pickAll}
                    >
                      {allPicked
                        ? 'Clear selection'
                        : rejectable.length > REJECT_MAX
                          ? `Select the first ${REJECT_MAX} pending`
                          : 'Select all pending'}
                    </button>
                  </div>
                )}
                <table
                  className={
                    rejectable.length > 0
                      ? 'mc-table mc-rw-table has-ticks'
                      : 'mc-table mc-rw-table'
                  }
                >
                  <thead>
                    <tr>
                      {rejectable.length > 0 && (
                        <th scope="col" className="mc-rw-tick">
                          <span className="sr-only">Select</span>
                        </th>
                      )}
                      <th scope="col">Date</th>
                      <th scope="col">Creator</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Reward</th>
                      <th scope="col" className="mc-num-col">
                        Amount
                      </th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((award) => (
                      <Row
                        key={award.award_id}
                        award={award}
                        currency={currency}
                        now={now}
                        linked={!memberId}
                        ticks={rejectable.length > 0}
                        picked={selected.has(award.award_id)}
                        locked={busy || (full && !selected.has(award.award_id))}
                        onToggle={() => toggle(award)}
                      />
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {moreProblem && (
              <Problem
                problem={moreProblem}
                onRetry={() => void more()}
                onSignIn={() => void signOut()}
              />
            )}

            {!switching && rows.length > 0 && (state.next_before || pages > 1) && (
              <div className="mc-list-foot mc-rw-more">
                <span className="mc-muted mc-num">
                  {state.next_before
                    ? `Showing the latest ${formatCount(rows.length)}`
                    : `All ${plural(rows.length, 'reward')} shown`}
                </span>
                {state.next_before && (
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    disabled={moreBusy}
                    onClick={() => void more()}
                  >
                    {moreBusy ? <Working>Loading</Working> : 'Show more'}
                  </button>
                )}
              </div>
            )}

            {picked.length > 0 && (
              <div className="mc-rw-bar" role="group" aria-label="Selected rewards">
                <p className="mc-num">
                  <strong>{formatCount(picked.length)} selected</strong>
                  <span>{formatAmount(back.rewards_minor, currency)}</span>
                  {full && <span>The most at one time</span>}
                </p>
                <button
                  type="button"
                  className="mc-text-btn"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="mc-btn mc-btn-secondary"
                  disabled={busy}
                  onClick={(event) => {
                    opener.current = event.currentTarget
                    setAskProblem(undefined)
                    setAsking(true)
                  }}
                >
                  Reject
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <Dialog
        open={asking}
        onOpenChange={(next) => !next && !busy && closeAsk()}
        title={asking ? rejectTitle(picked.length) : ''}
        description={asking ? `${confirmLine(back, currency)} This cannot be undone.` : ''}
      >
        <form className="mc-form-stack" noValidate onSubmit={(event) => void reject(event)}>
          <fieldset
            className={askProblem?.field === 'reason' ? 'mc-choices has-error' : 'mc-choices'}
            aria-describedby={askProblem?.field === 'reason' ? reasonId : undefined}
          >
            <legend>Reason</legend>
            <div>
              {REJECT_REASONS.map((item) => (
                <label key={item} className="mc-choice">
                  <input
                    type="radio"
                    name={`${reasonId}-reason`}
                    checked={reason === item}
                    disabled={busy}
                    onChange={() => {
                      setReason(item)
                      if (askProblem?.field === 'reason') setAskProblem(undefined)
                    }}
                  />
                  <span>{rejectReasonNames[item]}</span>
                </label>
              ))}
            </div>
            {askProblem?.field === 'reason' && (
              <p id={reasonId} className="mc-field-error">
                {askProblem.message}
              </p>
            )}
          </fieldset>
          <Field
            label="Note (optional)"
            error={askProblem?.field === 'note' ? askProblem.message : undefined}
          >
            {(props) => (
              <textarea
                {...props}
                rows={2}
                value={note}
                disabled={busy}
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
              disabled={busy}
              onClick={closeAsk}
            >
              Cancel
            </button>
            <button type="submit" className="mc-btn mc-btn-danger-solid" disabled={busy}>
              {busy ? <Working>Rejecting</Working> : `Reject ${plural(picked.length, 'reward')}`}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}

/** The month's budget in one line and one bar, then each reward with this month's count. */
function Month({
  budget,
  list,
  currency,
  canManage,
}: {
  budget: RewardsBudget | null
  list: Reward[]
  currency: string
  canManage: boolean
}) {
  const id = useId()
  const month = monthName(budget?.month ?? null)
  const standing = budget ? budgetStanding(budget, list) : null
  const notes = budget ? budgetNotes(budget, currency) : []
  if (!budget && list.length === 0) return null
  return (
    <section className="mc-panel mc-panel-flush mc-rw-month" aria-labelledby={id}>
      <div className="mc-panel-head is-padded">
        <h2 id={id}>{month ? `${month} budget` : 'This month’s budget'}</h2>
        <a className="mc-link" href={PROGRAM}>
          {canManage ? 'Change budget' : 'Open Program'}
        </a>
      </div>

      {budget && standing && (
        <div className="mc-rw-budget">
          <p className="mc-rw-used mc-num">
            <strong>{formatAmount(budget.used_minor, currency)}</strong>{' '}
            <span>of {formatAmount(budget.budget_minor ?? 0, currency)} used</span>
          </p>
          <p className={`mc-rw-left mc-num is-${standing.level}`}>
            {standing.level === 'used_up' && <TriangleAlert size={14} aria-hidden="true" />}
            {budgetLeft(standing, currency)}
          </p>
          <div
            className={`mc-rw-meter is-${standing.level}`}
            role="meter"
            aria-labelledby={id}
            aria-valuemin={0}
            aria-valuemax={(budget.budget_minor ?? 0) / 100}
            aria-valuenow={Math.min(budget.used_minor, budget.budget_minor ?? 0) / 100}
            aria-valuetext={budgetLine(budget, currency)}
          >
            <span style={{ width: `${Math.round(standing.share * 1000) / 10}%` }} />
          </div>
          <p className="mc-rw-quiet mc-num">
            {standing.level === 'used_up' ? USED_UP_LINE : notes.join(' ')}
          </p>
        </div>
      )}
      {budget && !standing && (
        <p className="mc-rw-unset">No monthly budget is set, so events earn nothing.</p>
      )}

      {list.length > 0 && (
        <table className="mc-table mc-rw-rewards">
          <thead>
            <tr>
              <th scope="col">Reward</th>
              <th scope="col" className="mc-num-col">
                Amount
              </th>
              <th scope="col" className="mc-num-col">
                This month
              </th>
              <th scope="col" className="mc-num-col">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((reward) => (
              <tr key={reward.key}>
                <td className="mc-rw-label">{reward.label}</td>
                <td data-label="Amount" className="mc-num-col mc-num">
                  {formatAmount(reward.amount_minor, currency)}
                </td>
                <td data-label="This month" className="mc-num-col mc-num">
                  {formatCount(reward.count)}
                </td>
                <td data-label="Total" className="mc-num-col mc-num">
                  {reward.amount_total_minor === null ? (
                    <Dash label="Not known" />
                  ) : (
                    formatAmount(reward.amount_total_minor, currency)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * The last 30 days per creator. A row that deserves a second look comes first, with a mark and
 * a sentence saying why: it never depends on colour to be seen.
 */
function Creators({
  listed,
  everyone,
  list,
  currency,
  linked,
  whole,
  onWhole,
}: {
  listed: RewardCreator[]
  everyone: RewardCreator[]
  list: Reward[]
  currency: string
  linked: boolean
  whole: boolean
  onWhole: () => void
}) {
  const id = useId()
  const ordered = creatorsInOrder(listed)
  const rows = whole ? ordered : ordered.slice(0, CREATORS_SHOWN)
  const further = everyone.some((creator) => creator.went_further !== null)
  return (
    <section className="mc-panel mc-panel-flush mc-rw-people" aria-labelledby={id}>
      <div className="mc-panel-head is-padded">
        <div>
          <h2 id={id}>Creators</h2>
          <p>
            Last 30 days.
            {further ? ' Went further: people who earned the first reward and then another.' : ''}
          </p>
        </div>
      </div>
      <div className="mc-rw-wide">
        <table className="mc-table mc-rw-creators">
          <thead>
            <tr>
              <th scope="col">Creator</th>
              <th scope="col" className="mc-num-col">
                Clicks
              </th>
              {list.map((reward) => (
                <th scope="col" key={reward.key} className="mc-num-col mc-rw-col">
                  {reward.label}
                </th>
              ))}
              {further && (
                <th scope="col" className="mc-num-col">
                  Went further
                </th>
              )}
              <th scope="col" className="mc-num-col">
                Earned
              </th>
              <th scope="col" className="mc-num-col">
                Rejected
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((creator) => {
              const marked = standsOut(creator, everyone)
              return (
                <tr key={creator.member_id} className={marked ? 'is-marked' : undefined}>
                  <td className="mc-rw-person">
                    {linked ? (
                      <a
                        href={href({ name: 'rewards', creator: creator.member_id })}
                        aria-label={`${creator.name}: show only their rewards`}
                      >
                        {creator.name}
                      </a>
                    ) : (
                      <span>{creator.name}</span>
                    )}
                    {marked && (
                      <span className="mc-rw-mark mc-num">
                        <Flag size={13} aria-hidden="true" />
                        <span className="sr-only">Worth a look: </span>
                        {standsOutLine(creator)}
                      </span>
                    )}
                  </td>
                  <td data-label="Clicks" className="mc-num-col mc-num">
                    {formatCount(creator.clicks)}
                  </td>
                  {list.map((reward) => (
                    <td key={reward.key} data-label={reward.label} className="mc-num-col mc-num">
                      {formatCount(creator.counts[reward.key] ?? 0)}
                    </td>
                  ))}
                  {further && (
                    <td data-label="Went further" className="mc-num-col mc-num">
                      {wentFurther(creator) ?? (
                        <Dash label={creator.people === 0 ? 'Nobody yet' : 'Not known'} />
                      )}
                    </td>
                  )}
                  <td data-label="Earned" className="mc-num-col mc-num">
                    {creator.earned_minor === null ? (
                      <Dash label="Not known" />
                    ) : (
                      formatAmount(creator.earned_minor, currency)
                    )}
                    {creator.pending_minor ? (
                      <span className="mc-sub">
                        {formatAmount(creator.pending_minor, currency)} pending
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Rejected" className="mc-num-col mc-num">
                    {formatCount(creator.rejected)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {ordered.length > rows.length && (
        <div className="mc-list-foot mc-rw-more">
          <span className="mc-muted mc-num">
            Showing {formatCount(rows.length)} of {formatCount(ordered.length)}
          </span>
          <button type="button" className="mc-btn mc-btn-secondary" onClick={onWhole}>
            Show all creators
          </button>
        </div>
      )}
    </section>
  )
}

/** One reward: when, who sent the person and through which link, what for, what became of it. */
function Row({
  award,
  currency,
  now,
  linked,
  ticks,
  picked,
  locked,
  onToggle,
}: {
  award: Award
  currency: string
  now: number
  linked: boolean
  ticks: boolean
  picked: boolean
  locked: boolean
  onToggle: () => void
}) {
  const status = awardStatus(award)
  const amount = formatAmount(award.amount_minor, currency)
  const who = award.creator_name ?? 'Creator not known'
  return (
    <tr data-award={award.award_id} tabIndex={-1} className={picked ? 'is-picked' : undefined}>
      {ticks && (
        <td className="mc-rw-tick">
          {award.can_reject && (
            <label className="mc-rw-box">
              <input
                type="checkbox"
                checked={picked}
                disabled={locked}
                onChange={onToggle}
                aria-label={`Select: ${who}, ${award.reward_label}, ${amount}`}
              />
            </label>
          )}
        </td>
      )}
      <td className="mc-rw-when mc-num">
        {formatWhen(award.occurred_at, Math.max(now, Date.parse(award.occurred_at)))}
      </td>
      <td className="mc-rw-who">
        {!award.creator_name ? (
          <Dash label="Not known" />
        ) : linked && award.member_id ? (
          <a
            href={href({ name: 'rewards', creator: award.member_id })}
            aria-label={`${award.creator_name}: show only their rewards`}
          >
            {award.creator_name}
          </a>
        ) : (
          award.creator_name
        )}
      </td>
      <td className="mc-rw-channel">
        {award.link_name ?? <span className="mc-muted">No link</span>}
      </td>
      <td className="mc-rw-reward">
        {award.reward_label}
        {/* On a phone the link is said here, so a reward stays three lines. */}
        <span className="mc-rw-via"> · {award.link_name ?? 'No link'}</span>
      </td>
      <td className="mc-num-col mc-num mc-rw-amount">
        {earns(award) ? (
          amount
        ) : award.status === 'rejected' ? (
          <span className="mc-muted">{amount}</span>
        ) : (
          <Dash label="None" />
        )}
      </td>
      <td className="mc-rw-status">
        <Pill tone={status.tone}>{status.label}</Pill>
        {status.detail && <span className="mc-sub">{status.detail}</span>}
      </td>
    </tr>
  )
}

/** The one creator the list is narrowed to. Its button shows everyone's rewards again. */
function Chip({ name }: { name?: string }) {
  const label = name ?? 'One creator'
  return (
    <span className="mc-rw-chip">
      <span className="mc-truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        onClick={() => navigate({ name: 'rewards' })}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </span>
  )
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** A value a row does not have: no creator, no amount. */
function Dash({ label }: { label: string }) {
  return (
    <span className="mc-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** A failure where it happened, with the one thing that gets past it. */
function Problem({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: RewardsProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-rw-problem" role="alert">
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

function Loading() {
  return (
    <div className="mc-rw-loading" role="status" aria-label="Loading your rewards">
      <div className="mc-panel">
        <Skeleton width={150} height={18} />
        <Skeleton width="min(260px, 70%)" height={26} />
        <Skeleton width="100%" height={8} />
        <Skeleton width="min(420px, 90%)" />
      </div>
      <div className="mc-panel">
        <Skeleton width={96} height={18} />
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} width="100%" height={36} />
        ))}
      </div>
    </div>
  )
}
