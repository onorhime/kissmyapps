import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, Play, Timer } from 'lucide-react'
import { api } from '../api'
import type { Kpis, OnlinePerson, Overview, Project, Range, Ranked, RetentionSummary } from '../api'
import {
  countryName,
  deviceLabel,
  deviceTypeLabels,
  formatAgo,
  formatChange,
  formatCount,
  formatDecimal,
  formatDuration,
  formatPercent,
  languageName,
  plural,
  timeIn,
} from '../format'
import { previousPhrase, rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { useStore } from '../store'
import { BarList, LineChart } from '../ui/Charts'
import type { BarRow } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import {
  Empty,
  ErrorNote,
  Freshness,
  PageHeader,
  Panel,
  PersonCell,
  Segmented,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'
import { InstallGuide } from './Settings'

function Delta({
  current,
  previous,
  comparable,
  goodWhenUp = true,
}: {
  current: number
  previous: number
  comparable: boolean
  goodWhenUp?: boolean
}) {
  // Without earlier data the note under the strip says so once, not on every number.
  if (!comparable) return null
  const change = formatChange(current, previous, goodWhenUp)
  return <span className={`mc-kpi-change is-${change.tone}`}>{change.text}</span>
}

// The summary's dates are calendar days in the project's time zone.
const summaryDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** Day 7 retention, which looks back further than the range: it needs a week to pass. */
function BackOnDaySeven({
  summary,
  failed,
  link,
}: {
  summary?: RetentionSummary
  failed: boolean
  link: string
}) {
  return (
    <a className="mc-kpi mc-kpi-link" href={link}>
      <span className="mc-kpi-label">Back on day 7</span>
      {summary ? (
        summary.people ? (
          <>
            <strong className="mc-kpi-value mc-num">
              {formatPercent(summary.returned, summary.people)}
            </strong>
            <span className="mc-sub">
              of {plural(summary.people, 'person', 'people')} first seen{' '}
              {summaryDate.format(Date.parse(summary.from))} to{' '}
              {summaryDate.format(Date.parse(summary.to))}
            </span>
          </>
        ) : (
          <>
            <strong className="mc-kpi-value mc-num mc-muted">—</strong>
            <span className="mc-sub">Needs people first seen over a week ago</span>
          </>
        )
      ) : failed ? (
        <>
          <strong className="mc-kpi-value mc-num mc-muted">—</strong>
          <span className="mc-sub">Couldn't load this. Open retention to try again.</span>
        </>
      ) : (
        <>
          <Skeleton width={72} height={28} />
          <Skeleton width={120} height={14} />
        </>
      )}
    </a>
  )
}

function KpiStrip({
  data,
  range,
  retention,
  retentionFailed,
  retentionLink,
}: {
  data?: Overview
  range: Range
  retention?: RetentionSummary
  retentionFailed: boolean
  retentionLink: string
}) {
  const items: Array<{
    key: keyof Kpis
    label: string
    value: (k: Kpis) => string
    sub?: (k: Kpis) => string
    goodWhenUp?: boolean
  }> = [
    {
      key: 'users',
      label: 'Unique users',
      value: (k) => formatCount(k.users),
      sub: (k) =>
        range === 'today'
          ? 'people active today'
          : `${formatDecimal(k.daily_users)} a day on average`,
    },
    {
      key: 'new_users',
      label: 'New users',
      value: (k) => formatCount(k.new_users),
      sub: (k) => `${formatPercent(k.new_users, k.users)} of users`,
    },
    {
      key: 'returning_users',
      label: 'Returning users',
      value: (k) => formatCount(k.returning_users),
      sub: () => 'first seen before this range',
    },
    {
      key: 'sessions',
      label: 'Sessions',
      value: (k) => formatCount(k.sessions),
      sub: (k) => `${formatDecimal(k.sessions_per_user)} per user`,
    },
    {
      key: 'avg_session_seconds',
      label: 'Average session',
      value: (k) => formatDuration(k.avg_session_seconds),
      sub: (k) => `${formatCount(k.events)} events`,
    },
  ]
  return (
    <div className="mc-kpis mc-kpis-6" role="group" aria-label={`Users ${rangePhrase[range]}`}>
      {items.map((item) => (
        <div key={item.key} className="mc-kpi">
          <span className="mc-kpi-label">{item.label}</span>
          {data ? (
            <>
              <strong className="mc-kpi-value mc-num">{item.value(data.current)}</strong>
              <Delta
                current={data.current[item.key]}
                previous={data.previous[item.key]}
                comparable={data.comparable}
                goodWhenUp={item.goodWhenUp}
              />
              {item.sub && <span className="mc-sub">{item.sub(data.current)}</span>}
            </>
          ) : (
            <>
              <Skeleton width={72} height={28} />
              <Skeleton width={120} height={14} />
            </>
          )}
        </div>
      ))}
      <BackOnDaySeven summary={retention} failed={retentionFailed} link={retentionLink} />
      {data && (
        <p className="mc-kpis-note mc-muted">
          {data.comparable
            ? `Changes ${previousPhrase[range]}.`
            : 'No data from before this range to compare with yet.'}{' '}
          Bots and development traffic are left out.
        </p>
      )}
    </div>
  )
}

function OnlineNow({ project, count }: { project: Project; count?: number }) {
  const { now } = useStore()
  const online = useRpc(`online:${project.id}`, () => api.online(project.id, 12), {
    pollMs: 15_000,
  })
  const people = online.data ?? []
  const total = count ?? people.length
  return (
    <section className="mc-panel mc-online" aria-labelledby="mc-online-title">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-online-title">
            <span className="mc-live-dot" aria-hidden="true" /> Online now
          </h2>
          <p>Active in the last 5 minutes</p>
        </div>
        <strong className="mc-online-count mc-num">
          {online.data || count !== undefined ? (
            formatCount(total)
          ) : (
            <Skeleton width={40} height={32} />
          )}
        </strong>
      </div>
      {online.error && !online.data ? (
        <ErrorNote message={online.error} onRetry={() => void online.refresh()} />
      ) : people.length ? (
        <ul className="mc-online-list">
          {people.map((person: OnlinePerson) => {
            const device = deviceLabel(person)
            return (
              <li key={person.person_id}>
                <PersonCell
                  person={person}
                  online
                  href={href({ name: 'person', projectId: project.id, personId: person.person_id })}
                />
                <span className="mc-online-meta">
                  <span className="mc-truncate">{person.screen ?? 'Just opened'}</span>
                  <span className="mc-muted mc-truncate">
                    {[person.city, countryName(person.country)].filter(Boolean).join(', ')} ·{' '}
                    {device.primary}
                  </span>
                </span>
                <a
                  className="mc-online-session"
                  href={href({
                    name: 'session',
                    projectId: project.id,
                    sessionId: person.session_id,
                  })}
                  aria-label={`Open this session, ${formatDuration((now - Date.parse(person.started_at)) / 1000)} so far`}
                >
                  {/* Only website sessions have a replay to play. */}
                  {person.platform === 'web' ? (
                    <Play size={14} aria-hidden="true" />
                  ) : (
                    <Timer size={14} aria-hidden="true" />
                  )}
                  <span>{formatDuration((now - Date.parse(person.started_at)) / 1000)}</span>
                </a>
              </li>
            )
          })}
        </ul>
      ) : online.loading && !online.data ? (
        <ul className="mc-online-list" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <li key={index}>
              <Skeleton width={160} height={32} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Nobody is using {project.name} right now.</Empty>
      )}
      {total > people.length && (
        <a className="mc-panel-foot mc-link" href={href({ name: 'users', projectId: project.id })}>
          See all {formatCount(total)} people online
        </a>
      )}
    </section>
  )
}

function ActiveUsersChart({
  data,
  timezone,
  range,
}: {
  data?: Overview
  timezone: string
  range: Range
}) {
  const time = timeIn(timezone)
  if (!data) return <div className="mc-chart" style={{ height: 240 }} aria-hidden="true" />
  const hourly = data.range.bucket === 'hour'
  const points = data.series.map((point) => ({
    time: Date.parse(point.start),
    partial: point.partial,
  }))
  return (
    <>
      <div className="mc-legend" aria-hidden="true">
        <span>
          <i style={{ background: seriesColors[0] }} /> All users
        </span>
        <span>
          <i style={{ background: seriesColors[1] }} /> New users
        </span>
      </div>
      <LineChart
        label={`Active users ${hourly ? 'per hour over the last 24 hours' : `per day ${rangePhrase[range]}`}`}
        height={240}
        area={false}
        series={[
          {
            key: 'users',
            label: 'All users',
            color: seriesColors[0],
            points: points.map((point, index) => ({ ...point, value: data.series[index].users })),
          },
          {
            key: 'new',
            label: 'New users',
            color: seriesColors[1],
            points: points.map((point, index) => ({
              ...point,
              value: data.series[index].new_users,
            })),
          },
        ]}
        formatX={hourly ? time.time : time.date}
        formatTooltip={
          hourly ? (value) => `${time.date(value)}, ${time.time(value)}` : time.weekday
        }
        empty={`No users ${rangePhrase[range]} yet`}
      />
    </>
  )
}

type Ranking = { label: string; rows: BarRow[]; empty: string; note?: string }

function RankedPanel({
  title,
  description,
  rankings,
  id,
}: {
  title: string
  description?: string
  rankings: Ranking[]
  id: string
}) {
  const [tab, setTab] = useState(0)
  const current = rankings[Math.min(tab, rankings.length - 1)]
  return (
    <Panel
      title={title}
      description={description}
      id={id}
      className="mc-span-6"
      actions={
        rankings.length > 1 ? (
          <Segmented
            label={`${title} by`}
            value={String(tab)}
            onChange={(value) => setTab(Number(value))}
            options={rankings.map((ranking, index) => ({
              value: String(index),
              label: ranking.label,
            }))}
          />
        ) : undefined
      }
    >
      {current.rows.length ? <BarList rows={current.rows} /> : <Empty>{current.empty}</Empty>}
      {current.note && <p className="mc-panel-note mc-muted">{current.note}</p>}
    </Panel>
  )
}

const usersRow =
  (total: number, label: (row: Ranked) => string, link?: (row: Ranked) => string | undefined) =>
  (row: Ranked): BarRow => ({
    key: String(row.key),
    label: label(row),
    value: row.users,
    display: `${formatCount(row.users)} · ${formatPercent(row.users, total)}`,
    href: link?.(row),
  })

/** The Users list filtered to a place, over the same days as the counts that led there. */
function placeLink(
  project: Project,
  range: Range,
  country: string,
  region?: string | null,
  city?: string | null,
) {
  const query = new URLSearchParams({ range, country })
  if (region) query.set('region', region)
  if (city) query.set('city', city)
  return `${href({ name: 'users', projectId: project.id })}?${query}`
}

type WhereTab = 'countries' | 'cities' | 'languages'

/**
 * Countries, cities and languages. A country opens in place into its cities or regions,
 * each of which leads to the people there.
 */
function WherePanel({ data, project, range }: { data: Overview; project: Project; range: Range }) {
  const b = data.breakdowns
  const total = data.current.users
  const scope = rangePhrase[range]
  const [tab, setTab] = useState<WhereTab>('countries')
  const [country, setCountry] = useState<string | null>(null)
  const [inside, setInside] = useState<'cities' | 'regions'>('cities')
  const listRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastOpened = useRef<string | null>(null)
  const places = useRpc(
    `places:${project.id}:${range}:${country ?? 'all'}`,
    () => api.places(project.id, range, country),
    { enabled: country !== null || tab === 'cities' },
  )

  // Opening a country moves focus to its name; going back returns it to the country.
  useEffect(() => {
    if (country) headingRef.current?.focus()
    else if (lastOpened.current)
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-key="${lastOpened.current}"] button`)
        ?.focus()
  }, [country])

  const open = (code: string) => {
    lastOpened.current = code
    setInside('cities')
    setCountry(code)
  }
  const placesBody = (rows: (people: number) => BarRow[], empty: string, note?: string) => {
    if (places.error)
      return (
        <ErrorNote
          message={`Couldn't load places. ${places.error}`}
          onRetry={() => void places.refresh()}
        />
      )
    if (!places.data)
      return (
        <div className="mc-where-loading" aria-label="Loading places">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} width={`${85 - index * 12}%`} height={14} />
          ))}
        </div>
      )
    const list = rows(places.data.users)
    return (
      <>
        {list.length ? <BarList rows={list} /> : <Empty>{empty}</Empty>}
        {note && <p className="mc-panel-note mc-muted">{note}</p>}
      </>
    )
  }
  const share = (people: number) => (users: number) =>
    `${formatCount(users)} · ${formatPercent(users, people)}`

  if (country) {
    const name = countryName(country)
    const known = places.data
    return (
      <Panel
        id="mc-where"
        title="Where they are"
        description={
          known ? `Share of the ${plural(known.users, 'user')} in ${name} ${scope}` : `In ${name}`
        }
        className="mc-span-6"
        actions={
          <Segmented
            label={`${name} by`}
            value={inside}
            onChange={setInside}
            options={[
              { value: 'cities', label: 'Cities' },
              { value: 'regions', label: 'Regions' },
            ]}
          />
        }
      >
        <div className="mc-where-head">
          <button type="button" className="mc-back" onClick={() => setCountry(null)}>
            <ArrowLeft size={16} aria-hidden="true" />
            All countries
          </button>
          <div className="mc-where-title">
            <h3 ref={headingRef} tabIndex={-1}>
              {name}
            </h3>
            {known && known.users > 0 && (
              <a href={placeLink(project, range, country)}>See {plural(known.users, 'user')}</a>
            )}
          </div>
        </div>
        {inside === 'cities'
          ? placesBody(
              (people) =>
                (known?.cities ?? []).map((row) => ({
                  key: `${row.region ?? ''}/${row.key}`,
                  label: (
                    <>
                      {row.key}
                      {row.region && row.region !== row.key && (
                        <span className="mc-barlist-sub">{row.region}</span>
                      )}
                    </>
                  ),
                  value: row.users,
                  display: share(people)(row.users),
                  href: placeLink(project, range, country, row.region, row.key),
                })),
              `No cities known in ${name} ${scope}.`,
              known?.unknown_city
                ? `${plural(known.unknown_city, 'user')} in ${name} without a known city.`
                : undefined,
            )
          : placesBody(
              (people) =>
                (known?.regions ?? []).map((row) => ({
                  key: String(row.key),
                  label: String(row.key),
                  value: row.users,
                  display: share(people)(row.users),
                  href: placeLink(project, range, country, String(row.key)),
                })),
              `No regions known in ${name} ${scope}.`,
              known?.unknown_region
                ? `${plural(known.unknown_region, 'user')} in ${name} without a known region.`
                : undefined,
            )}
      </Panel>
    )
  }

  // The same city name in two regions of a country is told apart by its region.
  const cities = places.data?.cities ?? []
  const twins = new Set(
    cities
      .filter((row, index) =>
        cities.some(
          (other, at) => at !== index && other.key === row.key && other.country === row.country,
        ),
      )
      .map((row) => `${row.country}/${row.key}`),
  )
  return (
    <Panel
      id="mc-where"
      title="Where they are"
      description={`Share of the ${plural(total, 'user')} ${scope}`}
      className="mc-span-6"
      actions={
        <Segmented
          label="Where they are by"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'countries', label: 'Countries' },
            { value: 'cities', label: 'Cities' },
            { value: 'languages', label: 'Languages' },
          ]}
        />
      }
    >
      <div ref={listRef}>
        {tab === 'countries' &&
          (b.countries.length ? (
            <BarList
              rows={b.countries.map((row) => ({
                ...usersRow(total, (item) => countryName(String(item.key)))(row),
                onSelect: () => open(String(row.key)),
              }))}
            />
          ) : (
            <Empty>No locations {scope}.</Empty>
          ))}
        {tab === 'countries' && b.countries.length > 0 && (
          <p className="mc-panel-note mc-muted">
            Choose a country to see its cities and regions.
            {b.unknown_country
              ? ` ${plural(b.unknown_country, 'user')} without a known country.`
              : ''}
          </p>
        )}
        {tab === 'cities' &&
          placesBody(
            () =>
              cities.map((row) => ({
                key: `${row.country}/${row.region ?? ''}/${row.key}`,
                label: [
                  row.key,
                  twins.has(`${row.country}/${row.key}`) ? row.region : null,
                  countryName(row.country),
                ]
                  .filter(Boolean)
                  .join(', '),
                value: row.users,
                display: share(total)(row.users),
                href: placeLink(project, range, row.country, row.region, row.key),
              })),
            `No cities known ${scope}.`,
            places.data?.unknown_city
              ? `${plural(places.data.unknown_city, 'user')} without a known city.`
              : undefined,
          )}
        {tab === 'languages' &&
          (b.languages.length ? (
            <BarList
              rows={b.languages.map(usersRow(total, (row) => languageName(String(row.key))))}
            />
          ) : (
            <Empty>No languages {scope}.</Empty>
          ))}
      </div>
    </Panel>
  )
}

