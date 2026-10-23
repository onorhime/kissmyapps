import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { FunnelMetricDefinition, FunnelMetricReport, FunnelMetricsGateway } from '../types'

export function MetricReportCards({ report }: { report: FunnelMetricReport }) {
  return (
    <div className="funnel-metrics-preview-grid">
      {report.metrics.map((metric) => (
        <article className="funnel-metrics-preview-card" key={metric.key}>
          <span>{metric.label}</span>
          <strong>
            {metric.value === null
              ? '—'
              : metric.kind === 'ratio'
                ? `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
                : metric.value.toLocaleString()}
          </strong>
          {metric.status !== 'available' && (
            <small>
              {metric.status === 'insufficient_data' ? 'No denominator events' : 'Awaiting events'}
            </small>
          )}
        </article>
      ))}
    </div>
  )
}

export function MetricDiagnostics({
  productId,
  funnelId,
  metrics,
  gateway,
}: {
  productId: string
  funnelId: string
  metrics: FunnelMetricDefinition[]
  gateway: FunnelMetricsGateway
}) {
  const [eventText, setEventText] = useState('')
  const [samplesText, setSamplesText] = useState('')
  const [busy, setBusy] = useState<'validate' | 'preview' | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [report, setReport] = useState<FunnelMetricReport | null>(null)
  const scope = useRef(0)
  useEffect(() => {
    scope.current += 1
    // Results from the previous remote funnel are not valid in the new scope.
    // eslint-disable-next-line react/set-state-in-effect
    setReport(null)
    setMessage('')
    setError('')
    setBusy(null)
    return () => {
      scope.current += 1
    }
  }, [productId, funnelId])
  // A sample result applies only to the definitions it was evaluated against.
  useEffect(() => {
    scope.current += 1
    // Invalidate the server-calculated preview when its definition inputs change.
    // eslint-disable-next-line react/set-state-in-effect
    setReport(null)
    setMessage('')
    setBusy(null)
  }, [metrics])

  async function run(kind: 'validate' | 'preview') {
    setError('')
    setMessage('')
    setReport(null)
    let value: unknown
    try {
      const text = kind === 'validate' ? eventText : samplesText
      if (text.length > 100_000) throw Error('Keep sample JSON below 100,000 characters.')
      value = JSON.parse(text)
      if (kind === 'validate' && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw Error('Enter one event as a JSON object.')
      if (kind === 'preview' && (!Array.isArray(value) || value.length > 100))
        throw Error('Enter a JSON array of up to 100 sample events.')
    } catch (failure) {
      setError(
        failure instanceof SyntaxError
          ? 'Enter valid JSON before testing.'
          : String((failure as Error).message),
      )
      return
    }
    const currentScope = scope.current
    setBusy(kind)
    if (kind === 'validate') {
      const result = await gateway.validateEvent({ productId, funnelId, event: value })
      if (scope.current !== currentScope) return
      if (result.data?.valid)
        setMessage(
          'Sample event structure is valid. Nothing was sent or saved. This does not verify your product connection, creator attribution or which report cards will count the event.',
        )
      else
        setError(
          result.error?.message || result.data?.errors.join(' ') || 'This sample event is invalid.',
        )
    } else {
      const result = await gateway.preview({
        productId,
        funnelId,
        metrics,
        sampleEvents: value as unknown[],
      })
      if (scope.current !== currentScope) return
      if (result.data) {
        setReport(result.data)
        setMessage('Sample preview only. No events, reports or financial values were written.')
      } else setError(result.error?.message || 'The sample report could not be calculated.')
    }
    setBusy(null)
  }
  function insertSample() {
    const eventName =
      metrics.find((metric) => metric.kind !== 'ratio')?.eventKey || 'lead_registered'
    const sample = {
      event_name: eventName,
      subject_id: 'sample_person_0001',
      occurred_at: new Date().toISOString(),
      context_id: 'sample_event',
    }
    setEventText(
      JSON.stringify(
        { ...sample, event_id: crypto.randomUUID(), click_id: 'sample_click_000001' },
        null,
        2,
      ),
    )
    setSamplesText(JSON.stringify([sample], null, 2))
    setError('')
    setMessage('')
    setReport(null)
  }
  return (
    <section
      aria-label="Test funnel metrics"
      aria-busy={Boolean(busy)}
      data-navigation-pending={Boolean(busy)}
    >
      <h4>Test with sample events</h4>
      <p className="funnel-metrics-help">
        Try fictional events against these draft cards. Insert example event only fills the boxes
        below. Validation checks the event format; preview calculates the sample cards. Neither
        saves events nor creates registrations, sales or commissions.
      </p>
      <p className="funnel-metrics-help">
        Standard v2 journey events do not need a custom card to be recorded. Custom v2 events need a
        matching published journey stage or custom card; legacy events need a published custom card.
        A sample preview does not test the full journey report or connect your product’s event
        sender.
      </p>
      <button
        type="button"
        className="admin-text-button"
        onClick={insertSample}
        disabled={Boolean(busy)}
      >
        Insert example event
      </button>
      <div className="admin-config-form-grid">
        <label className="admin-field">
          <span>Sample event JSON</span>
          <textarea
            className="funnel-metrics-sample"
            value={eventText}
            onChange={(event) => setEventText(event.target.value)}
            disabled={Boolean(busy)}
            placeholder={
              '{"event_id":"…","click_id":"…","subject_id":"…","event_name":"…","occurred_at":"…"}'
            }
          />
          <small className="admin-field-hint">
            Use fictional IDs. Never paste access keys or personal information. Presence also needs
            context_id, session_id and presence_expires_at.
          </small>
        </label>
        <label className="admin-field">
          <span>Sample events for report preview</span>
          <textarea
            className="funnel-metrics-sample"
            value={samplesText}
            onChange={(event) => setSamplesText(event.target.value)}
            disabled={Boolean(busy)}
            placeholder="[]"
          />
          <small className="admin-field-hint">
            Up to 100 events. Samples need subject_id, event_name and occurred_at; click_id and
            event_id are optional in previews.
          </small>
        </label>
      </div>
      <div className="funnel-metrics-toolbar">
        <button
          type="button"
          className="admin-secondary-button"
          disabled={Boolean(busy) || !eventText.trim()}
          onClick={() => void run('validate')}
        >
          {busy === 'validate' && <LoaderCircle size={16} className="admin-spin" />}Validate sample
          event
        </button>
        <button
          type="button"
          className="admin-secondary-button"
          disabled={Boolean(busy) || !samplesText.trim() || !metrics.length}
          onClick={() => void run('preview')}
        >
          {busy === 'preview' && <LoaderCircle size={16} className="admin-spin" />}Preview sample
          report
        </button>
      </div>
      {error && (
        <p role="alert" className="funnel-metrics-feedback">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="funnel-metrics-feedback">
          {message}
        </p>
      )}
      {report && <MetricReportCards report={report} />}
    </section>
  )
}
