import { useState } from 'react'
import { ArrowRight, Check, Circle, Radio } from 'lucide-react'
import {
  HISTORY_DAYS,
  eventSummaries,
  lastHours,
  minuteStrip,
  rangeLabels,
  rangeTotals,
  volumeSeries,
} from '../data/model'
import type { Dataset, Point, Range } from '../data/model'
import type { TrackedEvent } from '../data/live'
import type { Project } from '../data/sample'
import { platformLabels } from '../data/sample'
import {
  formatAgo,
  formatChange,
  formatClock,
  formatCount,
  formatDate,
  formatDecimal,
  formatTime,
} from '../format'
import type { Tone } from '../format'
import { href } from '../routes'
import { useDataset, useLiveEvents, useNow, useStore } from '../store'
import { BarList, LineChart, MinuteStrip } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import { PageHeader, Segmented } from '../ui/Primitives'

const ranges: Range[] = ['today', '7d', '30d', '90d']

function comparisonLabel(range: Range) {
  return range === 'today'
    ? 'vs yesterday at this time'
    : `vs the ${rangeLabels[range].toLowerCase()} before`
}

type Kpi = { label: string; value: string; change?: { text: string; tone: Tone }; lead?: boolean }

function KpiStrip({ items, note }: { items: Kpi[]; note: string }) {
  return (
    <section className="mc-kpis" aria-label="Key figures">
      {items.map((item) => (
        <div key={item.label} className={item.lead ? 'mc-kpi is-lead' : 'mc-kpi'}>
          <span className="mc-kpi-label">{item.label}</span>
          <span className="mc-kpi-value">{item.value}</span>
          <span className="mc-kpi-change">
            {item.change ? (
              <>
                <span className={`is-${item.change.tone}`}>{item.change.text}</span> {note}
              </>
            ) : (
              <span className="mc-muted">No earlier data</span>
            )}
          </span>
        </div>
      ))}
    </section>
  )
}

