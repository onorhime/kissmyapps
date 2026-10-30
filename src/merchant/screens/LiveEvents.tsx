import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Pause, Play, Search, X } from 'lucide-react'
import type { TrackedEvent } from '../data/live'
import type { Platform, Project } from '../data/sample'
import { platformLabels } from '../data/sample'
import { formatClock, formatCount, formatDateTime } from '../format'
import { downloadCsv } from '../csv'
import { href } from '../routes'
import { useLiveEvents, useNow } from '../store'
import { CopyButton, PageHeader, Select } from '../ui/Primitives'

function summary(properties: TrackedEvent['properties']): string {
  return Object.entries(properties)
    .map(([key, value]) => `${key}: ${value}`)
    .join('  ')
}

function EventDetail({
  project,
  event,
  onClose,
}: {
  project: Project
  event: TrackedEvent
  onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [event.id])
  return (
    <aside className="mc-panel mc-detail" aria-labelledby="mc-detail-title">
      <div className="mc-detail-head">
        <h2 id="mc-detail-title" ref={heading} tabIndex={-1} className="mc-mono">
          {event.name}
        </h2>
        <button
          type="button"
          className="mc-icon-btn"
          aria-label="Close event details"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <dl className="mc-kv">
        <div>
          <dt>Sent</dt>
          <dd className="mc-num">{formatDateTime(event.time)}</dd>
        </div>
        <div>
          <dt>Stored after</dt>
          <dd className="mc-num">{formatCount(event.receivedAt - event.time)} ms</dd>
        </div>
        <div>
          <dt>User</dt>
          <dd>
            {event.test ? (
              <span className="mc-mono">{event.userId}</span>
            ) : (
              <a
                className="mc-link mc-mono"
                href={href({ name: 'users', projectId: project.id, userId: event.userId })}
              >
                {event.userId}
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd className="mc-mono">{event.deviceId}</dd>
        </div>
        <div>
          <dt>Event ID</dt>
          <dd className="mc-id">
            <span className="mc-mono">{event.id}</span>
            <CopyButton value={event.id} label="event ID" compact />
          </dd>
        </div>
      </dl>
      <h3>Properties</h3>
      {Object.keys(event.properties).length ? (
        <dl className="mc-kv is-code">
          {Object.entries(event.properties).map(([key, value]) => (
            <div key={key}>
              <dt className="mc-mono">{key}</dt>
              <dd className="mc-mono">{JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mc-muted">This event was sent without properties.</p>
      )}
      <h3>Sent automatically</h3>
      <dl className="mc-kv is-code">
        {Object.entries(event.context).map(([key, value]) => (
          <div key={key}>
            <dt className="mc-mono">{key}</dt>
            <dd className="mc-mono">{JSON.stringify(value)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}

export function LiveEventsScreen({ project }: { project: Project }) {
  const [paused, setPaused] = useState(false)
  const events = useLiveEvents(project, paused)
  const now = useNow(5_000)
  const [query, setQuery] = useState('')
  const [eventName, setEventName] = useState('all')
  const [platform, setPlatform] = useState<'all' | Platform>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  // Rows that arrive after the stream opened, or after the filters last changed, flash once.
  const [highlightAfter, setHighlightAfter] = useState(() => Date.now())
  const refilter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setHighlightAfter(Date.now())
      set(value)
    }

  const names = useMemo(() => [...new Set(events.map((event) => event.name))].sort(), [events])
  const visible = events.filter(
    (event) =>
      (eventName === 'all' || event.name === eventName) &&
      (platform === 'all' || event.platform === platform) &&
      (!query.trim() ||
        [event.userId, event.deviceId, event.id, event.name].some((value) =>
          value.toLowerCase().includes(query.trim().toLowerCase()),
        )),
  )
  const selected = events.find((event) => event.id === selectedId) ?? null
  const perMinute = events.filter((event) => now - event.time < 60_000).length
  const filtered = eventName !== 'all' || platform !== 'all' || query.trim() !== ''

  const quiet = project.quietSource
  const description = !events.length
    ? 'Nothing has arrived yet. Events show here about a second after your app sends them.'
    : `About ${formatCount(perMinute)} events a minute${quiet ? `. ${platformLabels[quiet.platform]} has been quiet for ${quiet.minutes} minutes.` : '.'}`

  return (
    <div className="mc-page">
      <PageHeader
        title="Live events"
        description={
          paused && pausedAt
            ? `Paused at ${formatClock(pausedAt)}. New events are still being stored.`
            : description
        }
        actions={
          <>
            <button
              type="button"
              className="mc-btn mc-btn-quiet"
              disabled={!visible.length}
              onClick={() =>
                downloadCsv(`${project.id}-live-events.csv`, [
                  ['time', 'event', 'user_id', 'platform', 'properties'],
                  ...visible.map((event) => [
                    new Date(event.time).toISOString(),
                    event.name,
                    event.userId,
                    platformLabels[event.platform],
                    JSON.stringify(event.properties),
                  ]),
                ])
              }
            >
              <Download size={16} aria-hidden="true" />
              Export CSV
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              aria-pressed={paused}
              onClick={() => {
                setPausedAt(paused ? null : Date.now())
                setPaused((value) => !value)
              }}
            >
              {paused ? (
                <Play size={16} aria-hidden="true" />
              ) : (
                <Pause size={16} aria-hidden="true" />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
          </>
        }
      />

      <div className="mc-toolbar" role="search">
        <label className="mc-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search by user, device or event ID</span>
          <input
            value={query}
            placeholder="User, device or event ID"
            onChange={(event) => refilter(setQuery)(event.target.value)}
          />
        </label>
        <Select
          label="Event"
          hideLabel
          mono
          value={eventName}
          onChange={refilter(setEventName)}
          options={[
            { value: 'all', label: 'All events' },
            ...names.map((name) => ({ value: name, label: name })),
          ]}
        />
        <Select
          label="Source"
          hideLabel
          value={platform}
          onChange={refilter((value: string) => setPlatform(value as 'all' | Platform))}
          options={[
            { value: 'all', label: 'All sources' },
            ...project.platforms.map((item) => ({ value: item, label: platformLabels[item] })),
          ]}
        />
        <span className="mc-toolbar-count mc-muted mc-num" aria-live="polite">
          {formatCount(visible.length)} of the last {formatCount(events.length)}
        </span>
      </div>

      <div className={selected ? 'mc-live has-detail' : 'mc-live'}>
        <section className="mc-panel mc-panel-flush" aria-label="Event stream">
          {visible.length ? (
            <table className="mc-table mc-live-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">User</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="mc-col-wide">
                    Properties
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 100).map((event) => (
                  <tr
                    key={event.id}
                    className={[
                      event.id === selectedId ? 'is-selected' : '',
                      event.time > highlightAfter ? 'is-new' : '',
                    ].join(' ')}
                    onClick={() => setSelectedId(event.id)}
                  >
                    <td className="mc-num mc-muted">{formatClock(event.time)}</td>
                    <td>
                      <button
                        type="button"
                        className="mc-row-button mc-mono"
                        onClick={() => setSelectedId(event.id)}
                      >
                        {event.name}
                      </button>
                      {event.test && <span className="mc-tag">Test</span>}
                    </td>
                    <td className="mc-mono mc-muted">{event.userId}</td>
                    <td>{platformLabels[event.platform]}</td>
                    <td className="mc-col-wide mc-mono mc-muted mc-truncate">
                      {summary(event.properties) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : filtered ? (
            <div className="mc-empty">
              <p>No events in the last {formatCount(events.length)} match these filters.</p>
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                onClick={() => {
                  setHighlightAfter(Date.now())
                  setQuery('')
                  setEventName('all')
                  setPlatform('all')
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="mc-empty">
              <p>Waiting for the first event from {project.name}.</p>
              <a
                className="mc-btn mc-btn-primary"
                href={href({ name: 'install', projectId: project.id })}
              >
                Install the SDK
              </a>
            </div>
          )}
        </section>
        {selected && (
          <EventDetail project={project} event={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  )
}
