import { useEffect, useRef, useState } from 'react'
import { TermsSnapshot } from './TermsSnapshot'
import { CommissionSchedule } from './CommissionSchedule'
import { BankPayouts } from './BankPayouts'
import { BalanceSummary } from './BalanceSummary'
import { Dialog } from '../../components/Dialog'
import {
  settlementGateway,
  settlementMoney,
  commissionLabel,
  type SettlementGateway,
  type SettlementWorkspace,
  type SettlementScope,
  type CanonicalSettlementAgreement,
  type CommissionTerms,
} from './gateway'
import './settlements.css'

const scopeKey = (scope: SettlementScope) =>
  [
    scope.product_id,
    scope.funnel_id,
    scope.affiliate_id,
    scope.stripe_account_id,
    scope.platform_account_id,
    scope.livemode,
    scope.currency,
  ].join(':')
const fundingModelLabel = (model?: CommissionTerms['funding_model']) =>
  model === 'merchant_direct'
    ? 'Merchant direct'
    : model === 'prefunded_platform'
      ? 'Pre-funded platform'
      : model === 'application_fee'
        ? 'Collected from merchant checkout'
        : 'Funding model not recorded'
const businessScopeLabel = (scope: SettlementScope) =>
  `${scope.product_name} · ${scope.funnel_name} · ${scope.affiliate_name} · ${scope.currency ?? 'Choose currency'} · ${scope.livemode ? 'Live' : 'Test'}`
const scopeLabel = (scope: SettlementScope, model?: CommissionTerms['funding_model']) =>
  `${businessScopeLabel(scope)} · Funding ${scope.platform_account_id}${model ? ` · ${fundingModelLabel(model)}` : ''} · Merchant ${scope.stripe_account_id}`
const fundingSummary = (terms: CommissionTerms) =>
  `${fundingModelLabel(terms.funding_model)} · Funding account ${terms.platform_account_id} · Receiving merchant ${terms.stripe_account_id}`
const termsLabel = commissionLabel
type Confirmation = {
  title: string
  description: string
  input: Record<string, unknown>
  configure?: boolean
}