function ArrivingNow({
  project,
  dataset,
  events,
  now,
}: {
  project: Project
  dataset: Dataset | null
  events: TrackedEvent[]
  now: number
}) {
  const lastHour = dataset
    ? project.platforms.reduce(
        (sum, platform) =>
          sum + minuteStrip(dataset, platform).reduce((total, point) => total + point.value, 0),
        0,
      )
    : events.filter((event) => now - event.time < 3_600_000).length
  return (
    <section className="mc-panel mc-arriving" aria-labelledby="mc-arriving-title">
      <div className="mc-panel-head is-row">
        <h2 id="mc-arriving-title">Arriving now</h2>
        <span className="mc-muted mc-num">{formatCount(lastHour)} in the last hour</span>
      </div>
      <ul>
        {project.platforms.map((platform) => {
          const last = events.find((event) => event.platform === platform)
          const quiet = project.quietSource?.platform === platform
          const points: Point[] = dataset
            ? minuteStrip(dataset, platform)
            : Array.from({ length: 60 }, (_, index) => {
                const time = Math.floor(now / 60_000) * 60_000 - (59 - index) * 60_000
                const value = events.filter(
                  (event) =>
                    event.platform === platform && event.time >= time && event.time < time + 60_000,
                ).length
                return { time, value }
              })
          return (
            <li key={platform}>
              <div className="mc-arriving-line">
                <span className="mc-arriving-name">
                  <strong>{platformLabels[platform]}</strong>
                  <span className="mc-muted">
                    {project.sdk[platform] ?? (last ? 'Test events only' : 'SDK not installed')}
                  </span>
                </span>
                <span className={quiet ? 'mc-arriving-ago is-warning' : 'mc-arriving-ago'}>
                  {last
                    ? quiet
                      ? `Quiet for ${formatAgo(last.time, now).replace(' ago', '')}`
                      : formatAgo(last.time, now)
                    : 'No events yet'}
                </span>
              </div>
              {last || dataset ? (
                <MinuteStrip
                  points={points}
                  label={`${platformLabels[platform]}, events per minute for the last hour`}
                />
              ) : (
                <p className="mc-arriving-wait">
                  Bars start here a second after the first {platformLabels[platform]} event.
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mc-panel-foot mc-muted">One bar per minute, oldest on the left.</p>
    </section>
  )
}

function LatestEvents({ project, events }: { project: Project; events: TrackedEvent[] }) {
  return (
    <section className="mc-panel" aria-labelledby="mc-latest-title">
      <div className="mc-panel-head is-row">
        <h2 id="mc-latest-title">Latest events</h2>
        <a className="mc-link" href={href({ name: 'live', projectId: project.id })}>
          Open live events
        </a>
      </div>
      {events.length ? (
        <ol className="mc-latest">
          {events.slice(0, 6).map((event) => (
            <li key={event.id}>
              <span className="mc-num mc-muted">{formatClock(event.time)}</span>
              <span className="mc-mono mc-truncate">{event.name}</span>
              <span className="mc-mono mc-muted mc-truncate">{event.userId}</span>
              <span className="mc-muted">{platformLabels[event.platform]}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mc-empty-line">Events appear here a second after your app sends them.</p>
      )}
    </section>
  )
}

function SetupChecklist({ project, received }: { project: Project; received: boolean }) {
  const { keys } = useStore()
  const key = keys.find(
    (item) => item.projectId === project.id && item.kind === 'client' && !item.revokedAt,
  )
  const steps = [
    {
      label: 'Create the project',
      done: true,
      detail: `Created for ${project.platforms.map((platform) => platformLabels[platform]).join(', ')}`,
    },
    {
      label: 'Get a client key',
      done: Boolean(key),
      detail: key ? `${key.name}, ending ${key.suffix}` : 'Create one in Settings',
    },
    {
      label: 'Install the SDK and send a first event',
      done: received,
      detail: received ? 'Received' : 'Takes about five minutes',
    },
  ]
  const done = steps.filter((step) => step.done).length
  return (
    <section className="mc-panel mc-setup mc-span-8" aria-labelledby="mc-setup-title">
      <div className="mc-panel-head is-row">
        <h2 id="mc-setup-title">Finish setting up {project.name}</h2>
        <span className="mc-muted mc-num">
          {done} of {steps.length} done
        </span>
      </div>
      <div
        className="mc-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label="Setup progress"
      >
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mc-steps">
        {steps.map((step) => (
          <li key={step.label} className={step.done ? 'is-done' : undefined}>
            {step.done ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Circle size={16} aria-hidden="true" />
            )}
            <span>
              <strong>{step.label}</strong>
              <span className="mc-muted">{step.detail}</span>
            </span>
            <span className="sr-only">{step.done ? 'Done' : 'Not done yet'}</span>
          </li>
        ))}
      </ol>
      {!received && (
        <a
          className="mc-btn mc-btn-primary"
          href={href({ name: 'install', projectId: project.id })}
        >
          Install the SDK
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      )}
    </section>
  )
}

function finding(project: Project, dataset: Dataset | null, events: TrackedEvent[]): string {
  if (!dataset) {
    return events.length
      ? `${formatCount(events.length)} test ${events.length === 1 ? 'event' : 'events'} received. Send events from your app to fill this page.`
      : 'No events yet. Install the SDK and send a first event to see data here.'
  }
  const healthy = project.platforms
    .filter((platform) => platform !== project.quietSource?.platform)
    .map((platform) => platformLabels[platform])
  if (project.quietSource) {
    return `${platformLabels[project.quietSource.platform]} has sent nothing for ${project.quietSource.minutes} minutes. ${healthy.join(' and ')} are arriving as usual.`
  }
  return `Events are arriving from ${healthy.join(' and ')}.`
}

export function OverviewScreen({ project }: { project: Project }) {
  const dataset = useDataset(project)
  const events = useLiveEvents(project)
  const now = useNow()
  const [selectedRange, setRange] = useState<Range>('today')
  // Until real events arrive there is only today to show.
  const range = dataset ? selectedRange : 'today'

  const totals = dataset ? rangeTotals(dataset, range) : null
  const testCount = dataset ? 0 : events.length
  const note = comparisonLabel(range)
  const kpis: Kpi[] = totals
    ? [
        {
          label: range === 'today' ? 'Events today' : `Events, ${rangeLabels[range].toLowerCase()}`,
          value: formatCount(totals.events),
          change: totals.comparable
            ? formatChange(totals.events, totals.previousEvents)
            : undefined,
          lead: true,
        },
        {
          label: 'Active people',
          value: formatCount(totals.activeUsers),
          change: totals.comparable
            ? formatChange(totals.activeUsers, totals.previousActiveUsers)
            : undefined,
        },
        {
          label: 'New people',
          value: formatCount(totals.newUsers),
          change: totals.comparable
            ? formatChange(totals.newUsers, totals.previousNewUsers)
            : undefined,
        },
        {
          label: 'Events per person',
          value: formatDecimal(totals.events / Math.max(1, totals.activeUsers)),
          change: totals.comparable
            ? formatChange(
                totals.events / Math.max(1, totals.activeUsers),
                totals.previousEvents / Math.max(1, totals.previousActiveUsers),
              )
            : undefined,
        },
      ]
    : [
        { label: 'Events today', value: formatCount(testCount), lead: true },
        { label: 'Active people', value: formatCount(testCount ? 1 : 0) },
        { label: 'New people', value: formatCount(testCount ? 1 : 0) },
        { label: 'Events per person', value: testCount ? formatDecimal(testCount) : '—' },
      ]

  const series: Point[] = dataset
    ? volumeSeries(dataset, range)
    : lastHours(now).map((time) => ({
        time,
        value: events.filter((event) => event.time >= time && event.time < time + 3_600_000).length,
      }))
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const annotations =
    range === 'today'
      ? new Date(now).getHours() < 23
        ? [{ time: midnight, label: 'Today' }]
        : []
      : project.release && dataset
        ? [
            {
              time: dataset.dayStarts[HISTORY_DAYS - 1 - project.release.daysAgo],
              label: project.release.label,
            },
          ]
        : []
  const hourLabel = (time: number) =>
    `${time < midnight ? 'Yesterday' : 'Today'}, ${formatTime(time)} to ${formatTime(time + 3_600_000)}`
  const top = dataset
    ? eventSummaries(dataset, range)
        .filter((summary) => summary.total > 0)
        .sort((a, b) => b.total - a.total)
    : []

  return (
    <div className="mc-page">
      <PageHeader
        title="Overview"
        description={finding(project, dataset, events)}
        actions={
          <>
            {dataset && (
              <Segmented
                label="Period"
                value={range}
                onChange={setRange}
                options={ranges.map((value) => ({ value, label: rangeLabels[value] }))}
              />
            )}
            <a
              className="mc-btn mc-btn-secondary"
              href={href({ name: 'live', projectId: project.id })}
            >
              <Radio size={16} aria-hidden="true" />
              Live events
            </a>
          </>
        }
      />

      <KpiStrip items={kpis} note={note} />

      <div className="mc-grid">
        {!dataset && <SetupChecklist project={project} received={events.length > 0} />}
        {!dataset && (
          <div className="mc-span-4 mc-align-start">
            <ArrivingNow project={project} dataset={dataset} events={events} now={now} />
          </div>
        )}
        <section className="mc-panel mc-span-8" aria-labelledby="mc-volume-title">
          <div className="mc-panel-head is-row">
            <h2 id="mc-volume-title">
              {range === 'today'
                ? 'Events per hour, last 24 hours'
                : `Events per day, last ${rangeLabels[range].toLowerCase()}`}
            </h2>
            <span className="mc-muted">
              {dataset ? 'The dashed end is still filling' : 'Draws as events arrive'}
            </span>
          </div>
          <LineChart
            label={
              range === 'today'
                ? 'Events per hour over the last 24 hours'
                : `Events per day over ${rangeLabels[range]}`
            }
            series={[{ key: 'events', label: 'Events', color: seriesColors[0], points: series }]}
            height={232}
            formatX={range === 'today' ? formatTime : formatDate}
            formatTooltip={range === 'today' ? hourLabel : formatDate}
            annotations={annotations}
            empty="No events in the last 24 hours"
          />
        </section>
        {dataset && (
          <div className="mc-span-4">
            <ArrivingNow project={project} dataset={dataset} events={events} now={now} />
          </div>
        )}
        {dataset && (
          <section className="mc-panel mc-span-6" aria-labelledby="mc-top-title">
            <div className="mc-panel-head is-row">
              <h2 id="mc-top-title">Most sent events</h2>
              <a className="mc-link" href={href({ name: 'events', projectId: project.id })}>
                All {top.length} events
              </a>
            </div>
            <BarList
              rows={top.slice(0, 6).map((summary) => ({
                key: summary.event.name,
                label: <span className="mc-mono">{summary.event.name}</span>,
                value: summary.total,
                display: formatCount(summary.total),
                href: href({ name: 'event', projectId: project.id, eventName: summary.event.name }),
              }))}
            />
          </section>
        )}
        <div className={dataset ? 'mc-span-6' : 'mc-span-4'}>
          <LatestEvents project={project} events={events} />
        </div>
      </div>
    </div>
  )
}
