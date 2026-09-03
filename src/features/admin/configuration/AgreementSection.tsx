import { useMemo, useState, type FormEvent } from 'react'
import { BadgeDollarSign, FileSignature, LoaderCircle, Plus, ShieldCheck } from 'lucide-react'
import type {
  AdminAffiliate,
  AdminAgreement,
  AdminCommissionModel,
  AdminCommissionRule,
  AdminConfigurationGateway,
  AdminProductConfiguration,
} from '../api'
import {
  moneyToMinor,
  percentageToBasisPoints,
  positiveInteger,
  validateCommissionValues,
} from './configurationValidation'
import {
  hasExactlyOneSupportedActivePurchaseRule,
  isSupportedActivePurchaseRule,
} from './readiness'
import type { ConfigurationActionRunner } from './actionTypes'
import { Select } from '../../../components/Select'

const modelLabels: Record<AdminCommissionModel, string> = {
  cpl: 'CPL · draft only (not launch-supported)',
  cpa: 'CPA · fixed amount per acquisition',
  revenue_share: 'Revenue share · percentage',
  hybrid: 'Hybrid · fixed amount plus percentage',
}

function formatMinor(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value / 100)
  } catch {
    return `${currency} ${(value / 100).toFixed(2)}`
  }
}

export function AgreementSection({
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
  const [affiliateId, setAffiliateId] = useState('')
  const [model, setModel] = useState<AdminCommissionModel>('cpa')
  const [attributionDays, setAttributionDays] = useState('30')
  const [renewalDays, setRenewalDays] = useState('')
  const [payoutDays, setPayoutDays] = useState('14')
  const [currency, setCurrency] = useState('USD')
  const [minimumPayout, setMinimumPayout] = useState('100.00')
  const [agreementErrors, setAgreementErrors] = useState<Record<string, string>>({})
  const [ruleAgreementId, setRuleAgreementId] = useState('')
  const [ruleName, setRuleName] = useState('')
  const [triggerEvent, setTriggerEvent] = useState('purchase.completed')
  const [fixedAmount, setFixedAmount] = useState('')
  const [ratePercent, setRatePercent] = useState('')
  const [validationHours, setValidationHours] = useState('72')
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({})
  const busy = pendingKey?.startsWith('commercial:') ?? false
  const availableAffiliates = affiliates.filter((affiliate) =>
    ['active', 'paused'].includes(affiliate.status),
  )
  const ruleAgreement = useMemo(
    () => configuration.agreements.find((agreement) => agreement.id === ruleAgreementId) ?? null,
    [configuration.agreements, ruleAgreementId],
  )

  async function createAgreement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    const attributionWindowDays = positiveInteger(attributionDays, 1, 365)
    const renewalDurationDays = renewalDays ? positiveInteger(renewalDays, 1, 3650) : null
    const payoutFrequencyDays = positiveInteger(payoutDays, 1, 365)
    const minimumPayoutMinor = moneyToMinor(minimumPayout)
    if (!affiliateId) nextErrors.affiliateId = 'Choose a partner.'
    if (attributionWindowDays === null) nextErrors.attributionDays = 'Use 1 to 365 days.'
    if (renewalDays && renewalDurationDays === null) nextErrors.renewalDays = 'Use 1 to 3,650 days.'
    if (payoutFrequencyDays === null) nextErrors.payoutDays = 'Use 1 to 365 days.'
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase()))
      nextErrors.currency = 'Use a three-letter currency code.'
    if (minimumPayoutMinor === null) nextErrors.minimumPayout = 'Enter a valid non-negative amount.'
    setAgreementErrors(nextErrors)
    if (
      Object.keys(nextErrors).length ||
      attributionWindowDays === null ||
      payoutFrequencyDays === null ||
      minimumPayoutMinor === null
    )
      return

    const created = await runAction(
      'commercial:agreement:create',
      () =>
        gateway.createAgreement({
          productId: configuration.product.id,
          affiliateId,
          model,
          attributionWindowDays,
          renewalDurationDays,
          payoutFrequencyDays,
          payoutCurrency: currency.trim().toUpperCase(),
          minimumPayoutMinor,
        }),
      'Draft partner agreement created. Add and activate a commission rule next.',
    )
    if (created) setAffiliateId('')
  }

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const selectedModel = ruleAgreement?.model ?? 'cpa'
    const nextErrors: Record<string, string> = {
      ...validateCommissionValues({
        model: selectedModel,
        triggerEvent,
        fixedAmount,
        ratePercent,
        currency,
      }),
    }
    const windowHours = positiveInteger(validationHours, 1, 8760)
    if (!ruleAgreement) nextErrors.ruleAgreementId = 'Choose an agreement.'
    if (!ruleName.trim() || ruleName.trim().length > 120)
      nextErrors.ruleName = 'Enter a rule name of 120 characters or fewer.'
    if (windowHours === null) nextErrors.validationHours = 'Use 1 to 8,760 hours.'
    setRuleErrors(nextErrors)
    if (Object.keys(nextErrors).length || !ruleAgreement || windowHours === null) return

    const usesFixed =
      selectedModel === 'cpl' || selectedModel === 'cpa' || selectedModel === 'hybrid'
    const usesRate = selectedModel === 'revenue_share' || selectedModel === 'hybrid'
    const created = await runAction(
      'commercial:rule:create',
      () =>
        gateway.createCommissionRule({
          agreementId: ruleAgreement.id,
          name: ruleName.trim(),
          model: selectedModel,
          triggerEvent: triggerEvent.trim().toLowerCase(),
          fixedAmountMinor: usesFixed ? moneyToMinor(fixedAmount) : null,
          rateBasisPoints: usesRate ? percentageToBasisPoints(ratePercent) : null,
          currency: usesFixed ? currency.trim().toUpperCase() : null,
          validationWindowHours: windowHours,
        }),
      'Draft commission rule created. Activate it only after reviewing the commercial terms.',
    )
    if (created) {
      setRuleName('')
      setFixedAmount('')
      setRatePercent('')
    }
  }

  function setRuleStatus(rule: AdminCommissionRule, status: 'active' | 'superseded') {
    return runAction(
      `commercial:rule:status:${rule.id}`,
      () => gateway.setCommissionRuleStatus({ commissionRuleId: rule.id, status }),
      `${rule.name} is now ${status}.`,
    )
  }

  function activateAgreement(agreement: AdminAgreement) {
    return runAction(
      `commercial:agreement:activate:${agreement.id}`,
      () => gateway.activateAgreement({ agreementId: agreement.id }),
      `Agreement version ${agreement.version} is active.`,
    )
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-agreements-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <FileSignature size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">PARTNER TERMS</p>
          <h2 id="admin-agreements-title">Agreements and commission rules</h2>
          <p>
            Terms are versioned. Activation requires a bilateral signed document and exactly one
            supported active purchase rule.
          </p>
        </div>
      </div>

      <div className="admin-config-two-columns">
        <form
          className="admin-config-form admin-config-subpanel"
          onSubmit={createAgreement}
          noValidate
        >
          <fieldset disabled={!canManage || busy}>
            <legend>Create agreement version</legend>
            <div className="admin-config-form-grid">
              <label className="admin-field admin-config-span-two">
                <span>Partner</span>
                <Select
                  options={[
                    { value: '', label: 'Choose an active or paused partner' },
                    ...availableAffiliates.map((affiliate) => ({
                      value: affiliate.id,
                      label: `${affiliate.publicName} · ${affiliate.status}`,
                    })),
                  ]}
                  value={affiliateId}
                  onChange={setAffiliateId}
                  invalid={Boolean(agreementErrors.affiliateId)}
                />
                {agreementErrors.affiliateId && (
                  <small className="admin-field-error">{agreementErrors.affiliateId}</small>
                )}
              </label>
              <label className="admin-field admin-config-span-two">
                <span>Commission model</span>
                <Select
                  options={Object.entries(modelLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  value={model}
                  onChange={(next) => setModel(next as AdminCommissionModel)}
                />
              </label>
              <label className="admin-field">
                <span>Attribution window (days)</span>
                <input
                  inputMode="numeric"
                  value={attributionDays}
                  onChange={(event) => setAttributionDays(event.target.value)}
                  aria-invalid={Boolean(agreementErrors.attributionDays)}
                />
                {agreementErrors.attributionDays && (
                  <small className="admin-field-error">{agreementErrors.attributionDays}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Renewal duration (optional)</span>
                <input
                  inputMode="numeric"
                  value={renewalDays}
                  onChange={(event) => setRenewalDays(event.target.value)}
                  aria-invalid={Boolean(agreementErrors.renewalDays)}
                />
                {agreementErrors.renewalDays && (
                  <small className="admin-field-error">{agreementErrors.renewalDays}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Payout frequency (days)</span>
                <input
                  inputMode="numeric"
                  value={payoutDays}
                  onChange={(event) => setPayoutDays(event.target.value)}
                  aria-invalid={Boolean(agreementErrors.payoutDays)}
                />
                {agreementErrors.payoutDays && (
                  <small className="admin-field-error">{agreementErrors.payoutDays}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Payout currency</span>
                <input
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                  maxLength={3}
                  aria-invalid={Boolean(agreementErrors.currency)}
                />
                {agreementErrors.currency && (
                  <small className="admin-field-error">{agreementErrors.currency}</small>
                )}
              </label>
              <label className="admin-field admin-config-span-two">
                <span>Minimum payout ({currency || 'currency'})</span>
                <input
                  inputMode="decimal"
                  value={minimumPayout}
                  onChange={(event) => setMinimumPayout(event.target.value)}
                  aria-invalid={Boolean(agreementErrors.minimumPayout)}
                />
                {agreementErrors.minimumPayout && (
                  <small className="admin-field-error">{agreementErrors.minimumPayout}</small>
                )}
              </label>
            </div>
            <button className="admin-primary-button" type="submit">
              {pendingKey === 'commercial:agreement:create' ? (
                <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
              ) : (
                <Plus size={17} aria-hidden="true" />
              )}{' '}
              Create draft agreement
            </button>
          </fieldset>
        </form>

        <form className="admin-config-form admin-config-subpanel" onSubmit={createRule} noValidate>
          <fieldset disabled={!canManage || busy}>
            <legend>Add commission rule</legend>
            <div className="admin-config-form-grid">
              <label className="admin-field admin-config-span-two">
                <span>Agreement</span>
                <Select
                  options={[
                    { value: '', label: 'Choose a draft agreement' },
                    ...configuration.agreements
                      .filter((agreement) =>
                        ['draft', 'awaiting_signature', 'active'].includes(agreement.status),
                      )
                      .map((agreement) => ({
                        value: agreement.id,
                        label: `${agreement.partnerName ?? agreement.affiliateId} · v${agreement.version} · ${agreement.status}`,
                      })),
                  ]}
                  value={ruleAgreementId}
                  onChange={setRuleAgreementId}
                  invalid={Boolean(ruleErrors.ruleAgreementId)}
                />
                {ruleErrors.ruleAgreementId && (
                  <small className="admin-field-error">{ruleErrors.ruleAgreementId}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Rule name</span>
                <input
                  value={ruleName}
                  onChange={(event) => setRuleName(event.target.value)}
                  aria-invalid={Boolean(ruleErrors.ruleName)}
                />
                {ruleErrors.ruleName && (
                  <small className="admin-field-error">{ruleErrors.ruleName}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Trigger event</span>
                <input
                  value={triggerEvent}
                  onChange={(event) => setTriggerEvent(event.target.value)}
                  aria-invalid={Boolean(ruleErrors.triggerEvent)}
                />
                {ruleErrors.triggerEvent && (
                  <small className="admin-field-error">{ruleErrors.triggerEvent}</small>
                )}
              </label>
              {ruleAgreement?.model !== 'revenue_share' && (
                <label className="admin-field">
                  <span>Fixed amount ({currency})</span>
                  <input
                    inputMode="decimal"
                    value={fixedAmount}
                    onChange={(event) => setFixedAmount(event.target.value)}
                    aria-invalid={Boolean(ruleErrors.fixedAmount)}
                  />
                  {ruleErrors.fixedAmount && (
                    <small className="admin-field-error">{ruleErrors.fixedAmount}</small>
                  )}
                </label>
              )}
              {(ruleAgreement?.model === 'revenue_share' || ruleAgreement?.model === 'hybrid') && (
                <label className="admin-field">
                  <span>Revenue share (%)</span>
                  <input
                    inputMode="decimal"
                    value={ratePercent}
                    onChange={(event) => setRatePercent(event.target.value)}
                    aria-invalid={Boolean(ruleErrors.ratePercent)}
                  />
                  {ruleErrors.ratePercent && (
                    <small className="admin-field-error">{ruleErrors.ratePercent}</small>
                  )}
                </label>
              )}
              <label className="admin-field">
                <span>Validation window (hours)</span>
                <input
                  inputMode="numeric"
                  value={validationHours}
                  onChange={(event) => setValidationHours(event.target.value)}
                  aria-invalid={Boolean(ruleErrors.validationHours)}
                />
                {ruleErrors.validationHours && (
                  <small className="admin-field-error">{ruleErrors.validationHours}</small>
                )}
              </label>
            </div>
            <button className="admin-primary-button" type="submit">
              <BadgeDollarSign size={17} aria-hidden="true" /> Create draft rule
            </button>
          </fieldset>
        </form>
      </div>

      {configuration.agreements.length ? (
        <div className="admin-agreement-list">
          {configuration.agreements.map((agreement) => {
            const activeRules = agreement.commissionRules.filter((rule) => rule.status === 'active')
            const supportedActivePurchaseRules = agreement.commissionRules.filter((rule) =>
              isSupportedActivePurchaseRule(agreement, rule),
            )
            const hasExactlyOneSupportedPurchaseRule =
              hasExactlyOneSupportedActivePurchaseRule(agreement)
            const canActivateAgreement =
              agreement.hasSignedDocument && hasExactlyOneSupportedPurchaseRule
            return (
              <article className="admin-config-record" key={agreement.id}>
                <div className="admin-config-record-heading">
                  <div>
                    <h3>
                      {agreement.partnerName ??
                        affiliates.find((affiliate) => affiliate.id === agreement.affiliateId)
                          ?.publicName ??
                        'Partner agreement'}
                    </h3>
                    <p>
                      Version {agreement.version} · {modelLabels[agreement.model]}
                    </p>
                  </div>
                  <span className={`admin-status-badge admin-status-${agreement.status}`}>
                    {agreement.status.replace('_', ' ')}
                  </span>
                </div>
                <dl className="admin-terms-grid">
                  <div>
                    <dt>Attribution</dt>
                    <dd>{agreement.attributionWindowDays} days</dd>
                  </div>
                  <div>
                    <dt>Payout cadence</dt>
                    <dd>{agreement.payoutFrequencyDays} days</dd>
                  </div>
                  <div>
                    <dt>Minimum payout</dt>
                    <dd>{formatMinor(agreement.minimumPayoutMinor, agreement.payoutCurrency)}</dd>
                  </div>
                  <div>
                    <dt>Bilateral document</dt>
                    <dd>{agreement.hasSignedDocument ? 'Signed' : 'Missing signatures'}</dd>
                  </div>
                  <div>
                    <dt>Partner-link gate</dt>
                    <dd>{agreement.launchReady ? 'Launch ready' : 'Blocked'}</dd>
                  </div>
                </dl>
                {agreement.commissionRules.length ? (
                  <ul className="admin-rule-list">
                    {agreement.commissionRules.map((rule) => (
                      <li key={rule.id}>
                        <span>
                          <strong>{rule.name}</strong>
                          <small>
                            {rule.triggerEvent} · v{rule.version}
                          </small>
                        </span>
                        <span className={`admin-status-badge admin-status-${rule.status}`}>
                          {rule.status}
                        </span>
                        {canManage && rule.status === 'draft' && (
                          <button
                            className="admin-text-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void setRuleStatus(rule, 'active')}
                          >
                            Activate rule
                          </button>
                        )}
                        {canManage && rule.status === 'active' && (
                          <button
                            className="admin-text-button admin-danger-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void setRuleStatus(rule, 'superseded')}
                          >
                            Supersede
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="admin-record-empty-copy">No commission rules yet.</p>
                )}
                {canManage && ['draft', 'awaiting_signature'].includes(agreement.status) && (
                  <button
                    className="admin-secondary-button"
                    type="button"
                    disabled={!canActivateAgreement || busy}
                    onClick={() => void activateAgreement(agreement)}
                  >
                    <ShieldCheck size={16} aria-hidden="true" /> Activate agreement
                  </button>
                )}
                {['draft', 'awaiting_signature'].includes(agreement.status) && (
                  <div className="admin-gate-copy">
                    {!agreement.hasSignedDocument && (
                      <small>
                        Record a current agreement document signed by both the partner and
                        KissMyApps.
                      </small>
                    )}
                    {!hasExactlyOneSupportedPurchaseRule && (
                      <small>
                        {activeRules.length > 1
                          ? 'Supersede extra active rules so exactly one remains.'
                          : supportedActivePurchaseRules.length === 0 && activeRules.length === 1
                            ? 'The active rule must use purchase.completed, match the agreement model, and use a compatible payout currency.'
                            : 'Activate exactly one purchase.completed CPA, revenue-share, or hybrid rule.'}
                      </small>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="admin-config-empty">
          <FileSignature size={25} aria-hidden="true" />
          <h3>No partner agreements</h3>
          <p>
            Main-link issuance remains blocked until real commercial terms and a rule are active.
          </p>
        </div>
      )}
    </section>
  )
}
