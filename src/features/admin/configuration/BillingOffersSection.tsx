import { useState, type FormEvent } from 'react'
import {
  Archive,
  BadgeDollarSign,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  PauseCircle,
  Pencil,
  Plus,
  ShieldCheck,
} from 'lucide-react'
import type {
  AdminBillingMode,
  AdminBillingOffer,
  AdminConfigurationGateway,
  AdminProductConfiguration,
} from '../api'
import {
  normalizeConfigurationKey,
  positiveInteger,
  validateBillingOfferTerms,
} from './configurationValidation'
import type { ConfigurationActionRunner } from './actionTypes'
import { billingOfferActivationBlockers, canVerifyBillingOfferPrice } from './billingOfferReadiness'
import { Select } from '../../../components/Select'

type OfferForm = {
  name: string
  key: string
  billingMode: AdminBillingMode
  stripePriceId: string
  currency: string
  unitAmountMinor: string
  successUrlTemplate: string
  cancelUrl: string
}

const emptyForm: OfferForm = {
  name: '',
  key: '',
  billingMode: 'subscription',
  stripePriceId: '',
  currency: 'USD',
  unitAmountMinor: '',
  successUrlTemplate: '',
  cancelUrl: '',
}

type PendingStatus = Readonly<{
  offer: AdminBillingOffer
  status: 'active' | 'paused' | 'archived'
}>

function formatMinor(value: number | null, currency: string | null): string {
  if (value === null || !currency) return 'Exact amount missing'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100)
  } catch {
    return `${currency} ${value} minor units`
  }
}

function formFromOffer(offer: AdminBillingOffer): OfferForm {
  return {
    name: offer.name,
    key: offer.key,
    billingMode: offer.billingMode,
    stripePriceId: offer.stripePriceId ?? '',
    currency: offer.currency ?? '',
    unitAmountMinor: offer.unitAmountMinor?.toString() ?? '',
    successUrlTemplate: offer.successUrlTemplate ?? '',
    cancelUrl: offer.cancelUrl ?? '',
  }
}

