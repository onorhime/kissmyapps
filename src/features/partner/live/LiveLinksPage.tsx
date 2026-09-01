import { AlertCircle, Copy, Link2, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PartnerLinkCreate, PartnerLinkOption, PartnerProduct } from '../api'
import type { PartnerLiveResourceStatus, PartnerLiveWorkspaceValue } from './types'

type LinkDraft = Readonly<{
  name: string
  funnelId: string
  sourceId: string
  campaignId: string
  sub1: string
  sub2: string
  sub3: string
}>

type LinkDraftField = keyof LinkDraft
type LinkDraftErrors = Partial<Record<LinkDraftField | 'parent', string>>

const emptyDraft: LinkDraft = {
  name: '',
  funnelId: '',
  sourceId: '',
  campaignId: '',
  sub1: '',
  sub2: '',
  sub3: '',
}

const subIdPattern = /^[a-zA-Z0-9_-]{1,64}$/

function availableForProduct(option: PartnerLinkOption, productId: string) {
  return option.available && (option.productId === null || option.productId === productId)
}

function resourceIsKnown(status: PartnerLiveResourceStatus) {
  return status === 'ready' || status === 'empty'
}

function initialDraft(
  funnels: readonly PartnerLinkOption[],
  sources: readonly PartnerLinkOption[],
) {
  return {
    ...emptyDraft,
    funnelId: funnels[0]?.id ?? '',
    sourceId: sources[0]?.id ?? '',
  }
}

function validateDraft(
  draft: LinkDraft,
  product: PartnerProduct,
  funnels: readonly PartnerLinkOption[],
  sources: readonly PartnerLinkOption[],
  campaigns: readonly PartnerLinkOption[],
): LinkDraftErrors {
  const errors: LinkDraftErrors = {}
  const name = draft.name.trim()
  if (!name || name.length > 120) errors.name = 'Enter a link name of 1–120 characters.'
  if (!product.mainLinkId || !product.mainTrackingUrl) {
    errors.parent = 'The administrator must issue the current main link first.'
  }
  if (!funnels.some((option) => option.id === draft.funnelId)) {
    errors.funnelId = 'Choose an available live funnel.'
  }
  if (!sources.some((option) => option.id === draft.sourceId)) {
    errors.sourceId = 'Choose an available traffic source.'
  }
  if (draft.campaignId && !campaigns.some((option) => option.id === draft.campaignId)) {
    errors.campaignId = 'Choose an available campaign or leave it unassigned.'
  }
  for (const field of ['sub1', 'sub2', 'sub3'] as const) {
    const value = draft[field].trim()
    if ((field === 'sub1' || value) && !subIdPattern.test(value)) {
      errors[field] =
        field === 'sub1'
          ? 'Enter a Sub 1 value using 1–64 letters, numbers, hyphens, or underscores.'
          : 'Use 1–64 letters, numbers, hyphens, or underscores.'
    }
  }
  return errors
}

