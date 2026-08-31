import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { previewCampaigns, previewFunnels, previewSources } from './data'
import type { PreviewLink } from './data'
import { createLinkPreview, newLinkDraft, validateLinkDraft, variantDraft } from './linkData'
import type { LinkDraft, LinkErrors } from './linkData'

export function LinkForm({
  links,
  parent,
  onAdd,
  onCancel,
}: {
  links: PreviewLink[]
  parent?: PreviewLink
  onAdd: (link: PreviewLink) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<LinkDraft>(() =>
    parent ? variantDraft(parent) : { ...newLinkDraft },
  )
  const [errors, setErrors] = useState<LinkErrors>({})
  const inputs = useRef<
    Partial<Record<keyof LinkDraft, HTMLInputElement | HTMLSelectElement | null>>
  >({})
  const pendingFocus = useRef<keyof LinkDraft | null>(null)
  useEffect(() => {
    if (pendingFocus.current) {
      inputs.current[pendingFocus.current]?.focus()
      pendingFocus.current = null
    }
  }, [errors])
  useEffect(() => {
    if (parent) inputs.current.name?.focus()
  }, [parent])
  const update = (field: keyof LinkDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))
  const fieldProps = (field: keyof LinkDraft) => ({
    id: `link-${field}`,
    ref: (element: HTMLInputElement | HTMLSelectElement | null) => {
      inputs.current[field] = element
    },
    value: draft[field],
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby':
      [
        errors[field] ? `link-${field}-error` : '',
        ['subId', 'sub2', 'sub3'].includes(field) ? `link-${field}-hint` : '',
      ]
        .filter(Boolean)
        .join(' ') || undefined,
  })
  const error = (field: keyof LinkDraft) =>
    errors[field] && (
      <span className="form-error" id={`link-${field}-error`} role="alert">
        {errors[field]}
      </span>
    )
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const next = validateLinkDraft(draft, links)
        pendingFocus.current = (Object.keys(next)[0] as keyof LinkDraft | undefined) ?? null
        setErrors(next)
        if (!Object.keys(next).length)
          onAdd(createLinkPreview(draft, `sample-link-${crypto.randomUUID()}`, parent?.id))
      }}
    >
      {parent && (
        <p className="inline-note">
          Variant of {parent.name}. A new URL and empty history; no traffic or earnings are copied.
        </p>
      )}
      <div className="form-grid link-form-fields">
        <div className="form-field full-width">
          <label htmlFor="link-name">Link name</label>
          <input
            {...fieldProps('name')}
            onChange={(event) => update('name', event.target.value)}
            maxLength={80}
            required
            autoComplete="off"
            placeholder="e.g. Example newsletter"
          />
          {error('name')}
        </div>
        {(
          [
            ['source', 'Source', previewSources.slice(0, 4)],
            ['campaign', 'Campaign', previewCampaigns],
            ['funnel', 'Funnel', previewFunnels],
          ] as const
        ).map(([field, label, options]) => (
          <div className={`form-field ${field === 'funnel' ? 'full-width' : ''}`} key={field}>
            <label htmlFor={`link-${field}`}>{label}</label>
            <select {...fieldProps(field)} onChange={(event) => update(field, event.target.value)}>
              {options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
            {error(field)}
          </div>
        ))}
        {(
          [
            ['subId', 'Sub ID', 'sub1 · Main placement (required)'],
            ['sub2', 'Sub 2', 'Optional position, such as description'],
            ['sub3', 'Sub 3', 'Optional creative or variation'],
          ] as const
        ).map(([field, label, hint]) => (
          <div className={`form-field ${field === 'subId' ? 'full-width' : ''}`} key={field}>
            <label htmlFor={`link-${field}`}>{label}</label>
            <input
              {...fieldProps(field)}
              onChange={(event) => update(field, event.target.value)}
              required={field === 'subId'}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-hint" id={`link-${field}-hint`}>
              {hint}. Letters, numbers, hyphens, underscores only; no personal data.
            </span>
            {error(field)}
          </div>
        ))}
        <label className="form-field full-width">
          Resolved destination
          <input value="Example product · Configured sample funnel only" readOnly />
        </label>
      </div>
      <p className="inline-note">
        All choices are fictional. Real partner/product/funnel identity, commercial terms, and
        destinations are resolved by the server—not editable URL IDs.
      </p>
      <div className="dialog-actions">
        <button className="button button-white" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button-green" type="submit">
          <Plus size={15} />
          Add to preview
        </button>
      </div>
    </form>
  )
}
