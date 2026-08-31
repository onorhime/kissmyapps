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
  const { snapshot, selectedProductId, isRefreshing, actions } = usePartnerLiveWorkspace()
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
            {selectedProduct
              ? [label(context.commercialModel), context.payoutCurrency]
                  .filter(Boolean)
                  .join(' · ') || 'Agreement pending'
              : 'No agreement configured'}
          </strong>
          <span id="product-context-note">
            {selectedProduct
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
          <p>{copy.description}</p>
        </div>
      </div>

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
      ) : snapshot.status === 'ready-empty' || snapshot.availability.emptyReason ? (
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
          {page === 'payouts' && (
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
          )}
          {page === 'links' && (
            <section className="panel live-data-state">
              <Icon size={28} aria-hidden="true" />
              <h2>{snapshot.resources.links.data.length} tracked links</h2>
              <p>Only server-issued tracking URLs are available to this account.</p>
            </section>
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
