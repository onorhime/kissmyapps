import { useMemo, useState } from 'react'
import {
  Check,
  CircleAlert,
  Copy,
  Link2,
  LoaderCircle,
  Package,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import type { AdminContext, AdminFunnel, AdminGateway, AdminMainLink, AdminProduct } from '../api'
import { useFunnelsLinksOverview, type FunnelsLinksProductRow } from './useFunnelsLinksOverview'

export type FunnelsLinksPageProps = Readonly<{
  context: AdminContext
  products: readonly AdminProduct[]
  gateway: AdminGateway
  onOpenProducts: () => void
  onOpenProductConfiguration: (productId: string) => void
}>

function displayStatus(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).replaceAll('_', ' ')}`
}

function formattedDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function sanitizedHttpsDestination(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname) return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

function destinationCopy(funnel: AdminFunnel | undefined, canViewDestination: boolean): string {
  if (!funnel?.destinationConfigured) return 'Missing'
  if (!canViewDestination) return 'Configured'
  if (!funnel.destinationUrl) return 'Configured'
  return sanitizedHttpsDestination(funnel.destinationUrl) ?? 'Configured'
}

function defaultFunnel(row: FunnelsLinksProductRow): AdminFunnel | undefined {
  return row.configuration.funnels.find((funnel) => funnel.isDefault)
}

function routingReadiness(row: FunnelsLinksProductRow): {
  state: 'ready' | 'blocked'
  label: string
} {
  const funnel = defaultFunnel(row)
  if (!funnel) return { state: 'blocked', label: 'Default funnel missing' }
  if (!row.configuration.readiness.hasLiveDefaultFunnel) {
    return { state: 'blocked', label: 'Default funnel not live' }
  }
  if (!row.configuration.readiness.trackingReady) {
    return {
      state: 'blocked',
      label: row.configuration.tracking.enabled ? 'Tracking incomplete' : 'Tracking disabled',
    }
  }
  return { state: 'ready', label: 'Ready' }
}

function RoutingState({
  kind,
  title,
  description,
  action,
}: {
  kind: 'loading' | 'error' | 'empty'
  title: string
  description: string
  action?: React.ReactNode
}) {
  const loading = kind === 'loading'
  const Icon = loading ? LoaderCircle : kind === 'error' ? CircleAlert : Route
  return (
    <div
      className={`admin-routing-state admin-routing-state-${kind}`}
      role={loading ? 'status' : kind === 'error' ? 'alert' : undefined}
    >
      <span className="admin-state-icon">
        <Icon className={loading ? 'admin-spin' : ''} size={28} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function FunnelsLinksPage({
  context,
  products,
  gateway,
  onOpenProducts,
  onOpenProductConfiguration,
}: FunnelsLinksPageProps) {
  const { state, retry } = useFunnelsLinksOverview({ products, gateway })
  const [copyFeedback, setCopyFeedback] = useState<{
    linkId: string
    kind: 'success' | 'error'
  } | null>(null)
  const canViewDestination = context.role === 'owner' || context.role === 'operations'
  const rowsByProductId = useMemo(
    () => new Map(state.rows.map((row) => [row.product.id, row])),
    [state.rows],
  )
  const unavailableProductIds = useMemo(
    () => new Set(state.unavailableProductIds),
    [state.unavailableProductIds],
  )
  const funnelRows = useMemo(
    () =>
      state.rows.flatMap((row) =>
        row.configuration.funnels.map((funnel) => ({ product: row.product, funnel })),
      ),
    [state.rows],
  )
  const mainLinkRows = useMemo(
    () =>
      state.rows.flatMap((row) =>
        row.configuration.mainLinks.map((link) => ({
          product: row.product,
          configuration: row.configuration,
          link,
        })),
      ),
    [state.rows],
  )

  async function copyMainLink(link: AdminMainLink) {
    setCopyFeedback(null)
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable')
      }
      await navigator.clipboard.writeText(link.trackingUrl)
      setCopyFeedback({ linkId: link.id, kind: 'success' })
    } catch {
      setCopyFeedback({ linkId: link.id, kind: 'error' })
    }
  }

  const partial = state.status === 'partial'
  const loadedCount = state.rows.length
  const summaryQualifier = partial ? 'Loaded products only' : 'Across the product catalog'

  return (
    <section className="admin-page admin-routing-page" aria-labelledby="admin-routing-title">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">PRODUCTION ROUTING</p>
          <h1 id="admin-routing-title">Funnels &amp; Links</h1>
          <p>
            Review every product funnel, production-routing gate, and server-issued partner main
            link from one protected directory.
          </p>
        </div>
        <span className="admin-heading-chip">
          <ShieldCheck size={16} aria-hidden="true" /> Protected data
        </span>
      </header>

      {state.status === 'loading' ? (
        <RoutingState
          kind="loading"
          title="Loading funnels and links"
          description="Reading protected product configuration. No fallback data is shown."
        />
      ) : state.status === 'empty' ? (
        <RoutingState
          kind="empty"
          title="No products yet"
          description="Create the first draft product before adding a production funnel or issuing a partner link."
          action={
            <button className="admin-primary-button" type="button" onClick={onOpenProducts}>
              <Package size={17} aria-hidden="true" /> Open Products
            </button>
          }
        />
      ) : state.status === 'unconfigured' ? (
        <RoutingState
          kind="error"
          title="Funnels & Links are not configured"
          description="The protected product-configuration contract is not available in this workspace."
        />
      ) : state.status === 'error' ? (
        <RoutingState
          kind="error"
          title="Funnels & Links could not be loaded"
          description="Protected routing data is temporarily unavailable. No unavailable value is shown as zero."
          action={
            <button className="admin-primary-button" type="button" onClick={retry}>
              <RefreshCw size={17} aria-hidden="true" /> Retry
            </button>
          }
        />
      ) : (
        <>
          {partial && (
            <div
              className="admin-routing-state admin-routing-state-partial"
              role="status"
              aria-live="polite"
            >
              <CircleAlert size={19} aria-hidden="true" />
              <div>
                <strong>Some product configuration is unavailable</strong>
                <p>
                  Showing {loadedCount} of {products.length} products. Available funnels and links
                  remain visible.
                </p>
              </div>
              <button
                className="admin-secondary-button"
                type="button"
                disabled={state.refreshing}
                onClick={retry}
              >
                {state.refreshing ? (
                  <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
                ) : (
                  <RefreshCw size={16} aria-hidden="true" />
                )}
                {state.refreshing ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          )}

          <div className="admin-routing-summary-grid" aria-label="Funnels and links summary">
            <article className="admin-routing-summary-card">
              <span className="admin-routing-summary-icon">
                <Package size={20} aria-hidden="true" />
              </span>
              <span>Products</span>
              <strong>{state.totals.products}</strong>
              <small>All product records</small>
            </article>
            <article className="admin-routing-summary-card">
              <span className="admin-routing-summary-icon">
                <Route size={20} aria-hidden="true" />
              </span>
              <span>Funnels</span>
              <strong>{state.totals.funnels}</strong>
              <small>{summaryQualifier}</small>
            </article>
            <article className="admin-routing-summary-card">
              <span className="admin-routing-summary-icon">
                <Check size={20} aria-hidden="true" />
              </span>
              <span>Live defaults</span>
              <strong>{state.totals.liveDefaults}</strong>
              <small>{summaryQualifier}</small>
            </article>
            <article className="admin-routing-summary-card">
              <span className="admin-routing-summary-icon">
                <Link2 size={20} aria-hidden="true" />
              </span>
              <span>Main links</span>
              <strong>{state.totals.mainLinks}</strong>
              <small>{summaryQualifier}</small>
            </article>
          </div>

          <section
            className="admin-panel admin-routing-directory"
            aria-labelledby="routing-overview-title"
          >
            <div className="admin-routing-directory-heading">
              <div>
                <h2 id="routing-overview-title">Product routing overview</h2>
                <p>
                  Routing is ready only when tracking and a live default HTTPS funnel both pass.
                </p>
              </div>
              <span className="admin-count-badge">{products.length}</span>
            </div>
            <div
              className="admin-table-scroll"
              role="region"
              aria-label="Product routing table"
              tabIndex={0}
            >
              <table className="admin-products-table admin-routing-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Product status</th>
                    <th scope="col">Default funnel</th>
                    <th scope="col">Destination</th>
                    <th scope="col">Routing readiness</th>
                    <th scope="col">Main links</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((catalogProduct) => {
                    const row = rowsByProductId.get(catalogProduct.id)
                    const unavailable = unavailableProductIds.has(catalogProduct.id)
                    const product = row?.product ?? catalogProduct
                    const funnel = row ? defaultFunnel(row) : undefined
                    const readiness = row ? routingReadiness(row) : null
                    const activeLinks =
                      row?.configuration.mainLinks.filter((link) => link.status === 'active')
                        .length ?? 0
                    return (
                      <tr key={catalogProduct.id}>
                        <th scope="row" data-label="Product">
                          <span className="admin-routing-name-cell">
                            <strong>{product.name}</strong>
                            <code>{product.slug}</code>
                          </span>
                        </th>
                        <td data-label="Product status">
                          <span className={`admin-status-badge admin-status-${product.status}`}>
                            {displayStatus(product.status)}
                          </span>
                        </td>
                        <td data-label="Default funnel">
                          <span className="admin-routing-funnel-cell">
                            {unavailable ? (
                              'Unavailable'
                            ) : funnel ? (
                              <>
                                <strong>{funnel.name}</strong>
                                <small>{displayStatus(funnel.status)}</small>
                              </>
                            ) : (
                              'Not configured'
                            )}
                          </span>
                        </td>
                        <td data-label="Destination">
                          <span className="admin-routing-url">
                            {unavailable
                              ? 'Unavailable'
                              : destinationCopy(funnel, canViewDestination)}
                          </span>
                        </td>
                        <td data-label="Routing readiness">
                          <span
                            className={`admin-routing-readiness admin-routing-readiness-${readiness?.state ?? 'unavailable'}`}
                            data-state={readiness?.state ?? 'unavailable'}
                          >
                            {readiness?.label ?? 'Unavailable'}
                          </span>
                        </td>
                        <td data-label="Main links">
                          {row ? (
                            <span>
                              <strong>{row.configuration.mainLinks.length}</strong>
                              {row.configuration.mainLinks.length > 0 && (
                                <small> · {activeLinks} active</small>
                              )}
                            </span>
                          ) : (
                            'Unavailable'
                          )}
                        </td>
                        <td data-label="Action">
                          <button
                            className="admin-table-action admin-routing-action"
                            type="button"
                            onClick={() => onOpenProductConfiguration(catalogProduct.id)}
                            aria-label={`Open configuration for ${product.name}`}
                          >
                            <Settings2 size={15} aria-hidden="true" />
                            {canViewDestination ? 'Configure' : 'View'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className="admin-panel admin-routing-directory"
            aria-labelledby="funnel-directory-title"
          >
            <div className="admin-routing-directory-heading">
              <div>
                <h2 id="funnel-directory-title">Funnel directory</h2>
                <p>Every configured route remains attached to its product and immutable key.</p>
              </div>
              <span className="admin-count-badge">{funnelRows.length}</span>
            </div>
            {funnelRows.length ? (
              <div
                className="admin-table-scroll"
                role="region"
                aria-label="Funnel directory table"
                tabIndex={0}
              >
                <table className="admin-products-table admin-routing-table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Funnel</th>
                      <th scope="col">Status</th>
                      <th scope="col">Default</th>
                      <th scope="col">Destination</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnelRows.map(({ product, funnel }) => (
                      <tr key={funnel.id}>
                        <th scope="row" data-label="Product">
                          <span className="admin-routing-name-cell">
                            <strong>{product.name}</strong>
                            <code>{product.slug}</code>
                          </span>
                        </th>
                        <td data-label="Funnel">
                          <span className="admin-routing-funnel-cell">
                            <strong>{funnel.name}</strong>
                            <code>{funnel.key}</code>
                          </span>
                        </td>
                        <td data-label="Status">
                          <span className={`admin-status-badge admin-status-${funnel.status}`}>
                            {displayStatus(funnel.status)}
                          </span>
                        </td>
                        <td data-label="Default">{funnel.isDefault ? 'Yes' : 'No'}</td>
                        <td data-label="Destination">
                          <span className="admin-routing-url">
                            {destinationCopy(funnel, canViewDestination)}
                          </span>
                        </td>
                        <td data-label="Updated">{formattedDate(funnel.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-routing-state admin-routing-state-empty">
                <Route size={26} aria-hidden="true" />
                <h3>No funnels configured</h3>
                <p>
                  Open a product configuration when its approved production destination is ready.
                </p>
              </div>
            )}
          </section>

          <section className="admin-panel admin-routing-links" aria-labelledby="main-links-title">
            <div className="admin-routing-directory-heading">
              <div>
                <h2 id="main-links-title">Issued main links</h2>
                <p>
                  Copy server-returned links without opening them or creating production traffic.
                </p>
              </div>
              <span className="admin-count-badge">{mainLinkRows.length}</span>
            </div>
            {mainLinkRows.length ? (
              <ul className="admin-routing-link-list" aria-label="Issued main links">
                {mainLinkRows.map(({ product, configuration, link }) => {
                  const funnel = configuration.funnels.find(
                    (candidate) => candidate.id === link.funnelId,
                  )
                  const feedback = copyFeedback?.linkId === link.id ? copyFeedback : null
                  const partnerName = link.partnerName?.trim() || 'Partner unavailable'
                  return (
                    <li className="admin-routing-link-row" key={link.id}>
                      <span className="admin-routing-name-cell">
                        <strong>{partnerName}</strong>
                        <small>{product.name}</small>
                      </span>
                      <span className="admin-routing-funnel-cell">
                        <strong>{funnel?.name ?? 'Funnel unavailable'}</strong>
                        <small>Issued {formattedDate(link.createdAt)}</small>
                      </span>
                      <code className="admin-routing-url">{link.trackingUrl}</code>
                      <div className="admin-routing-action">
                        <span className={`admin-status-badge admin-status-${link.status}`}>
                          {displayStatus(link.status)}
                        </span>
                        <button
                          className="admin-table-action"
                          type="button"
                          onClick={() => void copyMainLink(link)}
                          aria-label={`Copy main link for ${partnerName}`}
                        >
                          <Copy size={15} aria-hidden="true" /> Copy link
                        </button>
                        {feedback && (
                          <small
                            className="admin-routing-copy-feedback"
                            role={feedback.kind === 'error' ? 'alert' : 'status'}
                          >
                            {feedback.kind === 'success'
                              ? 'Link copied.'
                              : 'Link could not be copied. Select and copy it manually.'}
                          </small>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="admin-routing-state admin-routing-state-empty">
                <Link2 size={26} aria-hidden="true" />
                <h3>No main links issued</h3>
                <p>
                  Links appear here only after the server accepts every production readiness gate.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  )
}

export default FunnelsLinksPage
