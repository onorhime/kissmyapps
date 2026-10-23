import type { AdminProductConfiguration, AdminReadinessBlockerCode } from '../api'
import { hasLaunchReadyActiveAgreement, hasLaunchReadyActiveBillingOffer } from './readiness'

export type SetupStepId =
  'funnel' | 'sources' | 'payments' | 'agreement' | 'approval' | 'launch' | 'settings'

export type SetupStepState = 'complete' | 'incomplete' | 'optional'

export type SetupStep = Readonly<{
  id: SetupStepId
  /** 1-based position among the numbered steps; null for the trailing settings entry. */
  number: number | null
  title: string
  /** Short line shown under the title in the step list. */
  caption: string
  /** One or two plain-language sentences shown above the step content. */
  intro: string
  state: SetupStepState
  /** Where this step stands right now, in a few words. */
  status: string
}>

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

function funnelStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const liveDefault = configuration.funnels.find(
    (funnel) => funnel.isDefault && funnel.status === 'live',
  )
  const done = configuration.readiness.hasLiveDefaultFunnel
  const status = done
    ? `${liveDefault?.name ?? 'Default funnel'} is live`
    : configuration.funnels.length === 0
      ? 'Add your first funnel'
      : configuration.funnels.some((funnel) => funnel.isDefault)
        ? 'Set the default funnel live'
        : 'Mark one funnel as the default'
  return {
    id: 'funnel',
    title: 'Funnel',
    caption: 'Where partner clicks land',
    intro:
      'Add the page partner traffic should land on, mark it as the default, and set it live. You can save a draft first and add the HTTPS address when the page exists.',
    state: done ? 'complete' : 'incomplete',
    status,
  }
}

function sourcesStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const campaigns = configuration.campaigns.filter((campaign) => campaign.status !== 'archived')
  return {
    id: 'sources',
    title: 'Sources & campaigns',
    caption: 'Optional reporting labels',
    intro:
      'Labels that group clicks in reports, such as “TikTok” or “Summer launch”. They never change where a click lands. Skip this step if you do not need them yet.',
    state: campaigns.length ? 'complete' : 'optional',
    status: campaigns.length ? plural(campaigns.length, 'campaign') : 'Optional',
  }
}

function paymentsStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const done = hasLaunchReadyActiveBillingOffer(configuration)
  const offers = configuration.billingOffers.filter((offer) => offer.status !== 'archived')
  return {
    id: 'payments',
    title: 'Payments',
    caption: 'Stripe account and price',
    intro:
      'Connect the Stripe account that receives payments, then add the price partners will sell. An offer counts once it is verified against live Stripe and active.',
    state: done ? 'complete' : 'incomplete',
    status: done
      ? 'Live offer verified'
      : offers.length
        ? 'Verify and activate an offer'
        : 'Add a price',
  }
}

function agreementStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const done = hasLaunchReadyActiveAgreement(configuration)
  const ready = configuration.agreements.filter(
    (agreement) => agreement.status === 'active' && agreement.launchReady,
  ).length
  return {
    id: 'agreement',
    title: 'Partner agreement',
    caption: 'Terms and commission',
    intro:
      'Create the agreement for each partner, add one commission rule, and record the signed document. A partner can get a link once both sides have signed and the agreement is active.',
    state: done ? 'complete' : 'incomplete',
    status: done
      ? `${plural(ready, 'partner')} ready`
      : configuration.agreements.length
        ? 'Finish signing and activate'
        : 'Create the first agreement',
  }
}

function approvalStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const done = configuration.readiness.trackingOnlyReady
  return {
    id: 'approval',
    title: 'Approve demo funnel',
    caption: 'Owner sign-off',
    intro:
      'This product only tests tracking. An Owner approves the current live funnel so demo links can run. Checkout, commissions, and payouts stay off.',
    state: done ? 'complete' : 'incomplete',
    status: done ? 'Approved' : 'Owner approval needed',
  }
}

function launchStep(configuration: AdminProductConfiguration): Omit<SetupStep, 'number'> {
  const active = configuration.product.status === 'active'
  const liveLinks = configuration.mainLinks.filter(
    (link) => link.status === 'active' && (link.environment ?? 'live') === 'live',
  ).length
  return {
    id: 'launch',
    title: 'Go live',
    caption: 'Activate and share links',
    intro:
      'Activate the product, then issue each eligible partner their main link. Nothing goes live until you confirm here.',
    state: active && liveLinks > 0 ? 'complete' : 'incomplete',
    status: !active
      ? 'Product not active yet'
      : liveLinks
        ? `Active · ${plural(liveLinks, 'partner link')}`
        : 'Active · issue the first link',
  }
}

const settingsStep: Omit<SetupStep, 'number'> = {
  id: 'settings',
  title: 'Product settings',
  caption: 'Mode and deletion',
  intro:
    'Rarely needed controls: switch between commercial and tracking-only testing, or delete a product that never launched.',
  state: 'optional',
  status: '',
}

/** The ordered setup journey for one product. Every step is always reachable. */
export function setupSteps(configuration: AdminProductConfiguration): readonly SetupStep[] {
  const trackingOnly = configuration.product.trackingMode === 'tracking_only'
  const numbered = trackingOnly
    ? [
        funnelStep(configuration),
        sourcesStep(configuration),
        approvalStep(configuration),
        launchStep(configuration),
      ]
    : [
        funnelStep(configuration),
        sourcesStep(configuration),
        paymentsStep(configuration),
        agreementStep(configuration),
        launchStep(configuration),
      ]
  return [
    ...numbered.map((step, index) => ({ ...step, number: index + 1 })),
    { ...settingsStep, number: null },
  ]
}

/** Required steps are numbered steps that are not optional. */
export function requiredSteps(steps: readonly SetupStep[]) {
  return steps.filter((step) => step.number !== null && step.state !== 'optional')
}

export function setupProgress(steps: readonly SetupStep[]) {
  const required = requiredSteps(steps)
  const complete = required.filter((step) => step.state === 'complete').length
  return { complete, total: required.length }
}

/** The step to open first: the earliest unfinished required step, else Go live. */
export function initialSetupStep(steps: readonly SetupStep[]): SetupStepId {
  return requiredSteps(steps).find((step) => step.state !== 'complete')?.id ?? 'launch'
}

/** Which step resolves a server readiness blocker, so a blocker can link to its fix. */
export function stepForBlocker(code: AdminReadinessBlockerCode): SetupStepId | null {
  switch (code) {
    case 'default_funnel_missing':
    case 'default_funnel_not_live':
      return 'funnel'
    case 'active_billing_offer_missing':
    case 'active_test_billing_offer_missing':
      return 'payments'
    case 'active_agreement_missing':
    case 'launch_ready_agreement_missing':
    case 'eligible_partner_missing':
      return 'agreement'
    case 'tracking_only_approval_required':
    case 'tracking_only_link_gate_not_ready':
      return 'approval'
    case 'test_links_require_commercial_product':
      return 'settings'
    case 'product_status_not_activatable':
    case 'product_not_active':
      return 'launch'
    default:
      return null
  }
}
