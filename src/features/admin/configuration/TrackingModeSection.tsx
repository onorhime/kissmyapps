import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, FlaskConical, LoaderCircle, LockKeyhole } from 'lucide-react'
import type { AdminConfigurationGateway, AdminProductConfiguration } from '../api'
import type { ConfigurationActionRunner } from './actionTypes'

type TrackingModeAction = 'enable' | 'reapprove' | 'commercial'

function formattedTimestamp(value: string | null): string {
  if (!value) return 'Not approved'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
}

export function TrackingModeSection({
  configuration,
  gateway,
  canManageMode,
  pendingKey,
  runAction,
}: {
  configuration: AdminProductConfiguration
  gateway: AdminConfigurationGateway
  canManageMode: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
}) {
  const [confirmation, setConfirmation] = useState<TrackingModeAction | null>(null)
  const status = useRef<HTMLSpanElement | null>(null)
  const actionButton = useRef<HTMLButtonElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  const focusStatusAfterReload = useRef(false)
  const trackingOnly = configuration.product.trackingMode === 'tracking_only'
  const trackingOnlyReady = configuration.readiness.trackingOnlyReady
  const busy = pendingKey?.startsWith('tracking-mode:') ?? false

  useEffect(() => {
    if (!focusStatusAfterReload.current) return
    status.current?.focus({ preventScroll: true })
    focusStatusAfterReload.current = false
  }, [configuration.product.trackingMode, configuration.product.updatedAt])

  function requestConfirmation(action: TrackingModeAction) {
    if (!canManageMode || busy) return
    setConfirmation(action)
    queueMicrotask(() => confirmButton.current?.focus({ preventScroll: true }))
  }

  function cancelConfirmation() {
    setConfirmation(null)
    queueMicrotask(() => actionButton.current?.focus({ preventScroll: true }))
  }

  async function changeMode(action: TrackingModeAction) {
    const mode = action === 'commercial' ? 'commercial' : 'tracking_only'
    const changed = await runAction(
      `tracking-mode:${action}`,
      () =>
        gateway.setProductTrackingMode({
          productId: configuration.product.id,
          mode,
          expectedUpdatedAt: configuration.product.updatedAt,
        }),
      action === 'commercial'
        ? 'Commercial mode restored. Any new commercial link must pass the full launch gates.'
        : action === 'reapprove'
          ? 'Tracking-only mode re-approved against the current live default funnel.'
          : 'Tracking-only mode enabled for the current live default funnel.',
    )
    if (changed) {
      setConfirmation(null)
      focusStatusAfterReload.current = true
    }
  }

  const actionCopy =
    confirmation === 'commercial'
      ? {
          title: 'Return to commercial mode?',
          body: 'This is allowed only before the first tracking-only click or event. After demo traffic exists, create a separate commercial product so test attribution can never become payable.',
          button: 'Confirm commercial mode',
        }
      : confirmation === 'reapprove'
        ? {
            title: 'Approve the current demo funnel?',
            body: 'This replaces the saved funnel snapshot. If its destination changes again, tracking-only links will fail closed until another approval.',
            button: 'Confirm funnel re-approval',
          }
        : {
            title: 'Enable tracking-only mode?',
            body: 'The current live default HTTPS funnel will be approved for non-commercial testing. Checkout, purchase qualification, commissions, and payouts remain disabled.',
            button: 'Confirm tracking-only mode',
          }

  return (
    <section
      className={`admin-config-section admin-tracking-mode admin-tracking-mode-${
        trackingOnly ? 'tracking-only' : 'commercial'
      }`}
      aria-labelledby="admin-tracking-mode-title"
    >
      <div className="admin-config-section-heading admin-tracking-mode-heading">
        <span className="admin-panel-icon">
          <FlaskConical size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">PRODUCT MODE</p>
          <h2 id="admin-tracking-mode-title">Tracking-only testing</h2>
          <p>
            Test redirects, attribution dimensions, and browser events on production infrastructure
            before checkout is connected.
          </p>
        </div>
        <span
          ref={status}
          tabIndex={-1}
          className={`admin-mode-badge admin-mode-badge-${trackingOnly ? 'test' : 'commercial'}`}
        >
          {trackingOnly ? 'Tracking only' : 'Commercial'}
        </span>
      </div>

      <div className="admin-tracking-mode-grid">
        <div>
          <strong>{trackingOnly ? 'Available for testing' : 'Current behavior'}</strong>
          <p>
            {trackingOnly
              ? 'Server-issued redirects, source and campaign attribution, and approved browser funnel events.'
              : 'Links continue to require verified billing and launch-ready signed partner terms.'}
          </p>
        </div>
        <div>
          <strong>
            {trackingOnly ? 'Commercial activity disabled' : 'Tracking-only mode is off'}
          </strong>
          <p>
            {trackingOnly
              ? 'No checkout sessions, qualified purchases, commissions, or payouts can be created in this mode.'
              : 'Nothing is bypassed. Existing production launch gates remain unchanged.'}
          </p>
        </div>
      </div>

      {trackingOnly && (
        <dl className="admin-tracking-mode-status">
          <div>
            <dt>Approved funnel snapshot</dt>
            <dd className={trackingOnlyReady ? 'admin-mode-ready' : 'admin-mode-stale'}>
              {trackingOnlyReady ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <CircleAlert size={15} aria-hidden="true" />
              )}
              {trackingOnlyReady ? 'Current' : 'Changed — re-approval required'}
            </dd>
          </div>
          <div>
            <dt>Owner approval</dt>
            <dd>{formattedTimestamp(configuration.product.trackingOnlyApprovedAt)}</dd>
          </div>
        </dl>
      )}

      {!canManageMode && (
        <div className="admin-inline-notice" role="note">
          <LockKeyhole size={18} aria-hidden="true" />
          <p>Only an Owner can approve or change the product tracking mode.</p>
        </div>
      )}

      {confirmation ? (
        <div
          className="admin-confirm-action admin-tracking-mode-confirm"
          role="group"
          aria-labelledby="admin-tracking-mode-confirm-title"
        >
          <p>
            <strong id="admin-tracking-mode-confirm-title">{actionCopy.title}</strong>
            <span>{actionCopy.body}</span>
          </p>
          <div className="admin-record-actions">
            <button
              ref={confirmButton}
              className="admin-primary-button"
              type="button"
              disabled={busy}
              onClick={() => void changeMode(confirmation)}
            >
              {busy && <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />}
              {busy ? 'Saving mode…' : actionCopy.button}
            </button>
            <button
              className="admin-secondary-button"
              type="button"
              disabled={busy}
              onClick={cancelConfirmation}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-tracking-mode-actions">
          {trackingOnly && !trackingOnlyReady && (
            <button
              ref={actionButton}
              className="admin-primary-button"
              type="button"
              disabled={!canManageMode || !configuration.readiness.hasLiveDefaultFunnel || busy}
              onClick={() => requestConfirmation('reapprove')}
            >
              Review funnel re-approval
            </button>
          )}
          <button
            ref={trackingOnlyReady || !trackingOnly ? actionButton : undefined}
            className={trackingOnly ? 'admin-secondary-button' : 'admin-primary-button'}
            type="button"
            disabled={
              !canManageMode ||
              (!trackingOnly && !configuration.readiness.hasLiveDefaultFunnel) ||
              busy
            }
            onClick={() => requestConfirmation(trackingOnly ? 'commercial' : 'enable')}
          >
            {trackingOnly ? 'Review commercial mode' : 'Review tracking-only mode'}
          </button>
        </div>
      )}

      {!trackingOnly && !configuration.readiness.hasLiveDefaultFunnel && (
        <small className="admin-gate-copy">
          Configure one live default HTTPS funnel before tracking-only mode can be approved.
        </small>
      )}
    </section>
  )
}