export function BillingOffersSection({
  configuration,
  gateway,
  canManage,
  pendingKey,
  runAction,
}: {
  configuration: AdminProductConfiguration
  gateway: AdminConfigurationGateway
  canManage: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
}) {
  const [form, setForm] = useState<OfferForm>(emptyForm)
  const [editing, setEditing] = useState<AdminBillingOffer | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmation, setConfirmation] = useState<PendingStatus | null>(null)
  const busy = pendingKey?.startsWith('billing:') ?? false

  function updateForm<Key extends keyof OfferForm>(key: Key, value: OfferForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function resetForm() {
    setForm(emptyForm)
    setEditing(null)
    setErrors({})
  }

  async function saveOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validateBillingOfferTerms({
      ...form,
      key: editing ? undefined : form.key,
    })
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    const unitAmountMinor = form.unitAmountMinor.trim()
      ? positiveInteger(form.unitAmountMinor, 1, 99999999)
      : null
    const configurationTerms = {
      name: form.name.trim().replace(/\s+/g, ' '),
      billingMode: form.billingMode,
      stripePriceId: form.stripePriceId.trim() || null,
      currency: form.currency.trim().toUpperCase() || null,
      unitAmountMinor,
      successUrlTemplate: form.successUrlTemplate.trim() || null,
      cancelUrl: form.cancelUrl.trim() || null,
    }
    const saved = editing
      ? await runAction(
          `billing:update:${editing.id}`,
          () => gateway.updateBillingOffer({ billingOfferId: editing.id, ...configurationTerms }),
          'Draft billing-offer terms updated. Live Stripe verification must be run again.',
        )
      : await runAction(
          'billing:create',
          () =>
            gateway.createBillingOffer({
              productId: configuration.product.id,
              key: normalizeConfigurationKey(form.key),
              ...configurationTerms,
            }),
          'Versioned draft billing offer created.',
        )
    if (saved) resetForm()
  }

  async function confirmStatus() {
    if (!confirmation) return
    const { offer, status } = confirmation
    const changed = await runAction(
      `billing:status:${offer.id}`,
      () => gateway.setBillingOfferStatus({ billingOfferId: offer.id, status }),
      `${offer.name} is now ${status}.`,
    )
    if (changed) setConfirmation(null)
  }

  function verifyPrice(offer: AdminBillingOffer) {
    return runAction(
      `billing:verify:${offer.id}`,
      () => gateway.verifyBillingOfferPrice({ billingOfferId: offer.id }),
      `The live Stripe Price for ${offer.name} was verified.`,
    )
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-billing-offers-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <BadgeDollarSign size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">PRODUCTION BILLING</p>
          <h2 id="admin-billing-offers-title">Stripe billing offers</h2>
          <p>
            Configure versioned Price references and redirects. The browser never receives or sends
            a Stripe secret.
          </p>
        </div>
      </div>

      <div className="admin-config-split">
        <form className="admin-config-form" onSubmit={saveOffer} noValidate>
          <fieldset disabled={!canManage || busy}>
            <legend>
              {editing ? `Edit draft · ${editing.key} v${editing.version}` : 'Add a draft offer'}
            </legend>
            <div className="admin-config-form-grid">
              <label className="admin-field">
                <span>Offer name</span>
                <input
                  value={form.name}
                  onChange={(event) => updateForm('name', event.target.value)}
                  aria-invalid={Boolean(errors.name)}
                />
                {errors.name && <small className="admin-field-error">{errors.name}</small>}
              </label>
              <label className="admin-field">
                <span>Offer key</span>
                <input
                  value={form.key}
                  disabled={Boolean(editing)}
                  onChange={(event) => updateForm('key', event.target.value)}
                  placeholder="monthly"
                  aria-invalid={Boolean(errors.key)}
                />
                {errors.key && <small className="admin-field-error">{errors.key}</small>}
              </label>
              <label className="admin-field">
                <span>Billing mode</span>
                <Select
                  options={[
                    { value: 'subscription', label: 'Subscription' },
                    { value: 'payment', label: 'One-time payment · draft only' },
                  ]}
                  value={form.billingMode}
                  onChange={(next) => updateForm('billingMode', next as AdminBillingMode)}
                />
              </label>
              <label className="admin-field">
                <span>Stripe Price ID</span>
                <input
                  value={form.stripePriceId}
                  onChange={(event) => updateForm('stripePriceId', event.target.value)}
                  placeholder="price_..."
                  autoComplete="off"
                  aria-invalid={Boolean(errors.stripePriceId)}
                />
                {errors.stripePriceId ? (
                  <small className="admin-field-error">{errors.stripePriceId}</small>
                ) : (
                  <small className="admin-field-hint">
                    Price IDs are references, not secret keys.
                  </small>
                )}
              </label>
              <label className="admin-field">
                <span>Currency</span>
                <input
                  value={form.currency}
                  onChange={(event) => updateForm('currency', event.target.value.toUpperCase())}
                  maxLength={3}
                  aria-invalid={Boolean(errors.currency)}
                />
                {errors.currency && <small className="admin-field-error">{errors.currency}</small>}
              </label>
              <label className="admin-field">
                <span>Exact amount (minor units)</span>
                <input
                  inputMode="numeric"
                  value={form.unitAmountMinor}
                  onChange={(event) => updateForm('unitAmountMinor', event.target.value)}
                  placeholder="1999"
                  aria-invalid={Boolean(errors.unitAmountMinor)}
                />
                {errors.unitAmountMinor && (
                  <small className="admin-field-error">{errors.unitAmountMinor}</small>
                )}
              </label>
              <label className="admin-field admin-config-span-two">
                <span>Production success URL template</span>
                <input
                  type="url"
                  value={form.successUrlTemplate}
                  onChange={(event) => updateForm('successUrlTemplate', event.target.value)}
                  placeholder="https://app.yourdomain.dev/success?session_id={CHECKOUT_SESSION_ID}"
                  aria-invalid={Boolean(errors.successUrlTemplate)}
                />
                {errors.successUrlTemplate ? (
                  <small className="admin-field-error">{errors.successUrlTemplate}</small>
                ) : (
                  <small className="admin-field-hint">
                    Activation requires the literal {'{CHECKOUT_SESSION_ID}'} placeholder.
                  </small>
                )}
              </label>
              <label className="admin-field admin-config-span-two">
                <span>Production cancel URL</span>
                <input
                  type="url"
                  value={form.cancelUrl}
                  onChange={(event) => updateForm('cancelUrl', event.target.value)}
                  placeholder="https://app.yourdomain.dev/checkout"
                  aria-invalid={Boolean(errors.cancelUrl)}
                />
                {errors.cancelUrl && (
                  <small className="admin-field-error">{errors.cancelUrl}</small>
                )}
              </label>
            </div>
            {form.billingMode === 'payment' && (
              <div className="admin-gate-summary" role="note">
                <CircleAlert size={17} aria-hidden="true" />
                <p>
                  One-time payment offers can be saved as drafts, but the server will not activate
                  them until canonical one-time transaction handling exists.
                </p>
              </div>
            )}
            {!canManage && (
              <p className="admin-readonly-copy">
                Owner or Operations access is required to change billing configuration.
              </p>
            )}
            <div className="admin-record-actions">
              <button className="admin-primary-button" type="submit">
                {busy ? (
                  <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
                ) : editing ? (
                  <ShieldCheck size={17} aria-hidden="true" />
                ) : (
                  <Plus size={17} aria-hidden="true" />
                )}
                {editing ? 'Save draft terms' : 'Create draft offer'}
              </button>
              {editing && (
                <button className="admin-secondary-button" type="button" onClick={resetForm}>
                  Cancel edit
                </button>
              )}
            </div>
          </fieldset>
        </form>

        <div className="admin-config-records">
          {configuration.billingOffers.length ? (
            configuration.billingOffers.map((offer) => {
              const blockers = billingOfferActivationBlockers(
                offer,
                configuration.product.status === 'active',
              )
              const canActivate = blockers.length === 0
              const canVerifyPrice = canVerifyBillingOfferPrice(offer)
              return (
                <article className="admin-config-record" key={offer.id}>
                  <div className="admin-config-record-heading">
                    <div>
                      <h3>{offer.name}</h3>
                      <code>
                        {offer.key} · v{offer.version}
                      </code>
                    </div>
                    <span className={`admin-status-badge admin-status-${offer.status}`}>
                      {offer.status}
                    </span>
                  </div>
                  <div className="admin-config-tags">
                    <span>
                      {offer.billingMode === 'subscription'
                        ? 'Subscription'
                        : 'Payment · draft only'}
                    </span>
                    <span>{formatMinor(offer.unitAmountMinor, offer.currency)}</span>
                    <span>
                      {offer.stripePriceVerified ? (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      ) : (
                        <CircleAlert size={14} aria-hidden="true" />
                      )}
                      {offer.stripePriceVerified ? 'Live Price verified' : 'Price not verified'}
                    </span>
                  </div>
                  {offer.stripePriceId && <code>{offer.stripePriceId}</code>}
                  {['draft', 'paused'].includes(offer.status) && blockers.length > 0 && (
                    <ul
                      className="admin-billing-blockers"
                      aria-label={`${offer.name} activation blockers`}
                    >
                      {blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                  {canManage && offer.status !== 'archived' && (
                    <div className="admin-record-actions">
                      {offer.status === 'draft' && (
                        <button
                          className="admin-secondary-button"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditing(offer)
                            setForm(formFromOffer(offer))
                            setErrors({})
                          }}
                        >
                          <Pencil size={15} aria-hidden="true" /> Edit draft
                        </button>
                      )}
                      {canVerifyPrice && (
                        <button
                          className="admin-primary-button"
                          type="button"
                          disabled={busy}
                          onClick={() => void verifyPrice(offer)}
                        >
                          <ShieldCheck size={15} aria-hidden="true" /> Verify live Price
                        </button>
                      )}
                      {(offer.status === 'draft' || offer.status === 'paused') &&
                        offer.billingMode === 'subscription' && (
                          <button
                            className="admin-primary-button"
                            type="button"
                            disabled={busy || !canActivate}
                            onClick={() => setConfirmation({ offer, status: 'active' })}
                          >
                            Review activation
                          </button>
                        )}
                      {offer.status === 'active' && (
                        <button
                          className="admin-secondary-button"
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmation({ offer, status: 'paused' })}
                        >
                          <PauseCircle size={15} aria-hidden="true" /> Review pause
                        </button>
                      )}
                      <button
                        className="admin-text-button admin-danger-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmation({ offer, status: 'archived' })}
                      >
                        <Archive size={15} aria-hidden="true" /> Review archive
                      </button>
                    </div>
                  )}
                </article>
              )
            })
          ) : (
            <div className="admin-config-empty">
              <BadgeDollarSign size={25} aria-hidden="true" />
              <h3>No billing offers configured</h3>
              <p>
                Create a versioned draft when the real Stripe Price and production redirects are
                known. No sample commercial data is shown.
              </p>
            </div>
          )}
        </div>
      </div>

      {confirmation && (
        <div
          className="admin-confirm-action admin-billing-confirmation"
          role="group"
          aria-labelledby="admin-billing-confirmation-title"
        >
          <p id="admin-billing-confirmation-title">
            Confirm {confirmation.status} for {confirmation.offer.name} v
            {confirmation.offer.version}. Billing lifecycle changes are audited and archival cannot
            be reversed.
          </p>
          <div className="admin-record-actions">
            <button
              className={
                confirmation.status === 'archived'
                  ? 'admin-primary-button admin-danger-solid-button'
                  : 'admin-primary-button'
              }
              type="button"
              disabled={busy}
              onClick={() => void confirmStatus()}
            >
              Confirm {confirmation.status}
            </button>
            <button
              className="admin-secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
