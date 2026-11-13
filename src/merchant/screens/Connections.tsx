import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import {
  accountEnding,
  browser,
  claimStripeReturn,
  describeProblem,
  formatDay,
  formatWhen,
  peekStripeReturn,
  outcomeUnknown,
  returnMessages,
  stripeConnect,
} from '../connections'
import type { ConnectProblem, ConnectStep, StripeConnection, StripeStatus } from '../connections'
import { countryName, formatCount } from '../format'
import { useStore } from '../store'
import { Dialog, PageHeader, Pill, Skeleton } from '../ui/Primitives'

const STRIPE_DASHBOARD = 'https://dashboard.stripe.com/'
const REFRESH_MS = 60_000

/** What the Stripe card is busy with; one thing at a time. */
type Phase = 'idle' | 'starting' | 'completing' | 'disconnecting'

/** A line in the card about what just happened: a failure with its way on, or plain news. */
type Notice =
  | {
      tone: 'problem'
      problem: ConnectProblem
      step: ConnectStep
      /** Set when the request may have worked after all; a live connection then settles it. */
      unlessConnected?: boolean
    }
  | { tone: 'news'; message: string }

const soon: Array<{ name: string; about: string }> = [
  {
    name: 'Analytics tools',
    about: 'See creator sales in Amplitude and Adapty, next to the numbers you already track.',
  },
]

