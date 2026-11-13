import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { CreditCard, LoaderCircle, TriangleAlert } from 'lucide-react'
import {
  amountMessage,
  balance,
  balanceCurrency,
  cardExpired,
  cardExpiry,
  cardLabel,
  changedSettings,
  checkDeposit,
  defaultDeposit,
  depositBounds,
  describeProblem,
  draftFromAccount,
  entryDetail,
  entryLabel,
  feePercent,
  forgetLeaving,
  formatAmount,
  formatDayAndTime,
  formatMovement,
  formatShortDay,
  hasStarted,
  heldBackByLimit,
  meansReadOnly,
  pausedForBalance,
  readReturn,
  rememberLeaving,
  returnMessages,
  topupReason,
  validateSettings,
} from '../balance'
import type {
  BalanceAccount,
  BalanceEntry,
  BalanceProblem,
  BalanceState,
  DepositBounds,
  SettingsDraft,
  SettingsErrors,
  SettingsField,
  TopupLimit,
  TopupProblem,
} from '../balance'
import { browser, formatWhen } from '../connections'
import { formatCount } from '../format'
import { href, navigate } from '../routes'
import type { StripeOutcome } from '../routes'
import { useStore } from '../store'
import { Dialog, Field, PageHeader, Skeleton } from '../ui/Primitives'

const REFRESH_MS = 60_000
/** While a payment is on its way the page looks again this often, for about two minutes. */
const QUICK_MS = 3_000
const QUICK_TRIES = 40
const CARD_TRIES = 5
const ROWS = 10
const ROWS_MORE = 20
const PROGRAM = href({ name: 'program' })

type Busy = 'idle' | 'deposit' | 'card' | 'saving'

type Notice =
  | { tone: 'problem'; problem: BalanceProblem; again?: () => void }
  | { tone: 'news'; message: string }

export function BalanceScreen({
  deposit,
  card,
}: {
  deposit?: StripeOutcome
  card?: StripeOutcome
}) {
  const { workspace } = useStore()
  return workspace ? (
    <BalancePage
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      deposit={deposit}
      card={card}
    />
  ) : null
}

