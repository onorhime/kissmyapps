import { useState } from 'react'
import { ArrowLeft, ChartLine, Search } from 'lucide-react'
import {
  HISTORY_DAYS,
  eventComparable,
  eventSummaries,
  rangeLabels,
  volumeSeries,
} from '../data/model'
import type { EventSummary, Range } from '../data/model'
import { contextProperties, eventCatalogs, platformLabels } from '../data/sample'
import type { EventDefinition, EventStatus, Project, PropertySpec } from '../data/sample'
import { formatAgo, formatChange, formatCount, formatDate, formatDecimal } from '../format'
import { href } from '../routes'
import { useDataset, useLiveEvents, useNow, useStore } from '../store'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import { CodeBlock, PageHeader, Pill, Segmented } from '../ui/Primitives'
import type { PillTone } from '../ui/Primitives'

const statusTone: Record<EventStatus, PillTone> = {
  live: 'positive',
  planned: 'neutral',
  blocked: 'negative',
}
const statusLabel: Record<EventStatus, string> = {
  live: 'Live',
  planned: 'Planned',
  blocked: 'Blocked',
}
type Tab = 'all' | EventStatus

function useSummaries(project: Project, range: Range) {
  const dataset = useDataset(project)
  const { eventStatus, testEvents } = useStore()
  const summaries: EventSummary[] = dataset ? eventSummaries(dataset, range) : []
  const tests = testEvents[project.id] ?? []
  if (!dataset && tests.length) {
    summaries.push({
      event: {
        name: 'kma_test_event',
        description: 'Sent from the install page to check the connection.',
        category: 'Automatic',
        status: 'live',
        daily: 0,
        share: [],
        perUser: 1,
        firstSeenDaysAgo: 0,
        properties: [{ name: 'sent_from', type: 'string', values: ['Install page'], coverage: 1 }],
      },
      total: tests.length,
      previous: 0,
      users: 1,
      lastSeen: tests[0].time,
      platforms: [...new Set(tests.map((event) => event.platform))],
    })
  }
  return summaries.map((summary) => ({
    ...summary,
    status: eventStatus(project.id, summary.event.name, summary.event.status),
  }))
}

