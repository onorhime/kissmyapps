import { Hourglass, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import type { Cohort, CohortCell, CohortInterval, CohortsReport, Project, RoiFilters } from '../api'
import { formatCount, plural } from '../format'
import {
  cohortLabel,
  formatMoney,
  formatMoneyTick,
  formatMoneyTile,
  formatRatio,
  heatShade,
  roiKeyLabel,
  unconvertedNote,
} from '../roi'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import { Empty, ErrorNote, Panel, Segmented, Select, Skeleton } from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

type Metric = 'revenue' | 'roas' | 'retention'

const intervalOptions: Array<{ value: CohortInterval; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]

const metricOptions: Array<{ value: Metric; label: string }> = [
  { value: 'revenue', label: 'Revenue per person' },
  { value: 'roas', label: 'ROAS' },
  { value: 'retention', label: 'Retention' },
]

const frames: Record<CohortInterval, { span: string; noun: string }> = {
  day: { span: 'the last 30 days', noun: 'day' },
  week: { span: 'the last 12 weeks', noun: 'week' },
  month: { span: 'the last 6 months', noun: 'month' },
}

/** A filter choice as a select value: all, the "none" key, or a key. */
type Choice = 'all' | 'none' | `=${string}`
const choiceOf = (key: string | null): Choice => (key === null ? 'none' : `=${key}`)
const keyOf = (choice: Choice): string | null => (choice === 'none' ? null : choice.slice(1))

function filtersOf(source: Choice, campaign: Choice): RoiFilters {
  if (source === 'all') return {}
  const filters: RoiFilters = { source: keyOf(source) }
  if (source !== 'none' && campaign !== 'all') filters.campaign = keyOf(campaign)
  return filters
}

function cellValue(cell: CohortCell, metric: Metric): number | null {
  return metric === 'revenue'
    ? cell.revenue_per_user
    : metric === 'roas'
      ? cell.roas
      : cell.retention
}

function cellText(value: number, metric: Metric, currency: string): string {
  return metric === 'revenue' ? formatMoney(value, currency) : formatRatio(value)
}

function cellDetail(cohort: Cohort, cell: CohortCell, metric: Metric, currency: string): string {
  const when = `day ${cell.day}${cell.state === 'partial' ? ' so far' : ''}`
  if (metric === 'revenue')
    return `${formatMoney(cell.revenue, currency)} paid by ${plural(cohort.users, 'person', 'people')} by ${when}`
  if (metric === 'roas')
    return `${formatMoney(cell.revenue, currency)} back of ${formatMoney(cohort.cost, currency)} spent, by ${when}`
  return `${formatCount(cell.returned)} of ${plural(cell.complete_users, 'person', 'people')} active on ${when}`
}

export function CohortsScreen({ project }: { project: Project }) {
  const [interval, setGrouping] = useState<CohortInterval>('day')
  const [source, setSource] = useState<Choice>('all')
  const [campaign, setCampaign] = useState<Choice>('all')
  const [metric, setMetric] = useState<Metric>('revenue')
  // The filters offer what ROI lists: sources over 90 days, then the chosen source's campaigns.
  const sources = useRpc(`attribution-cohort-sources:${project.id}`, () =>
    api.attributionRoi(project.id, { range: '90d', group: 'source' }),
  )
  const opened = source !== 'all' && source !== 'none'
  const campaigns = useRpc(
    `attribution-cohort-campaigns:${project.id}:${source}`,
    () =>
      api.attributionRoi(project.id, { range: '90d', group: 'campaign', source: keyOf(source) }),
    { enabled: opened },
  )
  const filters = filtersOf(source, campaign)
  const report = useRpc(
    `attribution-cohorts:${project.id}:${interval}:${JSON.stringify(filters)}`,
    () => api.attributionCohorts(project.id, { interval, ...filters }),
  )
  const [kept, setKept] = useState<CohortsReport>()
  if (report.data && report.data !== kept) setKept(report.data)
  const shown = report.data ?? kept
  const stale = !report.data && Boolean(kept)
  const currency = shown?.currency ?? 'USD'
  const filtered = source !== 'all'
  const scope =
    source === 'all'
      ? null
      : `${roiKeyLabel('source', keyOf(source))}${opened && campaign !== 'all' ? `, ${roiKeyLabel('campaign', keyOf(campaign))}` : ''}`

  const sourceOptions = [
    { value: 'all' as Choice, label: 'All sources' },
    ...(sources.data?.rows ?? []).map((row) => ({
      value: choiceOf(row.key),
      label: roiKeyLabel('source', row.key),
    })),
  ]
  // A chosen source the list no longer has stays choosable, so the select shows it.
  if (!sourceOptions.some((option) => option.value === source))
    sourceOptions.push({ value: source, label: roiKeyLabel('source', keyOf(source)) })
  const campaignOptions = [
    { value: 'all' as Choice, label: 'All campaigns' },
    ...(campaigns.data?.rows ?? []).map((row) => ({
      value: choiceOf(row.key),
      label: roiKeyLabel('campaign', row.key),
    })),
  ]
  if (!campaignOptions.some((option) => option.value === campaign))
    campaignOptions.push({ value: campaign, label: roiKeyLabel('campaign', keyOf(campaign)) })

  return (
    <>
      <div className="mc-toolbar">
        <Segmented
          label="Group people by"
          value={interval}
          onChange={setGrouping}
          options={intervalOptions}
        />
        <Select
          label="Source"
          hideLabel
          value={source}
          onChange={(next) => {
            setSource(next)
            setCampaign('all')
          }}
          options={sourceOptions}
        />
        {opened && (
          <Select
            label="Campaign"
            hideLabel
            value={campaign}
            onChange={setCampaign}
            options={campaignOptions}
          />
        )}
        {sources.error && (
          <span className="mc-toolbar-count mc-muted">Couldn&rsquo;t load your sources.</span>
        )}
      </div>

      {report.error && (
        <ErrorNote
          message={`Couldn't load cohorts. ${report.error}`}
          onRetry={() => void report.refresh()}
        />
      )}

      <div className={stale ? 'mc-at3-body is-stale' : 'mc-at3-body'}>
        <div
          className="mc-kpis mc-kpis-4"
          role="group"
          aria-label={scope ? `${scope} totals` : 'Totals'}
        >
          {(
            [
              [
                'People',
                (r: CohortsReport) => formatCount(r.totals.users),
                (span: string) => `who arrived in ${span}`,
              ],
              [
                'Spend',
                (r: CohortsReport) => formatMoneyTile(r.totals.cost, currency),
                () => 'on the days they arrived',
              ],
              [
                'Revenue',
                (r: CohortsReport) => formatMoneyTile(r.totals.revenue, currency),
                () => 'paid since they arrived',
              ],
              [
                'Paying people',
                (r: CohortsReport) => formatCount(r.totals.payers),
                () => 'have paid since they arrived',
              ],
            ] as const
          ).map(([label, value, sub]) => (
            <div key={label} className="mc-kpi">
              <span className="mc-kpi-label">{label}</span>
              <strong className="mc-kpi-value">
                {shown ? value(shown) : <Skeleton width={72} height={28} />}
              </strong>
              <span className="mc-sub">{shown ? sub(frames[shown.interval].span) : ''}</span>
            </div>
          ))}
        </div>
        {shown && unconvertedNote(shown.unconverted) && (
          <p className="mc-warning-text mc-attr-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>{unconvertedNote(shown.unconverted)}</span>
          </p>
        )}

        <Panel
          title={`People by the ${frames[shown?.interval ?? interval].noun} they arrived`}
          description={
            metric === 'revenue'
              ? 'What each group has paid per person by each day after they arrived.'
              : metric === 'roas'
                ? 'What each group has paid back of the spend on its days, by each day after they arrived.'
                : 'The share of each group active again on each day after they arrived.'
          }
          id="mc-at3-cohorts"
          flush
          actions={
            <div className="mc-panel-tools">
              <Segmented label="Show" value={metric} onChange={setMetric} options={metricOptions} />
            </div>
          }
        >
          {!shown ? (
            <div className="mc-table-loading" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((row) => (
                <Skeleton key={row} width="100%" height={28} />
              ))}
            </div>
          ) : shown.totals.users === 0 ? (
            <div className="mc-attr-empty">
              <Empty>
                {filtered
                  ? `Nobody from ${scope} arrived in ${frames[shown.interval].span}.`
                  : `Nobody arrived in ${frames[shown.interval].span} yet. Rows fill in as people arrive.`}
              </Empty>
              {filtered && (
                <button
                  type="button"
                  className="mc-btn mc-btn-secondary"
                  onClick={() => {
                    setSource('all')
                    setCampaign('all')
                  }}
                >
                  Show all sources
                </button>
              )}
            </div>
          ) : (
            <HeatTable report={shown} metric={metric} />
          )}
        </Panel>

        <div className="mc-at3-curves">
          <Panel
            title="Revenue per person by day"
            description="What people paid by each day after they arrived, over those who have finished that day."
            id="mc-at3-ltv"
          >
            {shown ? (
              <Curve report={shown} kind="revenue" />
            ) : (
              <div className="mc-chart" style={{ height: 220 }} aria-hidden="true" />
            )}
          </Panel>
          <Panel
            title="Retention by day"
            description="The share active again on each day after they arrived, over those who have reached it."
            id="mc-at3-retention"
          >
            {shown ? (
              <Curve report={shown} kind="retention" />
            ) : (
              <div className="mc-chart" style={{ height: 220 }} aria-hidden="true" />
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

function HeatTable({ report, metric }: { report: CohortsReport; metric: Metric }) {
  const currency = report.currency
  // The oldest groups from before anyone arrived are left off, as in Retention.
  const oldestUsed = report.cohorts.reduce(
    (last, cohort, index) => (cohort.users > 0 ? index : last),
    -1,
  )
  const cohorts = report.cohorts.slice(0, oldestUsed + 1)
  // Days no group has reached yet are left off, keeping at least day 0 to 7.
  const reached = report.days.filter((day, index) =>
    index < 4
      ? true
      : cohorts.some((cohort) =>
          cohort.cells.some((cell) => cell.day === day && cell.state !== 'future'),
        ),
  )
  const values = cohorts.flatMap((cohort) =>
    cohort.cells.flatMap((cell) => {
      const value = cell.state === 'future' ? null : cellValue(cell, metric)
      return value === null ? [] : [value]
    }),
  )
  const top = metric === 'retention' ? 1 : Math.max(0, ...values)
  const anyPartial = cohorts.some((cohort) => cohort.cells.some((cell) => cell.state === 'partial'))
  return (
    <>
      <div className="mc-cohorts-frame" tabIndex={0} role="region" aria-label="Cohorts by day">
        <table className="mc-cohorts mc-at3-cohorts">
          <thead>
            <tr>
              <th scope="col">Arrived</th>
              <th scope="col" className="mc-cohort-size">
                People
              </th>
              {metric === 'roas' && (
                <th scope="col" className="mc-cohort-size">
                  Spend
                </th>
              )}
              {reached.map((day) => (
                <th key={day} scope="col">
                  Day {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => {
              const label = cohortLabel(report.interval, cohort.start)
              return (
                <tr key={cohort.start}>
                  <th scope="row">{label}</th>
                  <td className="mc-cohort-size mc-num">
                    {cohort.users ? formatCount(cohort.users) : <span className="mc-muted">0</span>}
                  </td>
                  {metric === 'roas' && (
                    <td className="mc-cohort-size mc-num">
                      {cohort.cost > 0 ? (
                        formatMoney(cohort.cost, currency, cohort.cost >= 1000)
                      ) : (
                        <span className="mc-muted">—</span>
                      )}
                    </td>
                  )}
                  {reached.map((day) => {
                    const cell = cohort.cells.find((item) => item.day === day)
                    if (!cell || cell.state === 'future') return <td key={day} />
                    const value = cellValue(cell, metric)
                    // A day under way that nobody has finished yet has no share to show.
                    if (value === null && cohort.users > 0 && cell.state === 'partial')
                      return (
                        <td key={day}>
                          <span
                            className="mc-cohort-cell is-partial is-none"
                            aria-label={`${label}, day ${day}: still filling, nobody has finished it yet`}
                            title={`${label}: still filling, nobody has finished day ${day} yet`}
                          >
                            <Hourglass className="mc-at3-cell-mark" size={11} aria-hidden="true" />
                          </span>
                        </td>
                      )
                    if (value === null || !cohort.users)
                      return (
                        <td key={day}>
                          <span
                            className="mc-cohort-cell is-none"
                            aria-label={`${label}, day ${day}: nothing to show`}
                          >
                            —
                          </span>
                        </td>
                      )
                    const text = cellText(value, metric, currency)
                    const detail = cellDetail(cohort, cell, metric, currency)
                    const partial = cell.state === 'partial'
                    return (
                      <td key={day}>
                        <span
                          className={partial ? 'mc-cohort-cell is-partial' : 'mc-cohort-cell'}
                          style={{ background: heatShade(top > 0 ? value / top : 0) }}
                          aria-label={`${label}, day ${day}: ${text}${partial ? ', still filling' : ''}. ${detail}`}
                          title={`${label}: ${detail}${partial ? '. Still filling' : ''}`}
                        >
                          {text}
                          {partial && (
                            <Hourglass className="mc-at3-cell-mark" size={11} aria-hidden="true" />
                          )}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mc-cohort-foot">
        <span className="mc-cohort-scale" aria-hidden="true">
          <span>{metric === 'revenue' ? formatMoney(0, currency, true) : '0%'}</span>
          <i
            style={{
              background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((share) => `${heatShade(share)} ${share * 100}%`).join(', ')})`,
            }}
          />
          <span>{metric === 'revenue' ? formatMoney(top, currency) : formatRatio(top)}</span>
        </span>
        <span className="mc-muted">
          Deeper blue means more.{' '}
          {anyPartial && (
            <>
              <Hourglass size={12} aria-hidden="true" className="mc-at3-inline-icon" /> Still
              filling: some of the group have not finished that day yet, so the figure can still
              change.{' '}
            </>
          )}
          Blank cells are days still to come.
          {metric === 'roas' ? ' A dash means no spend was added for those days.' : ''}
        </span>
      </div>
    </>
  )
}

function Curve({ report, kind }: { report: CohortsReport; kind: 'revenue' | 'retention' }) {
  const points = report.curve.flatMap((point) => {
    const value = kind === 'revenue' ? point.revenue_per_user : point.retention
    return point.users > 0 && value !== null ? [{ ...point, value }] : []
  })
  if (!points.length)
    return (
      <Empty>
        {report.totals.users
          ? 'Nobody has finished their first day yet. The curve begins once they have.'
          : 'Nobody arrived in these groups yet.'}
      </Empty>
    )
  const byDay = new Map(points.map((point) => [point.day, point]))
  const currency = report.currency
  return (
    <LineChart
      label={
        kind === 'revenue'
          ? 'Revenue per person by each day after they arrived'
          : 'Share of people active again on each day after they arrived'
      }
      height={220}
      integers={kind === 'retention'}
      series={[
        {
          key: kind,
          label: kind === 'revenue' ? 'Revenue per person' : 'Active again',
          color: seriesColors[0],
          points: points.map((point) => ({
            time: point.day,
            value: kind === 'revenue' ? point.value : point.value * 100,
          })),
        },
      ]}
      formatX={(day) => `Day ${day}`}
      formatTooltip={(day) => {
        const point = byDay.get(day)
        return point ? `Day ${day}, over ${plural(point.users, 'person', 'people')}` : `Day ${day}`
      }}
      formatValue={(value) =>
        kind === 'revenue' ? formatMoney(value, currency) : formatRatio(value / 100)
      }
      formatTick={(value) => (kind === 'revenue' ? formatMoneyTick(value, currency) : `${value}%`)}
      ceiling={kind === 'retention' ? 100 : undefined}
    />
  )
}
