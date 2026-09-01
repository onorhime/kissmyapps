import { useMemo, useState } from 'react'
import {
  Check,
  CircleAlert,
  ExternalLink,
  Link2,
  LoaderCircle,
  Rocket,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { AdminAffiliate, AdminConfigurationGateway, AdminProductConfiguration } from '../api'
import {
  hasLaunchReadyActiveAgreement,
  hasLiveVerifiedActiveSubscriptionOffer,
  mainLinkReadiness,
  productActivationReadiness,
  readinessCopy,
} from './readiness'
import type { ConfigurationActionRunner } from './actionTypes'

function ChecklistItem({ passed, children }: { passed: boolean; children: React.ReactNode }) {
  return (
    <li className={passed ? 'admin-check-passed' : 'admin-check-blocked'}>
      <span>
        {passed ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
      </span>
      {children}
    </li>
  )
}

export function ReadinessLinksSection({
  configuration,
  affiliates,
  gateway,
  canManage,
  pendingKey,
  runAction,
}: {
  configuration: AdminProductConfiguration
  affiliates: readonly AdminAffiliate[]
  gateway: AdminConfigurationGateway
  canManage: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
}) {
  const [confirmActivation, setConfirmActivation] = useState(false)
  const [affiliateId, setAffiliateId] = useState('')
  const [confirmIssuance, setConfirmIssuance] = useState(false)
  const activation = productActivationReadiness(configuration)
  const issuance = mainLinkReadiness(configuration, affiliates)
  const eligibleAffiliates = useMemo(
    () => affiliates.filter((affiliate) => issuance.eligibleAffiliateIds.includes(affiliate.id)),
    [affiliates, issuance.eligibleAffiliateIds],
  )
  const selectedAffiliate = eligibleAffiliates.find((affiliate) => affiliate.id === affiliateId)
  const productActive = configuration.product.status === 'active'
  const trackingOnly = configuration.product.trackingMode === 'tracking_only'
  const hasVerifiedSubscription = hasLiveVerifiedActiveSubscriptionOffer(configuration)
  const hasLaunchReadyAgreement = hasLaunchReadyActiveAgreement(configuration)
  const busy = pendingKey?.startsWith('launch:') ?? false

  async function activateProduct() {
    const activated = await runAction(
      'launch:product:activate',
      () => gateway.activateProduct({ productId: configuration.product.id }),
      'Product activation was accepted and verified from the server.',
    )
    if (activated) setConfirmActivation(false)
  }

  async function issueMainLink() {
    if (!selectedAffiliate) return
    const issued = await runAction(
      'launch:main-link:issue',
      () =>
        gateway.issueMainLink({
          productId: configuration.product.id,
          affiliateId: selectedAffiliate.id,
        }),
      `Canonical main link issued for ${selectedAffiliate.publicName}.`,
    )
    if (issued) {
      setAffiliateId('')
      setConfirmIssuance(false)
    }
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-readiness-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <Rocket size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">
            {trackingOnly ? 'TRACKING-ONLY GATES' : 'PRODUCTION GATES'}
          </p>
          <h2 id="admin-readiness-title">
            {trackingOnly
              ? 'Demo readiness and main links'
              : 'Readiness, activation, and main links'}
          </h2>
          <p>
            {trackingOnly
              ? 'The server still requires an active product, approved funnel snapshot, canonical tracking switch, and active partner.'
              : 'These are separate server-validated actions. Saving configuration never launches the product automatically.'}
          </p>
        </div>
      </div>

      <div className="admin-config-two-columns admin-launch-grid">
        <article className="admin-config-subpanel">
          <div className="admin-subpanel-heading">
            <ShieldCheck size={19} aria-hidden="true" />
            <div>
              <h3>Product activation</h3>
              <p>The saved production origin and live default funnel are required.</p>
            </div>
          </div>
          <ul className="admin-readiness-list">
            <ChecklistItem passed={Boolean(configuration.tracking.baseUrl)}>
              Production tracking origin is configured; collection may remain disabled
            </ChecklistItem>
            <ChecklistItem passed={configuration.readiness.hasLiveDefaultFunnel}>
              One default HTTPS funnel is live
            </ChecklistItem>
            <ChecklistItem passed={['draft', 'paused'].includes(configuration.product.status)}>
              Product is in an activatable lifecycle state
            </ChecklistItem>
          </ul>
          {activation.blockers.length > 0 && !productActive && (
            <div className="admin-gate-summary">
              <CircleAlert size={17} aria-hidden="true" />
              <p>{activation.blockers.map((blocker) => readinessCopy[blocker]).join(' ')}</p>
            </div>
          )}
          {productActive ? (
            <p className="admin-success-banner">
              <Check size={17} aria-hidden="true" /> Product is active
            </p>
          ) : confirmActivation ? (
            <div
              className="admin-confirm-action"
              role="group"
              aria-label="Confirm product activation"
            >
              <p>
                Activate <strong>{configuration.product.name}</strong>{' '}
                {trackingOnly ? 'for tracking-only testing' : 'for production'}? This does not issue
                partner links.
              </p>
              <div className="admin-record-actions">
                <button
                  className="admin-primary-button"
                  type="button"
                  disabled={!activation.allowed || busy}
                  onClick={() => void activateProduct()}
                >
                  {pendingKey === 'launch:product:activate' && (
                    <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
                  )}{' '}
                  Confirm activation
                </button>
                <button
                  className="admin-secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmActivation(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="admin-primary-button"
              type="button"
              disabled={!canManage || !activation.allowed || busy}
              onClick={() => setConfirmActivation(true)}
            >
              Review product activation
            </button>
          )}
          <small className="admin-gate-copy">
            Server readiness is rechecked when activation is submitted.
          </small>
        </article>

        <article className="admin-config-subpanel">
          <div className="admin-subpanel-heading">
            <Link2 size={19} aria-hidden="true" />
            <div>
              <h3>Issue partner main link</h3>
              <p>
                {trackingOnly
                  ? 'The server can issue a non-commercial coded URL after the approved demo chain is ready.'
                  : 'The server requires verified billing and signed partner terms before it creates the canonical coded URL.'}
              </p>
            </div>
          </div>
          <ul className="admin-readiness-list">
            <ChecklistItem passed={productActive}>Product is active</ChecklistItem>
            {trackingOnly ? (
              <>
                <ChecklistItem passed={configuration.readiness.trackingOnlyReady}>
                  Current live default funnel matches the Owner-approved snapshot
                </ChecklistItem>
                <ChecklistItem passed={configuration.tracking.enabled}>
                  Canonical tracking collection is enabled
                </ChecklistItem>
                <ChecklistItem passed={configuration.readiness.trackingOnlyCanIssueLinks}>
                  Server tracking-only link gate is ready
                </ChecklistItem>
              </>
            ) : (
              <>
                <ChecklistItem
                  passed={
                    configuration.readiness.trackingReady &&
                    configuration.readiness.hasLiveDefaultFunnel
                  }
                >
                  Production routing is ready
                </ChecklistItem>
                <ChecklistItem
                  passed={configuration.readiness.hasActiveBillingOffer && hasVerifiedSubscription}
                >
                  An active live-verified subscription offer exists
                </ChecklistItem>
                <ChecklistItem
                  passed={configuration.readiness.hasActiveAgreement && hasLaunchReadyAgreement}
                >
                  A bilateral signed agreement has exactly one supported active purchase rule
                </ChecklistItem>
              </>
            )}
            <ChecklistItem passed={issuance.eligibleAffiliateIds.length > 0}>
              {trackingOnly
                ? 'An active partner without an existing main link is eligible'
                : 'An active partner with a launch-ready agreement is eligible'}
            </ChecklistItem>
          </ul>
          {issuance.blockers.length > 0 && (
            <div className="admin-gate-summary">
              <CircleAlert size={17} aria-hidden="true" />
              <p>{issuance.blockers.map((blocker) => readinessCopy[blocker]).join(' ')}</p>
            </div>
          )}
          <label className="admin-field">
            <span>Eligible partner</span>
            <select
              value={affiliateId}
              onChange={(event) => {
                setAffiliateId(event.target.value)
                setConfirmIssuance(false)
              }}
              disabled={!canManage || !issuance.allowed || busy}
            >
              <option value="">Choose a partner</option>
              {eligibleAffiliates.map((affiliate) => (
                <option value={affiliate.id} key={affiliate.id}>
                  {affiliate.publicName}
                </option>
              ))}
            </select>
          </label>
          {confirmIssuance && selectedAffiliate ? (
            <div
              className="admin-confirm-action"
              role="group"
              aria-label="Confirm main link issuance"
            >
              <p>
                Issue the server-owned main link for <strong>{selectedAffiliate.publicName}</strong>
                ? No destination, source, campaign, or Sub ID is accepted here.
                {trackingOnly && ' This link cannot create commercial facts.'}
              </p>
              <div className="admin-record-actions">
                <button
                  className="admin-primary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void issueMainLink()}
                >
                  {pendingKey === 'launch:main-link:issue' && (
                    <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
                  )}{' '}
                  Confirm link issuance
                </button>
                <button
                  className="admin-secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmIssuance(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="admin-secondary-button"
              type="button"
              disabled={!selectedAffiliate || busy}
              onClick={() => setConfirmIssuance(true)}
            >
              Review main-link issuance
            </button>
          )}
          <small className="admin-gate-copy">
            {trackingOnly
              ? 'The server rechecks the approved funnel snapshot and blocks checkout, commissions, and payouts.'
              : 'Partners never provide or receive the raw production destination. The server rechecks billing, signatures, and purchase terms at issuance.'}
          </small>
        </article>
      </div>

      <article className="admin-config-subpanel admin-main-links-panel">
        <div className="admin-subpanel-heading">
          <Link2 size={18} aria-hidden="true" />
          <div>
            <h3>Issued main links</h3>
            <p>Only server-returned production links are shown.</p>
          </div>
        </div>
        {configuration.mainLinks.length ? (
          <ul className="admin-main-link-list">
            {configuration.mainLinks.map((link) => {
              const affiliate = affiliates.find((candidate) => candidate.id === link.affiliateId)
              return (
                <li key={link.id}>
                  <span>
                    <strong>{affiliate?.publicName ?? 'Partner'}</strong>
                    <small>{link.status}</small>
                  </span>
                  <code>{link.trackingUrl}</code>
                  <a
                    href={link.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open main link for ${affiliate?.publicName ?? 'partner'}`}
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="admin-config-empty admin-config-empty-small">
            <Link2 size={22} aria-hidden="true" />
            <h3>No main links issued</h3>
            <p>
              The list stays empty until every{' '}
              {trackingOnly ? 'tracking-only' : 'production and partner'} gate passes.
            </p>
          </div>
        )}
      </article>
    </section>
  )
}