export function AdminSettlementsPanel({
  canWrite,
  gateway = settlementGateway,
}: {
  canWrite: boolean
  gateway?: SettlementGateway
}) {
  const [data, setData] = useState<SettlementWorkspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState('')
  const [currency, setCurrency] = useState('')
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [reason, setReason] = useState('')
  const [frozen, setFrozen] = useState<Record<string, unknown> | null>(null)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setBusy(true)
      setError(null)
      try {
        const value = await gateway.workspace(true)
        if (active) setData(value)
      } catch (e) {
        if (active) {
          setData(null)
          setError(e instanceof Error ? e.message : 'Settlements are unavailable.')
        }
      } finally {
        if (active) setBusy(false)
      }
    })
    return () => {
      active = false
    }
  }, [gateway, revision])
  const selectedScope = data?.scopes.find((item) => scopeKey(item) === selected)
  const scope =
    selectedScope && (selectedScope.currency || /^[A-Z]{3}$/.test(currency))
      ? { ...selectedScope, currency: selectedScope.currency ?? currency }
      : null
  const open = (next: Confirmation) => {
    setConfirm(next)
    setReason('')
    setFrozen(null)
    setActionError(null)
  }
  const submit = async () => {
    if (!confirm || pending.current || (!frozen && reason.trim().length < 8)) return
    pending.current = true
    const input = frozen ?? {
      ...confirm.input,
      reason: reason.trim(),
      request_id: crypto.randomUUID(),
    }
    setFrozen(input)
    setSaving(true)
    setActionError(null)
    try {
      await (confirm.configure ? gateway.configure(input) : gateway.action(input))
      setNotice(
        `${confirm.title} completed. Provider delivery remains subject to the configured worker and approval gates.`,
      )
      setConfirm(null)
      setFrozen(null)
      setRevision((n) => n + 1)
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : 'The action could not be confirmed. Retry this same request.',
      )
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  const labelFor = (row: {
    product_id: string
    funnel_id: string
    affiliate_id: string
    livemode: boolean
    currency: string
    platform_account_id?: string
    stripe_account_id?: string
    funding_model?: CommissionTerms['funding_model']
    terms_id?: string | null
  }) => {
    const terms = row.terms_id ? data?.terms.find((term) => term.id === row.terms_id) : undefined
    const platform = row.platform_account_id ?? terms?.platform_account_id
    const merchant = row.stripe_account_id ?? terms?.stripe_account_id
    const item = data?.scopes.find(
      (s) =>
        s.product_id === row.product_id &&
        s.funnel_id === row.funnel_id &&
        s.affiliate_id === row.affiliate_id &&
        s.livemode === row.livemode &&
        s.currency === row.currency &&
        (!platform || s.platform_account_id === platform) &&
        (!merchant || s.stripe_account_id === merchant),
    )
    return item
      ? platform
        ? scopeLabel(item, row.funding_model ?? terms?.funding_model)
        : businessScopeLabel(item)
      : `${row.currency} · ${row.livemode ? 'Live' : 'Test'}`
  }
  const scopeFundingModel = (item: SettlementScope) =>
    data?.terms
      .filter(
        (term) =>
          term.product_id === item.product_id &&
          term.funnel_id === item.funnel_id &&
          term.affiliate_id === item.affiliate_id &&
          term.stripe_account_id === item.stripe_account_id &&
          term.platform_account_id === item.platform_account_id &&
          term.livemode === item.livemode &&
          term.currency === item.currency,
      )
      .sort((a, b) => b.version - a.version)[0]?.funding_model
  return (
    <section className="creator-settlements" aria-label="External purchase settlements">
      <header>
        <div>
          <h2>External purchase settlements</h2>
          <p>
            Manage creator commissions for products that take payments in their own Stripe account.
          </p>
        </div>
        <button type="button" disabled={busy || saving} onClick={() => setRevision((n) => n + 1)}>
          {busy ? 'Loading settlements…' : 'Refresh settlements'}
        </button>
      </header>
      <p>
        Terms start unconfigured and apply to purchases made after approval. Each payout batch
        requires review and approval; bank payout status is separate from a transfer.
      </p>
      {error && (
        <p role="alert" className="settlement-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data?.truncated && (
        <p role="status">
          Showing the latest 100 records per section. This view is not a complete account statement.
          Each batch still includes all its frozen items.
        </p>
      )}
      {data && (
        <>
          <details>
            <summary>Funding connections</summary>
            {data.platforms.length === 0 && <p>No funding platforms are configured yet.</p>}
            {data.platforms.map((platform) => (
              <article
                className="settlement-card"
                key={`${platform.platform_account_id}:${platform.livemode}`}
              >
                <strong>
                  {platform.platform_account_id} · {platform.livemode ? 'Live' : 'Test'}
                </strong>
                <p>
                  {platform.enabled
                    ? 'Database release gate enabled'
                    : 'Database release gate disabled'}
                  . The provider worker also has a separate enable switch.
                </p>
                {canWrite && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      open({
                        title: platform.enabled
                          ? 'Disable funding connection'
                          : 'Enable funding connection',
                        description: `${platform.platform_account_id} · ${platform.livemode ? 'LIVE' : 'TEST'}. Enabling this gate allows approved batches to be claimed if the provider worker is also enabled.`,
                        input: {
                          action: 'set_platform_enabled',
                          platform_account_id: platform.platform_account_id,
                          livemode: platform.livemode,
                          enabled: !platform.enabled,
                          expected_revision: platform.revision,
                        },
                      })
                    }
                  >
                    {platform.enabled ? 'Disable connection' : 'Review enablement'}
                  </button>
                )}
              </article>
            ))}
          </details>
          <label>
            Creator and product scope
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value)
                setCurrency('')
              }}
              disabled={busy}
            >
              <option value="">Choose a scope</option>
              {data.scopes.map((item) => (
                <option key={scopeKey(item)} value={scopeKey(item)}>
                  {scopeLabel(item, scopeFundingModel(item))}
                </option>
              ))}
            </select>
          </label>
          {selectedScope?.currency === null && (
            <label>
              Signed agreement currency
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                <option value="">Choose agreement currency</option>
                {[
                  ...new Set(
                    (data.agreements ?? [])
                      .filter(
                        (agreement) =>
                          agreement.eligible &&
                          agreement.product_id === selectedScope.product_id &&
                          agreement.affiliate_id === selectedScope.affiliate_id,
                      )
                      .map((agreement) => agreement.payout_currency),
                  ),
                ].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!data.scopes.length && (
            <p>
              A verified merchant, commercial product and creator agreement must be configured
              before terms can be added.
            </p>
          )}
          {scope && canWrite && (
            <>
              <FundingMappingForm
                key={`${selected}:${scope.currency}`}
                scope={scope}
                agreements={data.agreements ?? []}
                expectedVersion={Math.max(
                  0,
                  ...data.terms
                    .filter(
                      (term) =>
                        term.product_id === scope.product_id &&
                        term.funnel_id === scope.funnel_id &&
                        term.affiliate_id === scope.affiliate_id &&
                        term.stripe_account_id === scope.stripe_account_id &&
                        term.livemode === scope.livemode &&
                        term.currency === scope.currency,
                    )
                    .map((term) => term.version),
                )}
                onReview={(input, description) =>
                  open({
                    title: 'Save funding mapping draft',
                    description,
                    input,
                    configure: true,
                  })
                }
              />
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  open({
                    title: 'Prepare settlement batch',
                    description: `${scopeLabel(scope)}. The server will select eligible earnings and freeze the amount for review.`,
                    input: {
                      action: 'prepare_batch',
                      product_id: scope.product_id,
                      funnel_id: scope.funnel_id,
                      affiliate_id: scope.affiliate_id,
                      platform_account_id: scope.platform_account_id,
                      livemode: scope.livemode,
                      currency: scope.currency,
                    },
                  })
                }
              >
                Prepare eligible earnings
              </button>
            </>
          )}
          <h3>Signed terms and funding mappings</h3>
          {!data.terms.length && (
            <p>No commission terms have been configured. Purchases remain on hold.</p>
          )}
          {data.terms
            .filter(
              (row) =>
                !scope ||
                (row.product_id === scope.product_id &&
                  row.funnel_id === scope.funnel_id &&
                  row.affiliate_id === scope.affiliate_id &&
                  row.livemode === scope.livemode &&
                  row.currency === scope.currency),
            )
            .map((terms) => (
              <article className="settlement-card" key={terms.id}>
                <strong>{labelFor(terms)}</strong>
                <p>{fundingSummary(terms)}</p>
                <p>
                  {termsLabel(terms)} · {terms.validation_window_hours ?? terms.hold_days * 24}-hour
                  hold · {terms.attribution_window_days}
                  -day attribution window · version {terms.version} · {terms.status}
                </p>
                <p className="settlement-muted">
                  Frozen agreement terms. Effective{' '}
                  {new Date(terms.effective_from).toLocaleString()}
                  {terms.effective_until
                    ? ` until ${new Date(terms.effective_until).toLocaleString()}`
                    : ''}
                  .
                </p>
                <TermsSnapshot terms={terms} admin />
                {canWrite && terms.status === 'draft' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      open({
                        title: 'Approve funding mapping',
                        description: `${labelFor(terms)}. ${fundingSummary(terms)}. Signed agreement ${terms.agreement_id ?? 'not recorded'} v${terms.agreement_version ?? '?'}; rule ${terms.commission_rule_id ?? 'not recorded'} v${terms.commission_rule_version ?? '?'}. ${termsLabel(terms)}, ${terms.validation_window_hours ?? terms.hold_days * 24}-hour validation hold and ${terms.attribution_window_days}-day attribution window. Basis: ${terms.commission_basis_policy === 'net_after_fees' ? 'net after payment fees' : terms.commission_basis_policy === 'subtotal_ex_tax_shipping' ? 'subtotal after discounts, excluding tax and shipping' : 'not recorded'}. Ordinary refund cutoff: ${terms.refund_cutoff_days === null ? 'unlimited' : terms.refund_cutoff_days === undefined ? 'not recorded' : `${terms.refund_cutoff_days} days`}. Minimum payout: ${terms.minimum_payout_minor == null ? 'not recorded' : settlementMoney(terms.minimum_payout_minor, terms.currency)}; cadence: ${terms.payout_frequency_days ?? 'not recorded'} days. Effective from ${new Date(terms.effective_from).toLocaleString()}${terms.effective_until ? ` until ${new Date(terms.effective_until).toLocaleString()}` : ` with no fixed end date`}. This approves the funding mapping for existing signed terms; it does not edit the agreement. Earlier purchases are not retroactively approved.`,
                        input: {
                          action: 'approve_terms',
                          id: terms.id,
                          expected_revision: terms.revision,
                        },
                      })
                    }
                  >
                    Review funding mapping approval
                  </button>
                )}
              </article>
            ))}
          <h3>Settlement batches</h3>
          {!data.batches.length && <p>No settlement batches yet.</p>}
          {data.batches.map((batch) => (
            <article className="settlement-card" key={batch.id}>
              <strong>
                {labelFor(batch)} · {settlementMoney(batch.amount_minor, batch.currency)}
              </strong>
              <p>
                Status: {batch.status.replaceAll('_', ' ')} · Funding account:{' '}
                {batch.platform_account_id}
              </p>
              {batch.reason && <p>{batch.reason}</p>}
              {batch.provider_jobs.map((job, index) => (
                <p
                  key={`${job.kind}:${index}`}
                  className={job.last_error ? 'settlement-error' : undefined}
                >
                  {job.kind === 'reversal' ? 'Transfer recovery' : 'Stripe transfer'}:{' '}
                  {job.state.replaceAll('_', ' ')} · {job.attempts} attempts
                  {job.last_error ? ` · ${job.last_error.replaceAll('_', ' ')}` : ''}
                </p>
              ))}
              <details>
                <summary>Frozen items ({batch.items.length})</summary>
                <div className="settlement-table-wrap">
                  <table className="settlement-table">
                    <thead>
                      <tr>
                        <th>Purchase</th>
                        <th>Commission</th>
                        <th>Current eligibility</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.items.map((item) => (
                        <tr key={item.award_id}>
                          <td>{item.order_id}</td>
                          <td>{settlementMoney(item.amount_minor, batch.currency)}</td>
                          <td>
                            {item.status.replaceAll('_', ' ')}
                            {item.eligible_at
                              ? ` · ${new Date(item.eligible_at).toLocaleString()}`
                              : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              {canWrite && (
                <div className="settlement-actions">
                  {[
                    {
                      action: 'review_batch',
                      title: 'Review batch',
                      enabled: ['draft', 'held'].includes(batch.status),
                    },
                    {
                      action: 'approve_batch',
                      title: 'Approve batch',
                      enabled: batch.status === 'reviewed',
                    },
                    {
                      action: 'hold_batch',
                      title: 'Hold batch',
                      enabled: ['draft', 'reviewed', 'approved'].includes(batch.status),
                    },
                    {
                      action: 'cancel_batch',
                      title: 'Cancel batch',
                      enabled: ['draft', 'reviewed', 'approved', 'held'].includes(batch.status),
                    },
                    {
                      action: 'reconcile_batch',
                      title: 'Check provider outcome',
                      enabled: batch.provider_jobs.some(
                        (job) => job.first_attempt_at && job.state !== 'succeeded',
                      ),
                    },
                  ]
                    .filter((item) => item.enabled)
                    .map((item) => (
                      <button
                        type="button"
                        key={item.action}
                        disabled={busy}
                        onClick={() =>
                          open({
                            title: item.title,
                            description: `${labelFor(batch)}. Amount: ${settlementMoney(batch.amount_minor, batch.currency)}. Funding account: ${batch.platform_account_id}. ${item.action === 'approve_batch' ? 'Approval authorizes the configured worker to transfer this amount once all eligibility checks pass.' : item.action === 'reconcile_batch' ? 'This requests a provider lookup for attempted transfers or reversals. It does not authorize another payment or mark a bank payout as paid.' : 'The server will recheck the frozen earnings and latest refund state.'}`,
                            input: {
                              action: item.action,
                              id: batch.id,
                              expected_revision: batch.revision,
                            },
                          })
                        }
                      >
                        {item.title}
                      </button>
                    ))}
                </div>
              )}
            </article>
          ))}
          <details>
            <summary>Commission calculation and hold details ({data.commissions.length})</summary>
            <div className="settlement-table-wrap">
              <table className="settlement-table">
                <thead>
                  <tr>
                    <th>Creator / product</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.commissions.map((commission) => (
                    <tr key={commission.id}>
                      <td>{labelFor(commission)}</td>
                      <td>
                        {commission.status === 'unconfigured' || commission.basis_minor === null
                          ? 'Not calculated'
                          : settlementMoney(commission.commission_minor, commission.currency)}
                      </td>
                      <td>{commission.status}</td>
                      <td>
                        {commission.blocker?.replaceAll('_', ' ') ??
                          (commission.payout_blocker ? null : '—')}
                        <CommissionSchedule commission={commission} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      {data && <BankPayouts items={data.bank_payouts ?? []} />}
      {data && <BalanceSummary items={data.balances} admin />}
      <Dialog
        open={!!confirm}
        onOpenChange={(openState) => {
          if (!openState && !saving) setConfirm(null)
        }}
        title={confirm?.title ?? 'Review settlement'}
        description={confirm?.description ?? 'Review the settlement action.'}
        dismissible={!saving}
      >
        <div className="creator-settlements">
          <label>
            Audit reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={saving || !!frozen}
              rows={3}
              placeholder="Explain the agreement or review supporting this action."
            />
          </label>
          {actionError && (
            <p role="alert" className="settlement-error">
              {actionError}
            </p>
          )}
          <div className="settlement-actions">
            <button
              type="button"
              disabled={saving || (!frozen && reason.trim().length < 8)}
              onClick={() => void submit()}
            >
              {saving
                ? 'Saving…'
                : frozen
                  ? 'Retry same request'
                  : `Confirm ${confirm?.title.toLowerCase()}`}
            </button>
            <button type="button" disabled={saving} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    </section>
  )
}

function FundingMappingForm({
  scope,
  agreements,
  expectedVersion,
  onReview,
}: {
  scope: SettlementScope & { currency: string }
  agreements: CanonicalSettlementAgreement[]
  expectedVersion: number
  onReview: (input: Record<string, unknown>, description: string) => void
}) {
  const [selection, setSelection] = useState('')
  const [fundingModel, setFundingModel] = useState('')
  const [fundingAccount, setFundingAccount] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const choices = agreements
    .filter(
      (agreement) =>
        agreement.eligible &&
        agreement.status === 'active' &&
        agreement.signed_document_id &&
        agreement.terms_sha256 &&
        agreement.product_id === scope.product_id &&
        agreement.affiliate_id === scope.affiliate_id &&
        agreement.payout_currency === scope.currency,
    )
    .flatMap((agreement) =>
      agreement.rules
        .filter(
          (rule) =>
            rule.status === 'active' &&
            rule.trigger_event === 'purchase.completed' &&
            ['cpa', 'revenue_share', 'hybrid'].includes(rule.model),
        )
        .map((rule) => ({ agreement, rule, key: `${agreement.id}:${rule.id}` })),
    )
  const selected = choices.find((choice) => choice.key === selection)
  return (
    <details className="settlement-card">
      <summary>Connect a signed agreement to funding</summary>
      <p>
        Commission rates, attribution, validation holds, refund policy and payout settings come from
        the signed product agreement.
      </p>
      <p>
        <a href={`#admin/products/${encodeURIComponent(scope.product_id)}/configuration`}>
          Manage agreements and commission rules
        </a>
      </p>
      {!choices.length ? (
        <p>
          No eligible signed agreement matches this creator and currency. Complete the existing
          product agreement first.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            try {
              if (
                !selected ||
                !['merchant_direct', 'prefunded_platform', 'application_fee'].includes(
                  fundingModel,
                ) ||
                !start
              )
                throw Error('Choose a signed agreement, funding model and effective date.')
              const platformAccount =
                fundingModel === 'merchant_direct'
                  ? scope.stripe_account_id
                  : fundingModel === 'application_fee'
                    ? scope.platform_account_id
                    : fundingAccount.trim()
              if (
                fundingModel === 'prefunded_platform' &&
                !/^acct_[A-Za-z0-9]+$/.test(platformAccount)
              )
                throw Error('Enter the reviewed platform account ID for pre-funded payouts.')
              const effectiveFrom = new Date(`${start}T00:00:00Z`).toISOString()
              const effectiveUntil = end ? new Date(`${end}T00:00:00Z`).toISOString() : null
              if (effectiveUntil && effectiveUntil <= effectiveFrom)
                throw Error('The end date must be later than the start date.')
              onReview(
                {
                  expected_version: expectedVersion,
                  agreement_id: selected.agreement.id,
                  commission_rule_id: selected.rule.id,
                  product_id: scope.product_id,
                  funnel_id: scope.funnel_id,
                  affiliate_id: scope.affiliate_id,
                  stripe_account_id: scope.stripe_account_id,
                  platform_account_id: platformAccount,
                  livemode: scope.livemode,
                  currency: scope.currency,
                  funding_model: fundingModel,
                  effective_from: effectiveFrom,
                  effective_until: effectiveUntil,
                },
                `${scopeLabel(scope)}: funding account ${platformAccount}; signed agreement v${selected.agreement.version}, ${selected.rule.name} v${selected.rule.version}. ${fundingModel === 'merchant_direct' ? 'Funded directly by the merchant.' : fundingModel === 'application_fee' ? 'Collected as a Stripe application fee from eligible connected merchant checkouts. Existing commission and payout rules apply.' : 'Requires separately pre-funded platform balance; no automatic movement from the merchant is implied.'} Effective ${effectiveFrom}${effectiveUntil ? ` until ${effectiveUntil}` : ''}. This saves a draft funding mapping; separate approval is required.`,
              )
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Check the funding mapping.')
            }
          }}
        >
          <div className="settlement-grid">
            <label>
              Signed agreement and rule
              <select
                value={selection}
                onChange={(event) => setSelection(event.target.value)}
                required
              >
                <option value="">Choose signed terms</option>
                {choices.map(({ key, agreement, rule }) => (
                  <option key={key} value={key}>
                    Agreement v{agreement.version} · {rule.name} v{rule.version} ·{' '}
                    {agreement.payout_currency}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Funding model
              <select
                value={fundingModel}
                onChange={(event) => setFundingModel(event.target.value)}
                required
              >
                <option value="">Choose funding model</option>
                <option value="merchant_direct">Merchant account directly</option>
                <option value="prefunded_platform">Pre-funded platform balance</option>
                <option value="application_fee">Collected from merchant checkout</option>
              </select>
            </label>
            {fundingModel === 'prefunded_platform' && (
              <label>
                Reviewed platform account ID
                <input
                  value={fundingAccount}
                  onChange={(event) => setFundingAccount(event.target.value)}
                  placeholder="acct_…"
                  required
                />
                <small>
                  Use the separately approved funding account. Saving this mapping does not verify
                  provider access or enable payouts.
                </small>
              </label>
            )}
            {fundingModel === 'application_fee' && (
              <p className="settlement-muted">
                KMA collects the agreed commission from eligible payments made through the connected
                merchant checkout. The assigned connection supplies the merchant and platform
                accounts. This uses your signed commission, refund and payout settings; payouts
                still require approval. Rules based on payment fees or first-purchase eligibility
                cannot be collected automatically until that eligibility can be verified before
                payment.
              </p>
            )}
            <label>
              Effective from (UTC)
              <input
                type="date"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                required
              />
            </label>
            <label>
              Effective until (UTC, optional)
              <input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
            </label>
          </div>
          {selected && (
            <p>
              {selected.rule.rate_basis_points !== null
                ? `${selected.rule.rate_basis_points / 100}%`
                : ''}
              {selected.rule.fixed_amount_minor !== null
                ? ` ${settlementMoney(selected.rule.fixed_amount_minor, selected.rule.currency ?? scope.currency)}`
                : ''}{' '}
              · {selected.rule.validation_window_hours}-hour validation hold ·{' '}
              {selected.agreement.attribution_window_days}-day attribution · Ordinary refund cutoff:{' '}
              {selected.rule.refund_cutoff_days === null
                ? 'unlimited'
                : `${selected.rule.refund_cutoff_days} days`}{' '}
              · Payout every {selected.agreement.payout_frequency_days} days, minimum{' '}
              {settlementMoney(selected.agreement.minimum_payout_minor, scope.currency)}.
            </p>
          )}
          {error && (
            <p role="alert" className="settlement-error">
              {error}
            </p>
          )}
          <button type="submit">Review funding mapping</button>
        </form>
      )}
    </details>
  )
}
