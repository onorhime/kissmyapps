import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Ban, CircleCheck, Pause, Play, Search } from 'lucide-react'
import { api } from '../api'
import type { Breakdown, LiveEvent, Project, Range } from '../api'
import {
  countryName,
  deviceLabel,
  formatAgo,
  formatChange,
  formatCount,
  formatDecimal,
  formatPercent,
  placeLabel,
  platformLabels,
  plural,
  timeIn,
} from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { canDo, useStore } from '../store'
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
  Pill,
  Segmented,
  Select,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

// The feed keeps the newest events; older ones are on each event's page.
const LIVE_ROWS = 100

function EventTabs({ project, live }: { project: Project; live: boolean }) {
  return (
    <nav className="mc-tabs" aria-label="Events views">
      <a
        href={href({ name: 'events', projectId: project.id })}
        aria-current={!live ? 'page' : undefined}
      >
        All events
      </a>
      <a
        href={href({ name: 'live', projectId: project.id })}
        aria-current={live ? 'page' : undefined}
      >
        <span className="mc-live-dot" aria-hidden="true" /> Live
      </a>
    </nav>
  )
}

export function EventsScreen({ project, live }: { project: Project; live: boolean }) {
  return live ? <LiveEvents project={project} /> : <EventCatalog project={project} />
}

