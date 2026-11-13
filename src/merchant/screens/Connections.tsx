import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react'
import { AMPLITUDE_KEY, analyticsDestinations, STORE_PROVIDERS, storeConnections } from '../api'
import type {
  AnalyticsDestination,
  DestinationRegion,
  Project,
  StoreConnection,
  StoreConnections,
  StoreProvider,
  StoreWebhook,
} from '../api'
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
import { ProgramError } from '../programs'
import { canDo, useStore } from '../store'
import {
  CopyButton,
  Dialog,
  PageHeader,
  Pill,
  ProjectMark,
  Segmented,
  Skeleton,
} from '../ui/Primitives'

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

export function ConnectionsScreen() {
  const { workspace, workspaces, selectWorkspace, signOut, now, projects } = useStore()
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

      <StoreTools
        workspaceId={workspaceId}
        workspaceName={workspace.name}
        canManage={canDo(workspace.role, 'admin')}
        now={now}
        onSignIn={() => void signOut()}
      />

      <AmplitudeCard
        projects={projects}
        workspaceName={workspace.name}
        canChange={canDo(workspace.role, 'developer')}
        now={now}
        onSignIn={() => void signOut()}
      />

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

// ---- In-app purchases and Amplitude (Phase 8) ----------------------------------------------

/** What the person was doing when a request to a tool card failed. */
type ToolStep =
  | 'load'
  | 'connect'
  | 'rotate'
  | 'remove'
  | 'amplitude-load'
  | 'amplitude-save'
  | 'amplitude-remove'

/** How the person gets past a problem in a tool card. `reload` means the card read it again. */
type ToolRecovery = 'retry' | 'reload' | 'sign-in' | 'none'

interface ToolProblem {
  code: string
  message: string
  recovery: ToolRecovery
  /** Set when the problem belongs to the Amplitude form's key or region. */
  field?: 'key' | 'region'
}

const toolMessages: Record<string, Omit<ToolProblem, 'code'>> = {
  not_allowed: {
    message: 'Your role cannot change this. Ask an owner or admin of the workspace.',
    recovery: 'none',
  },
  not_found: {
    message: 'That was changed somewhere else. You are now seeing the latest.',
    recovery: 'reload',
  },
  connection_exists: {
    message: 'That app is already connected. You are now seeing the latest.',
    recovery: 'reload',
  },
  already_connected: {
    message: 'That app is already connected. You are now seeing the latest.',
    recovery: 'reload',
  },
  invalid_key: {
    message: 'Enter the 32-character API key of your Amplitude project.',
    recovery: 'none',
    field: 'key',
  },
  key_required: {
    message: 'Enter the API key of your Amplitude project.',
    recovery: 'none',
    field: 'key',
  },
  invalid_region: { message: 'Choose US or EU.', recovery: 'none', field: 'region' },
  unauthorized: {
    message: 'Your session has expired. Sign in again to continue.',
    recovery: 'sign-in',
  },
  offline: {
    message: 'You are offline. Reconnect to the internet and try again.',
    recovery: 'retry',
  },
  unreachable: {
    message: 'KissMyApps could not be reached. Check your connection and try again.',
    recovery: 'retry',
  },
}

const toolFallbacks: Record<ToolStep, string> = {
  load: 'Your in-app purchase connections could not be loaded. Try again.',
  connect: 'The app was not connected. Try again.',
  rotate: 'No new header value was made, so the current one still works. Try again.',
  remove: 'The connection was not removed. Try again.',
  'amplitude-load': 'Your Amplitude connection could not be loaded. Try again.',
  'amplitude-save': 'The Amplitude key was not saved. Try again.',
  'amplitude-remove': 'Amplitude was not removed. Try again.',
}

function describeToolProblem(problem: unknown, step: ToolStep): ToolProblem {
  const code = problem instanceof ProgramError ? problem.code : 'unknown'
  // Amplitude can be changed by a developer too; the in-app purchase tools by an owner or admin.
  if (code === 'not_allowed' && step.startsWith('amplitude'))
    return {
      code,
      message: 'Your role cannot change this. Ask a developer, admin or owner of the workspace.',
      recovery: 'none',
    }
  // A key or region the database refused is said at the field; any other input is the form's.
  const known =
    toolMessages[code] ??
    (code === 'invalid_input' && step === 'amplitude-save' ? toolMessages.invalid_key : null)
  if (known) return { code, ...known }
  return { code, message: toolFallbacks[step], recovery: 'retry' }
}

const toolNames: Record<StoreProvider, string> = { revenuecat: 'RevenueCat', adapty: 'Adapty' }

/** Where each tool keeps its webhooks, in the words of its own dashboard. */
const webhookPlace: Record<StoreProvider, string> = {
  revenuecat:
    'In RevenueCat, open Project settings, then Integrations, then Webhooks, and add one.',
  adapty: 'In Adapty, open App settings, then Integrations, then Webhooks.',
}

const toolAbout: Record<StoreProvider, string> = {
  revenuecat: 'Lets creators earn on App Store and Google Play purchases that RevenueCat reports.',
  adapty: 'Lets creators earn on App Store and Google Play purchases that Adapty reports.',
}

/** A failure inside the card it belongs to, with the one thing that gets past it. */
function ToolNote({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: ToolProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-conn-problem mc-p8-problem" role="alert">
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

function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** What a tool card is busy with; one thing at a time across both cards. */
type StoreBusy =
  { kind: 'connect'; provider: StoreProvider } | { kind: 'rotate' | 'remove'; id: string } | null

/** A failure in one card, kept with what to run again. */
type StoreNotice = { provider: StoreProvider; problem: ToolProblem; again?: () => void }

/** The two in-app purchase tools: one answer draws both cards. */
function StoreTools({
  workspaceId,
  workspaceName,
  canManage,
  now,
  onSignIn,
}: {
  workspaceId: string
  workspaceName: string
  canManage: boolean
  now: number
  onSignIn: () => void
}) {
  const { notify } = useStore()
  const [list, setList] = useState<StoreConnections>()
  const [loadProblem, setLoadProblem] = useState<ToolProblem>()
  const [busy, setBusy] = useState<StoreBusy>(null)
  const [notice, setNotice] = useState<StoreNotice>()
  // Header values just made, by connection. Held on this page only: shown once, never stored.
  const [shown, setShown] = useState<Record<string, StoreWebhook>>({})
  const [confirming, setConfirming] = useState<{
    kind: 'rotate' | 'remove'
    connection: StoreConnection
  } | null>(null)
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const run = ++latest.current
      let next: StoreConnections
      try {
        next = await storeConnections.list(workspaceId)
      } catch (problem) {
        if (run !== latest.current || quiet) return
        setLoadProblem(describeToolProblem(problem, 'load'))
        return
      }
      if (run !== latest.current) return
      setList(next)
      setLoadProblem(undefined)
    },
    [workspaceId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Leaving the page while a header value is on screen asks first: it cannot be shown again.
  const showing = Object.keys(shown).length > 0
  useEffect(() => {
    if (!showing) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [showing])

  const fail = async (
    provider: StoreProvider,
    problem: unknown,
    step: ToolStep,
    again: () => void,
  ) => {
    const described = describeToolProblem(problem, step)
    if (described.recovery === 'reload') await load(true)
    setNotice({ provider, problem: described, again })
  }

  const connect = async (provider: StoreProvider, projectId: string) => {
    if (busy) return
    setNotice(undefined)
    setBusy({ kind: 'connect', provider })
    try {
      const made = await storeConnections.create(workspaceId, projectId, provider)
      await load(true)
      const key = made.connection?.id ?? `${provider}:${projectId}`
      setShown((current) => ({ ...current, [key]: made }))
      const name =
        made.connection?.project_name ??
        list?.projects.find((project) => project.id === projectId)?.name
      notify(`${toolNames[provider]} connected${name ? ` to ${name}` : ''}`)
    } catch (problem) {
      await fail(provider, problem, 'connect', () => void connect(provider, projectId))
    } finally {
      setBusy(null)
    }
  }

  const rotate = async (connection: StoreConnection) => {
    if (busy) return
    setNotice(undefined)
    setBusy({ kind: 'rotate', id: connection.id })
    try {
      const made = await storeConnections.rotate(connection.id)
      setShown((current) => ({ ...current, [connection.id]: made }))
      setConfirming(null)
      notify('New header value made')
      void load(true)
    } catch (problem) {
      setConfirming(null)
      await fail(connection.provider, problem, 'rotate', () => void rotate(connection))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (connection: StoreConnection) => {
    if (busy) return
    setNotice(undefined)
    setBusy({ kind: 'remove', id: connection.id })
    try {
      const after = await storeConnections.remove(connection.id)
      setShown(({ [connection.id]: _gone, ...rest }) => rest)
      setConfirming(null)
      notify(`${toolNames[connection.provider]} removed from ${connection.project_name}`)
      // The answer is the list as it now is; an answer without one is read again.
      if (after) setList(after)
      else await load(true)
    } catch (problem) {
      setConfirming(null)
      await fail(connection.provider, problem, 'remove', () => void remove(connection))
    } finally {
      setBusy(null)
    }
  }

  const done = (key: string) => setShown(({ [key]: _done, ...rest }) => rest)
  const target = confirming?.connection
  const tool = target ? toolNames[target.provider] : ''

  return (
    <>
      {STORE_PROVIDERS.map((provider) => (
        <StoreCard
          key={provider}
          provider={provider}
          list={list}
          loadProblem={loadProblem}
          canManage={list?.can_manage ?? canManage}
          workspaceName={workspaceName}
          busy={busy}
          notice={notice?.provider === provider ? notice : undefined}
          shown={shown}
          now={now}
          onRetryLoad={() => {
            setLoadProblem(undefined)
            void load()
          }}
          onSignIn={onSignIn}
          onConnect={(projectId) => void connect(provider, projectId)}
          onRotate={(connection) => setConfirming({ kind: 'rotate', connection })}
          onRemove={(connection) => setConfirming({ kind: 'remove', connection })}
          onDone={done}
        />
      ))}

      <Dialog
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
        title={
          confirming?.kind === 'rotate'
            ? 'Make a new header value?'
            : `Remove ${tool} from ${target?.project_name ?? 'this app'}?`
        }
        description={
          confirming?.kind === 'rotate'
            ? `The value ${tool} sends now stops working at once. Paste the new one in ${tool} straight after, or purchases are not recorded until you do.`
            : `KissMyApps stops recording purchases ${tool} sends for ${target?.project_name ?? 'this app'}. Sales already recorded stay. Remove the webhook in ${tool} too.`
        }
      >
        <div className="mc-form-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            disabled={Boolean(busy)}
            onClick={() => setConfirming(null)}
          >
            {confirming?.kind === 'rotate' ? 'Keep the current value' : 'Keep connected'}
          </button>
          {confirming?.kind === 'rotate' ? (
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={Boolean(busy)}
              onClick={() => target && void rotate(target)}
            >
              {busy?.kind === 'rotate' ? <Busy>Making a new value</Busy> : 'Make a new value'}
            </button>
          ) : (
            <button
              type="button"
              className="mc-btn mc-btn-danger-solid"
              disabled={Boolean(busy)}
              onClick={() => target && void remove(target)}
            >
              {busy?.kind === 'remove' ? <Busy>Removing</Busy> : `Remove ${tool}`}
            </button>
          )}
        </div>
      </Dialog>
    </>
  )
}

/** One in-app purchase tool: the apps it is connected to, and connecting another. */
function StoreCard({
  provider,
  list,
  loadProblem,
  canManage,
  workspaceName,
  busy,
  notice,
  shown,
  now,
  onRetryLoad,
  onSignIn,
  onConnect,
  onRotate,
  onRemove,
  onDone,
}: {
  provider: StoreProvider
  list: StoreConnections | undefined
  loadProblem: ToolProblem | undefined
  canManage: boolean
  workspaceName: string
  busy: StoreBusy
  notice: StoreNotice | undefined
  shown: Record<string, StoreWebhook>
  now: number
  onRetryLoad: () => void
  onSignIn: () => void
  onConnect: (projectId: string) => void
  onRotate: (connection: StoreConnection) => void
  onRemove: (connection: StoreConnection) => void
  onDone: (key: string) => void
}) {
  const name = toolNames[provider]
  const headingId = `mc-p8-${provider}`
  const connections = (list?.connections ?? [])
    .filter((connection) => connection.provider === provider)
    .sort((a, b) => a.project_name.localeCompare(b.project_name))
  const taken = new Set(connections.map((connection) => connection.project_id))
  const open = (list?.projects ?? []).filter((project) => !taken.has(project.id))
  // A value made for a connection the list does not carry yet still shows, under the list.
  const loose = Object.entries(shown).filter(
    ([key, made]) =>
      key.startsWith(`${provider}:`) ||
      (made.connection?.provider === provider && !connections.some((item) => item.id === key)),
  )
  const loading = !list && !loadProblem

  return (
    <section
      className="mc-panel mc-conn-stripe mc-p8-tool"
      aria-labelledby={headingId}
      aria-busy={loading}
    >
      <div className="mc-conn-head">
        <div className="mc-conn-text">
          <h2 id={headingId}>{name}</h2>
          <p className="mc-conn-about">{toolAbout[provider]}</p>
        </div>
      </div>

      {loading && (
        <div
          className="mc-p8-loading"
          role="status"
          aria-label={`Loading your ${name} connections`}
        >
          <Skeleton width="min(360px, 100%)" />
          <Skeleton width="min(240px, 70%)" />
        </div>
      )}

      {loadProblem && !list && (
        <ToolNote problem={loadProblem} onRetry={onRetryLoad} onSignIn={onSignIn} />
      )}

      {connections.length > 0 && (
        <ul className="mc-p8-apps" aria-label={`Apps connected to ${name}`}>
          {connections.map((connection) => (
            <StoreApp
              key={connection.id}
              connection={connection}
              canManage={canManage}
              busy={busy}
              made={shown[connection.id]}
              now={now}
              onRotate={() => onRotate(connection)}
              onRemove={() => onRemove(connection)}
              onDone={() => onDone(connection.id)}
            />
          ))}
        </ul>
      )}

      {loose.map(([key, made]) => (
        <WebhookSetup key={key} provider={provider} made={made} onDone={() => onDone(key)} />
      ))}

      {notice && <ToolNote problem={notice.problem} onRetry={notice.again} onSignIn={onSignIn} />}

      {list && canManage && open.length > 0 && (
        <ConnectApp
          provider={provider}
          projects={open}
          first={connections.length === 0}
          busy={busy?.kind === 'connect' && busy.provider === provider}
          disabled={Boolean(busy)}
          onConnect={onConnect}
        />
      )}

      {list && canManage && list.projects.length === 0 && (
        <p className="mc-conn-note">
          Add your app as a project first, then connect it to {name} here.
        </p>
      )}

      {list && !canManage && (
        <p className="mc-conn-note">
          {connections.length === 0 ? 'No app is connected. ' : ''}Only an owner or admin of{' '}
          {workspaceName} can connect {name}.
        </p>
      )}
    </section>
  )
}

/** Choosing the app a tool reports purchases for, and connecting it. */
function ConnectApp({
  provider,
  projects,
  first,
  busy,
  disabled,
  onConnect,
}: {
  provider: StoreProvider
  projects: Array<{ id: string; name: string }>
  first: boolean
  busy: boolean
  disabled: boolean
  onConnect: (projectId: string) => void
}) {
  const id = useId()
  const [chosen, setChosen] = useState(projects[0]?.id ?? '')
  // The app chosen may have just been connected, so the choice falls back to the first left.
  const value = projects.some((project) => project.id === chosen) ? chosen : (projects[0]?.id ?? '')
  return (
    <form
      className="mc-p8-connect"
      onSubmit={(event) => {
        event.preventDefault()
        if (value) onConnect(value)
      }}
    >
      <div className="mc-field">
        <label htmlFor={id}>{first ? 'App' : 'Another app'}</label>
        <span className="mc-select-box">
          <select id={id} value={value} onChange={(event) => setChosen(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      </div>
      <button
        type="submit"
        className={first ? 'mc-btn mc-btn-primary' : 'mc-btn mc-btn-secondary'}
        disabled={disabled || !value}
      >
        {busy ? <Busy>Connecting</Busy> : `Connect ${toolNames[provider]}`}
      </button>
    </form>
  )
}

/** One app a tool is connected to: what arrived lately, and the two things that can be done. */
function StoreApp({
  connection,
  canManage,
  busy,
  made,
  now,
  onRotate,
  onRemove,
  onDone,
}: {
  connection: StoreConnection
  canManage: boolean
  busy: StoreBusy
  made: StoreWebhook | undefined
  now: number
  onRotate: () => void
  onRemove: () => void
  onDone: () => void
}) {
  const working = busy && busy.kind !== 'connect' && busy.id === connection.id
  return (
    <li className="mc-p8-app">
      <div className="mc-p8-app-head">
        <ProjectMark project={{ id: connection.project_id, name: connection.project_name }} />
        <div className="mc-p8-app-text">
          <h3>{connection.project_name}</h3>
          <p className="mc-conn-state">
            <span
              className={connection.last_event_at ? 'mc-status-dot is-on' : 'mc-status-dot'}
              aria-hidden="true"
            />
            <span className="mc-num">
              {connection.last_event_at
                ? `Last event ${formatWhen(connection.last_event_at, Math.max(now, Date.parse(connection.last_event_at)))}`
                : 'Waiting for the first event'}
            </span>
          </p>
        </div>
        {canManage && (
          <div className="mc-p8-app-actions">
            <button
              type="button"
              className="mc-text-btn mc-conn-quiet"
              disabled={Boolean(busy)}
              onClick={onRotate}
            >
              {working && busy?.kind === 'rotate' ? <Busy>Making</Busy> : 'New header value'}
            </button>
            <button
              type="button"
              className="mc-text-btn mc-conn-quiet"
              disabled={Boolean(busy)}
              onClick={onRemove}
            >
              {working && busy?.kind === 'remove' ? <Busy>Removing</Busy> : 'Remove'}
            </button>
          </div>
        )}
      </div>
      <dl className="mc-conn-facts mc-p8-facts">
        <div>
          <dt>Events, 30 days</dt>
          <dd className="mc-num">{formatCount(connection.events_30d)}</dd>
        </div>
        <div>
          <dt>Creator sales, 30 days</dt>
          <dd className="mc-num">{formatCount(connection.sales_30d)}</dd>
        </div>
        {connection.created_at && (
          <div>
            <dt>Connected</dt>
            <dd>{formatDay(connection.created_at)}</dd>
          </div>
        )}
      </dl>
      {!made && connection.webhook_url && (
        <div className="mc-p8-address">
          <span>Webhook address</span>
          <CopyLine value={connection.webhook_url} label="webhook address" />
        </div>
      )}
      {made && <WebhookSetup provider={connection.provider} made={made} onDone={onDone} />}
    </li>
  )
}

/** The webhook to add in the tool's dashboard: the steps, the address and the header value, once. */
function WebhookSetup({
  provider,
  made,
  onDone,
}: {
  provider: StoreProvider
  made: StoreWebhook
  onDone: () => void
}) {
  const name = toolNames[provider]
  const headingId = useId()
  const box = useRef<HTMLDivElement>(null)
  // The value appears where the person is not looking yet, so focus takes them there.
  useEffect(() => {
    box.current?.focus()
  }, [made.header_value])
  return (
    <div className="mc-p8-setup" role="region" aria-labelledby={headingId} tabIndex={-1} ref={box}>
      <h3 id={headingId}>Add the webhook in {name}</h3>
      <ol>
        <li>{webhookPlace[provider]}</li>
        <li>
          <span>Paste this as the webhook address.</span>
          <CopyLine value={made.webhook_url} label="webhook address" />
        </li>
        <li>
          <span>Paste this as the Authorization header value, then save.</span>
          <CopyLine value={made.header_value} label="header value" />
        </li>
      </ol>
      <p className="mc-p8-once">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>This header value will not be shown again. Copy it now.</span>
      </p>
      <div>
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onDone}>
          I have added it
        </button>
      </div>
    </div>
  )
}

/** A value to paste somewhere else, with its copy button. */
function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <span className="mc-p8-copy">
      <code className="mc-mono">{value}</code>
      <CopyButton value={value} label={label} />
    </span>
  )
}

type AmplitudeBusy = 'idle' | 'saving' | 'removing'

/** Amplitude, per app: where installs are sent, the key's last four, and how sending goes. */
function AmplitudeCard({
  projects,
  workspaceName,
  canChange,
  now,
  onSignIn,
}: {
  projects: Project[]
  workspaceName: string
  canChange: boolean
  now: number
  onSignIn: () => void
}) {
  const { notify } = useStore()
  const pickerId = useId()
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const chosen = projects.find((project) => project.id === projectId) ?? projects[0]
  const [answer, setAnswer] = useState<{
    project: string
    destination: AnalyticsDestination | null
  }>()
  const [loadProblem, setLoadProblem] = useState<ToolProblem>()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [region, setRegion] = useState<DestinationRegion>('us')
  const [fieldError, setFieldError] = useState<{ key?: string; region?: string }>({})
  const [busy, setBusy] = useState<AmplitudeBusy>('idle')
  const [notice, setNotice] = useState<{ problem: ToolProblem; again?: () => void }>()
  const [confirming, setConfirming] = useState(false)
  const latest = useRef(0)
  const project = chosen?.id

  const load = useCallback(
    async (quiet = false) => {
      if (!project) return
      const run = ++latest.current
      let list: AnalyticsDestination[]
      try {
        list = await analyticsDestinations.get(project)
      } catch (problem) {
        if (run !== latest.current || quiet) return
        setLoadProblem(describeToolProblem(problem, 'amplitude-load'))
        return
      }
      if (run !== latest.current) return
      setAnswer({ project, destination: list[0] ?? null })
      setLoadProblem(undefined)
    },
    [project],
  )

  useEffect(() => {
    void load()
  }, [load])

  const current = answer?.project === project ? answer : undefined
  const destination = current?.destination ?? null

  const choose = (next: string) => {
    if (next === project) return
    setProjectId(next)
    setEditing(false)
    setKey('')
    setFieldError({})
    setNotice(undefined)
    setLoadProblem(undefined)
  }

  const startEdit = () => {
    setRegion(destination?.region ?? 'us')
    setKey('')
    setFieldError({})
    setNotice(undefined)
    setEditing(true)
  }

  const save = async () => {
    if (!project || busy !== 'idle') return
    const typed = key.trim()
    // A saved key may stay as it is; a first one must be given.
    if (typed ? !AMPLITUDE_KEY.test(typed) : !destination) {
      setFieldError({ key: 'Enter the 32-character API key of your Amplitude project.' })
      return
    }
    setFieldError({})
    setNotice(undefined)
    setBusy('saving')
    try {
      const list = await analyticsDestinations.save(project, {
        region,
        ...(typed ? { key: typed } : {}),
      })
      setAnswer({ project, destination: list[0] ?? null })
      setEditing(false)
      setKey('')
      notify(
        destination ? 'Amplitude updated' : `Amplitude connected to ${chosen?.name ?? 'your app'}`,
      )
    } catch (problem) {
      const described = describeToolProblem(problem, 'amplitude-save')
      if (described.field) setFieldError({ [described.field]: described.message })
      else {
        if (described.recovery === 'reload') await load(true)
        setNotice({ problem: described, again: () => void save() })
      }
    } finally {
      setBusy('idle')
    }
  }

  const remove = async () => {
    if (!project || busy !== 'idle') return
    setNotice(undefined)
    setBusy('removing')
    try {
      const list = await analyticsDestinations.remove(project)
      setAnswer({ project, destination: list[0] ?? null })
      setConfirming(false)
      setEditing(false)
      notify(`Amplitude removed from ${chosen?.name ?? 'your app'}`)
    } catch (problem) {
      setConfirming(false)
      const described = describeToolProblem(problem, 'amplitude-remove')
      if (described.recovery === 'reload') await load(true)
      setNotice({ problem: described, again: () => void remove() })
    } finally {
      setBusy('idle')
    }
  }

  const loading = Boolean(project) && !current && !loadProblem
  const form = editing || (canChange && current && !destination)

  return (
    <section
      className="mc-panel mc-conn-stripe mc-p8-tool"
      aria-labelledby="mc-p8-amplitude"
      aria-busy={loading || busy !== 'idle'}
    >
      <div className="mc-conn-head">
        <div className="mc-conn-text">
          <h2 id="mc-p8-amplitude">Amplitude</h2>
          <p className="mc-conn-about">
            Tells Amplitude where each app install came from: the source, the campaign and the
            creator.
          </p>
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="mc-conn-note">
          Add your app as a project first, then connect Amplitude here.
        </p>
      ) : (
        <>
          {projects.length > 1 && (
            <div className="mc-field mc-p8-picker">
              <label htmlFor={pickerId}>App</label>
              <span className="mc-select-box">
                <select
                  id={pickerId}
                  value={project}
                  disabled={busy !== 'idle'}
                  onChange={(event) => choose(event.target.value)}
                >
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            </div>
          )}

          {loading && (
            <div
              className="mc-p8-loading"
              role="status"
              aria-label="Loading your Amplitude connection"
            >
              <Skeleton width="min(360px, 100%)" />
              <Skeleton width="min(240px, 70%)" />
            </div>
          )}

          {loadProblem && !current && (
            <ToolNote
              problem={loadProblem}
              onRetry={() => {
                setLoadProblem(undefined)
                void load()
              }}
              onSignIn={onSignIn}
            />
          )}

          {current && destination && !editing && (
            <AmplitudeFacts
              destination={destination}
              appName={projects.length > 1 ? null : (chosen?.name ?? null)}
              canChange={canChange}
              busy={busy}
              now={now}
              onChange={startEdit}
              onRemove={() => setConfirming(true)}
            />
          )}

          {current && !destination && !canChange && (
            <p className="mc-conn-note">
              {chosen?.name ?? 'This app'} does not send installs to Amplitude. Only a developer,
              admin or owner of {workspaceName} can connect it.
            </p>
          )}

          {current && form && canChange && (
            <form
              className="mc-p8-amp-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <AmplitudeKeyField
                value={key}
                kept={destination?.key_last4 ?? null}
                error={fieldError.key}
                onChange={(value) => {
                  setKey(value)
                  if (fieldError.key) setFieldError(({ key: _fixed, ...rest }) => rest)
                }}
              />
              <div className={fieldError.region ? 'mc-field has-error' : 'mc-field'}>
                <span className="mc-prog-caption">Data region</span>
                <Segmented<DestinationRegion>
                  label="Data region"
                  value={region}
                  options={[
                    { value: 'us', label: 'US' },
                    { value: 'eu', label: 'EU' },
                  ]}
                  onChange={setRegion}
                />
                {fieldError.region ? (
                  <p className="mc-field-error">{fieldError.region}</p>
                ) : (
                  <p className="mc-field-hint">Where your Amplitude organization keeps its data.</p>
                )}
              </div>
              {!destination && (
                <p className="mc-conn-note">Installs made before the key is saved are not sent.</p>
              )}
              <div className="mc-p8-amp-actions">
                {destination && (
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    disabled={busy !== 'idle'}
                    onClick={() => {
                      setEditing(false)
                      setFieldError({})
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" className="mc-btn mc-btn-primary" disabled={busy !== 'idle'}>
                  {busy === 'saving' ? (
                    <Busy>Saving</Busy>
                  ) : destination ? (
                    'Save'
                  ) : (
                    'Connect Amplitude'
                  )}
                </button>
              </div>
            </form>
          )}

          {notice && (
            <ToolNote problem={notice.problem} onRetry={notice.again} onSignIn={onSignIn} />
          )}
        </>
      )}

      <Dialog
        open={confirming && Boolean(destination)}
        onOpenChange={(open) => !open && busy === 'idle' && setConfirming(false)}
        title={`Remove Amplitude from ${chosen?.name ?? 'this app'}?`}
        description="KissMyApps stops sending installs to Amplitude. What Amplitude already has stays there."
      >
        <div className="mc-form-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            disabled={busy !== 'idle'}
            onClick={() => setConfirming(false)}
          >
            Keep sending
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger-solid"
            disabled={busy !== 'idle'}
            onClick={() => void remove()}
          >
            {busy === 'removing' ? <Busy>Removing</Busy> : 'Remove Amplitude'}
          </button>
        </div>
      </Dialog>
    </section>
  )
}

/** The key field. A saved key is never shown back: only its last four, and it may stay as it is. */
function AmplitudeKeyField({
  value,
  kept,
  error,
  onChange,
}: {
  value: string
  kept: string | null
  error?: string
  onChange: (value: string) => void
}) {
  const id = useId()
  const hint = kept
    ? `Leave it empty to keep the key ending in ${kept}.`
    : 'In Amplitude, open Settings, then Projects, choose this app’s project and copy its API key.'
  return (
    <div className={error ? 'mc-field has-error' : 'mc-field'}>
      <label htmlFor={id}>{kept ? 'New API key' : 'API key'}</label>
      <input
        id={id}
        className="mc-mono"
        value={value}
        maxLength={64}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="mc-field-hint">
        {hint}
      </p>
      {error && (
        <p id={`${id}-error`} className="mc-field-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Words for what the worker records as the last failure; anything else is said in general. */
const amplitudeErrors: Record<string, string> = {
  invalid_key: 'Amplitude did not accept the API key.',
  rate_limited: 'Amplitude asked KissMyApps to slow down. Sending carries on by itself.',
  unavailable: 'Amplitude did not answer. Sending carries on by itself.',
}

function amplitudeError(text: string): string {
  if (amplitudeErrors[text]) return amplitudeErrors[text]
  // A bare code says nothing to a person; a sentence from the worker is shown as it is.
  return /^[a-z0-9_:.-]+$/i.test(text) ? 'Amplitude did not accept the last send.' : text
}

const amplitudeStates: Record<AnalyticsDestination['status'], { dot: string; text: string }> = {
  active: { dot: 'mc-status-dot is-on', text: 'Sending installs' },
  paused: {
    dot: 'mc-status-dot is-warning',
    text: 'Amplitude refused this key. Paste a new one.',
  },
  failing: {
    dot: 'mc-status-dot is-warning',
    text: 'Sending is failing. KissMyApps keeps trying.',
  },
}

function AmplitudeFacts({
  destination,
  appName,
  canChange,
  busy,
  now,
  onChange,
  onRemove,
}: {
  destination: AnalyticsDestination
  /** The app's name, when there is no picker above to say it. */
  appName: string | null
  canChange: boolean
  busy: AmplitudeBusy
  now: number
  onChange: () => void
  onRemove: () => void
}) {
  const state = amplitudeStates[destination.status]
  const waiting = destination.status === 'active' && !destination.last_sent_at
  return (
    <div className="mc-p8-amp">
      <div className="mc-p8-app-head">
        <p className="mc-conn-state">
          <span className={waiting ? 'mc-status-dot' : state.dot} aria-hidden="true" />
          <span>
            {waiting
              ? 'Waiting for the first install to send'
              : destination.status === 'paused' && !canChange
                ? 'Amplitude refused this key. A developer, admin or owner can paste a new one.'
                : state.text}
            {/* Only the lines without a full stop of their own carry the app's name. */}
            {appName && (waiting || destination.status === 'active') ? ` for ${appName}` : ''}
          </span>
        </p>
        {canChange && (
          <div className="mc-p8-app-actions">
            <button
              type="button"
              className="mc-text-btn mc-conn-quiet"
              disabled={busy !== 'idle'}
              onClick={onChange}
            >
              {destination.status === 'paused' ? 'Paste a new key' : 'Change'}
            </button>
            <button
              type="button"
              className="mc-text-btn mc-conn-quiet"
              disabled={busy !== 'idle'}
              onClick={onRemove}
            >
              {busy === 'removing' ? <Busy>Removing</Busy> : 'Remove'}
            </button>
          </div>
        )}
      </div>
      <dl className="mc-conn-facts mc-p8-facts">
        <div>
          <dt>API key</dt>
          <dd className="mc-mono">
            <span className="sr-only">Ending in </span>
            <span aria-hidden="true">••••</span>
            {destination.key_last4}
          </dd>
        </div>
        <div>
          <dt>Data region</dt>
          <dd>{destination.region === 'eu' ? 'EU' : 'US'}</dd>
        </div>
        <div>
          <dt>Last sent</dt>
          <dd className="mc-num">
            {destination.last_sent_at
              ? formatWhen(
                  destination.last_sent_at,
                  Math.max(now, Date.parse(destination.last_sent_at)),
                )
              : 'Not yet'}
          </dd>
        </div>
        <div>
          <dt>Sent, 30 days</dt>
          <dd className="mc-num">{formatCount(destination.sent_30d)}</dd>
        </div>
        {destination.failed_30d > 0 && (
          <div>
            <dt>Failed, 30 days</dt>
            <dd className="mc-num">{formatCount(destination.failed_30d)}</dd>
          </div>
        )}
      </dl>
      {/* A paused card already says Amplitude refused the key. */}
      {destination.last_error && destination.status !== 'paused' && (
        <p className="mc-conn-note mc-p8-last-error">
          <span className="mc-p8-label">Last error</span> {amplitudeError(destination.last_error)}
        </p>
      )}
    </div>
  )
}
