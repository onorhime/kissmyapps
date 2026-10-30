import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'
import type {
  FunnelBreakdown,
  Project,
  RetentionDefinition,
  RetentionInterval,
  RetentionPerson,
  RetentionReport,
} from '../api'
import { formatAgo, formatCount, formatPercent, placeLabel, plural, timeIn } from '../format'
import { groupLabel, groupNouns, groupOptions } from '../groups'
import { href } from '../routes'
import { useStore } from '../store'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import {
  Empty,
  ErrorNote,
  PageHeader,
  Panel,
  PersonCell,
  Segmented,
  Select,
  ShowMore,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

const intervalOptions: Array<{ value: RetentionInterval; label: string }> = [
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

const periodNouns: Record<RetentionInterval, string> = { day: 'Day', week: 'Week', month: 'Month' }

const rowOptions: Array<{ value: FunnelBreakdown; label: string }> = [
  { value: 'none', label: 'By start date' },
  ...groupOptions,
]

type Show = 'share' | 'people'

const showOptions: Array<{ value: Show; label: string }> = [
  { value: 'share', label: 'Share' },
  { value: 'people', label: 'People' },
]

// Cohorts are calendar dates in the project's time zone, sent as plain dates, so they are
// read and written in UTC to stay on the same day.
const utc = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })

const cohortFormats: Record<RetentionInterval, Intl.DateTimeFormat> = {
  day: utc({ weekday: 'short', month: 'short', day: 'numeric' }),
  week: utc({ month: 'short', day: 'numeric' }),
  month: utc({ month: 'long', year: 'numeric' }),
}

const shortDate = utc({ month: 'short', day: 'numeric' })

function cohortName(interval: RetentionInterval, start: string): string {
  const text = cohortFormats[interval].format(Date.parse(start))
  return interval === 'week' ? `Week of ${text}` : text
}

function cohortPhrase(interval: RetentionInterval, start: string): string {
  const text = cohortFormats[interval].format(Date.parse(start))
  return interval === 'day'
    ? `on ${text}`
    : interval === 'week'
      ? `in the week of ${text}`
      : `in ${text}`
}

/** "on day 3", "in week 2", "in month 1". */
function periodPhrase(interval: RetentionInterval, period: number): string {
  return `${interval === 'day' ? 'on' : 'in'} ${periodNouns[interval].toLowerCase()} ${period}`
}

type Choice = { interval: RetentionInterval; start: string; back: string }

function definitionOf(choice: Choice): RetentionDefinition {
  return {
    interval: choice.interval,
    start: choice.start ? { kind: 'event', event: choice.start } : { kind: 'first_seen' },
    return: choice.back ? { kind: 'event', event: choice.back } : { kind: 'any' },
  }
}

/**
 * One hue, deeper as more came back. The square root keeps small shares apart, and the cap
 * keeps white text above 4.5:1 on the darkest cell.
 */
function shade(share: number): string {
  return `rgba(39, 159, 215, ${(0.1 + 0.6 * Math.sqrt(share)).toFixed(3)})`
}

type Cell = {
  period: number
  /** Who came back in this period; null before it starts. */
  people: number | null
  /** Who could have: the row's people, or for averaged rows those who have had this long. */
  base: number
  partial: boolean
}

type Row = {
  key: string
  label: string
  cohort: string | null
  group: string | null
  people: number
  cells: Cell[]
  everyone?: boolean
}

type Drill = { cohort: string | null; group: string | null; period: number }

