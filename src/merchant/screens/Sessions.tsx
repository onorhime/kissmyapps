import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, ChevronRight, Search } from 'lucide-react'
import { api } from '../api'
import type { EventRow, Project, Range, SessionDetail, SessionsQuery } from '../api'
import {
  botRuleLabels,
  countryName,
  deviceLabel,
  formatAgo,
  formatClockDuration,
  formatDuration,
  languageName,
  placeLabel,
  platformLabels,
  plural,
  referrerHost,
  timeIn,
} from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { useStore } from '../store'
import {
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
import { ReplayPlayer } from '../ui/ReplayPlayer'
import type { ReplayData } from '../ui/ReplayPlayer'
import { useRpc } from '../ui/useRpc'
import { SessionRows } from './Users'

const PAGE = 50

export function SessionsScreen({ project }: { project: Project }) {
  const [range, setRange] = useState<Range>('7d')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('')
  const [country, setCountry] = useState('')
  const [show, setShow] = useState<'all' | 'replay' | 'live'>('all')
  const [minSeconds, setMinSeconds] = useState('0')
  const [bots, setBots] = useState<NonNullable<SessionsQuery['bots']>>('exclude')
  const [limit, setLimit] = useState(PAGE)
  const params: SessionsQuery = {
    range,
    search: query || undefined,
    platform: platform || undefined,
    country: country || undefined,
    replay_only: show === 'replay',
    live_only: show === 'live',
    min_seconds: Number(minSeconds),
    bots,
    limit,
  }
  const sessions = useRpc(
    `sessions:${project.id}:${JSON.stringify(params)}`,
    () => api.sessions(project.id, params),
    { pollMs: show === 'live' ? 10_000 : 60_000 },
  )
  const page = sessions.data
  const reset = () => setLimit(PAGE)

  return (
    <div className="mc-page">
      <PageHeader
        title="Sessions"
        description={`Every visit to ${project.name} ${rangePhrase[range]}, with its replay when the visit was on your website.`}
        actions={
          <Segmented
            label="Date range"
            value={range}
            onChange={(value) => {
              setRange(value)
              reset()
            }}
            options={rangeOptions}
          />
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
          <label htmlFor="mc-session-search" className="sr-only">
            Find sessions
          </label>
          <input
            id="mc-session-search"
            type="search"
            placeholder="Person, email or page"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              if (!event.target.value) setQuery('')
            }}
          />
        </form>
        <Segmented
          label="Show"
          value={show}
          onChange={(value) => {
            setShow(value)
            reset()
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'replay', label: 'With replay' },
            { value: 'live', label: 'Live now' },
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
            ...(page?.facets.countries ?? [])
              .map((value) => ({ value, label: countryName(value) }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          ]}
        />
        <Select
          label="Length"
          hideLabel
          value={minSeconds}
          onChange={(value) => {
            setMinSeconds(value)
            reset()
          }}
          options={[
            { value: '0', label: 'Any length' },
            { value: '10', label: '10 s or longer' },
            { value: '60', label: '1 min or longer' },
            { value: '300', label: '5 min or longer' },
          ]}
        />
        <Select
          label="Bots"
          hideLabel
          value={bots}
          onChange={(value) => {
            setBots(value)
            reset()
          }}
          options={[
            { value: 'exclude', label: 'People only' },
            { value: 'include', label: 'People and bots' },
            { value: 'only', label: 'Bots only' },
          ]}
        />
        <span className="mc-toolbar-count mc-muted">
          {page ? plural(page.total, 'session') : ''}
        </span>
      </div>
      {sessions.error && (
        <ErrorNote
          message={`Couldn't load sessions. ${sessions.error}`}
          onRetry={() => void sessions.refresh()}
        />
      )}
      <section className="mc-panel mc-panel-flush" aria-label="Sessions">
        {page ? (
          page.rows.length ? (
            <SessionRows sessions={page.rows} project={project} showPerson />
          ) : (
            <Empty>
              {show === 'live'
                ? `Nobody is in a session on ${project.name} right now.`
                : `No sessions ${rangePhrase[range]} with these filters.`}
            </Empty>
          )
        ) : (
          <div className="mc-table-loading" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} width="100%" height={40} />
            ))}
          </div>
        )}
      </section>
      {page && (
        <ShowMore
          shown={page.rows.length}
          total={page.total}
          noun="sessions"
          onMore={() => setLimit((value) => value + PAGE)}
        />
      )}
    </div>
  )
}

