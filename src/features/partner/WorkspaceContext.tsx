import { ChevronDown, Layers3 } from 'lucide-react'
import type { PreviewState } from './data'

export function WorkspaceContext({
  state,
  publicName,
  product,
  onProductChange,
}: {
  state: PreviewState
  publicName: string
  product: string
  onProductChange: (product: string) => void
}) {
  const empty = state === 'empty'
  return (
    <section className="workspace-context" aria-label="Product and partnership context">
      <label className="workspace-product">
        <Layers3 size={18} aria-hidden="true" />
        <span>
          <span className="context-label">PRODUCT</span>
          <select
            aria-label="Product"
            value={empty ? '' : product}
            disabled={empty}
            onChange={(event) => onProductChange(event.target.value)}
            aria-describedby="product-context-note"
          >
            {empty ? (
              <option value="">No active products</option>
            ) : (
              <option value="sample-product">Example product (sample)</option>
            )}
          </select>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </label>
      <div className="context-partner">
        <span className="context-label">PARTNER</span>
        <strong>{publicName || 'Your partner workspace'}</strong>
        <span>{empty ? 'Partner type not configured' : 'Content partner · Example profile'}</span>
      </div>
      <div className="context-terms">
        <span className="context-label">COMMERCIAL MODEL</span>
        <strong>{empty ? 'No agreement configured' : '30% Revenue share · USD'}</strong>
        <span id="product-context-note">
          {empty
            ? 'Your first product will appear here when it is ready.'
            : 'Example terms only · Not a live agreement'}
        </span>
      </div>
    </section>
  )
}
