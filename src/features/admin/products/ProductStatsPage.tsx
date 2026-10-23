import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  Clock3,
  Link2,
  LoaderCircle,
  MousePointerClick,
  Percent,
  RefreshCw,
  Repeat,
  Settings2,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react'
import type {
  AdminAttributionOverview,
  AdminContext,
  AdminGateway,
  AdminProductConfiguration,
} from '../api'
import type { AdminSubscriptionPage } from '../api/subscriptions'
import {
  formatAdminCount,
  formatAdminOperationalTimestamp,
} from '../observability/observabilityPresentation'
import { useAttributionOverview } from '../observability/useObservability'
import { setupProgress, setupSteps } from '../configuration/setupSteps'
import './ProductStats.css'

export type ProductStatsPageProps = Readonly<{
  productId: string
  context: AdminContext
  gateway: AdminGateway
  onBack: () => void
  onOpenSetup: () => void
  onOpenSubscriptions?: () => void
}>

const ranges = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const

type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'unavailable'; message: string }

function percent(part: number, whole: number): string {
  if (!whole) return '—'
  const value = (part / whole) * 100
  return `${value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)}%`
}

function displayEnum(value: string): string {
  return value
    .split(/[_.]/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function useProductConfigurationRead(gateway: AdminGateway, productId: string, version: number) {
  const [state, setState] = useState<{
    key: string
    value: Loadable<AdminProductConfiguration>
  } | null>(null)
  const key = `${productId}:${version}`
  useEffect(() => {
    const read = gateway.getProductConfiguration
    if (!read) return
    let active = true
    void read(productId)
      .then((result) => {
        if (!active) return
        setState({
          key,
          value:
            result.status === 'ready' && result.data
              ? { status: 'ready', data: result.data }
              : {
                  status: 'unavailable',
                  message: result.error?.message ?? 'This product could not be loaded.',
                },
        })
      })
      .catch(() => {
        if (active)
          setState({
            key,
            value: { status: 'unavailable', message: 'This product could not be loaded.' },
          })
      })
    return () => {
      active = false
    }
  }, [gateway, key, productId])
  if (!gateway.getProductConfiguration)
    return {
      status: 'unavailable',
      message: 'Product reads are not available in this deployment.',
    } as const
  return state?.key === key ? state.value : ({ status: 'loading' } as const)
}

function useSubscriptionSummary(
  gateway: AdminGateway,
  productId: string,
  allowed: boolean,
  version: number,
) {
  const [state, setState] = useState<{
    key: string
    value: Loadable<AdminSubscriptionPage>
  } | null>(null)
  const key = `${productId}:${version}`
  useEffect(() => {
    const read = gateway.getSubscriptions
    if (!read || !allowed) return
    let active = true
    void read({ productId, limit: 1, offset: 0 })
      .then((result) => {
        if (!active) return
        setState({
          key,
          value:
            result.status === 'ready' && result.data
              ? { status: 'ready', data: result.data }
              : {
                  status: 'unavailable',
                  message: result.error?.message ?? 'Subscriptions could not be loaded.',
                },
        })
      })
      .catch(() => {
        if (active)
          setState({
            key,
            value: { status: 'unavailable', message: 'Subscriptions could not be loaded.' },
          })
      })
    return () => {
      active = false
    }
  }, [allowed, gateway, key, productId])
  if (!gateway.getSubscriptions || !allowed)
    return {
      status: 'unavailable',
      message: allowed
        ? 'Subscription reporting is not available in this deployment.'
        : 'Your role cannot view subscriptions.',
    } as const
  return state?.key === key ? state.value : ({ status: 'loading' } as const)
}

function StatTile({
  icon: Icon,
  label,
  value,
  detail,
  explain,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail?: string
  explain: string
}) {
  return (
    <article className="admin-stats-tile">
      <header>
        <span className="admin-stats-tile-icon">
          <Icon size={17} aria-hidden="true" />
        </span>
        <h3>{label}</h3>
      </header>
      <strong>{value}</strong>
      {detail && <span className="admin-stats-tile-detail">{detail}</span>}
      <p>{explain}</p>
    </article>
  )
}

function SectionHeading({
  id,
  title,
  explain,
  action,
}: {
  id: string
  title: string
  explain: string
  action?: ReactNode
}) {
  return (
    <header className="admin-stats-section-heading">
      <div>
        <h2 id={id}>{title}</h2>
        <p>{explain}</p>
      </div>
      {action}
    </header>
  )
}

function ConversionFunnel({ summary }: { summary: AdminAttributionOverview['summary'] }) {
  const humanClicks = Math.max(summary.clicks - summary.botClicks, 0)
  const stages = [
    {
      label: 'Human clicks',
      value: humanClicks,
      explain: 'People who clicked a partner link (bots removed).',
    },
    {
      label: 'Matched visitors',
      value: summary.resolvedAcquisitions,
      explain: 'Clicks we could tie to a partner and a visitor on your funnel.',
    },
    {
      label: 'Qualified conversions',
      value: summary.qualifiedConversions,
      explain: 'Purchases that count toward partner commission.',
    },
  ]
  const top = Math.max(...stages.map((stage) => stage.value), 1)
  return (
    <ol className="admin-stats-funnel" aria-label="Conversion funnel">
      {stages.map((stage, index) => {
        const previous = index > 0 ? stages[index - 1].value : null
        return (
          <li key={stage.label}>
            <div className="admin-stats-funnel-label">
              <strong>{stage.label}</strong>
              <span>{stage.explain}</span>
            </div>
            <div
              className="admin-stats-funnel-bar"
              title={`${stage.label}: ${formatAdminCount(stage.value)}`}
            >
              <span style={{ width: `${(stage.value / top) * 100}%` }} />
            </div>
            <div className="admin-stats-funnel-value">
              <strong>{formatAdminCount(stage.value)}</strong>
              {previous !== null && <span>{percent(stage.value, previous)} of previous step</span>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function SourceTable({ rows }: { rows: AdminAttributionOverview['breakdown'] }) {
  if (!rows.length)
    return (
      <p className="admin-stats-empty">
        No clicks in this period yet. Sources appear here once partner traffic arrives.
      </p>
    )
  const top = Math.max(...rows.map((row) => row.clicks), 1)
  return (
    <div className="admin-stats-table-wrap">
      <table className="admin-stats-table">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Clicks</th>
            <th scope="col">Matched visitors</th>
            <th scope="col">Conversions</th>
            <th scope="col">Conversion rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sourceId ?? 'none'}:${row.sourceName}`}>
              <th scope="row">{row.sourceName}</th>
              <td>
                <span className="admin-stats-inline-bar" aria-hidden="true">
                  <span style={{ width: `${(row.clicks / top) * 100}%` }} />
                </span>
                {formatAdminCount(row.clicks)}
              </td>
              <td>{formatAdminCount(row.acquisitions)}</td>
              <td>{formatAdminCount(row.qualifiedConversions)}</td>
              <td>{percent(row.qualifiedConversions, row.clicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatsUnavailable({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="admin-stats-unavailable" role="note">
      <CircleAlert size={18} aria-hidden="true" />
      <p>{message}</p>
      {onRetry && (
        <button className="admin-text-button" type="button" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> Try again
        </button>
      )}
    </div>
  )
}

export function ProductStatsPage({
  productId,
  context,
  gateway,
  onBack,
  onOpenSetup,
  onOpenSubscriptions,
}: ProductStatsPageProps) {
  const [days, setDays] = useState<number>(30)
  const [windowEnd, setWindowEnd] = useState(() => new Date())
  const [version, setVersion] = useState(0)
  const reportingAllowed = context.role !== 'support'
  const input = useMemo(
    () => ({
      startsAt: new Date(windowEnd.getTime() - days * 86_400_000).toISOString(),
      endsAt: windowEnd.toISOString(),
      productId,
      limit: 10,
      offset: 0,
    }),
    [days, productId, windowEnd],
  )
  const configuration = useProductConfigurationRead(gateway, productId, version)
  const subscriptions = useSubscriptionSummary(gateway, productId, reportingAllowed, version)
  const { state: attribution, refresh } = useAttributionOverview({ gateway, input })

  function refreshAll() {
    setWindowEnd(new Date())
    setVersion((value) => value + 1)
    refresh()
  }

  const product = configuration.status === 'ready' ? configuration.data.product : null
  const setup =
    configuration.status === 'ready' ? setupProgress(setupSteps(configuration.data)) : null
  const liveLinks =
    configuration.status === 'ready'
      ? configuration.data.mainLinks.filter(
          (link) => link.status === 'active' && (link.environment ?? 'live') === 'live',
        ).length
      : null
  const overview = attribution.status === 'ready' ? attribution.data : null
  const summary = overview?.summary
  const humanClicks = summary ? Math.max(summary.clicks - summary.botClicks, 0) : 0
  const loading = attribution.status === 'loading' || configuration.status === 'loading'

  return (
    <section className="admin-page admin-stats-page" aria-labelledby="admin-product-stats-title">
      <button className="admin-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true" /> Back to Products
      </button>
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">PRODUCT STATS</p>
          <h1 id="admin-product-stats-title">{product?.name ?? 'Product stats'}</h1>
          <p>
            How partner traffic for this product turns into customers. Numbers cover the selected
            period and exclude test links.
          </p>
        </div>
        <div className="admin-stats-heading-actions">
          {product && (
            <span className={`admin-status-badge admin-status-${product.status}`}>
              {product.status}
            </span>
          )}
          <button className="admin-secondary-button" type="button" onClick={onOpenSetup}>
            <Settings2 size={16} aria-hidden="true" /> Open setup
          </button>
        </div>
      </header>

      <div className="admin-stats-toolbar">
        <div className="admin-stats-range" role="group" aria-label="Reporting period">
          {ranges.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-pressed={days === range.days}
              onClick={() => {
                setDays(range.days)
                setWindowEnd(new Date())
              }}
            >
              {range.label}
            </button>
          ))}
        </div>
        <span className="admin-stats-generated" aria-live="polite">
          {loading ? (
            <>
              <LoaderCircle className="admin-spin" size={14} aria-hidden="true" /> Loading stats…
            </>
          ) : overview ? (
            `Updated ${formatAdminOperationalTimestamp(overview.generatedAt)}`
          ) : null}
        </span>
        <button
          className="admin-text-button"
          type="button"
          onClick={refreshAll}
          disabled={attribution.refreshing}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      {configuration.status === 'ready' && setup && setup.complete < setup.total && (
        <div className="admin-inline-notice admin-stats-setup-notice" role="note">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            <strong>
              Setup is {setup.complete} of {setup.total} steps complete.
            </strong>{' '}
            Partners can only send traffic once the product is live and they have a link.
          </p>
          <button className="admin-text-button" type="button" onClick={onOpenSetup}>
            Continue setup
          </button>
        </div>
      )}
      {configuration.status === 'unavailable' && (
        <StatsUnavailable message={configuration.message} onRetry={refreshAll} />
      )}

      {!reportingAllowed ? (
        <StatsUnavailable message="Your role cannot view product reporting. Ask an Owner, Operations, Finance, or Analyst administrator." />
      ) : attribution.status === 'loading' ? (
        <div className="admin-stats-loading" role="status">
          <LoaderCircle className="admin-spin" size={24} aria-hidden="true" />
          <span>Loading traffic and conversions…</span>
        </div>
      ) : !overview || !summary ? (
        <StatsUnavailable
          message={attribution.error?.message ?? 'Traffic reporting is temporarily unavailable.'}
          onRetry={attribution.status === 'error' ? refreshAll : undefined}
        />
      ) : (
        <>
          <h2 className="sr-only">Key numbers</h2>
          <div className="admin-stats-tiles">
            <StatTile
              icon={MousePointerClick}
              label="Human clicks"
              value={formatAdminCount(humanClicks)}
              detail={`${formatAdminCount(summary.botClicks)} bot clicks filtered out`}
              explain="Visits from partner links, after removing automated traffic."
            />
            <StatTile
              icon={UserCheck}
              label="Matched visitors"
              value={formatAdminCount(summary.resolvedAcquisitions)}
              detail={`${formatAdminCount(summary.acquisitions)} attempts · ${formatAdminCount(summary.rejectedAcquisitions)} rejected`}
              explain="Visitors we could credit to a specific partner."
            />
            <StatTile
              icon={ShieldCheck}
              label="Qualified conversions"
              value={formatAdminCount(summary.qualifiedConversions)}
              explain="Purchases that met the agreement rules and can earn commission."
            />
            <StatTile
              icon={Percent}
              label="Conversion rate"
              value={percent(summary.qualifiedConversions, humanClicks)}
              explain="Qualified conversions divided by human clicks."
            />
            <StatTile
              icon={Repeat}
              label="Active subscriptions"
              value={
                subscriptions.status === 'ready'
                  ? formatAdminCount(subscriptions.data.summary.active)
                  : subscriptions.status === 'loading'
                    ? '…'
                    : '—'
              }
              detail={
                subscriptions.status === 'ready'
                  ? `${formatAdminCount(subscriptions.data.summary.trialing)} trialing · ${formatAdminCount(subscriptions.data.summary.paymentAttention)} need payment attention`
                  : subscriptions.status === 'unavailable'
                    ? subscriptions.message
                    : undefined
              }
              explain="Subscribers paying right now, whenever they joined. Not limited to the selected period."
            />
            <StatTile
              icon={Link2}
              label="Partners with live links"
              value={liveLinks === null ? '—' : formatAdminCount(liveLinks)}
              explain="Partners who have been issued a live main link for this product."
            />
          </div>

          <section className="admin-stats-section" aria-labelledby="admin-stats-funnel-title">
            <SectionHeading
              id="admin-stats-funnel-title"
              title="From click to customer"
              explain="Each bar is one stage. The percentage shows how many moved on from the stage before, which tells you where people drop off."
            />
            <ConversionFunnel summary={summary} />
          </section>

          <div className="admin-stats-columns">
            <section className="admin-stats-section" aria-labelledby="admin-stats-sources-title">
              <SectionHeading
                id="admin-stats-sources-title"
                title="Traffic by source"
                explain="Where clicks came from, using the source labels partners attach to their links. Compare conversion rates to see which channels bring buyers, not just visits."
              />
              <SourceTable rows={overview.breakdown.filter((row) => row.productId === productId)} />
            </section>

            <section className="admin-stats-section" aria-labelledby="admin-stats-health-title">
              <SectionHeading
                id="admin-stats-health-title"
                title="Data freshness"
                explain="When each kind of data last arrived. Old timestamps can mean tracking stopped."
              />
              <dl className="admin-stats-freshness">
                {(
                  [
                    ['Last click', overview.readiness.lastClickAt],
                    ['Last funnel event', overview.readiness.lastEventAt],
                    ['Last conversion', overview.readiness.lastConversionAt],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>
                      <Clock3 size={14} aria-hidden="true" /> {label}
                    </dt>
                    <dd>{formatAdminOperationalTimestamp(value)}</dd>
                  </div>
                ))}
                <div>
                  <dt>
                    <Bot size={14} aria-hidden="true" /> Trusted events
                  </dt>
                  <dd>
                    {formatAdminCount(summary.trustedEvents)} of {formatAdminCount(summary.events)}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="admin-stats-columns">
            <section className="admin-stats-section" aria-labelledby="admin-stats-events-title">
              <SectionHeading
                id="admin-stats-events-title"
                title="Funnel events received"
                explain="Events your funnel sent, such as sign-ups or purchases. Commission-eligible events are the ones that can turn into partner earnings."
              />
              {overview.eventTypes.length ? (
                <div className="admin-stats-table-wrap">
                  <table className="admin-stats-table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Received</th>
                        <th scope="col">Commission-eligible</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.eventTypes.map((event) => (
                        <tr key={event.eventName}>
                          <th scope="row">{displayEnum(event.eventName)}</th>
                          <td>{formatAdminCount(event.eventCount)}</td>
                          <td>{formatAdminCount(event.commercialEligibleCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-stats-empty">No funnel events in this period.</p>
              )}
            </section>

            <section className="admin-stats-section" aria-labelledby="admin-stats-recent-title">
              <SectionHeading
                id="admin-stats-recent-title"
                title="Latest matched visitors"
                explain="The most recent visitors credited to a partner, newest first."
              />
              {overview.recentAcquisitions.items.length ? (
                <ul className="admin-stats-recent">
                  {overview.recentAcquisitions.items.map((item, index) => (
                    <li key={`${item.createdAt}:${index}`}>
                      <div>
                        <strong>{item.partnerName ?? 'Unassigned partner'}</strong>
                        <span>
                          {[item.sourceName, item.campaignName, item.clickCountry]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                      <div>
                        <span className={`admin-status-badge admin-status-${item.status}`}>
                          {item.status}
                        </span>
                        <small>{formatAdminOperationalTimestamp(item.createdAt)}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-stats-empty">No matched visitors in this period.</p>
              )}
            </section>
          </div>

          {subscriptions.status === 'ready' && (
            <section className="admin-stats-section" aria-labelledby="admin-stats-subs-title">
              <SectionHeading
                id="admin-stats-subs-title"
                title="Subscriptions"
                explain="Current state of every subscription started through this product."
                action={
                  onOpenSubscriptions && (
                    <button
                      className="admin-text-button"
                      type="button"
                      onClick={onOpenSubscriptions}
                    >
                      View all subscriptions
                    </button>
                  )
                }
              />
              <dl className="admin-stats-subscriptions">
                {(
                  [
                    ['Active', subscriptions.data.summary.active, 'Paying right now'],
                    ['Trialing', subscriptions.data.summary.trialing, 'In a free trial'],
                    [
                      'Need attention',
                      subscriptions.data.summary.paymentAttention,
                      'Payment failed or overdue',
                    ],
                    ['Cancelled', subscriptions.data.summary.cancelled, 'No longer subscribed'],
                  ] as const
                ).map(([label, value, hint]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{formatAdminCount(value)}</dd>
                    <dd className="admin-stats-subscriptions-hint">{hint}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </section>
  )
}
