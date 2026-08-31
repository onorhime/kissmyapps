import { useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  FileCheck2,
  FileText,
  LockKeyhole,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/States'
import { downloadCsv } from './data'
import {
  documentDate,
  documentMatchesStatus,
  documentRecordCsv,
  documentStatuses,
  documentTypes,
  partnerDocuments,
} from './profileData'

export function PartnerDocuments({ empty }: { empty: boolean }) {
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const statusInput = useRef<HTMLSelectElement>(null)
  const documents = empty ? [] : partnerDocuments
  const visible = documents.filter(
    (document) =>
      documentMatchesStatus(document, status) && (type === 'all' || type === document.type),
  )
  const selected = documents.find((document) => document.id === selectedId)
  const statusClass = (value: string) =>
    ['Signed', 'Active'].includes(value)
      ? 'badge-green'
      : value.startsWith('Awaiting')
        ? 'badge-amber'
        : 'badge-neutral'
  return (
    <>
      <section className="panel partner-documents-panel">
        <div className="panel-heading">
          <div>
            <h2>Partnership documents</h2>
            <p>Agreement versions, two-party signatures, and lifecycle history.</p>
          </div>
          <button className="button button-white" disabled>
            <Upload size={15} />
            Upload document
          </button>
        </div>
        <div className="table-toolbar document-toolbar">
          <p className="toolbar-note">
            No files or signatures are collected. Uploading signed PDFs and signing require a
            connected account and private storage.
          </p>
          <label className="filter-select">
            <span className="sr-only">Document status</span>
            <select
              ref={statusInput}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">All statuses</option>
              {documentStatuses.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="filter-select">
            <span className="sr-only">Document type</span>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="all">All document types</option>
              {documentTypes.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        {!empty && (
          <p className="document-list-note">
            Illustrative lifecycle examples, not issued contracts. “Signed” includes completed
            signatures on active or historical versions; signing and activation are separate.
          </p>
        )}
        {visible.length ? (
          <div className="document-list">
            {visible.map((document) => (
              <article key={document.id}>
                <span className="document-icon">
                  <FileText size={22} />
                </span>
                <div className="document-name">
                  <h3>
                    {document.name} <span>{document.version}</span>
                  </h3>
                  <p>
                    {document.type} · Created {documentDate(document.created)}
                  </p>
                  <p>
                    Effective: {documentDate(document.effective)} · Expires:{' '}
                    {documentDate(document.expires)}
                  </p>
                  <p>
                    Partner: {document.partner.status} · KissMyApps: {document.company.status}
                  </p>
                </div>
                <span className={`status-badge ${statusClass(document.status)}`}>
                  {document.status} · sample
                </span>
                <button
                  className="table-action"
                  aria-label={`Preview ${document.name} ${document.version}`}
                  onClick={() => {
                    setNotice('')
                    setSelectedId(document.id)
                  }}
                >
                  Preview <ArrowRight size={13} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<FileCheck2 size={28} />}
            title={empty ? 'A fresh start. No paperwork yet.' : 'No documents match these filters'}
            description={
              empty
                ? 'Your agreement and partner documents will appear when your account is connected and your first partnership is set up.'
                : 'Choose another type or status to review the example lifecycle.'
            }
            action={
              !empty && (
                <button
                  className="button button-white"
                  onClick={() => {
                    setType('all')
                    setStatus('all')
                    statusInput.current?.focus()
                  }}
                >
                  Clear document filters
                </button>
              )
            }
          />
        )}
        <div className="panel-footnote">
          <span>
            <ShieldCheck size={14} />
            Real documents will use authorized, private downloads.
          </span>
          <span>{visible.length} sample records</span>
        </div>
      </section>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null)
            setNotice('')
          }
        }}
        title={selected ? `${selected.name} · ${selected.version}` : 'Document preview'}
        description="Illustrative document record. Not a contract, signature, or legal document."
        wide
      >
        {selected && (
          <>
            <div className="document-preview-sheet">
              <span className="eyebrow">SAMPLE DOCUMENT RECORD</span>
              <h3>{selected.name}</h3>
              <p>
                This preview demonstrates document metadata and versioning. No agreement has been
                issued or signed.
              </p>
              <dl className="document-facts">
                {[
                  ['Type', selected.type],
                  ['Version', selected.version],
                  ['Lifecycle status', `${selected.status} (sample)`],
                  ['Created', documentDate(selected.created)],
                  ['Effective date', documentDate(selected.effective)],
                  ['Expiration date', documentDate(selected.expires)],
                  ['Termination date', documentDate(selected.terminated, 'Not terminated')],
                  [
                    'Supersedes',
                    partnerDocuments.find((value) => value.id === selected.supersedes)?.version ??
                      'No earlier version linked',
                  ],
                  [
                    'Superseded by',
                    partnerDocuments.find((value) => value.id === selected.supersededBy)?.version ??
                      'No later version linked',
                  ],
                  ['Private file', 'No file uploaded · No storage path or signed URL issued'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <section className="document-signatures" aria-label="Signature metadata">
                <h3>Two-party signature record</h3>
                {[
                  ['Partner', selected.partner],
                  ['KissMyApps', selected.company],
                ].map(([label, value]) => {
                  const signature = value as typeof selected.partner
                  return (
                    <div key={String(label)}>
                      <strong>
                        {String(label)} · {signature.status}
                      </strong>
                      <span>
                        {documentDate(
                          signature.at,
                          signature.status === 'Awaiting signature'
                            ? 'Awaiting signature · No timestamp yet'
                            : 'Not signed · No timestamp',
                        )}
                      </span>
                    </div>
                  )
                })}
                <p>
                  Timestamps are fictional examples in UTC. An uploaded signed PDF does not itself
                  prove a verified signature or activate an agreement.
                </p>
              </section>
              <div className="document-watermark">PREVIEW ONLY</div>
            </div>
            <p className="inline-note">
              <LockKeyhole size={15} />
              Signing and signed-PDF downloads are unavailable. Real files require authenticated
              private access; storage paths are not exposed to partners.
            </p>
            <p className="detail-notice" role="status">
              {notice}
            </p>
            <div className="document-preview-actions">
              <button className="button button-white" disabled>
                Sign document
              </button>
              <button className="button button-white" disabled>
                Download signed PDF
              </button>
              <button
                className="button button-green"
                onClick={() => {
                  const csv = documentRecordCsv(selected)
                  downloadCsv(`SAMPLE-${selected.id}-record.csv`, csv.headers, csv.rows)
                  setNotice(
                    'Sample metadata CSV prepared. It is not a signed document or proof of agreement.',
                  )
                }}
              >
                <ArrowDownToLine size={15} />
                Download sample record
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  )
}
