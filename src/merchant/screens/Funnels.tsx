import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, ListFilter, Plus, Trash2, X } from 'lucide-react'
import { api } from '../api'
import type {
  Funnel,
  FunnelBreakdown,
  FunnelDefinition,
  FunnelMatch,
  FunnelOptions,
  FunnelPerson,
  FunnelReport,
  FunnelStep,
  FunnelWindow,
  Platform,
  Project,
  Range,
} from '../api'
import {
  countryName,
  deviceTypeLabels,
  formatAgo,
  formatCount,
  formatDuration,
  formatPercent,
  placeLabel,
  platformLabels,
  plural,
  timeIn,
} from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href, navigate } from '../routes'
import { useStore } from '../store'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import {
  Dialog,
  Empty,
  ErrorNote,
  Field,
  PageHeader,
  Panel,
  PersonCell,
  Segmented,
  Select,
  ShowMore,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

const MAX_STEPS = 10

const windowLabels: Record<FunnelWindow, string> = {
  1800: '30 minutes',
  3600: '1 hour',
  86400: '1 day',
  604800: '7 days',
  2592000: '30 days',
}

const windowOptions = (Object.keys(windowLabels) as `${FunnelWindow}`[]).map((value) => ({
  value,
  label: windowLabels[Number(value) as FunnelWindow],
}))

const matchOptions: Array<{ value: FunnelMatch; label: string }> = [
  { value: 'is', label: 'is' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'contains', label: 'contains' },
]

type GroupBy = Exclude<FunnelBreakdown, 'none'>

const groupOptions: Array<{ value: GroupBy; label: string }> = [
  { value: 'device', label: 'By device' },
  { value: 'platform', label: 'By platform' },
  { value: 'country', label: 'By country' },
  { value: 'browser', label: 'By browser' },
  { value: 'source', label: 'By source' },
]

const groupNouns: Record<GroupBy, string> = {
  device: 'Device',
  platform: 'Platform',
  country: 'Country',
  browser: 'Browser',
  source: 'Source',
}

function groupLabel(groupBy: GroupBy, key: string): string {
  if (key === 'Unknown') return 'Unknown'
  if (groupBy === 'country') return countryName(key)
  if (groupBy === 'device') return deviceTypeLabels[key] ?? key
  if (groupBy === 'platform') return platformLabels[key as Platform] ?? key
  return key
}

/** What a page step is called here: web projects have pages, apps have screens. */
function pageNoun(project: Project): string {
  const web = project.platforms.includes('web')
  const app = project.platforms.some((platform) => platform === 'ios' || platform === 'android')
  return web && app ? 'Page or screen' : app ? 'Screen' : 'Page'
}

function StepName({ step, noun }: { step: FunnelStep; noun: string }) {
  return (
    <>
      {step.label ? (
        step.label
      ) : step.kind === 'event' ? (
        <span className="mc-mono">{step.event}</span>
      ) : (
        <>
          {noun} {matchOptions.find((option) => option.value === step.match)?.label}{' '}
          <span className="mc-mono">{step.value}</span>
        </>
      )}
      {step.filter && (
        <span className="mc-muted">
          {' '}
          where <span className="mc-mono">{step.filter.property}</span> is{' '}
          <span className="mc-mono">{step.filter.value}</span>
        </span>
      )}
    </>
  )
}

function stepText(step: FunnelStep, noun: string): string {
  const base =
    step.label ??
    (step.kind === 'event'
      ? step.event
      : `${noun} ${matchOptions.find((option) => option.value === step.match)?.label} ${step.value}`)
  return step.filter ? `${base} where ${step.filter.property} is ${step.filter.value}` : base
}

/** Steps in one key order, so a saved funnel and the same steps in the builder share reports. */
function normalStep(step: FunnelStep): FunnelStep {
  const extra = {
    ...(step.label ? { label: step.label } : {}),
    ...(step.filter
      ? { filter: { property: step.filter.property, value: step.filter.value } }
      : {}),
  }
  return step.kind === 'event'
    ? { kind: 'event', event: step.event, ...extra }
    : { kind: 'screen', match: step.match, value: step.value, ...extra }
}

function definitionOf(funnel: Funnel): FunnelDefinition {
  return { steps: funnel.steps.map(normalStep), window_seconds: funnel.window_seconds }
}

// The builder -------------------------------------------------------------------------

type DraftStep = {
  id: number
  kind: 'event' | 'screen'
  event: string
  match: FunnelMatch
  value: string
  filtered: boolean
  property: string
  wanted: string
  label?: string
}

type Draft = { name: string; steps: DraftStep[]; window: FunnelWindow }

/** The step picker's choice: an event, or a page matched one of three ways. */
type StepKind = 'event' | `screen:${FunnelMatch}`

let draftIds = 0

function blankStep(): DraftStep {
  draftIds += 1
  return {
    id: draftIds,
    kind: 'screen',
    event: '',
    match: 'is',
    value: '',
    filtered: false,
    property: '',
    wanted: '',
  }
}

function draftOf(funnel: Funnel): Draft {
  return {
    name: funnel.name,
    window: funnel.window_seconds,
    steps: funnel.steps.map((step) => ({
      ...blankStep(),
      kind: step.kind,
      event: step.kind === 'event' ? step.event : '',
      match: step.kind === 'screen' ? step.match : 'is',
      value: step.kind === 'screen' ? step.value : '',
      filtered: Boolean(step.filter),
      property: step.filter?.property ?? '',
      wanted: step.filter?.value ?? '',
      label: step.label,
    })),
  }
}

/** The step as it is saved, or what it still needs. */
function readStep(draft: DraftStep): { step: FunnelStep } | { problem: string } {
  const filter = draft.filtered
    ? { property: draft.property.trim(), value: draft.wanted.trim() }
    : undefined
  let problem: string | null = null
  if (draft.kind === 'event') {
    const event = draft.event.trim()
    if (!event) problem = 'Choose an event.'
    else if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(event))
      problem = 'Event names start with a letter and use letters, numbers, _ . : or -.'
  } else if (!draft.value.trim()) {
    problem = 'Enter the address to match.'
  }
  if (!problem && filter && (!filter.property || !filter.value))
    problem = 'Give the filter a property and a value, or remove it.'
  if (problem) return { problem }
  const extra = { ...(draft.label ? { label: draft.label } : {}), ...(filter ? { filter } : {}) }
  return {
    step: normalStep(
      draft.kind === 'event'
        ? { kind: 'event', event: draft.event.trim(), ...extra }
        : { kind: 'screen', match: draft.match, value: draft.value.trim(), ...extra },
    ),
  }
}

