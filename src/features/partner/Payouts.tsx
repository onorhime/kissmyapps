import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Coins,
  Landmark,
  WalletCards,
} from 'lucide-react'
import { Dialog } from '../../components/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../components/States'
import { downloadCsv, money, payoutStatusLabels, shortDate } from './data'
import type { PortalPage, PreviewState, PayoutStatus, ProfileSection } from './data'
import { PayoutBadge } from './PayoutBadge'
import { PayoutDetail } from './PayoutDetail'
import { CalculationGuide, PayoutStateGuide } from './PayoutGuides'
import {
  payoutDetails,
  payoutHistoryCsv,
  payoutPeriodLabel,
  payoutSchedule,
  payoutSnapshotDate,
  payoutSummary,
  sampleAgreement,
} from './payoutData'
import type { PayoutDetail as PayoutDetailData } from './payoutData'

export { PayoutBadge } from './PayoutBadge'

type PayoutsProps = {
  state: PreviewState
  navigate: (page: PortalPage, section?: ProfileSection) => void
  onRetry: () => void
}

export function Payouts(props: PayoutsProps) {
  // Discard dialogs and drafts when their dataset disappears. Partial data is
  // still the same sample ledger, so its finalized statements stay available.
  return <PayoutWorkspace key={props.state === 'partial' ? 'sample' : props.state} {...props} />
}

