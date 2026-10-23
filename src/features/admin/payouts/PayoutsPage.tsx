import { useEffect, useRef, useState } from 'react'
import { AdminSettlementsPanel } from '../../creator-settlements/AdminSettlementsPanel'
import { Dialog } from '../../../components/Dialog'
import { Select } from '../../../components/Select'
import { ActionNotice, type ActionMessage } from '../../../components/ActionNotice'
import type { AdminGateway, AdminRole } from '../api/types'
import {
  PAYOUT_ACTION_LABELS,
  PAYOUT_BLOCKERS,
  PAYOUT_STATUSES,
  type Payout,
  type PayoutAction,
  type PayoutActionInput,
  type PayoutPeriod,
  type PayoutStatement,
  type PayoutStatus,
  type PayoutWorkspace,
} from '../api/payouts'
import './PayoutsPage.css'

const label = (value: string) => value.replaceAll('_', ' ')
const date = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
const payoutMoney = (amount: number, currency: string) =>
  currency === 'USD'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100)
    : `${amount.toLocaleString('en-US')} ${currency} minor units`
const periodLabel = (p: PayoutPeriod) => `${date(p.starts_at)} – ${date(p.ends_at)} · ${p.status}`
type Review = { action: PayoutAction; payout?: Payout; period?: PayoutPeriod }

