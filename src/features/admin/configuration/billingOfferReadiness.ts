import type { AdminBillingOffer } from '../api'
import { validateProductionHttpsUrl } from './configurationValidation'

export function billingOfferActivationBlockers(
  offer: AdminBillingOffer,
  productActive: boolean,
): string[] {
  const blockers: string[] = []
  if (offer.billingMode === 'payment') {
    blockers.push(
      'One-time payment mode is draft-only until its canonical transaction ledger ships.',
    )
  }
  if (!productActive) blockers.push('Activate the product first.')
  if (!offer.stripePriceId) blockers.push('Add a Stripe Price ID.')
  if (!offer.currency || offer.unitAmountMinor === null) {
    blockers.push('Add the exact currency and minor-unit amount.')
  }
  if (!offer.successUrlTemplate || !offer.cancelUrl) {
    blockers.push('Add both production success and cancel URLs.')
  } else {
    if (validateProductionHttpsUrl(offer.successUrlTemplate)) {
      blockers.push('Use a valid production HTTPS success URL.')
    }
    if (!offer.successUrlTemplate.includes('{CHECKOUT_SESSION_ID}')) {
      blockers.push('Add {CHECKOUT_SESSION_ID} to the success URL.')
    }
    if (validateProductionHttpsUrl(offer.cancelUrl)) {
      blockers.push('Use a valid production HTTPS cancel URL.')
    }
  }
  if (!offer.stripePriceVerified) {
    blockers.push('Verify the active Price against Stripe live mode.')
  }
  return blockers
}

export function canVerifyBillingOfferPrice(offer: AdminBillingOffer): boolean {
  return (
    offer.status === 'draft' &&
    offer.billingMode === 'subscription' &&
    !offer.stripePriceVerified &&
    Boolean(offer.stripePriceId) &&
    Boolean(offer.currency) &&
    offer.unitAmountMinor !== null &&
    Boolean(offer.successUrlTemplate) &&
    Boolean(offer.cancelUrl) &&
    offer.successUrlTemplate?.includes('{CHECKOUT_SESSION_ID}') === true &&
    validateProductionHttpsUrl(offer.successUrlTemplate ?? '') === null &&
    validateProductionHttpsUrl(offer.cancelUrl ?? '') === null
  )
}