export function ConnectionsScreen() {
  const { workspace, workspaces, selectWorkspace, signOut, now } = useStore()
  const workspaceId = workspace?.id
  const [status, setStatus] = useState<StripeStatus>()
  const [loadProblem, setLoadProblem] = useState<ConnectProblem>()
  // An answer from Stripe decides the first thing shown: finishing up, or why nothing happened.
  const [phase, setPhase] = useState<Phase>(() =>
    peekStripeReturn()?.kind === 'approved' ? 'completing' : 'idle',
  )
  const [notice, setNotice] = useState<Notice | undefined>(() => {
    const back = peekStripeReturn()
    return back && back.kind !== 'approved'
      ? { tone: 'news', message: returnMessages[back.kind] }
      : undefined
  })
  const [confirming, setConfirming] = useState(false)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)

  const show = useCallback((next: StripeStatus) => {
    latest.current += 1
    setStatus(next)
    setLoadProblem(undefined)
  }, [])

  const load = useCallback(
    async (quiet = false) => {
      if (!workspaceId) return
      const run = ++latest.current
      try {
        const next = await stripeConnect.status(workspaceId)
        if (run !== latest.current) return
        setStatus(next)
        setLoadProblem(undefined)
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return
        setLoadProblem(describeProblem(problem, 'load'))
      }
    },
    [workspaceId],
  )

  // Opening the page: finish a connection Stripe has just sent back, or read where things stand.
  const completing = useRef(false)
  // The store hands out new functions as its clock ticks; the effect below wants the latest only.
  const workspaceChoice = useRef({ workspaces, selectWorkspace })
  useEffect(() => {
    workspaceChoice.current = { workspaces, selectWorkspace }
  })
  useEffect(() => {
    if (!workspaceId) return
    const back = claimStripeReturn()
    if (back?.kind !== 'approved') {
      // A rerun of this effect must not start a read that would race the completion.
      if (!completing.current) void load()
      return
    }
    completing.current = true
    void (async () => {
      try {
        const next = await stripeConnect.complete(back.state, back.code, workspaceId)
        show(next)
        // The connection belongs to the workspace it was started from.
        const choice = workspaceChoice.current
        if (
          next.workspace_id !== workspaceId &&
          choice.workspaces.some((item) => item.id === next.workspace_id)
        )
          choice.selectWorkspace(next.workspace_id)
      } catch (problem) {
        // No answer does not mean no connection, so look before complaining.
        try {
          show(await stripeConnect.status(workspaceId))
        } catch (unread) {
          setLoadProblem(describeProblem(unread, 'load'))
        }
        setNotice({
          tone: 'problem',
          problem: describeProblem(problem, 'complete'),
          step: 'complete',
          unlessConnected: outcomeUnknown(problem),
        })
      } finally {
        completing.current = false
        setPhase('idle')
      }
    })()
  }, [workspaceId, load, show])

  /** Asked for by the person, or by the connection coming back: the skeleton shows while it reads. */
  const reload = useCallback(() => {
    setLoadProblem(undefined)
    void load()
  }, [load])

  const connected = Boolean(status?.connection)
  // Keeps "waiting for your first payment" honest without a reload.
  useEffect(() => {
    if (!connected || phase !== 'idle') return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [connected, phase, load])

  // Back online: read the connection again without being asked.
  useEffect(() => {
    if (!loadProblem) return
    const retry = () => reload()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [loadProblem, reload])

  // Coming back from Stripe with the browser's Back button restores the page as it was left.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPhase((current) => (current === 'starting' ? 'idle' : current))
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  if (!workspace || !workspaceId) return null

  const fail = (problem: unknown, step: ConnectStep) => {
    const described = describeProblem(problem, step)
    setNotice({ tone: 'problem', problem: described, step })
    // The server knows better than the page whether this person may connect, and whether anyone may.
    if (described.code === 'owner_or_admin_required')
      setStatus((current) => current && { ...current, can_manage: false })
    if (
      described.code === 'console_connect_disabled' ||
      described.code === 'merchant_provider_disabled'
    )
      setStatus((current) => current && { ...current, enabled: false })
  }

  const connect = async () => {
    setNotice(undefined)
    setPhase('starting')
    try {
      // The card keeps saying "Opening Stripe" until the browser has left.
      browser.leaveFor(await stripeConnect.start(workspaceId))
    } catch (problem) {
      fail(problem, 'start')
      setPhase('idle')
    }
  }

  const disconnect = async () => {
    setNotice(undefined)
    setPhase('disconnecting')
    try {
      show(await stripeConnect.disconnect(workspaceId))
      setNotice({ tone: 'news', message: returnMessages.disconnected })
    } catch (problem) {
      fail(problem, 'disconnect')
    } finally {
      setConfirming(false)
      setPhase('idle')
    }
  }

  const retry = (step: ConnectStep) => {
    if (step === 'disconnect') void disconnect()
    else if (step === 'load') reload()
    else void connect()
  }

  const connection = status?.connection ?? null
  const canManage = Boolean(status?.enabled && status.can_manage)
  const loading = !status && !loadProblem && phase !== 'completing'

  let line: ReactNode
  let action: ReactNode = null
  if (phase === 'completing') {
    line = (
      <p className="mc-conn-wait" role="status">
        <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />
        Finishing your Stripe connection
      </p>
    )
  } else if (loading) {
    line = (
      <p className="mc-conn-loading" role="status" aria-label="Loading your Stripe connection">
        <Skeleton width="min(460px, 100%)" />
        <Skeleton width="min(280px, 70%)" />
      </p>
    )
    action = <Skeleton width={148} height={36} />
  } else if (!status) {
    line = null
  } else if (connection) {
    line = connection.charges_enabled ? (
      <p className="mc-conn-state" role="status">
        <span className="mc-status-dot is-on" aria-hidden="true" />
        Connected. Watching for sales.
      </p>
    ) : (
      <p className="mc-conn-state" role="status">
        <span className="mc-status-dot is-warning" aria-hidden="true" />
        <span>
          Connected, but Stripe has paused payments on this account.{' '}
          <a className="mc-link" href={STRIPE_DASHBOARD} target="_blank" rel="noreferrer">
            Open Stripe
          </a>
        </span>
      </p>
    )
    if (canManage)
      action = (
        <button
          type="button"
          className="mc-text-btn mc-conn-quiet"
          disabled={phase !== 'idle'}
          onClick={() => setConfirming(true)}
        >
          Disconnect
        </button>
      )
  } else {
    line = (
      <p className="mc-conn-about">
        Connect the Stripe account your customers pay into, so KissMyApps can see each sale and
        match it to the creator who sent it.
      </p>
    )
    if (!status.enabled) action = <Pill>Coming soon</Pill>
    else if (status.can_manage)
      action = (
        <button
          type="button"
          className="mc-btn mc-btn-primary"
          disabled={phase !== 'idle'}
          onClick={() => void connect()}
        >
          {phase === 'starting' ? (
            <>
              <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> Opening Stripe
            </>
          ) : (
            'Connect Stripe'
          )}
        </button>
      )
  }

  const readOnly = status?.enabled && !status.can_manage && !connection && phase !== 'completing'

  return (
    <div className="mc-page mc-conn">
      <PageHeader
        title="Connections"
        description="Link the tools your business already uses. Stripe is the only one you need."
      />

      <section
        className="mc-panel mc-conn-stripe"
        aria-labelledby="mc-conn-stripe"
        aria-busy={loading || phase !== 'idle'}
      >
        <div className="mc-conn-head">
          <div className="mc-conn-text">
            <h2 id="mc-conn-stripe">Stripe</h2>
            {line}
          </div>
          {action && <div className="mc-conn-action">{action}</div>}
        </div>

        {readOnly && (
          <p className="mc-conn-note">
            Only an owner or admin of {workspace.name} can connect Stripe.
          </p>
        )}

        {loadProblem && !status && phase !== 'completing' && (
          <ProblemNote problem={loadProblem} onRetry={reload} onSignIn={() => void signOut()} />
        )}

        {notice?.tone === 'news' && phase !== 'completing' && !loadProblem && (
          <p className="mc-conn-note" role="status">
            {notice.message}
          </p>
        )}
        {notice?.tone === 'problem' &&
          phase === 'idle' &&
          status &&
          !(notice.unlessConnected && connection) &&
          // The note above already says who may connect.
          !(readOnly && notice.problem.code === 'owner_or_admin_required') && (
            <ProblemNote
              problem={notice.problem}
              onRetry={() => retry(notice.step)}
              onSignIn={() => void signOut()}
            />
          )}

        {connection && phase !== 'completing' && (
          <ConnectedFacts connection={connection} payments={status!.payments} now={now} />
        )}
      </section>

      <section className="mc-panel mc-conn-more" aria-label="More connections">
        <ul>
          {soon.map((item) => (
            <li key={item.name}>
              <h2>{item.name}</h2>
              <p>{item.about}</p>
              <Pill>Coming soon</Pill>
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={confirming && Boolean(connection)}
        onOpenChange={(open) => !open && phase !== 'disconnecting' && setConfirming(false)}
        title="Disconnect Stripe?"
        description={`KissMyApps will stop seeing sales from ${connection?.business_name || 'your Stripe account'}, so new sales can no longer be matched to creators. Your customers can still pay you as usual.`}
      >
        <div className="mc-form-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            disabled={phase === 'disconnecting'}
            onClick={() => setConfirming(false)}
          >
            Keep connected
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger-solid"
            disabled={phase === 'disconnecting'}
            onClick={() => void disconnect()}
          >
            {phase === 'disconnecting' ? (
              <>
                <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> Disconnecting
              </>
            ) : (
              'Disconnect Stripe'
            )}
          </button>
        </div>
      </Dialog>
    </div>
  )
}

/** A failure inside the card it belongs to, with the one thing that gets past it. */
function ProblemNote({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: ConnectProblem
  onRetry: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-conn-problem" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{problem.message}</span>
      {problem.recovery === 'retry' && (
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      {problem.recovery === 'sign-in' && (
        <button type="button" className="mc-text-btn" onClick={onSignIn}>
          Sign in again
        </button>
      )}
      {problem.recovery === 'stripe' && (
        <a className="mc-text-btn" href={STRIPE_DASHBOARD} target="_blank" rel="noreferrer">
          Open Stripe
        </a>
      )}
    </p>
  )
}

function ConnectedFacts({
  connection,
  payments,
  now,
}: {
  connection: StripeConnection
  payments: StripeStatus['payments']
  now: number
}) {
  const ending = accountEnding(connection.account_id)
  return (
    <>
      <dl className="mc-conn-facts">
        <div>
          <dt>Business</dt>
          <dd>{connection.business_name || 'Stripe account'}</dd>
        </div>
        {connection.country && (
          <div>
            <dt>Country</dt>
            <dd>{countryName(connection.country)}</dd>
          </div>
        )}
        <div>
          <dt>Account</dt>
          <dd className="mc-mono">
            <span className="sr-only">Ending in </span>
            <span aria-hidden="true">acct_••••</span>
            {ending}
          </dd>
        </div>
        {connection.connected_at && (
          <div>
            <dt>Connected</dt>
            <dd>{formatDay(connection.connected_at)}</dd>
          </div>
        )}
      </dl>
      <dl className="mc-conn-facts">
        {payments.seen === 0 ? (
          <div>
            <dt>Payments</dt>
            <dd>Waiting for your first payment</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>Payments seen</dt>
              <dd className="mc-num">{formatCount(payments.seen)}</dd>
            </div>
            {payments.tagged === 0 ? (
              <>
                {payments.last_at && (
                  <div>
                    <dt>Last payment</dt>
                    <dd className="mc-num">{formatWhen(payments.last_at, now)}</dd>
                  </div>
                )}
                <div>
                  <dt>From creator links</dt>
                  <dd>None yet</dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>From creator links</dt>
                  <dd className="mc-num">{formatCount(payments.tagged)}</dd>
                </div>
                <div>
                  <dt>Last creator sale</dt>
                  <dd className="mc-num">
                    {payments.last_tagged_at ? formatWhen(payments.last_tagged_at, now) : '–'}
                  </dd>
                </div>
              </>
            )}
          </>
        )}
      </dl>
    </>
  )
}
