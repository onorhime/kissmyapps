import { PartnerRuleTerms } from './PartnerRuleTerms'
import { providerMoney } from '../../../lib/providerMoney'
import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Clock3,
  FileText,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import { Select } from '../../../components/Select'
import type { PartnerDataGateway, PartnerDocument, PartnerDocumentStatus } from '../api'
import type { PartnerLiveWorkspaceValue } from './types'
import './LiveDocumentsPage.css'

const statusLabels: Record<PartnerDocumentStatus, string> = {
  draft: 'Draft',
  awaiting_partner_signature: 'Awaiting your signature',
  awaiting_kissmyapps_signature: 'Awaiting KissMyApps signature',
  signed: 'Signed by both parties',
  active: 'Active',
  superseded: 'Superseded',
  expired: 'Expired',
  terminated: 'Terminated',
}

function timezoneOrUtc(value: string | undefined) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value || 'UTC' }).format()
    return value || 'UTC'
  } catch {
    return 'UTC'
  }
}

function timestamp(value: string | null, timezone: string, fallback = 'Not set') {
  if (!value) return fallback
  if (!Number.isFinite(Date.parse(value))) return 'Date unavailable'
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value))
}

function hasSignature(value: string | null) {
  return Boolean(value && Number.isFinite(Date.parse(value)))
}

function documentStatus(document: PartnerDocument) {
  if (
    document.status === 'signed' &&
    (!hasSignature(document.partnerSignedAt) || !hasSignature(document.companySignedAt))
  ) {
    return 'Signed · signature details incomplete'
  }
  return statusLabels[document.status]
}

