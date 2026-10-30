import { useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, Bot, Download, Play, Search, ShieldCheck, ShieldOff } from 'lucide-react'
import { api } from '../api'
import type { PeopleQuery, Person, Project, Range, Session } from '../api'
import { toCsv, downloadCsv } from '../csv'
import {
  botRuleLabels,
  countryName,
  deviceLabel,
  formatAgo,
  formatCount,
  formatDuration,
  languageName,
  localClock,
  personLabel,
  placeLabel,
  platformLabels,
  plural,
  referrerHost,
  timeIn,
} from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { canDo, useStore } from '../store'
import {
  Avatar,
  Empty,
  ErrorNote,
  PageHeader,
  Panel,
  PersonCell,
  Pill,
  Segmented,
  Select,
  ShowMore,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

const PAGE = 50
const EXPORT_MAX = 50_000

function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '')
}

export function UsersScreen({ project }: { project: Project }) {
  const { now, notify } = useStore()
  const time = timeIn(project.timezone)
  const initial = hashParams()
  const [range, setRange] = useState<Range>('30d')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<NonNullable<PeopleQuery['status']>>(
    (['online', 'new', 'returning'] as const).find((value) => value === initial.get('status')) ??
      'all',
  )
  const [platform, setPlatform] = useState('')
  const [country, setCountry] = useState(initial.get('country') ?? '')
  const [sort, setSort] = useState<NonNullable<PeopleQuery['sort']>>('last_seen')
  const [limit, setLimit] = useState(PAGE)
  const params: PeopleQuery = {
    range,
    search: query || undefined,
    status,
    platform: platform || undefined,
    country: country || undefined,
    sort,
    limit,
  }
  const people = useRpc(
    `people:${project.id}:${JSON.stringify(params)}`,
    () => api.people(project.id, params),
    { pollMs: status === 'online' ? 15_000 : 60_000 },
  )
  const page = people.data
  const reset = () => setLimit(PAGE)

  const [exporting, setExporting] = useState(false)
  // Exports everyone matching the filters, not only the rows on screen.
  const exportCsv = async () => {
    if (!page) return
    setExporting(true)
    const everyone: Person[] = []
    try {
      while (everyone.length < Math.min(page.total, EXPORT_MAX)) {
        const next = await api.people(project.id, {
          ...params,
          limit: 1000,
          offset: everyone.length,
        })
        everyone.push(...next.rows)
        if (!next.rows.length) break
      }
    } catch (problem) {
      notify(problem instanceof Error ? `Export failed. ${problem.message}` : 'Export failed.')
      return
    } finally {
      setExporting(false)
    }
    const rows = everyone.map((person) => {
      const label = personLabel(person)
      return {
        user_id: person.user_id ?? '',
        anonymous_id: person.user_id ? '' : person.distinct_id,
        name: label.anonymous ? '' : label.name,
        email: typeof person.traits.email === 'string' ? person.traits.email : '',
        country: person.country ?? '',
        city: person.city ?? '',
        platform: person.platform ?? '',
        device: deviceLabel(person).primary,
        os: [person.os_name, person.os_version].filter(Boolean).join(' '),
        first_seen: person.first_seen,
        last_seen: person.last_seen,
        sessions: person.sessions_count,
        events: person.events_count,
      }
    })
    downloadCsv(`${project.name}-users-${range}.csv`, toCsv(rows))
  }

  return (
    <div className="mc-page">
      <PageHeader
        title="Users"
        description={
          query
            ? `Everyone in ${project.name} matching “${query}”, at any time.`
            : `People who used ${project.name} ${rangePhrase[range]}, newest activity first.`
        }
        actions={
          <>
            <Segmented
              label="Date range"
              value={range}
              onChange={(value) => {
                setRange(value)
                reset()
              }}
              options={rangeOptions}
            />
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => void exportCsv()}
              disabled={!page?.rows.length || exporting}
            >
              <Download size={16} aria-hidden="true" />
              {exporting ? 'Exporting' : 'Export CSV'}
            </button>
          </>
        }
      />
      <div className="mc-toolbar">
        <form
          className="mc-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(search.trim())
            reset()
          }}
        >
          <Search size={16} aria-hidden="true" />
          <label htmlFor="mc-user-search" className="sr-only">
            Find a person
          </label>
          <input
            id="mc-user-search"
            type="search"
            placeholder="User ID, email, name or device ID"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              if (!event.target.value) setQuery('')
            }}
          />
        </form>
        <Segmented
          label="Show"
          value={status}
          onChange={(value) => {
            setStatus(value)
            reset()
          }}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'online', label: 'Online now' },
            { value: 'new', label: 'New' },
            { value: 'returning', label: 'Returning' },
          ]}
        />
        <Select
          label="Platform"
          hideLabel
          value={platform}
          onChange={(value) => {
            setPlatform(value)
            reset()
          }}
          options={[
            { value: '', label: 'All platforms' },
            ...(page?.facets.platforms ?? []).map((value) => ({
              value,
              label: platformLabels[value],
            })),
          ]}
        />
        <Select
          label="Country"
          hideLabel
          value={country}
          onChange={(value) => {
            setCountry(value)
            reset()
          }}
          options={[
            { value: '', label: 'All countries' },
            ...[...new Set([...(page?.facets.countries ?? []), ...(country ? [country] : [])])]
              .map((value) => ({ value, label: countryName(value) }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          ]}
        />
        <Select
          label="Sort by"
          hideLabel
          value={sort}
          onChange={(value) => {
            setSort(value)
            reset()
          }}
          options={[
            { value: 'last_seen', label: 'Last seen' },
            { value: 'first_seen', label: 'First seen' },
            { value: 'sessions', label: 'Most sessions' },
            { value: 'events', label: 'Most events' },
          ]}
        />
        <span className="mc-toolbar-count mc-muted">
          {page ? plural(page.total, 'person', 'people') : ''}
        </span>
      </div>

      {people.error && (
        <ErrorNote
          message={`Couldn't load people. ${people.error}`}
          onRetry={() => void people.refresh()}
        />
      )}
      <section className="mc-panel mc-panel-flush" aria-label="People">
        <table className="mc-table mc-people-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Location</th>
              <th scope="col">Device</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
              <th scope="col" className="mc-num-col">
                Sessions
              </th>
              <th scope="col" className="mc-num-col">
                Events
              </th>
            </tr>
          </thead>
          <tbody>
            {!page &&
              [0, 1, 2, 3, 4].map((index) => (
                <tr key={index} aria-hidden="true">
                  {[160, 120, 120, 80, 80, 40, 40].map((width, cell) => (
                    <td key={cell}>
                      <Skeleton width={width} />
                    </td>
                  ))}
                </tr>
              ))}
            {page?.rows.map((person) => (
              <PersonRow key={person.id} person={person} project={project} now={now} time={time} />
            ))}
          </tbody>
        </table>
        {page && !page.rows.length && (
          <Empty>
            {query
              ? `Nobody in ${project.name} matches “${query}”.`
              : status === 'online'
                ? `Nobody is using ${project.name} right now.`
                : `No people ${rangePhrase[range]} with these filters.`}
          </Empty>
        )}
      </section>
      {page && (
        <ShowMore
          shown={page.rows.length}
          total={page.total}
          noun="people"
          onMore={() => setLimit((value) => value + PAGE)}
        />
      )}
    </div>
  )
}

