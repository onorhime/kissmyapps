import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { FUNNEL_METRIC_KINDS, FUNNEL_METRIC_RATIO_KINDS, metricKindLabels } from '../validation'
import type { FunnelMetricDefinition, FunnelMetricKind } from '../types'

export function MetricEditor({
  metric,
  index,
  metrics,
  onChange,
  onMove,
  onRemove,
}: {
  metric: FunnelMetricDefinition
  index: number
  metrics: FunnelMetricDefinition[]
  onChange: (metric: FunnelMetricDefinition) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}) {
  const counts = metrics
    .slice(0, index)
    .filter((item) => FUNNEL_METRIC_RATIO_KINDS.includes(item.kind))
  return (
    <section className="funnel-metrics-row" aria-label={`Metric ${index + 1}`}>
      <div className="funnel-metrics-row-heading">
        <h4>
          {index + 1}. {metric.label || 'New metric'}
        </h4>
        <div className="admin-record-actions">
          <button
            type="button"
            className="funnel-metrics-icon-button"
            aria-label={`Move metric ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="funnel-metrics-icon-button"
            aria-label={`Move metric ${index + 1} down`}
            disabled={index === metrics.length - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={16} />
          </button>
          <button
            type="button"
            className="funnel-metrics-icon-button"
            aria-label={`Remove metric ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="admin-config-form-grid">
        <label className="admin-field">
          <span>Name</span>
          <input
            maxLength={80}
            value={metric.label}
            onChange={(event) => onChange({ ...metric, label: event.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Metric key</span>
          <input
            maxLength={50}
            value={metric.key}
            onChange={(event) => onChange({ ...metric, key: event.target.value })}
          />
          <small className="admin-field-hint">A stable lowercase key, such as registrations.</small>
        </label>
        <label className="admin-field">
          <span>Counting method</span>
          <select
            value={metric.kind}
            onChange={(event) =>
              onChange({ ...metric, kind: event.target.value as FunnelMetricKind, config: {} })
            }
          >
            {FUNNEL_METRIC_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {metricKindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        {metric.kind !== 'ratio' && (
          <label className="admin-field">
            <span>Event key</span>
            <input
              maxLength={80}
              value={metric.eventKey}
              onChange={(event) => onChange({ ...metric, eventKey: event.target.value })}
            />
            <small className="admin-field-hint">Must match the event your product sends.</small>
          </label>
        )}
        {metric.kind === 'current_state' && (
          <label className="admin-field">
            <span>State to count</span>
            <input
              maxLength={50}
              value={metric.config.stateValue || ''}
              onChange={(event) =>
                onChange({ ...metric, config: { stateValue: event.target.value } })
              }
            />
            <small className="admin-field-hint">
              Uses each person’s latest state in each event or cohort. Previous states are replaced.
            </small>
          </label>
        )}
        {metric.kind === 'ratio' && (
          <>
            <label className="admin-field">
              <span>Numerator</span>
              <select
                value={metric.config.numeratorKey || ''}
                onChange={(event) =>
                  onChange({
                    ...metric,
                    config: { ...metric.config, numeratorKey: event.target.value },
                  })
                }
              >
                <option value="">Choose a count above this metric</option>
                {counts.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label || item.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-field">
              <span>Denominator</span>
              <select
                value={metric.config.denominatorKey || ''}
                onChange={(event) =>
                  onChange({
                    ...metric,
                    config: { ...metric.config, denominatorKey: event.target.value },
                  })
                }
              >
                <option value="">Choose a count above this metric</option>
                {counts.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label || item.key}
                  </option>
                ))}
              </select>
            </label>
            <p className="funnel-metrics-help admin-config-span-two">
              Numerator ÷ denominator, shown as a percentage. This can exceed 100% when the
              numerator is larger. An empty denominator shows unavailable. Keep both count metrics
              above this percentage.
            </p>
          </>
        )}
        {metric.kind === 'live_presence' && (
          <p className="funnel-metrics-help admin-config-span-two">
            Presence events require an event or cohort ID, session ID and expiry of up to five
            minutes. Multiple open tabs do not create extra people; expired sessions stop counting.
          </p>
        )}
        <label className="admin-config-check admin-config-span-two">
          <input
            type="checkbox"
            checked={metric.visible}
            onChange={(event) => onChange({ ...metric, visible: event.target.checked })}
          />
          Visible to creators
        </label>
      </div>
    </section>
  )
}
