import { useMemo, useState, type FormEvent } from 'react'
import {
  BadgeDollarSign,
  Check,
  Clock3,
  FileSignature,
  LoaderCircle,
  Paperclip,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
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

const DOCUMENT_STATUS_COPY: Record<string, string> = {
  awaiting_partner_signature: 'Awaiting partner signature',
  awaiting_kissmyapps_signature: 'Awaiting KissMyApps countersignature',
  signed: 'Signed',
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'pending'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unavailable'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
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
  const [renewalDays, setRenewalDays] = useState('7')
  const [payoutDays, setPayoutDays] = useState('14')
  const [currency, setCurrency] = useState('USD')
  const [minimumPayout, setMinimumPayout] = useState('20.00')
  const [agreementErrors, setAgreementErrors] = useState<Record<string, string>>({})
  const [ruleAgreementId, setRuleAgreementId] = useState('')
  const [ruleName, setRuleName] = useState('')
  const TRIGGER_EVENT = 'purchase.completed' as const
  const [fixedAmount, setFixedAmount] = useState('')
  const [ratePercent, setRatePercent] = useState('')
  const [validationHours, setValidationHours] = useState('72')
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({})
  const [pendingDocument, setPendingDocument] = useState<{
    agreementId: string
    affiliateId: string
    file: File
  } | null>(null)
  const [revoking, setRevoking] = useState<{ documentId: string; reason: string } | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<
    { kind: 'rule'; id: string } | { kind: 'agreement'; id: string } | null
  >(null)
  const [supersedingRuleId, setSupersedingRuleId] = useState<string | null>(null)
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
    if (created) {
      setAffiliateId('')
      setModel('cpa')
      setAttributionDays('30')
      setRenewalDays('7')
      setPayoutDays('14')
      setCurrency('USD')
      setMinimumPayout('20.00')
    }
  }

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const selectedModel = ruleAgreement?.model ?? 'cpa'
    const nextErrors: Record<string, string> = {
      ...validateCommissionValues({
        model: selectedModel,
        triggerEvent: TRIGGER_EVENT,
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
          triggerEvent: TRIGGER_EVENT,
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

  async function confirmDeletion() {
    if (!deleting || pendingKey) return
    if (deleting.kind === 'rule') {
      if (!gateway.deleteCommissionRule) return
      const removed = await runAction(
        `commercial:rule:delete:${deleting.id}`,
        () => gateway.deleteCommissionRule!({ commissionRuleId: deleting.id }),
        'Commission rule deleted.',
      )
      if (removed) setDeleting(null)
      return
    }
    if (!gateway.deleteAgreement) return
    const removed = await runAction(
      `commercial:agreement:delete:${deleting.id}`,
      () => gateway.deleteAgreement!({ agreementId: deleting.id }),
      'Draft agreement deleted.',
    )
    if (removed) setDeleting(null)
  }

  function activateAgreement(agreement: AdminAgreement) {
    return runAction(
      `commercial:agreement:activate:${agreement.id}`,
      () => gateway.activateAgreement({ agreementId: agreement.id }),
      `Agreement version ${agreement.version} is active.`,
    )
  }

  async function uploadAgreementDocument() {
    if (!pendingDocument || pendingKey || !gateway.uploadAgreementDocument) return
    const uploaded = await runAction(
      `commercial:doc:upload:${pendingDocument.agreementId}`,
      () =>
        gateway.uploadAgreementDocument!({
          agreementId: pendingDocument.agreementId,
          affiliateId: pendingDocument.affiliateId,
          file: pendingDocument.file,
        }),
      'Agreement sent to the partner for signature.',
    )
    if (uploaded) setPendingDocument(null)
  }

  function countersignDocument(agreement: AdminAgreement) {
    if (!agreement.document || !gateway.countersignAgreementDocument) return
    return runAction(
      `commercial:doc:countersign:${agreement.document.id}`,
      () => gateway.countersignAgreementDocument!({ documentId: agreement.document!.id }),
      'KissMyApps countersignature recorded. The agreement document is fully signed.',
    )
  }

  async function revokeDocument() {
    if (!revoking || pendingKey || !gateway.revokeAgreementDocument) return
    if (revoking.reason.trim().length < 10) {
      setRevokeError('Enter a reason between 10 and 500 characters.')
      return
    }
    const revoked = await runAction(
      `commercial:doc:revoke:${revoking.documentId}`,
      () =>
        gateway.revokeAgreementDocument!({
          documentId: revoking.documentId,
          reason: revoking.reason,
        }),
      'Agreement document revoked.',
    )
    if (revoked) setRevoking(null)
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
                {agreementErrors.renewalDays ? (
                  <small className="admin-field-error">{agreementErrors.renewalDays}</small>
                ) : (
                  <small className="admin-field-hint">
                    How many days renewals keep earning commission. Blank means for as long as the
                    subscription stays active.
                  </small>
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
                  value="purchase.completed"
                  readOnly
                  aria-readonly="true"
                  className="admin-field-locked"
                />
                <small className="admin-field-hint">
                  Fixed for launch: commission is earned when a purchase completes.
                </small>
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
            // Only one agreement per partner can ever be active; older drafts
            // are clutter from earlier working copies and are de-emphasised.
            const isNewestDraftForPartner =
              agreement.status !== 'draft' ||
              !configuration.agreements.some(
                (candidate) =>
                  candidate.affiliateId === agreement.affiliateId &&
                  candidate.status === 'draft' &&
                  candidate.version > agreement.version,
              )
            return (
              <article
                className={`admin-config-record${agreement.status === 'draft' && !isNewestDraftForPartner ? ' admin-agreement-older-draft' : ''}`}
                key={agreement.id}
              >
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
                  <span className="admin-config-record-badges">
                    {agreement.status === 'draft' && !isNewestDraftForPartner && (
                      <span className="admin-older-draft-badge">OLDER DRAFT</span>
                    )}
                    <span className={`admin-status-badge admin-status-${agreement.status}`}>
                      {agreement.status.replace('_', ' ')}
                    </span>
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
                    <dd>
                      {agreement.hasSignedDocument
                        ? 'Signed'
                        : agreement.document
                          ? DOCUMENT_STATUS_COPY[agreement.document.status]
                          : 'Not uploaded'}
                    </dd>
                  </div>
                  <div>
                    <dt>Partner-link gate</dt>
                    <dd>{agreement.launchReady ? 'Launch ready' : 'Blocked'}</dd>
                  </div>
                </dl>
                <div className="admin-agreement-document">
                  <p className="admin-eyebrow">AGREEMENT DOCUMENT</p>
                  {agreement.document ? (
                    <ul className="admin-doc-timeline">
                      <li
                        className={
                          agreement.document.partnerSignedAt
                            ? 'admin-check-passed'
                            : 'admin-check-blocked'
                        }
                      >
                        <span>
                          {agreement.document.partnerSignedAt ? (
                            <Check size={15} aria-hidden="true" />
                          ) : (
                            <Clock3 size={15} aria-hidden="true" />
                          )}
                        </span>
                        {agreement.document.partnerSignedAt
                          ? `Partner signed${agreement.document.partnerSignerName ? ` as ${agreement.document.partnerSignerName}` : ''} · ${formatTimestamp(agreement.document.partnerSignedAt)}`
                          : 'Waiting for the partner to sign'}
                      </li>
                      <li
                        className={
                          agreement.document.companySignedAt
                            ? 'admin-check-passed'
                            : 'admin-check-blocked'
                        }
                      >
                        <span>
                          {agreement.document.companySignedAt ? (
                            <Check size={15} aria-hidden="true" />
                          ) : (
                            <Clock3 size={15} aria-hidden="true" />
                          )}
                        </span>
                        {agreement.document.companySignedAt
                          ? `KissMyApps countersigned · ${formatTimestamp(agreement.document.companySignedAt)}`
                          : 'Waiting for the KissMyApps countersignature'}
                      </li>
                    </ul>
                  ) : (
                    <p className="admin-record-empty-copy">
                      Upload the signed-terms PDF, then the partner signs it in their dashboard and
                      an Owner or Operations administrator countersigns.
                    </p>
                  )}
                  {canManage &&
                    (typeof gateway.uploadAgreementDocument === 'function' ||
                      typeof gateway.countersignAgreementDocument === 'function' ||
                      typeof gateway.revokeAgreementDocument === 'function') &&
                    (agreement.document?.status === 'awaiting_partner_signature' ||
                      agreement.document?.status === 'awaiting_kissmyapps_signature' ||
                      (!agreement.document &&
                        !['superseded', 'expired', 'terminated'].includes(agreement.status))) && (
                      <div className="admin-doc-actions">
                        {!agreement.document && (
                          <>
                            <label
                              className={`admin-doc-picker${pendingDocument?.agreementId === agreement.id ? ' admin-doc-picker-chosen' : ''}`}
                            >
                              <input
                                type="file"
                                accept="application/pdf"
                                className="sr-only"
                                aria-label={`Agreement PDF for version ${agreement.version}`}
                                onChange={(event) => {
                                  const file = event.target.files?.[0]
                                  setRevokeError(null)
                                  setPendingDocument(
                                    file
                                      ? {
                                          agreementId: agreement.id,
                                          affiliateId: agreement.affiliateId,
                                          file,
                                        }
                                      : null,
                                  )
                                }}
                              />
                              <Paperclip size={15} aria-hidden="true" />
                              {pendingDocument?.agreementId === agreement.id
                                ? pendingDocument.file.name
                                : 'Choose the agreement PDF'}
                            </label>
                            {pendingDocument?.agreementId === agreement.id && (
                              <button
                                className="admin-primary-button"
                                type="button"
                                disabled={busy}
                                onClick={() => void uploadAgreementDocument()}
                              >
                                <LoaderCircle
                                  className={
                                    pendingKey === `commercial:doc:upload:${agreement.id}`
                                      ? 'admin-spin'
                                      : ''
                                  }
                                  size={16}
                                  aria-hidden="true"
                                />{' '}
                                Send for partner signature
                              </button>
                            )}
                          </>
                        )}
                        {agreement.document?.status === 'awaiting_kissmyapps_signature' && (
                          <button
                            className="admin-primary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void countersignDocument(agreement)}
                          >
                            <ShieldCheck size={16} aria-hidden="true" /> Countersign for KissMyApps
                          </button>
                        )}
                        {agreement.document &&
                          !revoking?.documentId &&
                          agreement.document.status !== 'signed' && (
                            <button
                              className="admin-text-button"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setRevokeError(null)
                                setRevoking({ documentId: agreement.document!.id, reason: '' })
                              }}
                            >
                              Revoke
                            </button>
                          )}
                      </div>
                    )}
                  {revoking?.documentId === agreement.document?.id &&
                    revoking &&
                    agreement.document && (
                      <div
                        className="admin-confirm-action"
                        role="group"
                        aria-label="Revoke document"
                      >
                        <p>
                          <strong>Revoke this agreement document?</strong>
                          <span>
                            The partner loses the signing request. Give a reason for the audit log.
                          </span>
                        </p>
                        <label className="admin-field">
                          <span>Reason</span>
                          <input
                            value={revoking.reason}
                            onChange={(event) =>
                              setRevoking({
                                documentId: revoking.documentId,
                                reason: event.target.value,
                              })
                            }
                            aria-invalid={Boolean(revokeError)}
                          />
                          {revokeError && (
                            <small className="admin-field-error">{revokeError}</small>
                          )}
                        </label>
                        <div className="admin-record-actions">
                          <button
                            className="admin-primary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void revokeDocument()}
                          >
                            Confirm revocation
                          </button>
                          <button
                            className="admin-secondary-button"
                            type="button"
                            disabled={busy}
                            onClick={() => setRevoking(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                </div>
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
                        {canManage &&
                          rule.status === 'active' &&
                          ['draft', 'awaiting_signature'].includes(agreement.status) && (
                            <button
                              className="admin-text-button"
                              type="button"
                              disabled={busy}
                              onClick={() => void setRuleStatus(rule, 'active')}
                            >
                              Activate rule
                            </button>
                          )}
                        {canManage &&
                          rule.status === 'active' &&
                          agreement.status === 'active' &&
                          (supersedingRuleId === rule.id ? (
                            <span className="admin-record-actions">
                              <button
                                className="admin-text-button admin-danger-button"
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  void setRuleStatus(rule, 'superseded')
                                  setSupersedingRuleId(null)
                                }}
                              >
                                Confirm supersede
                              </button>
                              <button
                                className="admin-text-button"
                                type="button"
                                disabled={busy}
                                onClick={() => setSupersedingRuleId(null)}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              className="admin-text-button admin-danger-button"
                              type="button"
                              disabled={busy}
                              onClick={() => setSupersedingRuleId(rule.id)}
                            >
                              Supersede
                            </button>
                          ))}
                        {canManage &&
                          agreement.status !== 'active' &&
                          typeof gateway.deleteCommissionRule === 'function' &&
                          (deleting?.kind === 'rule' && deleting.id === rule.id ? (
                            <span className="admin-record-actions">
                              <button
                                className="admin-text-button admin-danger-button"
                                type="button"
                                disabled={busy}
                                onClick={() => void confirmDeletion()}
                              >
                                Confirm delete
                              </button>
                              <button
                                className="admin-text-button"
                                type="button"
                                disabled={busy}
                                onClick={() => setDeleting(null)}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              className="admin-text-button admin-danger-button"
                              type="button"
                              disabled={busy}
                              onClick={() => setDeleting({ kind: 'rule', id: rule.id })}
                            >
                              <Trash2 size={14} aria-hidden="true" /> Delete
                            </button>
                          ))}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="admin-record-empty-copy">No commission rules yet.</p>
                )}
                <div className="admin-record-actions admin-agreement-card-actions">
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
                  {canManage &&
                    ['draft', 'awaiting_signature'].includes(agreement.status) &&
                    typeof gateway.deleteAgreement === 'function' && (
                      <button
                        className="admin-text-button admin-danger-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeleting({ kind: 'agreement', id: agreement.id })}
                      >
                        <Trash2 size={14} aria-hidden="true" /> Delete draft
                      </button>
                    )}
                </div>
                {deleting?.kind === 'agreement' && deleting.id === agreement.id && (
                  <div
                    className="admin-confirm-action"
                    role="group"
                    aria-label="Delete draft agreement"
                  >
                    <p>
                      <strong>Delete this draft agreement?</strong>
                      <span>
                        Its commission rules are removed with it. Active agreements can never be
                        deleted, only superseded by a new version.
                      </span>
                    </p>
                    <div className="admin-record-actions">
                      <button
                        className="admin-primary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmDeletion()}
                      >
                        Confirm deletion
                      </button>
                      <button
                        className="admin-secondary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
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