/** The value once it has stopped changing for a moment, so typing does not run a report per key. */
function useSettled(value: string, delay = 400): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (value === settled) return
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, settled, delay])
  return settled
}

function StepEditor({
  step,
  index,
  count,
  noun,
  options,
  lists,
  problem,
  onChange,
  onMove,
  onRemove,
}: {
  step: DraftStep
  index: number
  count: number
  noun: string
  options: FunnelOptions | undefined
  lists: { events: string; screens: string }
  problem: string | null
  onChange: (step: DraftStep) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const id = useId()
  const number = index + 1
  const properties =
    step.kind === 'event'
      ? (options?.properties[step.event.trim()] ?? [])
      : [...(options?.properties.page_viewed ?? []), ...(options?.properties.screen_viewed ?? [])]
  const values = properties.find((property) => property.key === step.property.trim())?.values ?? []
  return (
    <li className="mc-step-edit">
      <span className="mc-step-num mc-num" aria-hidden="true">
        {number}
      </span>
      <div className="mc-step-fields">
        <div className="mc-step-line">
          <Select
            label={`Step ${number} is`}
            hideLabel
            value={step.kind === 'event' ? 'event' : (`screen:${step.match}` as StepKind)}
            onChange={(kind) =>
              onChange(
                kind === 'event'
                  ? { ...step, kind: 'event' }
                  : { ...step, kind: 'screen', match: kind.slice(7) as FunnelMatch },
              )
            }
            options={[
              ...matchOptions.map((option) => ({
                value: `screen:${option.value}` as StepKind,
                label: `${noun} ${option.label}`,
              })),
              { value: 'event', label: 'Event' },
            ]}
          />
          {step.kind === 'event' ? (
            <input
              className="mc-input mc-mono"
              list={lists.events}
              aria-label={`Step ${number} event`}
              aria-invalid={problem ? true : undefined}
              placeholder="Event name"
              autoComplete="off"
              spellCheck={false}
              maxLength={80}
              value={step.event}
              onChange={(event) => onChange({ ...step, event: event.target.value })}
            />
          ) : (
            <input
              className="mc-input mc-mono"
              list={lists.screens}
              aria-label={`Step ${number} ${noun.toLowerCase()}`}
              aria-invalid={problem ? true : undefined}
              placeholder="/pricing"
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              value={step.value}
              onChange={(event) => onChange({ ...step, value: event.target.value })}
            />
          )}
        </div>
        {step.filtered && (
          <div className="mc-step-line">
            <span className="mc-muted">where</span>
            <input
              className="mc-input mc-mono"
              list={`${id}-properties`}
              aria-label={`Step ${number} property`}
              placeholder="property"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              value={step.property}
              onChange={(event) => onChange({ ...step, property: event.target.value })}
            />
            <span className="mc-muted">is</span>
            <input
              className="mc-input mc-mono"
              list={`${id}-values`}
              aria-label={`Step ${number} property value`}
              placeholder="value"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={step.wanted}
              onChange={(event) => onChange({ ...step, wanted: event.target.value })}
            />
            <datalist id={`${id}-properties`}>
              {properties.map((property) => (
                <option key={property.key} value={property.key} />
              ))}
            </datalist>
            <datalist id={`${id}-values`}>
              {values.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </div>
        )}
        {problem && <p className="mc-field-error">{problem}</p>}
      </div>
      <div className="mc-step-tools">
        <button
          type="button"
          className="mc-icon-btn"
          aria-pressed={step.filtered}
          aria-label={
            step.filtered ? `Remove the filter from step ${number}` : `Filter step ${number}`
          }
          title={step.filtered ? 'Remove the filter' : 'Only count it with a property value'}
          onClick={() => onChange({ ...step, filtered: !step.filtered })}
        >
          <ListFilter size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mc-icon-btn"
          aria-label={`Move step ${number} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mc-icon-btn"
          aria-label={`Move step ${number} down`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mc-icon-btn"
          aria-label={`Remove step ${number}`}
          disabled={count <= 2}
          onClick={onRemove}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

function FunnelBuilder({
  isNew,
  draft,
  onChange,
  noun,
  options,
  showProblems,
  saving,
  saveError,
  onSave,
  onCancel,
}: {
  isNew: boolean
  draft: Draft
  onChange: (draft: Draft) => void
  noun: string
  options: FunnelOptions | undefined
  showProblems: boolean
  saving: boolean
  saveError: string | null
  onSave: () => void
  onCancel: () => void
}) {
  const id = useId()
  const lists = { events: `${id}-events`, screens: `${id}-screens` }
  const setStep = (index: number, step: DraftStep) =>
    onChange({ ...draft, steps: draft.steps.map((item, at) => (at === index ? step : item)) })
  const move = (index: number, by: -1 | 1) => {
    const steps = [...draft.steps]
    const [step] = steps.splice(index, 1)
    steps.splice(index + by, 0, step)
    onChange({ ...draft, steps })
  }
  return (
    <Panel
      title={isNew ? 'Build a funnel' : 'Edit the funnel'}
      description="People count from the first time they do step 1 in the range. Each later step has to come after the one before it."
      id="mc-funnel-builder"
    >
      <form
        className="mc-form-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
      >
        <Field
          label="Name"
          error={showProblems && !draft.name.trim() ? 'Name the funnel.' : undefined}
        >
          {(props) => (
            <input
              {...props}
              maxLength={80}
              placeholder="Pricing to purchase"
              value={draft.name}
              onChange={(event) => onChange({ ...draft, name: event.target.value })}
            />
          )}
        </Field>
        <fieldset className="mc-steps-edit">
          <legend>Steps, in order</legend>
          <ol>
            {draft.steps.map((step, index) => {
              const read = readStep(step)
              return (
                <StepEditor
                  key={step.id}
                  step={step}
                  index={index}
                  count={draft.steps.length}
                  noun={noun}
                  options={options}
                  lists={lists}
                  problem={showProblems && 'problem' in read ? read.problem : null}
                  onChange={(next) => setStep(index, next)}
                  onMove={(by) => move(index, by)}
                  onRemove={() =>
                    onChange({ ...draft, steps: draft.steps.filter((_, at) => at !== index) })
                  }
                />
              )
            })}
          </ol>
          {draft.steps.length < MAX_STEPS ? (
            <button
              type="button"
              className="mc-btn mc-btn-quiet mc-self-start"
              onClick={() => onChange({ ...draft, steps: [...draft.steps, blankStep()] })}
            >
              <Plus size={16} aria-hidden="true" /> Add a step
            </button>
          ) : (
            <p className="mc-field-hint">A funnel can have up to {MAX_STEPS} steps.</p>
          )}
          <datalist id={lists.events}>
            {(options?.events ?? []).map((event) => (
              <option key={event.name} value={event.name}>
                {event.description ?? ''}
              </option>
            ))}
          </datalist>
          <datalist id={lists.screens}>
            {(options?.screens ?? []).map((screen) => (
              <option key={screen.screen} value={screen.screen}>
                {plural(screen.users, 'person', 'people')} in 30 days
              </option>
            ))}
          </datalist>
        </fieldset>
        <div className="mc-field">
          <Select
            label="Finish within"
            value={String(draft.window) as `${FunnelWindow}`}
            onChange={(value) => onChange({ ...draft, window: Number(value) as FunnelWindow })}
            options={windowOptions}
          />
          <p className="mc-field-hint">
            Counted from step 1. Anyone slower counts as stopping at their last step.
          </p>
        </div>
        {saveError && (
          <p className="mc-form-error" role="alert">
            {saveError}
          </p>
        )}
        <div className="mc-form-actions">
          <button type="button" className="mc-btn mc-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="mc-btn mc-btn-primary" disabled={saving}>
            {isNew ? 'Save funnel' : 'Save changes'}
          </button>
        </div>
      </form>
    </Panel>
  )
}

// The report --------------------------------------------------------------------------

type StepRow = {
  index: number
  step: FunnelStep
  people: number
  dropped: number | null
  median: number | null
}

type Drill = { step: number; outcome: 'reached' | 'dropped' }

/** The steps for everyone, or for one group of the breakdown. */
function stepRows(report: FunnelReport, focus: string | null): StepRow[] {
  const group = focus ? report.breakdown.find((item) => item.key === focus) : undefined
  return report.steps.map((step, at) => {
    if (!group)
      return {
        index: step.index,
        step: step.step,
        people: step.people,
        dropped: step.dropped,
        median: step.median_seconds,
      }
    const people = group.steps[at] ?? 0
    return {
      index: step.index,
      step: step.step,
      people,
      dropped: at < group.steps.length - 1 ? people - (group.steps[at + 1] ?? 0) : null,
      median: null,
    }
  })
}

/** The step most people stop after, as a share of those who reached it. */
function biggestDrop(rows: Array<{ index: number; people: number; dropped: number | null }>) {
  let best: { index: number; share: number } | null = null
  for (const row of rows) {
    if (!row.dropped || !row.people) continue
    const share = row.dropped / row.people
    if (!best || share > best.share) best = { index: row.index, share }
  }
  return best
}

function countsDrop(counts: number[]) {
  return biggestDrop(
    counts.map((people, at) => ({
      index: at + 1,
      people,
      dropped: at < counts.length - 1 ? people - counts[at + 1] : null,
    })),
  )
}

function FunnelLead({
  rows,
  range,
  window,
  noun,
}: {
  rows: StepRow[]
  range: Range
  window: FunnelWindow
  noun: string
}) {
  const started = rows[0]?.people ?? 0
  const finished = rows[rows.length - 1]?.people ?? 0
  const drop = biggestDrop(rows)
  const dropStep = drop ? rows.find((row) => row.index === drop.index) : undefined
  return (
    <div className="mc-funnel-lead">
      <div className="mc-funnel-figures">
        <div className="mc-funnel-figure">
          <span className="mc-kpi-label">Finished</span>
          <strong className="mc-num">{formatPercent(finished, started)}</strong>
        </div>
        <div className="mc-funnel-figure is-second">
          <span className="mc-kpi-label">Most stop after</span>
          <strong className="mc-num">
            {drop ? `Step ${drop.index}` : <span className="mc-muted">—</span>}
          </strong>
        </div>
      </div>
      <p>
        {started
          ? `${formatCount(finished)} of ${plural(started, 'person', 'people')} who started ${rangePhrase[range]} did all ${rows.length} steps within ${windowLabels[window]}.`
          : `Nobody did step 1 ${rangePhrase[range]}.`}
        {drop && dropStep
          ? ` ${formatPercent(dropStep.dropped ?? 0, dropStep.people)} of those who reached step ${drop.index} (${stepText(dropStep.step, noun)}) went no further.`
          : ''}
      </p>
    </div>
  )
}

function FunnelSteps({
  rows,
  noun,
  drill,
  onDrill,
}: {
  rows: StepRow[]
  noun: string
  drill: Drill | null
  onDrill?: (drill: Drill) => void
}) {
  const start = rows[0]?.people ?? 0
  const drop = biggestDrop(rows)
  return (
    <ol className="mc-funnel">
      {rows.map((row, at) => {
        const share = start ? row.people / start : 0
        const before = at === 0 ? (start ? 1 : 0) : start ? rows[at - 1].people / start : 0
        const lost = Math.max(0, before - share)
        const reached = drill?.step === row.index && drill.outcome === 'reached'
        const dropped = drill?.step === row.index && drill.outcome === 'dropped'
        const count = (
          <>
            <strong className="mc-num">{formatCount(row.people)}</strong>
            <span className="mc-num mc-muted">
              {at === 0
                ? row.people === 1
                  ? 'person'
                  : 'people'
                : formatPercent(row.people, start)}
            </span>
          </>
        )
        return (
          <li key={row.index} className="mc-funnel-step">
            <div className="mc-funnel-head">
              <span className="mc-funnel-num mc-num" aria-hidden="true">
                {row.index}
              </span>
              <span className="mc-funnel-name">
                <span className="sr-only">Step {row.index}: </span>
                <StepName step={row.step} noun={noun} />
                {at > 0 && row.median !== null && (
                  <span className="mc-sub">
                    Typically{' '}
                    {row.median < 1
                      ? `within a second of step ${row.index - 1}`
                      : `${formatDuration(row.median)} after step ${row.index - 1}`}
                  </span>
                )}
              </span>
              {onDrill && row.people > 0 ? (
                <button
                  type="button"
                  className="mc-funnel-count"
                  aria-pressed={reached}
                  aria-label={`See the ${plural(row.people, 'person', 'people')} who reached step ${row.index}`}
                  onClick={() => onDrill({ step: row.index, outcome: 'reached' })}
                >
                  {count}
                </button>
              ) : (
                <span className="mc-funnel-count">{count}</span>
              )}
            </div>
            <div className="mc-funnel-track" aria-hidden="true">
              {share > 0 && <span className="mc-funnel-bar" style={{ width: `${share * 100}%` }} />}
              {lost > 0 && <span className="mc-funnel-lost" style={{ width: `${lost * 100}%` }} />}
            </div>
            {row.dropped !== null && row.people > 0 && (
              <div
                className={
                  drop?.index === row.index ? 'mc-funnel-drop is-biggest' : 'mc-funnel-drop'
                }
              >
                <ArrowDown size={14} aria-hidden="true" />
                {row.dropped === 0 ? (
                  <span>Nobody stopped here</span>
                ) : onDrill ? (
                  <button
                    type="button"
                    aria-pressed={dropped}
                    onClick={() => onDrill({ step: row.index, outcome: 'dropped' })}
                  >
                    {plural(row.dropped, 'person', 'people')} stopped here
                  </button>
                ) : (
                  <span>{plural(row.dropped, 'person', 'people')} stopped here</span>
                )}
                {row.dropped > 0 && (
                  <span className="mc-funnel-drop-share mc-num">
                    {formatPercent(row.dropped, row.people)}
                    {drop?.index === row.index ? ', the biggest drop' : ''}
                  </span>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function StepsSkeleton({ count }: { count: number }) {
  return (
    <ol className="mc-funnel" aria-hidden="true">
      {Array.from({ length: count }, (_, at) => (
        <li key={at} className="mc-funnel-step">
          <div className="mc-funnel-head">
            <span className="mc-funnel-num mc-num">{at + 1}</span>
            <Skeleton width={160} />
            <Skeleton width={48} />
          </div>
          <div className="mc-funnel-track" />
        </li>
      ))}
    </ol>
  )
}

function FunnelPeople({
  project,
  definition,
  range,
  drill,
  group,
  groupBy,
  noun,
  window,
  onClose,
}: {
  project: Project
  definition: FunnelDefinition
  range: Range
  drill: Drill
  group: string | null
  groupBy: GroupBy
  noun: string
  window: FunnelWindow
  onClose: () => void
}) {
  const time = timeIn(project.timezone)
  const ref = useRef<HTMLDivElement>(null)
  const scope = group ? { breakdown: groupBy, key: group } : null
  const key = JSON.stringify([project.id, definition, range, drill, scope])
  const first = useRpc(`funnel-people:${key}`, () =>
    api.funnelPeople(project.id, definition, range, drill.step, drill.outcome, scope),
  )
  const [more, setMore] = useState<{ key: string; rows: FunnelPerson[] }>({ key: '', rows: [] })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const extra = more.key === key ? more.rows : []
  const rows = [...(first.data?.people ?? []), ...extra]
  const total = first.data?.total ?? 0
  const next = definition.steps[drill.step]

  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [key])

  const loadMore = async () => {
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.funnelPeople(
        project.id,
        definition,
        range,
        drill.step,
        drill.outcome,
        scope,
        rows.length,
      )
      setMore({ key, rows: [...extra, ...page.people] })
    } catch (problem) {
      setMoreError(problem instanceof Error ? problem.message : 'Could not load more people.')
    } finally {
      setLoadingMore(false)
    }
  }

  const who =
    drill.outcome === 'reached' ? `reached step ${drill.step}` : `stopped after step ${drill.step}`
  return (
    <div ref={ref} className="mc-funnel-people">
      <Panel
        title={
          first.data
            ? `${plural(total, 'person', 'people')} ${who}${group ? `, ${groupLabel(groupBy, group)}` : ''}`
            : `People who ${who}`
        }
        description={
          drill.outcome === 'dropped' && next
            ? `They did step ${drill.step} but not ${stepText(next, noun)} within ${windowLabels[window]}. Newest first.`
            : `Newest first, each with the session where they did step ${drill.step}.`
        }
        id="mc-funnel-people"
        flush
        actions={
          <button
            type="button"
            className="mc-icon-btn"
            aria-label="Close the list"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        }
      >
        {first.error && (
          <ErrorNote
            message={`Couldn't load these people. ${first.error}`}
            onRetry={() => void first.refresh()}
          />
        )}
        <table className="mc-table mc-funnel-people-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">At step {drill.step}</th>
              <th scope="col">Where</th>
              <th scope="col">Device</th>
              <th scope="col">Session</th>
            </tr>
          </thead>
          <tbody>
            {!first.data &&
              !first.error &&
              [0, 1, 2].map((row) => (
                <tr key={row} aria-hidden="true">
                  {[150, 90, 90, 70, 80].map((width, cell) => (
                    <td key={cell}>
                      <Skeleton width={width} />
                    </td>
                  ))}
                </tr>
              ))}
            {rows.map((person) => (
              <tr key={person.id}>
                <td data-label="Person">
                  <PersonCell
                    person={person}
                    href={href({ name: 'person', projectId: project.id, personId: person.id })}
                  />
                </td>
                <td data-label={`At step ${drill.step}`} className="mc-num">
                  {time.dateTime(person.at)}
                </td>
                <td data-label="Where">
                  <span className="mc-truncate">{placeLabel(person)}</span>
                </td>
                <td data-label="Device">
                  {person.platform === 'web' || !person.platform
                    ? person.device_type
                      ? (deviceTypeLabels[person.device_type] ?? person.device_type)
                      : 'Unknown'
                    : platformLabels[person.platform]}
                </td>
                <td data-label="Session">
                  {person.session_id ? (
                    <a
                      className="mc-link"
                      href={href({
                        name: 'session',
                        projectId: project.id,
                        sessionId: person.session_id,
                      })}
                    >
                      {person.replay ? 'Watch replay' : 'Open session'}
                    </a>
                  ) : (
                    <span className="mc-muted">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {first.data && !rows.length && <Empty>Nobody here for this range.</Empty>}
        {moreError && <ErrorNote message={moreError} onRetry={() => void loadMore()} />}
        {first.data && rows.length > 0 && (
          <div className="mc-panel-foot is-padded">
            <ShowMore
              shown={rows.length}
              total={total}
              noun="people"
              onMore={() => {
                if (!loadingMore) void loadMore()
              }}
            />
          </div>
        )}
      </Panel>
    </div>
  )
}

function Breakdown({
  report,
  groupBy,
  onGroupBy,
  focus,
  onFocus,
  range,
}: {
  report: FunnelReport | undefined
  groupBy: GroupBy
  onGroupBy: (groupBy: GroupBy) => void
  focus: string | null
  onFocus: (key: string | null) => void
  range: Range
}) {
  return (
    <Panel
      title="Who finishes"
      description="Grouped by where each person started. Choose a group to see its steps."
      id="mc-funnel-groups"
      flush
      actions={
        <Select
          label="Group by"
          hideLabel
          value={groupBy}
          onChange={(value) => {
            onFocus(null)
            onGroupBy(value)
          }}
          options={groupOptions}
        />
      }
    >
      {report?.breakdown.length ? (
        <table className="mc-table mc-funnel-groups">
          <thead>
            <tr>
              <th scope="col">{groupNouns[groupBy]}</th>
              <th scope="col" className="mc-num-col">
                Started
              </th>
              <th scope="col" className="mc-num-col">
                Finished
              </th>
              <th scope="col" className="mc-num-col">
                Conversion
              </th>
              <th scope="col">Most stop after</th>
            </tr>
          </thead>
          <tbody>
            {report.breakdown.map((group) => {
              const started = group.steps[0] ?? 0
              const finished = group.steps[group.steps.length - 1] ?? 0
              const drop = countsDrop(group.steps)
              return (
                <tr key={group.key} className={focus === group.key ? 'is-current' : undefined}>
                  <td data-label={groupNouns[groupBy]}>
                    <button
                      type="button"
                      className="mc-row-button"
                      aria-pressed={focus === group.key}
                      onClick={() => onFocus(focus === group.key ? null : group.key)}
                    >
                      {groupLabel(groupBy, group.key)}
                    </button>
                  </td>
                  <td data-label="Started" className="mc-num mc-num-col">
                    {formatCount(started)}
                  </td>
                  <td data-label="Finished" className="mc-num mc-num-col">
                    {formatCount(finished)}
                  </td>
                  <td data-label="Conversion" className="mc-num mc-num-col">
                    {formatPercent(finished, started)}
                  </td>
                  <td data-label="Most stop after">
                    {drop ? (
                      <>
                        Step {drop.index}{' '}
                        <span className="mc-muted mc-num">
                          {formatPercent(drop.share * 100, 100)}
                        </span>
                      </>
                    ) : (
                      <span className="mc-muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <Empty>
          {report ? `Nobody started this funnel ${rangePhrase[range]}.` : 'Loading groups.'}
        </Empty>
      )}
      {report && report.other_groups > 0 && (
        <p className="mc-panel-foot is-padded mc-muted">
          {plural(report.other_groups, 'smaller group')} not shown.
        </p>
      )}
    </Panel>
  )
}

// Screens -----------------------------------------------------------------------------

export function FunnelsScreen({ project }: { project: Project }) {
  const { now } = useStore()
  const list = useRpc(`funnels:${project.id}`, () => api.funnels(project.id))
  const noun = pageNoun(project)
  const funnels = list.data
  const newHref = href({ name: 'funnel', projectId: project.id, funnelId: 'new' })
  return (
    <div className="mc-page">
      <PageHeader
        title="Funnels"
        description={`Steps you choose, in order, and how many people in ${project.name} get through each one.`}
        actions={
          funnels?.length ? (
            <a className="mc-btn mc-btn-primary" href={newHref}>
              <Plus size={16} aria-hidden="true" /> New funnel
            </a>
          ) : undefined
        }
      />
      {list.error && (
        <ErrorNote
          message={`Couldn't load funnels. ${list.error}`}
          onRetry={() => void list.refresh()}
        />
      )}
      {funnels && !funnels.length ? (
        <section className="mc-panel" aria-label="Funnels">
          <div className="mc-funnel-first">
            <p>
              A funnel follows people through steps in order, such as a visit to{' '}
              <span className="mc-mono">/pricing</span>, then{' '}
              <span className="mc-mono">signup_started</span>, then{' '}
              <span className="mc-mono">purchase</span>. It shows how many reach each step and where
              the rest stop. It reads the visits you already have, so it fills in straight away.
            </p>
            <a className="mc-btn mc-btn-primary mc-self-start" href={newHref}>
              <Plus size={16} aria-hidden="true" /> Build your first funnel
            </a>
          </div>
        </section>
      ) : (
        !list.error && (
          <section className="mc-panel mc-panel-flush" aria-label="Funnels">
            <table className="mc-table mc-funnels-table">
              <thead>
                <tr>
                  <th scope="col">Funnel</th>
                  <th scope="col" className="mc-num-col">
                    Steps
                  </th>
                  <th scope="col">Finish within</th>
                  <th scope="col">Made by</th>
                  <th scope="col">Changed</th>
                </tr>
              </thead>
              <tbody>
                {!funnels &&
                  [0, 1, 2].map((row) => (
                    <tr key={row} aria-hidden="true">
                      {[220, 24, 70, 100, 70].map((width, cell) => (
                        <td key={cell}>
                          <Skeleton width={width} />
                        </td>
                      ))}
                    </tr>
                  ))}
                {funnels?.map((funnel) => (
                  <tr key={funnel.id} className="mc-row-link">
                    <td data-label="Funnel">
                      <a
                        className="mc-link"
                        href={href({ name: 'funnel', projectId: project.id, funnelId: funnel.id })}
                      >
                        {funnel.name}
                      </a>
                      <span className="mc-sub mc-truncate">
                        {funnel.steps.map((step) => stepText(step, noun)).join(' → ')}
                      </span>
                    </td>
                    <td data-label="Steps" className="mc-num mc-num-col">
                      {funnel.steps.length}
                    </td>
                    <td data-label="Finish within">{windowLabels[funnel.window_seconds]}</td>
                    <td data-label="Made by">
                      <span className="mc-truncate">{funnel.created_by ?? 'A former member'}</span>
                    </td>
                    <td data-label="Changed" className="mc-num">
                      {formatAgo(funnel.updated_at, Math.max(now, Date.parse(funnel.updated_at)))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      )}
    </div>
  )
}

export function FunnelScreen({ project, funnelId }: { project: Project; funnelId: string }) {
  const { now, notify } = useStore()
  const time = timeIn(project.timezone)
  const noun = pageNoun(project)
  const isNew = funnelId === 'new'
  const list = useRpc(`funnels:${project.id}`, () => api.funnels(project.id), {
    enabled: !isNew,
  })
  const saved = isNew ? undefined : list.data?.find((funnel) => funnel.id === funnelId)
  const [draft, setDraft] = useState<Draft | null>(() =>
    isNew ? { name: '', steps: [blankStep(), blankStep()], window: 86400 } : null,
  )
  const editing = draft !== null
  const options = useRpc(`funnel-options:${project.id}`, () => api.funnelOptions(project.id), {
    enabled: editing,
  })
  const [showProblems, setShowProblems] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [range, setRange] = useState<Range>('30d')
  const [groupBy, setGroupBy] = useState<GroupBy>('device')
  const [focus, setFocus] = useState<string | null>(null)
  const [drill, setDrill] = useState<Drill | null>(null)

  const read = useMemo(() => (draft ? draft.steps.map(readStep) : []), [draft])
  const draftSteps = read.flatMap((item) => ('step' in item ? [item.step] : []))
  const draftComplete = Boolean(draft) && draftSteps.length === read.length && read.length >= 2
  const savedKey = saved ? JSON.stringify(definitionOf(saved)) : ''
  // Outside the builder this is the saved funnel, so opening the builder keeps its report.
  const draftKey = draft
    ? draftComplete
      ? JSON.stringify({ steps: draftSteps, window_seconds: draft.window })
      : ''
    : savedKey
  const previewKey = useSettled(draftKey)
  const definitionKey = editing ? previewKey : savedKey
  const definition = useMemo<FunnelDefinition | null>(
    () => (definitionKey ? (JSON.parse(definitionKey) as FunnelDefinition) : null),
    [definitionKey],
  )
  const report = useRpc(
    `funnel-report:${project.id}:${definitionKey}:${range}:${groupBy}`,
    () => api.funnelReport(project.id, definition as FunnelDefinition, range, groupBy),
    { enabled: Boolean(definition), pollMs: editing ? undefined : 60_000 },
  )
  // While the builder changes, the last report stays on screen until the next one lands.
  const [kept, setKept] = useState<FunnelReport | undefined>(undefined)
  if (report.data && report.data !== kept) setKept(report.data)
  const shown = report.data ?? kept
  const stale = !report.data && Boolean(kept)
  const windowSeconds = draft?.window ?? saved?.window_seconds ?? 86400
  const focusGroup = focus && shown?.breakdown.some((group) => group.key === focus) ? focus : null
  const rows = shown ? stepRows(shown, editing ? null : focusGroup) : []

  const back = (
    <a className="mc-back" href={href({ name: 'funnels', projectId: project.id })}>
      <ArrowLeft size={16} aria-hidden="true" /> All funnels
    </a>
  )

  if (!isNew && !saved) {
    return (
      <div className="mc-page">
        {back}
        {list.data ? (
          <>
            <PageHeader
              title="Funnel not found"
              description="It may have been deleted by someone in your workspace."
            />
            <a
              className="mc-btn mc-btn-primary mc-self-start"
              href={href({ name: 'funnels', projectId: project.id })}
            >
              See all funnels
            </a>
          </>
        ) : list.error ? (
          <ErrorNote
            message={`Couldn't load this funnel. ${list.error}`}
            onRetry={() => void list.refresh()}
          />
        ) : (
          <>
            <PageHeader title={<Skeleton width={220} height={30} />} />
            <Panel title="Steps" id="mc-funnel-steps">
              <StepsSkeleton count={3} />
            </Panel>
          </>
        )}
      </div>
    )
  }

  const save = async () => {
    if (!draft) return
    setShowProblems(true)
    if (!draft.name.trim() || !draftComplete) {
      setSaveError(null)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.saveFunnel(project.id, isNew ? null : funnelId, draft.name.trim(), {
        steps: draftSteps,
        window_seconds: draft.window,
      })
      notify(isNew ? `${result.name} is saved` : 'Changes saved')
      if (isNew) {
        navigate({ name: 'funnel', projectId: project.id, funnelId: result.id }, true)
      } else {
        await list.refresh()
        setDraft(null)
        setShowProblems(false)
      }
    } catch (problem) {
      setSaveError(problem instanceof Error ? problem.message : 'The funnel was not saved.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!saved) return
    setDeleting(true)
    try {
      await api.deleteFunnel(saved.id)
      notify(`${saved.name} is deleted`)
      navigate({ name: 'funnels', projectId: project.id }, true)
    } catch (problem) {
      notify(problem instanceof Error ? problem.message : 'The funnel was not deleted.')
      setDeleting(false)
    }
  }

  const steps = editing ? (definition?.steps ?? draftSteps) : (saved?.steps ?? [])
  const lead =
    shown && rows.length ? (
      <FunnelLead rows={rows} range={range} window={windowSeconds} noun={noun} />
    ) : null
  const chart = shown ? (
    <FunnelSteps
      rows={rows}
      noun={noun}
      drill={drill}
      onDrill={editing ? undefined : (next) => setDrill(next)}
    />
  ) : (
    <StepsSkeleton count={Math.max(2, steps.length)} />
  )
  const hourly = shown?.range.bucket === 'hour'

  return (
    <div className="mc-page">
      {back}
      <PageHeader
        title={
          editing ? draft.name.trim() || (isNew ? 'New funnel' : 'Untitled funnel') : saved?.name
        }
        description={
          saved && !editing
            ? `${plural(saved.steps.length, 'step')}, finished within ${windowLabels[saved.window_seconds]} of step 1. Made by ${saved.created_by ?? 'a former member'}, changed ${formatAgo(saved.updated_at, Math.max(now, Date.parse(saved.updated_at)))}.`
            : 'Choose what people do at each step. The preview counts the visits you already have.'
        }
        actions={
          <>
            <Segmented
              label="Date range"
              value={range}
              onChange={setRange}
              options={rangeOptions}
            />
            {saved && !editing && (
              <>
                <button
                  type="button"
                  className="mc-btn mc-btn-secondary"
                  onClick={() => {
                    setDraft(draftOf(saved))
                    setDrill(null)
                    setSaveError(null)
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="mc-icon-btn mc-icon-btn-danger"
                  aria-label={`Delete ${saved.name}`}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </>
            )}
          </>
        }
      />
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${saved?.name ?? 'this funnel'}?`}
        description="Only the funnel goes: the events it counted stay, and so do other reports."
      >
        <div className="mc-form-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            onClick={() => setConfirmDelete(false)}
          >
            Keep it
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger-solid"
            disabled={deleting}
            onClick={() => void remove()}
          >
            Delete funnel
          </button>
        </div>
      </Dialog>

      {editing ? (
        <div className="mc-funnel-edit">
          <FunnelBuilder
            isNew={isNew}
            draft={draft}
            onChange={setDraft}
            noun={noun}
            options={options.data}
            showProblems={showProblems}
            saving={saving}
            saveError={saveError}
            onSave={() => void save()}
            onCancel={() => {
              if (isNew) navigate({ name: 'funnels', projectId: project.id })
              else {
                setDraft(null)
                setShowProblems(false)
              }
            }}
          />
          <Panel
            title="Preview"
            description={
              draftComplete
                ? stale || report.loading
                  ? 'Counting'
                  : `Everyone who started ${rangePhrase[range]}`
                : 'Finish every step to count it.'
            }
            id="mc-funnel-preview"
            className="mc-funnel-preview"
          >
            {report.error && (
              <ErrorNote
                message={`Couldn't count this funnel. ${report.error}`}
                onRetry={() => void report.refresh()}
              />
            )}
            {shown ? (
              <div className={stale ? 'mc-funnel-body is-stale' : 'mc-funnel-body'}>
                {lead}
                {chart}
              </div>
            ) : draftComplete ? (
              <StepsSkeleton count={Math.max(2, draft.steps.length)} />
            ) : (
              <Empty>
                Each step needs an event, or the address of a {noun.toLowerCase()}. Suggestions come
                from what {project.name} has sent in the last 30 days.
              </Empty>
            )}
          </Panel>
        </div>
      ) : (
        <>
          <Panel
            title={focusGroup ? `Steps for ${groupLabel(groupBy, focusGroup)}` : 'Steps'}
            description={
              focusGroup
                ? 'Only people in this group. Typical times are for everyone.'
                : 'Choose a count to see who reached a step, or who stopped there.'
            }
            id="mc-funnel-steps"
            actions={
              focusGroup ? (
                <button type="button" className="mc-text-btn" onClick={() => setFocus(null)}>
                  Show everyone
                </button>
              ) : undefined
            }
          >
            {report.error && (
              <ErrorNote
                message={`Couldn't count this funnel. ${report.error}`}
                updatedAt={report.updatedAt}
                timezoneClock={time.time}
                onRetry={() => void report.refresh()}
              />
            )}
            {lead}
            {chart}
          </Panel>
          {drill && definition && (
            <FunnelPeople
              key={`${drill.step}:${drill.outcome}`}
              project={project}
              definition={definition}
              range={range}
              drill={drill}
              group={focusGroup}
              groupBy={groupBy}
              noun={noun}
              window={windowSeconds}
              onClose={() => setDrill(null)}
            />
          )}
          <Panel
            title="Started and finished"
            description={
              hourly
                ? 'Per hour, by when people did step 1. Everyone, whatever the group.'
                : 'Per day, by when people did step 1. Everyone, whatever the group.'
            }
            id="mc-funnel-time"
          >
            {shown && (
              <div className="mc-legend" aria-hidden="true">
                <span>
                  <i style={{ background: '#8a8a90' }} /> Started
                </span>
                <span>
                  <i style={{ background: seriesColors[0] }} /> Finished
                </span>
              </div>
            )}
            {shown ? (
              <LineChart
                label="People who started and finished the funnel"
                series={[
                  {
                    key: 'started',
                    label: 'Started',
                    color: '#8a8a90',
                    points: shown.series.map((point) => ({
                      time: Date.parse(point.start),
                      value: point.started,
                      partial: point.partial,
                    })),
                  },
                  {
                    key: 'finished',
                    label: 'Finished',
                    color: seriesColors[0],
                    points: shown.series.map((point) => ({
                      time: Date.parse(point.start),
                      value: point.converted,
                      partial: point.partial,
                    })),
                  },
                ]}
                area={false}
                height={220}
                formatX={hourly ? time.time : time.date}
                formatTooltip={
                  hourly ? (value) => `${time.date(value)}, ${time.time(value)}` : time.weekday
                }
                empty={
                  shown.started ? undefined : `Nobody started this funnel ${rangePhrase[range]}.`
                }
              />
            ) : (
              <div className="mc-chart" style={{ height: 220 }} aria-hidden="true" />
            )}
          </Panel>
          <Breakdown
            report={shown}
            groupBy={groupBy}
            onGroupBy={setGroupBy}
            focus={focusGroup}
            onFocus={(key) => {
              setFocus(key)
              setDrill(null)
            }}
            range={range}
          />
        </>
      )}
    </div>
  )
}