function PayoutWorkspace({ state, navigate, onRetry }: PayoutsProps) {
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState<PayoutDetailData | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [stateGuide, setStateGuide] = useState<PayoutStatus | null>(null)
  const [definition, setDefinition] = useState<{ label: string; description: string } | null>(null)
  const [exportNotice, setExportNotice] = useState('')
  const unavailable = state === 'loading' || state === 'error'
  const payouts = state === 'empty' || unavailable ? [] : payoutDetails
  const filtered = payouts.filter((payout) => status === 'all' || payout.status === status)
  const current = payouts.find((payout) => payout.status === 'open')
  const summary = payoutSummary(payouts)
  const schedule = current ? payoutSchedule(current) : null
  const elapsedDays = current
    ? Math.min(
        14,
        Math.max(
          0,
          Math.floor((Date.parse(payoutSnapshotDate) - Date.parse(current.start)) / 86400000) + 1,
        ),
      )
    : 0

  const cards = [
    {
      label: 'Current period earnings',
      value: money(summary.openMinor),
      note: 'Accruing · Not approved for payment',
      icon: Coins,
      description:
        'Earnings before separate payout adjustments in the open 14-day period. These are not approved or withdrawable, even when the minimum is met.',
    },
    {
      label: 'Approved & scheduled',
      value: money(summary.approvedMinor),
      note: 'Approved amounts not yet paid',
      icon: Clock3,
      description:
        'Only explicit Approved and Scheduled records are included. A calculated balance or an expected date does not count as approval.',
    },
    {
      label: 'Next expected payout',
      value: schedule ? shortDate(schedule.expectedDate) + ', 2026' : '—',
      note: schedule ? 'Expected · Review & minimum apply' : 'No agreement or schedule configured',
      icon: CalendarDays,
      description:
        'Friday after the Monday–Thursday review window. This is an illustrative target, not a confirmed scheduled transfer; eligibility, minimum and security checks still apply.',
    },
    {
      label: 'Paid to date',
      value: money(summary.paidMinor),
      note: 'Finalized sample statements',
      icon: WalletCards,
      description:
        'Finalized paid statements only. Status examples and carried balances are excluded. No real transfer occurred in this preview.',
    },
  ]

  return (
    <div className="payout-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">THE REWARDS OF YOUR WORK</p>
          <h1>
            Payouts<span className="heading-dot">.</span>
          </h1>
          <p>A clear view of what you’ve earned, reviewed, and received.</p>
        </div>
        <button
          className="button button-white"
          disabled={!filtered.length || unavailable}
          onClick={() => {
            const csv = payoutHistoryCsv(filtered)
            downloadCsv('SAMPLE-payout-history.csv', csv.headers, csv.rows)
            setExportNotice('Sample history CSV prepared. Your browser controls the download.')
          }}
        >
          <ArrowDownToLine size={16} /> Export history
        </button>
      </div>
      <div className="payout-export-notice" role="status">
        {exportNotice}
      </div>
      {state === 'loading' ? (
        <LoadingState label="Loading payouts preview" />
      ) : state === 'error' ? (
        <ErrorState onRetry={onRetry} />
      ) : (
        <>
          <section className="metric-grid payout-metric-grid" aria-label="Payout summary">
            {cards.map((card, index) => (
              <article
                className={`metric-card ${index === 0 ? 'metric-featured' : ''}`}
                key={card.label}
                aria-label={card.label}
              >
                <div className="metric-top">
                  <span>{card.label}</span>
                  <button
                    className="payout-metric-help"
                    title={card.description}
                    aria-label={`About ${card.label.toLowerCase()}`}
                    onClick={() =>
                      setDefinition({ label: card.label, description: card.description })
                    }
                  >
                    <card.icon size={18} />
                  </button>
                </div>
                <strong className={`metric-value ${index === 2 ? 'payout-date-value' : ''}`}>
                  {card.value}
                </strong>
                <div className="metric-foot">
                  <span>{card.note}</span>
                </div>
              </article>
            ))}
          </section>
          {state !== 'empty' && (
            <p className="payout-snapshot-note">
              Sample snapshot · Aug 26, 2026 · UTC · All sources; Performance filters do not change
              payouts.
            </p>
          )}
          {state === 'partial' && (
            <div className="partial-notice" role="status">
              <CircleHelp size={18} />
              <div>
                <strong>Current-period settlement breakdown is unavailable.</strong>
                <p>
                  Unknown deduction values show “—”. Last sample ledger totals and earlier finalized
                  statements remain available.
                </p>
              </div>
            </div>
          )}
          <div className="payout-cycle-grid">
            <section className="panel cycle-panel">
              <div className="panel-heading">
                <div>
                  <h2>Current payout cycle</h2>
                  <p>
                    {current
                      ? payoutPeriodLabel(current) + ' · UTC'
                      : 'Your schedule will follow your partner agreement.'}
                  </p>
                </div>
                {current ? (
                  <PayoutBadge status="open" />
                ) : (
                  <span className="status-badge badge-neutral">Not configured</span>
                )}
              </div>
              {current && schedule ? (
                <div className="cycle-content">
                  <div className="cycle-progress-label">
                    <span>{elapsedDays} of 14 days</span>
                    <span>Ends {shortDate(current.end)}</span>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Current payout cycle elapsed days"
                    aria-valuemin={0}
                    aria-valuemax={14}
                    aria-valuenow={elapsedDays}
                    aria-valuetext={`${elapsedDays} of 14 days`}
                  >
                    <span style={{ width: `${(elapsedDays / 14) * 100}%` }} />
                  </div>
                  <ol className="payout-cycle-steps" aria-label="Payout lifecycle">
                    {['Open', 'Review', 'Approved', 'Scheduled', 'Paid'].map((step, index) => (
                      <li key={step} aria-current={index === 0 ? 'step' : undefined}>
                        <span aria-hidden="true">{index + 1}</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                  <dl className="payout-schedule">
                    <div>
                      <dt>Period closes</dt>
                      <dd>{shortDate(current.end)} · 23:59:59 UTC</dd>
                    </div>
                    <div>
                      <dt>Review · Monday–Thursday</dt>
                      <dd>
                        {shortDate(schedule.reviewStart)} – {shortDate(schedule.reviewEnd)}
                      </dd>
                    </div>
                    <div>
                      <dt>Expected payment · Friday</dt>
                      <dd>{shortDate(schedule.expectedDate)}, 2026</dd>
                    </div>
                    <div>
                      <dt>Example minimum</dt>
                      <dd>{money(sampleAgreement.minimumMinor)} USD</dd>
                    </div>
                  </dl>
                  <p className="inline-note">
                    A cycle begins Monday at 00:00 UTC. Below-minimum balances carry forward.
                    Meeting the minimum never approves a payout; the agreement and completed review
                    determine eligibility.
                  </p>
                  <button
                    className="text-button payout-cycle-action"
                    onClick={() => setSelected(current)}
                  >
                    View current calculation <ArrowRight size={14} />
                  </button>
                </div>
              ) : (
                <EmptyState
                  icon={<CalendarDays size={27} />}
                  title="Your first cycle is ahead"
                  description="Once a product and agreement are active, your cycle dates, earnings, and payout schedule will appear here."
                />
              )}
            </section>
            <section className="panel payment-method-panel">
              <span className="payment-method-icon">
                <Landmark size={23} />
              </span>
              <h2>{state === 'empty' ? 'Payment destination' : 'Your example agreement'}</h2>
              {state === 'empty' ? (
                <p>Add payment details once your account is connected.</p>
              ) : (
                <>
                  <p>Read-only terms · Not a live agreement</p>
                  <dl className="payout-agreement">
                    <div>
                      <dt>Model & rate</dt>
                      <dd>30% Revenue share</dd>
                    </div>
                    <div>
                      <dt>Frequency</dt>
                      <dd>{sampleAgreement.frequency}</dd>
                    </div>
                    <div>
                      <dt>Currency & method</dt>
                      <dd>USD · Bank transfer</dd>
                    </div>
                    <div>
                      <dt>Agreement version</dt>
                      <dd>Example v1</dd>
                    </div>
                  </dl>
                  <div className="masked-payment">
                    <strong>•••• 4821</strong>
                    <span>Example bank · Illustrative destination</span>
                  </div>
                </>
              )}
              <button className="text-button" onClick={() => navigate('profile', 'payment')}>
                View payout preferences <ArrowRight size={14} />
              </button>
              <div className="security-mini">
                <BadgeCheck size={16} />
                <span>
                  Changes need password and 2FA, email confirmation, and a 48-hour hold. Details
                  lock at Scheduled.
                </span>
              </div>
            </section>
          </div>
          <section className="panel payout-history-panel">
            <div className="panel-heading">
              <div>
                <h2>Payout history</h2>
                <p>Period balances, adjustments, and locked sample statements.</p>
              </div>
              <label className="filter-select">
                <span className="sr-only">Payout status</span>
                <select
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value)
                    setExportNotice('')
                  }}
                >
                  <option value="all">All statuses</option>
                  {Object.entries(payoutStatusLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </label>
            </div>
            {filtered.length ? (
              <div
                className="table-scroll payout-table-scroll"
                role="region"
                aria-label="Payout history table"
                tabIndex={0}
                onFocusCapture={(event) => {
                  const region = event.currentTarget
                  const target = event.target as HTMLElement
                  if (target === region) return
                  const frame = region.getBoundingClientRect()
                  const control = target.getBoundingClientRect()
                  if (!frame.width) return
                  if (control.right > frame.right - 8)
                    region.scrollLeft += control.right - frame.right + 8
                  else if (control.left < frame.left + 8)
                    region.scrollLeft += control.left - frame.left - 8
                }}
              >
                <table>
                  <caption className="sr-only">
                    Illustrative payout history. All amounts in USD; bank transfer under example
                    agreement v1. Open amounts are preliminary, not approved.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      <th scope="col">Eligible basis</th>
                      <th scope="col">Rate</th>
                      <th scope="col">Earnings</th>
                      <th scope="col">Adjustments</th>
                      <th scope="col">Period amount</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((payout) => (
                      <tr key={payout.id}>
                        <th scope="row">
                          <span className="table-cell-primary">
                            {shortDate(payout.start)} – {shortDate(payout.end)}
                          </span>
                          <span className="table-cell-secondary">
                            {payout.statement ?? 'Statement not yet issued'}
                          </span>
                        </th>
                        <td>{money(payout.eligibleRevenueMinor)}</td>
                        <td>30%</td>
                        <td>{money(payout.earningsMinor)}</td>
                        <td className={payout.adjustmentsMinor < 0 ? 'negative-value' : ''}>
                          {money(payout.adjustmentsMinor)}
                        </td>
                        <td className="money-cell">
                          {money(payout.finalMinor)}
                          <span className="table-cell-secondary">
                            {payout.status === 'paid' ? 'Finalized sample' : 'Preliminary'}
                          </span>
                        </td>
                        <td>
                          <PayoutBadge status={payout.status} />
                        </td>
                        <td>
                          <button
                            className="table-action"
                            onClick={() => setSelected(payout)}
                            aria-label={`View payout for ${shortDate(payout.start)}`}
                          >
                            View details <ArrowRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={<WalletCards size={28} />}
                title={
                  state === 'empty'
                    ? 'Nothing earned. Plenty ahead.'
                    : 'No payouts with this status'
                }
                description={
                  state === 'empty'
                    ? 'When your first product is live, earned commissions and payout statements will be collected here.'
                    : 'This sample history contains Open and Paid records. Other statuses are separate examples, excluded from your totals.'
                }
                action={
                  state !== 'empty' && (
                    <div className="payout-empty-actions">
                      <button className="button button-white" onClick={() => setStatus('all')}>
                        Show all payouts
                      </button>
                      <button
                        className="button button-white"
                        onClick={() => setStateGuide(status as PayoutStatus)}
                      >
                        Explore this status
                      </button>
                    </div>
                  )
                }
              />
            )}
            <div className="panel-footnote">
              <span>
                <Check size={13} /> Paid statements stay locked. Corrections appear in a new period.
              </span>
              <span>
                {state === 'empty'
                  ? 'Agreement and payment method not configured'
                  : 'USD · Bank transfer · Preview only'}
              </span>
            </div>
          </section>
          {state !== 'empty' && (
            <div className="payout-help-actions">
              <button className="text-button" onClick={() => setInfoOpen(true)}>
                <CircleHelp size={16} /> How are payouts calculated?
              </button>
              <button className="text-button" onClick={() => setStateGuide('open')}>
                <Clock3 size={16} /> Explore payout states
              </button>
            </div>
          )}
        </>
      )}
      <Dialog
        open={Boolean(selected) && !unavailable && state !== 'empty'}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={
          selected
            ? `Payout · ${shortDate(selected.start)} – ${shortDate(selected.end)}`
            : 'Payout details'
        }
        description="Sample statement preview. This is not an invoice or a payment record."
        wide
      >
        {selected && (
          <PayoutDetail
            key={selected.id}
            payout={selected}
            breakdownAvailable={state !== 'partial' || selected.status === 'paid'}
            onClose={() => setSelected(null)}
          />
        )}
      </Dialog>
      <Dialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        title="From earnings to payout"
        description="Your agreement defines the model, currency, minimum, and schedule."
        wide
      >
        <CalculationGuide />
      </Dialog>
      <Dialog
        open={Boolean(stateGuide)}
        onOpenChange={(open) => {
          if (!open) setStateGuide(null)
        }}
        title="Payout state examples"
        description="Independent illustrations, excluded from balances, history, statements, and Performance."
        wide
      >
        {stateGuide && <PayoutStateGuide status={stateGuide} onChange={setStateGuide} />}
      </Dialog>
      <Dialog
        open={Boolean(definition)}
        onOpenChange={(open) => {
          if (!open) setDefinition(null)
        }}
        title={definition?.label ?? 'Payout metric'}
        description={definition?.description ?? ''}
      >
        <p className="inline-note">
          Preview only · All sample amounts are USD. Real status and settlement evidence must come
          from the backend.
        </p>
      </Dialog>
    </div>
  )
}