export function PayoutsPage({ gateway, role }: { gateway: AdminGateway; role: AdminRole }) {
  const [workspace, setWorkspace] = useState<PayoutWorkspace | null>(null)
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState<PayoutStatus | ''>(''),
    [periodId, setPeriodId] = useState(''),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0)
  const [statementId, setStatementId] = useState<string | null>(null),
    [statement, setStatement] = useState<PayoutStatement | null>(null),
    [detailError, setDetailError] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null),
    [notice, setNotice] = useState<ActionMessage | null>(null)
  const canRead = role !== 'support',
    canWrite = role === 'owner' || role === 'finance'
  useEffect(() => {
    if (!canRead) return
    let current = true
    const run = async () => {
      await Promise.resolve()
      if (!current) return
      setLoading(true)
      setError(null)
      try {
        if (!gateway.getPayoutWorkspace) throw Error('The payout workflow is not deployed yet.')
        const result = await gateway.getPayoutWorkspace({
          periodId,
          query: search,
          status,
          offset,
          limit: 25,
        })
        if (!current) return
        if (result.error || !result.data)
          throw Error(result.error?.message || 'Payout data is unavailable.')
        setWorkspace(result.data)
      } catch (e) {
        if (current) {
          setWorkspace(null)
          setError(e instanceof Error ? e.message : 'Payout data is unavailable.')
        }
      } finally {
        if (current) setLoading(false)
      }
    }
    void run()
    return () => {
      current = false
    }
  }, [gateway, canRead, periodId, search, status, offset, revision])
  useEffect(() => {
    let current = true
    if (!statementId || !canRead) return
    const run = async () => {
      await Promise.resolve()
      if (!current) return
      setStatement(null)
      setDetailError(null)
      try {
        if (!gateway.getPayoutStatement) throw Error('Statement detail is unavailable.')
        const result = await gateway.getPayoutStatement(statementId)
        if (result.error || !result.data || result.data.payout.id !== statementId)
          throw Error(result.error?.message || 'Statement detail is unavailable.')
        if (current) setStatement(result.data)
      } catch (e) {
        if (current)
          setDetailError(e instanceof Error ? e.message : 'Statement detail is unavailable.')
      }
    }
    void run()
    return () => {
      current = false
    }
  }, [gateway, statementId, revision, canRead])
  if (!canRead)
    return (
      <section className="admin-payouts">
        <h1>Payout access restricted</h1>
        <p>Owner, Finance, Operations, or Analyst access is required.</p>
      </section>
    )
  const selected = workspace?.periods.find((p) => p.id === workspace.selected_period_id)
  const chooseFilter = (change: () => void) => {
    change()
    setOffset(0)
    setWorkspace(null)
    setStatementId(null)
  }
  const refresh = () => setRevision((n) => n + 1)
  return (
    <section className="admin-payouts" aria-label="Admin payouts">
      <header className="payout-heading">
        <div>
          <p className="payout-eyebrow">Partner settlements</p>
          <h1>
            Payouts<span>.</span>
          </h1>
          <p>Prepare statements, review the ledger, and approve eligible balances.</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </header>
      <div className="payout-callout">
        <strong>
          Legacy subscription statements: review and approval only — transfers are disabled.
        </strong>
        <p>
          Approved is not paid. These legacy statements cannot send money or mark a payout as paid.
          A $0 checkout does not create payable earnings.
        </p>
      </div>
      <AdminSettlementsPanel canWrite={canWrite} />
      {!canWrite && (
        <p>Read-only access. Only Owner and Finance can change payout workflow state.</p>
      )}
      <div className="payout-toolbar">
        <h2>Payout periods</h2>
        {canWrite && (
          <button
            type="button"
            className="payout-primary"
            onClick={() => setReview({ action: 'create_period' })}
            disabled={loading || !!error}
          >
            Create period
          </button>
        )}
      </div>
      {loading && (
        <p role="status">{workspace ? 'Refreshing payout records…' : 'Loading payout records…'}</p>
      )}
      {error && (
        <div role="alert" className="payout-callout">
          <strong>Payout records unavailable</strong>
          <p>{error} This is not a zero balance.</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {workspace && (
        <>
          {workspace.processing_attention && (
            <p role="status" className="payout-callout">
              Processing needs attention. Resolve Data Health issues before closing a period or
              approving statements.
            </p>
          )}
          {workspace.periods.length === 0 ? (
            <div className="payout-empty">
              <h3>No payout periods yet</h3>
              <p>
                Create a 14-day UTC period before paid commissions need to be posted. No payout
                statements or earnings have been invented.
              </p>
            </div>
          ) : (
            <>
              <Select
                label="Payout period"
                value={workspace.selected_period_id ?? ''}
                options={workspace.periods.map((p) => ({ value: p.id, label: periodLabel(p) }))}
                onChange={(v) => chooseFilter(() => setPeriodId(v))}
              />
              {workspace.periods_truncated && (
                <p>
                  Only the newest 200 periods are listed. Older periods require operator
                  investigation.
                </p>
              )}
              {selected && (
                <div className="payout-period">
                  <p>
                    <strong>{label(selected.status)}</strong> · Review from{' '}
                    {date(selected.review_starts_at)} · Due {date(selected.payout_due_at)} (UTC)
                  </p>
                  <div className="payout-actions">
                    {canWrite && selected.status === 'open' && (
                      <button
                        disabled={loading || workspace.processing_attention}
                        onClick={() => setReview({ action: 'review_period', period: selected })}
                      >
                        Start period review
                      </button>
                    )}
                    {canWrite && selected.status === 'review' && (
                      <button
                        disabled={loading || workspace.processing_attention}
                        onClick={() => setReview({ action: 'close_period', period: selected })}
                      >
                        Close period
                      </button>
                    )}
                    {canWrite && selected.status === 'closed' && (
                      <button
                        disabled={loading}
                        onClick={() =>
                          setReview({ action: 'prepare_statements', period: selected })
                        }
                      >
                        Prepare statements
                      </button>
                    )}
                  </div>
                  <p>
                    {workspace.unprepared_groups} ledger group(s) without a statement. Closed
                    periods cannot be reopened.
                  </p>
                </div>
              )}
              <form
                className="payout-filters"
                onSubmit={(e) => {
                  e.preventDefault()
                  chooseFilter(() => setSearch(query.trim()))
                }}
              >
                <label>
                  Find a statement
                  <input
                    value={query}
                    maxLength={120}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Partner, product, or statement number"
                  />
                </label>
                <Select
                  label="Statement status"
                  value={status}
                  options={[
                    { value: '', label: 'All statuses' },
                    ...PAYOUT_STATUSES.map((s) => ({ value: s, label: label(s) })),
                  ]}
                  onChange={(v) => chooseFilter(() => setStatus(v as PayoutStatus | ''))}
                />
                <button type="submit">Search</button>
              </form>
              {workspace.items.length === 0 ? (
                <div className="payout-empty">
                  <h3>No matching statements</h3>
                  <p>
                    {workspace.unprepared_groups
                      ? 'Close the period and prepare its ledger-backed statements.'
                      : 'There are no statements for these filters. No payable balance is implied.'}
                  </p>
                </div>
              ) : (
                <div className="payout-list">
                  {workspace.items.map((p) => (
                    <article className="payout-card" key={p.id}>
                      <div className="payout-toolbar">
                        <div>
                          <h3>{p.partner_name}</h3>
                          <p>
                            {p.product_name} · {p.statement_number ?? 'Statement not numbered'}
                          </p>
                        </div>
                        <span className={`payout-badge payout-${p.status}`}>{label(p.status)}</span>
                      </div>
                      <dl className="payout-amounts">
                        <div>
                          <dt>Statement amount</dt>
                          <dd>{payoutMoney(p.final_payout_minor, p.currency)}</dd>
                        </div>
                        <div>
                          <dt>Agreement minimum</dt>
                          <dd>
                            {p.minimum_minor === null
                              ? 'Unavailable'
                              : payoutMoney(p.minimum_minor, p.currency)}
                          </dd>
                        </div>
                        <div>
                          <dt>Payment destination</dt>
                          <dd>
                            {p.frozen_destination_label ?? p.destination_label ?? 'Not verified'}
                          </dd>
                        </div>
                      </dl>
                      {p.status !== 'paid' && <p>No payment confirmation recorded.</p>}
                      {p.status === 'on_hold' && (
                        <p>
                          <strong>Hold reason:</strong> {p.hold_reason}
                        </p>
                      )}
                      {(p.status === 'open' || p.status === 'review') &&
                        p.approval_blockers.length > 0 && (
                          <ul className="payout-blockers">
                            {p.approval_blockers.map((b) => (
                              <li key={b}>{PAYOUT_BLOCKERS[b]}</li>
                            ))}
                          </ul>
                        )}
                      {p.status === 'review' &&
                        p.snapshot_count > 1 &&
                        p.minimum_minor !== null &&
                        p.final_payout_minor < p.minimum_minor && (
                          <p>
                            Carry-forward is blocked for mixed-agreement balances until an
                            allocation policy is defined.
                          </p>
                        )}
                      <div className="payout-actions">
                        <button onClick={() => setStatementId(p.id)}>Review statement</button>
                        {canWrite && (
                          <>
                            {p.status === 'open' && (
                              <button
                                disabled={loading}
                                onClick={() => setReview({ action: 'review', payout: p })}
                              >
                                Mark reviewed
                              </button>
                            )}
                            {p.status === 'review' && (
                              <>
                                <button
                                  className="payout-primary"
                                  disabled={loading || p.approval_blockers.length > 0}
                                  onClick={() => setReview({ action: 'approve', payout: p })}
                                >
                                  Approve statement
                                </button>
                                <button
                                  disabled={
                                    loading ||
                                    p.common_blockers.length > 0 ||
                                    p.snapshot_count !== 1 ||
                                    p.minimum_minor === null ||
                                    p.final_payout_minor >= p.minimum_minor
                                  }
                                  onClick={() => setReview({ action: 'carry_forward', payout: p })}
                                >
                                  Carry balance forward
                                </button>
                              </>
                            )}
                            {['open', 'review', 'approved', 'scheduled', 'failed'].includes(
                              p.status,
                            ) && (
                              <button
                                disabled={loading}
                                onClick={() => setReview({ action: 'hold', payout: p })}
                              >
                                Place on hold
                              </button>
                            )}
                            {p.status === 'on_hold' &&
                              ['open', 'review', 'approved'].includes(p.held_from_status ?? '') && (
                                <button
                                  disabled={loading}
                                  onClick={() => setReview({ action: 'resume', payout: p })}
                                >
                                  Resume statement
                                </button>
                              )}
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <nav className="payout-toolbar" aria-label="Statement pagination">
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset((n) => Math.max(0, n - 25))}
                >
                  Previous
                </button>
                <p>
                  {workspace.total} matching statement(s) · Page {Math.floor(offset / 25) + 1}
                </p>
                <button
                  disabled={loading || offset + 25 >= workspace.total}
                  onClick={() => setOffset((n) => n + 25)}
                >
                  Next
                </button>
              </nav>
            </>
          )}
          <p className="payout-updated">
            Snapshot: {new Date(workspace.generated_at).toLocaleString()} · Refresh to check for
            newer records. The server rechecks every action.
          </p>
        </>
      )}
      <Dialog
        open={!!statementId}
        onOpenChange={(open) => {
          if (!open) setStatementId(null)
        }}
        title="Payout statement"
        description="Immutable ledger evidence. This is an internal review, not proof of payment."
        wide
        className="admin-payouts"
      >
        {detailError ? (
          <p role="alert">{detailError}</p>
        ) : !statement ? (
          <p role="status">Loading statement…</p>
        ) : (
          <>
            <h3>
              {statement.payout.partner_name} · {statement.payout.product_name}
            </h3>
            <p>
              {statement.payout.statement_number} · {label(statement.payout.status)}
            </p>
            <dl className="payout-breakdown">
              {(
                [
                  'eligible_net_minor',
                  'earnings_minor',
                  'adjustments_minor',
                  'carry_in_minor',
                  'carry_out_minor',
                  'final_payout_minor',
                ] as const
              ).map((k) => (
                <div key={k}>
                  <dt>{label(k.replace('_minor', ''))}</dt>
                  <dd>{payoutMoney(statement.payout[k], statement.payout.currency)}</dd>
                </div>
              ))}
            </dl>
            <h3>Frozen agreement terms</h3>
            {statement.agreements.map((a) => (
              <p key={a.agreement_id}>
                Version {a.version} · {label(a.model)} · {a.frequency_days}-day cadence ·{' '}
                {payoutMoney(a.minimum_minor, a.currency)} minimum
              </p>
            ))}
            <p>
              Reconciliation: {statement.payout.reconciliation_status ?? 'Required'}
              {statement.payout.reconciled_at ? ` · ${date(statement.payout.reconciled_at)}` : ''}
            </p>
            <h3>Ledger entries</h3>
            {statement.ledger.map((e) => (
              <div className="payout-ledger" key={e.id}>
                <strong>
                  {label(e.entry_type)} · {payoutMoney(e.amount_minor, e.currency)}
                </strong>
                <p>
                  {e.description ?? 'No description'} · {date(e.created_at)}
                </p>
              </div>
            ))}
            {statement.ledger_truncated && (
              <p role="status">
                Showing the first 500 entries only. Obtain the full ledger before completing your
                review.
              </p>
            )}
          </>
        )}
      </Dialog>
      {review && (
        <PayoutActionDialog
          gateway={gateway}
          review={review}
          periods={workspace?.periods ?? []}
          onClose={() => setReview(null)}
          onSuccess={() => {
            setReview(null)
            setNotice({
              kind: 'success',
              message: `${PAYOUT_ACTION_LABELS[review.action]} completed. No money was sent.`,
            })
            refresh()
          }}
        />
      )}
      <ActionNotice notice={notice} onDismiss={() => setNotice(null)} />
    </section>
  )
}

function PayoutActionDialog({
  gateway,
  review,
  periods,
  onClose,
  onSuccess,
}: {
  gateway: AdminGateway
  review: Review
  periods: PayoutPeriod[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [reason, setReason] = useState(''),
    [start, setStart] = useState(''),
    [reviewStart, setReviewStart] = useState(''),
    [due, setDue] = useState(''),
    [next, setNext] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const pending = useRef(false),
    request = useRef<PayoutActionInput | null>(null),
    alive = useRef(true)
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const end =
    start && Number.isFinite(Date.parse(`${start}T00:00:00Z`))
      ? new Date(Date.parse(`${start}T00:00:00Z`) + 14 * 86400000).toISOString()
      : ''
  const target = review.payout ?? review.period
  const send = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      if (!gateway.performPayoutAction)
        throw Error('The payout action contract is not deployed yet.')
      if (!request.current) {
        const input: PayoutActionInput = {
          request_id: crypto.randomUUID(),
          action: review.action,
          reason: reason.trim(),
        }
        if (target) {
          input.id = target.id
          input.expected_updated_at = target.updated_at
        }
        if (review.action === 'create_period') {
          input.starts_at = `${start}T00:00:00.000Z`
          input.ends_at = end
          input.review_starts_at = new Date(`${reviewStart}Z`).toISOString()
          input.payout_due_at = new Date(`${due}Z`).toISOString()
        }
        if (review.action === 'carry_forward') input.next_period_id = next
        request.current = input
        setLocked(true)
      }
      const result = await gateway.performPayoutAction(request.current)
      if (result.error || !result.data)
        throw Error(
          result.error?.message ||
            'No confirmation received. Retry this same request to check its outcome.',
        )
      if (
        result.data.request_id !== request.current.request_id ||
        result.data.action !== request.current.action ||
        (target && result.data.id !== target.id)
      )
        throw Error(
          'Unexpected action receipt. Refresh and investigate before trying another action.',
        )
      if (alive.current) onSuccess()
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Action not confirmed. Retry the same request.')
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose()
      }}
      dismissible={!busy}
      title={PAYOUT_ACTION_LABELS[review.action]}
      description="The server checks permissions, the latest statement, and its supporting evidence. This action does not transfer funds."
      className="admin-payouts"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {review.payout && (
          <p>
            <strong>
              {review.payout.partner_name} · {review.payout.product_name}
            </strong>
            <br />
            {review.payout.statement_number} ·{' '}
            {payoutMoney(review.payout.final_payout_minor, review.payout.currency)}
          </p>
        )}
        {review.period && <p>{periodLabel(review.period)}</p>}
        {review.action === 'create_period' && (
          <fieldset disabled={busy || locked}>
            <legend>14-day payout period · all times UTC</legend>
            <label>
              Period start
              <input
                type="date"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <p>Exclusive period end: {end ? date(end) : 'Choose a start date'} at 00:00 UTC.</p>
            <label>
              Review starts (UTC)
              <input
                type="datetime-local"
                required
                value={reviewStart}
                onChange={(e) => setReviewStart(e.target.value)}
              />
            </label>
            <label>
              Payout due (UTC)
              <input
                type="datetime-local"
                required
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
            <p>
              Review must start on or after the period ends; payout due must be after review starts.
              Period boundaries cannot be changed later.
            </p>
          </fieldset>
        )}
        {review.action === 'carry_forward' && (
          <>
            <Select
              label="Next open period"
              required
              value={next}
              disabled={busy || locked}
              options={[
                { value: '', label: 'Choose a later open period' },
                ...periods
                  .filter(
                    (p) => p.status === 'open' && p.starts_at >= (review.payout?.period_end ?? ''),
                  )
                  .map((p) => ({ value: p.id, label: periodLabel(p) })),
              ]}
              onChange={setNext}
            />
            <p>
              Moves the entire signed balance, including a negative balance, to one later open
              period. Mixed-agreement balances require a separate allocation policy.
            </p>
          </>
        )}
        {review.action === 'close_period' && (
          <p>
            Closing is irreversible. Resolve unprocessed billing events and exact-window
            reconciliation first.
          </p>
        )}
        {review.action === 'approve' && (
          <p>
            Approval freezes the calculation and payment destination. It does not schedule or send a
            transfer.
          </p>
        )}
        <label>
          Audit reason
          <textarea
            required
            minLength={5}
            maxLength={500}
            value={reason}
            disabled={busy || locked}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain the review or operational decision. Do not include bank details."
          />
        </label>
        {error && (
          <div role="alert">
            <p>{error}</p>
            <p>
              This request is locked for safe retry. If you need to change it, close this dialog,
              refresh the records, and review the latest state first.
            </p>
          </div>
        )}
        <div className="payout-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="payout-primary"
            disabled={busy || reason.trim().length < 5}
          >
            {busy
              ? 'Saving…'
              : locked
                ? 'Retry same request'
                : `Confirm ${PAYOUT_ACTION_LABELS[review.action].toLowerCase()}`}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