function Breakdowns({ data, project, range }: { data?: Overview; project: Project; range: Range }) {
  if (!data) {
    return (
      <div className="mc-grid">
        {[0, 1, 2, 3].map((index) => (
          <section key={index} className="mc-panel mc-span-6" aria-hidden="true">
            <Skeleton width="40%" height={18} />
            <Skeleton width="90%" height={14} />
            <Skeleton width="75%" height={14} />
            <Skeleton width="60%" height={14} />
          </section>
        ))}
      </div>
    )
  }
  const b = data.breakdowns
  const total = data.current.users
  const scope = rangePhrase[range]
  return (
    <div className="mc-grid">
      <WherePanel data={data} project={project} range={range} />
      <RankedPanel
        id="mc-devices"
        title="What they use"
        description={`Share of the ${plural(total, 'user')} ${scope}`}
        rankings={[
          {
            label: 'Platforms',
            rows: b.platforms.map(
              usersRow(
                total,
                (row) =>
                  ({ ios: 'iOS app', android: 'Android app', web: 'Website', server: 'Server' })[
                    String(row.key)
                  ] ?? String(row.key),
              ),
            ),
            empty: `No users ${scope}.`,
          },
          {
            label: 'Devices',
            rows: (b.devices.length ? b.devices : b.device_types).map(
              usersRow(total, (row) =>
                b.devices.length
                  ? String(row.key)
                  : (deviceTypeLabels[String(row.key)] ?? String(row.key)),
              ),
            ),
            empty: `No devices ${scope}.`,
            note: b.devices.length
              ? `By type: ${b.device_types.map((row) => `${deviceTypeLabels[String(row.key)] ?? row.key} ${formatPercent(row.users, total)}`).join(', ')}`
              : undefined,
          },
          {
            label: 'OS',
            rows: b.os.map(usersRow(total, (row) => String(row.key))),
            empty: `No operating systems ${scope}.`,
          },
          {
            label: 'Versions',
            rows: [
              ...b.app_versions.map(
                usersRow(
                  total,
                  (row) => `${row.platform === 'ios' ? 'iOS' : 'Android'} app ${row.key}`,
                ),
              ),
              ...b.browsers.map(usersRow(total, (row) => String(row.key))),
            ],
            empty: `No app versions or browsers ${scope}.`,
          },
        ]}
      />
      <RankedPanel
        id="mc-actions"
        title="What they do"
        description="Share of users who did each action at least once"
        rankings={[
          {
            label: 'Actions',
            rows: b.actions.map((row) => ({
              key: String(row.key),
              label: <span className="mc-mono">{row.key}</span>,
              value: row.users,
              display: `${formatPercent(row.users, total)} · ${formatCount(row.events)}×`,
              href: href({ name: 'event', projectId: project.id, eventName: String(row.key) }),
            })),
            empty: 'Actions appear here once your app tracks events beyond page and screen views.',
          },
          {
            label: 'Screens',
            rows: b.screens.map((row) => ({
              key: String(row.key),
              label: <span className="mc-mono">{row.key}</span>,
              value: row.users,
              display: `${formatPercent(row.users, total)} · ${formatCount(row.views)} views`,
            })),
            empty: `No page or screen views ${scope}.`,
          },
          {
            label: 'Entry',
            rows: b.entry_screens.map((row) => ({
              key: row.key,
              label: <span className="mc-mono">{row.key}</span>,
              value: row.sessions,
              display: plural(row.sessions, 'session'),
            })),
            empty: `No entry screens ${scope}.`,
          },
        ]}
      />
      <RankedPanel
        id="mc-sources"
        title="Where they came from"
        description="Websites only: the referrer or UTM source of each visit"
        rankings={[
          {
            label: 'Sources',
            rows: b.referrers.map(usersRow(total, (row) => String(row.key))),
            empty: `No website visits ${scope}.`,
          },
          {
            label: 'Errors',
            rows: b.errors.map((row) => ({
              key: String(row.key),
              label: <span className="mc-mono">{row.key}</span>,
              value: row.users,
              display: `${plural(row.users, 'user')} · ${formatCount(row.events)}×`,
              href: href({ name: 'event', projectId: project.id, eventName: 'error_thrown' }),
            })),
            empty: `No errors ${scope}.`,
          },
        ]}
      />
    </div>
  )
}

