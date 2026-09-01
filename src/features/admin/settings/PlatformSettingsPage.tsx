import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  ToggleLeft,
} from 'lucide-react'
import {
  ADMIN_TRACKING_ORIGIN,
  type AdminContext,
  type AdminDataError,
  type AdminGateway,
  type AdminPlatformSettings,
} from '../api'
import { usePlatformSettings } from './usePlatformSettings'

export type PlatformSettingsPageProps = Readonly<{
  context: AdminContext
  gateway: AdminGateway
}>

function normalizedHttpsOrigin(value: string): string | null {
  const candidate = value.trim()
  if (!candidate || candidate.length > 2048) return null

  try {
    const url = new URL(candidate)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

function normalizedTrackingOrigin(value: string): string | null {
  const normalized = normalizedHttpsOrigin(value)
  return normalized === ADMIN_TRACKING_ORIGIN ? normalized : null
}

function visibleOrigin(value: string | null): string {
  if (!value) return 'Not configured'
  return normalizedHttpsOrigin(value) ?? 'Configured value unavailable'
}

function visibleHost(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    return url.hostname ? url.host : 'Unavailable'
  } catch {
    return 'Unavailable'
  }
}

function formattedTimestamp(value: string | null): string {
  if (!value) return 'Not changed yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
}

function mutationFailureMessage(error: AdminDataError | null): string {
  if (error?.code === 'not_authenticated' || error?.code === 'not_authorized') {
    return 'This change was not authorized. Sign in again, then refresh settings before retrying.'
  }
  if (error?.code === 'not_configured' || error?.code === 'contract_unavailable') {
    return 'This change is unavailable in this deployment. Refresh settings after the service is restored.'
  }
  if (error?.code === 'invalid_state' || error?.code === 'conflict') {
    return 'Settings changed or launch readiness moved. The latest server state is being reloaded.'
  }
  return `${error?.message ?? 'Platform settings could not be updated.'} Refresh settings before retrying.`
}

function SettingsState({
  kind,
  message,
  onRetry,
}: {
  kind: 'loading' | 'unconfigured' | 'unauthorized' | 'error'
  message: string
  onRetry: () => void
}) {
  const loading = kind === 'loading'
  const unauthorized = kind === 'unauthorized'
  const Icon = loading ? LoaderCircle : unauthorized ? LockKeyhole : CircleAlert
  const title = loading
    ? 'Loading platform settings'
    : unauthorized
      ? 'Admin access required'
      : kind === 'unconfigured'
        ? 'Settings are not configured'
        : 'Settings could not be loaded'

  return (
    <div
      className={`admin-settings-state admin-settings-state-${kind}`}
      role={loading ? 'status' : 'alert'}
    >
      <span className="admin-state-icon">
        <Icon className={loading ? 'admin-spin' : ''} size={28} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      {kind === 'error' && (
        <button className="admin-primary-button" type="button" onClick={onRetry}>
          <RefreshCw size={17} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  )
}

function ReadinessSummary({ settings }: { settings: AdminPlatformSettings }) {
  const items = [
    ['Eligible product chains', settings.readiness.enableReadyProductCount],
    ['Commercial-ready chains', settings.readiness.commercialEnableReadyProductCount],
    ['Tracking-only-ready products', settings.readiness.trackingOnlyReadyProductCount],
    ['Active products', settings.readiness.activeProductCount],
    ['Live default funnels', settings.readiness.liveDefaultFunnelCount],
    ['Launch-ready agreements', settings.readiness.launchReadyAgreementCount],
    ['Verified active offers', settings.readiness.verifiedActiveOfferCount],
  ] as const
  const readinessStatus = settings.tracking.enabled
    ? settings.readiness.canEnable
      ? { className: 'enabled', label: 'Collection enabled', ready: true }
      : { className: 'drift', label: 'Enabled with drift', ready: false }
    : settings.readiness.canEnable
      ? { className: 'ready', label: 'Ready to enable', ready: true }
      : { className: 'blocked', label: 'Enablement blocked', ready: false }

  return (
    <section className="admin-panel admin-settings-readiness" aria-labelledby="settings-readiness">
      <div className="admin-settings-panel-heading">
        <div>
          <p className="admin-eyebrow">ENABLEMENT GATE</p>
          <h2 id="settings-readiness">Launch readiness</h2>
          <p>
            One complete commercial chain or one Owner-approved tracking-only chain can unlock
            collection.
          </p>
        </div>
        <span
          className={`admin-settings-status admin-settings-status-${readinessStatus.className}`}
        >
          {readinessStatus.ready ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <CircleAlert size={15} aria-hidden="true" />
          )}
          {readinessStatus.label}
        </span>
      </div>

      <dl className="admin-settings-readiness-grid">
        {items.map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count.toLocaleString('en-US')}</dd>
          </div>
        ))}
      </dl>

      <p className="admin-settings-evidence-note">
        These are existing database counts. Tracking-only readiness does not create offers, payment
        events, subscriptions, commissions, or payouts.
      </p>
    </section>
  )
}

