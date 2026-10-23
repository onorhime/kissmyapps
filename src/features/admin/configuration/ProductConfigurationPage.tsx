import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  DatabaseZap,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import {
  adminGateway,
  hasAdminConfigurationGateway,
  type AdminContext,
  type AdminDataResult,
  type AdminGateway,
  type AdminProduct,
} from '../api'
import { AgreementSection } from './AgreementSection'
import { BillingOffersSection } from './BillingOffersSection'
import { CampaignSourcesSection } from './CampaignSourcesSection'
import { FunnelSection } from './FunnelSection'
import { LaunchSection } from './LaunchSection'
import { TrackingModeSection } from './TrackingModeSection'
import type { ConfigurationActionRunner } from './actionTypes'
import { useProductConfiguration } from './useProductConfiguration'
import { ActionNotice } from '../../../components/ActionNotice'
import { revealInvalidField } from '../../../components/formFeedback'
import { discardScopeDrafts, markFormSaved } from '../../../components/useFormNavigationGuard'
import { ConfigurationReview } from './ConfigurationReview'
import { ConfigurationErrorContext } from './configurationErrorContext'
import { MerchantConnectionsSection } from '../../merchant-connections/MerchantConnectionsSection'

function DeleteProductZone({
  productId,
  productSlug,
  productName,
  gateway,
  canManage,
  busy,
  pendingKey,
  onDeleted,
  runAction,
}: {
  productId: string
  productSlug: string
  productName: string
  gateway: AdminGateway
  canManage: boolean
  busy: boolean
  pendingKey: string | null
  onDeleted: () => void
  runAction: ConfigurationActionRunner
}) {
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [confirmValue, setConfirmValue] = useState('')
  const supportsDelete = typeof gateway.deleteProduct === 'function'
  const slugMatches = confirmValue.trim().toLowerCase() === productSlug.toLowerCase()

  async function confirmDelete() {
    if (!slugMatches || busy) return
    const deleted = await runAction(
      'product:delete',
      () => gateway.deleteProduct!({ productId, confirmation: confirmValue.trim() }),
      `${productSlug} and all of its pre-launch records were deleted.`,
    )
    if (deleted) {
      setConfirmation(null)
      onDeleted()
    }
  }

  if (!canManage || !supportsDelete) return null

  return (
    <section
      className="admin-config-section admin-danger-zone"
      aria-labelledby="admin-danger-title"
    >
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon admin-panel-icon-danger">
          <Trash2 size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">DANGER ZONE</p>
          <h2 id="admin-danger-title">Delete this product</h2>
          <p>
            Permanently removes this product with its funnels, campaigns, agreements, rules, offers,
            links, and tracking data. Blocked once real purchases, commissions, payouts, or signed
            agreements exist. Type the exact slug <strong>{productSlug}</strong> to confirm.
          </p>
        </div>
      </div>
      {confirmation && (
        <ConfigurationReview
          title="Confirm product deletion"
          description={`Delete ${productName} permanently? This cannot be undone.`}
          busy={busy}
          onCancel={() => setConfirmation(null)}
        >
          <p>
            <strong>Delete {productName} permanently?</strong>
            <span>This cannot be undone. Type the exact product slug to enable the button.</span>
          </p>
          <label className="admin-field">
            <span>Product slug</span>
            <input
              value={confirmValue}
              onChange={(event) => setConfirmValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="admin-record-actions">
            <button
              className="admin-primary-button admin-danger-button-solid"
              type="button"
              disabled={!slugMatches || busy}
              onClick={() => void confirmDelete()}
            >
              {pendingKey === 'product:delete' && (
                <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
              )}{' '}
              Delete product permanently
            </button>
            <button
              className="admin-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmation(null)
                setConfirmValue('')
              }}
            >
              Cancel
            </button>
          </div>
        </ConfigurationReview>
      )}
      <button
        className="admin-text-button admin-danger-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setConfirmValue('')
          setConfirmation('confirm')
        }}
      >
        <Trash2 size={15} aria-hidden="true" /> Delete this product
      </button>
    </section>
  )
}

export type ProductConfigurationPageProps = Readonly<{
  productId: string
  context: AdminContext
  gateway?: AdminGateway
  onBack: () => void
  onProductRead?: (product: AdminProduct) => void
}>

function CollapsibleSection({
  id,
  label,
  defaultOpen = false,
  children,
}: {
  id: string
  label: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={open ? 'admin-collapsible' : 'admin-collapsible admin-collapsible-closed'}>
      <button
        type="button"
        className="admin-collapse-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={16} aria-hidden="true" />
        <span className="sr-only">{open ? `Collapse ${label}` : `Expand ${label}`}</span>
      </button>
      <div id={id} className="admin-collapse-region">
        {children}
      </div>
    </div>
  )
}