export function OverviewScreen({ project }: { project: Project }) {
  const { now } = useStore()
  const [range, setRange] = useState<Range>('7d')
  const overview = useRpc(
    `overview:${project.id}:${range}`,
    () => api.overview(project.id, range),
    { pollMs: 60_000 },
  )
  const data = overview.data
  const retention = useRpc(`retention-summary:${project.id}`, () =>
    api.retentionSummary(project.id),
  )
  const time = timeIn(project.timezone)

  if (data && !data.has_data) {
    return (
      <div className="mc-page">
        <PageHeader
          title="Overview"
          description={`${project.name} has not sent anything yet. Install the SDK and your first users appear here within seconds.`}
        />
        <InstallGuide project={project} compact />
      </div>
    )
  }

  const bots = data?.bots
  return (
    <div className="mc-page">
      <PageHeader
        title="Overview"
        description={`Who used ${project.name} ${rangePhrase[range]}. Days run on ${project.timezone} time.`}
        actions={
          <>
            <Segmented
              label="Date range"
              value={range}
              onChange={setRange}
              options={rangeOptions}
            />
            <Freshness
              updatedAt={overview.updatedAt}
              loading={overview.loading}
              onRefresh={() => void overview.refresh()}
              now={now}
            />
          </>
        }
      />
      {overview.error && (
        <ErrorNote
          message={`Couldn't load the overview. ${overview.error}`}
          updatedAt={overview.updatedAt}
          timezoneClock={time.time}
          onRetry={() => void overview.refresh()}
        />
      )}

      <div className="mc-overview-top">
        <OnlineNow project={project} count={data?.online_now} />
        <section className="mc-panel mc-overview-main" aria-labelledby="mc-active-title">
          <div className="mc-panel-head">
            <div>
              <h2 id="mc-active-title">Active users</h2>
              <p>
                {data?.range.bucket === 'hour'
                  ? 'Per hour, last 24 hours'
                  : `Per day, ${rangePhrase[range]}`}
              </p>
            </div>
          </div>
          <KpiStrip
            data={data}
            range={range}
            retention={retention.data}
            retentionFailed={Boolean(retention.error)}
            retentionLink={href({ name: 'retention', projectId: project.id })}
          />
          <ActiveUsersChart data={data} timezone={project.timezone} range={range} />
        </section>
      </div>

      <Breakdowns data={data} project={project} range={range} />

      {bots && bots.sessions > 0 && (
        <a className="mc-bots-note" href={href({ name: 'bots', projectId: project.id })}>
          <Bot size={16} aria-hidden="true" />
          <span>
            {bots.excluded_sessions
              ? `${plural(bots.excluded_sessions, 'bot session')} (${formatPercent(bots.excluded_sessions, bots.sessions)} of traffic) left out of these numbers.`
              : `No bot traffic found ${rangePhrase[range]}.`}
          </span>
          <span className="mc-link">Review bots</span>
        </a>
      )}
      {data?.last_event_at && (
        <p className="mc-muted mc-page-foot">
          Last event received{' '}
          {formatAgo(data.last_event_at, Math.max(now, Date.parse(data.last_event_at)))}.
        </p>
      )}
    </div>
  )
}
