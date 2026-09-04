import {
  AlertCircle,
  ChartNoAxesCombined,
  ChevronDown,
  FileText,
  Layers3,
  Link2,
  LoaderCircle,
  RefreshCw,
  WalletCards,
} from 'lucide-react'
import type { PartnerMetricValues, PartnerTrendPoint } from '../api'
import type { PortalPage } from '../data'
import { toPartnerLiveWorkspaceContext } from './adapters'
import { AgreementSignBanner } from './AgreementSignBanner'
import { LiveLinksPage } from './LiveLinksPage'
import { usePartnerLiveWorkspace } from './usePartnerLiveWorkspace'

const pageCopy = {
  performance: {
    eyebrow: 'YOUR PARTNER PERFORMANCE',
    title: 'Performance',
    description: 'Traffic, conversions, and earnings from verified partner activity.',
    icon: ChartNoAxesCombined,
  },
  payouts: {
    eyebrow: 'YOUR EARNINGS JOURNEY',
    title: 'Payouts',
    description: 'Balances, review status, statements, and settled payments.',
    icon: WalletCards,
  },
  links: {
    eyebrow: 'YOUR TRACKED DESTINATIONS',
    title: 'Links & Sources',
    description: 'Trusted tracking links for approved products and live funnels.',
    icon: Link2,
  },
  profile: {
    eyebrow: 'YOUR PARTNER ACCOUNT',
    title: 'Profile & Documents',
    description: 'Your verified identity, commercial terms, preferences, and documents.',
    icon: FileText,
  },
} as const

