import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpDown,
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Clock3,
  Coins,
  Link2,
  MousePointer2,
  SlidersHorizontal,
} from 'lucide-react'
import { Dialog } from '../../components/Dialog'
import { ErrorState, LoadingState, PartialNotice } from '../../components/States'
import {
  downloadCsv,
  money,
  previewCampaigns,
  previewCountries,
  previewFunnels,
  previewPayouts,
  previewSources,
  trackedPreviewUrl,
} from './data'
import type { PortalPage, PreviewLink, PreviewState } from './data'
import { linkHasHistory, linkReportingRecords, scopeLinkFilters } from './linkData'
import {
  aggregateReport,
  allPeriodMetrics,
  breakdownLabels,
  chartGroups,
  currentSubscriptions,
  defaultReportingFilters,
  dimensionReport,
  effectiveStage,
  filterReportingRecords,
  formatMetric,
  metricDefinitions,
  primaryMetrics,
  rangeLabel,
  reportCsv,
  reportRange,
  REPORT_COVERAGE_START,
  REPORT_TODAY,
  resetDimensions,
  secondaryMetrics,
  sortReport,
  tableMetrics,
  timeReport,
  validateCustomRange,
} from './reporting'
import type {
  Breakdown,
  ChartGroup,
  MetricKey,
  PeriodMetric,
  ReconciliationStage,
  ReportingFilters,
  ReportingPeriod,
  ReportSort,
  TimeGrain,
} from './reporting'

const TrendChart = lazy(() => import('./TrendChart'))
const missingProviderMetrics: PeriodMetric[] = ['installs', 'activations']
const noMissingMetrics: PeriodMetric[] = []
const stageLabels: Record<ReconciliationStage, string> = {
  preliminary: 'Preliminary',
  reconciled: 'Reconciled',
  finalized: 'Finalized',
}
const providers = [
  { name: 'Tracker', time: '08:00', partial: false },
  { name: 'Singular', time: '07:45', partial: true },
  { name: 'Stripe', time: '07:55', partial: false },
  { name: 'App events', time: '07:50', partial: true },
  { name: 'Payout reconciliation', time: '06:00', partial: false },
]
type Props = {
  state: PreviewState
  navigate: (page: PortalPage) => void
  onRetry: () => void
  link?: PreviewLink | null
  onClearLink?: () => void
}

// Keep keyboard-focused header actions visible beyond the pinned first column.
function revealTableControl(event: FocusEvent<HTMLDivElement>) {
  const container = event.currentTarget
  const target = event.target
  if (target === container || !(target instanceof HTMLElement)) return
  const rect = container.getBoundingClientRect()
  const control = target.getBoundingClientRect()
  const firstCell = container.querySelector('thead th')?.getBoundingClientRect()
  const pinned =
    target.closest('th') === container.querySelector('thead th') ? 0 : (firstCell?.width ?? 0)
  if (control.left < rect.left + pinned + 8)
    container.scrollLeft -= rect.left + pinned + 8 - control.left
  else if (control.right > rect.right - 8) container.scrollLeft += control.right - rect.right + 8
}

