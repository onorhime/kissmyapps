import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleAlert, LoaderCircle, LockKeyhole, RefreshCw, Save } from 'lucide-react'
import { StatusNotice } from '../../../components/ActionNotice'
import { markFormSaved } from '../../../components/useFormNavigationGuard'
import { ConfigurationReview } from '../configuration/ConfigurationReview'
import type { AdminContext, AdminDataError, AdminDataResult, AdminGateway } from '../api'
import {
  PROGRAM_MONEY_CHANGED,
  depositField,
  depositLabel,
  depositToMinor,
  feeField,
  feeLabel,
  feePercentToBps,
  moneyByCurrency,
} from '../api/programMoney'
import type { AdminMoneyByCurrency, AdminProgramMoney } from '../api/programMoney'
import './ProgramMoney.css'

/**
 * Program money on the Settings page: the platform switch for prepaid program balances, the
 * KissMyApps fee, the minimum first deposit, and what is held right now. Only the Owner can
 * change it, and every change names the version of the settings it was made against.
 */

type MoneyState =
  | { status: 'loading' }
  | { status: 'ready'; money: AdminProgramMoney }
  /** The functions are not in this deployment yet. */
  | { status: 'unavailable' }
  | { status: 'unauthorized' }
  | { status: 'error'; error: AdminDataError | null }

type MoneyResult = AdminDataResult<AdminProgramMoney | null>

const thrown: MoneyResult = {
  data: null,
  status: 'error',
  error: {
    code: 'temporarily_unavailable',
    message: 'Program money is temporarily unavailable.',
    retryable: true,
  },
}

function failureMessage(error: AdminDataError | null): string {
  if (error?.code === 'not_authenticated' || error?.code === 'not_authorized') {
    return 'This change was not authorized. Sign in again as the Owner and retry.'
  }
  if (error?.code === 'not_configured' || error?.code === 'contract_unavailable') {
    return 'Program money is not available in this deployment yet.'
  }
  if (error?.code === 'conflict' || error?.code === 'invalid_state') return PROGRAM_MONEY_CHANGED
  if (error?.code === 'invalid_input') return error.message
  return 'That change did not go through. Nothing was saved. Try again.'
}

const FEE_ERROR = 'Enter a fee from 0 to 50, for example 10.'
const DEPOSIT_ERROR = 'Enter an amount from 1.00 to 1,000,000.00, for example 50.'

