import { useFormNavigationGuard } from '../../components/useFormNavigationGuard'
import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowRightLeft,
  BadgeDollarSign,
  Boxes,
  ChartNoAxesCombined,
  CircleAlert,
  DatabaseZap,
  FileText,
  Gauge,
  Link2,
  LoaderCircle,
  LogOut,
  Package,
  RefreshCw,
  Settings,
  ShieldX,
  Users,
} from 'lucide-react'
import { Brand } from '../../components/Brand'
import { adminGateway as defaultAdminGateway, type AdminGateway } from './api'
import { AffiliatesPage } from './affiliates/AffiliatesPage'
import { AdminOverview } from './AdminOverview'
import { ProductConfigurationPage } from './configuration/ProductConfigurationPage'
import { FunnelsLinksPage } from './funnels/FunnelsLinksPage'
import { AttributionPage } from './observability/AttributionPage'
import { DataHealthPage } from './observability/DataHealthPage'
import { ProductsPage } from './products/ProductsPage'
import { PlatformSettingsPage } from './settings/PlatformSettingsPage'
import { SubscriptionsPage } from './subscriptions/SubscriptionsPage'
import { PayoutsPage } from './payouts/PayoutsPage'
import { useAdminWorkspace, type AdminWorkspaceStatus } from './useAdminWorkspace'
import './AdminPortal.css'

export type AdminPrimaryRoute =
  | 'overview'
  | 'products'
  | 'affiliates'
  | 'funnels-links'
  | 'attribution'
  | 'subscriptions'
  | 'payouts'
  | 'data-health'
  | 'settings'
export type AdminRoute = AdminPrimaryRoute | 'product-configuration' | 'affiliate-detail'

export type AdminIdentity = Readonly<{
  name?: string | null
  email?: string | null
}>

export type AdminPortalAppProps = Readonly<{
  route: AdminRoute
  sessionUserId: string | null
  gateway?: AdminGateway
  identity?: AdminIdentity
  productId?: string | null
  affiliateId?: string | null
  onNavigate: (route: AdminRoute) => void
  onOpenProductConfiguration: (productId: string) => void
  onOpenAffiliate?: (affiliateId: string) => void
  onSignOut: () => void | Promise<void>
  onSwitchToPartner: () => void | Promise<void>
}>

type UpcomingRoute = 'documents'

const navigation: readonly (
  | { id: AdminPrimaryRoute; label: string; icon: typeof Gauge; enabled: true }
  | { id: UpcomingRoute; label: string; icon: typeof Gauge; enabled: false }
)[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, enabled: true },
  { id: 'products', label: 'Products', icon: Package, enabled: true },
  { id: 'affiliates', label: 'Affiliates', icon: Users, enabled: true },
  { id: 'funnels-links', label: 'Funnels & Links', icon: Link2, enabled: true },
  { id: 'attribution', label: 'Attribution', icon: Activity, enabled: true },
  { id: 'subscriptions', label: 'Subscriptions', icon: Boxes, enabled: true },
  { id: 'payouts', label: 'Payouts', icon: BadgeDollarSign, enabled: true },
  { id: 'documents', label: 'Documents', icon: FileText, enabled: false },
  { id: 'data-health', label: 'Data Health', icon: DatabaseZap, enabled: true },
  { id: 'settings', label: 'Settings', icon: Settings, enabled: true },
]

const routeLabels: Record<AdminRoute, string> = {
  overview: 'Overview',
  products: 'Products',
  affiliates: 'Affiliates',
  'funnels-links': 'Funnels & Links',
  attribution: 'Attribution',
  subscriptions: 'Subscriptions',
  payouts: 'Payouts',
  'data-health': 'Data Health',
  settings: 'Settings',
  'product-configuration': 'Product configuration',
  'affiliate-detail': 'Affiliate details',
}

function routeIsActive(route: AdminRoute, navigationRoute: AdminPrimaryRoute): boolean {
  return (
    route === navigationRoute ||
    (route === 'product-configuration' && navigationRoute === 'products') ||
    (route === 'affiliate-detail' && navigationRoute === 'affiliates')
  )
}

