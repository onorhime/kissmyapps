import type {
  AdminActionReadiness,
  AdminAffiliate,
  AdminAgreement,
  AdminCommissionRule,
  AdminMainLinkReadiness,
  AdminLinkEnvironment,
  AdminProductConfiguration,
  AdminReadinessBlockerCode,
} from '../api'
import { managedPriceVerifications } from './billingOfferReadiness'

const supportedLaunchModels = new Set(['cpa', 'revenue_share', 'hybrid'])

export const readinessCopy: Record<AdminReadinessBlockerCode, string> = {
  tracking_not_configured: 'Configure the production tracking origin.',
  tracking_disabled: 'Enable production tracking.',
  default_funnel_missing: 'Choose one default funnel.',
  default_funnel_not_live: 'Set the default HTTPS funnel live.',
  product_status_not_activatable: 'Only a draft or paused product can be activated.',
  product_not_active: 'Activate the product before issuing links.',
  eligible_partner_missing: 'Choose an active partner that does not already have a main link.',
  active_agreement_missing: 'Activate an agreement for the selected partner and product.',
  active_commission_rule_missing: 'Activate a compatible commission rule.',
  active_billing_offer_missing:
    'Activate a live-verified subscription or managed one-time offer before issuing partner links.',
  active_test_billing_offer_missing:
    'Activate an offer verified against the assigned TEST merchant before issuing test links.',
  test_links_require_commercial_product:
    'TEST links use normal product agreements and offers. A tracking-only demo cannot issue them.',
  launch_ready_agreement_missing:
    'A partner agreement needs a bilateral signed document and exactly one supported active purchase rule.',
  tracking_only_approval_required:
    'An Owner must approve the current live default funnel for tracking-only testing.',
  tracking_only_link_gate_not_ready:
    'The approved tracking-only funnel, active product, and canonical tracking switch must all remain ready.',
  server_readiness_unavailable: 'Readiness could not be verified. Refresh before continuing.',
}

function trackingBlocker(configuration: AdminProductConfiguration): AdminReadinessBlockerCode {
  return configuration.tracking.baseUrl ? 'tracking_disabled' : 'tracking_not_configured'
}

function funnelBlocker(configuration: AdminProductConfiguration): AdminReadinessBlockerCode {
  return configuration.funnels.some((funnel) => funnel.isDefault)
    ? 'default_funnel_not_live'
    : 'default_funnel_missing'
}

export function hasLiveVerifiedActiveSubscriptionOffer(
  configuration: AdminProductConfiguration,
): boolean {
  return configuration.billingOffers.some(
    (offer) =>
      offer.status === 'active' &&
      offer.billingMode === 'subscription' &&
      offer.stripePriceVerified &&
      Boolean(offer.stripeLivemodeVerifiedAt),
  )
}

export function hasLaunchReadyActiveBillingOffer(
  configuration: AdminProductConfiguration,
): boolean {
  return (
    hasLiveVerifiedActiveSubscriptionOffer(configuration) ||
    (configuration.readiness.managedPaymentCheckoutEnabled === true &&
      configuration.billingOffers.some(
        (offer) =>
          offer.productId === configuration.product.id &&
          offer.status === 'active' &&
          offer.billingMode === 'payment' &&
          offer.mainLinkReady === true &&
          managedPriceVerifications(offer).some((proof) => proof.livemode),
      ))
  )
}

export function hasTestReadyActiveBillingOffer(configuration: AdminProductConfiguration): boolean {
  return configuration.billingOffers.some(
    (offer) =>
      offer.productId === configuration.product.id &&
      offer.status === 'active' &&
      offer.billingMode === 'payment' &&
      offer.mainLinkTestReady === true &&
      managedPriceVerifications(offer).some((proof) => !proof.livemode),
  )
}

export function isSupportedActivePurchaseRule(
  agreement: AdminAgreement,
  rule: AdminCommissionRule,
): boolean {
  return (
    rule.status === 'active' &&
    rule.triggerEvent === 'purchase.completed' &&
    supportedLaunchModels.has(rule.model) &&
    rule.model === agreement.model &&
    (rule.currency === null || rule.currency === agreement.payoutCurrency)
  )
}

export function hasExactlyOneSupportedActivePurchaseRule(agreement: AdminAgreement): boolean {
  const activeRules = agreement.commissionRules.filter((rule) => rule.status === 'active')
  return activeRules.length === 1 && isSupportedActivePurchaseRule(agreement, activeRules[0])
}

