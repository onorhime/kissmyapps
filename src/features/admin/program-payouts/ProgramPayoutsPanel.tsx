import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { StatusNotice } from '../../../components/ActionNotice'
import { Dialog } from '../../../components/Dialog'
import { depositField, depositLabel, depositToMinor, moneyByCurrency } from '../api/programMoney'
import type { AdminMoneyByCurrency } from '../api/programMoney'
import type { AdminDataError, AdminDataResult, AdminGateway, AdminRole } from '../api/types'
import {
  BLOCKER_WORDS,
  PAYOUT_MONEY_OFF,
  PAYOUT_NO_PLATFORM,
  creatorName,
  currenciesOf,
  openPayoutWords,
  payoutDate,
  payoutFailureWords,
  payoutMoney,
} from './api'
import type {
  AdminClosedPayout,
  AdminOpenPayout,
  AdminPayoutCreator,
  AdminProgramPayouts,
} from './api'
import './ProgramPayouts.css'

/**
 * Program payouts on the admin Payouts page: who can be paid and how much, what is on its way
 * and what was paid. Nothing is paid by itself: an Owner or Finance admin presses Pay, reads
 * exactly what will be sent and confirms it. Only the Owner switches payouts on or off and sets
 * the smallest payout.
 */

type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; payouts: AdminProgramPayouts }
  /** The functions are not in this deployment. */
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'error' }

type PayoutsResult = AdminDataResult<AdminProgramPayouts | null>

type Confirming =
  | { kind: 'pay'; creator: AdminPayoutCreator }
  | { kind: 'pay_ready'; currency: string; creators: readonly AdminPayoutCreator[]; total: number }
  | { kind: 'cancel'; payout: AdminOpenPayout }
  | { kind: 'switch'; to: boolean }

type ActionKind = 'pay' | 'cancel' | 'settings'

const thrown: PayoutsResult = {
  data: null,
  status: 'error',
  error: {
    code: 'temporarily_unavailable',
    message: 'Program payouts are temporarily unavailable.',
    retryable: true,
  },
}

const UNAVAILABLE = 'Program payouts are not available in this deployment.'
const MIN_ERROR = 'Enter an amount from 1.00 to 1,000,000.00, for example 25.'
const LIST_SHOWN = 6

function failureMessage(error: AdminDataError | null, kind: ActionKind): string {
  const code = error?.code
  if (code === 'not_authenticated' || code === 'not_authorized') {
    return kind === 'settings'
      ? 'This change was not authorized. Sign in again as the Owner and retry.'
      : kind === 'pay'
        ? 'Paying was not authorized, so nothing was sent. Sign in again as an Owner or Finance admin and retry.'
        : 'Canceling was not authorized, so nothing changed. Sign in again as an Owner or Finance admin and retry.'
  }
  if (code === 'not_configured' || code === 'contract_unavailable') return UNAVAILABLE
  if (error && (code === 'conflict' || code === 'invalid_state' || code === 'invalid_input')) {
    return error.message
  }
  // No answer is not a no: the list is read again so the admin sees what really happened.
  if (kind === 'pay') {
    return 'Paying could not be confirmed. The list was reloaded: check On its way before paying again.'
  }
  if (kind === 'cancel') {
    return 'Canceling could not be confirmed. The list was reloaded: check it before trying again.'
  }
  return 'That change did not go through. Nothing was saved. Try again.'
}

/** After these the list on screen is still what the database holds. */
const leavesListAsItWas = (error: AdminDataError | null) =>
  error?.code === 'not_authenticated' ||
  error?.code === 'not_authorized' ||
  error?.code === 'not_configured' ||
  error?.code === 'contract_unavailable' ||
  error?.code === 'invalid_input'

const people = (count: number) =>
  `${count.toLocaleString('en-US')} creator${count === 1 ? '' : 's'}`