function PersonRow({
  person,
  project,
  now,
  time,
}: {
  person: Person
  project: Project
  now: number
  time: ReturnType<typeof timeIn>
}) {
  const device = deviceLabel(person)
  const link = href({ name: 'person', projectId: project.id, personId: person.id })
  return (
    <tr className="mc-row-link">
      <td data-label="Person">
        <PersonCell person={person} href={link} online={person.online} />
      </td>
      <td data-label="Location">
        <span className="mc-truncate">{placeLabel(person)}</span>
        {person.timezone && (
          <span className="mc-sub mc-truncate">{localClock(person.timezone, now)} local</span>
        )}
      </td>
      <td data-label="Device">
        <span className="mc-truncate">{device.primary}</span>
        {device.secondary && <span className="mc-sub mc-truncate">{device.secondary}</span>}
      </td>
      <td data-label="First seen">
        <span className="mc-num">{time.date(person.first_seen)}</span>
        <span className="mc-sub">{formatAgo(person.first_seen, now)}</span>
      </td>
      <td data-label="Last seen">
        {person.online ? (
          <Pill tone="positive">Online now</Pill>
        ) : (
          <span className="mc-num">
            {formatAgo(person.last_seen, Math.max(now, Date.parse(person.last_seen)))}
          </span>
        )}
        <span className="mc-sub mc-num">{time.dateTime(person.last_seen)}</span>
      </td>
      <td data-label="Sessions" className="mc-num mc-num-col">
        {formatCount(person.sessions_count)}
      </td>
      <td data-label="Events" className="mc-num mc-num-col">
        {formatCount(person.events_count)}
      </td>
    </tr>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children ?? <span className="mc-muted">—</span>}</dd>
    </div>
  )
}

