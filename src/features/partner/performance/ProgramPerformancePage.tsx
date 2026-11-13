import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatCompact } from '../../../merchant/format'
import { formatMoney } from '../../../merchant/programs'
import { LineChart } from '../../../merchant/ui/Charts'
import { seriesColors } from '../../../merchant/ui/chart-utils'
import { StatusPill } from '../../marketplace/components'
import { marketplaceHash } from '../../marketplace/routing'
import { shortDay } from '../earnings/earnings'
import {
  PERFORMANCE_DAYS,
  axisDay,
  axisMoney,
  changeAgainst,
  changeAmount,
  changeRest,
  channelRows,
  conversionText,
  countText,
  dayAsTime,
  earningsPerClickText,
  performanceErrorMessage,
  periodLine,
  quietLinksLine,
  saleStatus,
  tooltipDay,
} from './performance'
import type {
  PerformanceChannel,
  PerformanceDays,
  PerformanceMoney,
  PerformanceProgram,
  ProgramPerformance,
} from './performance'
import type { ProgramPerformanceHandle } from './useProgramPerformance'
import '../earnings/ProgramEarnings.css'
import '../live/LivePerformance.css'
import './ProgramPerformance.css'

/**
 * A creator's results in the programs they joined: earnings, clicks, sales and the two rates
 * for 7, 30 or 90 days, the same three numbers day by day, where they came from, and the
 * program's money to date.
 *
 * It is the whole Performance page for a creator who has only programs. For a creator who also
 * has a product from before programs (`beside`), it is a section above that product's report,
 * and shows nothing at all where program results do not exist.
 */

/** With more programs than this the picker is a list to choose from instead of a row of names. */
const PROGRAMS_IN_A_ROW = 4

const METRICS = [
  { value: 'clicks', label: 'Clicks' },
  { value: 'sales', label: 'Sales' },
  { value: 'earnings', label: 'Earnings' },
] as const
type Metric = (typeof METRICS)[number]['value']

const DAY_OPTIONS = PERFORMANCE_DAYS.map((days) => ({ value: days, label: `${days} days` }))