export function ProgramPayoutsPanel({
  gateway,
  role,
  reloadKey = 0,
}: {
  gateway: AdminGateway
  role: AdminRole
  /** Changes when the page is refreshed, so this panel reads again too. */
  reloadKey?: number
}) {
  const canPay = role === 'owner' || role === 'finance'
  const canConfigure = role === 'owner'
  const read = gateway.getProgramPayouts
  const perform = gateway.performProgramPayout
  const configure = gateway.configureProgramPayouts
  const [state, setState] = useState<PanelState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [draft, setDraft] = useState({ scope: '', value: '' })
  const [minError, setMinError] = useState<string | null>(null)
  const minInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!read) return
    let current = true
    void read()
      .catch(() => thrown)
      .then((result) => {
        if (!current) return
        if (result.status === 'ready' && result.data) {
          setState({ status: 'ready', payouts: result.data })
        } else if (
          result.status === 'unconfigured' ||
          result.error?.code === 'contract_unavailable' ||
          result.error?.code === 'not_configured'
        ) {
          setState({ status: 'unavailable' })
        } else if (result.status === 'unauthorized') {
          setState({ status: 'unauthorized' })
        } else {
          setState({ status: 'error' })
        }
      })
    return () => {
      current = false
    }
  }, [read, attempt, reloadKey])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  // An older gateway has no program payouts at all: the page stays as it was.
  if (!read || !perform || !configure) return null

  const payouts = state.status === 'ready' ? state.payouts : null
  // What was typed is kept only for the saved number it was typed against.
  const minScope = payouts ? String(payouts.minPayoutMinor) : ''
  const minValue =
    draft.scope === minScope ? draft.value : payouts ? depositField(payouts.minPayoutMinor) : ''

  async function act(
    kind: ActionKind,
    send: () => Promise<PayoutsResult>,
    done: string,
  ): Promise<boolean> {
    if (pending) return false
    setPending(true)
    setSuccess(null)
    setFailure(null)
    let result: PayoutsResult
    try {
      result = await send()
    } catch {
      result = thrown
    }
    setPending(false)
    setConfirming(null)
    if (result.status === 'ready' && result.data) {
      setState({ status: 'ready', payouts: result.data })
      setSuccess(done)
      return true
    }
    setFailure(failureMessage(result.error, kind))
    // A refusal means the list is out of date, and a lost answer may still have gone through.
    if (!leavesListAsItWas(result.error)) setAttempt((value) => value + 1)
    return false
  }

  function saveSmallest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!payouts || !configure) return
    const minor = depositToMinor(minValue)
    if (minor === null) {
      setMinError(MIN_ERROR)
      queueMicrotask(() => minInput.current?.focus())
      return
    }
    void act(
      'settings',
      () =>
        configure({
          enabled: payouts.enabled,
          minPayoutMinor: minor,
          expectedUpdatedAt: payouts.updatedAt,
        }),
      'Smallest payout saved.',
    )
  }

  return (
    <section
      className="admin-panel admin-pp"
      aria-labelledby="admin-program-payouts"
      aria-busy={state.status === 'loading'}
    >
      <div className="admin-pp-head">
        <div>
          <h2 id="admin-program-payouts">Program payouts</h2>
          <p>
            Pay creators what their programs have approved. Nothing is paid until you press Pay.
          </p>
        </div>
        {payouts && (
          <span
            className={`admin-settings-status admin-settings-status-${payouts.enabled ? 'enabled' : 'disabled'}`}
          >
            <span aria-hidden="true" />
            {payouts.enabled ? 'On' : 'Off'}
          </span>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="admin-pp-line" role="status">
          <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
          Loading program payouts
        </p>
      )}

      {state.status === 'unavailable' && <p className="admin-pp-line">{UNAVAILABLE}</p>}

      {state.status === 'unauthorized' && (
        <p className="admin-pp-line">Your admin role cannot see program payouts. Ask the Owner.</p>
      )}

      {state.status === 'error' && (
        <div className="admin-pp-problem" role="alert">
          <p>
            <strong>Program payouts did not load.</strong> Nothing was paid or changed.
          </p>
          <button className="admin-pp-btn" type="button" onClick={retry}>
            <RefreshCw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      {payouts && (
        <Loaded
          payouts={payouts}
          canPay={canPay}
          canConfigure={canConfigure}
          pending={pending}
          onConfirm={(next) => {
            setSuccess(null)
            setFailure(null)
            setConfirming(next)
          }}
          settings={
            canConfigure ? (
              <SmallestPayout
                value={minValue}
                unchanged={depositToMinor(minValue) === payouts.minPayoutMinor}
                error={minError}
                input={minInput}
                busy={pending && confirming === null}
                disabled={pending}
                onEdit={(value) => {
                  setDraft({ scope: minScope, value })
                  setMinError(null)
                  setSuccess(null)
                  setFailure(null)
                }}
                onSave={saveSmallest}
              />
            ) : null
          }
        />
      )}

      {payouts && confirming?.kind === 'pay' && (
        <Confirm
          title={`Pay ${creatorName(confirming.creator.name)}`}
          description="Check the amount before you send it."
          busy={pending}
          onCancel={() => setConfirming(null)}
        >
          <p className="admin-pp-sum">
            <strong>
              {payoutMoney(confirming.creator.payableMinor, confirming.creator.currency)}
            </strong>{' '}
            to {creatorName(confirming.creator.name)}
          </p>
          {confirming.creator.programs.length > 1 && (
            <ul className="admin-pp-breakdown">
              {confirming.creator.programs.map((program) => (
                <li key={program.programId}>
                  <span>{program.name || 'Program'}</span>
                  <span>{payoutMoney(program.amountMinor, confirming.creator.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="admin-pp-warning">
            You can cancel until it starts sending. After that it cannot be taken back.
          </p>
          <ConfirmActions
            busy={pending}
            confirm={`Pay ${payoutMoney(confirming.creator.payableMinor, confirming.creator.currency)}`}
            busyLabel="Paying…"
            dismiss="Cancel"
            onDismiss={() => setConfirming(null)}
            onConfirm={() => {
              const { creator } = confirming
              const amount = payoutMoney(creator.payableMinor, creator.currency)
              void act(
                'pay',
                () =>
                  perform({
                    action: 'pay',
                    affiliateId: creator.affiliateId,
                    currency: creator.currency,
                    expectedAmountMinor: creator.payableMinor,
                  }),
                `${amount} to ${creatorName(creator.name)} is on its way.`,
              )
            }}
          />
        </Confirm>
      )}

      {payouts && confirming?.kind === 'pay_ready' && (
        <Confirm
          title="Pay all ready"
          description="Check the count and the total before you send them."
          busy={pending}
          onCancel={() => setConfirming(null)}
        >
          <p className="admin-pp-sum">
            <strong>{payoutMoney(confirming.total, confirming.currency)}</strong> to{' '}
            {people(confirming.creators.length)}
          </p>
          <ul className="admin-pp-breakdown">
            {confirming.creators.slice(0, LIST_SHOWN).map((creator) => (
              <li key={creator.affiliateId}>
                <span>{creatorName(creator.name)}</span>
                <span>{payoutMoney(creator.payableMinor, creator.currency)}</span>
              </li>
            ))}
            {confirming.creators.length > LIST_SHOWN && (
              <li className="admin-pp-breakdown-more">
                <span>and {confirming.creators.length - LIST_SHOWN} more</span>
              </li>
            )}
          </ul>
          <p className="admin-pp-warning">
            You can cancel each one until it starts sending. After that it cannot be taken back.
          </p>
          <ConfirmActions
            busy={pending}
            confirm={`Pay ${people(confirming.creators.length)} ${payoutMoney(confirming.total, confirming.currency)}`}
            busyLabel="Paying…"
            dismiss="Cancel"
            onDismiss={() => setConfirming(null)}
            onConfirm={() => {
              const { currency, creators, total } = confirming
              void act(
                'pay',
                () =>
                  perform({
                    action: 'pay_ready',
                    currency,
                    expectedCount: creators.length,
                    expectedTotalMinor: total,
                  }),
                `${payoutMoney(total, currency)} to ${people(creators.length)} is on its way.`,
              )
            }}
          />
        </Confirm>
      )}

      {payouts && confirming?.kind === 'cancel' && (
        <Confirm
          title="Cancel this payout"
          description="It has not started sending, so it can still be stopped."
          busy={pending}
          onCancel={() => setConfirming(null)}
        >
          <p className="admin-pp-sum">
            <strong>
              {payoutMoney(confirming.payout.amountMinor, confirming.payout.currency)}
            </strong>{' '}
            to {creatorName(confirming.payout.name)}
          </p>
          <p className="admin-pp-warning">
            The money goes back to what the creator is owed. You can pay it again later.
          </p>
          <ConfirmActions
            busy={pending}
            danger
            confirm="Cancel payout"
            busyLabel="Canceling…"
            dismiss="Keep payout"
            onDismiss={() => setConfirming(null)}
            onConfirm={() => {
              const { payout } = confirming
              void act(
                'cancel',
                () => perform({ action: 'cancel', payoutId: payout.id }),
                `Payout to ${creatorName(payout.name)} canceled. ${payoutMoney(payout.amountMinor, payout.currency)} is back in what they are owed.`,
              )
            }}
          />
        </Confirm>
      )}

      {payouts && confirming?.kind === 'switch' && (
        <Confirm
          title={confirming.to ? 'Switch on payouts' : 'Switch off payouts'}
          description={
            confirming.to
              ? 'Review what this allows before switching it on.'
              : 'Review what stops before switching it off.'
          }
          busy={pending}
          onCancel={() => setConfirming(null)}
        >
          {confirming.to ? (
            <p className="admin-pp-warning">
              Owner and Finance admins will be able to pay creators from this page, and creators can
              set up a payout account. Nothing is paid by itself. The smallest payout is{' '}
              {depositLabel(payouts.minPayoutMinor)} in the program’s currency.
            </p>
          ) : (
            <p className="admin-pp-warning">
              No one can be paid while this is off, and payouts already on their way wait until it
              is switched on again. What creators are owed is kept.
            </p>
          )}
          <ConfirmActions
            busy={pending}
            danger={!confirming.to}
            confirm={confirming.to ? 'Switch on' : 'Switch off'}
            busyLabel={confirming.to ? 'Switching on…' : 'Switching off…'}
            dismiss="Cancel"
            onDismiss={() => setConfirming(null)}
            onConfirm={() => {
              const { to } = confirming
              void act(
                'settings',
                () =>
                  configure({
                    enabled: to,
                    minPayoutMinor: payouts.minPayoutMinor,
                    expectedUpdatedAt: payouts.updatedAt,
                  }),
                to ? 'Payouts switched on.' : 'Payouts switched off.',
              )
            }}
          />
        </Confirm>
      )}

      <StatusNotice success={success} error={failure} />
    </section>
  )
}

function Loaded({
  payouts,
  canPay,
  canConfigure,
  pending,
  onConfirm,
  settings,
}: {
  payouts: AdminProgramPayouts
  canPay: boolean
  canConfigure: boolean
  pending: boolean
  onConfirm: (next: Confirming) => void
  settings: ReactNode
}) {
  const ready = payouts.creators.filter((creator) => creator.blocker === null)
  const waiting = payouts.creators.filter((creator) => creator.blocker !== null)
  const nothing = payouts.creators.length + payouts.open.length + payouts.recent.length === 0
  const readyCurrencies = currenciesOf(ready)
  // One "pay all" per currency: amounts in different currencies are never added together.
  const batches = readyCurrencies
    .map((currency) => {
      const creators = ready.filter((creator) => creator.currency === currency)
      return {
        currency,
        creators,
        total: creators.reduce((sum, creator) => sum + creator.payableMinor, 0),
      }
    })
    .filter((batch) => batch.creators.length > 1)
  const platformNotReady = Boolean(
    payouts.enabled &&
    payouts.platform &&
    !(payouts.platform.registered && payouts.platform.enabled),
  )
  const cannotSwitchOn = !payouts.moneyEnabled
    ? PAYOUT_MONEY_OFF
    : !payouts.platform
      ? PAYOUT_NO_PLATFORM
      : null
  const returned = payouts.recent.some((payout) => payout.status !== 'paid')

  return (
    <>
      {!payouts.enabled && (
        <div className="admin-pp-off" role="note">
          <p>
            <strong>Payouts are off.</strong>{' '}
            {canConfigure
              ? (cannotSwitchOn ?? 'No one can be paid until you switch them on.')
              : 'Only the Owner can switch them on.'}
          </p>
          {canConfigure && (
            <button
              className="admin-pp-btn admin-pp-btn-primary"
              type="button"
              disabled={pending || cannotSwitchOn !== null}
              onClick={() => onConfirm({ kind: 'switch', to: true })}
            >
              Switch on payouts
            </button>
          )}
        </div>
      )}

      {platformNotReady && (
        <div className="admin-pp-off" role="note">
          <p>
            <strong>No one can be paid yet.</strong> The Stripe platform that holds program money is
            not enabled for payouts.
          </p>
        </div>
      )}

      <dl className="admin-pp-totals" aria-label="Program payout totals">
        <Total
          label="Ready to pay"
          amounts={payouts.totals.readyMinorByCurrency}
          note={payouts.totals.readyCount > 0 ? people(payouts.totals.readyCount) : null}
        />
        <Total label="Waiting" amounts={payouts.totals.waitingMinorByCurrency} note={null} />
        <Total label="Paid" amounts={payouts.totals.paidMinorByCurrency} note={null} />
      </dl>

      {nothing ? (
        <p className="admin-pp-empty">
          Nothing to pay yet. Creators appear here once a program approves their commission.
        </p>
      ) : (
        <>
          <div className="admin-pp-block" role="group" aria-labelledby="admin-pp-ready">
            <div className="admin-pp-block-head">
              <h3 id="admin-pp-ready">Ready to pay</h3>
              {canPay &&
                batches.map((batch) => (
                  <button
                    key={batch.currency}
                    className="admin-pp-btn admin-pp-btn-primary"
                    type="button"
                    disabled={pending}
                    aria-label={`Pay all ready${readyCurrencies.length > 1 ? ` in ${batch.currency}` : ''}: ${people(batch.creators.length)}, ${payoutMoney(batch.total, batch.currency)}`}
                    onClick={() => onConfirm({ kind: 'pay_ready', ...batch })}
                  >
                    {readyCurrencies.length > 1 ? `Pay all in ${batch.currency}` : 'Pay all ready'}
                  </button>
                ))}
            </div>
            {ready.length === 0 ? (
              <p className="admin-pp-none">No one is ready to be paid.</p>
            ) : (
              <ul className="admin-pp-rows">
                {ready.map((creator) => (
                  <li
                    key={`${creator.affiliateId}:${creator.currency}`}
                    className={canPay ? 'admin-pp-row-action' : undefined}
                  >
                    <span className="admin-pp-name">{creatorName(creator.name)}</span>
                    <span className="admin-pp-amount">
                      {payoutMoney(creator.payableMinor, creator.currency)}
                    </span>
                    <span className="admin-pp-detail">
                      <Programs creator={creator} />
                    </span>
                    {canPay && (
                      <span className="admin-pp-action">
                        <button
                          className="admin-pp-btn"
                          type="button"
                          disabled={pending}
                          aria-label={`Pay ${creatorName(creator.name)} ${payoutMoney(creator.payableMinor, creator.currency)}`}
                          onClick={() => onConfirm({ kind: 'pay', creator })}
                        >
                          Pay
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {waiting.length > 0 && (
            <div className="admin-pp-block" role="group" aria-labelledby="admin-pp-waiting">
              <div className="admin-pp-block-head">
                <h3 id="admin-pp-waiting">Waiting</h3>
              </div>
              <ul className="admin-pp-rows">
                {waiting.map((creator) => (
                  <li key={`${creator.affiliateId}:${creator.currency}`}>
                    <span className="admin-pp-name">{creatorName(creator.name)}</span>
                    <span className="admin-pp-amount">
                      {payoutMoney(creator.payableMinor, creator.currency)}
                    </span>
                    <span className="admin-pp-detail">
                      {BLOCKER_WORDS[creator.blocker ?? 'other']}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {payouts.open.length > 0 && (
            <div className="admin-pp-block" role="group" aria-labelledby="admin-pp-open">
              <div className="admin-pp-block-head">
                <h3 id="admin-pp-open">On its way</h3>
              </div>
              <ul className="admin-pp-rows">
                {payouts.open.map((payout) => (
                  <li
                    key={payout.id}
                    className={canPay && payout.canCancel ? 'admin-pp-row-action' : undefined}
                  >
                    <span className="admin-pp-name">{creatorName(payout.name)}</span>
                    <span className="admin-pp-amount">
                      {payoutMoney(payout.amountMinor, payout.currency)}
                    </span>
                    <span className="admin-pp-detail">
                      {[openPayoutWords(payout), payoutDate(payout.createdAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {canPay && payout.canCancel && (
                      <span className="admin-pp-action">
                        <button
                          className="admin-pp-btn"
                          type="button"
                          disabled={pending}
                          aria-label={`Cancel payout to ${creatorName(payout.name)}, ${payoutMoney(payout.amountMinor, payout.currency)}`}
                          onClick={() => onConfirm({ kind: 'cancel', payout })}
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {payouts.recent.length > 0 && (
            <div className="admin-pp-block" role="group" aria-labelledby="admin-pp-recent">
              <div className="admin-pp-block-head">
                <h3 id="admin-pp-recent">Recent</h3>
              </div>
              <ul className="admin-pp-rows">
                {payouts.recent.map((payout) => (
                  <li key={payout.id}>
                    <span className="admin-pp-name">{creatorName(payout.name)}</span>
                    <span className="admin-pp-amount">
                      {payoutMoney(payout.amountMinor, payout.currency)}
                    </span>
                    <span className="admin-pp-detail admin-pp-outcome">
                      <Outcome payout={payout} />
                    </span>
                  </li>
                ))}
              </ul>
              {returned && (
                <p className="admin-pp-note">
                  A payout that was not sent or was canceled is back in what the creator is owed.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <div className="admin-pp-foot">
        {settings ?? (
          <p>
            Smallest payout: {depositLabel(payouts.minPayoutMinor)} in the program’s currency.{' '}
            {canPay
              ? 'Only the Owner can change payout settings.'
              : 'Only an Owner or Finance admin can pay.'}
          </p>
        )}
        {canConfigure && payouts.enabled && (
          <button
            className="admin-pp-btn admin-pp-btn-danger"
            type="button"
            disabled={pending}
            onClick={() => onConfirm({ kind: 'switch', to: false })}
          >
            Switch off payouts
          </button>
        )}
      </div>
    </>
  )
}

function SmallestPayout({
  value,
  unchanged,
  error,
  input,
  busy,
  disabled,
  onEdit,
  onSave,
}: {
  value: string
  unchanged: boolean
  error: string | null
  input: RefObject<HTMLInputElement | null>
  busy: boolean
  disabled: boolean
  onEdit: (value: string) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form className="admin-pp-settings" onSubmit={onSave} noValidate>
      <label className="admin-pp-label" htmlFor="admin-pp-min">
        Smallest payout
      </label>
      <div className="admin-pp-field">
        <input
          id="admin-pp-min"
          className="admin-pp-input"
          ref={input}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          maxLength={14}
          value={value}
          onChange={(event) => onEdit(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'admin-pp-min-error' : 'admin-pp-min-hint'}
        />
        <button className="admin-pp-btn" type="submit" disabled={disabled || unchanged}>
          {busy && <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />}
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error ? (
        <p className="admin-pp-hint admin-pp-hint-error" id="admin-pp-min-error">
          {error}
        </p>
      ) : (
        <p className="admin-pp-hint" id="admin-pp-min-hint">
          In the program’s currency: 25 means $25.00 for a US dollar program.
        </p>
      )}
    </form>
  )
}

function Total({
  label,
  amounts,
  note,
}: {
  label: string
  amounts: AdminMoneyByCurrency
  note: string | null
}) {
  const lines = moneyByCurrency(amounts)
  return (
    <div>
      <dt>{label}</dt>
      {lines.length > 0 ? (
        lines.map((line) => <dd key={line}>{line}</dd>)
      ) : (
        <dd className="admin-pp-total-none">None</dd>
      )}
      {note && <dd className="admin-pp-total-note">{note}</dd>}
    </div>
  )
}

/** The programs a payable comes from; the split is shown only when there is more than one. */
function Programs({ creator }: { creator: AdminPayoutCreator }) {
  if (creator.programs.length === 1) return <>{creator.programs[0].name || 'Program'}</>
  return (
    <>
      {creator.programs.map((program, index) => (
        <span className="admin-pp-program" key={program.programId}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          {program.name || 'Program'} {payoutMoney(program.amountMinor, creator.currency)}
        </span>
      ))}
    </>
  )
}

function Outcome({ payout }: { payout: AdminClosedPayout }) {
  const when = payoutDate(payout.closedAt ?? payout.createdAt)
  if (payout.status === 'paid') {
    return (
      <>
        <span className="admin-pp-pill admin-pp-pill-paid">Paid</span>
        {when && <span>{when}</span>}
        {payout.transferId && <code>{payout.transferId}</code>}
      </>
    )
  }
  if (payout.status === 'canceled') {
    return (
      <>
        <span className="admin-pp-pill">Canceled</span>
        {when && <span>{when}</span>}
      </>
    )
  }
  return (
    <>
      <span className="admin-pp-pill admin-pp-pill-failed">Not sent</span>
      {when && <span>{when}</span>}
      <span>{payoutFailureWords(payout.failureCode) ?? 'Stripe refused the transfer'}</span>
    </>
  )
}

function Confirm({
  title,
  description,
  busy,
  onCancel,
  children,
}: {
  title: string
  description: string
  busy: boolean
  onCancel: () => void
  children: ReactNode
}) {
  // Focus lands on the text, not on the button that sends money.
  const body = useRef<HTMLDivElement>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
      title={title}
      description={description}
      initialFocusRef={body}
      className="admin-portal admin-review-dialog"
      dismissible={!busy}
    >
      <div ref={body} tabIndex={-1} className="admin-review-body admin-pp-confirm">
        {children}
      </div>
    </Dialog>
  )
}

function ConfirmActions({
  busy,
  danger = false,
  confirm,
  busyLabel,
  dismiss,
  onConfirm,
  onDismiss,
}: {
  busy: boolean
  danger?: boolean
  confirm: string
  busyLabel: string
  dismiss: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  return (
    <div className="admin-pp-confirm-actions">
      <button
        className={`admin-primary-button${danger ? ' admin-settings-disable' : ''}`}
        type="button"
        disabled={busy}
        onClick={onConfirm}
      >
        {busy && <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />}
        {busy ? busyLabel : confirm}
      </button>
      <button className="admin-secondary-button" type="button" disabled={busy} onClick={onDismiss}>
        {dismiss}
      </button>
    </div>
  )
}