export function Performance({ state, navigate, onRetry, link, onClearLink }: Props) {
  const [filters, setFilters] = useState<ReportingFilters>(() =>
    scopeLinkFilters(defaultReportingFilters, link),
  )
  const [draftFilters, setDraftFilters] = useState<ReportingFilters>(() =>
    scopeLinkFilters(defaultReportingFilters, link),
  )
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [datesOpen, setDatesOpen] = useState(false)
  const [draftDates, setDraftDates] = useState({ start: '', end: '' })
  const [dateError, setDateError] = useState<ReturnType<typeof validateCustomRange>>(null)
  const startInput = useRef<HTMLInputElement>(null)
  const endInput = useRef<HTMLInputElement>(null)
  const [reportingInfoOpen, setReportingInfoOpen] = useState(false)
  const [definition, setDefinition] = useState<MetricKey | null>(null)
  const [grain, setGrain] = useState<TimeGrain>('day')
  const [breakdown, setBreakdown] = useState<Breakdown>('source')
  const [tablePage, setTablePage] = useState(0)
  const [sort, setSort] = useState<ReportSort>({ key: 'label', direction: 'asc' })
  const [allColumns, setAllColumns] = useState(false)
  const [chartGroup, setChartGroup] = useState<ChartGroup>('revenue')
  const [series, setSeries] = useState<PeriodMetric[]>(chartGroups.revenue.defaults)
  const [requestedStage, setRequestedStage] = useState<ReconciliationStage>('preliminary')
  const range = useMemo(() => reportRange(filters), [filters])
  const missing = state === 'partial' ? missingProviderMetrics : noMissingMetrics
  const rows = useMemo(
    () =>
      state === 'empty'
        ? []
        : link
          ? linkReportingRecords(link, filters)
          : filterReportingRecords(filters),
    [state, filters, link],
  )
  const totals = useMemo(() => aggregateReport(rows, missing), [rows, missing])
  const timeline = useMemo(
    () => timeReport(rows, range, grain, missing),
    [rows, range, grain, missing],
  )
  const report = useMemo(
    () => (breakdown === 'date' ? timeline : dimensionReport(rows, breakdown, missing)),
    [rows, breakdown, timeline, missing],
  )
  const sortedRows = useMemo(() => sortReport(report, sort), [report, sort])
  const columns = useMemo(
    () =>
      allColumns
        ? allPeriodMetrics
        : [...new Set([...tableMetrics, ...series, ...(sort.key === 'label' ? [] : [sort.key])])],
    [allColumns, series, sort.key],
  )
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / 7))
  const currentTablePage = Math.min(tablePage, pageCount - 1)
  const displayedRows = sortedRows.slice(currentTablePage * 7, currentTablePage * 7 + 7)
  const activeFilterCount =
    [filters.country, filters.campaign, filters.funnel].filter((value) => value !== 'all').length +
    Number(Boolean(filters.subId.trim()))
  const unavailable = state === 'error' || state === 'loading'
  const stage = effectiveStage(requestedStage, range, state === 'partial' || state === 'empty')
  const active = currentSubscriptions(
    filters,
    state === 'empty' || Boolean(link && !linkHasHistory(link)),
  )
  const chartUnavailable =
    rows.length > 0 &&
    series.length > 0 &&
    !timeline.some((row) => series.some((key) => row.values[key] !== null))

  function applyFilters(next: ReportingFilters) {
    setFilters(scopeLinkFilters(next, link))
    setTablePage(0)
  }
  function openDates() {
    setDraftDates(range)
    setDateError(null)
    setDatesOpen(true)
  }
  function changeSort(key: ReportSort['key']) {
    setSort({ key, direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc' })
    setTablePage(0)
  }
  function exportReport() {
    const csv = reportCsv(sortedRows, totals, filters, breakdown, grain, stage)
    if (link) {
      csv.headers.push('Sample link', 'Sample tracking URL')
      csv.rows = csv.rows.map((row) => [...row, link.name, trackedPreviewUrl(link)])
    }
    downloadCsv(
      `SAMPLE-partner-${breakdown}-${range.start}-${range.end}.csv`,
      csv.headers,
      csv.rows,
    )
  }
  function metricHelp(key: MetricKey) {
    return (
      <button
        className="metric-definition"
        type="button"
        aria-label={`About ${metricDefinitions[key].label}`}
        title={metricDefinitions[key].definition}
        onClick={() => setDefinition(key)}
      >
        <CircleHelp size={15} aria-hidden="true" />
      </button>
    )
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">THE BIG PICTURE</p>
          <h1>
            Performance<span className="heading-dot">.</span>
          </h1>
          <p>Your traffic, conversions, and earnings. All in one place.</p>
        </div>
        <button
          className="button button-white"
          onClick={exportReport}
          disabled={!rows.length || unavailable}
        >
          <ArrowDownToLine size={16} /> Export report
        </button>
      </div>
      {link && state !== 'empty' && !unavailable && (
        <section className="link-report-context" aria-label="Selected link report">
          <div>
            <strong>Viewing link: {link.name}</strong>
            <p>
              {link.source} · {link.campaign} · {link.funnel} · sub1: {link.subId}
              {link.sub2 ? ` · sub2: ${link.sub2}` : ''}
              {link.sub3 ? ` · sub3: ${link.sub3}` : ''}
            </p>
            <p>
              {linkHasHistory(link)
                ? 'Only this sample link’s history. Pausing or archiving does not remove it.'
                : 'No activity for this new sample link. Similar tracking labels never copy another link’s history.'}{' '}
              Date and country filters remain available.
            </p>
          </div>
          <button className="button button-white" onClick={onClearLink}>
            Show all performance
          </button>
        </section>
      )}
      <div className="filter-bar">
        <label className="filter-select date-select">
          <CalendarDays size={16} />
          <span className="sr-only">Reporting period</span>
          <select
            value={filters.period}
            onChange={(event) =>
              event.target.value === 'custom'
                ? openDates()
                : applyFilters({ ...filters, period: event.target.value as ReportingPeriod })
            }
          >
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="year">This year</option>
            <option value="custom">Custom range</option>
          </select>
          <ChevronDown size={14} />
        </label>
        {filters.period === 'custom' && (
          <button className="button button-white" onClick={openDates}>
            Edit dates
          </button>
        )}
        <label className="filter-select">
          <Link2 size={16} />
          <span className="sr-only">Traffic source</span>
          <select
            value={state === 'empty' ? 'all' : filters.source}
            disabled={state === 'empty' || Boolean(link)}
            onChange={(event) => applyFilters({ ...filters, source: event.target.value })}
          >
            <option value="all">All sources</option>
            {state !== 'empty' &&
              previewSources.map((source) => <option key={source}>{source}</option>)}
          </select>
          <ChevronDown size={14} />
        </label>
        <button
          className={`button button-white filter-button ${activeFilterCount ? 'filters-active' : ''}`}
          onClick={() => {
            setDraftFilters(filters)
            setFiltersOpen(true)
          }}
        >
          <SlidersHorizontal size={14} /> Filters{' '}
          {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
        </button>
        <span className="filter-date-label">{rangeLabel(range)}</span>
        <button
          className="timezone-label"
          onClick={() => setReportingInfoOpen(true)}
          aria-label="Reporting timezone and status information"
        >
          UTC <CircleHelp size={13} />
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {unavailable
          ? `Report ${state}.`
          : `Report updated. ${rangeLabel(range)}, UTC. ${filters.source === 'all' ? 'All sources' : filters.source}. ${activeFilterCount} additional filters. ${stageLabels[stage]} sample.`}
      </p>
      {state === 'loading' ? (
        <LoadingState label="Loading performance preview" />
      ) : state === 'error' ? (
        <ErrorState onRetry={onRetry} />
      ) : (
        <>
          {state === 'partial' && <PartialNotice />}
          <section className="metric-grid reporting-metrics" aria-label="Performance summary">
            {primaryMetrics.map((key) => (
              <article
                className={`metric-card ${key === 'earningsMinor' ? 'metric-featured' : ''}`}
                key={key}
                aria-label={metricDefinitions[key].label}
              >
                <div className="metric-top">
                  <span>{metricDefinitions[key].label}</span>
                  {metricHelp(key)}
                </div>
                <strong
                  className="metric-value"
                  aria-label={
                    (key === 'activeSubscriptions' ? active : totals[key]) === null
                      ? 'Unavailable'
                      : undefined
                  }
                >
                  {formatMetric(key, key === 'activeSubscriptions' ? active : totals[key])}
                </strong>
                <div className="metric-foot">
                  <span>{metricDefinitions[key].note}</span>
                  {key === 'earningsMinor' && <ArrowUpRight size={16} />}
                </div>
              </article>
            ))}
          </section>
          <div className="performance-main-grid">
            <section
              className="panel chart-panel reporting-chart-panel"
              aria-labelledby="growth-heading"
            >
              <div className="panel-heading">
                <div>
                  <h2 id="growth-heading">Growth over time</h2>
                  <p>The progress behind the numbers.</p>
                </div>
                <button
                  className="status-badge badge-neutral badge-button"
                  onClick={() => setReportingInfoOpen(true)}
                >
                  <span />
                  {stageLabels[stage]} <CircleHelp size={11} />
                </button>
              </div>
              <div className="report-chart-controls">
                <div className="segmented-control" role="group" aria-label="Chart group">
                  {(Object.keys(chartGroups) as ChartGroup[]).map((key) => (
                    <button
                      key={key}
                      aria-pressed={chartGroup === key}
                      className={chartGroup === key ? 'selected' : ''}
                      onClick={() => {
                        setChartGroup(key)
                        setSeries(chartGroups[key].defaults)
                      }}
                    >
                      {chartGroups[key].label}
                    </button>
                  ))}
                </div>
                <div className="segmented-control" role="group" aria-label="Time grouping">
                  {(['day', 'week', 'month'] as const).map((key) => (
                    <button
                      key={key}
                      aria-pressed={grain === key}
                      className={grain === key ? 'selected' : ''}
                      onClick={() => {
                        setGrain(key)
                        setTablePage(0)
                      }}
                    >
                      {key[0].toUpperCase() + key.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <fieldset className="chart-series" aria-describedby="chart-series-hint">
                <legend className="sr-only">Visible chart metrics</legend>
                {chartGroups[chartGroup].metrics.map((key) => {
                  const selected = series.includes(key)
                  return (
                    <label key={key} className={selected ? 'series-selected' : ''}>
                      <input
                        type="checkbox"
                        aria-label={`${metricDefinitions[key].label}${missing.includes(key) ? ' (unavailable)' : ''}`}
                        checked={selected}
                        disabled={!selected && series.length === 3}
                        onChange={() =>
                          setSeries(
                            selected ? series.filter((value) => value !== key) : [...series, key],
                          )
                        }
                      />
                      {metricDefinitions[key].label}
                      {missing.includes(key) && <span className="sr-only"> (unavailable)</span>}
                    </label>
                  )
                })}
              </fieldset>
              <div className="chart-series-hint" id="chart-series-hint">
                <span>
                  {series.length} of 3 metrics selected
                  {series.length === 3 ? ' · Deselect one to add another' : ''}
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    setBreakdown('date')
                    setTablePage(0)
                    setSort({ key: 'label', direction: 'asc' })
                    document.getElementById('report-table-heading')?.focus()
                  }}
                >
                  View chart data <ArrowRight size={13} />
                </button>
              </div>
              {rows.length && series.length && !chartUnavailable ? (
                <figure
                  className="report-chart"
                  aria-label={`${chartGroups[chartGroup].label} chart`}
                >
                  <div className="chart-wrap">
                    <Suspense
                      fallback={
                        <div className="chart-loading" role="status">
                          Loading chart…
                        </div>
                      }
                    >
                      <TrendChart
                        rows={timeline}
                        series={series}
                        currency={chartGroup === 'revenue'}
                      />
                    </Suspense>
                  </div>
                  <figcaption>
                    {series.map((key, index) => (
                      <span key={key}>
                        <i className={`series-line series-line-${index}`} />
                        {metricDefinitions[key].label}
                        {missing.includes(key) ? ' · Unavailable' : ''}
                      </span>
                    ))}
                    <span>
                      Calendar {grain}s · UTC{grain === 'week' ? ' · Monday start' : ''}
                    </span>
                  </figcaption>
                </figure>
              ) : (
                <div className="chart-empty">
                  <div className="empty-icon">
                    <MousePointer2 size={24} />
                  </div>
                  <h3>
                    {!series.length
                      ? 'Choose a metric to explore'
                      : chartUnavailable
                        ? 'Selected metrics are unavailable'
                        : state === 'empty'
                          ? 'Your story starts with a click'
                          : 'No activity matches these filters'}
                  </h3>
                  {!series.length ? (
                    <p>Select up to three metrics above to compare their trends.</p>
                  ) : chartUnavailable ? (
                    <p>
                      These provider values are missing, not zero. Choose an available metric or
                      review the em dashes in the table below.
                    </p>
                  ) : state === 'empty' ? (
                    <>
                      <p>
                        Once your first product and funnel are ready,
                        <br />
                        you’ll see performance take shape here.
                      </p>
                      <button className="text-button" onClick={() => navigate('links')}>
                        Explore Links &amp; Sources <ArrowRight size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <p>Try a different source or remove filters to see your sample activity.</p>
                      <button
                        className="text-button"
                        onClick={() => applyFilters(resetDimensions(filters))}
                      >
                        Clear report filters <ArrowRight size={14} />
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="panel-footnote">
                <span className="small-dot" />
                {state === 'empty'
                  ? 'No activity in this preview account.'
                  : 'Sample snapshot · Aug 26, 2026 · Not synced'}
                <span>All amounts in USD</span>
              </div>
            </section>
            <aside className="payout-overview">
              <div className="payout-card-icon">
                <Coins size={22} />
              </div>
              <div className="payout-card-eyebrow">YOUR NEXT CHAPTER</div>
              <h2>
                Good partnerships.
                <br />
                Clear rewards.
              </h2>
              <p>Know what you’ve earned and where every payout stands.</p>
              <div className="payout-preview-value">
                <span>Current period · All sources</span>
                <strong>
                  {state === 'empty' ? '$0.00' : money(previewPayouts[0].earningsMinor)}
                </strong>
                <span className="status-badge badge-dark">
                  {state === 'empty' ? 'No active period' : 'Sample · Open period'}
                </span>
              </div>
              <button className="button button-lime" onClick={() => navigate('payouts')}>
                View payouts <ArrowRight size={16} />
              </button>
              <span className="payout-small-print">
                Earnings are not yet approved for payout. Report filters do not change this
                current-period summary.
              </span>
            </aside>
          </div>
          <section
            className="panel source-panel reporting-table-panel"
            aria-labelledby="report-table-heading"
          >
            <div className="panel-heading">
              <div>
                <h2 id="report-table-heading" tabIndex={-1}>
                  Where your results come from
                </h2>
                <p>
                  {breakdown === 'date'
                    ? `Chart values by calendar ${grain}. First and last buckets follow your selected dates.`
                    : 'Full-period totals by dimension. Time grouping only changes the chart and Date breakdown.'}
                </p>
              </div>
              <label className="filter-select">
                <span className="sr-only">Report breakdown</span>
                <select
                  value={breakdown}
                  onChange={(event) => {
                    setBreakdown(event.target.value as Breakdown)
                    setTablePage(0)
                    setSort({ key: 'label', direction: 'asc' })
                  }}
                >
                  {(Object.keys(breakdownLabels) as Breakdown[]).map((key) => (
                    <option value={key} key={key}>
                      {breakdownLabels[key]}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </label>
            </div>
            <div className="report-table-tools">
              <label className="report-column-toggle">
                <input
                  type="checkbox"
                  checked={allColumns}
                  onChange={(event) => setAllColumns(event.target.checked)}
                />
                Show all metrics
              </label>
              <span>
                {stageLabels[stage]} sample · CSV includes all metrics and all{' '}
                {rows.length ? sortedRows.length : 0} rows, plus totals.
              </span>
            </div>
            {rows.length ? (
              <div
                className="table-scroll reporting-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Performance breakdown table"
                aria-describedby="report-totals-note"
                onFocusCapture={revealTableControl}
              >
                <table>
                  <caption className="sr-only">
                    Sample performance in USD, grouped by {breakdownLabels[breakdown]}.{' '}
                    {rangeLabel(range)}, UTC. {stageLabels[stage]}. Scroll horizontally for more
                    metrics. Unavailable values are shown as an em dash.
                  </caption>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        aria-sort={
                          sort.key === 'label'
                            ? sort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                      >
                        <button
                          className="report-sort"
                          onClick={() => changeSort('label')}
                          aria-label={`Sort by ${breakdownLabels[breakdown]}`}
                        >
                          {breakdownLabels[breakdown]}
                          {breakdown === 'date' && ' (UTC)'}
                          <ArrowUpDown size={13} />
                        </button>
                      </th>
                      {columns.map((key) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={
                            sort.key === key
                              ? sort.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : undefined
                          }
                        >
                          <div className="report-column-heading">
                            <button
                              className="report-sort"
                              onClick={() => changeSort(key)}
                              aria-label={`Sort by ${metricDefinitions[key].label}`}
                            >
                              {metricDefinitions[key].label}
                              <ArrowUpDown size={13} />
                            </button>
                            {metricHelp(key)}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedRows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        {columns.map((key) => (
                          <td
                            key={key}
                            className={
                              metricDefinitions[key].kind === 'money' ? 'money-cell' : undefined
                            }
                            aria-label={row.values[key] === null ? 'Unavailable' : undefined}
                          >
                            {formatMetric(key, row.values[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total · All filtered rows</th>
                      {columns.map((key) => (
                        <td
                          key={key}
                          className={
                            metricDefinitions[key].kind === 'money' ? 'money-cell' : undefined
                          }
                          aria-label={totals[key] === null ? 'Unavailable' : undefined}
                        >
                          {formatMetric(key, totals[key])}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="table-empty">
                <Link2 size={24} />
                <h3>{state === 'empty' ? 'No sources yet' : 'No matching results'}</h3>
                <p>
                  {state === 'empty'
                    ? 'Your sources will appear when the first tracked link is available.'
                    : 'Try a wider date range or clear the report filters.'}
                </p>
                {state !== 'empty' && (
                  <button
                    className="text-button"
                    onClick={() => applyFilters(resetDimensions(filters))}
                  >
                    Clear filters <ArrowRight size={14} />
                  </button>
                )}
              </div>
            )}
            <div className="panel-footnote">
              <span>
                <BadgeCheck size={14} />
                Direct / untagged is included when no source filter is applied.
              </span>
              <span className="pagination">
                <button
                  aria-label="Previous report rows"
                  disabled={currentTablePage === 0 || !rows.length}
                  onClick={() => setTablePage(currentTablePage - 1)}
                >
                  ←
                </button>
                {currentTablePage + 1} / {rows.length ? pageCount : 1}
                <button
                  aria-label="Next report rows"
                  disabled={currentTablePage >= pageCount - 1 || !rows.length}
                  onClick={() => setTablePage(currentTablePage + 1)}
                >
                  →
                </button>
              </span>
            </div>
            <p className="report-totals-note" id="report-totals-note">
              Totals cover the full selection, not just this page. Unique visitors are deduplicated
              across the period; rates use total counts. The current subscription snapshot is not a
              period total.
            </p>
          </section>
          <details className="secondary-metrics reporting-secondary">
            <summary>
              Explore more metrics <ChevronDown size={14} />
            </summary>
            <div className="secondary-metric-grid">
              {secondaryMetrics.map((key) => (
                <div key={key}>
                  <span>
                    {metricDefinitions[key].label}
                    {metricHelp(key)}
                  </span>
                  <strong aria-label={totals[key] === null ? 'Unavailable' : undefined}>
                    {formatMetric(key, totals[key])}
                  </strong>
                </div>
              ))}
            </div>
            <p>
              Confirmed installs are separate from App Store clicks. Trial starts do not create
              revenue-share earnings. Eligible revenue follows the example commercial terms.
            </p>
          </details>
          <section className="panel reporting-freshness" aria-labelledby="freshness-heading">
            <div className="panel-heading">
              <div>
                <h2 id="freshness-heading">Data freshness</h2>
                <p>Illustrative timestamps only. No provider sync or reconciliation has run.</p>
              </div>
              <Clock3 size={19} aria-hidden="true" />
            </div>
            <dl className="provider-grid">
              {providers.map((provider) => (
                <div key={provider.name}>
                  <dt>{provider.name}</dt>
                  <dd>
                    {state === 'empty' ? (
                      'Not configured'
                    ) : state === 'partial' && provider.partial ? (
                      'Unavailable'
                    ) : (
                      <>
                        <time dateTime={`2026-08-26T${provider.time}:00Z`}>
                          Aug 26 · {provider.time} UTC
                        </time>
                        <span>Sample timestamp</span>
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="report-stage-control">
              <label className="filter-select">
                <span>Sample status</span>
                <select
                  aria-label="Sample reconciliation status"
                  value={stage}
                  disabled={state === 'partial' || state === 'empty'}
                  onChange={(event) => setRequestedStage(event.target.value as ReconciliationStage)}
                >
                  <option value="preliminary">Preliminary</option>
                  <option value="reconciled">Reconciled</option>
                  <option value="finalized" disabled={range.end >= '2026-08-17'}>
                    Finalized
                  </option>
                </select>
                <ChevronDown size={14} />
              </label>
              <button className="text-button" onClick={() => setReportingInfoOpen(true)}>
                What do these mean? <CircleHelp size={14} />
              </button>
            </div>
          </section>
        </>
      )}
      <Dialog
        open={datesOpen}
        onOpenChange={setDatesOpen}
        title="Choose your date range"
        description="Sample coverage: Jan 1 – Aug 26, 2026. Both dates are included, in UTC."
      >
        <form
          noValidate
          onInput={() => setDateError(null)}
          onSubmit={(event) => {
            event.preventDefault()
            // Read the submitted native date fields so validation always agrees
            // with the visible values, including browser date-picker changes.
            const form = new FormData(event.currentTarget)
            const start = String(form.get('start') ?? '')
            const end = String(form.get('end') ?? '')
            const error = validateCustomRange(start, end)
            setDateError(error)
            if (error) {
              ;(error.field === 'start' ? startInput : endInput).current?.focus()
              return
            }
            applyFilters({
              ...filters,
              period: 'custom',
              customStart: start,
              customEnd: end,
            })
            setDatesOpen(false)
          }}
        >
          <div className="form-grid">
            <label className="form-field">
              Start date
              <input
                ref={startInput}
                type="date"
                name="start"
                min={REPORT_COVERAGE_START}
                max={REPORT_TODAY}
                defaultValue={draftDates.start}
                aria-invalid={dateError?.field === 'start'}
                aria-describedby={dateError?.field === 'start' ? 'report-date-error' : undefined}
              />
            </label>
            <label className="form-field">
              End date
              <input
                ref={endInput}
                type="date"
                name="end"
                min={REPORT_COVERAGE_START}
                max={REPORT_TODAY}
                defaultValue={draftDates.end}
                aria-invalid={dateError?.field === 'end'}
                aria-describedby={dateError?.field === 'end' ? 'report-date-error' : undefined}
              />
            </label>
          </div>
          {dateError && (
            <p className="form-error" id="report-date-error" role="alert">
              {dateError.message}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setDatesOpen(false)}
            >
              Cancel
            </button>
            <button type="submit" className="button button-green">
              Apply dates
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Refine your report"
        description="These filters apply to the sample performance data only."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            applyFilters(draftFilters)
            setFiltersOpen(false)
          }}
        >
          <div className="form-grid">
            <label className="form-field">
              Country
              <select
                value={draftFilters.country}
                onChange={(event) =>
                  setDraftFilters({ ...draftFilters, country: event.target.value })
                }
              >
                <option value="all">All countries</option>
                {previewCountries.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Campaign
              <select
                value={draftFilters.campaign}
                disabled={Boolean(link)}
                onChange={(event) =>
                  setDraftFilters({ ...draftFilters, campaign: event.target.value })
                }
              >
                <option value="all">All campaigns</option>
                {previewCampaigns.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Funnel
              <select
                value={draftFilters.funnel}
                disabled={Boolean(link)}
                onChange={(event) =>
                  setDraftFilters({ ...draftFilters, funnel: event.target.value })
                }
              >
                <option value="all">All funnels</option>
                {previewFunnels.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Sub ID
              <input
                value={draftFilters.subId}
                readOnly={Boolean(link)}
                onChange={(event) =>
                  setDraftFilters({ ...draftFilters, subId: event.target.value })
                }
                placeholder="e.g. placement-1"
                maxLength={100}
              />
            </label>
          </div>
          <div className="dialog-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setDraftFilters(scopeLinkFilters(resetDimensions(filters), link))}
            >
              Reset filters
            </button>
            <button className="button button-green" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={reportingInfoOpen}
        onOpenChange={setReportingInfoOpen}
        title="Reporting you can trust"
        description="UTC reporting periods keep your dashboard and payout statements aligned."
      >
        <dl className="definition-list">
          <div>
            <dt>Preliminary</dt>
            <dd>Current activity can change as events arrive and validation completes.</dd>
          </div>
          <div>
            <dt>Reconciled</dt>
            <dd>Provider records have been matched to the internal ledger.</dd>
          </div>
          <div>
            <dt>Finalized</dt>
            <dd>
              The paid statement is locked. Later corrections appear in a new period. This preview
              only allows finalized examples ending before the current payout period.
            </dd>
          </div>
          <div>
            <dt>Unavailable is not zero</dt>
            <dd>
              An em dash means a provider value is unavailable. CSV exports say “Unavailable”. A
              measured period with no activity is zero.
            </dd>
          </div>
        </dl>
        <p className="inline-note">
          Everything in this preview is illustrative. No live sync or reconciliation has run. “This
          year” ends at the sample snapshot, Aug 26, 2026.
        </p>
        <div className="dialog-actions">
          <button
            className="button button-white"
            disabled={state === 'empty' || state === 'partial' || unavailable}
            onClick={() => {
              applyFilters({
                ...filters,
                period: 'custom',
                customStart: '2026-08-03',
                customEnd: '2026-08-16',
              })
              setRequestedStage('finalized')
              setReportingInfoOpen(false)
            }}
          >
            Preview a finalized report
          </button>
        </div>
      </Dialog>
      <Dialog
        open={definition !== null}
        onOpenChange={(open) => {
          if (!open) setDefinition(null)
        }}
        title={definition ? metricDefinitions[definition].label : 'Metric definition'}
        description="How this metric is counted in the partner report."
      >
        <p className="metric-definition-copy">
          {definition && metricDefinitions[definition].definition}
        </p>
        <p className="inline-note">
          Sample data only. Production values will come from validated backend aggregates.
        </p>
      </Dialog>
    </>
  )
}