function useReplay(projectId: string, sessionId: string, enabled: boolean) {
  const [state, setState] = useState<{
    data: ReplayData | null
    error: string | null
    loading: boolean
  }>({ data: null, error: null, loading: enabled })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async () => {
      setState((current) => ({ ...current, loading: true, error: null }))
      try {
        const events: { type: number; timestamp: number; data?: unknown }[] = []
        let skewMs = 0
        let from: number | null = 0
        let first = true
        while (from !== null) {
          const page = await api.replay(projectId, sessionId, from)
          for (const chunk of page.chunks) {
            const chunkEvents = chunk.events as {
              type: number
              timestamp: number
              data?: unknown
            }[]
            if (first && chunkEvents.length) {
              skewMs = chunk.first_ts - Math.min(...chunkEvents.map((event) => event.timestamp))
              first = false
            }
            events.push(...chunkEvents)
          }
          from = page.next_seq
        }
        events.sort((a, b) => a.timestamp - b.timestamp)
        if (!cancelled) setState({ data: { events, skewMs }, error: null, loading: false })
      } catch (problem) {
        if (!cancelled)
          setState({
            data: null,
            error: problem instanceof Error ? problem.message : 'The replay could not load.',
            loading: false,
          })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, enabled, nonce])
  return { ...state, reload: useCallback(() => setNonce((value) => value + 1), []) }
}

