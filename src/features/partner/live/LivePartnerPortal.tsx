import { useContext } from 'react'
import { NavigationGuardContext } from '../../../components/useFormNavigationGuard'
import { CreatorEarningsPanel } from '../../creator-settlements/CreatorEarningsPanel'
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
import type { PortalPage } from '../data'
import { toPartnerLiveWorkspaceContext } from './adapters'
import { AgreementSignBanner } from './AgreementSignBanner'
import { LiveLinksPage } from './LiveLinksPage'
import { LiveDocumentsPage } from './LiveDocumentsPage'
import { FunnelMetricsReport } from './FunnelMetricsReport'
import { providerMoney } from '../../../lib/providerMoney'
import { LivePerformance, PeriodPicker } from './LivePerformance'
import type { ReportingPeriod } from './performanceData'
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

function money(value: number | null, currency: string | null) {
  if (value === null || !currency) return '—'
  try {
    return providerMoney(value, currency)
  } catch {
    return '—'
  }
}

function payoutDate(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
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

export function LivePartnerPortal({
  page,
  reportingDays,
  onReportingDaysChange,
}: {
  page: PortalPage
  reportingDays?: ReportingPeriod
  onReportingDaysChange?: (days: ReportingPeriod) => void
}) {
  const navigateSafely = useContext(NavigationGuardContext)
  const workspace = usePartnerLiveWorkspace()
  const { snapshot, selectedProductId, isRefreshing, actions } = workspace
  const context = toPartnerLiveWorkspaceContext(snapshot, selectedProductId)
  const copy = pageCopy[page]
  const Icon = copy.icon
  const selectedProduct = context.selectedProduct
  const summary = snapshot.resources.dashboardSummary.data
  const payout = snapshot.resources.payoutSummary.data
  const empty = stateMessage(snapshot.availability.emptyReason)
  const error = snapshot.errors[0]
  const loading = snapshot.status === 'loading'
  const productsKnown = ['ready', 'empty'].includes(snapshot.resources.products.status)
  const productsUnavailable = !loading && !productsKnown
  const failed = ['unavailable', 'unconfigured', 'error'].includes(snapshot.status)
  const trackingOnly = selectedProduct?.trackingMode === 'tracking_only'
  const trends = snapshot.resources.dashboardTrends
  const canRenderOperationalPage =
    snapshot.availability.emptyReason === 'no_activity' &&
    (page === 'links' || page === 'performance' || (trackingOnly && page === 'payouts'))
  const showEmptyState =
    snapshot.status === 'ready-empty' ||
    (Boolean(snapshot.availability.emptyReason) && !canRenderOperationalPage)

  return (
    <>
      {page !== 'profile' && (
        <section className="workspace-context" aria-label="Product and partnership context">
          <label className="workspace-product">
            <Layers3 size={18} aria-hidden="true" />
            <span>
              <span className="context-label">PRODUCT</span>
              <select
                aria-label="Product"
                value={selectedProductId ?? ''}
                disabled={loading || productsUnavailable || context.products.length === 0}
                onChange={(event) => {
                  const productId = event.target.value || null
                  navigateSafely(() => actions.selectProduct(productId))
                }}
                aria-describedby="product-context-note"
              >
                {context.products.length === 0 ? (
                  <option value="">
                    {loading
                      ? 'Loading products…'
                      : productsUnavailable
                        ? 'Products unavailable'
                        : 'No active products'}
                  </option>
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
              {loading
                ? 'Loading agreement…'
                : productsUnavailable
                  ? 'Agreement details unavailable'
                  : trackingOnly
                    ? 'Tracking-only demo'
                    : selectedProduct
                      ? [label(context.commercialModel), context.payoutCurrency]
                          .filter(Boolean)
                          .join(' · ') || 'Agreement pending'
                      : 'No agreement configured'}
            </strong>
            <span id="product-context-note">
              {loading
                ? 'Reading your authorized product and agreement details.'
                : productsUnavailable
                  ? 'Product details could not be loaded. Your saved configuration has not been changed.'
                  : trackingOnly
                    ? 'Non-commercial · purchases, earnings and payouts unavailable'
                    : selectedProduct
                      ? `${label(context.agreementStatus) ?? 'Agreement pending'} · ${label(selectedProduct.status)}`
                      : 'Your first product will appear here when it is ready.'}
            </span>
          </div>
        </section>
      )}

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
        {page === 'performance' && reportingDays && onReportingDaysChange && (
          <PeriodPicker value={reportingDays} onChange={onReportingDaysChange} />
        )}
      </div>

      {!loading && !failed && (
        <AgreementSignBanner gateway={workspace.gateway} onCompleted={actions.refresh} />
      )}

      {page === 'profile' ? (
        <LiveDocumentsPage workspace={workspace} />
      ) : loading ? (
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
      ) : productsUnavailable ? (
        <section className="panel live-data-state" role="alert">
          <AlertCircle size={28} aria-hidden="true" />
          <h2>Product data is unavailable</h2>
          <p>
            We could not load your authorized products and main links. This does not mean they have
            not been configured.
          </p>
          <button
            className="button button-primary"
            onClick={actions.refresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={isRefreshing ? 'spin' : ''} size={16} aria-hidden="true" />
            {isRefreshing ? 'Refreshing…' : 'Retry product data'}
          </button>
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
            <LivePerformance
              summary={summary}
              trends={trends}
              trackingOnly={trackingOnly}
              isRefreshing={isRefreshing}
              onRefresh={actions.refresh}
            />
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
              <>
                <div className="live-summary-grid">
                  <article className="panel">
                    <span>Open</span>
                    <strong>{money(payout.openMinor, payout.currency)}</strong>
                    <small>Earned and still inside the review window.</small>
                  </article>
                  <article className="panel">
                    <span>Approved</span>
                    <strong>{money(payout.approvedMinor, payout.currency)}</strong>
                    <small>Cleared review and waiting for the next payout run.</small>
                  </article>
                  <article className="panel">
                    <span>Paid</span>
                    <strong>{money(payout.paidMinor, payout.currency)}</strong>
                    <small>Already sent to your payout account.</small>
                  </article>
                </div>
                {payoutDate(payout.nextExpectedPaymentAt) && (
                  <p className="performance-status" role="status">
                    <span className="performance-status-pill">
                      Next payout expected {payoutDate(payout.nextExpectedPaymentAt)}
                    </span>
                    <span>The date can move if a review or bank check is still open.</span>
                  </p>
                )}
              </>
            ))}
          {page === 'links' && selectedProduct && (
            <LiveLinksPage
              key={selectedProduct.id}
              product={selectedProduct}
              workspace={workspace}
            />
          )}
        </section>
      )}
      {page === 'performance' &&
        selectedProduct &&
        !loading &&
        !failed &&
        !productsUnavailable &&
        snapshot.resources.profile.data && <FunnelMetricsReport workspace={workspace} />}
      {page === 'payouts' &&
        selectedProduct &&
        !trackingOnly &&
        !loading &&
        !failed &&
        snapshot.resources.profile.data && (
          <CreatorEarningsPanel
            key={`${workspace.sessionUserId}:${selectedProduct.id}`}
            productId={selectedProduct.id}
            client={workspace.client}
          />
        )}
    </>
  )
}
