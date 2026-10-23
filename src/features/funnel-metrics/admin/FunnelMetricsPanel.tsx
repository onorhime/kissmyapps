import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Plus, X } from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import { markFormSaved } from '../../../components/useFormNavigationGuard'
import { funnelMetricsGateway } from '../gateway'
import { funnelMetricTemplate, newFunnelMetric } from '../templates'
import { FUNNEL_METRIC_LIMIT, validateMetricDefinitions } from '../validation'
import type {
  FunnelMetricConfiguration,
  FunnelMetricDefinition,
  FunnelMetricTemplateKey,
  FunnelMetricsGateway,
} from '../types'
import { MetricEditor } from './MetricEditor'
import { MetricDiagnostics } from './MetricDiagnostics'
import { RecordedPerformance } from './RecordedPerformance'
import { JourneyConfiguration } from './JourneyConfiguration'
import { JourneyDefinitionEditor } from './JourneyDefinitionEditor'
import './FunnelMetrics.css'

export function FunnelMetricsPanel({
  productId,
  funnelId,
  funnelName,
  canManage,
  onClose,
  initialTemplate = 'blank',
  gateway = funnelMetricsGateway,
}: {
  productId: string
  funnelId: string
  funnelName: string
  canManage: boolean
  onClose: () => void
  initialTemplate?: FunnelMetricTemplateKey
  gateway?: FunnelMetricsGateway
}) {
  const [configuration, setConfiguration] = useState<FunnelMetricConfiguration | null>(null)
  const [metrics, setMetrics] = useState<FunnelMetricDefinition[]>([])
  const [template, setTemplate] = useState<FunnelMetricTemplateKey>('blank')
  const [templateChoice, setTemplateChoice] = useState<FunnelMetricTemplateKey>(initialTemplate)
  const [busy, setBusy] = useState<'load' | 'save' | 'publish' | null>('load')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<
    'publish' | 'template' | 'close' | 'reload' | null
  >(null)
  const [reload, setReload] = useState(0)
  const [journeyDirty, setJourneyDirty] = useState(false)
  const [journeyPending, setJourneyPending] = useState(false)
  const [journeyPublished, setJourneyPublished] = useState(0)
  const scope = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  const dirty = Boolean(
    configuration &&
    (JSON.stringify(metrics) !== JSON.stringify(configuration.draft.metrics) ||
      template !== configuration.draft.template),
  )
  const invalid = validateMetricDefinitions(metrics)

  function acceptConfiguration(value: FunnelMetricConfiguration) {
    setConfiguration(value)
    setMetrics(value.draft.metrics)
    setTemplate(value.draft.template)
    setTemplateChoice(value.draft.template)
    setConflict(false)
  }
  useEffect(() => {
    const currentScope = ++scope.current
    // Drop the previous remote scope before fetching another funnel or retrying its configuration.
    // eslint-disable-next-line react/set-state-in-effect
    setConfiguration(null)
    setMetrics([])
    setBusy('load')
    setError('')
    setNotice('')
    setConflict(false)
    setConfirmation(null)
    void gateway.getConfiguration(productId, funnelId).then((result) => {
      if (scope.current !== currentScope) return
      if (result.data) {
        acceptConfiguration(result.data)
        if (
          !result.data.draft.metrics.length &&
          !result.data.published &&
          initialTemplate !== 'blank' &&
          reload === 0
        ) {
          setMetrics(funnelMetricTemplate(initialTemplate))
          setTemplate(initialTemplate)
          setTemplateChoice(initialTemplate)
          setNotice(
            'Starter metrics are ready to edit. Save the draft, then publish when you are ready.',
          )
        }
      } else setError(result.error?.message || 'Reporting configuration could not be loaded.')
      setBusy(null)
    })
    return () => {
      scope.current += 1
    }
  }, [productId, funnelId, gateway, initialTemplate, reload])

  function edit(next: FunnelMetricDefinition[]) {
    setMetrics(next.map((metric, index) => ({ ...metric, order: index })))
    setNotice('')
    setError(conflict ? error : '')
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!configuration || !canManage || busy || conflict) return
    if (invalid.length) {
      setError(invalid.join(' '))
      return
    }
    const currentScope = scope.current
    setBusy('save')
    setError('')
    setNotice('')
    const result = await gateway.saveDraft({
      productId,
      funnelId,
      expectedRevision: configuration.draft.revision,
      template,
      metrics,
    })
    if (scope.current !== currentScope) return
    if (result.data) {
      acceptConfiguration(result.data)
      setNotice('Reporting draft saved. Creators still see the published version.')
      if (form.current) markFormSaved(form.current)
    } else {
      setError(result.error?.message || 'The draft could not be saved. Your edits are still here.')
      setConflict(result.error?.code === 'conflict')
    }
    setBusy(null)
  }
  async function publish() {
    if (
      !configuration ||
      !canManage ||
      dirty ||
      busy ||
      conflict ||
      validateMetricDefinitions(metrics, false).length
    )
      return
    const currentScope = scope.current
    setBusy('publish')
    setError('')
    setNotice('')
    setConfirmation(null)
    const result = await gateway.publish({
      productId,
      funnelId,
      expectedRevision: configuration.draft.revision,
    })
    if (scope.current !== currentScope) return
    if (result.data) {
      acceptConfiguration(result.data)
      setNotice(
        `Reporting version ${result.data.published?.version ?? ''} published. New verified events can now contribute to this version.`,
      )
      if (form.current) markFormSaved(form.current)
    } else {
      setError(result.error?.message || 'Reporting could not be published.')
      setConflict(result.error?.code === 'conflict')
    }
    setBusy(null)
  }
  function confirmAction() {
    if (confirmation === 'publish') {
      void publish()
      return
    }
    if (confirmation === 'template') {
      edit(funnelMetricTemplate(templateChoice))
      setTemplate(templateChoice)
    }
    if (confirmation === 'close') {
      if (form.current) markFormSaved(form.current)
      onClose()
    }
    if (confirmation === 'reload') {
      if (form.current) markFormSaved(form.current)
      setReload((value) => value + 1)
    }
    setConfirmation(null)
  }
  return (
    <section
      className="funnel-metrics-panel"
      aria-label={`Reporting metrics for ${funnelName}`}
      aria-busy={Boolean(busy)}
      data-navigation-pending={Boolean(busy)}
    >
      <div className="funnel-metrics-heading">
        <div>
          <h3>Reporting metrics · {funnelName}</h3>
          <p className="funnel-metrics-help">
            Choose what creators can follow for this funnel. Existing revenue, earnings and payout
            calculations stay separate.
          </p>
        </div>
        <button
          type="button"
          className="funnel-metrics-icon-button"
          aria-label="Close reporting metrics"
          disabled={Boolean(busy) || journeyPending}
          onClick={() => (dirty || journeyDirty ? setConfirmation('close') : onClose())}
        >
          <X size={18} />
        </button>
      </div>
      {busy === 'load' && (
        <p role="status">
          <LoaderCircle className="admin-spin" size={18} /> Loading reporting configuration…
        </p>
      )}
      {error && (
        <div role="alert" className="funnel-metrics-feedback">
          {error}
          {(!configuration || conflict) && (
            <div>
              <button
                type="button"
                className="admin-text-button"
                disabled={Boolean(busy)}
                onClick={() =>
                  dirty ? setConfirmation('reload') : setReload((value) => value + 1)
                }
              >
                Reload reporting draft
              </button>
            </div>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="funnel-metrics-feedback">
          {notice}
        </p>
      )}
      {configuration && (
        <>
          <div className="funnel-metrics-toolbar">
            <strong>
              {configuration.published
                ? `Published version ${configuration.published.version}`
                : 'Not published'}
            </strong>
            <span className="funnel-metrics-help">
              Draft revision {configuration.draft.revision} · {dirty ? 'Unsaved changes' : 'Saved'}
            </span>
          </div>
          <p className="funnel-metrics-help">
            Publishing starts a new reporting period for these definitions. Previous versions remain
            available in reports; events are not relabelled retroactively. Publishing metrics does
            not connect the product’s event sender.
          </p>
          {configuration.versions.length > 0 && (
            <details>
              <summary>Published versions ({configuration.versions.length})</summary>
              <ul>
                {configuration.versions.map((version) => (
                  <li key={version.version}>
                    Version {version.version} · {new Date(version.publishedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!canManage && (
            <p className="funnel-metrics-feedback">
              This configuration is read only. An authorized administrator can edit and publish
              active funnels.
            </p>
          )}
          <form
            className="funnel-metrics-form"
            ref={form}
            onSubmit={(event) => void save(event)}
            noValidate
          >
            <fieldset disabled={!canManage || Boolean(busy)}>
              <p className="funnel-metrics-help">
                These are optional custom cards for period counts or current states. Configure
                journey stages and ordered conversions in Journey definition below. Both appear in
                Recorded performance; clicks and verified earnings are always provided by KMA.
              </p>
              <div className="funnel-metrics-toolbar">
                <label className="admin-field">
                  <span>Starter template</span>
                  <select
                    value={templateChoice}
                    onChange={(event) =>
                      setTemplateChoice(event.target.value as FunnelMetricTemplateKey)
                    }
                  >
                    <option value="blank">Blank</option>
                    <option value="sales">Sales</option>
                    <option value="subscription">Subscription</option>
                    <option value="webinar">Webinar</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="admin-secondary-button"
                  onClick={() =>
                    metrics.length
                      ? setConfirmation('template')
                      : (edit(funnelMetricTemplate(templateChoice)), setTemplate(templateChoice))
                  }
                >
                  Use template
                </button>
              </div>
              <div className="funnel-metrics-list">
                {metrics.map((metric, index) => (
                  <MetricEditor
                    key={index}
                    metric={metric}
                    index={index}
                    metrics={metrics}
                    onChange={(next) =>
                      edit(metrics.map((item, position) => (position === index ? next : item)))
                    }
                    onRemove={() => edit(metrics.filter((_, position) => position !== index))}
                    onMove={(direction) => {
                      const next = [...metrics]
                      ;[next[index], next[index + direction]] = [
                        next[index + direction],
                        next[index],
                      ]
                      edit(next)
                    }}
                  />
                ))}
              </div>
              {!metrics.length && (
                <p className="funnel-metrics-help">
                  No custom metrics yet. Choose a template or add your first metric.
                </p>
              )}
              <button
                type="button"
                className="admin-secondary-button"
                disabled={metrics.length >= FUNNEL_METRIC_LIMIT}
                onClick={() => edit([...metrics, newFunnelMetric(metrics)])}
              >
                <Plus size={16} />
                Add metric
              </button>
              {invalid.length > 0 && (
                <ul className="funnel-metrics-diagnostics" aria-label="Metric validation issues">
                  {invalid.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              <div className="funnel-metrics-toolbar">
                <button
                  type="submit"
                  className="admin-primary-button"
                  disabled={!dirty || invalid.length > 0 || conflict}
                >
                  {busy === 'save' && <LoaderCircle size={16} className="admin-spin" />}
                  {busy === 'save' ? 'Saving draft…' : 'Save reporting draft'}
                </button>
                <button
                  type="button"
                  className="admin-secondary-button"
                  disabled={dirty || !metrics.length || invalid.length > 0 || conflict}
                  onClick={() => setConfirmation('publish')}
                >
                  {busy === 'publish' && <LoaderCircle size={16} className="admin-spin" />}
                  {busy === 'publish' ? 'Publishing…' : 'Publish reporting version'}
                </button>
              </div>
              {dirty && (
                <p className="funnel-metrics-help">Save these changes before publishing.</p>
              )}
            </fieldset>
          </form>
          <JourneyConfiguration funnelId={funnelId} canManage={canManage} gateway={gateway} />
          <JourneyDefinitionEditor
            key={`journey:${productId}:${funnelId}`}
            funnelId={funnelId}
            canManage={canManage}
            gateway={gateway}
            onDirtyChange={setJourneyDirty}
            onPendingChange={setJourneyPending}
            onPublished={() => setJourneyPublished((value) => value + 1)}
          />
          <RecordedPerformance
            key={`report:${productId}:${funnelId}:${journeyPublished}`}
            productId={productId}
            funnelId={funnelId}
            gateway={gateway}
          />
          <MetricDiagnostics
            key={`${productId}:${funnelId}`}
            productId={productId}
            funnelId={funnelId}
            metrics={metrics}
            gateway={gateway}
          />
        </>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={
          confirmation === 'publish'
            ? 'Publish reporting version?'
            : confirmation === 'template'
              ? 'Replace draft metrics?'
              : 'Discard unsaved changes?'
        }
        description={
          confirmation === 'publish'
            ? `${metrics.filter((metric) => metric.visible).length} creator-visible metrics will be published for this funnel. A new version starts now; previous reports remain available.`
            : confirmation === 'template'
              ? 'The selected template replaces the metrics currently in this draft. Published reports remain unchanged until you save and publish.'
              : 'Your unsaved reporting edits will be discarded. The saved draft and published reports remain unchanged.'
        }
      >
        <div className="funnel-metrics-toolbar">
          <button
            type="button"
            className="admin-secondary-button"
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </button>
          <button type="button" className="admin-primary-button" onClick={confirmAction}>
            {confirmation === 'publish'
              ? 'Publish version'
              : confirmation === 'template'
                ? 'Replace metrics'
                : confirmation === 'reload'
                  ? 'Discard and reload'
                  : 'Discard and close'}
          </button>
        </div>
      </Dialog>
    </section>
  )
}