function dimensionSummary(
  source: string | null,
  campaign: string | null,
  sub1: string,
  sub2: string,
  sub3: string,
) {
  return [
    source ?? 'No source',
    campaign ?? 'No campaign',
    `Sub 1: ${sub1}`,
    sub2 ? `Sub 2: ${sub2}` : null,
    sub3 ? `Sub 3: ${sub3}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function LiveLinksPage({
  product,
  workspace,
}: {
  product: PartnerProduct
  workspace: PartnerLiveWorkspaceValue
}) {
  const { snapshot, actions, mutation, isRefreshing } = workspace
  const linkDirectoryResource = snapshot.resources.linkDirectory
  const linksResource = snapshot.resources.links
  const directory = linkDirectoryResource.data
  const links = linksResource.data
  const directoryKnown = resourceIsKnown(linkDirectoryResource.status)
  const linksKnown = resourceIsKnown(linksResource.status)
  const resourcesKnown = directoryKnown && linksKnown
  const resourceError = linksResource.error ?? linkDirectoryResource.error
  const funnels = useMemo(
    () => directory.funnels.filter((option) => availableForProduct(option, product.id)),
    [directory.funnels, product.id],
  )
  const sources = useMemo(
    () => directory.sources.filter((option) => availableForProduct(option, product.id)),
    [directory.sources, product.id],
  )
  const campaigns = useMemo(
    () => directory.campaigns.filter((option) => availableForProduct(option, product.id)),
    [directory.campaigns, product.id],
  )
  const [draft, setDraft] = useState<LinkDraft>(() => initialDraft(funnels, sources))
  const [errors, setErrors] = useState<LinkDraftErrors>({})
  const [showForm, setShowForm] = useState(false)
  const [notice, setNotice] = useState('')
  const createButton = useRef<HTMLButtonElement | null>(null)
  const restoreCreateFocus = useRef(false)
  const inputs = useRef<
    Partial<Record<LinkDraftField, HTMLInputElement | HTMLSelectElement | null>>
  >({})

  useEffect(() => {
    if (showForm) {
      inputs.current.name?.focus({ preventScroll: true })
      return
    }
    if (restoreCreateFocus.current) {
      createButton.current?.focus({ preventScroll: true })
      restoreCreateFocus.current = false
    }
  }, [showForm])

  const update = (field: LinkDraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const copyUrl = async (url: string, name: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(url)
      setNotice(`${name} copied.`)
    } catch {
      setNotice('Clipboard is unavailable. Select and copy the visible tracking URL.')
    }
  }

  const pending = mutation.status === 'pending' && mutation.operation === 'create-link'
  const canStart =
    resourcesKnown &&
    Boolean(product.mainLinkId && product.mainTrackingUrl) &&
    funnels.length > 0 &&
    sources.length > 0

  const closeForm = (restoreFocus = false) => {
    restoreCreateFocus.current = restoreFocus
    setShowForm(false)
    setErrors({})
  }

  return (
    <div className="live-links-workspace">
      {product.trackingMode === 'tracking_only' && (
        <div className="live-demo-scope" role="note">
          <strong>Tracking-only demo</strong>
          <span>
            Click and source attribution are live. Purchases, earnings and payouts are unavailable;
            this traffic is permanently non-commercial.
          </span>
        </div>
      )}

      <section className="panel live-main-link" aria-labelledby="live-main-link-title">
        <div>
          <span className="context-label">SERVER-ISSUED MAIN LINK</span>
          <h2 id="live-main-link-title">Your main link</h2>
          <p>
            Every source and campaign link below is derived from this current product link. The
            server owns its destination and attribution identity.
          </p>
        </div>
        {product.mainTrackingUrl ? (
          <div className="live-link-copy-row">
            <input
              aria-label="Main tracking URL"
              value={product.mainTrackingUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="button button-green"
              type="button"
              onClick={() => void copyUrl(product.mainTrackingUrl!, 'Main link')}
            >
              <Copy size={15} aria-hidden="true" />
              Copy main link
            </button>
          </div>
        ) : (
          <p className="inline-note">The administrator has not issued a current main link yet.</p>
        )}
      </section>

      <div className="live-links-actions">
        <div>
          <h2>Source and campaign links</h2>
          <p>
            {linksKnown
              ? `${links.length} server-issued variants for this product.`
              : 'Link history is unavailable until the protected read succeeds.'}
          </p>
        </div>
        <button
          ref={createButton}
          className="button button-green"
          type="button"
          disabled={!canStart || pending}
          aria-expanded={showForm}
          aria-controls="live-link-create-form"
          onClick={() => {
            if (showForm) {
              closeForm()
              return
            }
            setShowForm(true)
            setErrors({})
          }}
        >
          <Plus size={15} aria-hidden="true" />
          Create tracked link
        </button>
      </div>

      {!resourcesKnown && (
        <section
          className="panel live-data-state live-links-resource-state"
          role="alert"
          aria-labelledby="live-links-resource-title"
        >
          <AlertCircle size={26} aria-hidden="true" />
          <h2 id="live-links-resource-title">Links and sources are temporarily unavailable</h2>
          <p>
            {resourceError?.message ??
              'The current link history or creation options could not be verified safely.'}
          </p>
          <button
            className="button button-white"
            type="button"
            onClick={actions.refresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={isRefreshing ? 'spin' : ''} size={15} aria-hidden="true" />
            {isRefreshing ? 'Refreshing links…' : 'Retry links and sources'}
          </button>
        </section>
      )}

      {resourcesKnown && !canStart && (
        <p className="inline-note live-links-prerequisite">
          A current main link, live funnel and available traffic source are required before a
          derived link can be created.
        </p>
      )}

      {showForm && (
        <form
          id="live-link-create-form"
          className="panel live-link-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const nextErrors = validateDraft(draft, product, funnels, sources, campaigns)
            setErrors(nextErrors)
            const firstField = Object.keys(nextErrors).find(
              (field): field is LinkDraftField => field !== 'parent',
            )
            if (firstField) {
              inputs.current[firstField]?.focus()
              return
            }
            if (Object.keys(nextErrors).length || !product.mainLinkId) return

            const input: PartnerLinkCreate = {
              name: draft.name.trim(),
              productId: product.id,
              funnelId: draft.funnelId,
              sourceId: draft.sourceId,
              campaignId: draft.campaignId || null,
              sub1: draft.sub1.trim(),
              sub2: draft.sub2.trim(),
              sub3: draft.sub3.trim(),
              parentLinkId: product.mainLinkId,
            }
            void actions.createLink(input).then((result) => {
              if (result.status === 'ready' && result.data) {
                setDraft(initialDraft(funnels, sources))
                closeForm(true)
                setNotice(`${result.data.name} created. Its server-issued URL is ready to copy.`)
              }
            })
          }}
        >
          <div className="live-link-form-heading">
            <div>
              <span className="context-label">DERIVED FROM CURRENT MAIN LINK</span>
              <h2>Create a source link</h2>
            </div>
            <button className="button button-white" type="button" onClick={() => closeForm(true)}>
              Cancel
            </button>
          </div>
          {errors.parent && (
            <p className="form-error" role="alert">
              {errors.parent}
            </p>
          )}
          <div className="form-grid link-form-fields">
            <div className="form-field full-width">
              <label htmlFor="live-link-name">Link name</label>
              <input
                id="live-link-name"
                ref={(element) => {
                  inputs.current.name = element
                }}
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
                maxLength={120}
                autoComplete="off"
                required
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'live-link-name-error' : undefined}
                placeholder="e.g. TikTok profile bio"
              />
              {errors.name && (
                <span className="form-error" id="live-link-name-error" role="alert">
                  {errors.name}
                </span>
              )}
            </div>

            {(
              [
                ['funnelId', 'Funnel', funnels],
                ['sourceId', 'Traffic source', sources],
              ] as const
            ).map(([field, fieldLabel, options]) => (
              <div className="form-field" key={field}>
                <label htmlFor={`live-link-${field}`}>{fieldLabel}</label>
                <select
                  id={`live-link-${field}`}
                  ref={(element) => {
                    inputs.current[field] = element
                  }}
                  value={draft[field]}
                  onChange={(event) => update(field, event.target.value)}
                  required
                  aria-invalid={Boolean(errors[field])}
                  aria-describedby={errors[field] ? `live-link-${field}-error` : undefined}
                >
                  {options.length === 0 && (
                    <option value="">No available {fieldLabel.toLowerCase()}</option>
                  )}
                  {options.map((option) => (
                    <option value={option.id} key={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
                {errors[field] && (
                  <span className="form-error" id={`live-link-${field}-error`} role="alert">
                    {errors[field]}
                  </span>
                )}
              </div>
            ))}

            <div className="form-field full-width">
              <label htmlFor="live-link-campaignId">Campaign</label>
              <select
                id="live-link-campaignId"
                ref={(element) => {
                  inputs.current.campaignId = element
                }}
                value={draft.campaignId}
                onChange={(event) => update('campaignId', event.target.value)}
                aria-invalid={Boolean(errors.campaignId)}
                aria-describedby={errors.campaignId ? 'live-link-campaignId-error' : undefined}
              >
                <option value="">No campaign</option>
                {campaigns.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              {errors.campaignId && (
                <span className="form-error" id="live-link-campaignId-error" role="alert">
                  {errors.campaignId}
                </span>
              )}
            </div>

            {(
              [
                ['sub1', 'Sub 1', 'Required placement identifier'],
                ['sub2', 'Sub 2', 'Optional position identifier'],
                ['sub3', 'Sub 3', 'Optional creative identifier'],
              ] as const
            ).map(([field, fieldLabel, hint]) => (
              <div className={`form-field ${field === 'sub1' ? 'full-width' : ''}`} key={field}>
                <label htmlFor={`live-link-${field}`}>{fieldLabel}</label>
                <input
                  id={`live-link-${field}`}
                  ref={(element) => {
                    inputs.current[field] = element
                  }}
                  value={draft[field]}
                  onChange={(event) => update(field, event.target.value)}
                  required={field === 'sub1'}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors[field])}
                  aria-describedby={`live-link-${field}-hint${errors[field] ? ` live-link-${field}-error` : ''}`}
                />
                <span className="field-hint" id={`live-link-${field}-hint`}>
                  {hint}. Use letters, numbers, hyphens or underscores; do not enter personal data.
                </span>
                {errors[field] && (
                  <span className="form-error" id={`live-link-${field}-error`} role="alert">
                    {errors[field]}
                  </span>
                )}
              </div>
            ))}
          </div>
          {mutation.status === 'failed' && mutation.operation === 'create-link' && (
            <p className="form-error" role="alert">
              {mutation.error?.message ?? 'The tracking link could not be created.'}
            </p>
          )}
          <div className="dialog-actions">
            <span className="field-hint">
              The destination and partner identity remain server-owned.
            </span>
            <button className="button button-green" type="submit" disabled={pending}>
              <Link2 size={15} aria-hidden="true" />
              {pending ? 'Creating…' : 'Create live link'}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <p className="detail-notice live-links-notice" role="status">
          {notice}
        </p>
      )}

      {!resourcesKnown ? null : links.length === 0 ? (
        <section className="panel live-data-state live-links-empty">
          <Link2 size={28} aria-hidden="true" />
          <h2>No source links yet</h2>
          <p>
            Create the first server-issued variant after choosing its funnel, source and Sub IDs.
          </p>
        </section>
      ) : (
        <section className="panel live-links-list" aria-labelledby="live-links-list-title">
          <h2 id="live-links-list-title" className="sr-only">
            Source and campaign link history
          </h2>
          <div className="table-scroll links-history-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Link</th>
                  <th scope="col">Attribution dimensions</th>
                  <th scope="col">Funnel</th>
                  <th scope="col">Status</th>
                  <th scope="col">Clicks</th>
                  <th scope="col">Commercial scope</th>
                  <th scope="col">Tracking URL</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id}>
                    <th scope="row">
                      <span className="table-cell-primary">{link.name}</span>
                      <span className="table-cell-secondary">{link.productName}</span>
                    </th>
                    <td>
                      {dimensionSummary(
                        link.sourceName,
                        link.campaignName,
                        link.sub1,
                        link.sub2,
                        link.sub3,
                      )}
                    </td>
                    <td>{link.funnelName}</td>
                    <td>{link.status.replace(/^./, (value) => value.toUpperCase())}</td>
                    <td>{new Intl.NumberFormat('en-US').format(link.clicks)}</td>
                    <td>{link.commercialEligible ? 'Commercial' : 'Demo · non-commercial'}</td>
                    <td>
                      <div className="live-link-table-url">
                        <input
                          aria-label={`${link.name} tracking URL`}
                          value={link.trackingUrl}
                          readOnly
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <button
                          className="button button-white"
                          type="button"
                          aria-label={`Copy ${link.name} tracking link`}
                          onClick={() => void copyUrl(link.trackingUrl, link.name)}
                        >
                          <Copy size={14} aria-hidden="true" />
                          Copy
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
