import { useId, useState, type FormEvent } from 'react'
import type { AdminBillingOffer, AdminConfigurationGateway } from '../api'
import type { ConfigurationActionRunner } from './actionTypes'

/** These are public configuration references; credentials stay in the verifier. */
export function ManagedPriceVerificationForm({
  offer,
  gateway,
  busy,
  runAction,
}: {
  offer: AdminBillingOffer
  gateway: AdminConfigurationGateway
  busy: boolean
  runAction: ConfigurationActionRunner
}) {
  const [bindingId, setBindingId] = useState('')
  const [priceId, setPriceId] = useState(offer.stripePriceId ?? '')
  const [error, setError] = useState('')
  const prefix = useId()
  async function verify(event: FormEvent) {
    event.preventDefault()
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(bindingId.trim()) ||
      !/^price_[A-Za-z0-9_]{8,128}$/.test(priceId.trim())
    ) {
      setError('Enter the configured integration ID and a valid Stripe Price ID.')
      return
    }
    setError('')
    await runAction(
      `billing:verify:${offer.id}`,
      () =>
        gateway.verifyBillingOfferPrice({
          billingOfferId: offer.id,
          managed: { bindingId: bindingId.trim(), stripePriceId: priceId.trim() },
        }),
      `The managed Stripe Price for ${offer.name} was verified. Check its account and mode below.`,
    )
  }
  return (
    <details className="admin-config-record">
      <summary>Verify a managed Stripe Price</summary>
      <form onSubmit={verify}>
        <p className="admin-field-hint">
          The configured integration determines the Stripe account and Test or Live mode.
          Verification checks the Price against this offer’s exact amount. It does not enable
          checkout.
        </p>
        <label className="admin-field" htmlFor={`${prefix}-binding`}>
          <span>Managed integration ID</span>
          <input
            id={`${prefix}-binding`}
            value={bindingId}
            onChange={(event) => setBindingId(event.target.value)}
            placeholder="Configured integration ID"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="admin-field" htmlFor={`${prefix}-price`}>
          <span>Managed Stripe Price ID</span>
          <input
            id={`${prefix}-price`}
            value={priceId}
            onChange={(event) => setPriceId(event.target.value)}
            placeholder="price_..."
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className="admin-field-error">
            {error}
          </p>
        )}
        <button className="admin-secondary-button" type="submit" disabled={busy}>
          Verify managed Price
        </button>
      </form>
    </details>
  )
}