function label(value: string | null) {
  if (!value) return null
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function metric(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function money(value: number | null, currency: string | null) {
  if (value === null || !currency) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value / 100)
}

type DemoTrafficMetrics = Readonly<
  Pick<PartnerMetricValues, 'clicks' | 'funnelStarts' | 'paymentViews' | 'appStoreClicks'>
>

type DemoSourceRow = Readonly<{
  key: string
  label: string
  metrics: DemoTrafficMetrics
}>

function addKnown(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right
}

/**
 * Source reporting remains date-grained in the RPC so the UI combines each
 * source's buckets. A null bucket keeps the aggregate unknown instead of being
 * silently treated as zero.
 */
function sourceBreakdown(points: readonly PartnerTrendPoint[]): readonly DemoSourceRow[] {
  const rows = new Map<string, DemoSourceRow>()

  for (const point of points) {
    const current = rows.get(point.dimensionKey)
    const nextMetrics: DemoTrafficMetrics = current
      ? {
          clicks: addKnown(current.metrics.clicks, point.metrics.clicks),
          funnelStarts: addKnown(current.metrics.funnelStarts, point.metrics.funnelStarts),
          paymentViews: addKnown(current.metrics.paymentViews, point.metrics.paymentViews),
          appStoreClicks: addKnown(current.metrics.appStoreClicks, point.metrics.appStoreClicks),
        }
      : {
          clicks: point.metrics.clicks,
          funnelStarts: point.metrics.funnelStarts,
          paymentViews: point.metrics.paymentViews,
          appStoreClicks: point.metrics.appStoreClicks,
        }
    rows.set(point.dimensionKey, {
      key: point.dimensionKey,
      label: point.dimensionLabel,
      metrics: nextMetrics,
    })
  }

  return [...rows.values()].sort((left, right) => {
    const clickDifference = (right.metrics.clicks ?? -1) - (left.metrics.clicks ?? -1)
    return clickDifference || left.label.localeCompare(right.label)
  })
}

function stateMessage(
  reason: ReturnType<typeof toPartnerLiveWorkspaceContext>['availability']['emptyReason'],
) {
  switch (reason) {
    case 'no_partner_profile':
      return {
        title: 'Your account still needs a partner workspace',
        body: 'The sign-in is valid, but this user has not been assigned to an active partner profile yet.',
      }
    case 'no_products':
      return {
        title: 'No products are connected yet',
        body: 'The partner dashboard is ready. Your first product and commercial agreement will appear here when they are configured.',
      }
    case 'no_funnels':
      return {
        title: 'No live funnel is available yet',
        body: 'This product is connected, but trusted tracking links remain disabled until its first funnel is live.',
      }
    case 'no_activity':
      return {
        title: 'No verified activity yet',
        body: 'This is a real zero-data state. Metrics will appear only after the first attributed events are processed.',
      }
    default:
      return {
        title: 'Your partner workspace is ready',
        body: 'Live records will appear here as the product starts receiving verified activity.',
      }
  }
}

export function LivePartnerPortal({ page }: { page: PortalPage }) {
  const workspace = usePartnerLiveWorkspace()
  const { snapshot, selectedProductId, isRefreshing, actions } = workspace
  const context = toPartnerLiveWorkspaceContext(snapshot, selectedProductId)
  const copy = pageCopy[page]
  const Icon = copy.icon
  const selectedProduct = context.selectedProduct
  const profile = snapshot.resources.profile.data
  const summary = snapshot.resources.dashboardSummary.data
  const payout = snapshot.resources.payoutSummary.data
  const empty = stateMessage(snapshot.availability.emptyReason)
  const error = snapshot.errors[0]
  const loading = snapshot.status === 'loading'
  const failed = ['unavailable', 'unconfigured', 'error'].includes(snapshot.status)
  const trackingOnly = selectedProduct?.trackingMode === 'tracking_only'
  const trends = snapshot.resources.dashboardTrends
  const demoSources = trackingOnly && trends.status === 'ready' ? sourceBreakdown(trends.data) : []
  const canRenderOperationalPage =
    snapshot.availability.emptyReason === 'no_activity' &&
    (page === 'links' || (trackingOnly && (page === 'performance' || page === 'payouts')))
  const showEmptyState =
    snapshot.status === 'ready-empty' ||
    (Boolean(snapshot.availability.emptyReason) && !canRenderOperationalPage)

  return (
    <>
      <section className="workspace-context" aria-label="Product and partnership context">
        <label className="workspace-product">
          <Layers3 size={18} aria-hidden="true" />
          <span>
            <span className="context-label">PRODUCT</span>
            <select
              aria-label="Product"
              value={selectedProductId ?? ''}
              disabled={loading || context.products.length === 0}
              onChange={(event) => actions.selectProduct(event.target.value || null)}
              aria-describedby="product-context-note"
            >
              {context.products.length === 0 ? (
                <option value="">No active products</option>
              ) : (
                context.products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))
              )}
            </select>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <div className="context-partner">
          <span className="context-label">PARTNER</span>
          <strong>{context.partnerName ?? 'Partner workspace not assigned'}</strong>
          <span>
            {[label(context.partnerRole), label(context.partnerStatus)]
              .filter(Boolean)
              .join(' · ') || 'Account assignment pending'}
          </span>
        </div>
        <div className="context-terms">
          <span className="context-label">COMMERCIAL MODEL</span>
          <strong>
            {trackingOnly
              ? 'Tracking-only demo'
              : selectedProduct
                ? [label(context.commercialModel), context.payoutCurrency]
                    .filter(Boolean)
                    .join(' · ') || 'Agreement pending'
                : 'No agreement configured'}
          </strong>
          <span id="product-context-note">
            {trackingOnly
              ? 'Non-commercial · purchases, earnings and payouts unavailable'
              : selectedProduct
                ? `${label(context.agreementStatus) ?? 'Agreement pending'} · ${label(selectedProduct.status)}`
                : 'Your first product will appear here when it is ready.'}
          </span>
        </div>
      </section>

      <div className="page-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>
            {copy.title}
            <span className="heading-dot">.</span>
          </h1>
          <p>
            {page === 'performance' && trackingOnly
              ? 'Clicks and approved non-commercial funnel events, grouped by traffic source.'
              : copy.description}
          </p>
        </div>
      </div>

      {!loading && !failed && <AgreementSignBanner gateway={workspace.gateway} />}

      {loading ? (
        <section className="panel live-data-state" aria-busy="true">
          <LoaderCircle className="spin" size={28} aria-hidden="true" />
          <h2>Loading your partner workspace</h2>
          <p role="status">Reading your authorized profile and product data securely…</p>
        </section>
      ) : failed ? (
        <section className="panel live-data-state" role="alert">
          <AlertCircle size={28} aria-hidden="true" />
          <h2>Partner data is not available</h2>
          <p>{error?.message ?? 'The partner data service could not be loaded.'}</p>
          {error?.retryable && (
            <button
              className="button button-primary"
              onClick={actions.refresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={isRefreshing ? 'spin' : ''} size={16} aria-hidden="true" />
              {isRefreshing ? 'Refreshing…' : 'Try again'}
            </button>
          )}
        </section>
      ) : showEmptyState ? (
        <section className="panel live-data-state" aria-labelledby="live-empty-title">
          <Icon size={28} aria-hidden="true" />
          <h2 id="live-empty-title">{empty.title}</h2>
          <p>{empty.body}</p>
        </section>
      ) : (
        <section className="live-overview" aria-label={`${copy.title} live summary`}>
          {snapshot.status === 'partial' && (
            <div className="inline-note live-partial-note" role="status">
              Some partner sources are temporarily unavailable. Unknown values remain shown as —.
            </div>
          )}
          {page === 'performance' && (
            <>
              {trackingOnly ? (
                <div className="live-summary-grid live-demo-summary-grid">
                  <article className="panel">
                    <span>Clicks</span>
                    <strong>{metric(summary.metrics.clicks)}</strong>
                  </article>
                  <article className="panel">
                    <span>Funnel starts</span>
                    <strong>{metric(summary.metrics.funnelStarts)}</strong>
                  </article>
                  <article className="panel">
                    <span>Payment views</span>
                    <strong>{metric(summary.metrics.paymentViews)}</strong>
                  </article>
                  <article className="panel">
                    <span>App-store clicks</span>
                    <strong>{metric(summary.metrics.appStoreClicks)}</strong>
                  </article>
                </div>
              ) : (
                <div className="live-summary-grid">
                  <article className="panel">
                    <span>Clicks</span>
                    <strong>{metric(summary.metrics.clicks)}</strong>
                  </article>
                  <article className="panel">
                    <span>Purchases</span>
                    <strong>{metric(summary.metrics.purchases)}</strong>
                  </article>
                  <article className="panel">
                    <span>Earnings</span>
                    <strong>{money(summary.metrics.earningsMinor, summary.currency)}</strong>
                  </article>
                </div>
              )}

              {trackingOnly && (
                <section
                  className="panel live-source-breakdown"
                  aria-labelledby="source-results-title"
                >
                  <div className="live-source-breakdown-heading">
                    <div>
                      <span className="context-label">SOURCE ATTRIBUTION</span>
                      <h2 id="source-results-title">Traffic source results</h2>
                    </div>
                    <p>Verified, non-bot demo traffic in the current reporting window.</p>
                  </div>

                  {trends.status === 'ready' && demoSources.length > 0 ? (
                    <div className="table-scroll live-source-breakdown-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Source</th>
                            <th scope="col">Clicks</th>
                            <th scope="col">Funnel starts</th>
                            <th scope="col">Payment views</th>
                            <th scope="col">App-store clicks</th>
                          </tr>
                        </thead>
                        <tbody>
                          {demoSources.map((source) => (
                            <tr key={source.key}>
                              <th scope="row">{source.label}</th>
                              <td>{metric(source.metrics.clicks)}</td>
                              <td>{metric(source.metrics.funnelStarts)}</td>
                              <td>{metric(source.metrics.paymentViews)}</td>
                              <td>{metric(source.metrics.appStoreClicks)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : trends.status === 'empty' || trends.status === 'ready' ? (
                    <div className="live-source-unavailable" role="status">
                      <Link2 size={24} aria-hidden="true" />
                      <div>
                        <strong>No attributed source activity yet</strong>
                        <span>Results will appear after the first verified tracking click.</span>
                      </div>
                    </div>
                  ) : (
                    <div className="live-source-unavailable" role="alert">
                      <AlertCircle size={24} aria-hidden="true" />
                      <div>
                        <strong>Source results are temporarily unavailable</strong>
                        <span>
                          {trends.error?.message ??
                            'The source attribution read could not be verified safely.'}
                        </span>
                      </div>
                      <button
                        className="button button-white"
                        type="button"
                        onClick={actions.refresh}
                        disabled={isRefreshing}
                      >
                        <RefreshCw
                          className={isRefreshing ? 'spin' : ''}
                          size={15}
                          aria-hidden="true"
                        />
                        {isRefreshing ? 'Refreshing sources…' : 'Retry source results'}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          {page === 'payouts' &&
            (trackingOnly ? (
              <section className="panel live-data-state">
                <WalletCards size={28} aria-hidden="true" />
                <h2>Payouts are unavailable for demo traffic</h2>
                <p>
                  Tracking-only clicks can never qualify for purchases, earnings, statements or
                  payouts. Commercial reporting starts only on a separately configured commercial
                  product.
                </p>
              </section>
            ) : (
              <div className="live-summary-grid">
                <article className="panel">
                  <span>Open</span>
                  <strong>{money(payout.openMinor, payout.currency)}</strong>
                </article>
                <article className="panel">
                  <span>Approved</span>
                  <strong>{money(payout.approvedMinor, payout.currency)}</strong>
                </article>
                <article className="panel">
                  <span>Paid</span>
                  <strong>{money(payout.paidMinor, payout.currency)}</strong>
                </article>
              </div>
            ))}
          {page === 'links' && selectedProduct && (
            <LiveLinksPage
              key={selectedProduct.id}
              product={selectedProduct}
              workspace={workspace}
            />
          )}
          {page === 'profile' && (
            <section className="panel live-data-state">
              <Icon size={28} aria-hidden="true" />
              <h2>{profile?.publicName ?? 'Partner profile'}</h2>
              <p>
                {snapshot.resources.documents.data.length} documents ·{' '}
                {snapshot.resources.agreements.data.length} agreement versions
              </p>
            </section>
          )}
        </section>
      )}
    </>
  )
}