function ConfigurationState({
  status,
  message,
  onRetry,
}: {
  status: 'loading' | 'not_found' | 'unauthorized' | 'unconfigured' | 'error'
  message: string | null
  onRetry: () => void
}) {
  const loading = status === 'loading'
  const title = loading
    ? 'Loading production configuration'
    : status === 'not_found'
      ? 'Product configuration not found'
      : status === 'unauthorized'
        ? 'Product configuration access required'
        : status === 'unconfigured'
          ? 'Configuration contracts are not available'
          : 'Configuration could not be loaded'
  return (
    <div className="admin-config-state" role={loading ? 'status' : undefined}>
      {loading ? (
        <LoaderCircle className="admin-spin" size={28} aria-hidden="true" />
      ) : (
        <DatabaseZap size={28} aria-hidden="true" />
      )}
      <h2>{title}</h2>
      <p>
        {message ??
          (loading
            ? 'Reading the protected server configuration. No fallback data will be used.'
            : 'The production configuration is unavailable.')}
      </p>
      {status === 'error' && (
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  )
}

export function ProductConfigurationPage(props: ProductConfigurationPageProps) {
  return (
    <ProductConfigurationContent
      key={`${props.context.userId}:${props.context.role}:${props.productId}`}
      {...props}
    />
  )
}

function ProductConfigurationContent({
  productId,
  context,
  gateway = adminGateway,
  onBack,
  onProductRead,
}: ProductConfigurationPageProps) {
  const configurationGateway = hasAdminConfigurationGateway(gateway) ? gateway : null
  const { state, reload, invalidate } = useProductConfiguration({
    productId,
    gateway: configurationGateway,
    onProductRead,
  })
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const actionLock = useRef(false)
  const pageRoot = useRef<HTMLElement>(null)
  const actionEpoch = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  )
  const canManage = context.role === 'owner' || context.role === 'operations'
  const canManageTrackingMode = context.role === 'owner'
  const trackingOnlySelected = state.configuration?.product.trackingMode === 'tracking_only'
  const clearReviewError = useCallback(
    () => setFeedback((current) => (current?.kind === 'error' ? null : current)),
    [],
  )
  useEffect(() => {
    actionEpoch.current += 1
    actionLock.current = false
    // A replacement gateway invalidates callbacks and all pending outcome UI from the old one.
    // eslint-disable-next-line react/set-state-in-effect
    setPendingKey(null)
    setFeedback(null)
  }, [gateway])

  const runAction: ConfigurationActionRunner = async <T,>(
    key: string,
    operation: () => Promise<AdminDataResult<T>>,
    successMessage: string,
  ) => {
    if (!canManage || actionLock.current || state.refreshing || state.error) return false
    actionLock.current = true
    const epoch = actionEpoch.current
    const submittedForm = document.activeElement?.closest('form') ?? null
    setPendingKey(key)
    setFeedback(null)
    let response: AdminDataResult<T>
    try {
      response = await operation()
    } catch {
      response = {
        data: null as T,
        status: 'error',
        error: {
          code: 'temporarily_unavailable',
          message: 'Admin data is temporarily unavailable.',
          retryable: true,
        },
      }
    }
    if (!mounted.current || epoch !== actionEpoch.current) return false
    actionLock.current = false
    setPendingKey(null)
    if (response.status === 'ready' && response.data) {
      // Billing edits restore a different, possibly unsaved create draft in the
      // same DOM form. Its original navigation baseline must remain unchanged.
      if (!key.startsWith('billing:update:')) markFormSaved(submittedForm)
      if (key === 'product:delete') discardScopeDrafts(pageRoot.current)
      setFeedback({ kind: 'success', message: successMessage })
      if (key !== 'product:delete') reload()
      return true
    }
    setFeedback({
      kind: 'error',
      message: response.error?.message ?? 'The production configuration was not changed.',
    })
    if (
      response.error &&
      ['not_authenticated', 'not_authorized', 'invalid_reference'].includes(response.error.code)
    )
      invalidate(response.error)
    return false
  }

  return (
    <section
      ref={pageRoot}
      className="admin-page admin-config-page"
      aria-labelledby="admin-product-config-title"
      onSubmitCapture={revealInvalidField}
      data-navigation-pending={Boolean(pendingKey)}
    >
      <button
        className="admin-back-button"
        type="button"
        onClick={onBack}
        disabled={Boolean(pendingKey)}
      >
        <ArrowLeft size={17} aria-hidden="true" /> Back to Products
      </button>
      <header className="admin-page-heading admin-config-page-heading">
        <div>
          <p className="admin-eyebrow">PRODUCT CONFIGURATION</p>
          <h1 id="admin-product-config-title">
            {state.configuration?.product.name ?? 'Production setup'}
          </h1>
          <p>
            {trackingOnlySelected
              ? 'This product is in tracking-only mode: redirects and attribution run, but checkout, commissions, and payouts stay disabled.'
              : 'Configure routing, attribution, commercial terms, and partner links. Production destinations stay admin-only.'}
          </p>
        </div>
        <span className="admin-heading-chip">
          <ShieldCheck size={16} aria-hidden="true" />{' '}
          {trackingOnlySelected ? 'Tracking-only product' : 'Production controls'}
        </span>
      </header>

      {!canManage && (
        <div className="admin-inline-notice admin-config-role-notice" role="note">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            {context.role === 'finance' || context.role === 'analyst'
              ? 'This role has read-only configuration access. Production destinations remain masked.'
              : 'This role cannot change product configuration.'}
          </p>
        </div>
      )}
      <ActionNotice notice={feedback} onDismiss={() => setFeedback(null)} />
      <div className="admin-refresh-status" aria-live="polite">
        {state.refreshing ? (
          'Refreshing configuration… Your place and drafts are preserved.'
        ) : state.configuration && state.error ? (
          <>
            <span>
              Changes may be saved, but the latest configuration could not be refreshed. Existing
              values are shown; actions are paused until refresh succeeds.
            </span>{' '}
            <button type="button" className="admin-text-button" onClick={reload}>
              Retry refresh
            </button>
          </>
        ) : null}
      </div>

      {state.status !== 'ready' || !state.configuration || !configurationGateway ? (
        <ConfigurationState
          status={state.status === 'ready' ? 'error' : state.status}
          message={state.error?.message ?? null}
          onRetry={reload}
        />
      ) : (
        <ConfigurationErrorContext.Provider
          value={{
            error: feedback?.kind === 'error' ? feedback.message : null,
            clear: clearReviewError,
          }}
        >
          <fieldset
            className="admin-config-stack admin-action-fieldset"
            disabled={Boolean(pendingKey) || state.refreshing || Boolean(state.error)}
            aria-busy={Boolean(pendingKey) || state.refreshing}
          >
            <CollapsibleSection id="collapse-funnels" label="funnels" defaultOpen>
              <FunnelSection
                configuration={state.configuration}
                gateway={configurationGateway}
                canManage={canManage}
                pendingKey={
                  pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
                }
                runAction={runAction}
              />
            </CollapsibleSection>
            <CollapsibleSection id="collapse-sources" label="sources and campaigns">
              <CampaignSourcesSection
                configuration={state.configuration}
                sources={state.sources}
                gateway={configurationGateway}
                canManage={canManage}
                pendingKey={
                  pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
                }
                runAction={runAction}
              />
            </CollapsibleSection>
            {!trackingOnlySelected && (
              <CollapsibleSection id="collapse-merchants" label="merchant Stripe connections">
                <MerchantConnectionsSection productId={productId} canManage={canManage} />
              </CollapsibleSection>
            )}
            {!trackingOnlySelected && (
              <CollapsibleSection id="collapse-billing" label="billing offers">
                <BillingOffersSection
                  configuration={state.configuration}
                  gateway={configurationGateway}
                  canManage={canManage}
                  pendingKey={
                    pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
                  }
                  runAction={runAction}
                />
              </CollapsibleSection>
            )}
            {!trackingOnlySelected && (
              <CollapsibleSection id="collapse-agreements" label="agreements">
                <AgreementSection
                  configuration={state.configuration}
                  affiliates={state.affiliates}
                  gateway={configurationGateway}
                  canManage={canManage}
                  pendingKey={
                    pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
                  }
                  runAction={runAction}
                />
              </CollapsibleSection>
            )}
            <CollapsibleSection id="collapse-launch" label="launch" defaultOpen>
              <LaunchSection
                configuration={state.configuration}
                affiliates={state.affiliates}
                gateway={configurationGateway}
                canManage={canManage}
                pendingKey={
                  pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
                }
                runAction={runAction}
              />
            </CollapsibleSection>
            <TrackingModeSection
              configuration={state.configuration}
              gateway={configurationGateway}
              canManageMode={canManageTrackingMode}
              pendingKey={
                pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)
              }
              runAction={runAction}
            />
            <DeleteProductZone
              productId={state.configuration.product.id}
              productSlug={state.configuration.product.slug}
              productName={state.configuration.product.name}
              gateway={gateway}
              canManage={canManage}
              busy={Boolean(pendingKey)}
              pendingKey={pendingKey}
              onDeleted={onBack}
              runAction={runAction}
            />
          </fieldset>
        </ConfigurationErrorContext.Provider>
      )}
    </section>
  )
}