function tableRows(report: RetentionReport, breakdown: FunnelBreakdown): Row[] {
  const everyone: Row = {
    key: 'everyone',
    label: 'Everyone',
    cohort: null,
    group: null,
    people: report.started,
    everyone: true,
    cells: report.curve.map((point) => ({
      period: point.period,
      people: point.people ? point.returned : null,
      base: point.people,
      partial: false,
    })),
  }
  if (breakdown !== 'none') {
    return [
      everyone,
      ...report.breakdown.map((group) => ({
        key: group.key,
        label: groupLabel(breakdown, group.key),
        cohort: null,
        group: group.key,
        people: group.people,
        cells: group.values.map((value) => ({
          period: value.period,
          people: value.people ? value.returned : null,
          base: value.people,
          partial: false,
        })),
      })),
    ]
  }
  // Newest first, leaving off the oldest periods from before anyone started.
  const firstUsed = report.cohorts.findIndex((cohort) => cohort.people > 0)
  return [
    everyone,
    ...report.cohorts
      .slice(Math.max(0, firstUsed))
      .reverse()
      .map((cohort) => ({
        key: cohort.start,
        label: cohortName(report.definition.interval, cohort.start),
        cohort: cohort.start,
        group: null,
        people: cohort.people,
        cells: cohort.values.map((value) => ({
          period: value.period,
          people: value.state === 'future' ? null : value.people,
          base: cohort.people,
          partial: value.state === 'partial',
        })),
      })),
  ]
}

function Headline({ report }: { report: RetentionReport | undefined }) {
  return (
    <div className="mc-kpis mc-kpis-3" role="group" aria-label="Back after 1, 7 and 30 days">
      {[1, 7, 30].map((day) => {
        const item = report?.headline.find((entry) => entry.day === day)
        return (
          <div key={day} className="mc-kpi">
            <span className="mc-kpi-label">Back on day {day}</span>
            {report ? (
              item?.people ? (
                <>
                  <strong className="mc-kpi-value mc-num">
                    {formatPercent(item.returned, item.people)}
                  </strong>
                  <span className="mc-sub">
                    {formatCount(item.returned)} of {plural(item.people, 'person', 'people')}
                  </span>
                </>
              ) : (
                <>
                  <strong className="mc-kpi-value mc-num mc-muted" aria-label="No figure yet">
                    —
                  </strong>
                  <span className="mc-sub">Nobody has reached day {day} yet</span>
                </>
              )
            ) : (
              <>
                <Skeleton width={72} height={28} />
                <Skeleton width={120} height={14} />
              </>
            )}
          </div>
        )
      })}
      {report && (
        <p className="mc-kpis-note mc-muted">
          Each counts the people who reached that day in the last 30 days. Day 7 means active again
          on the seventh day after the day they started, in {report.timezone} days.
        </p>
      )}
    </div>
  )
}

function Curve({ report }: { report: RetentionReport }) {
  const interval = report.definition.interval
  const noun = periodNouns[interval]
  const finished = report.curve.filter((point) => point.people > 0)
  if (!finished.length) {
    return (
      <Empty>
        {report.started
          ? `Nobody has had a whole ${noun.toLowerCase()} since they started yet. The curve begins once ${noun.toLowerCase()} 1 is over.`
          : 'Nobody started in this window yet.'}
      </Empty>
    )
  }
  const byPeriod = new Map(finished.map((point) => [point.period, point]))
  return (
    <LineChart
      label={`Share of people back in each ${noun.toLowerCase()} after they started`}
      height={220}
      series={[
        {
          key: 'back',
          label: 'Came back',
          color: seriesColors[0],
          points: finished.map((point) => ({
            time: point.period,
            value: (point.returned / point.people) * 100,
          })),
        },
      ]}
      formatX={(period) => `${noun} ${period}`}
      formatTooltip={(period) => {
        const point = byPeriod.get(period)
        return point
          ? `${noun} ${period}: ${formatCount(point.returned)} of ${formatCount(point.people)}`
          : `${noun} ${period}`
      }}
      formatValue={(value) => `${Math.round(value)}%`}
      formatTick={(value) => `${value}%`}
      ceiling={100}
      empty="Nobody has come back yet."
    />
  )
}

