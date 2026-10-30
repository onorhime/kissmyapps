import { useMemo, useState } from 'react'
import {
  Check,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Link2,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  AdminAffiliate,
  AdminConfigurationGateway,
  AdminProductConfiguration,
  AdminLinkEnvironment,
  AdminReadinessBlockerCode,
} from '../api'
import {
  hasLaunchReadyActiveAgreement,
  hasLaunchReadyActiveBillingOffer,
  hasTestReadyActiveBillingOffer,
  mainLinkReadiness,
  productActivationReadiness,
  readinessCopy,
} from './readiness'
import { Select } from '../../../components/Select'
import type { ConfigurationActionRunner } from './actionTypes'
import { ConfigurationReview } from './ConfigurationReview'

export type BlockerResolver = (
  code: AdminReadinessBlockerCode,
) => { label: string; open: () => void } | null

function GateSummary({
  blockers,
  resolveBlocker,
}: {
  blockers: readonly AdminReadinessBlockerCode[]
  resolveBlocker?: BlockerResolver
}) {
  if (!blockers.length) return null
  return (
    <div className="admin-gate-summary">
      <CircleAlert size={17} aria-hidden="true" />
      <div>
        <p>
          <strong>Still needed:</strong>
        </p>
        <ul className="admin-gate-list">
          {blockers.map((blocker) => {
            const fix = resolveBlocker?.(blocker)
            return (
              <li key={blocker}>
                <span>{readinessCopy[blocker]}</span>
                {fix && (
                  <button type="button" className="admin-text-button" onClick={fix.open}>
                    {fix.label}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

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

export function LaunchSection({
  configuration,
  affiliates,
  gateway,
  canManage,
  pendingKey,
  runAction,
  resolveBlocker,
}: {
  configuration: AdminProductConfiguration
  affiliates: readonly AdminAffiliate[]
  gateway: AdminConfigurationGateway
  canManage: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
  resolveBlocker?: BlockerResolver
}) {
  const [confirmActivation, setConfirmActivation] = useState(false)
  const [affiliateId, setAffiliateId] = useState('')
  const [confirmIssuance, setConfirmIssuance] = useState(false)
  const [environment, setEnvironment] = useState<AdminLinkEnvironment>('live')
  const activation = productActivationReadiness(configuration)
  const issuance = mainLinkReadiness(configuration, affiliates, environment)
  const eligibleAffiliates = useMemo(
    () => affiliates.filter((affiliate) => issuance.eligibleAffiliateIds.includes(affiliate.id)),
    [affiliates, issuance.eligibleAffiliateIds],
  )
  const selectedAffiliate = eligibleAffiliates.find((affiliate) => affiliate.id === affiliateId)
  const productActive = configuration.product.status === 'active'
  const trackingOnly = configuration.product.trackingMode === 'tracking_only'
  const testEnvironment = environment === 'test'
  const hasVerifiedOffer = testEnvironment
    ? hasTestReadyActiveBillingOffer(configuration)
    : hasLaunchReadyActiveBillingOffer(configuration)
  const environmentLinks = configuration.mainLinks.filter(
    (link) => (link.environment ?? 'live') === environment,
  )
  const hasLaunchReadyAgreement = hasLaunchReadyActiveAgreement(configuration)
  const launchReadyAffiliateIds = mainLinkReadiness(
    { ...configuration, mainLinks: [] },
    affiliates,
    environment,
  ).eligibleAffiliateIds
  const allEligibleLinksIssued =
    launchReadyAffiliateIds.length > 0 &&
    launchReadyAffiliateIds.every((id) =>
      environmentLinks.some((link) => link.affiliateId === id && link.status === 'active'),
    )
  // Eligibility excludes partners with an existing link to prevent duplicates.
  // That is not a failed launch step once their active link has been issued.
  const visibleIssuanceBlockers = issuance.blockers.filter(
    (blocker) => !(allEligibleLinksIssued && blocker === 'eligible_partner_missing'),
  )
  const busy = Boolean(pendingKey)

  async function activateProduct() {
    const activated = await runAction(
      'launch:product:activate',
      () => gateway.activateProduct({ productId: configuration.product.id }),
      'Product activation was accepted and verified from the server.',
    )
    if (activated) setConfirmActivation(false)
  }

  async function issueMainLink() {
    if (!canManage || !issuance.allowed || !selectedAffiliate || busy) return
    const issued = await runAction(
      'launch:main-link:issue',
      () =>
        gateway.issueMainLink({
          productId: configuration.product.id,
          affiliateId: selectedAffiliate.id,
          environment,
        }),
      `${environment.toUpperCase()} main link issued for ${selectedAffiliate.publicName}.`,
    )
    if (issued) {
      setAffiliateId('')
      setConfirmIssuance(false)
    }
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-launch-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <ShieldCheck size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">LAUNCH</p>
          <h2 id="admin-launch-title">Launch and partner links</h2>
          <p>
            Two server-validated steps: activate the product, then issue a main link per partner and
            environment. Saving configuration never launches the product automatically.
          </p>
        </div>
      </div>

      <div className="admin-launch-steps">
        <article className="admin-config-subpanel admin-launch-step">
          <div className="admin-subpanel-heading">
            <span className="admin-launch-step-number" aria-hidden="true">
              1
            </span>
            <div>
              <h3>Activate the product</h3>
              <p>
                Requires a saved production tracking origin and one live default HTTPS funnel. The
                server rechecks readiness when activation is submitted.
              </p>
            </div>
            {productActive && (
              <span className="admin-launch-step-state admin-launch-step-done">
                <CircleCheck size={15} aria-hidden="true" /> Active
              </span>
            )}
          </div>
          <ul className="admin-readiness-list">
            <ChecklistItem passed={Boolean(configuration.tracking.baseUrl)}>
              Production tracking origin is configured
            </ChecklistItem>
            <ChecklistItem passed={configuration.readiness.hasLiveDefaultFunnel}>
              One default HTTPS funnel is live
            </ChecklistItem>
            <ChecklistItem
              passed={productActive || ['draft', 'paused'].includes(configuration.product.status)}
            >
              {productActive
                ? 'Product activation is complete'
                : 'Product is in an activatable lifecycle state'}
            </ChecklistItem>
          </ul>
          {!productActive && (
            <GateSummary blockers={activation.blockers} resolveBlocker={resolveBlocker} />
          )}
          {productActive ? (
            <p className="admin-success-banner">
              <Check size={17} aria-hidden="true" /> Product is active
            </p>
          ) : (
            <button
              className="admin-primary-button"
              type="button"
              disabled={!canManage || !activation.allowed || busy}
              onClick={() => setConfirmActivation(true)}
            >
              Activate product
            </button>
          )}
          {confirmActivation && (
            <ConfigurationReview
              title="Confirm product activation"
              description={`Review activation of ${configuration.product.name}. This does not issue partner links.`}
              busy={busy}
              onCancel={() => setConfirmActivation(false)}
            >
              <p>
                Activate <strong>{configuration.product.name}</strong>
                {trackingOnly ? ' for tracking-only testing' : ' for production'}? This does not
                issue partner links.
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
            </ConfigurationReview>
          )}
        </article>

        <article className="admin-config-subpanel admin-launch-step">
          <div className="admin-subpanel-heading">
            <span className="admin-launch-step-number" aria-hidden="true">
              2
            </span>
            <div>
              <h3>Issue a partner main link</h3>
              <p>
                {trackingOnly
                  ? 'One readable product and creator link after the approved demo chain is ready.'
                  : 'One readable product and creator link per partner. Partners can create separate campaign links in their dashboard; shared links keep their attribution.'}
              </p>
            </div>
            {environmentLinks.length > 0 && (
              <span className="admin-launch-step-state">
                {environmentLinks.length} {environment.toUpperCase()} issued
              </span>
            )}
          </div>
          {!trackingOnly && (
            <Select
              label="Link environment"
              options={[
                { value: 'live', label: 'LIVE — public creator link' },
                { value: 'test', label: 'TEST — test journey and attribution' },
              ]}
              value={environment}
              onChange={(next) => {
                setEnvironment(next as AdminLinkEnvironment)
                setAffiliateId('')
                setConfirmIssuance(false)
              }}
              disabled={!canManage || busy}
            />
          )}
          {testEnvironment && (
            <p className="admin-inline-note" role="note">
              TEST links keep test activity separate in reports. They use this product’s existing
              agreements and verified TEST offer. Issuing a link does not enable checkout or
              payouts.
            </p>
          )}
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
                    (testEnvironment
                      ? configuration.tracking.enabled && Boolean(configuration.tracking.baseUrl)
                      : configuration.readiness.trackingReady) &&
                    configuration.readiness.hasLiveDefaultFunnel
                  }
                >
                  {testEnvironment
                    ? 'Tracking collection and funnel routing are ready'
                    : 'Production routing is ready'}
                </ChecklistItem>
                <ChecklistItem
                  passed={
                    (testEnvironment
                      ? configuration.readiness.hasActiveTestBillingOffer === true
                      : configuration.readiness.hasActiveBillingOffer) && hasVerifiedOffer
                  }
                >
                  {testEnvironment
                    ? 'An active offer is verified for the assigned TEST merchant'
                    : 'An active live-verified subscription or managed one-time offer exists'}
                </ChecklistItem>
                <ChecklistItem
                  passed={configuration.readiness.hasActiveAgreement && hasLaunchReadyAgreement}
                >
                  A bilateral signed agreement has exactly one supported active purchase rule
                </ChecklistItem>
              </>
            )}
            <ChecklistItem
              passed={issuance.eligibleAffiliateIds.length > 0 || allEligibleLinksIssued}
            >
              {allEligibleLinksIssued
                ? 'All eligible partners already have an active main link'
                : trackingOnly
                  ? 'An active partner without an existing main link is eligible'
                  : 'An active partner with a launch-ready agreement is eligible'}
            </ChecklistItem>
          </ul>
          <GateSummary blockers={visibleIssuanceBlockers} resolveBlocker={resolveBlocker} />
          {allEligibleLinksIssued && visibleIssuanceBlockers.length === 0 && (
            <p className="admin-success-banner">
              <Check size={17} aria-hidden="true" /> Main-link issuance is complete for the current
              eligible partners. Existing links are listed below.
            </p>
          )}
          <Select
            label="Eligible partner"
            options={[
              { value: '', label: 'Choose a partner' },
              ...eligibleAffiliates.map((affiliate) => ({
                value: affiliate.id,
                label: affiliate.publicName,
              })),
            ]}
            value={affiliateId}
            onChange={(next) => {
              setAffiliateId(next)
              setConfirmIssuance(false)
            }}
            disabled={!canManage || !issuance.allowed || busy}
          />
          {confirmIssuance && selectedAffiliate && (
            <ConfigurationReview
              title="Confirm main link issuance"
              description={`Issue a ${environment.toUpperCase()} main link for ${selectedAffiliate.publicName}. All server eligibility gates still apply.`}
              busy={busy}
              onCancel={() => setConfirmIssuance(false)}
            >
              <p>
                Issue the <strong>{environment.toUpperCase()}</strong> main link for{' '}
                <strong>{selectedAffiliate.publicName}</strong>? No destination, source, campaign,
                or Sub ID is accepted here.
                {trackingOnly && ' This link cannot create commercial facts.'}
              </p>
              <div className="admin-record-actions">
                <button
                  className="admin-primary-button"
                  type="button"
                  disabled={!canManage || !issuance.allowed || busy}
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
            </ConfigurationReview>
          )}
          <button
            className="admin-secondary-button"
            type="button"
            disabled={!canManage || !issuance.allowed || !selectedAffiliate || busy}
            onClick={() => setConfirmIssuance(true)}
          >
            Issue main link
          </button>
        </article>
      </div>

      <article className="admin-config-subpanel admin-main-links-panel">
        <div className="admin-subpanel-heading">
          <Link2 size={18} aria-hidden="true" />
          <div>
            <h3>Partner main links</h3>
            <p>
              The canonical per-partner links issued by the server. Partner-created variants live in
              the partner dashboard.
            </p>
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
                    <small>
                      {(link.environment ?? 'live').toUpperCase()} · {link.status}
                    </small>
                  </span>
                  <code>{link.trackingUrl}</code>
                  <a
                    href={link.trackingUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${(link.environment ?? 'live').toUpperCase()} main link for ${affiliate?.publicName ?? 'partner'}`}
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
