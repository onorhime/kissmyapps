import { useState } from 'react'
import { ChevronRight, Download, Hourglass, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { Attribution, MoneyRange, Project, RoiMetrics, RoiReport, RoiRow } from '../api'
import { hasApp, sourceHint } from '../attribution'
import { downloadCsv, toCsv } from '../csv'
import { formatCount, plural } from '../format'
import { rangePhrase } from '../ranges'
import {
  filtersFor,
  formatMoney,
  formatMoneyTick,
  formatMoneyTile,
  formatRatio,
  groupFor,
  levelFor,
  levelNouns,
  moneyRangeOptions,
  plainDate,
  roiKeyLabel,
  unconvertedNote,
} from '../roi'
import type { RoiLevel } from '../roi'
import { href } from '../routes'
import { LineChart } from '../ui/Charts'
import { seriesColors } from '../ui/chart-utils'
import { Empty, ErrorNote, Panel, Segmented, Skeleton } from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

type Path = Array<string | null>

/** The last answer stays on screen, dimmed, while the next one loads; with the path it was for. */
function useKept<T>(data: T | undefined, path: Path) {
  const [kept, setKept] = useState<{ data: T; path: Path }>()
  if (data !== undefined && kept?.data !== data) setKept({ data, path })
  if (data !== undefined) return { data, path, stale: false }
  return { data: kept?.data, path: kept?.path ?? path, stale: Boolean(kept) }
}

/** A figure worked out from spend means nothing while no spend is entered for the row. */
function fromSpend(row: RoiMetrics, value: number | null, currency: string): string {
  return row.cost > 0 && value !== null ? formatMoney(value, currency) : '—'
}

function roasCell(row: RoiMetrics, value: number | null): string {
  return row.cost > 0 ? formatRatio(value) : '—'
}

export function RoiScreen({ project, view }: { project: Project; view: Attribution }) {
  const apps = hasApp(project, view.settings)
  const [range, setRange] = useState<MoneyRange>('30d')
  // The rows opened: [] lists sources, [source] its campaigns, and so on to ads.
  const [path, setPath] = useState<Path>([])
  const filters = filtersFor(path)
  const key = JSON.stringify([project.id, range, path])
  const table = useRpc(`attribution-roi:${key}`, () =>
    api.attributionRoi(project.id, { range, group: groupFor(path), ...filters }),
  )
  const byDay = useRpc(`attribution-roi-days:${key}`, () =>
    api.attributionRoi(project.id, { range, group: 'day', ...filters }),
  )
  const shown = useKept(table.data, path)
  const report = shown.data
  const level = levelFor(shown.path)
  const nothing =
    report && !shown.path.length && !report.has_costs && !report.has_revenue && !report.totals.users
  const currency = report?.currency ?? view.settings?.currency ?? 'USD'
  const scope = path.length ? roiKeyLabel(levelFor(path.slice(0, -1)), path.at(-1) ?? null) : null

  const exportCsv = (answer: RoiReport) => {
    const money = currency.toLowerCase()
    const parents = shown.path.map((value, index) => [
      levelFor(shown.path.slice(0, index)),
      value ?? '',
    ])
    downloadCsv(
      `${project.name}-roi-${[...shown.path.map((value) => value ?? 'none'), level].join('-')}-${range}.csv`,
      toCsv(
        answer.rows.map((row) => ({
          ...Object.fromEntries(parents),
          [level]: row.key ?? (level === 'source' ? 'direct' : ''),
          people: row.users,
          ...(apps ? { installs: row.installs } : {}),
          [`spend_${money}`]: row.cost,
          [apps ? `cpi_${money}` : `cost_per_person_${money}`]:
            (apps ? row.cpi : row.cost_per_user) ?? '',
          paying_people: row.payers,
          [`revenue_${money}`]: row.revenue,
          [`revenue_d0_${money}`]: row.revenue_d0,
          [`revenue_d7_${money}`]: row.revenue_d7,
          [`revenue_d30_${money}`]: row.revenue_d30,
          roas_d0: row.roas_d0 ?? '',
          roas_d7: row.roas_d7 ?? '',
          roas_d30: row.roas_d30 ?? '',
          roas: row.roas ?? '',
        })),
      ),
    )
  }

  return (
    <>
      <div className="mc-toolbar">
        <Segmented
          label="Date range"
          value={range}
          onChange={setRange}
          options={moneyRangeOptions}
        />
        <button
          type="button"
          className="mc-btn mc-btn-secondary mc-toolbar-end"
          disabled={!report?.rows.length || shown.stale}
          onClick={() => report && exportCsv(report)}
        >
          <Download size={16} aria-hidden="true" /> Export CSV
        </button>
      </div>

      {path.length > 0 && <Crumbs path={path} onOpen={setPath} />}

      {table.error && (
        <ErrorNote
          message={`Couldn't load ROI. ${table.error}`}
          onRetry={() => void table.refresh()}
        />
      )}

      {nothing ? (
        <StartHere project={project} range={range} />
      ) : (
        <div className={shown.stale ? 'mc-at3-body is-stale' : 'mc-at3-body'}>
          {report && <Missing project={project} report={report} />}
          <Tiles report={report} apps={apps} scope={scope} />
          {report && <Unconverted report={report} />}
          <Panel
            title="Spend and revenue by day"
            description={`Spend on each day, and what the people who arrived that day have paid since${scope ? `, from ${scope}` : ''}. Today is still going.`}
            id="mc-at3-roi-chart"
          >
            <DayChart
              report={byDay.data}
              error={byDay.error}
              currency={currency}
              range={range}
              onRetry={() => void byDay.refresh()}
            />
          </Panel>
          <RoiTable
            report={report}
            path={shown.path}
            apps={apps}
            range={range}
            onOpen={(value) => setPath([...shown.path, value])}
          />
        </div>
      )}

      <HowRoiWorks currency={currency} />
    </>
  )
}

function Crumbs({ path, onOpen }: { path: Path; onOpen: (path: Path) => void }) {
  return (
    <nav className="mc-at3-crumbs" aria-label="Where you are in the report">
      <ol>
        <li>
          <button type="button" className="mc-attr-drill" onClick={() => onOpen([])}>
            All sources
          </button>
        </li>
        {path.map((value, index) => {
          const name = roiKeyLabel(levelFor(path.slice(0, index)), value)
          const last = index === path.length - 1
          return (
            <li key={`${index}:${value ?? ''}`}>
              <ChevronRight size={14} aria-hidden="true" />
              {last ? (
                <span aria-current="page" className="mc-truncate">
                  {name}
                </span>
              ) : (
                <button
                  type="button"
                  className="mc-attr-drill"
                  onClick={() => onOpen(path.slice(0, index + 1))}
                >
                  <span className="mc-truncate">{name}</span>
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Tiles({
  report,
  apps,
  scope,
}: {
  report: RoiReport | undefined
  apps: boolean
  scope: string | null
}) {
  const totals = report?.totals
  const currency = report?.currency ?? 'USD'
  const perInstall = Boolean(totals && apps && totals.installs > 0)
  const value = (render: (metrics: RoiMetrics) => string) =>
    totals ? render(totals) : <Skeleton width={72} height={28} />
  return (
    <div
      className="mc-kpis mc-kpis-5"
      role="group"
      aria-label={scope ? `${scope} totals` : 'Totals'}
    >
      <div className="mc-kpi">
        <span className="mc-kpi-label">Spend</span>
        <strong className="mc-kpi-value">
          {value((metrics) => formatMoneyTile(metrics.cost, currency))}
        </strong>
        <span className="mc-sub">
          {report ? (report.has_costs ? 'Ads and creator deals' : 'None added yet') : ''}
        </span>
      </div>
      <div className="mc-kpi">
        <span className="mc-kpi-label">Revenue</span>
        <strong className="mc-kpi-value">
          {value((metrics) => formatMoneyTile(metrics.revenue, currency))}
        </strong>
        <span className="mc-sub">
          {totals ? `From ${plural(totals.users, 'new person', 'new people')}` : ''}
        </span>
      </div>
      <div className="mc-kpi">
        <span className="mc-kpi-label">ROAS to date</span>
        <strong className="mc-kpi-value">
          {value((metrics) => (metrics.cost > 0 ? formatRatio(metrics.roas) : '—'))}
        </strong>
        <span className="mc-sub">
          {totals && report ? (
            <>
              Day 7: {totals.cost > 0 ? formatRatio(totals.roas_d7) : '—'}
              {!report.complete.d7 && totals.cost > 0 && <Filling day={7} />}
            </>
          ) : (
            ''
          )}
        </span>
      </div>
      <div className="mc-kpi">
        <span className="mc-kpi-label">
          {perInstall ? 'Cost per install' : 'Cost per new person'}
        </span>
        <strong className="mc-kpi-value">
          {value((metrics) =>
            fromSpend(metrics, perInstall ? metrics.cpi : metrics.cost_per_user, currency),
          )}
        </strong>
        <span className="mc-sub">
          {totals
            ? perInstall
              ? plural(totals.installs, 'install')
              : plural(totals.users, 'new person', 'new people')
            : ''}
        </span>
      </div>
      <div className="mc-kpi">
        <span className="mc-kpi-label">Paying people</span>
        <strong className="mc-kpi-value mc-num">
          {value((metrics) => formatCount(metrics.payers))}
        </strong>
        <span className="mc-sub">
          {totals
            ? totals.cost > 0 && totals.cost_per_payer !== null
              ? `${formatMoney(totals.cost_per_payer, currency)} of spend each`
              : totals.payers
                ? 'No spend to divide'
                : 'Nobody has paid yet'
            : ''}
        </span>
      </div>
    </div>
  )
}

/** The mark on a day that some people have not reached yet. */
function Filling({ day }: { day: number }) {
  return (
    <span
      className="mc-at3-filling"
      title={`Still filling: some people have not reached day ${day}`}
    >
      <Hourglass size={12} aria-hidden="true" />
      <span className="sr-only">, still filling</span>
    </span>
  )
}

function DayChart({
  report,
  error,
  currency,
  range,
  onRetry,
}: {
  report: RoiReport | undefined
  error: string | null
  currency: string
  range: MoneyRange
  onRetry: () => void
}) {
  if (error && !report)
    return <ErrorNote message={`Couldn't load the days. ${error}`} onRetry={onRetry} />
  if (!report) return <div className="mc-chart" style={{ height: 240 }} aria-hidden="true" />
  const days = report.rows.filter((row) => row.key !== null)
  const last = days.length - 1
  const point = (row: RoiRow, index: number, value: number) => ({
    time: Date.parse(`${row.key}T00:00:00Z`),
    value,
    partial: index === last,
  })
  const byTime = new Map(days.map((row) => [Date.parse(`${row.key}T00:00:00Z`), row]))
  const money = (value: number) => formatMoney(value, currency)
  return (
    <>
      <div className="mc-legend" aria-hidden="true">
        <span>
          <i style={{ background: seriesColors[0] }} /> Revenue
        </span>
        <span>
          <i style={{ background: seriesColors[1] }} /> Spend
        </span>
      </div>
      <LineChart
        label={`Spend and revenue by day ${rangePhrase[range]}`}
        height={240}
        area={false}
        integers={false}
        series={[
          {
            key: 'revenue',
            label: 'Revenue',
            color: seriesColors[0],
            points: days.map((row, index) => point(row, index, row.revenue)),
          },
          {
            key: 'spend',
            label: 'Spend',
            color: seriesColors[1],
            points: days.map((row, index) => point(row, index, row.cost)),
          },
        ]}
        formatX={(time) => plainDate(new Date(time).toISOString().slice(0, 10))}
        formatTooltip={(time) => {
          const row = byTime.get(time)
          const day = plainDate(new Date(time).toISOString().slice(0, 10), 'weekday')
          return row ? `${day}: ${plural(row.users, 'new person', 'new people')}` : day
        }}
        formatValue={money}
        formatTick={(value) => formatMoneyTick(value, currency)}
        empty={`No spend or revenue ${rangePhrase[range]} yet`}
      />
    </>
  )
}

function RoiTable({
  report,
  path,
  apps,
  range,
  onOpen,
}: {
  report: RoiReport | undefined
  path: Path
  apps: boolean
  range: MoneyRange
  onOpen: (value: string) => void
}) {
  const level = levelFor(path)
  const noun = levelNouns[level]
  const parent = path.length ? roiKeyLabel(levelFor(path.slice(0, -1)), path.at(-1) ?? null) : null
  const currency = report?.currency ?? 'USD'
  const canOpen = (key: string | null): key is string => key !== null && level !== 'ad'
  const next: RoiLevel | null =
    level === 'source'
      ? 'campaign'
      : level === 'campaign'
        ? 'adset'
        : level === 'adset'
          ? 'ad'
          : null
  const d7 = report ? !report.complete.d7 : false
  const d30 = report ? !report.complete.d30 : false
  const columns = 9 + (apps ? 1 : 0)
  return (
    <Panel
      title={parent ? `${noun.title}s in ${parent}` : 'By source'}
      description={
        parent
          ? `What ${parent} spent and earned back ${rangePhrase[range]}, by ${noun.one}.`
          : `What each source spent and earned back ${rangePhrase[range]}. Choose a source to see its campaigns.`
      }
      id="mc-at3-roi-table"
      flush
    >
      {report && report.rows.length === 0 ? (
        <Empty>
          {parent
            ? `Nothing from ${parent} ${rangePhrase[range]}.`
            : `Nobody arrived and nothing was spent ${rangePhrase[range]}.`}
        </Empty>
      ) : (
        <div className="mc-at3-table-frame">
          <table
            className={apps ? 'mc-table mc-at3-roi-table is-apps' : 'mc-table mc-at3-roi-table'}
          >
            <thead>
              <tr>
                <th scope="col">{noun.title}</th>
                <th scope="col" className="mc-num-col">
                  People
                </th>
                {apps && (
                  <th scope="col" className="mc-num-col">
                    Installs
                  </th>
                )}
                <th scope="col" className="mc-num-col">
                  Spend
                </th>
                <th scope="col" className="mc-num-col">
                  {apps ? 'CPI' : 'Cost per person'}
                </th>
                <th scope="col" className="mc-num-col">
                  Paying
                </th>
                <th scope="col" className="mc-num-col">
                  Revenue
                </th>
                <th scope="col" className="mc-num-col">
                  ROAS D0
                </th>
                <th scope="col" className="mc-num-col">
                  ROAS D7{d7 && <Filling day={7} />}
                </th>
                <th scope="col" className="mc-num-col">
                  ROAS D30{d30 && <Filling day={30} />}
                </th>
                <th scope="col" className="mc-num-col">
                  ROAS to date
                </th>
              </tr>
            </thead>
            <tbody>
              {!report &&
                [0, 1, 2, 3].map((index) => (
                  <tr key={index} aria-hidden="true">
                    {[140, ...Array<number>(columns).fill(44)].map((width, cell) => (
                      <td key={cell}>
                        <Skeleton width={width} />
                      </td>
                    ))}
                  </tr>
                ))}
              {report?.rows.map((row) => {
                const name = roiKeyLabel(level, row.key)
                const hint = level === 'source' && row.key !== null ? sourceHint(row.key) : null
                return (
                  <tr key={row.key ?? '(none)'}>
                    <td data-label={noun.title}>
                      {canOpen(row.key) && next ? (
                        <button
                          type="button"
                          className="mc-attr-drill"
                          onClick={() => onOpen(row.key as string)}
                          aria-label={`${name}: see its ${levelNouns[next].one}s`}
                        >
                          <span className="mc-truncate">{name}</span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className={row.key === null ? 'mc-muted' : 'mc-truncate'}>
                          {name}
                        </span>
                      )}
                      {hint && <span className="mc-sub">{hint}</span>}
                    </td>
                    <td data-label="People" className="mc-num mc-num-col">
                      {formatCount(row.users)}
                    </td>
                    {apps && (
                      <td data-label="Installs" className="mc-num mc-num-col">
                        {formatCount(row.installs)}
                      </td>
                    )}
                    <td data-label="Spend" className="mc-num mc-num-col">
                      {row.cost > 0 ? formatMoney(row.cost, currency) : '—'}
                    </td>
                    <td data-label={apps ? 'CPI' : 'Cost per person'} className="mc-num mc-num-col">
                      {fromSpend(row, apps ? row.cpi : row.cost_per_user, currency)}
                    </td>
                    <td data-label="Paying" className="mc-num mc-num-col">
                      {formatCount(row.payers)}
                    </td>
                    <td data-label="Revenue" className="mc-num mc-num-col">
                      {formatMoney(row.revenue, currency)}
                    </td>
                    <td data-label="ROAS D0" className="mc-num mc-num-col">
                      {roasCell(row, row.roas_d0)}
                    </td>
                    <td
                      data-label={d7 ? 'ROAS D7, still filling' : 'ROAS D7'}
                      className={d7 ? 'mc-num mc-num-col is-filling' : 'mc-num mc-num-col'}
                    >
                      {roasCell(row, row.roas_d7)}
                    </td>
                    <td
                      data-label={d30 ? 'ROAS D30, still filling' : 'ROAS D30'}
                      className={d30 ? 'mc-num mc-num-col is-filling' : 'mc-num mc-num-col'}
                    >
                      {roasCell(row, row.roas_d30)}
                    </td>
                    <td data-label="ROAS to date" className="mc-num mc-num-col">
                      <strong>{roasCell(row, row.roas)}</strong>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {(d7 || d30) && report && report.rows.length > 0 && (
        <p className="mc-at3-table-note mc-muted">
          <Hourglass size={12} aria-hidden="true" /> Still filling: some people here arrived less
          than {d30 && !d7 ? '30' : d7 && !d30 ? '7' : '7 or 30'} days ago, so the figure can still
          grow. A dash means no spend is added for that row.
        </p>
      )}
    </Panel>
  )
}

/** Says what is missing for ROI to mean something, with where to add it. */
function Missing({ project, report }: { project: Project; report: RoiReport }) {
  if (report.has_costs && report.has_revenue) return null
  const settings = href({ name: 'attribution', projectId: project.id, section: 'settings' })
  const setup = href({ name: 'attribution', projectId: project.id, section: 'setup' })
  const costs = href({ name: 'attribution', projectId: project.id, section: 'costs' })
  return (
    <div className="mc-attr-callout mc-at3-callout">
      {!report.has_revenue && (
        <p>
          No revenue has arrived yet, so revenue and ROAS show nothing.{' '}
          <a className="mc-link" href={setup}>
            Send payments with the SDK&rsquo;s revenue call
          </a>
          , or{' '}
          <a className="mc-link" href={settings}>
            name the payment event your app already sends in Settings
          </a>
          .
        </p>
      )}
      {!report.has_costs && (
        <p>
          No spend is added yet, so spend, cost per install and ROAS are empty.{' '}
          <a className="mc-link" href={costs}>
            Add what you spent in Costs
          </a>
          , typed in or from a spreadsheet.
        </p>
      )}
    </div>
  )
}

function StartHere({ project, range }: { project: Project; range: MoneyRange }) {
  const to = (section: 'links' | 'setup' | 'costs') =>
    href({ name: 'attribution', projectId: project.id, section })
  return (
    <section className="mc-panel" aria-labelledby="mc-at3-roi-start">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-at3-roi-start">Nothing to count {rangePhrase[range]} yet</h2>
          <p>Return on ad spend needs three things. Each one can be set up now.</p>
        </div>
      </div>
      <ol className="mc-attr-how mc-at3-start">
        <li>
          <strong>People who arrive from a source</strong>
          <span className="mc-muted">
            <a className="mc-link" href={to('links')}>
              Share a link
            </a>{' '}
            or tag your ads with utm_source, so each person is credited to where they came from.
          </span>
        </li>
        <li>
          <strong>What they pay</strong>
          <span className="mc-muted">
            <a className="mc-link" href={to('setup')}>
              Track revenue
            </a>{' '}
            with the SDK&rsquo;s revenue call, or connect RevenueCat or Adapty.
          </span>
        </li>
        <li>
          <strong>What you spent</strong>
          <span className="mc-muted">
            <a className="mc-link" href={to('costs')}>
              Add your spend
            </a>{' '}
            for each day and campaign, or a price per install for a creator&rsquo;s link.
          </span>
        </li>
      </ol>
    </section>
  )
}

function Unconverted({ report }: { report: RoiReport }) {
  const note = unconvertedNote(report.unconverted)
  if (!note) return null
  return (
    <p className="mc-warning-text mc-attr-warning">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{note}</span>
    </p>
  )
}

function HowRoiWorks({ currency }: { currency: string }) {
  return (
    <section className="mc-panel" aria-labelledby="mc-at3-roi-how">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-at3-roi-how">How ROI is counted</h2>
        </div>
      </div>
      <ul className="mc-attr-explain">
        <li>
          <strong>Each person once</strong>
          <span className="mc-muted">
            A person counts on the day we first saw them, on your website or in your app, and is
            credited to the first source we know for them: a link, an ad tag or the store&rsquo;s
            install referrer. With none, they are Direct and organic. Someone who paid on your
            website and installed the app later counts once, from that first visit.
          </span>
        </li>
        <li>
          <strong>Revenue</strong>
          <span className="mc-muted">
            Everything they have paid since they arrived, in {currency} at the European Central
            Bank&rsquo;s rate for each day. Refunds subtract. Day 0, 7 and 30 count what was paid by
            the end of that day after they arrived.
          </span>
        </li>
        <li>
          <strong>Spend</strong>
          <span className="mc-muted">
            What you added in Costs for each day, plus link prices. Spend meets people by source and
            campaign name, so name them the same in both: spend for meta meets people from facebook
            and instagram.
          </span>
        </li>
        <li>
          <strong>ROAS</strong>
          <span className="mc-muted">
            Revenue divided by spend. 100% means the people a source brought have paid back what it
            cost.
          </span>
        </li>
      </ul>
    </section>
  )
}