function EventList({
  events,
  replay,
  time,
  current,
  onSeek,
}: {
  events: EventRow[]
  replay: ReplayData | null
  time: ReturnType<typeof timeIn>
  current: number | null
  onSeek?: (offset: number) => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const start = replay?.events[0]?.timestamp ?? null
  const offsets = events.map((event) =>
    start !== null && replay ? Date.parse(event.time) - replay.skewMs - start : null,
  )
  let activeIndex = -1
  if (current !== null)
    offsets.forEach((offset, index) => {
      if (offset !== null && offset <= current) activeIndex = index
    })
  return (
    <ol className="mc-session-events" tabIndex={0} aria-label="Session events">
      {events.map((event, index) => {
        const offset = offsets[index]
        const properties = Object.entries(event.properties)
        return (
          <li key={event.id} className={index === activeIndex ? 'is-current' : undefined}>
            <div className="mc-session-event">
              {offset !== null && offset >= 0 && onSeek ? (
                <button
                  type="button"
                  className="mc-session-time mc-num"
                  onClick={() => onSeek(offset)}
                  aria-label={`Jump to ${event.name} at ${formatClockDuration(offset)}`}
                >
                  {formatClockDuration(offset)}
                </button>
              ) : (
                <span className="mc-session-time mc-num mc-muted">{time.clock(event.time)}</span>
              )}
              <span className={event.name === 'error_thrown' ? 'mc-mono is-negative' : 'mc-mono'}>
                {event.name}
              </span>
              {properties.length > 0 && (
                <button
                  type="button"
                  className="mc-icon-btn"
                  aria-expanded={open === event.id}
                  aria-label={`Properties of ${event.name}`}
                  onClick={() => setOpen(open === event.id ? null : event.id)}
                >
                  <ChevronRight
                    size={14}
                    aria-hidden="true"
                    className={open === event.id ? 'is-open' : undefined}
                  />
                </button>
              )}
            </div>
            {event.screen && <span className="mc-sub mc-mono mc-truncate">{event.screen}</span>}
            {open === event.id && (
              <dl className="mc-props">
                {properties.map(([key, value]) => (
                  <div key={key}>
                    <dt className="mc-mono">{key}</dt>
                    <dd className="mc-mono">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function NoReplay({ detail, project }: { detail: SessionDetail; project: Project }) {
  const session = detail.session
  const reason =
    session.platform !== 'web'
      ? `Replays are recorded on websites. This session came from the ${platformLabels[session.platform]}, so its events are listed instead.`
      : !project.replay_enabled
        ? 'Session replay is turned off for this project. Turn it on in project settings to record new visits.'
        : 'No recording arrived for this visit. The visitor may have left within seconds, opted out, or the site loads the SDK with replay turned off.'
  return (
    <div className="mc-replay-missing">
      <p>{reason}</p>
      {session.platform === 'web' && !project.replay_enabled && (
        <a
          className="mc-link"
          href={href({ name: 'settings', projectId: project.id, section: 'general' })}
        >
          Open project settings
        </a>
      )}
    </div>
  )
}

export function SessionDetailScreen({
  project,
  sessionId,
}: {
  project: Project
  sessionId: string
}) {
  const { now } = useStore()
  const time = timeIn(project.timezone)
  const detail = useRpc(`session:${project.id}:${sessionId}`, () =>
    api.session(project.id, sessionId),
  )
  const data = detail.data
  const live = data?.session.live ?? false
  const refreshDetail = detail.refresh
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void refreshDetail(), 10_000)
    return () => window.clearInterval(timer)
  }, [live, refreshDetail])
  const replay = useReplay(project.id, sessionId, Boolean(data?.session.has_replay))
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [seekTo, setSeekTo] = useState<{ time: number; nonce: number } | null>(null)
  const events = useMemo(() => data?.events ?? [], [data])

  const back = (
    <a className="mc-back" href={href({ name: 'sessions', projectId: project.id })}>
      <ArrowLeft size={16} aria-hidden="true" /> All sessions
    </a>
  )
  if (detail.error && !data) {
    return (
      <div className="mc-page">
        {back}
        <PageHeader title="Session" />
        <ErrorNote message={detail.error} onRetry={() => void detail.refresh()} />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mc-page" aria-busy="true">
        {back}
        <Skeleton width={280} height={28} />
        <Skeleton width="100%" height={420} />
      </div>
    )
  }
  const session = data.session
  const device = deviceLabel(session)
  const source = session.utm_source ?? referrerHost(session.referrer)

  return (
    <div className="mc-page">
      {back}
      <header className="mc-session-head">
        <PersonCell
          person={data.person}
          online={data.person.online}
          href={href({ name: 'person', projectId: project.id, personId: data.person.id })}
        />
        <div className="mc-page-title">
          <h1 tabIndex={-1} id="mc-page-title">
            {time.weekday(session.started_at)}, {time.time(session.started_at)}
          </h1>
          <p>
            {formatDuration(session.duration_seconds)} · {plural(session.events_count, 'event')} ·{' '}
            {plural(session.screens_count, 'screen')}
            {session.live ? (
              <>
                {' '}
                <Pill tone="positive">Live now</Pill>
              </>
            ) : (
              ` · ${formatAgo(session.ended_at, Math.max(now, Date.parse(session.ended_at)))}`
            )}
          </p>
        </div>
      </header>

      <dl className="mc-facts mc-facts-row mc-session-facts">
        <div>
          <dt>Location</dt>
          <dd>
            {placeLabel(session)}
            {session.location_source === 'timezone' && (
              <span className="mc-sub">From the device time zone</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>
            {device.primary}
            {device.secondary && <span className="mc-sub">{device.secondary}</span>}
          </dd>
        </div>
        <div>
          <dt>Language</dt>
          <dd>
            {session.language ? (
              languageName(session.language)
            ) : (
              <span className="mc-muted">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Came from</dt>
          <dd>
            {source ??
              (session.platform === 'web' ? 'Direct' : <span className="mc-muted">—</span>)}
            {session.utm_campaign && (
              <span className="mc-sub">Campaign {session.utm_campaign}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Journey</dt>
          <dd className="mc-mono">
            {session.entry_screen ?? '—'}
            {session.exit_screen && session.exit_screen !== session.entry_screen
              ? ` → ${session.exit_screen}`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Screen</dt>
          <dd className="mc-num">
            {session.screen_width && session.screen_height ? (
              `${session.screen_width} × ${session.screen_height}`
            ) : (
              <span className="mc-muted">—</span>
            )}
          </dd>
        </div>
      </dl>

      {session.bot_reasons.length > 0 && (
        <p className={session.excluded ? 'mc-bot-banner is-excluded' : 'mc-bot-banner'}>
          <Bot size={16} aria-hidden="true" />
          <span>
            Flagged as{' '}
            {session.bot_reasons
              .map((rule) => botRuleLabels[rule].name.toLowerCase())
              .join(' and ')}
            .{' '}
            {session.excluded
              ? 'Left out of reports.'
              : 'Counted in reports because this person was marked as a person or the rule is off.'}
          </span>
          <a className="mc-link" href={href({ name: 'bots', projectId: project.id })}>
            Bot settings
          </a>
        </p>
      )}

      <div className="mc-session-layout">
        <section className="mc-panel mc-session-player" aria-label="Session replay">
          {session.has_replay ? (
            replay.data ? (
              <ReplayPlayer
                replay={replay.data}
                events={events}
                onTime={setPlayhead}
                seekTo={seekTo}
              />
            ) : replay.error ? (
              <ErrorNote
                message={`The replay could not load. ${replay.error}`}
                onRetry={replay.reload}
              />
            ) : (
              <div className="mc-replay-missing" role="status">
                <p>
                  Loading the recording ({Math.max(1, Math.round(data.replay.bytes / 1024))} kB)
                </p>
              </div>
            )
          ) : (
            <NoReplay detail={data} project={project} />
          )}
          {session.live && session.has_replay && (
            <button type="button" className="mc-text-btn" onClick={replay.reload}>
              Load the latest part of this live session
            </button>
          )}
        </section>
        <Panel
          title="Events"
          description={
            replay.data
              ? 'Select a time to jump there in the replay'
              : `Times on ${project.timezone} time`
          }
          id="mc-session-events"
          className="mc-session-side"
        >
          {events.length ? (
            <EventList
              events={events}
              replay={replay.data}
              time={time}
              current={playhead}
              onSeek={
                replay.data ? (offset) => setSeekTo({ time: offset, nonce: Date.now() }) : undefined
              }
            />
          ) : (
            <Empty>This session has no events yet.</Empty>
          )}
        </Panel>
      </div>
      {session.user_agent && (
        <p className="mc-muted mc-page-foot mc-break">
          <span className="mc-mono">{session.user_agent}</span>
        </p>
      )}
    </div>
  )
}