function CohortTable({
  report,
  breakdown,
  show,
  drill,
  onDrill,
}: {
  report: RetentionReport
  breakdown: FunnelBreakdown
  show: Show
  drill: Drill | null
  onDrill: (drill: Drill) => void
}) {
  const interval = report.definition.interval
  const noun = periodNouns[interval]
  const rows = tableRows(report, breakdown)
  const periods = Array.from({ length: report.periods }, (_, at) => at + 1)
  const pressed = (row: Row, period: number) =>
    drill?.cohort === row.cohort && drill?.group === row.group && drill?.period === period
  return (
    <div className="mc-cohorts-frame" tabIndex={0} role="region" aria-label="Who came back">
      <table className="mc-cohorts">
        <thead>
          <tr>
            <th scope="col">{breakdown === 'none' ? 'Started' : groupNouns[breakdown]}</th>
            <th scope="col" className="mc-cohort-size">
              People
            </th>
            {periods.map((period) => (
              <th key={period} scope="col">
                {noun} {period}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.everyone ? 'is-everyone' : undefined}>
              <th scope="row">{row.label}</th>
              <td className="mc-cohort-size mc-num">
                {row.people ? (
                  <button
                    type="button"
                    className="mc-row-button"
                    aria-pressed={pressed(row, 0)}
                    aria-label={`${plural(row.people, 'person', 'people')}${row.cohort ? ` started ${cohortPhrase(interval, row.cohort)}` : row.everyone ? ' in this table' : `, ${row.label}`}`}
                    onClick={() => onDrill({ cohort: row.cohort, group: row.group, period: 0 })}
                  >
                    {formatCount(row.people)}
                  </button>
                ) : (
                  <span className="mc-muted">0</span>
                )}
              </td>
              {row.cells.map((cell) => {
                if (cell.people === null) return <td key={cell.period} />
                if (!cell.base)
                  return (
                    <td key={cell.period}>
                      <span className="mc-cohort-cell is-none" aria-label="Nobody to count">
                        —
                      </span>
                    </td>
                  )
                const share = cell.people / cell.base
                const text =
                  show === 'share'
                    ? formatPercent(cell.people, cell.base)
                    : formatCount(cell.people)
                const detail = `${formatCount(cell.people)} of ${plural(cell.base, 'person', 'people')} back ${periodPhrase(interval, cell.period)}${cell.partial ? ' so far' : ''}`
                if (!cell.people)
                  return (
                    <td key={cell.period}>
                      <span
                        className={
                          cell.partial
                            ? 'mc-cohort-cell is-zero is-partial'
                            : 'mc-cohort-cell is-zero'
                        }
                        aria-label={`${text}: ${detail}`}
                      >
                        {text}
                      </span>
                    </td>
                  )
                return (
                  <td key={cell.period}>
                    <button
                      type="button"
                      className={cell.partial ? 'mc-cohort-cell is-partial' : 'mc-cohort-cell'}
                      style={{ background: shade(share) }}
                      aria-pressed={pressed(row, cell.period)}
                      aria-label={`${text}: ${detail}`}
                      title={detail}
                      onClick={() =>
                        onDrill({ cohort: row.cohort, group: row.group, period: cell.period })
                      }
                    >
                      {text}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RetentionPeople({
  project,
  definition,
  breakdown,
  drill,
  report,
  onClose,
}: {
  project: Project
  definition: RetentionDefinition
  breakdown: FunnelBreakdown
  drill: Drill
  report: RetentionReport
  onClose: () => void
}) {
  const { now } = useStore()
  const time = timeIn(project.timezone)
  const ref = useRef<HTMLDivElement>(null)
  const interval = definition.interval
  const group =
    drill.group !== null && breakdown !== 'none' ? { breakdown, key: drill.group } : null
  const cell = { cohort: drill.cohort, period: drill.period, group }
  const key = JSON.stringify([project.id, definition, cell])
  const first = useRpc(`retention-people:${key}`, () =>
    api.retentionPeople(project.id, definition, cell),
  )
  const [more, setMore] = useState<{ key: string; rows: RetentionPerson[] }>({
    key: '',
    rows: [],
  })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const extra = more.key === key ? more.rows : []
  const rows = [...(first.data?.people ?? []), ...extra]
  const total = first.data?.total ?? 0

  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [key])

  const loadMore = async () => {
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.retentionPeople(project.id, definition, cell, rows.length)
      setMore({ key, rows: [...extra, ...page.people] })
    } catch (problem) {
      setMoreError(problem instanceof Error ? problem.message : 'Could not load more people.')
    } finally {
      setLoadingMore(false)
    }
  }

  const firstCohort = report.cohorts[0]?.start
  const started = drill.cohort
    ? `who started ${cohortPhrase(interval, drill.cohort)}`
    : firstCohort
      ? `who started since ${shortDate.format(Date.parse(firstCohort))}`
      : 'who started'
  const who = `${started}${drill.period ? ` and came back ${periodPhrase(interval, drill.period)}` : ''}${drill.group && breakdown !== 'none' ? `, ${groupLabel(breakdown, drill.group)}` : ''}`
  const partial =
    drill.cohort !== null &&
    drill.period > 0 &&
    report.cohorts.find((cohort) => cohort.start === drill.cohort)?.values[drill.period - 1]
      ?.state === 'partial'
  return (
    <div ref={ref} className="mc-retention-people">
      <Panel
        title={first.data ? `${plural(total, 'person', 'people')} ${who}` : `People ${who}`}
        description={
          partial
            ? `${periodNouns[interval]} ${drill.period} is still going, so more may come back. Newest first.`
            : `Newest first, with how many days each came back on.`
        }
        id="mc-retention-people"
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
        <table className="mc-table mc-retention-people-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Started</th>
              <th scope="col">Came back</th>
              <th scope="col">Where</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {!first.data &&
              !first.error &&
              [0, 1, 2].map((row) => (
                <tr key={row} aria-hidden="true">
                  {[150, 90, 70, 90, 70].map((width, at) => (
                    <td key={at}>
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
                <td data-label="Started" className="mc-num">
                  {time.dateTime(person.started_at)}
                </td>
                <td data-label="Came back" className="mc-num">
                  {person.days_back ? (
                    plural(person.days_back, 'day')
                  ) : (
                    <span className="mc-muted">Not yet</span>
                  )}
                </td>
                <td data-label="Where">
                  <span className="mc-truncate">{placeLabel(person)}</span>
                </td>
                <td data-label="Last seen" className="mc-num">
                  {formatAgo(person.last_seen, Math.max(now, Date.parse(person.last_seen)))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {first.data && !rows.length && <Empty>Nobody here.</Empty>}
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

function TableSkeleton() {
  return (
    <div className="mc-table-loading" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} width="100%" height={28} />
      ))}
    </div>
  )
}

export function RetentionScreen({ project }: { project: Project }) {
  const time = timeIn(project.timezone)
  const [choice, setChoice] = useState<Choice>({ interval: 'day', start: '', back: '' })
  const [breakdown, setBreakdown] = useState<FunnelBreakdown>('none')
  const [show, setShow] = useState<Show>('share')
  const options = useRpc(`funnel-options:${project.id}`, () => api.funnelOptions(project.id))
  const definition = useMemo(() => definitionOf(choice), [choice])
  const reportKey = `retention:${project.id}:${JSON.stringify(definition)}:${breakdown}`
  const report = useRpc(reportKey, () => api.retention(project.id, definition, breakdown))
  // While a new report loads, the last one stays on screen, dimmed, with the rows it was made for.
  const [kept, setKept] = useState<{ report: RetentionReport; breakdown: FunnelBreakdown }>()
  if (report.data && report.data !== kept?.report) setKept({ report: report.data, breakdown })
  const shown = report.data ?? kept?.report
  const shownBreakdown = report.data ? breakdown : (kept?.breakdown ?? breakdown)
  const stale = !report.data && Boolean(kept)
  // A chosen cell belongs to the report it was chosen in.
  const [drill, setDrill] = useState<{ key: string; cell: Drill } | null>(null)
  const activeDrill = drill?.key === reportKey ? drill.cell : null

  const events = options.data?.events.map((event) => event.name) ?? []
  const eventChoices = (current: string) =>
    [...new Set([...events, ...(current ? [current] : [])])].map((name) => ({
      value: name,
      label: name,
    }))
  const noun = periodNouns[shown?.definition.interval ?? choice.interval].toLowerCase()

  return (
    <div className="mc-page">
      <PageHeader
        title="Retention"
        description={`Of the people who start, how many come back, and when. Days run on ${project.timezone} time.`}
        actions={
          <Segmented
            label="Count by"
            value={choice.interval}
            onChange={(interval) => setChoice((current) => ({ ...current, interval }))}
            options={intervalOptions}
          />
        }
      />
      <div className="mc-toolbar">
        <Select
          label="When people start"
          hideLabel
          value={choice.start}
          onChange={(start) => setChoice((current) => ({ ...current, start }))}
          options={[
            { value: '', label: 'Start: first seen' },
            ...eventChoices(choice.start).map((option) => ({
              ...option,
              label: `Start: first ${option.label}`,
            })),
          ]}
        />
        <Select
          label="What counts as coming back"
          hideLabel
          value={choice.back}
          onChange={(back) => setChoice((current) => ({ ...current, back }))}
          options={[
            { value: '', label: 'Back: any activity' },
            ...eventChoices(choice.back).map((option) => ({
              ...option,
              label: `Back: ${option.label}`,
            })),
          ]}
        />
        {options.error && (
          <span className="mc-toolbar-count mc-muted">Couldn't load your event names.</span>
        )}
      </div>

      {report.error && (
        <ErrorNote
          message={`Couldn't work out retention. ${report.error}`}
          updatedAt={report.updatedAt}
          timezoneClock={time.time}
          onRetry={() => void report.refresh()}
        />
      )}

      <div className={stale ? 'mc-retention-body is-stale' : 'mc-retention-body'}>
        <Headline report={shown} />

        <Panel
          title="Retention curve"
          description={`The share back in each ${noun} after the ${noun} they started, across everyone who has had that long.`}
          id="mc-retention-curve"
        >
          {shown ? (
            <Curve report={shown} />
          ) : (
            <div className="mc-chart" style={{ height: 220 }} aria-hidden="true" />
          )}
        </Panel>

        <Panel
          title={
            shownBreakdown === 'none'
              ? 'Who came back, by when they started'
              : `Who came back, by ${groupNouns[shownBreakdown].toLowerCase()}`
          }
          description={
            shownBreakdown === 'none'
              ? `Each row is everyone who started in that ${noun}. Choose a number to see who they are.`
              : `Grouped by where each person was first seen, over ${noun}s they have finished. Choose a number to see who they are.`
          }
          id="mc-retention-table"
          flush
          actions={
            <div className="mc-panel-tools">
              <Select
                label="Rows"
                hideLabel
                value={breakdown}
                onChange={setBreakdown}
                options={rowOptions}
              />
              <Segmented label="Show" value={show} onChange={setShow} options={showOptions} />
            </div>
          }
        >
          {shown ? (
            shown.started ? (
              <>
                <CohortTable
                  report={shown}
                  breakdown={shownBreakdown}
                  show={show}
                  drill={activeDrill}
                  onDrill={(cell) => setDrill({ key: reportKey, cell })}
                />
                <div className="mc-cohort-foot">
                  <span className="mc-cohort-scale" aria-hidden="true">
                    <span>0%</span>
                    <i
                      style={{
                        background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((share) => `${shade(share)} ${share * 100}%`).join(', ')})`,
                      }}
                    />
                    <span>100%</span>
                  </span>
                  <span className="mc-muted">
                    {shownBreakdown === 'none'
                      ? `Deeper blue means more of the row came back. A dashed cell is the ${noun} in progress.`
                      : 'Deeper blue means more of the row came back.'}
                    {shownBreakdown !== 'none' && shown.other_groups > 0
                      ? ` ${plural(shown.other_groups, 'smaller group')} not shown.`
                      : ''}
                  </span>
                </div>
              </>
            ) : (
              <Empty>
                {choice.start
                  ? `Nobody did ${choice.start} in this window yet.`
                  : 'Nobody was first seen in this window yet.'}{' '}
                Rows fill in as people arrive.
              </Empty>
            )
          ) : (
            <TableSkeleton />
          )}
        </Panel>
      </div>

      {activeDrill && report.data && (
        <RetentionPeople
          key={JSON.stringify(activeDrill)}
          project={project}
          definition={definition}
          breakdown={breakdown}
          drill={activeDrill}
          report={report.data}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  )
}
