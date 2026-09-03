import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Ban,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileCheck2,
  Link2,
  LoaderCircle,
  Mail,
  PauseCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCheck,
  Users,
} from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import { Select } from '../../../components/Select'
import type {
  AdminAffiliateDirectoryInput,
  AdminAffiliateDirectoryRecord,
  AdminAffiliateDirectorySort,
  AdminAffiliateEmailConfirmationStatus,
  AdminAffiliateStatus,
  AdminContext,
  AdminGateway,
} from '../api'
import {
  activationStatusLabel,
  affiliateInitial,
  affiliateStatusLabel,
  confirmationStatusLabel,
  formatAdminTimestamp,
  registrationKindLabel,
  safeExternalUrl,
} from './affiliatePresentation'
import { useAffiliateDirectory } from './useAffiliateDirectory'

type AffiliateAction = 'pause' | 'reactivate' | 'terminate'

const statuses: readonly AdminAffiliateStatus[] = [
  'draft',
  'invited',
  'active',
  'paused',
  'terminated',
]

const confirmationStatuses: readonly AdminAffiliateEmailConfirmationStatus[] = [
  'confirmed',
  'pending',
  'unknown',
]

const sorts: ReadonlyArray<{ value: AdminAffiliateDirectorySort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
]

function SummaryCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: number | null
  detail: string
  tone: 'pink' | 'yellow' | 'green' | 'red' | 'muted'
}) {
  const Icon =
    tone === 'green'
      ? CircleCheck
      : tone === 'yellow'
        ? Clock3
        : tone === 'red'
          ? Ban
          : tone === 'muted'
            ? PauseCircle
            : Users
  return (
    <article className="admin-affiliate-summary-card">
      <span className={`admin-affiliate-summary-icon admin-affiliate-summary-${tone}`}>
        <Icon size={19} aria-hidden="true" />
      </span>
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
      <small>{detail}</small>
    </article>
  )
}

function AffiliateStatusBadge({ status }: { status: AdminAffiliateStatus }) {
  return (
    <span className={`admin-status-badge admin-status-${status}`}>
      {affiliateStatusLabel(status)}
    </span>
  )
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function DetailSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Users
  children: ReactNode
}) {
  return (
    <section className="admin-affiliate-detail-section">
      <h3>
        <Icon size={17} aria-hidden="true" /> {title}
      </h3>
      {children}
    </section>
  )
}

