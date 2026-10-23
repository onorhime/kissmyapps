import { useRef, useState, type FormEvent } from 'react'
import './ProductStats.css'
import { ActionNotice } from '../../../components/ActionNotice'
import { markFormSaved } from '../../../components/useFormNavigationGuard'
import {
  Box,
  ChartNoAxesColumn,
  LoaderCircle,
  PackagePlus,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import type { AdminContext, AdminDataResult, AdminProduct, AdminProductCreate } from '../api'
import {
  normalizeProductDraft,
  slugifyProductName,
  validateProductDraft,
  type ProductDraftErrors,
  type ProductDraftField,
} from './productValidation'

function formattedDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export type ProductsPageProps = Readonly<{
  context: AdminContext
  products: readonly AdminProduct[]
  onCreate: (input: AdminProductCreate) => Promise<AdminDataResult<AdminProduct | null>>
  onConfigure?: (productId: string) => void
  onViewStats?: (productId: string) => void
}>

export function ProductsPage({
  context,
  products,
  onCreate,
  onConfigure,
  onViewStats,
}: ProductsPageProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [errors, setErrors] = useState<ProductDraftErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)
  const [feedback, setFeedback] = useState<{
    kind: 'success' | 'error'
    message: string
  } | null>(null)
  const fields = useRef<Partial<Record<ProductDraftField, HTMLInputElement | null>>>({})
  const canCreate = context.role === 'owner' || context.role === 'operations'

  function updateName(value: string) {
    setName(value)
    if (!slugEdited) setSlug(slugifyProductName(value))
    if (errors.name) setErrors((current) => ({ ...current, name: undefined }))
    setFeedback(null)
  }

  function updateSlug(value: string) {
    setSlugEdited(true)
    setSlug(value)
    if (errors.slug) setErrors((current) => ({ ...current, slug: undefined }))
    setFeedback(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canCreate || submitLock.current) return
    const submittedForm = event.currentTarget

    const nextErrors = validateProductDraft(name, slug)
    const firstError = (['name', 'slug'] as const).find((field) => nextErrors[field])
    if (firstError) {
      setErrors(nextErrors)
      queueMicrotask(() => fields.current[firstError]?.focus())
      return
    }

    submitLock.current = true
    setSubmitting(true)
    setErrors({})
    setFeedback(null)
    const draft = normalizeProductDraft(name, slug)
    let creation: AdminDataResult<AdminProduct | null>
    try {
      creation = await onCreate(draft)
    } catch {
      creation = {
        data: null,
        status: 'error',
        error: {
          code: 'temporarily_unavailable',
          message: 'Admin data is temporarily unavailable.',
          retryable: true,
        },
      }
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }

    if (creation.status === 'ready' && creation.data) {
      setName('')
      setSlug('')
      setSlugEdited(false)
      markFormSaved(submittedForm)
      setFeedback({
        kind: 'success',
        message: `${creation.data.name} was created as a draft product.`,
      })
      return
    }
    setFeedback({
      kind: 'error',
      message: creation.error?.message ?? 'The draft product could not be created.',
    })
  }

  return (
    <section className="admin-page" aria-labelledby="admin-products-title">
      <header className="admin-page-heading">
        <div>
          <p className="admin-eyebrow">PRODUCT CATALOG</p>
          <h1 id="admin-products-title">Products</h1>
          <p>
            Create the product record first. Funnel configuration remains a separate later step.
          </p>
        </div>
        <span className="admin-heading-chip">
          <ShieldCheck size={16} aria-hidden="true" /> RPC protected
        </span>
      </header>

      <div className="admin-products-layout">
        <article className="admin-panel admin-product-form-card">
          <div className="admin-panel-heading">
            <span className="admin-panel-icon">
              <PackagePlus size={20} aria-hidden="true" />
            </span>
            <div>
              <h2>Add a product</h2>
              <p>Every new product starts safely in Draft.</p>
            </div>
          </div>

          {!canCreate && (
            <div className="admin-inline-notice" role="note">
              <ShieldCheck size={18} aria-hidden="true" />
              <p>Only Owner and Operations administrators can create products.</p>
            </div>
          )}

          <form className="admin-product-form" onSubmit={submit} noValidate aria-busy={submitting}>
            <fieldset disabled={!canCreate || submitting}>
              <div className="admin-field">
                <label htmlFor="admin-product-name">Product name</label>
                <input
                  id="admin-product-name"
                  name="name"
                  ref={(element) => {
                    fields.current.name = element
                  }}
                  value={name}
                  onChange={(event) => updateName(event.target.value)}
                  maxLength={121}
                  placeholder="e.g. Daily Planner"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? 'admin-product-name-error' : undefined}
                />
                {errors.name && (
                  <p className="admin-field-error" id="admin-product-name-error">
                    {errors.name}
                  </p>
                )}
              </div>

              <div className="admin-field">
                <label htmlFor="admin-product-slug">Product slug</label>
                <div className="admin-slug-field">
                  <span aria-hidden="true">/</span>
                  <input
                    id="admin-product-slug"
                    name="slug"
                    ref={(element) => {
                      fields.current.slug = element
                    }}
                    value={slug}
                    onChange={(event) => updateSlug(event.target.value)}
                    maxLength={121}
                    placeholder="daily-planner"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors.slug)}
                    aria-describedby={
                      errors.slug ? 'admin-product-slug-error' : 'admin-product-slug-hint'
                    }
                  />
                </div>
                {errors.slug ? (
                  <p className="admin-field-error" id="admin-product-slug-error">
                    {errors.slug}
                  </p>
                ) : (
                  <p className="admin-field-hint" id="admin-product-slug-hint">
                    Used as a stable internal identifier. It can be configured before any funnel.
                  </p>
                )}
              </div>

              <div className="admin-draft-lock">
                <span>Status</span>
                <strong>Draft</strong>
                <small>Activation is not available from this form.</small>
              </div>

              <button className="admin-primary-button admin-create-button" type="submit">
                {submitting ? (
                  <LoaderCircle className="admin-spin" size={18} aria-hidden="true" />
                ) : (
                  <PackagePlus size={18} aria-hidden="true" />
                )}
                {submitting ? 'Creating draft…' : 'Create draft product'}
              </button>
            </fieldset>
          </form>

          <ActionNotice notice={feedback} onDismiss={() => setFeedback(null)} />
        </article>

        <article className="admin-panel admin-products-card">
          <div className="admin-panel-heading admin-list-heading">
            <div>
              <h2>Product catalog</h2>
              <p>{products.length ? `${products.length} product records` : 'No products yet'}</p>
            </div>
            <span className="admin-count-badge">{products.length}</span>
          </div>

          {products.length ? (
            <div
              className="admin-table-scroll"
              role="region"
              aria-label="Product catalog table"
              tabIndex={0}
            >
              <table className="admin-products-table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Slug</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">Updated</th>
                    {(onConfigure || onViewStats) && <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <th scope="row">
                        <span className="admin-product-name-cell">
                          <span className="admin-product-symbol">
                            <Box size={16} aria-hidden="true" />
                          </span>
                          {product.name}
                        </span>
                      </th>
                      <td>
                        <code>{product.slug}</code>
                      </td>
                      <td>
                        <span className={`admin-status-badge admin-status-${product.status}`}>
                          {product.status}
                        </span>
                      </td>
                      <td>{formattedDate(product.createdAt)}</td>
                      <td>{formattedDate(product.updatedAt)}</td>
                      {(onConfigure || onViewStats) && (
                        <td>
                          <span className="admin-table-actions">
                            {onConfigure && (
                              <button
                                className="admin-table-action"
                                type="button"
                                aria-label={`${canCreate ? 'Set up' : 'View setup for'} ${product.name}`}
                                onClick={() => onConfigure(product.id)}
                              >
                                <Settings2 size={15} aria-hidden="true" />
                                {canCreate ? 'Setup' : 'View setup'}
                              </button>
                            )}
                            {onViewStats && (
                              <button
                                className="admin-table-action"
                                type="button"
                                aria-label={`View stats for ${product.name}`}
                                onClick={() => onViewStats(product.id)}
                              >
                                <ChartNoAxesColumn size={15} aria-hidden="true" />
                                Stats
                              </button>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="admin-empty-catalog">
              <span>
                <Box size={27} aria-hidden="true" />
              </span>
              <h3>No products have been created</h3>
              <p>Use the form to create the first draft. A funnel is not required.</p>
            </div>
          )}
        </article>
      </div>
    </section>
  )
}