function AdminState({
  status,
  message,
  onRetry,
  onSwitchToPartner,
}: {
  status: AdminWorkspaceStatus
  message: string | null
  onRetry: () => void
  onSwitchToPartner: () => void
}) {
  const loading = status === 'loading'
  const unauthorized = status === 'unauthorized' || status === 'unauthenticated'
  const unconfigured = status === 'unconfigured'
  const Icon = loading ? LoaderCircle : unauthorized ? ShieldX : DatabaseZap
  const title = loading
    ? 'Checking admin access'
    : status === 'unauthenticated'
      ? 'Admin sign-in required'
      : status === 'unauthorized'
        ? 'Admin access required'
        : unconfigured
          ? 'Admin data is not configured'
          : 'Admin data is unavailable'
  const body = loading
    ? 'Verifying the signed-in account and protected admin data contracts.'
    : (message ??
      (unauthorized
        ? 'This account is not an active KissMyApps administrator.'
        : 'The admin workspace could not be loaded safely.'))

  return (
    <section
      className="admin-state-card"
      aria-labelledby="admin-state-title"
      role={loading ? 'status' : undefined}
    >
      <span className="admin-state-icon">
        <Icon className={loading ? 'admin-spin' : ''} size={30} aria-hidden="true" />
      </span>
      <p className="admin-eyebrow">PROTECTED WORKSPACE</p>
      <h1 id="admin-state-title">{title}</h1>
      <p>{body}</p>
      {!loading && (
        <div className="admin-state-actions">
          {!unauthorized && !unconfigured && (
            <button className="admin-primary-button" type="button" onClick={onRetry}>
              <RefreshCw size={17} aria-hidden="true" /> Retry
            </button>
          )}
          {unauthorized && (
            <button className="admin-secondary-button" type="button" onClick={onSwitchToPartner}>
              <ArrowRightLeft size={17} aria-hidden="true" /> Switch to Partner
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export function AdminPortalApp({
  route,
  sessionUserId,
  gateway,
  identity,
  productId,
  affiliateId,
  onNavigate,
  onOpenProductConfiguration,
  onOpenAffiliate,
  onSignOut,
  onSwitchToPartner,
}: AdminPortalAppProps) {
  const effectiveGateway = gateway ?? defaultAdminGateway
  const { state, retry, createProduct, replaceProduct } = useAdminWorkspace({
    sessionUserId,
    gateway: effectiveGateway,
  })
  const [mobileNavRoute, setMobileNavRoute] = useState<AdminRoute | null>(null)
  const [shellError, setShellError] = useState('')
  const [signOutPending, setSignOutPending] = useState(false)
  const previousRoute = useRef(route)
  const mainRef = useRef<HTMLElement>(null)
  const guard = useFormNavigationGuard(true, sessionUserId ?? '')
  const context = state.context
  const displayName = context?.fullName ?? identity?.name?.trim() ?? 'Admin account'
  const displayEmail = context?.email ?? identity?.email?.trim() ?? 'Protected access'
  const initial = displayName.slice(0, 1).toUpperCase() || 'A'
  const workspaceReady = (state.status === 'ready' || state.status === 'empty') && context
  const mobileNavOpen = mobileNavRoute === route
  const funnelsLinksRestricted = context?.role === 'support'
  const observabilityRestricted = context?.role === 'support'
  const settingsRestricted = context?.role === 'support'

  function isRestrictedRoute(routeId: string): boolean {
    return (
      (routeId === 'funnels-links' && funnelsLinksRestricted) ||
      ((routeId === 'attribution' || routeId === 'data-health') && observabilityRestricted) ||
      (routeId === 'settings' && settingsRestricted) ||
      ((routeId === 'subscriptions' || routeId === 'payouts') && context?.role === 'support')
    )
  }

  useEffect(() => {
    if (previousRoute.current !== route) {
      const affiliateOverlay = [previousRoute.current, route].every(
        (value) => value === 'affiliates' || value === 'affiliate-detail',
      )
      if (!affiliateOverlay) {
        mainRef.current?.focus({ preventScroll: true })
        window.scrollTo({ top: 0, behavior: 'auto' })
      }
      previousRoute.current = route
    }
  }, [route])

  async function safelySwitchToPartner() {
    setShellError('')
    try {
      await onSwitchToPartner()
    } catch {
      setShellError('We could not switch workspaces. Please try again.')
    }
  }

  async function safelySignOut() {
    if (signOutPending) return
    setSignOutPending(true)
    setShellError('')
    try {
      await onSignOut()
    } catch {
      setShellError('We could not sign you out. Please try again.')
    } finally {
      setSignOutPending(false)
    }
  }

  function navigate(nextRoute: AdminRoute) {
    setMobileNavRoute(null)
    if (nextRoute === route) return
    guard.request(() => onNavigate(nextRoute))
  }

  return (
    <div
      className="admin-portal"
      onFocusCapture={guard.capture}
      onPointerDownCapture={guard.capture}
    >
      <a
        className="admin-skip-link"
        href="#admin-main-content"
        onClick={(event) => {
          event.preventDefault()
          mainRef.current?.focus()
        }}
      >
        Skip to admin content
      </a>

      <div className="admin-shell">
        <aside className={`admin-sidebar ${mobileNavOpen ? 'admin-sidebar-open' : ''}`}>
          <div className="admin-brand">
            <Brand context="Admin" />
          </div>

          <div className="admin-workspace-label">
            <span className="admin-workspace-monogram">A</span>
            <span>
              <strong>Admin workspace</strong>
              <small>Platform control center</small>
            </span>
          </div>

          <p className="admin-nav-caption">PLATFORM</p>
          <nav className="admin-navigation" aria-label="Admin navigation">
            {navigation.map((item) => {
              const Icon = item.icon
              const restricted = isRestrictedRoute(item.id)
              if (!item.enabled || restricted) {
                return (
                  <span
                    className="admin-nav-item admin-nav-item-upcoming"
                    aria-disabled="true"
                    key={item.id}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{item.label}</span>
                    <small>{restricted ? 'Restricted' : 'Upcoming'}</small>
                  </span>
                )
              }
              return (
                <button
                  className={`admin-nav-item ${routeIsActive(route, item.id) ? 'admin-nav-item-active' : ''}`}
                  type="button"
                  aria-current={routeIsActive(route, item.id) ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                  key={item.id}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="admin-sidebar-footer">
            <button
              className="admin-switch-button"
              type="button"
              onClick={() => guard.request(() => void safelySwitchToPartner())}
            >
              <ArrowRightLeft size={17} aria-hidden="true" />
              Switch to Partner
            </button>
            <div className="admin-sidebar-account">
              <span className="admin-avatar">{initial}</span>
              <span>
                <strong>{displayName}</strong>
                <small>{displayEmail}</small>
              </span>
            </div>
          </div>
        </aside>

        <div className="admin-workspace">
          <header className="admin-topbar">
            <div className="admin-topbar-left">
              <button
                className="admin-mobile-nav-button"
                type="button"
                aria-expanded={mobileNavOpen}
                aria-controls="admin-mobile-navigation"
                onClick={() =>
                  setMobileNavRoute((openRoute) => (openRoute === route ? null : route))
                }
              >
                <ChartNoAxesCombined size={19} aria-hidden="true" />
                Menu
              </button>
              <span className="admin-breadcrumb">
                <span>Admin</span>
                <span aria-hidden="true">/</span>
                <strong>{routeLabels[route]}</strong>
              </span>
            </div>
            <div className="admin-topbar-actions">
              <button
                className="admin-sign-out-button"
                type="button"
                disabled={signOutPending || !sessionUserId}
                aria-label={signOutPending ? 'Signing out…' : 'Sign out'}
                onClick={() => guard.request(() => void safelySignOut())}
              >
                {signOutPending ? (
                  <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                ) : (
                  <LogOut size={17} aria-hidden="true" />
                )}
                <span className="admin-sign-out-label">
                  {signOutPending ? 'Signing out…' : 'Sign out'}
                </span>
              </button>
            </div>
          </header>

          <div
            className="admin-mobile-navigation-wrap"
            id="admin-mobile-navigation"
            hidden={!mobileNavOpen}
          >
            <nav aria-label="Mobile admin navigation">
              {navigation.map((item) =>
                item.enabled && !isRestrictedRoute(item.id) ? (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={routeIsActive(route, item.id) ? 'page' : undefined}
                    onClick={() => navigate(item.id)}
                  >
                    {item.label}
                  </button>
                ) : (
                  <span key={item.id} aria-disabled="true">
                    {item.label}{' '}
                    <small>{isRestrictedRoute(item.id) ? 'Restricted' : 'Upcoming'}</small>
                  </span>
                ),
              )}
              <button
                className="admin-mobile-switch-button"
                type="button"
                onClick={() => guard.request(() => void safelySwitchToPartner())}
              >
                <ArrowRightLeft size={16} aria-hidden="true" />
                Switch to Partner
              </button>
            </nav>
          </div>

          {shellError && (
            <div className="admin-shell-error" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              <span>{shellError}</span>
              <button type="button" onClick={() => setShellError('')}>
                Dismiss
              </button>
            </div>
          )}

          <main className="admin-main" id="admin-main-content" tabIndex={-1} ref={mainRef}>
            {workspaceReady ? (
              route === 'product-configuration' ? (
                productId ? (
                  <ProductConfigurationPage
                    productId={productId}
                    context={context}
                    gateway={effectiveGateway}
                    onBack={() => navigate('products')}
                    onProductRead={replaceProduct}
                  />
                ) : (
                  <section
                    className="admin-state-card"
                    aria-labelledby="admin-product-selection-title"
                  >
                    <CircleAlert size={30} aria-hidden="true" />
                    <p className="admin-eyebrow">PRODUCT CONFIGURATION</p>
                    <h1 id="admin-product-selection-title">Choose a product first</h1>
                    <p>
                      Open a real product from the catalog before configuring production routing.
                    </p>
                    <button
                      className="admin-primary-button"
                      type="button"
                      onClick={() => navigate('products')}
                    >
                      Open Products
                    </button>
                  </section>
                )
              ) : route === 'products' ? (
                <ProductsPage
                  context={context}
                  products={state.products}
                  onCreate={createProduct}
                  onConfigure={(id) => guard.request(() => onOpenProductConfiguration(id))}
                />
              ) : route === 'funnels-links' ? (
                funnelsLinksRestricted ? (
                  <section
                    className="admin-state-card"
                    aria-labelledby="admin-funnels-links-restricted-title"
                  >
                    <span className="admin-state-icon">
                      <ShieldX size={30} aria-hidden="true" />
                    </span>
                    <p className="admin-eyebrow">RESTRICTED WORKSPACE</p>
                    <h1 id="admin-funnels-links-restricted-title">
                      Funnels &amp; Links access restricted
                    </h1>
                    <p>
                      Support accounts cannot access protected product routing or issued partner
                      links. Ask an Owner or Operations administrator when routing assistance is
                      required.
                    </p>
                    <button
                      className="admin-secondary-button"
                      type="button"
                      onClick={() => navigate('overview')}
                    >
                      Open Overview
                    </button>
                  </section>
                ) : (
                  <FunnelsLinksPage
                    context={context}
                    products={state.products}
                    gateway={effectiveGateway}
                    onOpenProducts={() => navigate('products')}
                    onOpenProductConfiguration={onOpenProductConfiguration}
                  />
                )
              ) : route === 'attribution' || route === 'data-health' ? (
                observabilityRestricted ? (
                  <section
                    className="admin-state-card"
                    aria-labelledby="admin-observability-restricted-title"
                  >
                    <span className="admin-state-icon">
                      <ShieldX size={30} aria-hidden="true" />
                    </span>
                    <p className="admin-eyebrow">RESTRICTED WORKSPACE</p>
                    <h1 id="admin-observability-restricted-title">
                      Operational reporting access restricted
                    </h1>
                    <p>
                      Support accounts cannot access platform-wide attribution or processing health.
                      Ask an Owner, Operations, Finance, or Analyst administrator when an aggregate
                      report is required.
                    </p>
                    <button
                      className="admin-secondary-button"
                      type="button"
                      onClick={() => navigate('overview')}
                    >
                      Open Overview
                    </button>
                  </section>
                ) : route === 'attribution' ? (
                  <AttributionPage
                    products={state.products}
                    gateway={effectiveGateway}
                    onOpenFunnelsLinks={() => navigate('funnels-links')}
                  />
                ) : (
                  <DataHealthPage
                    gateway={effectiveGateway}
                    onOpenFunnelsLinks={() => navigate('funnels-links')}
                  />
                )
              ) : route === 'subscriptions' ? (
                <SubscriptionsPage
                  key={context.userId}
                  role={context.role}
                  products={state.products}
                  gateway={effectiveGateway}
                />
              ) : route === 'payouts' ? (
                <PayoutsPage key={context.userId} role={context.role} gateway={effectiveGateway} />
              ) : route === 'affiliates' || route === 'affiliate-detail' ? (
                <AffiliatesPage
                  key={context.userId}
                  context={context}
                  gateway={effectiveGateway}
                  affiliateId={route === 'affiliate-detail' ? affiliateId : null}
                  onOpenAffiliate={(nextAffiliateId) => onOpenAffiliate?.(nextAffiliateId)}
                  onCloseAffiliate={() => navigate('affiliates')}
                />
              ) : route === 'settings' ? (
                settingsRestricted ? (
                  <section
                    className="admin-state-card"
                    aria-labelledby="admin-settings-restricted-title"
                  >
                    <span className="admin-state-icon">
                      <ShieldX size={30} aria-hidden="true" />
                    </span>
                    <p className="admin-eyebrow">RESTRICTED WORKSPACE</p>
                    <h1 id="admin-settings-restricted-title">
                      Platform Settings access restricted
                    </h1>
                    <p>
                      Support accounts cannot read or change production routing configuration. Ask
                      an Owner or Operations administrator when configuration assistance is
                      required.
                    </p>
                    <button
                      className="admin-secondary-button"
                      type="button"
                      onClick={() => navigate('overview')}
                    >
                      Open Overview
                    </button>
                  </section>
                ) : (
                  <PlatformSettingsPage context={context} gateway={effectiveGateway} />
                )
              ) : (
                <AdminOverview
                  products={state.products}
                  onOpenProducts={() => navigate('products')}
                />
              )
            ) : (
              <AdminState
                status={state.status}
                message={state.error?.message ?? null}
                onRetry={retry}
                onSwitchToPartner={() => void safelySwitchToPartner()}
              />
            )}
          </main>

          <footer className="admin-footer">
            <span>© 2026 KissMyApps</span>
            <span>Internal administration · Protected actions only</span>
          </footer>
        </div>
      </div>
      {guard.dialog}
    </div>
  )
}

export default AdminPortalApp