export function PlatformSettingsPage({ context, gateway }: PlatformSettingsPageProps) {
  const { state, mutation, retry, configureTracking } = usePlatformSettings(gateway)
  const [scopedDraftOrigin, setScopedDraftOrigin] = useState({ scope: 'unavailable', value: '' })
  const [originError, setOriginError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<'enable' | 'disable' | null>(null)
  const focusAfterMutation = useRef<'enable' | 'disable' | null>(null)
  const originInput = useRef<HTMLInputElement | null>(null)
  const trackingStatus = useRef<HTMLSpanElement | null>(null)
  const enableButton = useRef<HTMLButtonElement | null>(null)
  const disableButton = useRef<HTMLButtonElement | null>(null)
  const confirmEnableButton = useRef<HTMLButtonElement | null>(null)
  const confirmDisableButton = useRef<HTMLButtonElement | null>(null)
  const canEdit = context.role === 'owner'
  const pending = mutation.status === 'pending'

  const settings = state.data
  const settingsScope = settings
    ? [settings.tracking.baseUrl ?? 'not-configured', settings.tracking.updatedAt ?? 'never'].join(
        '|',
      )
    : 'unavailable'
  const savedOrigin = settings ? normalizedTrackingOrigin(settings.tracking.baseUrl ?? '') : null
  const draftWasSuggested = settings?.tracking.baseUrl === null
  const draftOrigin =
    scopedDraftOrigin.scope === settingsScope
      ? scopedDraftOrigin.value
      : settings?.tracking.baseUrl === null
        ? ADMIN_TRACKING_ORIGIN
        : (savedOrigin ?? '')

  useEffect(() => {
    const requestedFocus = focusAfterMutation.current
    if (!requestedFocus || !settings) return
    const target =
      requestedFocus === 'disable' && settings.tracking.enabled
        ? disableButton.current
        : requestedFocus === 'enable' && !settings.tracking.enabled
          ? enableButton.current
          : null
    ;(target ?? trackingStatus.current)?.focus({ preventScroll: true })
    focusAfterMutation.current = null
  }, [settings])

  function updateDraft(value: string) {
    setScopedDraftOrigin({ scope: settingsScope, value })
    setOriginError(null)
    setSuccessMessage(null)
    setConfirmation(null)
  }

  async function submitOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || !settings || pending) return

    const normalized = normalizedTrackingOrigin(draftOrigin)
    if (!normalized) {
      setOriginError(`Enter exactly ${ADMIN_TRACKING_ORIGIN}. Other HTTPS origins are not allowed.`)
      queueMicrotask(() => originInput.current?.focus({ preventScroll: true }))
      return
    }

    setOriginError(null)
    setSuccessMessage(null)
    setConfirmation(null)
    const result = await configureTracking({
      baseUrl: normalized,
      enabled: settings.tracking.enabled,
    })
    if (result.status === 'ready' && result.data) {
      setSuccessMessage(
        result.data.tracking.enabled
          ? 'Tracking origin saved. Collection remains enabled.'
          : 'Tracking origin saved. Collection remains disabled.',
      )
    }
  }

  function requestDisableConfirmation() {
    if (!canEdit || !settings || !settings.tracking.enabled || pending) return
    setSuccessMessage(null)
    setConfirmation('disable')
    queueMicrotask(() => confirmDisableButton.current?.focus({ preventScroll: true }))
  }

  function cancelDisable() {
    setConfirmation(null)
    queueMicrotask(() => disableButton.current?.focus({ preventScroll: true }))
  }

  async function confirmDisable() {
    if (!canEdit || !settings || !settings.tracking.enabled || pending) return
    setSuccessMessage(null)
    const result = await configureTracking({
      baseUrl: settings.tracking.baseUrl,
      enabled: false,
    })
    setConfirmation(null)
    if (result.status === 'ready' && result.data) {
      setSuccessMessage('Tracking disabled. Saved host configuration was retained.')
      focusAfterMutation.current = 'enable'
    } else {
      focusAfterMutation.current = 'disable'
    }
  }

  function requestEnableConfirmation() {
    if (!canEdit || !settings?.readiness.canEnable || settings.tracking.enabled || pending) return
    setSuccessMessage(null)
    setConfirmation('enable')
    queueMicrotask(() => confirmEnableButton.current?.focus({ preventScroll: true }))
  }

  function cancelEnable() {
    setConfirmation(null)
    queueMicrotask(() => enableButton.current?.focus({ preventScroll: true }))
  }

  async function confirmEnable() {
    if (
      !canEdit ||
      !settings ||
      !settings.readiness.canEnable ||
      settings.tracking.enabled ||
      !savedOrigin ||
      pending
    ) {
      return
    }

    setSuccessMessage(null)
    const result = await configureTracking({ baseUrl: savedOrigin, enabled: true })
    setConfirmation(null)
    if (result.status === 'ready' && result.data) {
      setSuccessMessage('Tracking enabled for the saved production origin.')
      focusAfterMutation.current = 'disable'
    } else {
      focusAfterMutation.current = 'enable'
    }
  }

  function cancelConfirmationOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || pending) return
    event.preventDefault()
    if (confirmation === 'enable') cancelEnable()
    if (confirmation === 'disable') cancelDisable()
  }

  function refreshSettings() {
    setOriginError(null)
    setSuccessMessage(null)
    setConfirmation(null)
    retry()
  }

  return (
    <section className="admin-page admin-settings-page" aria-labelledby="admin-settings-title">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">PLATFORM CONTROL</p>
          <h1 id="admin-settings-title">Settings</h1>
          <p>
            Configure the production tracking origin and inspect the server-enforced launch gate
            without creating placeholder commercial data.
          </p>
        </div>
        <div className="admin-settings-heading-actions">
          {state.status === 'ready' && settings && (
            <button
              className="admin-secondary-button"
              type="button"
              disabled={state.refreshing || pending}
              onClick={refreshSettings}
            >
              <RefreshCw
                className={state.refreshing ? 'admin-spin' : ''}
                size={16}
                aria-hidden="true"
              />
              {state.refreshing ? 'Refreshing…' : 'Refresh settings'}
            </button>
          )}
          <span className="admin-heading-chip">
            {canEdit ? (
              <ServerCog size={16} aria-hidden="true" />
            ) : (
              <LockKeyhole size={16} aria-hidden="true" />
            )}
            {canEdit ? 'Owner control' : 'Protected read only'}
          </span>
        </div>
      </header>

      {state.status === 'loading' ? (
        <SettingsState
          kind="loading"
          message="Reading protected platform configuration. No default is presented as saved."
          onRetry={refreshSettings}
        />
      ) : state.status === 'unconfigured' ? (
        <SettingsState
          kind="unconfigured"
          message="The protected settings contract is not available in this deployment yet."
          onRetry={refreshSettings}
        />
      ) : state.status === 'unauthorized' ? (
        <SettingsState
          kind="unauthorized"
          message="This account does not have permission to read platform settings."
          onRetry={refreshSettings}
        />
      ) : state.status !== 'ready' || !settings ? (
        <SettingsState
          kind="error"
          message={state.error?.message ?? 'Platform settings could not be loaded safely.'}
          onRetry={refreshSettings}
        />
      ) : (
        <>
          <div className="admin-settings-layout">
            <section
              className="admin-panel admin-settings-tracking"
              aria-labelledby="tracking-host"
            >
              <div className="admin-settings-panel-heading">
                <div>
                  <p className="admin-eyebrow">TRACKING GATEWAY</p>
                  <h2 id="tracking-host">Production origin</h2>
                  <p>
                    This deployment requires exactly {ADMIN_TRACKING_ORIGIN}; other HTTPS origins
                    are rejected.
                  </p>
                </div>
                <span
                  ref={trackingStatus}
                  tabIndex={-1}
                  className={`admin-settings-status admin-settings-status-${
                    settings.tracking.enabled ? 'enabled' : 'disabled'
                  }`}
                >
                  <span aria-hidden="true" />
                  {settings.tracking.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              <dl className="admin-settings-current">
                <div>
                  <dt>Saved origin</dt>
                  <dd>{visibleOrigin(settings.tracking.baseUrl)}</dd>
                </div>
                <div>
                  <dt>Last changed</dt>
                  <dd>{formattedTimestamp(settings.tracking.updatedAt)}</dd>
                </div>
              </dl>

              {canEdit ? (
                <form className="admin-settings-form" onSubmit={submitOrigin} noValidate>
                  <div className="admin-field">
                    <label htmlFor="admin-tracking-origin">Required tracking origin</label>
                    <input
                      id="admin-tracking-origin"
                      ref={originInput}
                      type="url"
                      inputMode="url"
                      value={draftOrigin}
                      onChange={(event) => updateDraft(event.target.value)}
                      maxLength={2048}
                      autoComplete="url"
                      spellCheck={false}
                      aria-invalid={Boolean(originError)}
                      aria-describedby={
                        originError ? 'admin-tracking-origin-error' : 'admin-tracking-origin-hint'
                      }
                    />
                    {originError ? (
                      <p className="admin-field-error" id="admin-tracking-origin-error">
                        {originError}
                      </p>
                    ) : (
                      <p className="admin-field-hint" id="admin-tracking-origin-hint">
                        {draftWasSuggested
                          ? `${ADMIN_TRACKING_ORIGIN} is the required value, shown as an unsaved suggestion.`
                          : `The only accepted origin is ${ADMIN_TRACKING_ORIGIN}. Saving preserves the collection state.`}
                      </p>
                    )}
                  </div>

                  <div className="admin-settings-actions">
                    <button
                      className="admin-primary-button"
                      type="submit"
                      disabled={
                        pending ||
                        (normalizedTrackingOrigin(draftOrigin) !== null &&
                          normalizedTrackingOrigin(draftOrigin) === savedOrigin)
                      }
                    >
                      {pending ? (
                        <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                      ) : (
                        <Save size={17} aria-hidden="true" />
                      )}
                      {pending ? 'Saving…' : 'Save origin'}
                    </button>

                    {settings.tracking.enabled ? (
                      <button
                        className="admin-secondary-button admin-settings-disable"
                        ref={disableButton}
                        type="button"
                        disabled={pending}
                        aria-expanded={confirmation === 'disable'}
                        aria-controls="admin-confirm-disable-tracking"
                        onClick={requestDisableConfirmation}
                      >
                        <ToggleLeft size={17} aria-hidden="true" /> Disable tracking
                      </button>
                    ) : settings.readiness.canEnable && savedOrigin ? (
                      <button
                        className="admin-secondary-button"
                        ref={enableButton}
                        type="button"
                        disabled={pending}
                        aria-expanded={confirmation === 'enable'}
                        aria-controls="admin-confirm-enable-tracking"
                        onClick={requestEnableConfirmation}
                      >
                        <ShieldCheck size={17} aria-hidden="true" /> Enable tracking
                      </button>
                    ) : null}
                  </div>
                </form>
              ) : (
                <div className="admin-inline-notice" role="note">
                  <LockKeyhole size={18} aria-hidden="true" />
                  <p>
                    Operations, Finance, and Analyst administrators can inspect this configuration.
                    Only an Owner can change it.
                  </p>
                </div>
              )}

              {!settings.tracking.enabled && !settings.readiness.canEnable && (
                <div className="admin-settings-blocked" role="note">
                  <CircleAlert size={18} aria-hidden="true" />
                  <p>
                    Tracking cannot be enabled until the server reports one complete commercial
                    chain or one valid Owner-approved tracking-only product chain.
                  </p>
                </div>
              )}

              {confirmation === 'enable' &&
                settings.readiness.canEnable &&
                !settings.tracking.enabled && (
                  <div
                    className="admin-settings-confirm"
                    id="admin-confirm-enable-tracking"
                    role="alert"
                    aria-labelledby="admin-confirm-enable-title"
                    onKeyDown={cancelConfirmationOnEscape}
                  >
                    <div>
                      <strong id="admin-confirm-enable-title">Confirm production collection</strong>
                      <p>
                        Enable tracking for the saved origin{' '}
                        {visibleOrigin(settings.tracking.baseUrl)}? This changes collection state
                        but does not create traffic or payment data. Tracking-only products remain
                        unable to create checkout, commission, or payout records.
                      </p>
                    </div>
                    <div className="admin-settings-confirm-actions">
                      <button
                        className="admin-primary-button"
                        ref={confirmEnableButton}
                        type="button"
                        disabled={pending}
                        onClick={confirmEnable}
                      >
                        {pending ? (
                          <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                        ) : (
                          <ShieldCheck size={17} aria-hidden="true" />
                        )}
                        {pending ? 'Enabling…' : 'Confirm enable tracking'}
                      </button>
                      <button
                        className="admin-secondary-button"
                        type="button"
                        disabled={pending}
                        onClick={cancelEnable}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              {confirmation === 'disable' && settings.tracking.enabled && (
                <div
                  className="admin-settings-confirm admin-settings-confirm-disable"
                  id="admin-confirm-disable-tracking"
                  role="alert"
                  aria-labelledby="admin-confirm-disable-title"
                  onKeyDown={cancelConfirmationOnEscape}
                >
                  <div>
                    <strong id="admin-confirm-disable-title">Confirm collection shutdown</strong>
                    <p>
                      Disable tracking now? The canonical origin remains saved, but new tracking
                      redirects will fail closed until collection is enabled again.
                    </p>
                  </div>
                  <div className="admin-settings-confirm-actions">
                    <button
                      className="admin-primary-button admin-settings-disable"
                      ref={confirmDisableButton}
                      type="button"
                      disabled={pending}
                      onClick={confirmDisable}
                    >
                      {pending ? (
                        <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                      ) : (
                        <ToggleLeft size={17} aria-hidden="true" />
                      )}
                      {pending ? 'Disabling…' : 'Confirm disable tracking'}
                    </button>
                    <button
                      className="admin-secondary-button"
                      type="button"
                      disabled={pending}
                      onClick={cancelDisable}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="admin-settings-feedback" aria-live="polite">
                {successMessage && (
                  <p className="admin-feedback-success" role="status">
                    <CheckCircle2 size={17} aria-hidden="true" /> {successMessage}
                  </p>
                )}
                {mutation.status === 'failed' && (
                  <p className="admin-feedback-error" role="alert">
                    <CircleAlert size={17} aria-hidden="true" />
                    {mutationFailureMessage(mutation.error)}
                  </p>
                )}
              </div>
            </section>

            <section className="admin-panel admin-settings-hosts" aria-labelledby="expected-hosts">
              <div className="admin-settings-panel-heading">
                <div>
                  <p className="admin-eyebrow">EXPECTED HOSTS</p>
                  <h2 id="expected-hosts">Production routing</h2>
                  <p>Public host names expected by this platform configuration.</p>
                </div>
                <Globe2 size={22} aria-hidden="true" />
              </div>
              <dl>
                <div>
                  <dt>Partner dashboard</dt>
                  <dd>{visibleHost(settings.expectedHosts.partner)}</dd>
                </div>
                <div>
                  <dt>Admin dashboard</dt>
                  <dd>{visibleHost(settings.expectedHosts.admin)}</dd>
                </div>
                <div>
                  <dt>Tracking gateway</dt>
                  <dd>{visibleHost(settings.expectedHosts.tracking)}</dd>
                </div>
              </dl>
            </section>
          </div>

          <ReadinessSummary settings={settings} />

          <aside className="admin-settings-proof-limit" aria-labelledby="settings-proof-limit">
            <ServerCog size={20} aria-hidden="true" />
            <div>
              <h2 id="settings-proof-limit">What saving this cannot prove</h2>
              <p>
                A saved host is database configuration only. It does not prove DNS resolution, TLS,
                reverse-proxy routing, Edge Function deployment, secret configuration, or live
                traffic collection.
              </p>
            </div>
          </aside>
        </>
      )}
    </section>
  )
}
