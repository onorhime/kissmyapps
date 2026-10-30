import { useState } from 'react'
import { Download } from 'lucide-react'
import { HISTORY_DAYS, eventComparable, exploreSeries, rangeLabels } from '../data/model'
import type { Breakdown, Measure, Range } from '../data/model'
import type { Project } from '../data/sample'
import { formatChange, formatCount, formatDate, formatDecimal } from '../format'
import { href } from '../routes'
import { useDataset } from '../store'
import { downloadCsv } from '../csv'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import { PageHeader, Segmented, Select } from '../ui/Primitives'

type ExploreRange = Exclude<Range, 'today'>

const measures: Array<{ value: Measure; label: string }> = [
  { value: 'uniques', label: 'People' },
  { value: 'totals', label: 'Events' },
  { value: 'perUser', label: 'Per person' },
]
const breakdowns: Array<{ value: Breakdown; label: string }> = [
  { value: 'none', label: 'Nothing' },
  { value: 'platform', label: 'Platform' },
  { value: 'country', label: 'Country' },
  { value: 'version', label: 'App version' },
]

export function ExploreScreen({
  project,
  initialEvent,
}: {
  project: Project
  initialEvent?: string
}) {
  const dataset = useDataset(project)
  const liveEvents = dataset?.events.filter((event) => event.status === 'live') ?? []
  const fallback =
    liveEvents.find((event) => event.name === 'paywall_viewed')?.name ?? liveEvents[0]?.name ?? ''
  const [eventName, setEventName] = useState(
    initialEvent && liveEvents.some((event) => event.name === initialEvent)
      ? initialEvent
      : fallback,
  )
  const [measure, setMeasure] = useState<Measure>('uniques')
  const [breakdown, setBreakdown] = useState<Breakdown>('platform')
  const [range, setRange] = useState<ExploreRange>('30d')

  if (!dataset || !eventName) {
    return (
      <div className="mc-page">
        <PageHeader
          title="Explore"
          description="Charts need a few days of events. Install the SDK to start collecting them."
        />
        <section className="mc-panel">
          <div className="mc-empty">
            <p>
              Once {project.name} sends events, you can count people and events here and break them
              down by platform, country or app version.
            </p>
            <a
              className="mc-btn mc-btn-primary"
              href={href({ name: 'install', projectId: project.id })}
            >
              Install the SDK
            </a>
          </div>
        </section>
      </div>
    )
  }

  const lines = exploreSeries(dataset, eventName, range, measure, breakdown).slice(0, 4)
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  // An event younger than both windows has no fair comparison.
  const definition = dataset.events.find((event) => event.name === eventName)
  const comparable = definition ? eventComparable(definition, range) : false
  const previous = comparable
    ? exploreSeries(dataset, eventName, range, measure, breakdown, days)
    : []
  const formatValue = measure === 'perUser' ? formatDecimal : formatCount
  const grand = lines.reduce((sum, line) => sum + line.total, 0)
  const measureLabel = measures.find((item) => item.value === measure)?.label ?? ''
  const leader = [...lines].sort((a, b) => b.total - a.total)[0]
  const description =
    measure === 'perUser'
      ? `${eventName}: on a typical day each person sends it ${formatDecimal(leader?.total ?? 0)} times${breakdown === 'none' ? '' : ` on ${leader?.label}`}.`
      : `${formatCount(grand)} ${measure === 'uniques' ? 'person-days' : 'events'} of ${eventName} in the last ${rangeLabels[range].toLowerCase()}${
          breakdown === 'none' || !leader
            ? '.'
            : `, ${Math.round((leader.total / Math.max(1, grand)) * 100)}% from ${leader.label}.`
        }`
  const release =
    project.release &&
    dataset.events.find((event) => event.name === eventName)?.releaseLift &&
    project.release.daysAgo < days
      ? [
          {
            time: dataset.dayStarts[HISTORY_DAYS - 1 - project.release.daysAgo],
            label: project.release.label,
          },
        ]
      : []

  return (
    <div className="mc-page">
      <PageHeader
        title="Explore"
        description={description}
        actions={
          <button
            type="button"
            className="mc-btn mc-btn-quiet"
            onClick={() =>
              downloadCsv(`${project.id}-${eventName}-${range}.csv`, [
                ['date', ...lines.map((line) => line.label)],
                ...(lines[0]?.points ?? []).map((point, index) => [
                  new Date(point.time).toISOString().slice(0, 10),
                  ...lines.map((line) => line.points[index].value),
                ]),
              ])
            }
          >
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        }
      />

      <div className="mc-toolbar mc-explore-controls">
        <Select
          label="Event"
          mono
          value={eventName}
          onChange={setEventName}
          options={liveEvents.map((event) => ({ value: event.name, label: event.name }))}
        />
        <div className="mc-control">
          <span className="mc-control-label" id="mc-measure-label">
            Count
          </span>
          <Segmented label="Count" value={measure} onChange={setMeasure} options={measures} />
        </div>
        <Select
          label="Break down by"
          value={breakdown}
          onChange={setBreakdown}
          options={breakdowns}
        />
        <div className="mc-control">
          <span className="mc-control-label">Period</span>
          <Segmented
            label="Period"
            value={range}
            onChange={setRange}
            options={(['7d', '30d', '90d'] as const).map((value) => ({
              value,
              label: rangeLabels[value],
            }))}
          />
        </div>
      </div>

      <section className="mc-panel" aria-labelledby="mc-explore-chart">
        <div className="mc-panel-head is-row">
          <h2 id="mc-explore-chart">
            {measureLabel} per day
            {breakdown === 'none'
              ? ''
              : `, by ${breakdowns.find((item) => item.value === breakdown)?.label.toLowerCase()}`}
          </h2>
          {lines.length > 1 && (
            <ul className="mc-legend">
              {lines.map((line, index) => (
                <li key={line.key}>
                  <i style={{ background: seriesColors[index] }} aria-hidden="true" />
                  {line.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        <LineChart
          label={`${measureLabel} of ${eventName} per day`}
          series={lines.map((line, index) => ({
            key: line.key,
            label: line.label,
            color: seriesColors[index],
            points: line.points,
          }))}
          formatX={formatDate}
          formatValue={formatValue}
          integers={measure !== 'perUser'}
          height={280}
          annotations={release}
        />
      </section>

      <section className="mc-panel mc-panel-flush" aria-labelledby="mc-explore-table">
        <h2 id="mc-explore-table" className="sr-only">
          Breakdown table
        </h2>
        <table className="mc-table mc-explore-table">
          <thead>
            <tr>
              <th scope="col">
                {breakdown === 'none'
                  ? 'Event'
                  : breakdowns.find((item) => item.value === breakdown)?.label}
              </th>
              <th scope="col" className="is-num">
                {measure === 'perUser'
                  ? 'Average per day'
                  : `${measureLabel}, ${rangeLabels[range].toLowerCase()}`}
              </th>
              {measure !== 'perUser' && (
                <th scope="col" className="is-num">
                  Share
                </th>
              )}
              <th scope="col" className="is-num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const before = previous.find((item) => item.key === line.key)?.total ?? 0
              const change = before > 0 ? formatChange(line.total, before) : null
              return (
                <tr key={line.key}>
                  <td>
                    <span className="mc-legend-cell">
                      <i style={{ background: seriesColors[index] }} aria-hidden="true" />
                      <span className={breakdown === 'none' ? 'mc-mono' : undefined}>
                        {line.label}
                      </span>
                    </span>
                  </td>
                  <td className="is-num mc-num">{formatValue(line.total)}</td>
                  {measure !== 'perUser' && (
                    <td className="is-num mc-num mc-muted">
                      {Math.round((line.total / Math.max(1, grand)) * 100)}%
                    </td>
                  )}
                  <td className="is-num mc-num">
                    {change ? (
                      <span className={`is-${change.tone}`}>{change.text}</span>
                    ) : (
                      <span className="mc-muted">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="mc-panel-foot mc-muted is-padded">
          Change compares with the {rangeLabels[range].toLowerCase()} before. People are counted
          once per day, so the total is person-days.
        </p>
      </section>
    </div>
  )
}
