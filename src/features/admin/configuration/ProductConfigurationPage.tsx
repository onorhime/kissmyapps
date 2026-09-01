import { useState } from 'react'
import {
  ArrowLeft,
  CircleAlert,
  DatabaseZap,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
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
import { ReadinessLinksSection } from './ReadinessLinksSection'
import { TrackingModeSection } from './TrackingModeSection'
import type { ConfigurationActionRunner } from './actionTypes'
import { useProductConfiguration } from './useProductConfiguration'

export type ProductConfigurationPageProps = Readonly<{
  productId: string
  context: AdminContext
  gateway?: AdminGateway
  onBack: () => void
  onProductRead?: (product: AdminProduct) => void
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

export function ProductConfigurationPage({
  productId,
  context,
  gateway = adminGateway,
  onBack,
  onProductRead,
}: ProductConfigurationPageProps) {
  const configurationGateway = hasAdminConfigurationGateway(gateway) ? gateway : null
  const { state, reload } = useProductConfiguration({
    productId,
    gateway: configurationGateway,
    onProductRead,
  })
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  )
  const canManage = context.role === 'owner' || context.role === 'operations'
  const canManageTrackingMode = context.role === 'owner'
  const trackingOnlySelected = state.configuration?.product.trackingMode === 'tracking_only'

  const runAction: ConfigurationActionRunner = async <T,>(
    key: string,
    operation: () => Promise<AdminDataResult<T>>,
    successMessage: string,
  ) => {
    if (!canManage || pendingKey) return false
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
    setPendingKey(null)
    if (response.status === 'ready' && response.data) {
      setFeedback({ kind: 'success', message: successMessage })
      reload()
      return true
    }
    setFeedback({
      kind: 'error',
      message: response.error?.message ?? 'The production configuration was not changed.',
    })
    return false
  }

  return (
    <section className="admin-page admin-config-page" aria-labelledby="admin-product-config-title">
      <button className="admin-back-button" type="button" onClick={onBack}>
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
              ? 'Configure protected demo routing and attribution without enabling checkout, commissions, or payouts.'
              : 'Configure protected routing, attribution dimensions, commercial terms, and server-issued links without exposing raw destinations to partners.'}
          </p>
        </div>
        <span className="admin-heading-chip">
          <ShieldCheck size={16} aria-hidden="true" />{' '}
          {trackingOnlySelected
            ? 'Tracking only · production infrastructure'
            : 'Production controls'}
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
      {feedback && (
        <div
          className={`admin-config-feedback admin-config-feedback-${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          <CircleAlert size={17} aria-hidden="true" />
          <span>{feedback.message}</span>
          <button type="button" onClick={() => setFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {state.status !== 'ready' || !state.configuration || !configurationGateway ? (
        <ConfigurationState
          status={state.status === 'ready' ? 'error' : state.status}
          message={state.error?.message ?? null}
          onRetry={reload}
        />
      ) : (
        <div className="admin-config-stack">
          <TrackingModeSection
            configuration={state.configuration}
            gateway={configurationGateway}
            canManageMode={canManageTrackingMode}
            pendingKey={pendingKey}
            runAction={runAction}
          />
          <ReadinessLinksSection
            configuration={state.configuration}
            affiliates={state.affiliates}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={pendingKey}
            runAction={runAction}
          />
          <FunnelSection
            configuration={state.configuration}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={pendingKey}
            runAction={runAction}
          />
          {!trackingOnlySelected && (
            <BillingOffersSection
              configuration={state.configuration}
              gateway={configurationGateway}
              canManage={canManage}
              pendingKey={pendingKey}
              runAction={runAction}
            />
          )}
          <CampaignSourcesSection
            configuration={state.configuration}
            sources={state.sources}
            gateway={configurationGateway}
            canManage={canManage}
            pendingKey={pendingKey}
            runAction={runAction}
          />
          {!trackingOnlySelected && (
            <AgreementSection
              configuration={state.configuration}
              affiliates={state.affiliates}
              gateway={configurationGateway}
              canManage={canManage}
              pendingKey={pendingKey}
              runAction={runAction}
            />
          )}
        </div>
      )}
    </section>
  )
}
