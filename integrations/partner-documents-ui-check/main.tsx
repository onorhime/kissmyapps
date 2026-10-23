// Developer-only visual fixture, not an application entrypoint or public asset.
// Run with Supabase environment variables empty. No signature/download is real.
import { createRoot } from 'react-dom/client'
import { LiveDocumentsPage } from '../../src/features/partner/live/LiveDocumentsPage'
import { createLoadingPartnerLiveSnapshot, createPartnerLiveSnapshot } from '../../src/features/partner/live/loader'
import type { PartnerLiveWorkspaceValue } from '../../src/features/partner/live/types'
import type { PartnerDocument } from '../../src/features/partner/api/types'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/brand.css'

const document: PartnerDocument = {
  id: 'fixture-document', productId: 'fixture-product', name: 'BC Learn partnership agreement',
  type: 'partner_agreement', version: 1, status: 'signed', createdAt: '2026-09-05T08:00:00Z',
  effectiveAt: null, expiresAt: null, terminatedAt: null, partnerSignedAt: '2026-09-05T09:53:00Z',
  companySignedAt: '2026-09-05T10:28:00Z', supersedesDocumentId: null,
  supersededByDocumentId: null, downloadAvailable: true,
}
const base = createLoadingPartnerLiveSnapshot(null)
const resources = {
  ...base.resources,
  documents: { status: 'ready' as const, error: null, data: [document, { ...document, id: 'older-fixture', name: 'Earlier partnership terms', version: 1, status: 'superseded' as const, supersededByDocumentId: document.id }] },
}
const workspace = {
  snapshot: createPartnerLiveSnapshot(resources, null), selectedProductId: null, isRefreshing: false,
  mutation: { status: 'idle', operation: null, error: null },
  actions: { refresh: () => {} },
  gateway: { getDocumentUrl: async () => ({ status: 'ready', data: 'https://example.invalid/qa-only.pdf', error: null }) },
} as unknown as PartnerLiveWorkspaceValue

createRoot(window.document.getElementById('root')!).render(
  <main id="main-content" tabIndex={-1} style={{ maxWidth: 1220, margin: '0 auto', padding: '24px 16px' }}>
    <p>LOCAL UI CHECK · Synthetic records only · No live account or PDF</p>
    <div className="page-heading"><div><p className="eyebrow">YOUR PARTNER ACCOUNT</p><h1>Profile &amp; Documents<span className="heading-dot">.</span></h1><p>Your agreements and recorded signatures, before and after launch.</p></div></div>
    <LiveDocumentsPage workspace={workspace} />
  </main>,
)