export function SessionRows({
  sessions,
  project,
  showPerson = false,
}: {
  sessions: Session[]
  project: Project
  showPerson?: boolean
}) {
  const { now } = useStore()
  const time = timeIn(project.timezone)
  return (
    <table className="mc-table mc-sessions-table">
      <thead>
        <tr>
          {showPerson && <th scope="col">Person</th>}
          <th scope="col">Started</th>
          <th scope="col">Length</th>
          <th scope="col">Location</th>
          <th scope="col">Device</th>
          <th scope="col">Journey</th>
          <th scope="col" className="mc-num-col">
            Events
          </th>
          <th scope="col">Replay</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => {
          const device = deviceLabel(session)
          const link = href({ name: 'session', projectId: project.id, sessionId: session.id })
          return (
            <tr key={session.id} className="mc-row-link">
              {showPerson && (
                <td data-label="Person">
                  <PersonCell
                    person={{
                      id: session.person_id,
                      distinct_id: session.distinct_id ?? session.person_id,
                      user_id: session.user_id,
                      traits: session.traits,
                    }}
                    href={href({
                      name: 'person',
                      projectId: project.id,
                      personId: session.person_id,
                    })}
                    online={session.live}
                  />
                </td>
              )}
              <td data-label="Started">
                <a className="mc-link mc-num" href={link}>
                  {time.dateTime(session.started_at)}
                </a>
                <span className="mc-sub">
                  {session.live ? 'Live now' : formatAgo(session.started_at, now)}
                  {session.excluded && ' · left out as a bot'}
                </span>
              </td>
              <td data-label="Length" className="mc-num">
                {formatDuration(session.duration_seconds)}
              </td>
              <td data-label="Location">
                <span className="mc-truncate">{placeLabel(session)}</span>
              </td>
              <td data-label="Device">
                <span className="mc-truncate">{device.primary}</span>
                {device.secondary && <span className="mc-sub mc-truncate">{device.secondary}</span>}
              </td>
              <td data-label="Journey">
                <span className="mc-truncate mc-mono">
                  {session.entry_screen ?? '—'}
                  {session.exit_screen && session.exit_screen !== session.entry_screen
                    ? ` → ${session.exit_screen}`
                    : ''}
                </span>
                <span className="mc-sub">
                  {plural(session.screens_count, 'screen')}
                  {session.errors_count ? ` · ${plural(session.errors_count, 'error')}` : ''}
                </span>
              </td>
              <td data-label="Events" className="mc-num mc-num-col">
                {formatCount(session.events_count)}
              </td>
              <td data-label="Replay">
                {session.has_replay ? (
                  <a
                    className="mc-replay-link"
                    href={link}
                    aria-label={`Watch the session from ${time.dateTime(session.started_at)}`}
                  >
                    <Play size={14} aria-hidden="true" /> Watch
                  </a>
                ) : (
                  <span className="mc-muted">{session.platform === 'web' ? 'None' : 'App'}</span>
                )}
                {session.bot_reasons.length > 0 && (
                  <span className="mc-sub">
                    <Bot size={12} aria-hidden="true" />{' '}
                    {session.bot_reasons.map((rule) => botRuleLabels[rule].name).join(', ')}
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function PersonScreen({ project, personId }: { project: Project; personId: string }) {
  const { now, workspace, notify } = useStore()
  const time = timeIn(project.timezone)
  const detail = useRpc(
    `person:${project.id}:${personId}`,
    () => api.person(project.id, personId),
    { pollMs: 30_000 },
  )
  const [busy, setBusy] = useState(false)
  const data = detail.data
  const back = (
    <a className="mc-back" href={href({ name: 'users', projectId: project.id })}>
      <ArrowLeft size={16} aria-hidden="true" /> All users
    </a>
  )

  if (detail.error && !data) {
    return (
      <div className="mc-page">
        {back}
        <PageHeader title="User" />
        <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mc-page" aria-busy="true">
        {back}
        <Skeleton width={240} height={28} />
        <Skeleton width={360} height={16} />
      </div>
    )
  }

  const person = data.person
  const label = personLabel(person)
  const traits = Object.entries(person.traits).filter(([key]) => !['name', 'email'].includes(key))
  const canEdit = canDo(workspace?.role, 'developer')
  const verdict = data.override?.verdict
  const setVerdict = async (next: 'human' | 'bot' | null) => {
    setBusy(true)
    try {
      if (next === null && data.override) await api.deleteOverride(data.override.id)
      else if (next) await api.setOverride(project.id, next, person.id)
      notify(
        next === 'bot'
          ? 'Blocked: this person is left out of reports and new events are refused'
          : next === 'human'
            ? 'Marked as a person: their sessions count in reports'
            : 'Mark removed',
      )
      await detail.refresh()
    } catch (problem) {
      notify(problem instanceof Error ? problem.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mc-page">
      {back}
      <header className="mc-profile-head">
        <span className="mc-person-avatar-wrap">
          <Avatar id={person.id} name={label.name} size={56} />
          {person.online && <span className="mc-online-badge" aria-label="Online now" />}
        </span>
        <div className="mc-page-title">
          <h1 tabIndex={-1} id="mc-page-title">
            {label.name}
          </h1>
          <p>
            {person.online ? (
              <Pill tone="positive">Online now</Pill>
            ) : (
              <span>
                Last seen {formatAgo(person.last_seen, Math.max(now, Date.parse(person.last_seen)))}
              </span>
            )}{' '}
            {label.anonymous ? <Pill>Not signed in</Pill> : <Pill tone="info">Signed in</Pill>}{' '}
            {verdict === 'bot' && <Pill tone="negative">Blocked as a bot</Pill>}
            {verdict === 'human' && <Pill tone="positive">Marked as a person</Pill>}
            {person.environment === 'development' && <Pill tone="warning">Development</Pill>}
          </p>
        </div>
        {canEdit && (
          <div className="mc-page-actions">
            {verdict ? (
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                disabled={busy}
                onClick={() => void setVerdict(null)}
              >
                Remove mark
              </button>
            ) : (
              <>
                {data.stats.bot_sessions > 0 && (
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    disabled={busy}
                    onClick={() => void setVerdict('human')}
                  >
                    <ShieldCheck size={16} aria-hidden="true" /> Not a bot
                  </button>
                )}
                <button
                  type="button"
                  className="mc-btn mc-btn-danger"
                  disabled={busy}
                  onClick={() => void setVerdict('bot')}
                >
                  <ShieldOff size={16} aria-hidden="true" /> Block as a bot
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <div className="mc-kpis mc-kpis-4" role="group" aria-label="Activity">
        <div className="mc-kpi">
          <span className="mc-kpi-label">Sessions</span>
          <strong className="mc-kpi-value mc-num">{formatCount(person.sessions_count)}</strong>
          <span className="mc-sub">{plural(data.stats.replays, 'replay')}</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Time in app</span>
          <strong className="mc-kpi-value mc-num">
            {formatDuration(data.stats.total_seconds)}
          </strong>
          <span className="mc-sub">{formatDuration(data.stats.avg_seconds)} a session</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Events</span>
          <strong className="mc-kpi-value mc-num">{formatCount(person.events_count)}</strong>
          <span className="mc-sub">
            {data.top_events[0] ? `Most: ${data.top_events[0].name}` : 'None yet'}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">First seen</span>
          <strong className="mc-kpi-value mc-num">{time.longDate(person.first_seen)}</strong>
          <span className="mc-sub">{formatAgo(person.first_seen, now)}</span>
        </div>
      </div>

      <div className="mc-grid">
        <Panel title="Who" id="mc-who" className="mc-span-4">
          <dl className="mc-facts">
            <Fact label="User ID">
              {person.user_id ? <span className="mc-mono">{person.user_id}</span> : null}
            </Fact>
            <Fact label="Email">
              {typeof person.traits.email === 'string' ? person.traits.email : null}
            </Fact>
            <Fact label="Name">
              {typeof person.traits.name === 'string' ? person.traits.name : null}
            </Fact>
            {traits.map(([key, value]) => (
              <Fact key={key} label={key}>
                <span className="mc-mono">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </span>
              </Fact>
            ))}
            <Fact label={person.anonymous_ids.length === 1 ? 'Device ID' : 'Device IDs'}>
              {person.anonymous_ids.length ? (
                <span className="mc-mono mc-break">{person.anonymous_ids.join(', ')}</span>
              ) : null}
            </Fact>
          </dl>
        </Panel>
        <Panel title="Where" id="mc-where-person" className="mc-span-4">
          <dl className="mc-facts">
            <Fact label="Country">
              {person.country ? `${countryName(person.country)} (${person.country})` : null}
            </Fact>
            <Fact label="Region">{person.region}</Fact>
            <Fact label="City">{person.city}</Fact>
            <Fact label="Time zone">{person.timezone}</Fact>
            <Fact label="Their time now">{localClock(person.timezone, now)}</Fact>
            <Fact label="Language">
              {person.language ? `${languageName(person.language)} (${person.language})` : null}
            </Fact>
            {data.stats.countries.length > 1 && (
              <Fact label="Seen in">
                {data.stats.countries.map((code) => countryName(code)).join(', ')}
              </Fact>
            )}
          </dl>
        </Panel>
        <Panel title="Device" id="mc-device-person" className="mc-span-4">
          <dl className="mc-facts">
            <Fact label="Platform">{person.platform ? platformLabels[person.platform] : null}</Fact>
            <Fact label="Device">
              {[person.device_model, person.device_type && `(${person.device_type})`]
                .filter(Boolean)
                .join(' ') || null}
            </Fact>
            <Fact label="System">
              {[person.os_name, person.os_version].filter(Boolean).join(' ') || null}
            </Fact>
            {person.platform === 'web' ? (
              <Fact label="Browser">
                {[person.browser, person.browser_version].filter(Boolean).join(' ') || null}
              </Fact>
            ) : (
              <Fact label="App version">{person.app_version}</Fact>
            )}
            <Fact label="Screen">
              {person.screen_width && person.screen_height
                ? `${person.screen_width} × ${person.screen_height}`
                : null}
            </Fact>
            <Fact label="SDK">{person.sdk}</Fact>
            {data.stats.devices.length > 1 && (
              <Fact label="All devices">{data.stats.devices.join(', ')}</Fact>
            )}
          </dl>
        </Panel>
        <Panel title="How they found you" id="mc-source-person" className="mc-span-12">
          <dl className="mc-facts mc-facts-row">
            <Fact label="First visit from">
              {referrerHost(person.initial_referrer) ??
                (person.platform === 'web' ? 'Direct' : null)}
            </Fact>
            <Fact label="UTM source">{person.initial_utm_source}</Fact>
            <Fact label="UTM medium">{person.initial_utm_medium}</Fact>
            <Fact label="UTM campaign">{person.initial_utm_campaign}</Fact>
            <Fact label="Landing page">
              {person.initial_landing ? (
                <span className="mc-mono">{person.initial_landing}</span>
              ) : null}
            </Fact>
          </dl>
        </Panel>
      </div>

      <Panel
        title="Sessions"
        description={`Newest first, times on ${project.timezone} time`}
        id="mc-person-sessions"
        flush
      >
        {data.sessions.length ? (
          <SessionRows sessions={data.sessions} project={project} />
        ) : (
          <Empty>No sessions yet. Events sent without a session appear below.</Empty>
        )}
      </Panel>

      <div className="mc-grid">
        <Panel title="What they did most" id="mc-person-top" className="mc-span-5">
          {data.top_events.length ? (
            <ol className="mc-count-list">
              {data.top_events.map((event) => (
                <li key={event.name}>
                  <a
                    className="mc-mono mc-link"
                    href={href({ name: 'event', projectId: project.id, eventName: event.name })}
                  >
                    {event.name}
                  </a>
                  <span className="mc-num">{formatCount(event.count)}×</span>
                  <span className="mc-muted mc-num">{formatAgo(event.last, now)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No events yet.</Empty>
          )}
        </Panel>
        <Panel
          title="Latest activity"
          description="The last 50 events"
          id="mc-person-recent"
          className="mc-span-7"
        >
          {data.recent_events.length ? (
            <ol className="mc-timeline" tabIndex={0} aria-label="Latest activity">
              {data.recent_events.map((event) => (
                <li key={event.id}>
                  <span className="mc-num mc-muted">
                    {time.date(event.time)}, {time.clock(event.time)}
                  </span>
                  <span className="mc-mono">{event.name}</span>
                  <span className="mc-muted mc-truncate">{event.screen ?? ''}</span>
                  {event.session_id && (
                    <a
                      className="mc-link"
                      href={href({
                        name: 'session',
                        projectId: project.id,
                        sessionId: event.session_id,
                      })}
                    >
                      Session
                    </a>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No events yet.</Empty>
          )}
        </Panel>
      </div>
    </div>
  )
}