export function EventsScreen({ project }: { project: Project }) {
  const [range, setRange] = useState<Exclude<Range, 'today'>>('30d')
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const now = useNow(10_000)
  const summaries = useSummaries(project, range)
  const counts = {
    all: summaries.length,
    live: summaries.filter((summary) => summary.status === 'live').length,
    planned: summaries.filter((summary) => summary.status === 'planned').length,
    blocked: summaries.filter((summary) => summary.status === 'blocked').length,
  }
  const rows = summaries
    .filter(
      (summary) =>
        (tab === 'all' || summary.status === tab) &&
        summary.event.name.includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => b.total - a.total || a.event.name.localeCompare(b.event.name))
  const description = summaries.length
    ? `${counts.live} live event types in ${project.name}. ${counts.planned} planned and ${counts.blocked} blocked.`
    : 'Event types appear here the first time your app sends them.'

  return (
    <div className="mc-page">
      <PageHeader
        title="Events"
        description={description}
        actions={
          <Segmented
            label="Period"
            value={range}
            onChange={setRange}
            options={(['7d', '30d', '90d'] as const).map((value) => ({
              value,
              label: rangeLabels[value],
            }))}
          />
        }
      />
      <div className="mc-toolbar">
        <div className="mc-tabs" role="tablist" aria-label="Event status">
          {(['all', 'live', 'planned', 'blocked'] as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === 'all' ? 'All' : statusLabel[value]}{' '}
              <span className="mc-num mc-muted">{counts[value]}</span>
            </button>
          ))}
        </div>
        <label className="mc-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Find an event</span>
          <input
            value={query}
            placeholder="Find an event"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section className="mc-panel mc-panel-flush" aria-label="Event types">
        {rows.length ? (
          <table className="mc-table mc-events-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Category</th>
                <th scope="col" className="is-num">
                  Events
                </th>
                <th scope="col" className="is-num">
                  People
                </th>
                <th scope="col" className="is-num">
                  Change
                </th>
                <th scope="col" className="is-num">
                  Last seen
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((summary) => {
                const comparable = eventComparable(summary.event, range)
                const change =
                  summary.status === 'live' && comparable && summary.previous > 0
                    ? formatChange(summary.total, summary.previous)
                    : null
                const isNew = summary.status === 'live' && !comparable && summary.total > 0
                return (
                  <tr key={summary.event.name} className="mc-row-link">
                    <td>
                      <a
                        className="mc-event-cell"
                        href={href({
                          name: 'event',
                          projectId: project.id,
                          eventName: summary.event.name,
                        })}
                      >
                        <span className="mc-mono">{summary.event.name}</span>
                        <span className="mc-sub">{summary.event.description}</span>
                      </a>
                    </td>
                    <td className="mc-muted">{summary.event.category}</td>
                    <td className="is-num mc-num">{formatCount(summary.total)}</td>
                    <td className="is-num mc-num">{formatCount(summary.users)}</td>
                    <td className="is-num mc-num">
                      {change ? (
                        <span className={`is-${change.tone}`}>{change.text}</span>
                      ) : isNew ? (
                        <span className="mc-muted" title="First seen inside the period before">
                          New
                        </span>
                      ) : (
                        <span className="mc-muted">—</span>
                      )}
                    </td>
                    <td className="is-num mc-num mc-muted">
                      {summary.lastSeen ? formatAgo(summary.lastSeen, now) : '—'}
                    </td>
                    <td>
                      <Pill tone={statusTone[summary.status]}>{statusLabel[summary.status]}</Pill>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : summaries.length ? (
          <div className="mc-empty">
            <p>
              No {tab === 'all' ? '' : `${statusLabel[tab].toLowerCase()} `}events match “
              {query.trim()}”.
            </p>
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => {
                setQuery('')
                setTab('all')
              }}
            >
              Show all events
            </button>
          </div>
        ) : (
          <div className="mc-empty">
            <p>No events yet. Send one from the install page to see it listed here.</p>
            <a
              className="mc-btn mc-btn-primary"
              href={href({ name: 'install', projectId: project.id })}
            >
              Install the SDK
            </a>
          </div>
        )}
      </section>
    </div>
  )
}

function exampleValue(spec: PropertySpec): string {
  if (spec.values?.length) return JSON.stringify(spec.values[0])
  if (spec.type === 'boolean') return 'true'
  if (spec.range) return String(spec.range[0] + Math.round((spec.range[1] - spec.range[0]) / 2))
  return '"…"'
}

function trackSnippets(event: EventDefinition) {
  const props = event.properties.filter((spec) => spec.name !== 'session_id').slice(0, 3)
  const js = props.length
    ? `, {\n${props.map((spec) => `  ${spec.name}: ${exampleValue(spec)},`).join('\n')}\n}`
    : ''
  const swift = props.length
    ? `, properties: [\n${props.map((spec) => `  "${spec.name}": ${exampleValue(spec)},`).join('\n')}\n]`
    : ''
  const kotlin = props.length
    ? `, mapOf(\n${props.map((spec) => `  "${spec.name}" to ${exampleValue(spec)},`).join('\n')}\n)`
    : ''
  return {
    web: `kma.track('${event.name}'${js})`,
    ios: `KMA.track("${event.name}"${swift})`,
    android: `KMA.track("${event.name}"${kotlin})`,
  }
}

export function EventDetailScreen({ project, eventName }: { project: Project; eventName: string }) {
  const dataset = useDataset(project)
  const { setEventStatus, notify } = useStore()
  const events = useLiveEvents(project)
  const now = useNow(10_000)
  const [snippet, setSnippet] = useState<'web' | 'ios' | 'android'>(
    project.platforms.includes('web') && !project.platforms.includes('ios')
      ? 'web'
      : project.platforms[0] === 'android'
        ? 'android'
        : project.platforms[0] === 'web'
          ? 'web'
          : 'ios',
  )
  const [confirmBlock, setConfirmBlock] = useState(false)
  const summaries = useSummaries(project, '30d')
  const summary = summaries.find((item) => item.event.name === eventName)

  if (!summary) {
    return (
      <div className="mc-page">
        <a className="mc-back" href={href({ name: 'events', projectId: project.id })}>
          <ArrowLeft size={16} aria-hidden="true" />
          Events
        </a>
        <PageHeader
          title="Event not found"
          description={`${project.name} has no event called “${eventName}”. It may have been renamed.`}
        />
      </div>
    )
  }

  const { event, status } = summary
  const series = dataset ? volumeSeries(dataset, '30d', { events: [event.name] }) : []
  const note =
    event.releaseLift && project.release && dataset
      ? [
          {
            time: dataset.dayStarts[HISTORY_DAYS - 1 - project.release.daysAgo],
            label: project.release.label,
          },
        ]
      : []
  const lastLive = events.find((item) => item.name === event.name)
  const lastSeen = lastLive?.time ?? summary.lastSeen
  const snippets = trackSnippets(event)
  const isCatalogued = Boolean(eventCatalogs[project.id]?.some((item) => item.name === event.name))

  return (
    <div className="mc-page">
      <a className="mc-back" href={href({ name: 'events', projectId: project.id })}>
        <ArrowLeft size={16} aria-hidden="true" />
        Events
      </a>
      <PageHeader
        title={<span className="mc-mono">{event.name}</span>}
        description={event.description}
        actions={
          <>
            <Pill tone={statusTone[status]}>{statusLabel[status]}</Pill>
            {isCatalogued && status !== 'planned' && (
              <button
                type="button"
                className={
                  status === 'blocked' ? 'mc-btn mc-btn-secondary' : 'mc-btn mc-btn-danger'
                }
                onClick={() => {
                  if (status === 'blocked') {
                    setEventStatus(project.id, event.name, 'live')
                    notify(`${event.name} is live again. New events are stored.`)
                  } else setConfirmBlock(true)
                }}
              >
                {status === 'blocked' ? 'Unblock event' : 'Block event'}
              </button>
            )}
            {dataset && status === 'live' && (
              <a
                className="mc-btn mc-btn-secondary"
                href={href({ name: 'explore', projectId: project.id, eventName: event.name })}
              >
                <ChartLine size={16} aria-hidden="true" />
                Explore
              </a>
            )}
          </>
        }
      />

      {confirmBlock && (
        <div
          className="mc-confirm"
          role="alertdialog"
          aria-labelledby="mc-block-title"
          aria-describedby="mc-block-text"
        >
          <div>
            <strong id="mc-block-title">Block {event.name}?</strong>
            <p id="mc-block-text">
              New {event.name} events are dropped when they arrive. Events already stored stay in
              your reports. You can unblock it at any time.
            </p>
          </div>
          <div className="mc-form-actions">
            <button
              type="button"
              className="mc-btn mc-btn-quiet"
              onClick={() => setConfirmBlock(false)}
            >
              Keep it live
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-danger-solid"
              onClick={() => {
                setEventStatus(project.id, event.name, 'blocked')
                setConfirmBlock(false)
                notify(`${event.name} is blocked. New ones will be dropped.`)
              }}
            >
              Block {event.name}
            </button>
          </div>
        </div>
      )}

      <section className="mc-kpis" aria-label="Last 30 days">
        <div className="mc-kpi is-lead">
          <span className="mc-kpi-label">Events, 30 days</span>
          <span className="mc-kpi-value">{formatCount(summary.total)}</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">People, 30 days</span>
          <span className="mc-kpi-value">{formatCount(summary.users)}</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Events per person</span>
          <span className="mc-kpi-value">
            {summary.users ? formatDecimal(summary.total / summary.users) : '0.00'}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Last seen</span>
          <span className="mc-kpi-value">{lastSeen ? formatAgo(lastSeen, now) : '—'}</span>
        </div>
      </section>

      <div className="mc-grid">
        <section className="mc-panel mc-span-12" aria-labelledby="mc-event-volume">
          <div className="mc-panel-head is-row">
            <h2 id="mc-event-volume">Events per day, last 30 days</h2>
            <span className="mc-muted">
              {summary.platforms.map((platform) => platformLabels[platform]).join(', ') ||
                'No sources yet'}
            </span>
          </div>
          {series.length ? (
            <LineChart
              label={`${event.name} per day`}
              series={[
                { key: event.name, label: event.name, color: seriesColors[0], points: series },
              ]}
              formatX={formatDate}
              height={200}
              annotations={note}
            />
          ) : (
            <p className="mc-empty-line">
              {status === 'planned'
                ? 'Planned. Nothing has been sent yet.'
                : 'History appears after the first full day of events.'}
            </p>
          )}
        </section>

        <section className="mc-panel mc-panel-flush mc-span-7" aria-labelledby="mc-props-title">
          <div className="mc-panel-head is-row is-padded">
            <h2 id="mc-props-title">Properties</h2>
            <span className="mc-muted">{event.properties.length} sent with this event</span>
          </div>
          <table className="mc-table mc-props-table">
            <thead>
              <tr>
                <th scope="col">Property</th>
                <th scope="col">Type</th>
                <th scope="col" className="is-num">
                  Seen on
                </th>
                <th scope="col">Example values</th>
              </tr>
            </thead>
            <tbody>
              {event.properties.map((spec) => (
                <tr key={spec.name}>
                  <td className="mc-mono">{spec.name}</td>
                  <td className="mc-muted">{spec.type}</td>
                  <td className="is-num mc-num">{Math.round(spec.coverage * 100)}%</td>
                  <td>
                    <span className="mc-values">
                      {(
                        spec.values ??
                        (spec.range
                          ? [`${spec.range[0]} to ${spec.range[1]}`]
                          : spec.type === 'boolean'
                            ? [true, false]
                            : ['Unique per event'])
                      )
                        .slice(0, 3)
                        .map((value) => (
                          <span key={String(value)} className="mc-tag mc-mono">
                            {String(value)}
                          </span>
                        ))}
                    </span>
                  </td>
                </tr>
              ))}
              {!event.properties.length && (
                <tr>
                  <td colSpan={4} className="mc-muted">
                    This event has no properties of its own.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="mc-panel-foot mc-muted is-padded">
            Every event also carries {contextProperties.map((spec) => spec.name).join(', ')}.
          </p>
        </section>

        <section className="mc-panel mc-span-5" aria-labelledby="mc-send-title">
          <div className="mc-panel-head is-row">
            <h2 id="mc-send-title">Send it from your app</h2>
            <Segmented
              label="Platform"
              value={snippet}
              onChange={setSnippet}
              options={[
                { value: 'web', label: 'Web' },
                { value: 'ios', label: 'iOS' },
                { value: 'android', label: 'Android' },
              ]}
            />
          </div>
          <CodeBlock
            code={snippets[snippet]}
            label={snippet === 'web' ? 'JavaScript' : snippet === 'ios' ? 'Swift' : 'Kotlin'}
          />
          <a className="mc-link" href={href({ name: 'install', projectId: project.id })}>
            Setting up the SDK for the first time
          </a>
        </section>
      </div>
    </div>
  )
}
