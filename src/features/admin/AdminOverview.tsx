import { ArrowRight, Boxes, CircleCheck, Clock3, PackagePlus } from 'lucide-react'
import type { AdminProduct } from './api'

export function AdminOverview({
  products,
  onOpenProducts,
}: {
  products: readonly AdminProduct[]
  onOpenProducts: () => void
}) {
  const draft = products.filter((product) => product.status === 'draft').length
  const active = products.filter((product) => product.status === 'active').length

  return (
    <section className="admin-page" aria-labelledby="admin-overview-title">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">ACTION CENTER</p>
          <h1 id="admin-overview-title">Overview</h1>
          <p>Create the product foundation now. Funnels and attribution can be connected later.</p>
        </div>
        <button className="admin-primary-button" type="button" onClick={onOpenProducts}>
          <PackagePlus size={18} aria-hidden="true" />
          Add product
        </button>
      </header>

      <div className="admin-metric-grid" aria-label="Product summary">
        <article className="admin-metric-card">
          <span className="admin-metric-icon admin-metric-icon-pink">
            <Boxes size={21} aria-hidden="true" />
          </span>
          <span>Total products</span>
          <strong>{products.length}</strong>
          <small>All product records</small>
        </article>
        <article className="admin-metric-card">
          <span className="admin-metric-icon admin-metric-icon-yellow">
            <Clock3 size={21} aria-hidden="true" />
          </span>
          <span>Draft products</span>
          <strong>{draft}</strong>
          <small>Safe to configure before launch</small>
        </article>
        <article className="admin-metric-card">
          <span className="admin-metric-icon admin-metric-icon-green">
            <CircleCheck size={21} aria-hidden="true" />
          </span>
          <span>Active products</span>
          <strong>{active}</strong>
          <small>Activation remains server-controlled</small>
        </article>
      </div>

      <div className="admin-overview-grid">
        <article className="admin-panel admin-start-panel">
          <p className="admin-eyebrow">START HERE</p>
          <h2>
            {products.length ? 'Your product catalog is underway' : 'Create the first product'}
          </h2>
          <p>
            A product only needs a name and URL-safe slug at this stage. It will be saved as a
            draft, without inventing a funnel, link, commission, or live destination.
          </p>
          <button className="admin-secondary-button" type="button" onClick={onOpenProducts}>
            {products.length ? 'Manage products' : 'Create draft product'}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </article>

        <article className="admin-panel admin-later-panel">
          <span className="admin-spark" aria-hidden="true">
            ✦
          </span>
          <p className="admin-eyebrow">LATER, WHEN READY</p>
          <h2>Connect the launch journey</h2>
          <ol className="admin-step-list">
            <li>
              <span>1</span>
              <div>
                <strong>Add a funnel</strong>
                <p>Give the draft product a verified destination.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Configure partner terms</strong>
                <p>Version commercial rules before issuing links.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Validate attribution</strong>
                <p>Prove the complete event journey before activation.</p>
              </div>
            </li>
          </ol>
        </article>
      </div>
    </section>
  )
}