function SignatureDates({ document, timezone }: { document: PartnerDocument; timezone: string }) {
  return (
    <div className="live-document-signatures" role="group" aria-label="Recorded signatures">
      {(
        [
          ['Partner', document.partnerSignedAt],
          ['KissMyApps', document.companySignedAt],
        ] as const
      ).map(([party, at]) => (
        <div key={party}>
          {hasSignature(at) ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Clock3 size={18} aria-hidden="true" />
          )}
          <span>
            <strong>{party}</strong>
            <span>{timestamp(at, timezone, 'Signature not recorded')}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function DocumentReview({
  document,
  documents,
  gateway,
  timezone,
}: {
  document: PartnerDocument
  documents: readonly PartnerDocument[]
  gateway: PartnerDataGateway
  timezone: string
}) {
  const [pending, setPending] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const active = useRef(true)
  const inFlight = useRef(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      clearTimeout(timeout.current)
      clearTimeout(expiry.current)
    }
  }, [])

  async function prepareDownload() {
    if (
      !document.downloadAvailable ||
      document.status === 'draft' ||
      !gateway.getDocumentUrl ||
      inFlight.current
    )
      return
    inFlight.current = true
    setPending(true)
    setUrl(null)
    setMessage(null)
    clearTimeout(expiry.current)
    try {
      const result = await Promise.race([
        gateway.getDocumentUrl(document.id),
        new Promise<undefined>((resolve) => {
          timeout.current = setTimeout(() => resolve(undefined), 15_000)
        }),
      ])
      if (!active.current) return
      if (result?.status !== 'ready' || !result.data) {
        setMessage('The private PDF link could not be prepared. Try again or refresh documents.')
        return
      }
      const candidate = new URL(result.data)
      if (candidate.protocol !== 'https:' || candidate.username || candidate.password)
        throw new Error('Unsafe document URL')
      setUrl(candidate.href)
      expiry.current = setTimeout(() => {
        if (!active.current) return
        setUrl(null)
        setMessage('This private link expired. Prepare a new link to open the PDF.')
      }, 240_000)
    } catch {
      if (active.current)
        setMessage('The private PDF link could not be prepared. Try again or refresh documents.')
    } finally {
      clearTimeout(timeout.current)
      inFlight.current = false
      if (active.current) setPending(false)
    }
  }

  const versionName = (id: string | null) => {
    if (!id) return 'None linked'
    const related = documents.find((item) => item.id === id)
    return related
      ? `${related.name} · Version ${related.version}`
      : 'Linked version is not available'
  }

  return (
    <div className="live-document-review">
      <span className="live-document-status">{documentStatus(document)}</span>
      <dl className="live-document-facts">
        {[
          ['Version', `Version ${document.version}`],
          ['Document type', document.type.replaceAll('_', ' ')],
          ['Created', timestamp(document.createdAt, timezone)],
          ['Effective', timestamp(document.effectiveAt, timezone)],
          ['Expires', timestamp(document.expiresAt, timezone, 'No expiry recorded')],
          ['Terminated', timestamp(document.terminatedAt, timezone, 'Not terminated')],
          ['Replaces', versionName(document.supersedesDocumentId)],
          ['Replaced by', versionName(document.supersededByDocumentId)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h3>Two-party signature record</h3>
      <SignatureDates document={document} timezone={timezone} />
      <p className="live-document-note">
        Times shown in {timezone}. Signing and agreement activation are separate steps. The PDF
        contains the uploaded terms; the recorded signature dates are shown here.
      </p>
      <div className="live-document-download">
        <LockKeyhole size={20} aria-hidden="true" />
        <div>
          <h3>Private agreement PDF</h3>
          <p>
            Access is checked against your partner account. Open the PDF in a new tab to read or
            save a copy.
          </p>
          {!document.downloadAvailable || document.status === 'draft' ? (
            <p role="status">
              No downloadable file is available for this document. Contact KissMyApps if you
              expected a PDF.
            </p>
          ) : !gateway.getDocumentUrl ? (
            <p role="status">Private downloads are not available in this deployment yet.</p>
          ) : url ? (
            <>
              <a
                className="button live-document-primary"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open PDF <ArrowUpRight size={16} aria-hidden="true" />
              </a>
              <p role="status">Your private link is ready and expires shortly.</p>
            </>
          ) : (
            <button
              className="button live-document-primary"
              type="button"
              onClick={() => void prepareDownload()}
              disabled={pending}
            >
              {pending ? 'Preparing private link…' : 'Prepare PDF link'}
            </button>
          )}
          {message && (
            <p className="live-document-error" role="alert">
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function LiveDocumentsPage({ workspace }: { workspace: PartnerLiveWorkspaceValue }) {
  const { snapshot, actions, isRefreshing, gateway } = workspace
  const resource = snapshot.resources.documents
  const profile =
    snapshot.resources.profile.status === 'ready' ? snapshot.resources.profile.data : null
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const known = resource.status === 'ready' || resource.status === 'empty'
  const documents = known ? resource.data : []
  const visible = documents.filter((item) => filter === 'all' || item.status === filter)
  const selected = documents.find((item) => item.id === selectedId)
  const timezone = timezoneOrUtc(profile?.timezone)
  const products =
    snapshot.resources.products.status === 'ready' ? snapshot.resources.products.data : []

  return (
    <div className="live-documents-page">
      {profile && (
        <section className="panel live-document-profile" aria-label="Partner account details">
          <div>
            <span className="eyebrow">YOUR PARTNER ACCOUNT</span>
            <h2>{profile.publicName}</h2>
            <p>{profile.email}</p>
          </div>
          <div>
            <span>Legal name</span>
            <strong>{profile.legalName || 'Not provided'}</strong>
            <p>
              {profile.role} · {profile.status}
            </p>
          </div>
        </section>
      )}
      {snapshot.resources.agreements.status === 'ready' &&
        snapshot.resources.agreements.data.length > 0 && (
          <section className="panel live-documents-panel" aria-label="Commercial agreements">
            <h2>Commercial agreements</h2>
            <p>
              Read-only product terms. Signed document versions and historical settlement snapshots
              remain unchanged.
            </p>
            {snapshot.resources.agreements.data.map((agreement) => (
              <details
                key={`${agreement.productId}:${agreement.version}`}
                className="settlement-card"
              >
                <summary>
                  {agreement.productName} · agreement v{agreement.version} · {agreement.status}
                </summary>
                <p>
                  Attribution: {agreement.attributionWindowDays} days · Payout every{' '}
                  {agreement.payoutFrequencyDays} days · Minimum{' '}
                  {providerMoney(agreement.minimumPayoutMinor, agreement.payoutCurrency)}
                </p>
                {agreement.rules.map((rule, index) => (
                  <PartnerRuleTerms
                    key={`${rule.name}:${index}`}
                    rule={rule}
                    currency={agreement.payoutCurrency}
                  />
                ))}
              </details>
            ))}
          </section>
        )}
      <section className="panel live-documents-panel" aria-labelledby="partnership-documents-title">
        <div className="live-document-heading">
          <div>
            <h2 id="partnership-documents-title">Partnership documents</h2>
            <p>
              All documents shared with your account, including products that have not launched.
            </p>
          </div>
          <button
            className="button live-document-secondary"
            type="button"
            onClick={actions.refresh}
            disabled={isRefreshing || resource.status === 'loading'}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {isRefreshing ? 'Refreshing documents…' : 'Refresh documents'}
          </button>
        </div>
        {resource.status === 'loading' ? (
          <p className="live-document-empty" role="status">
            Loading your documents…
          </p>
        ) : !known ? (
          <div className="live-document-empty" role="alert">
            <AlertCircle size={28} aria-hidden="true" />
            <h3>Documents are unavailable</h3>
            <p>
              {resource.error?.message ||
                'Your documents could not be loaded. Refresh to try again.'}
            </p>
          </div>
        ) : documents.length === 0 ? (
          <div className="live-document-empty" role="status">
            <FileText size={28} aria-hidden="true" />
            <h3>No documents shared yet</h3>
            <p>
              Your agreements will appear here when KissMyApps shares them. No traffic or payments
              are required.
            </p>
          </div>
        ) : (
          <>
            <div className="live-document-toolbar">
              <p>
                {documents.length} {documents.length === 1 ? 'document' : 'documents'} · All
                products
              </p>
              <Select
                label="Document status"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All statuses' },
                  ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
                ]}
              />
            </div>
            <div className="live-document-list">
              {visible.map((document) => (
                <article
                  key={document.id}
                  aria-label={`${document.name}, version ${document.version}`}
                  className="live-document-card"
                >
                  <div className="live-document-card-heading">
                    <FileText size={24} aria-hidden="true" />
                    <div>
                      <h3>{document.name}</h3>
                      <p>
                        Version {document.version} ·{' '}
                        {products.find((product) => product.id === document.productId)?.name ||
                          'Partner document'}
                      </p>
                    </div>
                    <span className="live-document-status">{documentStatus(document)}</span>
                  </div>
                  <SignatureDates document={document} timezone={timezone} />
                  <div className="live-document-card-footer">
                    <p>Created {timestamp(document.createdAt, timezone)}</p>
                    <button
                      className="button live-document-secondary"
                      type="button"
                      onClick={() => setSelectedId(document.id)}
                      aria-label={`View ${document.name}, version ${document.version}`}
                    >
                      View document <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
              {visible.length === 0 && (
                <div className="live-document-empty" role="status">
                  <h3>No documents match this status</h3>
                  <button
                    className="button live-document-secondary"
                    type="button"
                    onClick={() => setFilter('all')}
                  >
                    Clear document filter
                  </button>
                </div>
              )}
            </div>
            <p className="live-document-note">
              Times shown in {timezone}. Historical versions and recorded signatures remain
              available here.
            </p>
          </>
        )}
      </section>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        title={selected ? `${selected.name} · Version ${selected.version}` : 'Document details'}
        description="Review your document version, signature dates, and private PDF."
        wide
      >
        {selected && (
          <DocumentReview
            key={[
              selected.id,
              selected.version,
              selected.status,
              selected.downloadAvailable,
              selected.partnerSignedAt,
              selected.companySignedAt,
            ].join(':')}
            document={selected}
            documents={documents}
            gateway={gateway}
            timezone={timezone}
          />
        )}
      </Dialog>
    </div>
  )
}