export function ProgramPerformancePage({
  performance,
  beside = false,
  notice,
}: {
  /** The results and what was picked, from `useProgramPerformance`. */
  performance: ProgramPerformanceHandle
  /** True when an older product's report follows on the same page. */
  beside?: boolean
  /** Something the dashboard has to say on every page, shown under the heading. */
  notice?: ReactNode
}) {
  const { state, picked, selectProgram, selectDays, retry } = performance
  if (state.status === 'hidden') return null

  const answer = state.status === 'ready' ? state.performance : null
  const program = answer?.program ?? null
  const Title = beside ? 'h2' : 'h1'

  return (
    <section
      className={beside ? 'pp-page pp-beside' : 'pp-page'}
      aria-labelledby="pp-title"
      aria-busy={state.status === 'loading' || (state.status === 'ready' && state.loading)}
    >
      <div className="page-heading pp-heading">
        <div>
          <Title id="pp-title">
            {beside ? (
              'Program results'
            ) : (
              <>
                Performance<span className="heading-dot">.</span>
              </>
            )}
          </Title>
          {answer && program ? (
            <p>
              {program.name} · {periodLine(answer.starts_on, answer.ends_on)}
            </p>
          ) : (
            // With no program the one sentence below says it all.
            !answer && <p>Clicks, sales and earnings from the programs you joined.</p>
          )}
        </div>
        {answer && program && (
          <div className="pp-pickers">
            <ProgramPicker
              programs={answer.programs}
              shown={program}
              value={picked.slug ?? program.slug}
              onChange={selectProgram}
            />
            <Segmented
              label="Days"
              options={DAY_OPTIONS}
              value={picked.days}
              onChange={selectDays}
            />
          </div>
        )}
      </div>

      {notice}

      {state.status === 'loading' && <PerformanceSkeleton />}

      {state.status === 'error' && (
        <div className="panel pp-state" role="alert">
          <h2>Performance did not load</h2>
          <p>{performanceErrorMessage(state.error)}</p>
          {state.error?.code !== 'not_authenticated' && (
            <button type="button" className="pe-btn" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && state.failed && (
        <div className="pp-failed" role="alert">
          <p>
            <strong>That did not load.</strong> {performanceErrorMessage(state.failed)}
          </p>
          {state.failed.code !== 'not_authenticated' && (
            <button type="button" className="pe-btn" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}

      {answer &&
        (program ? (
          <Results
            answer={answer}
            program={program}
            stale={state.status === 'ready' && state.loading}
          />
        ) : (
          <div className="panel pp-state">
            <p>Join a program to see your clicks, sales and earnings here.</p>
            <a className="pe-btn" href={marketplaceHash()}>
              Open the marketplace
            </a>
          </div>
        ))}

      {state.status === 'ready' && state.loading && (
        <p className="pe-sr" role="status">
          Loading your results
        </p>
      )}
    </section>
  )
}

// Pickers -----------------------------------------------------------------------------------

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  /** `title` is the whole label, for one that may be cut short. */
  options: readonly { value: T; label: string; title?: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="performance-segmented pp-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Nothing with one program, a row of names with a few, a list to choose from with many. */
function ProgramPicker({
  programs,
  shown,
  value,
  onChange,
}: {
  programs: readonly PerformanceProgram[]
  shown: PerformanceProgram
  value: string
  onChange: (slug: string) => void
}) {
  // The program on screen is always offered, even if the list somehow leaves it out.
  const options = programs.some((program) => program.slug === shown.slug)
    ? programs
    : [shown, ...programs]
  if (options.length <= 1) return null
  if (options.length <= PROGRAMS_IN_A_ROW)
    return (
      <Segmented
        label="Program"
        options={options.map((program) => ({
          value: program.slug,
          label: program.name,
          title: program.name,
        }))}
        value={value}
        onChange={onChange}
      />
    )
  return (
    <label className="pp-select">
      <span className="pe-sr">Program</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((program) => (
          <option key={program.slug} value={program.slug}>
            {program.name}
          </option>
        ))}
      </select>
    </label>
  )
}

// The results of one program ----------------------------------------------------------------

function Results({
  answer,
  program,
  stale,
}: {
  answer: ProgramPerformance
  program: PerformanceProgram
  /** Another answer is loading: these numbers are about to be replaced. */
  stale: boolean
}) {
  return (
    <div className={stale ? 'pp-results pp-stale' : 'pp-results'}>
      <Figures answer={answer} currency={program.currency} />
      <DailyChart answer={answer} currency={program.currency} />
      <div className="pp-columns">
        <Channels answer={answer} currency={program.currency} />
        <Money answer={answer} program={program} />
      </div>
    </div>
  )
}

function Figure({
  label,
  value,
  lead = false,
  children,
}: {
  label: string
  value: string
  lead?: boolean
  children?: ReactNode
}) {
  return (
    <div className={lead ? 'pp-figure pp-figure-lead' : 'pp-figure'}>
      <dt>{label}</dt>
      <dd className="pp-value">{value}</dd>
      {children && <dd className="pp-sub">{children}</dd>}
    </div>
  )
}

/** "+412 vs prior 30 days", with the part that moved in green when it went up. */
function changeLine(
  current: number,
  previous: number,
  days: PerformanceDays,
  amount: (value: number) => string,
): ReactNode {
  const change = changeAgainst(current, previous)
  if (!change) return null
  const moved = changeAmount(change, amount)
  return (
    <>
      {moved && <span className={`pp-change pp-change-${change.direction}`}>{moved}</span>}
      {moved && ' '}
      {changeRest(change, days)}
    </>
  )
}

function Figures({ answer, currency }: { answer: ProgramPerformance; currency: string }) {
  const { totals, previous, days } = answer
  const money = (minor: number) => formatMoney(minor, currency)
  return (
    <dl className="panel pp-figures">
      <Figure label="Earnings" value={money(totals.earnings_minor)} lead>
        {changeLine(totals.earnings_minor, previous.earnings_minor, days, money)}
      </Figure>
      <Figure label="Clicks" value={countText(totals.clicks)}>
        {changeLine(totals.clicks, previous.clicks, days, countText)}
      </Figure>
      <Figure label="Sales" value={countText(totals.sales)}>
        {changeLine(totals.sales, previous.sales, days, countText)}
      </Figure>
      <Figure label="Conversion rate" value={conversionText(totals.sales, totals.clicks)}>
        Sales ÷ clicks
      </Figure>
      <Figure
        label="Earnings per click"
        value={earningsPerClickText(totals.earnings_minor, totals.clicks, currency)}
      >
        Earnings ÷ clicks
      </Figure>
    </dl>
  )
}

const plural = (value: number, one: string, many: string) =>
  `${countText(value)} ${value === 1 ? one : many}`

/** One number for every day, as a line, with the same days as a table for a screen reader. */
function DailyChart({ answer, currency }: { answer: ProgramPerformance; currency: string }) {
  const [metric, setMetric] = useState<Metric>('clicks')
  const { daily, days } = answer
  const title = `${METRICS.find((option) => option.value === metric)!.label} per day`
  const value = (row: ProgramPerformance['daily'][number]) =>
    metric === 'clicks' ? row.clicks : metric === 'sales' ? row.sales : row.earnings_minor
  const last = daily.length - 1

  return (
    <section className="panel pp-card" aria-labelledby="pp-chart-title">
      <div className="pp-card-head">
        <h2 id="pp-chart-title">{title}</h2>
        <Segmented label="Chart shows" options={METRICS} value={metric} onChange={setMetric} />
      </div>
      <div className="pp-chart">
        <LineChart
          label={`${title}, ${periodLine(answer.starts_on, answer.ends_on)}`}
          height={240}
          series={[
            {
              key: metric,
              label: title,
              color: seriesColors[0],
              // The last day is today, which is not over yet.
              points: daily.map((row, index) => ({
                time: dayAsTime(row.day),
                value: value(row),
                partial: index === last,
              })),
            },
          ]}
          formatX={axisDay}
          formatTooltip={tooltipDay}
          formatValue={(amount) =>
            metric === 'earnings'
              ? formatMoney(amount, currency)
              : metric === 'sales'
                ? plural(amount, 'sale', 'sales')
                : plural(amount, 'click', 'clicks')
          }
          formatTick={
            metric === 'earnings' ? (amount) => axisMoney(amount, currency) : formatCompact
          }
          empty={`No ${metric} in these ${days} days`}
        />
      </div>
      {/* The same days for a screen reader. A table cannot be hidden by its own size. */}
      <div className="pe-sr">
        <table>
          <caption>Clicks, sales and earnings per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Clicks</th>
              <th scope="col">Sales</th>
              <th scope="col">Earnings</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((row) => (
              <tr key={row.day}>
                <th scope="row">{tooltipDay(row.day)}</th>
                <td>{countText(row.clicks)}</td>
                <td>{countText(row.sales)}</td>
                <td>{formatMoney(row.earnings_minor, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ChannelRow({ row, currency }: { row: PerformanceChannel; currency: string }) {
  return (
    <tr>
      <th scope="row">
        {row.name}
        {row.kind === 'none' && <small>Sales we could not tie to a link</small>}
      </th>
      <td className="pp-num" data-label="Clicks">
        {countText(row.clicks)}
      </td>
      <td className="pp-num" data-label="Sales">
        {countText(row.sales)}
      </td>
      <td className="pp-num" data-label="Conversion">
        {conversionText(row.sales, row.clicks)}
      </td>
      <td className="pp-num pp-earned" data-label="Earnings">
        {formatMoney(row.earnings_minor, currency)}
      </td>
      <td className="pp-num" data-label="Per click">
        {earningsPerClickText(row.earnings_minor, row.clicks, currency)}
      </td>
    </tr>
  )
}

/** The links that brought something, in the order of the Links page. */
function Channels({ answer, currency }: { answer: ProgramPerformance; currency: string }) {
  const { rows, quiet } = channelRows(answer.channels)
  const quietLine = quietLinksLine(quiet, rows.length, answer.days)
  return (
    <section className="panel pp-card" aria-labelledby="pp-channels-title">
      <div className="pp-card-head">
        <h2 id="pp-channels-title">By channel</h2>
      </div>
      {rows.length > 0 ? (
        <table className="pp-table" aria-labelledby="pp-channels-title">
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col" className="pp-num">
                Clicks
              </th>
              <th scope="col" className="pp-num">
                Sales
              </th>
              <th scope="col" className="pp-num">
                Conversion
              </th>
              <th scope="col" className="pp-num">
                Earnings
              </th>
              <th scope="col" className="pp-num">
                Per click
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ChannelRow key={row.link_id ?? 'none'} row={row} currency={currency} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="pp-empty">
          {quietLine ?? `No clicks or sales in these ${answer.days} days.`}{' '}
          <a href="#links">Share one of your links</a> to get your first clicks.
        </p>
      )}
      {rows.length > 0 && quietLine && <p className="pp-note">{quietLine}</p>}
    </section>
  )
}

const NO_MONEY: PerformanceMoney = {
  pending_minor: 0,
  approved_minor: 0,
  paying_minor: 0,
  paid_minor: 0,
  next_release_at: null,
}

/** The program's money to date and its latest sales. */
function Money({ answer, program }: { answer: ProgramPerformance; program: PerformanceProgram }) {
  const now = new Date()
  const money = answer.money ?? NO_MONEY
  const amount = (minor: number) => formatMoney(minor, program.currency)
  const holdEnds =
    money.pending_minor > 0 &&
    money.next_release_at &&
    Date.parse(money.next_release_at) > now.getTime()
      ? shortDay(money.next_release_at, now)
      : null
  // What the three figures do not say: when pending money is next released, and what is in a
  // payout that has not arrived.
  const notes = [
    holdEnds && `First hold ends ${holdEnds}`,
    money.paying_minor > 0 && `${amount(money.paying_minor)} is on its way to you`,
  ].filter((note): note is string => Boolean(note))
  return (
    <section className="panel pp-card pp-money" aria-labelledby="pp-money-title">
      <div className="pp-card-head">
        <div>
          <h2 id="pp-money-title">Your money</h2>
          <p>All {program.name} earnings to date.</p>
        </div>
      </div>
      <dl className="pp-money-figures">
        <div>
          <dt>Pending</dt>
          <dd className="pp-value">{amount(money.pending_minor)}</dd>
        </div>
        <div>
          <dt>Approved</dt>
          <dd className="pp-value">{amount(money.approved_minor)}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd className="pp-value">{amount(money.paid_minor)}</dd>
        </div>
      </dl>
      {notes.length > 0 && <p className="pp-note">{notes.join(' · ')}</p>}
      <div className="pp-latest">
        <h3 id="pp-latest-title">Latest sales</h3>
        {answer.latest.length > 0 ? (
          <ul aria-labelledby="pp-latest-title">
            {answer.latest.map((sale, index) => {
              const status = saleStatus(sale.status)
              return (
                <li key={index} className={sale.status === 'reversed' ? 'pp-returned' : undefined}>
                  <span className="pp-latest-what">
                    {sale.paid_at && <>{shortDay(sale.paid_at, now)} · </>}
                    {sale.link_name ?? 'No link'}
                  </span>
                  <span className="pp-latest-amount">{amount(sale.amount_minor)}</span>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="pp-empty">No sales yet.</p>
        )}
      </div>
      <a className="pp-more" href="#payouts">
        See payouts
      </a>
    </section>
  )
}

// Loading -----------------------------------------------------------------------------------

function PerformanceSkeleton() {
  return (
    <div className="pp-results">
      <p className="pe-sr" role="status">
        Loading your results
      </p>
      <div className="panel pp-figures" aria-hidden="true">
        {[150, 90, 70, 80, 80].map((width, index) => (
          <div key={index} className={index === 0 ? 'pp-figure pp-figure-lead' : 'pp-figure'}>
            <span className="pe-bar" style={{ width: 84, height: 14 }} />
            <span className="pe-bar" style={{ width, height: index === 0 ? 38 : 30 }} />
            <span className="pe-bar" style={{ width: 120, height: 14 }} />
          </div>
        ))}
      </div>
      <div className="panel pp-card" aria-hidden="true">
        <span className="pe-bar" style={{ width: 150, height: 22 }} />
        <span className="pe-bar" style={{ width: '100%', height: 240 }} />
      </div>
      <div className="pp-columns" aria-hidden="true">
        <div className="panel pp-card">
          <span className="pe-bar" style={{ width: 120, height: 22 }} />
          <span className="pe-bar" style={{ width: '100%', height: 40 }} />
          <span className="pe-bar" style={{ width: '100%', height: 40 }} />
          <span className="pe-bar" style={{ width: '100%', height: 40 }} />
        </div>
        <div className="panel pp-card">
          <span className="pe-bar" style={{ width: 120, height: 22 }} />
          <span className="pe-bar" style={{ width: '100%', height: 56 }} />
          <span className="pe-bar" style={{ width: '100%', height: 40 }} />
        </div>
      </div>
    </div>
  )
}
