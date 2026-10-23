import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Dialog } from '../../../components/Dialog'
import { markFormSaved, observeForm } from '../../../components/useFormNavigationGuard'
import {
  getJourneyTemplate,
  journeyDefinitionToBackend,
  JOURNEY_DEFINITION_LIMITS,
  validateJourneyDefinition,
  type JourneyDefinition,
  type JourneyDefinitionConfiguration,
  type JourneySequence,
  type JourneyStage,
} from '../journeyDefinitions'
import type { FunnelMetricsGateway } from '../types'
import './JourneyDefinitionEditor.css'

type Template = JourneyDefinitionConfiguration['draft']['template']
const emptyDefinition = (): JourneyDefinition => ({ stages: [], rates: [], paths: [] })
const nextKey = (prefix: string, existing: Array<{ key: string }>) => {
  let number = 1
  while (existing.some((item) => item.key === `${prefix}_${number}`)) number += 1
  return `${prefix}_${number}`
}
const move = <T,>(items: T[], index: number, direction: -1 | 1) => {
  const result = [...items]
  const target = index + direction
  if (target < 0 || target >= result.length) return result
  ;[result[index], result[target]] = [result[target], result[index]]
  return result
}

/** Definitions control visible journey reporting; publishing never enables money movement. */
export function JourneyDefinitionEditor({
  funnelId,
  canManage,
  gateway,
  onPublished,
  onDirtyChange,
  onPendingChange,
}: {
  funnelId: string
  canManage: boolean
  gateway: FunnelMetricsGateway
  onPublished?: () => void
  onDirtyChange?: (dirty: boolean) => void
  onPendingChange?: (pending: boolean) => void
}) {
  const [configuration, setConfiguration] = useState<JourneyDefinitionConfiguration | null>(null)
  const [definition, setDefinition] = useState<JourneyDefinition>(emptyDefinition)
  const [template, setTemplate] = useState<Template>('blank')
  const [templateChoice, setTemplateChoice] = useState<Template>('blank')
  const [busy, setBusy] = useState<'load' | 'save' | 'publish' | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [confirmation, setConfirmation] = useState<'template' | 'publish' | 'reload' | null>(null)
  const [reload, setReload] = useState(0)
  const scope = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  const dirty = Boolean(
    configuration &&
    (JSON.stringify(definition) !== JSON.stringify(configuration.draft.definition) ||
      template !== configuration.draft.template),
  )
  const invalid = validateJourneyDefinition(definition)
  const needsFirstSave = configuration?.draft.revision === 0

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    onPendingChange?.(busy === 'save' || busy === 'publish')
    return () => onPendingChange?.(false)
  }, [busy, onPendingChange])

  function accept(value: JourneyDefinitionConfiguration) {
    setConfiguration(value)
    setDefinition(value.draft.definition)
    setTemplate(value.draft.template)
    setTemplateChoice(value.draft.template)
    setConflict(false)
  }

  useEffect(() => {
    const current = ++scope.current
    // Drop the previous funnel's draft immediately; an old request cannot replace this scope.
    // eslint-disable-next-line react/set-state-in-effect
    setConfiguration(null)
    setDefinition(emptyDefinition())
    setTemplate('blank')
    setTemplateChoice('blank')
    setBusy('load')
    setError('')
    setNotice('')
    setCopyNotice('')
    setConflict(false)
    setConfirmation(null)
    if (!gateway.getJourneyDefinition) {
      setBusy(null)
      return
    }
    void gateway
      .getJourneyDefinition(funnelId)
      .then((result) => {
        if (scope.current !== current) return
        if (result.data && result.data.funnelId === funnelId) accept(result.data)
        else setError(result.error?.message || 'Journey definitions could not be loaded.')
        setBusy(null)
      })
      .catch(() => {
        if (scope.current === current) {
          setError('Journey definitions could not be loaded. Try again.')
          setBusy(null)
        }
      })
    return () => {
      scope.current += 1
    }
  }, [funnelId, gateway, reload])

  function edit(value: JourneyDefinition) {
    observeForm(form.current)
    setDefinition(value)
    setTemplate('custom')
    setNotice('')
    setCopyNotice('')
    if (!conflict) setError('')
  }

  function editStage(index: number, stage: JourneyStage) {
    const previousKey = definition.stages[index].key
    const rename = (sequences: JourneySequence[]) =>
      sequences.map((sequence) => ({
        ...sequence,
        steps: sequence.steps.map((step) => (step === previousKey ? stage.key : step)),
      }))
    edit({
      stages: definition.stages.map((value, position) => (position === index ? stage : value)),
      rates: rename(definition.rates),
      paths: rename(definition.paths),
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!configuration || !canManage || busy || conflict || !gateway.saveJourneyDefinition) return
    if (invalid.length) {
      setError(invalid.join(' '))
      return
    }
    const current = scope.current
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const result = await gateway.saveJourneyDefinition({
        funnelId,
        expectedRevision: configuration.draft.revision,
        template,
        definition,
      })
      if (scope.current !== current) return
      if (result.data && result.data.funnelId === funnelId) {
        accept(result.data)
        setNotice('Journey draft saved. Creators still see the published journey.')
        markFormSaved(form.current)
      } else {
        setError(
          result.error?.message || 'Journey draft could not be saved. Your edits are still here.',
        )
        setConflict(result.error?.code === 'conflict')
      }
    } catch {
      if (scope.current === current)
        setError('Journey draft could not be saved. Your edits are still here.')
    } finally {
      if (scope.current === current) setBusy(null)
    }
  }

  async function publish() {
    if (
      !configuration ||
      !canManage ||
      busy ||
      conflict ||
      dirty ||
      needsFirstSave ||
      invalid.length ||
      !gateway.publishJourneyDefinition
    )
      return
    const current = scope.current
    setConfirmation(null)
    setBusy('publish')
    setError('')
    setNotice('')
    try {
      const result = await gateway.publishJourneyDefinition({
        funnelId,
        expectedRevision: configuration.draft.revision,
      })
      if (scope.current !== current) return
      if (result.data && result.data.funnelId === funnelId) {
        accept(result.data)
        setNotice(
          `Journey version ${result.data.published?.version ?? ''} published. Reload the recorded report to see this configuration.`,
        )
        markFormSaved(form.current)
        onPublished?.()
      } else {
        setError(result.error?.message || 'Journey could not be published.')
        setConflict(result.error?.code === 'conflict')
      }
    } catch {
      if (scope.current === current) setError('Journey could not be published. Try again.')
    } finally {
      if (scope.current === current) setBusy(null)
    }
  }

  function confirmAction() {
    if (confirmation === 'publish') {
      void publish()
      return
    }
    if (confirmation === 'template') {
      observeForm(form.current)
      setDefinition(getJourneyTemplate(templateChoice))
      setTemplate(templateChoice)
      setNotice('Template applied to this draft only. Review the event keys, save, then publish.')
      setError('')
      setCopyNotice('')
    }
    if (confirmation === 'reload') {
      markFormSaved(form.current)
      setReload((value) => value + 1)
    }
    setConfirmation(null)
  }

  const developerSpecification = JSON.stringify(
    {
      funnel_id: funnelId,
      draft_revision: configuration?.draft.revision ?? 0,
      published_version: configuration?.published?.version ?? null,
      unsaved_changes: dirty,
      definition: journeyDefinitionToBackend(definition),
    },
    null,
    2,
  )

  async function copySpecification() {
    const current = scope.current
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable')
      await navigator.clipboard.writeText(developerSpecification)
      if (scope.current === current)
        setCopyNotice(
          'Draft specification copied. This does not send events or publish the journey.',
        )
    } catch {
      if (scope.current === current)
        setCopyNotice('Clipboard access is unavailable. Select and copy the JSON below.')
    }
  }

  return (
    <details className="admin-config-subpanel journey-definition-editor" open>
      <summary>Journey stages and conversion paths</summary>
      <p>
        Define the journey for this product: the stages creators see, the conversions measured, and
        the paths people take. Templates fill this editor with editable definitions. Clicks,
        verified orders, refunds and earnings are standard KMA reporting.
      </p>
      <p>
        Creating a stage does not connect your product. Your developer must send the exact event
        keys shown here from your product using its authenticated integration. A card label can be
        any name you choose. Creators see published results; they do not configure tracking.
      </p>
      {!gateway.getJourneyDefinition ? (
        <p role="status">Journey definitions are not available in this environment yet.</p>
      ) : (
        <>
          {busy === 'load' && <p role="status">Loading journey definitions…</p>}
          {error && (
            <p className="funnel-metrics-feedback" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="funnel-metrics-feedback" role="status">
              {notice}
            </p>
          )}
          {configuration && (
            <>
              <p>
                {configuration.published
                  ? `Published journey version ${configuration.published.version} · Draft revision ${configuration.draft.revision}`
                  : `No journey published · Draft revision ${configuration.draft.revision}`}
                {!canManage && ' · Read-only access'}
              </p>
              <form ref={form} onSubmit={save} aria-busy={busy === 'save' || busy === 'publish'}>
                <fieldset disabled={!canManage || Boolean(busy) || conflict}>
                  <legend>Journey definition</legend>
                  <div className="funnel-metrics-toolbar">
                    <label className="admin-field">
                      Journey template
                      <select
                        value={templateChoice}
                        onChange={(event) => setTemplateChoice(event.target.value as Template)}
                      >
                        <option value="blank">Blank — define your own journey</option>
                        <option value="sales">Sales journey</option>
                        <option value="webinar">Webinar and assessment journey</option>
                        {templateChoice === 'custom' && (
                          <option value="custom">Custom draft</option>
                        )}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="admin-secondary-button"
                      disabled={templateChoice === 'custom'}
                      onClick={() => setConfirmation('template')}
                    >
                      Apply journey template
                    </button>
                  </div>
                  <h4>Stages</h4>
                  <p>
                    Each stage counts distinct people. Optional state matching uses the latest
                    accepted state for that person and context, such as a confirmed attendance
                    status.
                  </p>
                  {!definition.stages.length && (
                    <p>No stages yet. Add one or explicitly apply a template.</p>
                  )}
                  <div className="journey-definition-list">
                    {definition.stages.map((stage, index) => (
                      <StageEditor
                        key={index}
                        stage={stage}
                        index={index}
                        onChange={(value) => editStage(index, value)}
                        onRemove={() =>
                          edit({
                            ...definition,
                            stages: definition.stages.filter((_, position) => position !== index),
                          })
                        }
                        onMove={(direction) =>
                          edit({ ...definition, stages: move(definition.stages, index, direction) })
                        }
                        total={definition.stages.length}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="admin-secondary-button"
                    disabled={definition.stages.length >= JOURNEY_DEFINITION_LIMITS.stages}
                    onClick={() =>
                      edit({
                        ...definition,
                        stages: [
                          ...definition.stages,
                          {
                            key: nextKey('stage', definition.stages),
                            label: 'New stage',
                            source: 'event',
                            eventNames: [''],
                          },
                        ],
                      })
                    }
                  >
                    Add journey stage
                  </button>
                  <SequencesEditor
                    title="Conversion rates"
                    kind="rate"
                    value={definition.rates}
                    stages={definition.stages}
                    onChange={(rates) => edit({ ...definition, rates })}
                  />
                  <SequencesEditor
                    title="Journey paths"
                    kind="path"
                    value={definition.paths}
                    stages={definition.stages}
                    onChange={(paths) => edit({ ...definition, paths })}
                  />
                  <p>
                    Steps must happen in order for the same person within the reporting window. A
                    repeated context field requires the same context value across those steps. Rates
                    divide people completing every step by people reaching the first step. Paths
                    count people independently, so one person can complete multiple paths.
                  </p>
                  {invalid.length > 0 && (
                    <ul
                      className="funnel-metrics-diagnostics"
                      aria-label="Journey validation issues"
                    >
                      {invalid.map((issue, index) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <div className="funnel-metrics-toolbar">
                    <button
                      type="submit"
                      className="admin-primary-button"
                      disabled={
                        (!dirty && !needsFirstSave) ||
                        invalid.length > 0 ||
                        !gateway.saveJourneyDefinition
                      }
                    >
                      {busy === 'save' ? 'Saving journey draft…' : 'Save journey draft'}
                    </button>
                    <button
                      type="button"
                      className="admin-secondary-button"
                      disabled={
                        dirty ||
                        needsFirstSave ||
                        invalid.length > 0 ||
                        !gateway.publishJourneyDefinition
                      }
                      onClick={() => setConfirmation('publish')}
                    >
                      {busy === 'publish' ? 'Publishing journey…' : 'Publish journey version'}
                    </button>
                  </div>
                  {needsFirstSave ? (
                    <p>
                      Save this new journey draft first, even if you want to publish a blank
                      journey.
                    </p>
                  ) : (
                    dirty && <p>Save these journey changes before publishing.</p>
                  )}
                </fieldset>
              </form>
              <details className="journey-definition-integration">
                <summary>Event keys for your developer</summary>
                <p>
                  This is the current draft specification. Publish it before sending new custom
                  events. Your backend sends signed events with a unique event ID, occurrence time,
                  stable person reference and Test/Live environment. Keep API secrets on the server.
                  Purchase stages use KMA’s verified order records and cannot be supplied as custom
                  events.
                </p>
                <p>
                  Include each required state and context value in the event. An event can be
                  accepted without qualifying for a stage when its required values are missing or do
                  not match. A context field repeated across a path links those steps to the same
                  context, such as the same webinar or assessment attempt.
                </p>
                <div className="journey-definition-table-scroll">
                  <table>
                    <caption>Draft event requirements</caption>
                    <thead>
                      <tr>
                        <th>Stage</th>
                        <th>Event keys / source</th>
                        <th>Required state</th>
                        <th>Context field</th>
                      </tr>
                    </thead>
                    <tbody>
                      {definition.stages.map((stage, index) => (
                        <tr key={index}>
                          <th scope="row">{stage.label}</th>
                          <td>
                            {stage.source === 'purchase'
                              ? 'Verified KMA purchase — no custom event'
                              : (stage.eventNames ?? []).map((name, position) => (
                                  <code key={position}>{name || '(event key needed)'}</code>
                                ))}
                          </td>
                          <td>{stage.stateValue || 'Any'}</td>
                          <td>{stage.contextField || 'None'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  className="admin-secondary-button"
                  onClick={() => void copySpecification()}
                >
                  Copy journey specification
                </button>
                {copyNotice && <p role="status">{copyNotice}</p>}
                <label className="admin-field">
                  Draft specification JSON — configuration, not an event payload
                  <textarea
                    className="funnel-metrics-sample"
                    value={developerSpecification}
                    readOnly
                    spellCheck={false}
                  />
                </label>
              </details>
            </>
          )}
          <button
            type="button"
            className="admin-text-button"
            disabled={Boolean(busy)}
            onClick={() => (dirty ? setConfirmation('reload') : setReload((value) => value + 1))}
          >
            Reload journey draft
          </button>
        </>
      )}
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title={
          confirmation === 'publish'
            ? 'Publish this journey?'
            : confirmation === 'template'
              ? 'Replace journey draft?'
              : 'Discard journey edits?'
        }
        description={
          confirmation === 'publish'
            ? 'This becomes the default journey calculation, including previously accepted events in the selected audience. Event records remain unchanged and earlier journey versions stay available. This does not enable checkout, payouts or your product integration.'
            : confirmation === 'template'
              ? 'This replaces the stages, rates and paths in the current draft. The published journey and custom reporting cards stay unchanged until you publish the journey.'
              : 'Your unsaved journey edits will be discarded and the latest saved draft loaded.'
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
              ? 'Publish journey'
              : confirmation === 'template'
                ? 'Replace journey draft'
                : 'Discard and reload journey'}
          </button>
        </div>
      </Dialog>
    </details>
  )
}

function StageEditor({
  stage,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  stage: JourneyStage
  index: number
  total: number
  onChange: (stage: JourneyStage) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}) {
  return (
    <section className="journey-definition-row" aria-label={`Journey stage ${index + 1}`}>
      <div className="funnel-metrics-row-heading">
        <h5>Stage {index + 1}</h5>
        <div className="journey-definition-actions">
          <button
            type="button"
            className="admin-text-button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Move stage up
          </button>
          <button
            type="button"
            className="admin-text-button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            Move stage down
          </button>
          <button type="button" className="admin-text-button" onClick={onRemove}>
            Remove stage
          </button>
        </div>
      </div>
      <div className="admin-config-form-grid">
        <label className="admin-field">
          Stage name
          <input
            maxLength={JOURNEY_DEFINITION_LIMITS.labelLength}
            value={stage.label}
            onChange={(event) => onChange({ ...stage, label: event.target.value })}
          />
        </label>
        <label className="admin-field">
          Stage key
          <input
            maxLength={JOURNEY_DEFINITION_LIMITS.keyLength}
            value={stage.key}
            onChange={(event) => onChange({ ...stage, key: event.target.value })}
          />
        </label>
        <label className="admin-field">
          Data source
          <select
            value={stage.source}
            onChange={(event) =>
              onChange(
                event.target.value === 'purchase'
                  ? { key: stage.key, label: stage.label, source: 'purchase' }
                  : { key: stage.key, label: stage.label, source: 'event', eventNames: [''] },
              )
            }
          >
            <option value="event">Product event</option>
            <option value="purchase">Verified purchase</option>
          </select>
        </label>
        {stage.source === 'event' && (
          <>
            <label className="admin-field">
              Required state (optional)
              <input
                value={stage.stateValue ?? ''}
                placeholder="Any state"
                onChange={(event) => {
                  const { stateValue: _, ...rest } = stage
                  onChange(event.target.value ? { ...rest, stateValue: event.target.value } : rest)
                }}
              />
            </label>
            <label className="admin-field">
              Context field
              <select
                value={stage.contextField ?? ''}
                onChange={(event) => {
                  const { contextField: _, ...rest } = stage
                  onChange(
                    event.target.value
                      ? {
                          ...rest,
                          contextField: event.target.value as JourneyStage['contextField'],
                        }
                      : rest,
                  )
                }}
              >
                <option value="">No context constraint</option>
                <option value="context_id">Context ID</option>
                <option value="webinar_id">Webinar ID</option>
                <option value="intake_id">Intake ID</option>
                <option value="assessment_attempt_id">Assessment attempt ID</option>
              </select>
            </label>
          </>
        )}
      </div>
      {stage.source === 'event' ? (
        <div className="journey-definition-event-list">
          {(stage.eventNames ?? []).map((name, eventIndex) => (
            <div className="journey-definition-step" key={eventIndex}>
              <label className="admin-field">
                Event key {eventIndex + 1}
                <input
                  value={name}
                  placeholder="e.g. trial_started"
                  onChange={(event) =>
                    onChange({
                      ...stage,
                      eventNames: stage.eventNames?.map((value, position) =>
                        position === eventIndex ? event.target.value : value,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="admin-text-button"
                onClick={() =>
                  onChange({
                    ...stage,
                    eventNames: stage.eventNames?.filter((_, position) => position !== eventIndex),
                  })
                }
              >
                Remove event key {eventIndex + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="admin-text-button"
            disabled={(stage.eventNames?.length ?? 0) >= JOURNEY_DEFINITION_LIMITS.eventNames}
            onClick={() => onChange({ ...stage, eventNames: [...(stage.eventNames ?? []), ''] })}
          >
            Add event key
          </button>
          <p>
            Any of these exact event keys can satisfy this stage. Stage keys label configuration;
            event keys match what your product sends.
          </p>
        </div>
      ) : (
        <p>
          KMA counts confirmed paid orders belonging to this funnel. A product event cannot create a
          purchase or commission.
        </p>
      )}
    </section>
  )
}

function SequencesEditor({
  title,
  kind,
  value,
  stages,
  onChange,
}: {
  title: string
  kind: 'rate' | 'path'
  value: JourneySequence[]
  stages: JourneyStage[]
  onChange: (value: JourneySequence[]) => void
}) {
  function edit(index: number, sequence: JourneySequence) {
    onChange(value.map((item, position) => (position === index ? sequence : item)))
  }
  return (
    <section className="journey-definition-sequences" aria-label={title}>
      <h4>{title}</h4>
      <p>
        {kind === 'rate'
          ? 'Measure the share of people who progress through an ordered sequence.'
          : 'Count people who complete a particular sequence, such as trial → activation → purchase.'}
      </p>
      <div className="journey-definition-list">
        {value.map((sequence, index) => (
          <section
            key={index}
            className="journey-definition-row"
            aria-label={`Journey ${kind} ${index + 1}`}
          >
            <div className="funnel-metrics-row-heading">
              <h5>
                {kind === 'rate' ? 'Rate' : 'Path'} {index + 1}
              </h5>
              <div className="journey-definition-actions">
                <button
                  type="button"
                  className="admin-text-button"
                  disabled={index === 0}
                  onClick={() => onChange(move(value, index, -1))}
                >
                  Move {kind} up
                </button>
                <button
                  type="button"
                  className="admin-text-button"
                  disabled={index === value.length - 1}
                  onClick={() => onChange(move(value, index, 1))}
                >
                  Move {kind} down
                </button>
                <button
                  type="button"
                  className="admin-text-button"
                  onClick={() => onChange(value.filter((_, position) => position !== index))}
                >
                  Remove {kind}
                </button>
              </div>
            </div>
            <div className="admin-config-form-grid">
              <label className="admin-field">
                {kind === 'rate' ? 'Rate name' : 'Path name'}
                <input
                  maxLength={JOURNEY_DEFINITION_LIMITS.labelLength}
                  value={sequence.label}
                  onChange={(event) => edit(index, { ...sequence, label: event.target.value })}
                />
              </label>
              <label className="admin-field">
                {kind === 'rate' ? 'Rate key' : 'Path key'}
                <input
                  maxLength={JOURNEY_DEFINITION_LIMITS.keyLength}
                  value={sequence.key}
                  onChange={(event) => edit(index, { ...sequence, key: event.target.value })}
                />
              </label>
            </div>
            <ol className="journey-definition-steps">
              {sequence.steps.map((step, stepIndex) => (
                <li key={stepIndex} className="journey-definition-step">
                  <label className="admin-field">
                    Step {stepIndex + 1}
                    <select
                      value={step}
                      onChange={(event) =>
                        edit(index, {
                          ...sequence,
                          steps: sequence.steps.map((item, position) =>
                            position === stepIndex ? event.target.value : item,
                          ),
                        })
                      }
                    >
                      <option value="">Choose a stage</option>
                      {step && !stages.some((stage) => stage.key === step) && (
                        <option value={step}>Missing stage: {step}</option>
                      )}
                      {stages.map((stage, position) => (
                        <option key={position} value={stage.key}>
                          {stage.label} ({stage.key})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="journey-definition-actions">
                    <button
                      type="button"
                      className="admin-text-button"
                      disabled={stepIndex === 0}
                      onClick={() =>
                        edit(index, { ...sequence, steps: move(sequence.steps, stepIndex, -1) })
                      }
                    >
                      Move step {stepIndex + 1} up
                    </button>
                    <button
                      type="button"
                      className="admin-text-button"
                      disabled={stepIndex === sequence.steps.length - 1}
                      onClick={() =>
                        edit(index, { ...sequence, steps: move(sequence.steps, stepIndex, 1) })
                      }
                    >
                      Move step {stepIndex + 1} down
                    </button>
                    <button
                      type="button"
                      className="admin-text-button"
                      onClick={() =>
                        edit(index, {
                          ...sequence,
                          steps: sequence.steps.filter((_, position) => position !== stepIndex),
                        })
                      }
                    >
                      Remove step {stepIndex + 1}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="admin-text-button"
              disabled={sequence.steps.length >= JOURNEY_DEFINITION_LIMITS.steps}
              onClick={() => edit(index, { ...sequence, steps: [...sequence.steps, ''] })}
            >
              Add step
            </button>
          </section>
        ))}
      </div>
      <button
        type="button"
        className="admin-secondary-button"
        disabled={value.length >= JOURNEY_DEFINITION_LIMITS[kind === 'rate' ? 'rates' : 'paths']}
        onClick={() =>
          onChange([
            ...value,
            {
              key: nextKey(kind, value),
              label: kind === 'rate' ? 'New conversion rate' : 'New journey path',
              steps: ['', ''],
            },
          ])
        }
      >
        Add {kind === 'rate' ? 'conversion rate' : 'journey path'}
      </button>
    </section>
  )
}
