import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowDownToLine, ArrowLeft, FileText, MessageSquareText } from 'lucide-react'
import { downloadCsv, money, shortDate } from './data'
import { PayoutBadge } from './PayoutBadge'
import {
  payoutPeriodLabel,
  payoutSchedule,
  payoutStatementCsv,
  statementPdfPath,
} from './payoutData'
import type { PayoutDetail as PayoutDetailData } from './payoutData'

type DetailView = 'details' | 'report' | 'report-preview'
const discrepancyReasons = {
  earnings: 'Earnings calculation',
  adjustment: 'Adjustment or reversal',
  payment: 'Payment status or amount',
  statement: 'Statement details',
  other: 'Another money-related issue',
}

export function PayoutDetail({
  payout,
  breakdownAvailable,
  onClose,
}: {
  payout: PayoutDetailData
  breakdownAvailable: boolean
  onClose: () => void
}) {
  const [view, setView] = useState<DetailView>('details')
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<{ reason?: string; description?: string }>({})
  const [downloadNotice, setDownloadNotice] = useState('')
  const reasonField = useRef<HTMLSelectElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  const reportButton = useRef<HTMLButtonElement>(null)
  const previousView = useRef(view)
  const invalidField = useRef<'reason' | 'description' | null>(null)
  const schedule = payoutSchedule(payout)
  const pdfPath = statementPdfPath(payout)

  useEffect(() => {
    if (previousView.current !== view) {
      if (view === 'report') reasonField.current?.focus()
      else if (view === 'report-preview') previewHeading.current?.focus()
      else reportButton.current?.focus()
    }
    previousView.current = view
  }, [view])

  useEffect(() => {
    // Focus only after an invalid submission's descriptions have committed.
    // Ordinary edits clear errors without stealing focus from the user.
    if (invalidField.current === 'reason') reasonField.current?.focus()
    else if (invalidField.current === 'description') descriptionField.current?.focus()
    invalidField.current = null
  }, [errors])

  function previewReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = {
      reason: reason in discrepancyReasons ? undefined : 'Choose what you would like reviewed.',
      description:
        description.trim().length < 10 || description.trim().length > 1000
          ? 'Describe the issue in 10–1,000 characters.'
          : undefined,
    }
    invalidField.current = nextErrors.reason
      ? 'reason'
      : nextErrors.description
        ? 'description'
        : null
    setErrors(nextErrors)
    if (!invalidField.current) setView('report-preview')
  }

  if (view !== 'details') {
    return (
      <div className="payout-discrepancy">
        <button className="text-button" onClick={() => setView('details')}>
          <ArrowLeft size={15} /> Back to payout details
        </button>
        <div className="payout-local-note">
          <strong>Local preview only</strong>
          <p>
            Nothing is sent or saved. Please use fictional details, not account numbers or customer
            information.
          </p>
        </div>
        {view === 'report' ? (
          <form noValidate onSubmit={previewReport}>
            <h3>Report a discrepancy</h3>
            <p className="inline-note">
              {payoutPeriodLabel(payout)} · {payout.statement ?? 'Open period; no statement yet'}
            </p>
            <label className="form-field">
              <span id="payout-reason-label">What needs reviewing?</span>
              <select
                ref={reasonField}
                aria-labelledby="payout-reason-label"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value)
                  setErrors((old) => ({ ...old, reason: undefined }))
                }}
                required
                aria-invalid={Boolean(errors.reason)}
                aria-describedby={errors.reason ? 'payout-reason-error' : undefined}
              >
                <option value="">Choose a reason</option>
                {Object.entries(discrepancyReasons).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {errors.reason && (
                <span className="field-error" id="payout-reason-error" role="alert">
                  {errors.reason}
                </span>
              )}
            </label>
            <label className="form-field">
              <span id="payout-description-label">Describe the issue</span>
              <textarea
                ref={descriptionField}
                aria-labelledby="payout-description-label"
                rows={5}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value)
                  setErrors((old) => ({ ...old, description: undefined }))
                }}
                required
                maxLength={1000}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={`payout-description-hint${errors.description ? ' payout-description-error' : ''}`}
              />
              <span className="field-hint" id="payout-description-hint">
                10–1,000 characters · {description.length}/1,000
              </span>
              {errors.description && (
                <span className="field-error" id="payout-description-error" role="alert">
                  {errors.description}
                </span>
              )}
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button button-white"
                onClick={() => setView('details')}
              >
                Cancel
              </button>
              <button className="button button-green" type="submit">
                Preview report
              </button>
            </div>
          </form>
        ) : (
          <section aria-labelledby="payout-report-preview-heading">
            <h3 id="payout-report-preview-heading" tabIndex={-1} ref={previewHeading}>
              Your discrepancy preview
            </h3>
            <dl className="payout-report-summary">
              <div>
                <dt>Period</dt>
                <dd>{payoutPeriodLabel(payout)}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{discrepancyReasons[reason as keyof typeof discrepancyReasons]}</dd>
              </div>
              <div>
                <dt>Your description</dt>
                <dd className="payout-report-message">{description.trim()}</dd>
              </div>
            </dl>
            <p className="payout-local-note" role="status">
              Your report has not been sent or saved. The real support workflow will be available
              after the backend is connected.
            </p>
            <div className="dialog-actions">
              <button className="button button-white" onClick={() => setView('report')}>
                Edit preview
              </button>
              <button className="button button-green" onClick={onClose}>
                Close preview
              </button>
            </div>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="payout-detail">
      <div className="statement-banner">
        <span>
          <FileText size={14} /> SAMPLE STATEMENT
        </span>
        <PayoutBadge status={payout.status} />
      </div>
      <p className="inline-note payout-statement-disclaimer">
        {payout.status === 'paid'
          ? 'No transfer occurred. Every date and reference below is fictional; this is not an invoice or a payment record.'
          : 'Open earnings may change. They are not available for withdrawal or approved for payment.'}
      </p>
      <dl className="statement-meta payout-statement-meta">
        <div>
          <dt>Statement number</dt>
          <dd>{payout.statement ?? 'Not issued'}</dd>
        </div>
        <div>
          <dt>Partner snapshot</dt>
          <dd>{payout.agreement.partner}</dd>
        </div>
        <div>
          <dt>Agreement version</dt>
          <dd>{payout.agreement.version}</dd>
        </div>
        <div>
          <dt>Currency & method</dt>
          <dd>
            {payout.agreement.currency} · {payout.agreement.method}
          </dd>
        </div>
        <div>
          <dt>Review window · UTC</dt>
          <dd>
            {shortDate(schedule.reviewStart)} – {shortDate(schedule.reviewEnd)}
          </dd>
        </div>
        <div>
          <dt>{payout.paidAt ? 'Sample payment date · UTC' : 'Expected, subject to review'}</dt>
          <dd>{shortDate(payout.paidAt ?? schedule.expectedDate)}, 2026</dd>
        </div>
        <div>
          <dt>Destination snapshot</dt>
          <dd>{payout.agreement.destination}</dd>
        </div>
        <div>
          <dt>Sample payment reference</dt>
          <dd>{payout.paymentReference ?? 'No payment recorded'}</dd>
        </div>
      </dl>
      <section className="payout-calculation" aria-labelledby="payout-calculation-heading">
        <h3 id="payout-calculation-heading">How this amount is calculated</h3>
        <p className="inline-note">
          USD · 30% revenue share · Agreement v1. Known zero deductions are specific to this
          fictional example.
        </p>
        {!breakdownAvailable && (
          <p className="payout-local-note" role="status">
            Settlement breakdown unavailable. “—” is unknown, not zero. The last sample ledger
            totals remain below.
          </p>
        )}
        <dl className="payout-bridge" aria-label="Revenue calculation">
          {payout.bridge.map((line) => (
            <div key={line.key}>
              <dt>{line.label}</dt>
              <dd>
                {breakdownAvailable ? (
                  money(line.amountMinor)
                ) : (
                  <span aria-label="Unavailable">—</span>
                )}
              </dd>
            </div>
          ))}
          <div className="payout-bridge-subtotal">
            <dt>Eligible net revenue {breakdownAvailable ? '' : '· ledger snapshot'}</dt>
            <dd>{money(payout.eligibleRevenueMinor)}</dd>
          </div>
          <div>
            <dt>
              Partner earnings <small>Eligible revenue × 30%, before adjustments</small>
            </dt>
            <dd>{money(payout.earningsMinor)}</dd>
          </div>
          <div>
            <dt>
              Approved adjustments <small>Separate commission entries</small>
            </dt>
            <dd>{money(payout.adjustmentsMinor)}</dd>
          </div>
          <div className="payout-bridge-total">
            <dt>
              {payout.status === 'paid' ? 'Final sample payout' : 'Preliminary period amount'}
            </dt>
            <dd>{money(payout.finalMinor)}</dd>
          </div>
        </dl>
        <p className="inline-note">
          Refunds use actual settlement balance impact, including non-returned fees. FX is Stripe
          settlement conversion only. Real fees, taxes and deductions depend on verified records and
          the effective agreement.
        </p>
      </section>
      {breakdownAvailable && (
        <details className="payout-history-disclosure">
          <summary>Calculation notes</summary>
          <dl className="definition-list">
            {payout.bridge.map((line) => (
              <div key={line.key}>
                <dt>{line.label}</dt>
                <dd>{line.note}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <details className="payout-history-disclosure">
        <summary>Money-affecting history</summary>
        <p className="inline-note">
          Simplified period-level sample entries. Earnings, separate adjustments, and payments are
          different movements.
        </p>
        <ol className="payout-money-history">
          {payout.moneyHistory.map((entry, index) => (
            <li key={index}>
              <div>
                <time dateTime={entry.date}>{shortDate(entry.date)}, 2026 · UTC</time>
                <strong>{entry.title}</strong>
                <p>{entry.detail}</p>
              </div>
              <span>
                {entry.amountMinor > 0 ? '+' : ''}
                {money(entry.amountMinor)}
              </span>
            </li>
          ))}
        </ol>
      </details>
      <details className="payout-history-disclosure">
        <summary>Change history</summary>
        <ol className="payout-change-history">
          {payout.changes.map((entry, index) => (
            <li key={index}>
              <time dateTime={entry.date}>{shortDate(entry.date)}, 2026 · UTC</time>
              <span>{entry.label}</span>
            </li>
          ))}
        </ol>
        <p className="inline-note">
          Only partner-relevant history appears here. Paid periods retain their original agreement,
          destination and statement; later corrections belong to a new open period.
        </p>
      </details>
      <div className="payout-discrepancy-action">
        <button ref={reportButton} className="text-button" onClick={() => setView('report')}>
          <MessageSquareText size={16} /> Report a discrepancy
        </button>
        <span>Preview the form · Nothing is sent</span>
      </div>
      <div className="payout-download-notice" role="status">
        {downloadNotice}
      </div>
      <div className="dialog-actions payout-statement-actions">
        <button className="button button-white" onClick={onClose}>
          Close
        </button>
        {pdfPath ? (
          <a
            className="button button-white"
            href={`${import.meta.env.BASE_URL}${pdfPath}`}
            download={`${payout.statement}.pdf`}
          >
            <FileText size={15} /> Download sample PDF
          </a>
        ) : (
          <button className="button button-white" disabled>
            <FileText size={15} /> Download sample PDF
          </button>
        )}
        <button
          className="button button-green"
          disabled={!pdfPath}
          onClick={() => {
            const csv = payoutStatementCsv(payout)
            if (!csv) return
            downloadCsv(`${payout.statement}.csv`, csv.headers, csv.rows)
            setDownloadNotice('Sample CSV prepared. Your browser controls the download.')
          }}
        >
          <ArrowDownToLine size={15} /> Download sample CSV
        </button>
      </div>
    </div>
  )
}
