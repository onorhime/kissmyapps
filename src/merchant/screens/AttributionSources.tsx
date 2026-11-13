import { useState } from 'react'
import { ArrowLeft, ChevronRight, Download } from 'lucide-react'
import { api } from '../api'
import type {
  Attribution,
  AttributionModel,
  AttributionSources,
  Project,
  Range,
  SourceRow,
} from '../api'
import { hasApp, sourceHint, sourceInstalls, sourceLabel, totalInstalls } from '../attribution'
import { downloadCsv, toCsv } from '../csv'
import { formatCount, formatPercent, plural } from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { Empty, ErrorNote, Panel, Segmented, Skeleton } from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

const modelOptions: Array<{ value: AttributionModel; label: string }> = [
  { value: 'last', label: 'Last touch' },
  { value: 'first', label: 'First touch' },
]

/** Converters out of the people who came; a dash when nobody came in the range. */
function rate(row: Pick<SourceRow, 'converters' | 'people'>): string {
  return row.people ? formatPercent(row.converters, row.people) : '—'
}

export function SourcesScreen({ project, view }: { project: Project; view?: Attribution }) {
  // Installs only mean something for a project with an app.
  const apps = hasApp(project, view?.settings ?? null)
  const [range, setRange] = useState<Range>('30d')
  const [model, setModel] = useState<AttributionModel>('last')
  // A source opened to see its campaigns; null lists every source.
  const [source, setSource] = useState<string | null>(null)
  const report = useRpc(`attribution-sources:${project.id}:${range}:${model}:${source ?? ''}`, () =>
    api.attributionSources(project.id, range, model, source),
  )
  const data = report.data
  const totals = data?.totals
  const noConversions = data ? data.conversion_events.length === 0 : false
  const name = (key: string | null) => (source ? (key ?? 'No campaign') : sourceLabel(key))

  const exportCsv = (sources: AttributionSources) => {
    downloadCsv(
      `${project.name}-${source ? `${source}-campaigns` : 'sources'}-${range}-${model}.csv`,
      toCsv(
        sources.rows.map((row) => ({
          [source ? 'campaign' : 'source']: row.key ?? (source ? '' : 'direct'),
          link_clicks: row.clicks,
          ...(apps ? { installs: sourceInstalls(row) } : {}),
          visits: row.visits,
          people: row.people,
          conversions: row.conversions,
          people_converted: row.converters,
        })),
      ),
    )
  }

  return (
    <>
      <div className="mc-toolbar">
        <Segmented label="Date range" value={range} onChange={setRange} options={rangeOptions} />
        <Segmented label="Credit" value={model} onChange={setModel} options={modelOptions} />
        <button
          type="button"
          className="mc-btn mc-btn-secondary mc-toolbar-end"
          disabled={!data?.rows.length}
          onClick={() => data && exportCsv(data)}
        >
          <Download size={16} aria-hidden="true" /> Export CSV
        </button>
      </div>

      {report.error && (
        <ErrorNote
          message={`Couldn't load sources. ${report.error}`}
          onRetry={() => void report.refresh()}
        />
      )}

      {noConversions && (
        <p className="mc-attr-callout">
          No event counts as a conversion yet, so only clicks and visits show.{' '}
          <a
            className="mc-link"
            href={href({ name: 'attribution', projectId: project.id, section: 'settings' })}
          >
            Choose your conversion events in Settings
          </a>
          , such as a sign-up or a purchase.
        </p>
      )}

      <div
        className={apps ? 'mc-kpis mc-kpis-5' : 'mc-kpis mc-kpis-4'}
        role="group"
        aria-label={source ? `${sourceLabel(source)} totals` : 'Totals'}
      >
        <div className="mc-kpi">
          <span className="mc-kpi-label">Link clicks</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.clicks) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">on your smart links</span>
        </div>
        {apps && (
          <div className="mc-kpi">
            <span className="mc-kpi-label">Installs</span>
            <strong className="mc-kpi-value mc-num">
              {data ? formatCount(totalInstalls(data)) : <Skeleton width={60} height={28} />}
            </strong>
            <span className="mc-sub">of your app</span>
          </div>
        )}
        <div className="mc-kpi">
          <span className="mc-kpi-label">Visits</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.visits) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {totals ? `by ${plural(totals.people, 'person', 'people')}` : ''}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Conversions</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.conversions) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {totals && !noConversions ? `by ${plural(totals.converters, 'person', 'people')}` : ''}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Conversion rate</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? noConversions ? '—' : rate(totals) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">of people who came</span>
        </div>
      </div>

      <Panel
        title={source ? `Campaigns from ${sourceLabel(source)}` : 'Sources'}
        description={
          source
            ? `${sourceLabel(source)}'s ${apps ? 'installs, visits' : 'visits'} and conversions ${rangePhrase[range]}, by campaign.`
            : apps
              ? `Where installs and visitors came from ${rangePhrase[range]}, and the conversions each source earned.`
              : `Where visitors came from ${rangePhrase[range]}, and the conversions each source earned.`
        }
        id="mc-attr-sources"
        actions={
          source ? (
            <button type="button" className="mc-btn mc-btn-quiet" onClick={() => setSource(null)}>
              <ArrowLeft size={16} aria-hidden="true" /> All sources
            </button>
          ) : undefined
        }
        flush
      >
        {data && data.rows.length === 0 ? (
          <Empty>
            {source
              ? `Nothing from ${sourceLabel(source)} ${rangePhrase[range]}.`
              : `No ${apps ? 'installs or visits' : 'visits'} ${rangePhrase[range]} yet. Share a link, or tag your ads with utm_source, and ${apps ? 'people' : 'visitors'} show here by where they came from.`}
          </Empty>
        ) : (
          <table
            className={
              apps
                ? 'mc-table mc-attr-sources-table mc-at2-sources'
                : 'mc-table mc-attr-sources-table'
            }
          >
            <thead>
              <tr>
                <th scope="col">{source ? 'Campaign' : 'Source'}</th>
                <th scope="col" className="mc-num-col">
                  Link clicks
                </th>
                {apps && (
                  <th scope="col" className="mc-num-col">
                    Installs
                  </th>
                )}
                <th scope="col" className="mc-num-col">
                  Visits
                </th>
                <th scope="col" className="mc-num-col">
                  People
                </th>
                <th scope="col" className="mc-num-col">
                  Conversions
                </th>
                <th scope="col" className="mc-num-col">
                  Conversion rate
                </th>
              </tr>
            </thead>
            <tbody>
              {!data &&
                [0, 1, 2, 3].map((index) => (
                  <tr key={index} aria-hidden="true">
                    {[140, ...Array<number>(apps ? 6 : 5).fill(40)].map((width, cell) => (
                      <td key={cell}>
                        <Skeleton width={width} />
                      </td>
                    ))}
                  </tr>
                ))}
              {data?.rows.map((row) => {
                const hint = source ? null : sourceHint(row.key)
                const key = row.key
                return (
                  <tr key={key ?? '(none)'}>
                    <td data-label={source ? 'Campaign' : 'Source'}>
                      {!source && key !== null ? (
                        <button
                          type="button"
                          className="mc-attr-drill"
                          onClick={() => setSource(key)}
                          aria-label={`${sourceLabel(key)}: see its campaigns`}
                        >
                          <span className="mc-truncate">{name(key)}</span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className={key === null ? 'mc-muted' : undefined}>{name(key)}</span>
                      )}
                      {hint && <span className="mc-sub">{hint}</span>}
                    </td>
                    <td data-label="Link clicks" className="mc-num mc-num-col">
                      {formatCount(row.clicks)}
                    </td>
                    {apps && (
                      <td data-label="Installs" className="mc-num mc-num-col">
                        {formatCount(sourceInstalls(row))}
                      </td>
                    )}
                    <td data-label="Visits" className="mc-num mc-num-col">
                      {formatCount(row.visits)}
                    </td>
                    <td data-label="People" className="mc-num mc-num-col">
                      {formatCount(row.people)}
                    </td>
                    <td data-label="Conversions" className="mc-num mc-num-col">
                      {formatCount(row.conversions)}
                    </td>
                    <td data-label="Conversion rate" className="mc-num mc-num-col">
                      {noConversions ? '—' : rate(row)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <HowCreditWorks model={model} days={data?.web_lookback_days ?? 30} apps={apps} />
    </>
  )
}

function HowCreditWorks({
  model,
  days,
  apps,
}: {
  model: AttributionModel
  days: number
  apps: boolean
}) {
  return (
    <section className="mc-panel" aria-labelledby="mc-attr-credit">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-attr-credit">How conversions are credited</h2>
        </div>
      </div>
      <ul className="mc-attr-explain">
        <li>
          <strong>{model === 'last' ? 'Last touch' : 'First touch'}</strong>
          <span className="mc-muted">
            {model === 'last'
              ? `Each conversion goes to the latest source the person came from in the ${plural(days, 'day')} before it.`
              : 'Each conversion goes to the first source the person ever came from.'}{' '}
            Once someone signs in, visits from all their devices count, so a tap on a phone can earn
            a sign-up on a laptop.
          </span>
        </li>
        {apps && (
          <li>
            <strong>App installs</strong>
            <span className="mc-muted">
              An install counts once, for the click that brought it: the link that opened the app,
              the click Google Play passes on, an Apple Ads tap, the click a link&rsquo;s iPhone
              page copied, or a link tapped on the web by the same person before they signed in. A
              reinstall on the same phone is not a new install, and installs with no link count
              under Direct or unknown.
            </span>
          </li>
        )}
        <li>
          <strong>What a source is</strong>
          <span className="mc-muted">
            In order: one of your links; the utm_source on the page address; an ad's click ID
            (gclid, fbclid, ttclid or msclkid); then the site that sent them. Your own sites, and
            people coming back from checkout or sign-in, are not sources.
          </span>
        </li>
        <li>
          <strong>Direct or unknown</strong>
          <span className="mc-muted">
            No link, tag or referring site: a typed address, a bookmark, or an app such as WhatsApp
            that hides where a tap came from. Use a link for each place you share to see them.
          </span>
        </li>
      </ul>
    </section>
  )
}