function AffiliateDetails({
  affiliate,
  role,
  onAction,
}: {
  affiliate: AdminAffiliateDirectoryRecord
  role: AdminContext['role']
  onAction: (action: AffiliateAction) => void
}) {
  const website = safeExternalUrl(affiliate.websiteUrl)
  const terms = safeExternalUrl(affiliate.termsUrl)
  const privacy = safeExternalUrl(affiliate.privacyUrl)
  const canChangeStatus = role === 'owner' || role === 'operations'
  const canTerminate = role === 'owner' && affiliate.status !== 'terminated'
  const terminationBlocked =
    affiliate.blockingAgreementCount > 0 ||
    affiliate.blockingDocumentCount > 0 ||
    affiliate.unsettledPayoutCount > 0

  return (
    <div className="admin-affiliate-detail">
      <div className="admin-affiliate-detail-identity">
        <span className="admin-affiliate-avatar" aria-hidden="true">
          {affiliateInitial(affiliate.publicName)}
        </span>
        <div>
          <div className="admin-affiliate-detail-name">
            <h2>{affiliate.publicName}</h2>
            <AffiliateStatusBadge status={affiliate.status} />
          </div>
          <p>
            <code>{affiliate.slug}</code>
            {affiliate.legalName ? ` · ${affiliate.legalName}` : ''}
          </p>
        </div>
      </div>

      <div className="admin-affiliate-detail-grid">
        <DetailSection title="Primary contact" icon={UserRoundCheck}>
          <dl className="admin-affiliate-definition-list">
            <Definition label="Name">{affiliate.primaryFullName ?? 'Unavailable'}</Definition>
            <Definition label="Email">{affiliate.primaryEmail ?? 'Unavailable'}</Definition>
            <Definition label="Role">{affiliate.primaryUserRole ?? 'Unavailable'}</Definition>
            <Definition label="Members">
              {affiliate.activeMemberCount} active of {affiliate.memberCount}
            </Definition>
          </dl>
        </DetailSection>

        <DetailSection title="Account lifecycle" icon={ShieldCheck}>
          <dl className="admin-affiliate-definition-list">
            <Definition label="Registration">
              {registrationKindLabel(affiliate.registrationKind)}
            </Definition>
            <Definition label="Registered">
              {formatAdminTimestamp(affiliate.registeredAt)}
            </Definition>
            <Definition label="Email">
              {confirmationStatusLabel(affiliate.emailConfirmationStatus)}
            </Definition>
            <Definition label="Confirmed">
              {formatAdminTimestamp(affiliate.emailConfirmedAt)}
            </Definition>
            <Definition label="Workspace">
              {activationStatusLabel(affiliate.activationStatus)}
            </Definition>
            <Definition label="Activated">{formatAdminTimestamp(affiliate.activatedAt)}</Definition>
          </dl>
        </DetailSection>

        <DetailSection title="Legal acceptance" icon={FileCheck2}>
          {affiliate.legalAcceptedAt ? (
            <dl className="admin-affiliate-definition-list">
              <Definition label="Accepted">
                {formatAdminTimestamp(affiliate.legalAcceptedAt)}
              </Definition>
              <Definition label="Age confirmed">{affiliate.ageConfirmed ? 'Yes' : 'No'}</Definition>
              <Definition label="Terms">
                {terms ? (
                  <a href={terms} target="_blank" rel="noreferrer">
                    {affiliate.termsVersion ?? 'View terms'} <ExternalLink size={12} />
                  </a>
                ) : (
                  (affiliate.termsVersion ?? 'Unavailable')
                )}
              </Definition>
              <Definition label="Privacy">
                {privacy ? (
                  <a href={privacy} target="_blank" rel="noreferrer">
                    {affiliate.privacyVersion ?? 'View privacy'} <ExternalLink size={12} />
                  </a>
                ) : (
                  (affiliate.privacyVersion ?? 'Unavailable')
                )}
              </Definition>
            </dl>
          ) : (
            <p className="admin-affiliate-unavailable">Not recorded for this registration path.</p>
          )}
        </DetailSection>

        <DetailSection title="Commercial footprint" icon={Link2}>
          <dl className="admin-affiliate-definition-list">
            <Definition label="Related products">{affiliate.productCount}</Definition>
            <Definition label="Agreement versions">
              {affiliate.agreementCount} total · {affiliate.activeAgreementCount} active
            </Definition>
            <Definition label="Termination-blocking agreements">
              {affiliate.blockingAgreementCount}
            </Definition>
            <Definition label="Termination-blocking documents">
              {affiliate.blockingDocumentCount}
            </Definition>
            <Definition label="Links">
              {affiliate.linkCount} total · {affiliate.activeLinkCount} configured active
            </Definition>
            <Definition label="Unsettled payout obligations">
              {affiliate.unsettledPayoutCount}
            </Definition>
          </dl>
        </DetailSection>

        <DetailSection title="Profile" icon={BadgeCheck}>
          <dl className="admin-affiliate-definition-list">
            <Definition label="Entity">{affiliate.entityType ?? 'Not provided'}</Definition>
            <Definition label="Country">{affiliate.countryCode ?? 'Not provided'}</Definition>
            <Definition label="Timezone">{affiliate.reportingTimezone || 'Unavailable'}</Definition>
            <Definition label="Currency">{affiliate.preferredCurrency || 'Unavailable'}</Definition>
            <Definition label="Website">
              {website ? (
                <a href={website} target="_blank" rel="noreferrer">
                  Open website <ExternalLink size={12} />
                </a>
              ) : (
                (affiliate.websiteUrl ?? 'Not provided')
              )}
            </Definition>
          </dl>
        </DetailSection>
      </div>

      {(canChangeStatus || canTerminate) && (
        <div className="admin-affiliate-detail-actions">
          <div>
            <strong>Protected lifecycle actions</strong>
            <p>Every change requires a password-authenticated admin session and an audit reason.</p>
          </div>
          <div>
            {canChangeStatus && affiliate.status === 'active' && (
              <button
                className="admin-secondary-button"
                type="button"
                onClick={() => onAction('pause')}
              >
                <PauseCircle size={16} aria-hidden="true" /> Pause affiliate
              </button>
            )}
            {canChangeStatus && affiliate.status === 'paused' && (
              <button
                className="admin-secondary-button"
                type="button"
                onClick={() => onAction('reactivate')}
              >
                <CircleCheck size={16} aria-hidden="true" /> Reactivate affiliate
              </button>
            )}
            {canTerminate && (
              <button
                className="admin-secondary-button admin-danger-button"
                type="button"
                disabled={terminationBlocked}
                onClick={() => onAction('terminate')}
              >
                <Ban size={16} aria-hidden="true" /> Terminate affiliate access
              </button>
            )}
          </div>
          {canTerminate && terminationBlocked && (
            <p className="admin-affiliate-action-blocker">
              Resolve all active or awaiting-signature agreements, current legal documents, and
              unsettled payout obligations before termination.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ActionDialog({
  action,
  affiliate,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  action: AffiliateAction | null
  affiliate: AdminAffiliateDirectoryRecord | null
  pending: boolean
  error: string | null
  onClose: () => void
  onSubmit: (reason: string, confirmation: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [validationError, setValidationError] = useState('')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  if (!affiliate || !action) return null
  const selectedAffiliate = affiliate

  const isTermination = action === 'terminate'
  const title =
    action === 'pause'
      ? `Pause ${affiliate.publicName}?`
      : action === 'reactivate'
        ? `Reactivate ${affiliate.publicName}?`
        : `Terminate ${affiliate.publicName}?`
  const description = isTermination
    ? 'This permanently ends workspace access, pauses active links, and cannot be reversed.'
    : action === 'pause'
      ? 'Historical reporting remains available, but new tracked traffic will be blocked.'
      : 'Workspace eligibility is restored; platform and product tracking gates still apply.'

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalizedReason = reason.trim()
    if (normalizedReason.length < 10) {
      setValidationError('Enter an audit reason of at least 10 characters.')
      reasonRef.current?.focus()
      return
    }
    if (isTermination && confirmation.trim() !== selectedAffiliate.slug) {
      setValidationError(`Type ${selectedAffiliate.slug} exactly to confirm termination.`)
      confirmationRef.current?.focus()
      return
    }
    setValidationError('')
    await onSubmit(normalizedReason, confirmation.trim())
  }

  return (
    <Dialog
      open
      initialFocusRef={reasonRef}
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
      title={title}
      description={description}
    >
      <form className="admin-affiliate-action-form" onSubmit={(event) => void submit(event)}>
        {isTermination && (
          <div className="admin-affiliate-danger-note">
            <AlertTriangle size={18} aria-hidden="true" />
            <p>
              The affiliate and membership history will be preserved. Access termination is
              permanent.
            </p>
          </div>
        )}
        <label className="admin-field">
          <span>Audit reason</span>
          <textarea
            ref={reasonRef}
            aria-label="Audit reason"
            autoFocus
            value={reason}
            minLength={10}
            maxLength={500}
            required
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why this lifecycle change is required."
          />
          <small>{reason.trim().length}/500 · minimum 10 characters</small>
        </label>
        {isTermination && (
          <label className="admin-field">
            <span>
              Type <code>{affiliate.slug}</code> to confirm
            </span>
            <input
              ref={confirmationRef}
              value={confirmation}
              required
              autoComplete="off"
              disabled={pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        )}
        {(validationError || error) && (
          <p className="admin-affiliate-dialog-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" /> {validationError || error}
          </p>
        )}
        <div className="admin-affiliate-dialog-actions">
          <button
            className="admin-secondary-button"
            type="button"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className={`admin-primary-button ${isTermination ? 'admin-danger-solid-button' : ''}`}
            type="submit"
            disabled={pending}
          >
            {pending && <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />}
            {pending
              ? 'Saving…'
              : action === 'pause'
                ? 'Pause affiliate'
                : action === 'reactivate'
                  ? 'Reactivate affiliate'
                  : 'Terminate access'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export type AffiliatesPageProps = Readonly<{
  context: AdminContext
  gateway?: AdminGateway
  affiliateId?: string | null
  onOpenAffiliate: (affiliateId: string) => void
  onCloseAffiliate: () => void
}>

export function AffiliatesPage({
  context,
  gateway,
  affiliateId = null,
  onOpenAffiliate,
  onCloseAffiliate,
}: AffiliatesPageProps) {
  const {
    input,
    summary,
    directory,
    detail,
    mutation,
    applyFilters,
    goToOffset,
    refresh,
    setAffiliateStatus,
    terminateAffiliate,
    clearMutation,
  } = useAffiliateDirectory({ enabled: true, gateway, selectedAffiliateId: affiliateId })
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<AdminAffiliateStatus | ''>('')
  const [confirmationStatus, setConfirmationStatus] = useState<
    AdminAffiliateEmailConfirmationStatus | ''
  >('')
  const [sort, setSort] = useState<AdminAffiliateDirectorySort>('newest')
  const [action, setAction] = useState<AffiliateAction | null>(null)
  const [success, setSuccess] = useState('')
  const page = directory.data
  const records = page?.items ?? []
  const offset = input.offset ?? 0
  const limit = input.limit ?? 25
  const total = page?.totalCount ?? 0
  const hasFilters = Boolean(input.query || input.status || input.confirmationStatus)
  const selectedDetail = detail.data?.id === affiliateId ? detail.data : null
  const firstItem = total ? offset + 1 : 0
  const lastItem = Math.min(offset + records.length, total)
  const detailsDescription = selectedDetail
    ? `Protected lifecycle and registration evidence for ${selectedDetail.publicName}.`
    : 'Loading protected affiliate details.'
  const summaryData = summary.data
  const directoryUnavailable = ['unconfigured', 'unauthorized', 'error'].includes(directory.status)

  function submitFilters(event: FormEvent) {
    event.preventDefault()
    const filters: Omit<AdminAffiliateDirectoryInput, 'limit' | 'offset'> = {
      query: search.trim() || null,
      status: status || null,
      confirmationStatus: confirmationStatus || null,
      activationStatus: null,
      sort,
    }
    applyFilters(filters)
  }

  function clearFilters() {
    setSearch('')
    setStatus('')
    setConfirmationStatus('')
    setSort('newest')
    applyFilters({
      query: null,
      status: null,
      confirmationStatus: null,
      activationStatus: null,
      sort: 'newest',
    })
  }

  async function submitAction(reason: string, confirmation: string) {
    if (!selectedDetail || !action) return
    const completed =
      action === 'terminate'
        ? await terminateAffiliate({
            affiliateId: selectedDetail.id,
            reason,
            confirmation,
          })
        : await setAffiliateStatus({
            affiliateId: selectedDetail.id,
            status: action === 'pause' ? 'paused' : 'active',
            reason,
          })
    if (!completed) return
    setSuccess(
      action === 'pause'
        ? `${selectedDetail.publicName} is now paused.`
        : action === 'reactivate'
          ? `${selectedDetail.publicName} is active again.`
          : `${selectedDetail.publicName} access has been terminated.`,
    )
    setAction(null)
    onCloseAffiliate()
  }

  const summaryCards = useMemo(
    () => [
      {
        label: 'All affiliates',
        value: summaryData?.totalCount ?? null,
        detail: 'Every registered workspace',
        tone: 'pink' as const,
      },
      {
        label: 'Active',
        value: summaryData?.activeCount ?? null,
        detail: 'Active partner workspaces',
        tone: 'green' as const,
      },
      {
        label: 'Awaiting confirmation',
        value: summaryData?.pendingConfirmationCount ?? null,
        detail: 'Email confirmation pending',
        tone: 'yellow' as const,
      },
      {
        label: 'Paused',
        value: summaryData?.pausedCount ?? null,
        detail: 'Historical access retained',
        tone: 'muted' as const,
      },
      {
        label: 'Terminated',
        value: summaryData?.terminatedCount ?? null,
        detail: 'Access permanently ended',
        tone: 'red' as const,
      },
    ],
    [summaryData],
  )

  return (
    <section className="admin-page admin-affiliates-page" aria-labelledby="admin-affiliates-title">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">PARTNER OPERATIONS</p>
          <h1 id="admin-affiliates-title">Affiliate directory</h1>
          <p>
            Review partner registration, account activation, legal evidence, and commercial
            footprint from one protected workspace.
          </p>
        </div>
        <span className="admin-heading-chip">
          <ShieldCheck size={15} aria-hidden="true" /> {context.role} access
        </span>
      </header>

      {success && (
        <div className="admin-config-feedback admin-config-feedback-success" role="status">
          <CircleCheck size={17} aria-hidden="true" />
          <span>{success}</span>
          <button type="button" onClick={() => setSuccess('')}>
            Dismiss
          </button>
        </div>
      )}

      <div className="admin-affiliate-summary-grid" aria-label="Affiliate lifecycle summary">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </div>

      <article className="admin-panel admin-affiliate-directory-card">
        <div className="admin-affiliate-directory-heading">
          <div>
            <p className="admin-eyebrow">DIRECTORY</p>
            <h2>Registered affiliates</h2>
            <p>Search by public name, email, or affiliate slug.</p>
          </div>
          <button
            className="admin-text-button"
            type="button"
            disabled={directory.status === 'loading'}
            onClick={refresh}
          >
            <RefreshCw size={15} aria-hidden="true" /> Refresh
          </button>
        </div>

        <form className="admin-affiliate-filters" role="search" onSubmit={submitFilters}>
          <label className="admin-affiliate-search">
            <span className="sr-only">Search affiliates</span>
            <Search size={17} aria-hidden="true" />
            <input
              value={search}
              maxLength={120}
              placeholder="Search name, email, or slug"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Affiliate status</span>
            <Select
              options={[
                { value: '', label: 'All statuses' },
                ...statuses.map((option) => ({
                  value: option,
                  label: affiliateStatusLabel(option),
                })),
              ]}
              value={status}
              onChange={(next) => setStatus(next as AdminAffiliateStatus | '')}
            />
          </label>
          <label>
            <span className="sr-only">Email confirmation status</span>
            <Select
              options={[
                { value: '', label: 'All confirmation states' },
                ...confirmationStatuses.map((option) => ({
                  value: option,
                  label: confirmationStatusLabel(option),
                })),
              ]}
              value={confirmationStatus}
              onChange={(next) =>
                setConfirmationStatus(next as AdminAffiliateEmailConfirmationStatus | '')
              }
            />
          </label>
          <label>
            <span className="sr-only">Directory sort order</span>
            <Select
              options={sorts.map((option) => ({ value: option.value, label: option.label }))}
              value={sort}
              onChange={(next) => setSort(next as AdminAffiliateDirectorySort)}
            />
          </label>
          <button className="admin-primary-button" type="submit">
            Apply filters
          </button>
          {hasFilters && (
            <button className="admin-text-button" type="button" onClick={clearFilters}>
              Clear
            </button>
          )}
        </form>

        {directory.status === 'loading' && !page ? (
          <div className="admin-affiliate-directory-state" role="status">
            <LoaderCircle className="admin-spin" size={28} aria-hidden="true" />
            <h3>Loading affiliate directory</h3>
            <p>Reading protected account and lifecycle data.</p>
          </div>
        ) : directoryUnavailable ? (
          <div className="admin-affiliate-directory-state">
            <CircleAlert size={28} aria-hidden="true" />
            <h3>
              {directory.status === 'unauthorized'
                ? 'Affiliate access required'
                : directory.status === 'unconfigured'
                  ? 'Affiliate management is not configured'
                  : 'Affiliate directory is unavailable'}
            </h3>
            <p>
              {directory.error?.message ?? 'The protected directory could not be loaded safely.'}
            </p>
            {directory.error?.retryable && (
              <button className="admin-secondary-button" type="button" onClick={refresh}>
                <RefreshCw size={16} aria-hidden="true" /> Retry
              </button>
            )}
          </div>
        ) : records.length === 0 ? (
          <div className="admin-affiliate-directory-state">
            <Users size={28} aria-hidden="true" />
            <h3>{hasFilters ? 'No affiliates match these filters' : 'No affiliates yet'}</h3>
            <p>
              {hasFilters
                ? 'Clear or adjust the directory filters to broaden the results.'
                : 'Confirmed and pending partner workspaces will appear here after registration.'}
            </p>
            {hasFilters && (
              <button className="admin-secondary-button" type="button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-affiliate-table">
                <caption className="sr-only">Registered affiliate directory</caption>
                <thead>
                  <tr>
                    <th scope="col">Affiliate</th>
                    <th scope="col">Status</th>
                    <th scope="col">Registered</th>
                    <th scope="col">Email confirmation</th>
                    <th scope="col">Related products</th>
                    <th scope="col">Links</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((affiliate) => (
                    <tr key={affiliate.id}>
                      <th scope="row">
                        <span className="admin-affiliate-name-cell">
                          <span className="admin-affiliate-avatar" aria-hidden="true">
                            {affiliateInitial(affiliate.publicName)}
                          </span>
                          <span>
                            <strong>{affiliate.publicName}</strong>
                            <small>{affiliate.primaryEmail ?? affiliate.slug}</small>
                          </span>
                        </span>
                      </th>
                      <td data-label="Status">
                        <AffiliateStatusBadge status={affiliate.status} />
                      </td>
                      <td data-label="Registered">
                        {formatAdminTimestamp(affiliate.registeredAt)}
                      </td>
                      <td data-label="Email confirmation">
                        <span
                          className={`admin-affiliate-confirmation admin-affiliate-confirmation-${affiliate.emailConfirmationStatus}`}
                        >
                          <Mail size={13} aria-hidden="true" />
                          {confirmationStatusLabel(affiliate.emailConfirmationStatus)}
                        </span>
                      </td>
                      <td data-label="Related products">{affiliate.productCount}</td>
                      <td data-label="Links">{affiliate.linkCount}</td>
                      <td data-label="Actions">
                        <button
                          className="admin-table-action"
                          type="button"
                          onClick={() => onOpenAffiliate(affiliate.id)}
                        >
                          View {affiliate.publicName}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-affiliate-pagination">
              <span>
                Showing {firstItem}–{lastItem} of {total}
              </span>
              <div>
                <button
                  className="admin-text-button"
                  type="button"
                  disabled={offset === 0 || directory.status === 'loading'}
                  onClick={() => goToOffset(offset - limit)}
                >
                  <ArrowLeft size={15} aria-hidden="true" /> Previous
                </button>
                <button
                  className="admin-text-button"
                  type="button"
                  disabled={offset + records.length >= total || directory.status === 'loading'}
                  onClick={() => goToOffset(offset + limit)}
                >
                  Next <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        )}
      </article>

      <Dialog
        open={Boolean(affiliateId)}
        onOpenChange={(open) => {
          if (!open && !action) onCloseAffiliate()
        }}
        title="Affiliate details"
        description={detailsDescription}
        wide
      >
        {detail.status === 'loading' && !selectedDetail ? (
          <div className="admin-affiliate-detail-state" role="status">
            <LoaderCircle className="admin-spin" size={26} aria-hidden="true" />
            Loading protected details…
          </div>
        ) : selectedDetail ? (
          <AffiliateDetails
            affiliate={selectedDetail}
            role={context.role}
            onAction={(nextAction) => {
              clearMutation()
              setAction(nextAction)
            }}
          />
        ) : (
          <div className="admin-affiliate-detail-state">
            <CircleAlert size={26} aria-hidden="true" />
            <p>{detail.error?.message ?? 'Affiliate details could not be loaded.'}</p>
            {detail.error?.retryable && (
              <button className="admin-secondary-button" type="button" onClick={refresh}>
                Retry
              </button>
            )}
          </div>
        )}
      </Dialog>

      <ActionDialog
        key={`${action ?? 'none'}-${selectedDetail?.id ?? 'none'}`}
        action={action}
        affiliate={selectedDetail}
        pending={mutation.status === 'pending'}
        error={mutation.error?.message ?? null}
        onClose={() => {
          if (mutation.status === 'pending') return
          clearMutation()
          setAction(null)
        }}
        onSubmit={submitAction}
      />
    </section>
  )
}