function EventCatalog({ project }: { project: Project }) {
  const { now } = useStore()
  const [range, setRange] = useState<Range>('7d')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'live' | 'blocked'>('live')
  const catalog = useRpc(`catalog:${project.id}:${range}`, () => api.catalog(project.id, range), {
    pollMs: 60_000,
  })
  const data = catalog.data
  const rows = (data?.events ?? []).filter(
    (event) =>
      event.status === status && event.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const blocked = data?.events.filter((event) => event.status === 'blocked').length ?? 0

  return (
    <div className="mc-page">
      <PageHeader
        title="Events"
        description={`What people did in ${project.name} ${rangePhrase[range]}, by how many of them did it.`}
        actions={
          <Segmented label="Date range" value={range} onChange={setRange} options={rangeOptions} />
        }
      />
      <EventTabs project={project} live={false} />
      <div className="mc-toolbar">
        <div className="mc-search">
          <Search size={16} aria-hidden="true" />
          <label htmlFor="mc-event-search" className="sr-only">
            Find an event
          </label>
          <input
            id="mc-event-search"
            type="search"
            placeholder="Event name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'live', label: 'Collected' },
            { value: 'blocked', label: `Blocked${blocked ? ` (${blocked})` : ''}` },
          ]}
        />
        <span className="mc-toolbar-count mc-muted">
          {data ? `${formatCount(data.active_users)} active users ${rangePhrase[range]}` : ''}
        </span>
      </div>
      {catalog.error && (
        <ErrorNote
          message={`Couldn't load events. ${catalog.error}`}
          onRetry={() => void catalog.refresh()}
        />
      )}
      <section className="mc-panel mc-panel-flush" aria-label="Events">
        <table className="mc-table mc-events-table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col" className="mc-num-col">
                Users
              </th>
              <th scope="col" className="mc-num-col">
                Share of users
              </th>
              <th scope="col" className="mc-num-col">
                Times
              </th>
              <th scope="col" className="mc-num-col">
                Change in users
              </th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {!data &&
              [0, 1, 2, 3].map((index) => (
                <tr key={index} aria-hidden="true">
                  {[160, 40, 40, 40, 60, 80].map((width, cell) => (
                    <td key={cell}>
                      <Skeleton width={width} />
                    </td>
                  ))}
                </tr>
              ))}
            {rows.map((event) => {
              const change = formatChange(event.users, event.users_prev)
              return (
                <tr key={event.name} className="mc-row-link">
                  <td data-label="Event">
                    <a
                      className="mc-link mc-mono"
                      href={href({ name: 'event', projectId: project.id, eventName: event.name })}
                    >
                      {event.name}
                    </a>
                    {event.description && <span className="mc-sub">{event.description}</span>}
                  </td>
                  <td data-label="Users" className="mc-num mc-num-col">
                    {formatCount(event.users)}
                  </td>
                  <td data-label="Share of users" className="mc-num mc-num-col">
                    {formatPercent(event.users, data?.active_users ?? 0)}
                  </td>
                  <td data-label="Times" className="mc-num mc-num-col">
                    {formatCount(event.events)}
                  </td>
                  <td data-label="Change in users" className="mc-num mc-num-col">
                    {event.comparable ? (
                      <span className={`is-${change.tone}`}>{change.text}</span>
                    ) : (
                      <span className="mc-muted">New</span>
                    )}
                  </td>
                  <td data-label="Last seen">
                    <span className="mc-num">
                      {formatAgo(event.last_seen, Math.max(now, Date.parse(event.last_seen)))}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {data && !rows.length && (
          <Empty>
            {search
              ? `No ${status === 'blocked' ? 'blocked ' : ''}event names contain “${search}”.`
              : status === 'blocked'
                ? 'No blocked events. Block an event from its page to stop collecting it.'
                : `${project.name} has not sent any events yet.`}
          </Empty>
        )}
      </section>
    </div>
  )
}

function LiveEvents({ project }: { project: Project }) {
  const time = timeIn(project.timezone)
  const [rows, setRows] = useState<LiveEvent[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const last = useRef<number | null>(null)

  useEffect(() => {
    if (paused) return
    let cancelled = false
    const poll = async () => {
      try {
        const fresh = await api.live(project.id, last.current, LIVE_ROWS)
        if (cancelled) return
        setError(null)
        setLoaded(true)
        if (fresh.length) {
          last.current = Math.max(last.current ?? 0, ...fresh.map((event) => event.id))
          setRows((current) => [...fresh, ...current].slice(0, LIVE_ROWS))
        }
      } catch (problem) {
        if (!cancelled)
          setError(problem instanceof Error ? problem.message : 'The live feed stopped.')
      }
    }
    void poll()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void poll()
    }, 3_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [paused, project.id])

  const visible = rows.filter(
    (event) => !filter || event.name.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="mc-page">
      <PageHeader
        title="Live events"
        description={`Events from ${project.name} as they arrive, newest first. Development keys and bots are labelled.`}
        actions={
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? (
              <Play size={16} aria-hidden="true" />
            ) : (
              <Pause size={16} aria-hidden="true" />
            )}
            {paused ? 'Resume' : 'Pause'}
          </button>
        }
      />
      <EventTabs project={project} live />
      <div className="mc-toolbar">
        <div className="mc-search">
          <Search size={16} aria-hidden="true" />
          <label htmlFor="mc-live-filter" className="sr-only">
            Filter by event name
          </label>
          <input
            id="mc-live-filter"
            type="search"
            placeholder="Filter by event name"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <span className="mc-toolbar-count mc-muted" role="status">
          {paused ? 'Paused' : 'Checking every 3 seconds'} · {plural(visible.length, 'event')}
        </span>
      </div>
      {error && <ErrorNote message={`The live feed stopped. ${error}`} />}
      <section className="mc-panel mc-panel-flush" aria-label="Live events">
        <table className="mc-table mc-live-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Person</th>
              <th scope="col">Event</th>
              <th scope="col">Where</th>
              <th scope="col">Device</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((event) => {
              const device = deviceLabel(event)
              const properties = Object.entries(event.properties)
              return (
                <tr key={event.id} className={open === event.id ? 'is-open' : undefined}>
                  <td data-label="Time" className="mc-num">
                    {time.clock(event.time)}
                  </td>
                  <td data-label="Person">
                    <PersonCell
                      person={{
                        id: event.person_id,
                        distinct_id: event.distinct_id,
                        traits: event.traits,
                        user_id: event.user_id,
                      }}
                      href={href({
                        name: 'person',
                        projectId: project.id,
                        personId: event.person_id,
                      })}
                    />
                  </td>
                  <td data-label="Event">
                    <button
                      type="button"
                      className="mc-row-button mc-mono"
                      aria-expanded={open === event.id}
                      onClick={() => setOpen(open === event.id ? null : event.id)}
                    >
                      {event.name}
                    </button>
                    <span className="mc-sub">
                      {event.screen ?? ''}
                      {event.environment === 'development' && (
                        <Pill tone="warning">Development</Pill>
                      )}
                      {event.bot && <Pill tone="negative">Bot</Pill>}
                    </span>
                    {open === event.id && (
                      <dl className="mc-props">
                        {properties.length ? (
                          properties.map(([key, value]) => (
                            <div key={key}>
                              <dt className="mc-mono">{key}</dt>
                              <dd className="mc-mono">
                                {typeof value === 'string' ? value : JSON.stringify(value)}
                              </dd>
                            </div>
                          ))
                        ) : (
                          <div>
                            <dt>Properties</dt>
                            <dd className="mc-muted">None</dd>
                          </div>
                        )}
                        {event.session_id && (
                          <div>
                            <dt>Session</dt>
                            <dd>
                              <a
                                className="mc-link"
                                href={href({
                                  name: 'session',
                                  projectId: project.id,
                                  sessionId: event.session_id,
                                })}
                              >
                                Open the session
                              </a>
                            </dd>
                          </div>
                        )}
                      </dl>
                    )}
                  </td>
                  <td data-label="Where">
                    <span className="mc-truncate">{placeLabel(event)}</span>
                  </td>
                  <td data-label="Device">
                    <span className="mc-truncate">{device.primary}</span>
                    <span className="mc-sub mc-truncate">{platformLabels[event.platform]}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!visible.length && (
          <Empty>
            {!loaded
              ? 'Connecting to the live feed.'
              : filter
                ? `No live events named like “${filter}” yet.`
                : `Waiting for ${project.name} to send an event. Events from the last 24 hours show here.`}
          </Empty>
        )}
      </section>
    </div>
  )
}

const breakdownOptions: Array<{ value: Breakdown; label: string }> = [
  { value: 'none', label: 'No breakdown' },
  { value: 'platform', label: 'By platform' },
  { value: 'country', label: 'By country' },
  { value: 'app_version', label: 'By app version' },
  { value: 'browser', label: 'By browser' },
]

function keyLabel(breakdown: Breakdown, key: string): string {
  if (breakdown === 'country') return key === 'Unknown' ? 'Unknown' : countryName(key)
  if (breakdown === 'platform') return platformLabels[key as keyof typeof platformLabels] ?? key
  if (breakdown === 'none') return 'Users'
  return key
}

export function EventDetailScreen({ project, eventName }: { project: Project; eventName: string }) {
  const { now, workspace, notify } = useStore()
  const time = timeIn(project.timezone)
  const [range, setRange] = useState<Range>('30d')
  const [breakdown, setBreakdown] = useState<Breakdown>('none')
  const detail = useRpc(
    `event:${project.id}:${eventName}:${range}:${breakdown}`,
    () => api.event(project.id, eventName, range, breakdown),
    { pollMs: 60_000 },
  )
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const data = detail.data
  const canEdit = canDo(workspace?.role, 'developer')

  const back = (
    <a className="mc-back" href={href({ name: 'events', projectId: project.id })}>
      <ArrowLeft size={16} aria-hidden="true" /> All events
    </a>
  )
  if (detail.error && !data) {
    return (
      <div className="mc-page">
        {back}
        <PageHeader title={<span className="mc-mono">{eventName}</span>} />
        <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
      </div>
    )
  }

  const save = async (status: 'live' | 'blocked', text?: string) => {
    setBusy(true)
    try {
      await api.setEvent(project.id, eventName, status, text)
      notify(
        status === 'blocked'
          ? `${eventName} is blocked: new ones are refused`
          : text !== undefined
            ? 'Description saved'
            : `${eventName} is collected again`,
      )
      setEditing(false)
      await detail.refresh()
    } catch (problem) {
      notify(problem instanceof Error ? problem.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  const keys = (data?.keys ?? []).slice(0, 4)
  const hourly = data?.range.bucket === 'hour'
  const series = data
    ? keys.map((key, index) => ({
        key,
        label: keyLabel(breakdown, key),
        color: seriesColors[index],
        points: data.series.map((point) => ({
          time: Date.parse(point.start),
          value: point.users[key] ?? 0,
          partial: point.partial,
        })),
      }))
    : []
  const definition = data?.definition

  return (
    <div className="mc-page">
      {back}
      <PageHeader
        title={<span className="mc-mono">{eventName}</span>}
        description={
          definition ? (
            <>
              {definition.status === 'blocked' && <Pill tone="negative">Blocked</Pill>}{' '}
              {definition.description ?? 'No description yet.'} First seen{' '}
              {time.longDate(definition.first_seen)}, last{' '}
              {formatAgo(definition.last_seen, Math.max(now, Date.parse(definition.last_seen)))}.
            </>
          ) : undefined
        }
        actions={
          <>
            <Segmented
              label="Date range"
              value={range}
              onChange={setRange}
              options={rangeOptions}
            />
            {canEdit && definition && (
              <>
                <button
                  type="button"
                  className="mc-btn mc-btn-secondary"
                  onClick={() => {
                    setDescription(definition.description ?? '')
                    setEditing(true)
                  }}
                >
                  Describe
                </button>
                {definition.status === 'blocked' ? (
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    disabled={busy}
                    onClick={() => void save('live')}
                  >
                    <CircleCheck size={16} aria-hidden="true" /> Collect again
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mc-btn mc-btn-danger"
                    disabled={busy}
                    onClick={() => void save('blocked')}
                  >
                    <Ban size={16} aria-hidden="true" /> Block
                  </button>
                )}
              </>
            )}
          </>
        }
      />
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Describe this event"
        description="Teammates see it in the events list and on this page."
      >
        <form
          className="mc-form-stack"
          onSubmit={(event) => {
            event.preventDefault()
            void save(definition?.status ?? 'live', description)
          }}
        >
          <Field label="Description" hint="Up to 200 characters.">
            {(props) => (
              <input
                {...props}
                maxLength={200}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>
          <div className="mc-form-actions">
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </Dialog>

      <div
        className="mc-kpis mc-kpis-4"
        role="group"
        aria-label={`${eventName} ${rangePhrase[range]}`}
      >
        <div className="mc-kpi">
          <span className="mc-kpi-label">Users who did it</span>
          <strong className="mc-kpi-value mc-num">
            {data ? formatCount(data.totals.users) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {data
              ? `${formatPercent(data.totals.users, data.active_users)} of ${formatCount(data.active_users)} active users`
              : ''}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Times</span>
          <strong className="mc-kpi-value mc-num">
            {data ? formatCount(data.totals.events) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {data ? `in ${plural(data.totals.sessions, 'session')}` : ''}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Per user</span>
          <strong className="mc-kpi-value mc-num">
            {data ? (
              data.totals.users ? (
                formatDecimal(data.totals.events / data.totals.users)
              ) : (
                '0'
              )
            ) : (
              <Skeleton width={60} height={28} />
            )}
          </strong>
          <span className="mc-sub">times on average</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Properties</span>
          <strong className="mc-kpi-value mc-num">
            {data ? formatCount(data.properties.length) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {data ? `from the last ${formatCount(data.sample_size)} events` : ''}
          </span>
        </div>
      </div>

      <Panel
        title="Users over time"
        description={hourly ? 'Per hour, last 24 hours' : `Per day, ${rangePhrase[range]}`}
        id="mc-event-chart"
        actions={
          <Select
            label="Breakdown"
            hideLabel
            value={breakdown}
            onChange={setBreakdown}
            options={breakdownOptions}
          />
        }
      >
        {series.length > 1 && (
          <div className="mc-legend" aria-hidden="true">
            {series.map((line) => (
              <span key={line.key}>
                <i style={{ background: line.color }} /> {line.label}
              </span>
            ))}
          </div>
        )}
        {data ? (
          series.length ? (
            <LineChart
              label={`Users who sent ${eventName}`}
              series={series}
              height={240}
              formatX={hourly ? time.time : time.date}
              formatTooltip={
                hourly ? (value) => `${time.date(value)}, ${time.time(value)}` : time.weekday
              }
            />
          ) : (
            <LineChart
              label={`Users who sent ${eventName}`}
              series={[
                {
                  key: 'none',
                  label: 'Users',
                  color: seriesColors[0],
                  points: data.series.map((point) => ({
                    time: Date.parse(point.start),
                    value: 0,
                    partial: point.partial,
                  })),
                },
              ]}
              height={240}
              formatX={hourly ? time.time : time.date}
              empty={`Nobody sent ${eventName} ${rangePhrase[range]}.`}
            />
          )
        ) : (
          <div className="mc-chart" style={{ height: 240 }} aria-hidden="true" />
        )}
        {data && data.keys.length > 4 && (
          <p className="mc-panel-note mc-muted">
            The four largest groups are drawn; the table lists them all.
          </p>
        )}
      </Panel>

      <div className="mc-grid">
        {breakdown !== 'none' && (
          <Panel title="Breakdown" id="mc-event-breakdown" className="mc-span-5" flush>
            {data?.breakdown.length ? (
              <table className="mc-table">
                <thead>
                  <tr>
                    <th scope="col">
                      {breakdownOptions
                        .find((option) => option.value === breakdown)
                        ?.label.replace('By ', '')}
                    </th>
                    <th scope="col" className="mc-num-col">
                      Users
                    </th>
                    <th scope="col" className="mc-num-col">
                      Times
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((row) => (
                    <tr key={row.key}>
                      <td data-label="Group">{keyLabel(breakdown, row.key)}</td>
                      <td data-label="Users" className="mc-num mc-num-col">
                        {formatCount(row.users)}
                      </td>
                      <td data-label="Times" className="mc-num mc-num-col">
                        {formatCount(row.events)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No data {rangePhrase[range]}.</Empty>
            )}
          </Panel>
        )}
        <Panel
          title="Properties"
          description="Keys sent with this event and their most common values"
          id="mc-event-props"
          className={breakdown !== 'none' ? 'mc-span-7' : 'mc-span-12'}
          flush
        >
          {data?.properties.length ? (
            <table className="mc-table mc-props-table">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="mc-num-col">
                    Sent with
                  </th>
                  <th scope="col">Top values</th>
                </tr>
              </thead>
              <tbody>
                {data.properties.map((property) => (
                  <tr key={property.key}>
                    <td data-label="Property" className="mc-mono">
                      {property.key}
                    </td>
                    <td data-label="Type">{property.types.join(', ')}</td>
                    <td data-label="Sent with" className="mc-num mc-num-col">
                      {formatPercent(property.seen, data.sample_size)}
                    </td>
                    <td data-label="Top values">
                      <span className="mc-values">
                        {(property.values ?? []).map((value) => (
                          <span key={String(value.value)} className="mc-tag">
                            <span className="mc-mono">{value.value ?? 'null'}</span>{' '}
                            <span className="mc-muted mc-num">{formatCount(value.count)}</span>
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>
              {data ? 'This event has been sent without properties.' : 'Loading properties.'}
            </Empty>
          )}
        </Panel>
      </div>

      <Panel
        title="Latest"
        description="Newest first, up to 25, with who did it"
        id="mc-event-recent"
        flush
      >
        {data?.recent.length ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Person</th>
                <th scope="col">Where</th>
                <th scope="col">Properties</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((row) => (
                <tr key={row.id}>
                  <td data-label="Time" className="mc-num">
                    {row.session_id ? (
                      <a
                        className="mc-link"
                        href={href({
                          name: 'session',
                          projectId: project.id,
                          sessionId: row.session_id,
                        })}
                      >
                        {time.dateTime(row.time)}
                      </a>
                    ) : (
                      time.dateTime(row.time)
                    )}
                  </td>
                  <td data-label="Person">
                    <PersonCell
                      person={{
                        id: row.person_id,
                        distinct_id: row.distinct_id,
                        traits: row.traits,
                        user_id: row.user_id,
                      }}
                      href={href({
                        name: 'person',
                        projectId: project.id,
                        personId: row.person_id,
                      })}
                    />
                  </td>
                  <td data-label="Where">
                    {row.country
                      ? countryName(row.country)
                      : row.platform
                        ? platformLabels[row.platform]
                        : 'Server'}
                  </td>
                  <td data-label="Properties" className="mc-mono mc-truncate">
                    {Object.keys(row.properties).length ? (
                      JSON.stringify(row.properties)
                    ) : (
                      <span className="mc-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{data ? `Nobody sent ${eventName} ${rangePhrase[range]}.` : 'Loading.'}</Empty>
        )}
      </Panel>
    </div>
  )
}
