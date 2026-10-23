import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChartNoAxesColumn,
  CircleAlert,
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
  type AdminReadinessBlockerCode,
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
import { SetupProgress, SetupStepFooter, SetupStepList, SetupStepPanel } from './SetupWizard'
import { initialSetupStep, setupSteps, stepForBlocker, type SetupStepId } from './setupSteps'
import './ProductSetup.css'

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
  onOpenStats?: () => void
  onOpenSettings?: () => void
}>

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
  onOpenStats,
  onOpenSettings,
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
  const focusStepHeading = useRef(false)
  const [stepVisit, setStepVisit] = useState<{
    id: SetupStepId
    completeOnArrival: boolean
  } | null>(null)
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

  const configuration = state.configuration
  const steps = configuration ? setupSteps(configuration) : null
  const numberedTotal = steps?.filter((step) => step.number !== null).length ?? 0
  if (steps && (!stepVisit || !steps.some((step) => step.id === stepVisit.id))) {
    const id = initialSetupStep(steps)
    // Opening the first unfinished step is derived during render, not in an effect.
    setStepVisit({
      id,
      completeOnArrival: steps.find((step) => step.id === id)?.state === 'complete',
    })
  }
  const activeId = stepVisit?.id ?? null

  function openStep(id: SetupStepId) {
    if (!steps) return
    setStepVisit({
      id,
      completeOnArrival: steps.find((step) => step.id === id)?.state === 'complete',
    })
    focusStepHeading.current = true
  }

  useEffect(() => {
    if (!focusStepHeading.current || !activeId) return
    focusStepHeading.current = false
    const heading = document.getElementById(`admin-setup-step-${activeId}-title`)
    heading?.focus({ preventScroll: true })
    pageRoot.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [activeId])

  const resolveBlocker = (code: AdminReadinessBlockerCode) => {
    if ((code === 'tracking_not_configured' || code === 'tracking_disabled') && onOpenSettings)
      return { label: 'Open Settings', open: onOpenSettings }
    const id = stepForBlocker(code)
    const target = id ? steps?.find((step) => step.id === id) : null
    return target && target.id !== 'launch'
      ? { label: `Go to ${target.title}`, open: () => openStep(target.id) }
      : null
  }

  const sectionPendingKey =
    pendingKey ?? (state.refreshing || state.error ? 'configuration:refresh' : null)

  function stepContent(id: SetupStepId) {
    if (!configuration || !configurationGateway) return null
    switch (id) {
      case 'funnel':
        return (
          <FunnelSection
            configuration={configuration}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={sectionPendingKey}
            runAction={runAction}
          />
        )
      case 'sources':
        return (
          <CampaignSourcesSection
            configuration={configuration}
            sources={state.sources}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={sectionPendingKey}
            runAction={runAction}
          />
        )
      case 'payments':
        return (
          <>
            <MerchantConnectionsSection productId={productId} canManage={canManage} />
            <BillingOffersSection
              configuration={configuration}
              gateway={configurationGateway}
              canManage={canManage}
              pendingKey={sectionPendingKey}
              runAction={runAction}
            />
          </>
        )
      case 'agreement':
        return (
          <AgreementSection
            configuration={configuration}
            affiliates={state.affiliates}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={sectionPendingKey}
            runAction={runAction}
          />
        )
      case 'approval':
        return (
          <TrackingModeSection
            configuration={configuration}
            gateway={configurationGateway}
            canManageMode={canManageTrackingMode}
            pendingKey={sectionPendingKey}
            runAction={runAction}
          />
        )
      case 'launch':
        return (
          <LaunchSection
            configuration={configuration}
            affiliates={state.affiliates}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={sectionPendingKey}
            runAction={runAction}
            resolveBlocker={resolveBlocker}
          />
        )
      case 'settings':
        return (
          <>
            {!trackingOnlySelected && (
              <TrackingModeSection
                configuration={configuration}
                gateway={configurationGateway}
                canManageMode={canManageTrackingMode}
                pendingKey={sectionPendingKey}
                runAction={runAction}
              />
            )}
            <DeleteProductZone
              productId={configuration.product.id}
              productSlug={configuration.product.slug}
              productName={configuration.product.name}
              gateway={gateway}
              canManage={canManage}
              busy={Boolean(pendingKey)}
              pendingKey={pendingKey}
              onDeleted={onBack}
              runAction={runAction}
            />
          </>
        )
    }
  }

  const platformTrackingMissing =
    configuration && (!configuration.tracking.baseUrl || !configuration.tracking.enabled)

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
          <p className="admin-eyebrow">PRODUCT SETUP</p>
          <h1 id="admin-product-config-title">{configuration?.product.name ?? 'Product setup'}</h1>
          <p>
            {trackingOnlySelected
              ? 'Tracking-only product: redirects and attribution run, but checkout, commissions, and payouts stay off.'
              : 'Set up this product one step at a time. Nothing goes live until you confirm it on the Go live step.'}
          </p>
        </div>
        <div className="admin-setup-heading-meta">
          {configuration && (
            <span
              className={`admin-status-badge admin-status-${configuration.product.status}`}
              title="Product status"
            >
              {configuration.product.status}
            </span>
          )}
          <span className="admin-heading-chip">
            <ShieldCheck size={16} aria-hidden="true" />{' '}
            {trackingOnlySelected ? 'Tracking-only product' : 'Commercial product'}
          </span>
          {configuration && onOpenStats && (
            <button
              className="admin-secondary-button"
              type="button"
              onClick={onOpenStats}
              disabled={Boolean(pendingKey)}
            >
              <ChartNoAxesColumn size={16} aria-hidden="true" /> View stats
            </button>
          )}
        </div>
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
        ) : configuration && state.error ? (
          <>
            <span>
              Your change may have been saved, but the latest setup could not be loaded. Existing
              values are shown and actions are paused until a refresh succeeds.
            </span>{' '}
            <button type="button" className="admin-text-button" onClick={reload}>
              Retry refresh
            </button>
          </>
        ) : null}
      </div>

      {state.status !== 'ready' ||
      !configuration ||
      !configurationGateway ||
      !steps ||
      !activeId ? (
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
          <SetupProgress steps={steps} />
          {platformTrackingMissing && (
            <div className="admin-inline-notice admin-setup-platform-notice" role="note">
              <CircleAlert size={18} aria-hidden="true" />
              <p>
                <strong>Platform tracking is not switched on yet.</strong> An Owner sets the
                tracking domain in Settings. You can finish every step here, but partner links
                cannot be issued until tracking is on.
              </p>
              {onOpenSettings && (
                <button className="admin-text-button" type="button" onClick={onOpenSettings}>
                  Open Settings
                </button>
              )}
            </div>
          )}
          <div className="admin-setup-layout">
            <SetupStepList steps={steps} activeId={activeId} onSelect={openStep} />
            <fieldset
              className="admin-setup-panels admin-action-fieldset"
              disabled={Boolean(pendingKey) || state.refreshing || Boolean(state.error)}
              aria-busy={Boolean(pendingKey) || state.refreshing}
            >
              {steps.map((step) => {
                const numbered = steps.filter((candidate) => candidate.number !== null)
                const position = numbered.findIndex((candidate) => candidate.id === step.id)
                const previous =
                  step.number === null
                    ? (numbered.at(-1) ?? null)
                    : (numbered[position - 1] ?? null)
                const next = step.number === null ? null : (numbered[position + 1] ?? null)
                const active = step.id === activeId
                return (
                  <SetupStepPanel
                    key={step.id}
                    step={step}
                    total={numberedTotal}
                    active={active}
                    single={step.id !== 'payments' && step.id !== 'settings'}
                    footer={
                      <SetupStepFooter
                        step={step}
                        previous={previous}
                        next={next}
                        completedHere={
                          active && step.state === 'complete' && !stepVisit?.completeOnArrival
                        }
                        onSelect={openStep}
                      />
                    }
                  >
                    {stepContent(step.id)}
                  </SetupStepPanel>
                )
              })}
            </fieldset>
          </div>
        </ConfigurationErrorContext.Provider>
      )}
    </section>
  )
}