export function ProgramMoneySection({
  context,
  gateway,
  settingsUpdatedAt,
  reloadKey,
  onChanged,
}: {
  context: AdminContext
  gateway: AdminGateway
  /** The settings version the rest of the page last read: the fallback for a change. */
  settingsUpdatedAt: string | null
  /** Changes when the page reloads its settings, so this section reads again too. */
  reloadKey: number
  /** Called after the settings changed here, so the page reads its own part again. */
  onChanged: () => void
}) {
  const canEdit = context.role === 'owner'
  const read = gateway.getProgramMoney
  const configure = gateway.configureProgramMoney
  const [state, setState] = useState<MoneyState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState({ scope: '', fee: '', deposit: '' })
  const [errors, setErrors] = useState<{ fee?: string; deposit?: string }>({})
  const [confirming, setConfirming] = useState<'on' | 'off' | null>(null)
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const feeInput = useRef<HTMLInputElement | null>(null)
  const depositInput = useRef<HTMLInputElement | null>(null)
  const switchButton = useRef<HTMLButtonElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const focusSwitch = useRef(false)
  // Totals come with a read. A change may answer without them, so the last ones are kept.
  const [lastTotals, setLastTotals] = useState<AdminProgramMoney['totals']>(null)

  useEffect(() => {
    if (!read) return
    let current = true
    void read()
      .catch(() => thrown)
      .then((result) => {
        if (!current) return
        if (result.status === 'ready' && result.data) {
          if (result.data.totals) setLastTotals(result.data.totals)
          setState({ status: 'ready', money: result.data })
        } else if (
          result.status === 'unconfigured' ||
          result.error?.code === 'contract_unavailable' ||
          result.error?.code === 'not_configured'
        ) {
          setState({ status: 'unavailable' })
        } else if (result.status === 'unauthorized') {
          setState({ status: 'unauthorized' })
        } else {
          setState({ status: 'error', error: result.error })
        }
      })
    return () => {
      current = false
    }
  }, [read, attempt, reloadKey, settingsUpdatedAt])

  const money = state.status === 'ready' ? state.money : null
  const enabled = money?.enabled ?? false

  useEffect(() => {
    if (!focusSwitch.current) return
    focusSwitch.current = false
    switchButton.current?.focus({ preventScroll: true })
  }, [enabled, confirming])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((value) => value + 1)
  }, [])

  // An older gateway has no program money at all: the page stays as it was.
  if (!read || !configure) return null

  const scope = money ? `${money.feeBps}|${money.minDepositMinor}` : ''
  const fee = draft.scope === scope ? draft.fee : money ? feeField(money.feeBps) : ''
  const deposit =
    draft.scope === scope ? draft.deposit : money ? depositField(money.minDepositMinor) : ''
  const feeBps = feePercentToBps(fee)
  const depositMinor = depositToMinor(deposit)
  const unchanged = Boolean(
    money && feeBps === money.feeBps && depositMinor === money.minDepositMinor,
  )
  const totals = money?.totals ?? lastTotals

  function edit(field: 'fee' | 'deposit', value: string) {
    setDraft({ scope, fee, deposit, [field]: value })
    setErrors((current) => ({ ...current, [field]: undefined }))
    setSuccess(null)
    setFailure(null)
  }

  /** Both numbers as typed, or null after pointing at the first one that is wrong. */
  function typedNumbers(): { feeBps: number; minDepositMinor: number } | null {
    const next = {
      fee: feeBps === null ? FEE_ERROR : undefined,
      deposit: depositMinor === null ? DEPOSIT_ERROR : undefined,
    }
    setErrors(next)
    if (feeBps === null || depositMinor === null) {
      const target = next.fee ? feeInput : depositInput
      queueMicrotask(() => target.current?.focus())
      return null
    }
    return { feeBps, minDepositMinor: depositMinor }
  }

  async function change(
    next: { enabled: boolean; feeBps: number; minDepositMinor: number },
    done: string,
  ): Promise<boolean> {
    if (!canEdit || !money || !configure || pending) return false
    setPending(true)
    setSuccess(null)
    setFailure(null)
    let result: MoneyResult
    try {
      result = await configure({
        ...next,
        expectedUpdatedAt: money.updatedAt ?? settingsUpdatedAt,
      })
    } catch {
      result = thrown
    }
    setPending(false)
    if (result.status === 'ready' && result.data) {
      if (result.data.totals) setLastTotals(result.data.totals)
      setState({ status: 'ready', money: result.data })
      setSuccess(done)
      onChanged()
      return true
    }
    setFailure(failureMessage(result.error))
    if (result.error?.code === 'conflict' || result.error?.code === 'invalid_state') {
      // Someone else changed the settings: show theirs, here and on the rest of the page.
      setAttempt((value) => value + 1)
      onChanged()
    }
    return false
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    if (!money) return
    const numbers = typedNumbers()
    if (!numbers) return
    if (await change({ enabled: money.enabled, ...numbers }, 'Fee and minimum deposit saved.')) {
      markFormSaved(form)
    }
  }

  function askToSwitch() {
    if (!money || pending) return
    // Switching on applies the numbers on screen, so they must be right first.
    if (!money.enabled && !typedNumbers()) return
    setSuccess(null)
    setFailure(null)
    setConfirming(money.enabled ? 'off' : 'on')
    queueMicrotask(() => confirmButton.current?.focus({ preventScroll: true }))
  }

  function cancelSwitch() {
    focusSwitch.current = true
    setConfirming(null)
  }

  async function confirmSwitch() {
    if (!money || !confirming) return
    const numbers =
      confirming === 'on' && feeBps !== null && depositMinor !== null
        ? { feeBps, minDepositMinor: depositMinor }
        : { feeBps: money.feeBps, minDepositMinor: money.minDepositMinor }
    await change(
      { enabled: confirming === 'on', ...numbers },
      confirming === 'on'
        ? 'Program money is on. Programs now need a funded balance to publish and stay live.'
        : 'Program money is off.',
    )
    focusSwitch.current = true
    setConfirming(null)
  }

  return (
    <section
      className="admin-panel admin-money"
      aria-labelledby="admin-program-money"
      aria-busy={state.status === 'loading'}
    >
      <div className="admin-settings-panel-heading">
        <div>
          <h2 id="admin-program-money">Program money</h2>
          <p>
            Merchants keep a prepaid balance for their affiliate program. Each commission, and the
            KissMyApps fee on top of it, is set aside from that balance when the sale happens.
          </p>
        </div>
        {money && (
          <span
            className={`admin-settings-status admin-settings-status-${enabled ? 'enabled' : 'disabled'}`}
          >
            <span aria-hidden="true" />
            {enabled ? 'On' : 'Off'}
          </span>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="admin-money-line" role="status">
          <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
          Loading program money
        </p>
      )}

      {state.status === 'unavailable' && (
        <p className="admin-money-line">Program money is not available in this deployment yet.</p>
      )}

      {state.status === 'unauthorized' && (
        <div className="admin-inline-notice" role="note">
          <LockKeyhole size={18} aria-hidden="true" />
          <p>Your admin role cannot see program money. Ask the Owner.</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="admin-money-problem" role="alert">
          <p>
            <strong>Program money did not load.</strong> The rest of this page is not affected.
          </p>
          <button className="admin-secondary-button" type="button" onClick={retry}>
            <RefreshCw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      {money && (
        <>
          {enabled ? (
            <p className="admin-money-line">
              While this is on, a program needs a funded balance to be published and to stay live. A
              program whose balance cannot cover a commission earns nothing on that sale and is
              paused until the merchant adds funds.
            </p>
          ) : canEdit ? (
            <div className="admin-settings-blocked admin-money-warning" role="note">
              <CircleAlert size={18} aria-hidden="true" />
              <p>
                Switching this on makes every program need a funded balance to be published and to
                stay live. A program whose balance cannot cover a commission earns nothing on that
                sale and is paused until the merchant adds funds.
              </p>
            </div>
          ) : (
            <p className="admin-money-line">
              While this is off, programs do not need a balance and sales earn no program
              commission.
            </p>
          )}

          {canEdit ? (
            <form className="admin-money-form" onSubmit={(event) => void save(event)} noValidate>
              <div className="admin-money-fields">
                <div className="admin-field">
                  <label htmlFor="admin-money-fee">KissMyApps fee (%)</label>
                  <input
                    id="admin-money-fee"
                    ref={feeInput}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={8}
                    value={fee}
                    onChange={(event) => edit('fee', event.target.value)}
                    aria-invalid={Boolean(errors.fee)}
                    aria-describedby={errors.fee ? 'admin-money-fee-error' : 'admin-money-fee-hint'}
                  />
                  {errors.fee ? (
                    <p className="admin-field-error" id="admin-money-fee-error">
                      {errors.fee}
                    </p>
                  ) : (
                    <p className="admin-field-hint" id="admin-money-fee-hint">
                      A percentage of each commission, charged to the merchant on top of it. A
                      change applies to commission earned from then on.
                    </p>
                  )}
                </div>
                <div className="admin-field">
                  <label htmlFor="admin-money-deposit">Minimum first deposit</label>
                  <input
                    id="admin-money-deposit"
                    ref={depositInput}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={14}
                    value={deposit}
                    onChange={(event) => edit('deposit', event.target.value)}
                    aria-invalid={Boolean(errors.deposit)}
                    aria-describedby={
                      errors.deposit ? 'admin-money-deposit-error' : 'admin-money-deposit-hint'
                    }
                  />
                  {errors.deposit ? (
                    <p className="admin-field-error" id="admin-money-deposit-error">
                      {errors.deposit}
                    </p>
                  ) : (
                    <p className="admin-field-hint" id="admin-money-deposit-hint">
                      In the program’s own currency: 50 means $50.00 for a US dollar program.
                    </p>
                  )}
                </div>
              </div>

              <div className="admin-settings-actions">
                <button
                  className="admin-primary-button"
                  type="submit"
                  disabled={pending || unchanged}
                >
                  {pending && !confirming ? (
                    <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                  ) : (
                    <Save size={17} aria-hidden="true" />
                  )}
                  {pending && !confirming ? 'Saving…' : 'Save fee and deposit'}
                </button>
                <button
                  className={`admin-secondary-button${enabled ? ' admin-settings-disable' : ''}`}
                  ref={switchButton}
                  type="button"
                  disabled={pending}
                  onClick={askToSwitch}
                >
                  {enabled ? 'Switch off program money' : 'Switch on program money'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <dl className="admin-settings-current admin-money-current">
                <div>
                  <dt>KissMyApps fee</dt>
                  <dd>{feeLabel(money.feeBps)} of each commission</dd>
                </div>
                <div>
                  <dt>Minimum first deposit</dt>
                  <dd>{depositLabel(money.minDepositMinor)}</dd>
                </div>
              </dl>
              <div className="admin-inline-notice" role="note">
                <LockKeyhole size={18} aria-hidden="true" />
                <p>Only an Owner can change program money.</p>
              </div>
            </>
          )}

          {totals && (
            <dl className="admin-money-totals" aria-label="Program money totals">
              <div>
                <dt>Programs with a balance</dt>
                <dd>{totals.programsWithBalance.toLocaleString('en-US')}</dd>
              </div>
              <Total
                label="Available in balances"
                note="Deposited by merchants and not set aside."
                amounts={totals.availableMinorByCurrency}
              />
              <Total
                label="Reserved"
                note="Set aside for pending commission and its fee."
                amounts={totals.reservedMinorByCurrency}
              />
              <Total
                label="Owed to creators"
                note="Approved commission not paid out yet."
                amounts={totals.owedToCreatorsMinorByCurrency}
              />
            </dl>
          )}

          {confirming === 'on' && (
            <ConfigurationReview
              title="Switch on program money"
              description="Review what changes for programs before switching this on."
              busy={pending}
              onCancel={cancelSwitch}
            >
              <p>
                From now on a program needs a funded balance to be published and to stay live. Each
                commission, plus a KissMyApps fee of {feeLabel(feeBps ?? money.feeBps)}, is set
                aside from the merchant’s balance when the sale happens. A program whose balance
                cannot cover a commission earns nothing on that sale and is paused until the
                merchant adds funds.
              </p>
              <p>
                The minimum first deposit will be{' '}
                {depositLabel(depositMinor ?? money.minDepositMinor)} in the program’s currency.
              </p>
              <div className="admin-settings-confirm-actions">
                <button
                  className="admin-primary-button"
                  ref={confirmButton}
                  type="button"
                  disabled={pending}
                  onClick={() => void confirmSwitch()}
                >
                  {pending && <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />}
                  {pending ? 'Switching on…' : 'Switch on'}
                </button>
                <button
                  className="admin-secondary-button"
                  type="button"
                  disabled={pending}
                  onClick={cancelSwitch}
                >
                  Cancel
                </button>
              </div>
            </ConfigurationReview>
          )}

          {confirming === 'off' && (
            <ConfigurationReview
              title="Switch off program money"
              description="Review what stops before switching this off."
              busy={pending}
              onCancel={cancelSwitch}
            >
              <p>
                While this is off, sales earn no program commission and no program is paused or
                blocked for its balance. Balances and commission already recorded are kept.
              </p>
              <div className="admin-settings-confirm-actions">
                <button
                  className="admin-primary-button admin-settings-disable"
                  ref={confirmButton}
                  type="button"
                  disabled={pending}
                  onClick={() => void confirmSwitch()}
                >
                  {pending && <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />}
                  {pending ? 'Switching off…' : 'Switch off'}
                </button>
                <button
                  className="admin-secondary-button"
                  type="button"
                  disabled={pending}
                  onClick={cancelSwitch}
                >
                  Cancel
                </button>
              </div>
            </ConfigurationReview>
          )}
        </>
      )}

      <StatusNotice success={success} error={failure} />
    </section>
  )
}

function Total({
  label,
  note,
  amounts,
}: {
  label: string
  note: string
  amounts: AdminMoneyByCurrency
}) {
  const lines = moneyByCurrency(amounts)
  return (
    <div>
      <dt>{label}</dt>
      {lines.length > 0 ? (
        lines.map((line) => <dd key={line}>{line}</dd>)
      ) : (
        <dd className="admin-money-none">None</dd>
      )}
      <dd className="admin-money-total-note">{note}</dd>
    </div>
  )
}