export function isLaunchReadyActiveAgreement(agreement: AdminAgreement): boolean {
  return (
    agreement.status === 'active' &&
    agreement.hasSignedDocument &&
    agreement.launchReady &&
    hasExactlyOneSupportedActivePurchaseRule(agreement)
  )
}

export function hasLaunchReadyActiveAgreement(configuration: AdminProductConfiguration): boolean {
  return configuration.agreements.some(isLaunchReadyActiveAgreement)
}

export function productActivationReadiness(
  configuration: AdminProductConfiguration,
): AdminActionReadiness {
  const blockers: AdminReadinessBlockerCode[] = []
  if (!['draft', 'paused'].includes(configuration.product.status)) {
    blockers.push('product_status_not_activatable')
  }
  // Product activation is the pre-launch step that unlocks live-offer
  // verification. The kill switch deliberately remains off until the full
  // product, funnel, agreement and offer chain is ready.
  if (!configuration.tracking.baseUrl) blockers.push('tracking_not_configured')
  if (!configuration.readiness.hasLiveDefaultFunnel) blockers.push(funnelBlocker(configuration))
  return { allowed: blockers.length === 0, blockers }
}

export function mainLinkReadiness(
  configuration: AdminProductConfiguration,
  affiliates: readonly AdminAffiliate[],
  environment: AdminLinkEnvironment = 'live',
): AdminMainLinkReadiness {
  const blockers: AdminReadinessBlockerCode[] = []
  if (configuration.product.status !== 'active') blockers.push('product_not_active')

  const linkedAffiliateIds = new Set(
    configuration.mainLinks
      .filter((link) => link.status !== 'archived' && (link.environment ?? 'live') === environment)
      .map((link) => link.affiliateId),
  )
  const activeAffiliateIds = affiliates
    .filter((affiliate) => affiliate.status === 'active')
    .map((affiliate) => affiliate.id)

  if (configuration.product.trackingMode === 'tracking_only') {
    if (environment === 'test') blockers.push('test_links_require_commercial_product')
    if (!configuration.tracking.baseUrl || !configuration.tracking.enabled) {
      blockers.push(trackingBlocker(configuration))
    }
    if (!configuration.readiness.hasLiveDefaultFunnel) blockers.push(funnelBlocker(configuration))
    if (!configuration.readiness.trackingOnlyReady) {
      blockers.push('tracking_only_approval_required')
    } else if (!configuration.readiness.trackingOnlyCanIssueLinks) {
      blockers.push('tracking_only_link_gate_not_ready')
    }

    const eligibleAffiliateIds = activeAffiliateIds.filter(
      (affiliateId) => !linkedAffiliateIds.has(affiliateId),
    )
    if (eligibleAffiliateIds.length === 0) blockers.push('eligible_partner_missing')

    return { allowed: blockers.length === 0, blockers, eligibleAffiliateIds }
  }

  const routingReady =
    environment === 'test'
      ? configuration.tracking.enabled && Boolean(configuration.tracking.baseUrl)
      : configuration.readiness.trackingReady
  if (!routingReady) blockers.push(trackingBlocker(configuration))
  if (!configuration.readiness.hasLiveDefaultFunnel) blockers.push(funnelBlocker(configuration))
  if (!configuration.readiness.hasActiveAgreement) blockers.push('active_agreement_missing')

  if (environment === 'test') {
    if (
      !configuration.readiness.hasActiveTestBillingOffer ||
      !hasTestReadyActiveBillingOffer(configuration)
    ) {
      blockers.push('active_test_billing_offer_missing')
    }
  } else if (
    !configuration.readiness.hasActiveBillingOffer ||
    !hasLaunchReadyActiveBillingOffer(configuration)
  ) {
    blockers.push('active_billing_offer_missing')
  }

  const activeAffiliateIdSet = new Set(activeAffiliateIds)
  const eligibleAffiliateIds = configuration.agreements
    .filter(
      (agreement) =>
        isLaunchReadyActiveAgreement(agreement) &&
        activeAffiliateIdSet.has(agreement.affiliateId) &&
        !linkedAffiliateIds.has(agreement.affiliateId),
    )
    .map((agreement) => agreement.affiliateId)
    .filter((id, index, ids) => ids.indexOf(id) === index)

  if (configuration.readiness.hasActiveAgreement && !hasLaunchReadyActiveAgreement(configuration))
    blockers.push('launch_ready_agreement_missing')
  if (eligibleAffiliateIds.length === 0) blockers.push('eligible_partner_missing')

  return {
    allowed: blockers.length === 0,
    blockers,
    eligibleAffiliateIds,
  }
}