function BalancePage({
  workspaceId,
  workspaceName,
  deposit,
  card,
}: {
  workspaceId: string
  workspaceName: string
  deposit?: StripeOutcome
  card?: StripeOutcome
}) {
  const { signOut, notify, now } = useStore()
  // How Stripe's page ended, read once: the address is cleaned straight after.
  const [returned] = useState(() => readReturn({ deposit, card }))
  const [state, setState] = useState<BalanceState>()
  const [loadProblem, setLoadProblem] = useState<BalanceProblem>()
  const [busy, setBusy] = useState<Busy>('idle')
  const [adding, setAdding] = useState(false)
  const [depositProblem, setDepositProblem] = useState<BalanceProblem>()
  const [notice, setNotice] = useState<Notice | undefined>(() => {
    if (!returned) return undefined
    if (returned.outcome === 'canceled')
      return {
        tone: 'news',
        message:
          returned.what === 'card' ? returnMessages.cardCanceled : returnMessages.depositCanceled,
      }
    return returned.what === 'card' ? { tone: 'news', message: returnMessages.cardDone } : undefined
  })
  // Untouched, the form shows what is saved; it becomes a draft with the first edit.
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [errors, setErrors] = useState<SettingsErrors>({})
  // A deposit paid on Stripe that the balance has not shown yet.
  const [expecting, setExpecting] = useState(
    returned?.what === 'deposit' && returned.outcome === 'done',
  )
  const waiting = useRef(expecting)
  const announce = useRef(notify)
  useEffect(() => {
    announce.current = notify
  })
  const cardSaved = returned?.what === 'card' && returned.outcome === 'done'
  const [looks, setLooks] = useState(0)
  const [shown, setShown] = useState(ROWS)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)

  /** Shows an answer. The deposit the person just paid is announced once, when it has landed. */
  const show = useCallback((next: BalanceState) => {
    setState(next)
    setLoadProblem(undefined)
    if (!waiting.current || next.pending_topup) return
    waiting.current = false
    setExpecting(false)
    announce.current(returnMessages.depositDone)
  }, [])

  const load = useCallback(
    async (quiet = false) => {
      const run = ++latest.current
      let next: BalanceState
      try {
        next = await balance.get(workspaceId)
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return
        setLoadProblem(describeProblem(problem, 'load'))
        return
      }
      if (run !== latest.current) return
      show(next)
    },
    [workspaceId, show],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Stripe's answer leaves the address bar, so a reload does not announce it twice.
  useEffect(() => {
    forgetLeaving()
    if (deposit || card) navigate({ name: 'balance' }, true)
  }, [deposit, card])

  const pending = state?.pending_topup ?? null
  // Money on its way: paid on Stripe a moment ago, or a charge Stripe is still working on.
  const inFlight = Boolean(pending && (expecting || pending.status === 'processing'))
  const quick = inFlight ? looks < QUICK_TRIES : cardSaved && looks < CARD_TRIES
  const loaded = Boolean(state)
  useEffect(() => {
    if (!loaded || !quick || busy !== 'idle') return
    const timer = window.setInterval(() => {
      void load(true).then(() => setLooks((count) => count + 1))
    }, QUICK_MS)
    return () => window.clearInterval(timer)
  }, [loaded, quick, busy, load])

  // Commission is set aside as sales happen, so the page looks for itself now and then.
  const settled = loaded && busy === 'idle' && !adding && !quick
  useEffect(() => {
    if (!settled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [settled, load])

  // Back online: read the balance again without being asked.
  useEffect(() => {
    if (!loadProblem) return
    const retry = () => void load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [loadProblem, load])

  // Coming back from Stripe with the browser's Back button restores the page as it was left.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy('idle')
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  const adopt = (next: BalanceState) => {
    latest.current += 1
    show(next)
  }

  /** What every failed action shares. Returns the problem when it is still the caller's to show. */
  const fail = async (problem: unknown, step: 'deposit' | 'card' | 'settings') => {
    const described = describeProblem(problem, step)
    // The page no longer matched the server, so it reads the balance again and says so.
    if (described.recovery === 'reload') {
      setAdding(false)
      await load(true)
      setNotice({ tone: 'news', message: described.message })
      return null
    }
    // The server knows better than the page whether this person may manage the balance.
    if (meansReadOnly(described)) {
      setAdding(false)
      setState((current) => current && { ...current, can_manage: false })
      setNotice({ tone: 'problem', problem: described })
      return null
    }
    return described
  }

  /** Asks for Stripe's payment page and goes there. Nothing is charged before the person pays. */
  const addFunds = async (amountMinor: number) => {
    if (busy !== 'idle') return
    setDepositProblem(undefined)
    setNotice(undefined)
    setBusy('deposit')
    try {
      const address = await balance.deposit(workspaceId, amountMinor)
      rememberLeaving('deposit')
      // The button keeps saying "Opening Stripe" until the browser has left.
      browser.leaveFor(address)
    } catch (problem) {
      setDepositProblem((await fail(problem, 'deposit')) ?? undefined)
      setBusy('idle')
    }
  }

  const changeCard = async () => {
    if (busy !== 'idle') return
    setNotice(undefined)
    setBusy('card')
    try {
      const address = await balance.changeCard(workspaceId)
      rememberLeaving('card')
      browser.leaveFor(address)
    } catch (problem) {
      const described = await fail(problem, 'card')
      if (described)
        setNotice({
          tone: 'problem',
          problem: described,
          again: described.recovery === 'retry' ? () => void changeCard() : undefined,
        })
      setBusy('idle')
    }
  }

  const account = state?.account ?? null
  const form = draft ?? (account ? draftFromAccount(account) : null)
  const changes = form && account ? changedSettings(form, account) : null
  const currency = state ? balanceCurrency(state) : 'USD'

  const saveSettings = async () => {
    if (busy !== 'idle' || !form || !account) return
    const found = validateSettings(form, currency)
    setErrors(found)
    if (Object.keys(found).length || !changes) return
    setNotice(undefined)
    setBusy('saving')
    try {
      adopt(await balance.saveSettings(workspaceId, changes))
      setDraft(null)
      notify('Top-up settings saved')
    } catch (problem) {
      const described = await fail(problem, 'settings')
      if (described?.field && described.field !== 'amount')
        setErrors({ [described.field]: described.message })
      else if (described)
        setNotice({
          tone: 'problem',
          problem: described,
          again: described.recovery === 'retry' ? () => void saveSettings() : undefined,
        })
    } finally {
      setBusy('idle')
    }
  }

  const edit = (change: Partial<SettingsDraft>, field?: SettingsField) => {
    if (!form) return
    setDraft({ ...form, ...change })
    if (field && errors[field]) setErrors(({ [field]: _fixed, ...rest }) => rest)
  }

  const program = state?.enabled ? state.program : null
  const canManage = Boolean(state?.can_manage)
  const started = Boolean(state && hasStarted(state))
  const paused = pausedForBalance(program)
  const failed = account?.topup_problem ?? null
  const limit = heldBackByLimit(account ?? null)
  const attention = paused || Boolean(failed) || Boolean(limit)
  const idle = busy === 'idle'
  const bounds = state ? depositBounds(state) : null
  const openDialog = () => {
    setDepositProblem(undefined)
    setAdding(true)
  }

  return (
    <div className="mc-page mc-bal">
      <PageHeader
        title="Balance"
        description="The money your creators are paid from."
        actions={
          program &&
          started &&
          canManage &&
          !attention && (
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={!idle}
              onClick={openDialog}
            >
              Add funds
            </button>
          )
        }
      />

      {!state && !loadProblem && <Loading />}

      {loadProblem && !state && (
        <section className="mc-panel" aria-label="Balance">
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

      {state && !state.enabled && (
        <section className="mc-panel" aria-label="Balance">
          <p className="mc-bal-none">
            Balances are not switched on yet. There is nothing you need to do here.
          </p>
        </section>
      )}

      {state?.enabled && !program && (
        <section className="mc-panel" aria-label="Balance">
          <p className="mc-bal-none">
            {workspaceName} has no affiliate program yet.{' '}
            <a className="mc-link" href={PROGRAM}>
              {canManage ? 'Set up your program' : 'Open Program'}
            </a>
          </p>
        </section>
      )}

      {state && program && bounds && (
        <>
          {attention && (
            <Attention
              paused={paused}
              failed={failed}
              limit={limit}
              canManage={canManage}
              busy={busy}
              onAddFunds={started ? openDialog : undefined}
              onChangeCard={started && failed ? () => void changeCard() : undefined}
            />
          )}

          {inFlight && pending && (
            <p className="mc-bal-note mc-bal-wait" role="status">
              <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />
              <span className="mc-num">
                {formatAmount(pending.amount_minor, currency)} is on its way to your balance. This
                usually takes a few seconds.
              </span>
            </p>
          )}

          {notice?.tone === 'problem' && (
            <Problem
              problem={notice.problem}
              onRetry={notice.again}
              onSignIn={() => void signOut()}
            />
          )}
          {notice?.tone === 'news' && (
            <p className="mc-bal-note" role="status">
              {notice.message}
            </p>
          )}

          {!started && (
            <FirstDeposit
              state={state}
              bounds={bounds}
              currency={currency}
              canManage={canManage}
              workspaceName={workspaceName}
              busy={busy}
              problem={depositProblem}
              onEdit={() => setDepositProblem(undefined)}
              onSubmit={(amount) => void addFunds(amount)}
              onSignIn={() => void signOut()}
            />
          )}

          {started && account && form && (
            <>
              <Summary account={account} feeBps={state.fee_bps} />

              {!canManage && (
                <p className="mc-bal-note">
                  Only an owner or admin of {workspaceName} can add funds or change these settings.
                </p>
              )}

              <div className="mc-bal-layout">
                <Settings
                  account={account}
                  form={form}
                  errors={errors}
                  dirty={Boolean(changes)}
                  canManage={canManage}
                  busy={busy}
                  now={now}
                  onEdit={edit}
                  onSave={() => void saveSettings()}
                  onChangeCard={() => void changeCard()}
                />
                <Activity
                  entries={state.activity}
                  currency={currency}
                  shown={shown}
                  now={now}
                  onMore={() => setShown((count) => count + ROWS_MORE)}
                />
              </div>
            </>
          )}

          <Dialog
            open={adding}
            onOpenChange={(next) => !next && idle && setAdding(false)}
            title="Add funds"
            description="You pay by card on Stripe. The card is saved for automatic top-ups."
          >
            <DepositForm
              start={defaultDeposit(state)}
              bounds={bounds}
              currency={currency}
              busy={busy}
              problem={depositProblem}
              onEdit={() => setDepositProblem(undefined)}
              onSubmit={(amount) => void addFunds(amount)}
              onCancel={() => setAdding(false)}
              onSignIn={() => void signOut()}
            />
          </Dialog>
        </>
      )}
    </div>
  )
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** A failure where it happened, with the one thing that gets past it. */
function Problem({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: BalanceProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-bal-problem" role="alert">
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

/**
 * What needs the merchant now: a program paused for its balance, a top-up that failed, a
 * top-up held back by the day's limit, or several of these.
 */
function Attention({
  paused,
  failed,
  limit,
  canManage,
  busy,
  onAddFunds,
  onChangeCard,
}: {
  paused: boolean
  failed: TopupProblem | null
  limit: TopupLimit | null
  canManage: boolean
  busy: Busy
  onAddFunds?: () => void
  onChangeCard?: () => void
}) {
  const idle = busy === 'idle'
  return (
    <div className="mc-bal-alert" role="status">
      <div className="mc-bal-alert-text">
        {paused && (
          <p>
            <strong>Your program is paused.</strong> The balance could not cover a commission, so
            new sales earn creators nothing. Add funds and it goes live again.
          </p>
        )}
        {failed && (
          <p className="mc-num">
            {paused ? 'The automatic top-up' : <strong>Automatic top-up failed</strong>}
            {failed.failed_at ? ` on ${formatShortDay(failed.failed_at)}` : ''}
            {paused ? ' failed' : ''}: {topupReason(failed.code)}.{' '}
            {failed.retry_at
              ? `We will try again on ${formatShortDay(failed.retry_at)}.`
              : 'We will not try again until you add funds or change your card.'}
          </p>
        )}
        {limit && (
          <p className="mc-num">
            {paused || failed ? (
              'Automatic top-up is also waiting'
            ) : (
              <strong>Automatic top-up is waiting</strong>
            )}
            : your card was charged {limit.per_day} times in 24 hours, the most we charge
            automatically.{' '}
            {limit.resumes_at ? `It starts again at ${formatDayAndTime(limit.resumes_at)}. ` : ''}
            Add funds yourself until then, or raise the top-up amount so each one lasts longer.
          </p>
        )}
      </div>
      {canManage && (onAddFunds || onChangeCard) && (
        <div className="mc-bal-alert-actions">
          {onChangeCard && (
            <button
              type="button"
              className="mc-btn mc-btn-quiet"
              disabled={!idle}
              onClick={onChangeCard}
            >
              {busy === 'card' ? <Working>Opening Stripe</Working> : 'Change card'}
            </button>
          )}
          {onAddFunds && (
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={!idle}
              onClick={onAddFunds}
            >
              Add funds
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The amount, and the button that goes to Stripe's page to pay it. */
function DepositForm({
  start,
  bounds,
  currency,
  busy,
  problem,
  onEdit,
  onSubmit,
  onCancel,
  onSignIn,
}: {
  start: string
  bounds: DepositBounds
  currency: string
  busy: Busy
  problem?: BalanceProblem
  onEdit: () => void
  onSubmit: (amountMinor: number) => void
  onCancel?: () => void
  onSignIn: () => void
}) {
  const [typed, setTyped] = useState(start)
  const [refusal, setRefusal] = useState<string>()
  const dollars = currency === 'USD'
  const error =
    refusal ?? (problem?.field === 'amount' ? amountMessage(bounds, currency) : undefined)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy !== 'idle') return
    const checked = checkDeposit(typed, bounds, currency)
    if ('error' in checked) {
      setRefusal(checked.error)
      return
    }
    onSubmit(checked.minor)
  }

  return (
    <form className="mc-form-stack mc-bal-deposit" noValidate onSubmit={submit}>
      <Field
        label="Amount"
        hint={`Minimum ${formatAmount(bounds.min_minor, currency)}`}
        error={error}
      >
        {(props) => (
          <div className={dollars ? 'mc-affix is-prefix' : 'mc-affix'}>
            {dollars && <span aria-hidden="true">$</span>}
            <input
              {...props}
              inputMode="decimal"
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
                setRefusal(undefined)
                if (problem) onEdit()
              }}
            />
            {!dollars && <span aria-hidden="true">{currency}</span>}
          </div>
        )}
      </Field>
      {problem && !problem.field && <Problem problem={problem} onSignIn={onSignIn} />}
      <div className="mc-form-actions">
        {onCancel && (
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            disabled={busy !== 'idle'}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        <button type="submit" className="mc-btn mc-btn-primary" disabled={busy !== 'idle'}>
          {busy === 'deposit' ? <Working>Opening Stripe</Working> : 'Continue to payment'}
        </button>
      </div>
    </form>
  )
}

/** Before any money has arrived, the page is the first deposit. */
function FirstDeposit({
  state,
  bounds,
  currency,
  canManage,
  workspaceName,
  busy,
  problem,
  onEdit,
  onSubmit,
  onSignIn,
}: {
  state: BalanceState
  bounds: DepositBounds
  currency: string
  canManage: boolean
  workspaceName: string
  busy: Busy
  problem?: BalanceProblem
  onEdit: () => void
  onSubmit: (amountMinor: number) => void
  onSignIn: () => void
}) {
  const id = useId()
  const fee = feePercent(state.fee_bps)
  return (
    <section className="mc-panel mc-bal-first" aria-labelledby={id}>
      <div className="mc-bal-first-text">
        <h2 id={id}>Make your first deposit</h2>
        <p>
          Commission is set aside from your balance when a sale happens, and creators are paid only
          from it.{fee ? ` KissMyApps adds a ${fee} fee on top of each commission.` : ''}
        </p>
        {canManage && <p>You pay by card on Stripe. The card is saved for automatic top-ups.</p>}
      </div>
      {canManage ? (
        <DepositForm
          start={defaultDeposit(state)}
          bounds={bounds}
          currency={currency}
          busy={busy}
          problem={problem}
          onEdit={onEdit}
          onSubmit={onSubmit}
          onSignIn={onSignIn}
        />
      ) : (
        <p className="mc-bal-none">
          An owner or admin of {workspaceName} can make the first deposit.
        </p>
      )}
    </section>
  )
}

/** Where the money stands: what is free, what is set aside, what creators have earned, the fee. */
function Summary({ account, feeBps }: { account: BalanceAccount; feeBps: number | null }) {
  const fee = feePercent(feeBps)
  const figures = [
    {
      label: 'Reserved',
      value: account.reserved_minor,
      about: 'For sales still in their hold',
    },
    {
      label: 'Approved for creators',
      value: account.creators_approved_minor,
      about: 'Past the hold and owed to them',
    },
    {
      label: 'KissMyApps fees',
      value: account.fees_minor,
      about: fee ? `${fee} on top of each commission` : 'On top of each commission',
    },
  ]
  return (
    <section className="mc-bal-summary" aria-label="Your balance">
      <dl>
        <div className="mc-bal-figure is-lead">
          <dt>Available</dt>
          <dd
            className={
              account.available_minor < 0
                ? 'mc-bal-value mc-num is-negative'
                : 'mc-bal-value mc-num'
            }
          >
            {formatAmount(account.available_minor, account.currency)}
          </dd>
          <dd className="mc-bal-about">Ready for new commissions</dd>
        </div>
        {figures.map((figure) => (
          <div className="mc-bal-figure" key={figure.label}>
            <dt>{figure.label}</dt>
            <dd className="mc-bal-value mc-num">{formatAmount(figure.value, account.currency)}</dd>
            <dd className="mc-bal-about">{figure.about}</dd>
          </div>
        ))}
      </dl>
      <p className="mc-bal-rule">
        Commission is set aside when a sale happens, and creators are paid only from this balance.
      </p>
    </section>
  )
}

/** The saved card, and the rule that keeps the balance from running out. */
function Settings({
  account,
  form,
  errors,
  dirty,
  canManage,
  busy,
  now,
  onEdit,
  onSave,
  onChangeCard,
}: {
  account: BalanceAccount
  form: SettingsDraft
  errors: SettingsErrors
  dirty: boolean
  canManage: boolean
  busy: Busy
  now: number
  onEdit: (change: Partial<SettingsDraft>, field?: SettingsField) => void
  onSave: () => void
  onChangeCard: () => void
}) {
  const id = useId()
  const card = account.card
  const expiry = card ? cardExpiry(card) : null
  const expired = card ? cardExpired(card, now) : false
  const idle = busy === 'idle'
  const dollars = account.currency === 'USD'
  const problems = [errors.minBalance, errors.topupAmount].filter(Boolean)

  const money = (field: SettingsField, label: string) => (
    <span
      className={[
        'mc-bal-money',
        dollars ? 'is-prefix' : '',
        errors[field] ? 'has-error' : '',
      ].join(' ')}
    >
      {dollars && <span aria-hidden="true">$</span>}
      <input
        aria-label={label}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={errors[field] ? `${id}-errors` : undefined}
        inputMode="decimal"
        autoComplete="off"
        value={form[field]}
        onChange={(event) => onEdit({ [field]: event.target.value }, field)}
      />
      {!dollars && <span aria-hidden="true">{account.currency}</span>}
    </span>
  )

  return (
    <section className="mc-panel mc-bal-settings" aria-labelledby={id}>
      <div className="mc-panel-head">
        <h2 id={id}>Card and automatic top-up</h2>
      </div>

      <div className="mc-bal-card">
        <CreditCard size={18} aria-hidden="true" />
        <div className="mc-bal-card-text">
          {card ? (
            <>
              <strong className="mc-num">{cardLabel(card)}</strong>
              {expiry && (
                <span className={expired ? 'mc-sub mc-num mc-warning-text' : 'mc-sub mc-num'}>
                  {expired ? 'Expired' : 'Expires'} {expiry}
                </span>
              )}
            </>
          ) : (
            <span className="mc-muted">No card saved</span>
          )}
        </div>
        {canManage && (
          <button
            type="button"
            className="mc-btn mc-btn-quiet"
            disabled={!idle}
            onClick={onChangeCard}
          >
            {busy === 'card' ? (
              <Working>Opening Stripe</Working>
            ) : card ? (
              'Change card'
            ) : (
              'Add card'
            )}
          </button>
        )}
      </div>

      {canManage ? (
        <form
          className="mc-bal-topup"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <label className="mc-bal-toggle">
            <span>Automatic top-up</span>
            <span className="mc-switch">
              <input
                type="checkbox"
                role="switch"
                checked={form.autoTopup}
                disabled={!idle || (!card && !form.autoTopup)}
                onChange={(event) => onEdit({ autoTopup: event.target.checked })}
              />
              <span aria-hidden="true" className="mc-switch-track" />
            </span>
          </label>
          {!card && !form.autoTopup && (
            <p className="mc-bal-hint">Add a card to turn on automatic top-up.</p>
          )}
          {form.autoTopup && (
            <div className="mc-bal-sentence">
              <label>
                <span>When the balance falls below</span>
                {money('minBalance', 'When the balance falls below')}
              </label>
              <label>
                <span>add</span>
                {money('topupAmount', 'Amount to add')}
              </label>
            </div>
          )}
          {problems.length > 0 && (
            <div id={`${id}-errors`} className="mc-bal-errors">
              {problems.map((message) => (
                <p key={message} className="mc-field-error">
                  {message}
                </p>
              ))}
            </div>
          )}
          <div className="mc-form-actions">
            <button type="submit" className="mc-btn mc-btn-secondary" disabled={!idle || !dirty}>
              {busy === 'saving' ? <Working>Saving</Working> : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <p className="mc-bal-readonly mc-num">
          {account.auto_topup
            ? `Automatic top-up is on. When the balance falls below ${formatAmount(account.min_balance_minor, account.currency)}, ${formatAmount(account.topup_amount_minor, account.currency)} is added.`
            : 'Automatic top-up is off.'}
        </p>
      )}
    </section>
  )
}

/** Every movement of the balance, newest first, each with the balance it left. */
function Activity({
  entries,
  currency,
  shown,
  now,
  onMore,
}: {
  entries: BalanceEntry[]
  currency: string
  shown: number
  now: number
  onMore: () => void
}) {
  const id = useId()
  const rows = entries.slice(0, shown)
  return (
    <section className="mc-panel mc-panel-flush mc-bal-activity" aria-labelledby={id}>
      <div className="mc-panel-head is-padded">
        <h2 id={id}>Activity</h2>
      </div>
      {rows.length === 0 ? (
        <p className="mc-empty-line">
          Nothing has moved yet. Deposits and commissions appear here.
        </p>
      ) : (
        <table className="mc-table mc-bal-table">
          <thead>
            <tr>
              <th scope="col">Entry</th>
              <th scope="col">Date</th>
              <th scope="col" className="mc-num-col">
                Amount
              </th>
              <th scope="col" className="mc-num-col">
                Balance after
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const detail = entryDetail(entry, currency)
              return (
                <tr key={entry.id}>
                  <td>
                    <strong>{entryLabel(entry)}</strong>
                    {detail && <span className="mc-sub mc-num">{detail}</span>}
                  </td>
                  <td className="mc-bal-when mc-num">
                    {entry.created_at ? (
                      formatWhen(entry.created_at, Math.max(now, Date.parse(entry.created_at)))
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td
                    className={
                      entry.amount_minor > 0
                        ? 'mc-num-col mc-num mc-bal-amount is-positive'
                        : 'mc-num-col mc-num mc-bal-amount'
                    }
                  >
                    {formatMovement(entry.amount_minor, currency)}
                  </td>
                  <td className="mc-num-col mc-num mc-bal-after">
                    {entry.available_after_minor === null ? (
                      <Dash />
                    ) : (
                      <>
                        <span className="mc-bal-after-label">Balance </span>
                        {formatAmount(entry.available_after_minor, currency)}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {entries.length > rows.length && (
        <div className="mc-list-foot mc-bal-more">
          <span className="mc-muted mc-num">
            Showing {formatCount(rows.length)} of the latest {formatCount(entries.length)}
          </span>
          <button type="button" className="mc-btn mc-btn-secondary" onClick={onMore}>
            Show more
          </button>
        </div>
      )}
    </section>
  )
}

/** A value the ledger did not send. */
function Dash() {
  return (
    <span className="mc-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not known</span>
    </span>
  )
}

function Loading() {
  return (
    <div className="mc-bal-loading" role="status" aria-label="Loading your balance">
      <div className="mc-bal-summary">
        <dl>
          {['Available', 'Reserved', 'Approved for creators', 'KissMyApps fees'].map(
            (label, index) => (
              <div className={index ? 'mc-bal-figure' : 'mc-bal-figure is-lead'} key={label}>
                <dt>{label}</dt>
                <dd className="mc-bal-value">
                  <Skeleton width={index ? 96 : 132} height={index ? 26 : 32} />
                </dd>
                <dd className="mc-bal-about">
                  <Skeleton width="min(160px, 80%)" />
                </dd>
              </div>
            ),
          )}
        </dl>
      </div>
      <div className="mc-bal-layout">
        <div className="mc-panel mc-bal-settings">
          <Skeleton width={200} height={18} />
          <Skeleton width="100%" height={44} />
          <Skeleton width="70%" />
        </div>
        <div className="mc-panel mc-bal-activity">
          <Skeleton width={80} height={18} />
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} width="100%" height={36} />
          ))}
        </div>
      </div>
    </div>
  )
}
