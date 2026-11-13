import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, Download, Pause, Pencil, Play, Plus, QrCode, Trash2 } from 'lucide-react'
import { api } from '../api'
import type {
  Attribution,
  AttributionLink,
  AttributionLinkFields,
  Project,
  Range,
  Role,
} from '../api'
import {
  SOURCE_SUGGESTIONS,
  hasApp,
  linkInstalls,
  linkWithOverrides,
  qrDataUrl,
  sourceLabel,
  suggestedPath,
} from '../attribution'
import { formatCount } from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { canDo, useStore } from '../store'
import {
  CopyButton,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Panel,
  Pill,
  Segmented,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

type Editing = AttributionLink | 'new' | null

export function LinksScreen({
  project,
  view,
  role,
}: {
  project: Project
  view: Attribution
  role?: Role
}) {
  const { notify } = useStore()
  const [range, setRange] = useState<Range>('30d')
  const [editing, setEditing] = useState<Editing>(null)
  const [sharing, setSharing] = useState<AttributionLink | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const canEdit = canDo(role, 'developer')
  // Installs and re-engagements only mean something for a project with an app.
  const apps = hasApp(project, view.settings)
  const report = useRpc(`attribution-links:${project.id}:${range}`, () =>
    api.attributionLinks(project.id, range),
  )
  const data = report.data

  const act = async (id: string, action: () => Promise<unknown>, message: string) => {
    setBusy(id)
    try {
      await action()
      notify(message)
      await report.refresh()
    } catch (problem) {
      notify(problem instanceof Error ? problem.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  if (editing)
    return (
      <LinkEditor
        project={project}
        view={view}
        host={data?.host ?? null}
        link={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={async (link, created) => {
          setEditing(null)
          await report.refresh()
          if (created) setSharing(link)
        }}
      />
    )

  return (
    <>
      <div className="mc-toolbar">
        <Segmented label="Date range" value={range} onChange={setRange} options={rangeOptions} />
        {canEdit && (
          <button
            type="button"
            className="mc-btn mc-btn-primary mc-toolbar-end"
            onClick={() => setEditing('new')}
          >
            <Plus size={16} aria-hidden="true" /> New link
          </button>
        )}
      </div>
      {report.error && (
        <ErrorNote
          message={`Couldn't load links. ${report.error}`}
          onRetry={() => void report.refresh()}
        />
      )}
      <Panel
        title="Links"
        description={
          apps
            ? `Clicks, the installs and visits they brought, and the conversions they got ${rangePhrase[range]}.`
            : `Clicks, the visits they opened and the conversions they got ${rangePhrase[range]}.`
        }
        id="mc-attr-links"
        flush
      >
        {!data ? (
          <div className="mc-panel-pad" aria-busy="true">
            <Skeleton width="100%" height={120} />
          </div>
        ) : data.links.length === 0 ? (
          <div className="mc-attr-empty">
            <Empty>
              No links yet. Make one for each place you share {project.name}: an ad, a bio, an email
              or a QR code. Each one says where the people it brings came from.
            </Empty>
            {canEdit && (
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                onClick={() => setEditing('new')}
              >
                <Plus size={16} aria-hidden="true" /> Make your first link
              </button>
            )}
          </div>
        ) : (
          <table
            className={
              apps ? 'mc-table mc-attr-links-table mc-at2-links' : 'mc-table mc-attr-links-table'
            }
          >
            <thead>
              <tr>
                <th scope="col">Link</th>
                <th scope="col">Source</th>
                <th scope="col" className="mc-num-col">
                  Clicks
                </th>
                {apps && (
                  <>
                    <th scope="col" className="mc-num-col">
                      Installs
                    </th>
                    <th scope="col" className="mc-num-col">
                      Re-engagements
                    </th>
                  </>
                )}
                <th scope="col" className="mc-num-col">
                  Visits
                </th>
                <th scope="col" className="mc-num-col">
                  Conversions
                </th>
                <th scope="col" className="is-action">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.links.map((link) => (
                <tr key={link.id}>
                  <td data-label="Link">
                    <span className="mc-attr-link-name">
                      <strong>{link.name}</strong>
                      {link.status === 'paused' && <Pill tone="warning">Paused</Pill>}
                    </span>
                    {link.url && (
                      <span className="mc-attr-link-url">
                        <span className="mc-mono mc-truncate">
                          {link.url.replace('https://', '')}
                        </span>
                        <CopyButton value={link.url} label={`${link.name} link`} compact />
                      </span>
                    )}
                  </td>
                  <td data-label="Source">
                    <span>{sourceLabel(link.source)}</span>
                    {link.campaign && <span className="mc-sub mc-truncate">{link.campaign}</span>}
                  </td>
                  <td data-label="Clicks" className="mc-num mc-num-col">
                    {formatCount(link.clicks ?? 0)}
                  </td>
                  {apps && (
                    <>
                      <td data-label="Installs" className="mc-num mc-num-col">
                        {formatCount(linkInstalls(link).installs)}
                      </td>
                      <td data-label="Re-engagements" className="mc-num mc-num-col">
                        {formatCount(linkInstalls(link).reengagements)}
                      </td>
                    </>
                  )}
                  <td data-label="Visits" className="mc-num mc-num-col">
                    {formatCount(link.visits ?? 0)}
                  </td>
                  <td data-label="Conversions" className="mc-num mc-num-col">
                    {formatCount(link.conversions ?? 0)}
                  </td>
                  <td className="is-action">
                    <span className="mc-row-actions">
                      {link.url && (
                        <button
                          type="button"
                          className="mc-icon-btn"
                          aria-label={`QR code for ${link.name}`}
                          title="QR code"
                          onClick={() => setSharing(link)}
                        >
                          <QrCode size={18} aria-hidden="true" />
                        </button>
                      )}
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            className="mc-icon-btn"
                            aria-label={`Edit ${link.name}`}
                            title="Edit"
                            onClick={() => setEditing(link)}
                          >
                            <Pencil size={18} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="mc-icon-btn"
                            aria-label={`${link.status === 'active' ? 'Pause' : 'Resume'} ${link.name}`}
                            title={link.status === 'active' ? 'Pause' : 'Resume'}
                            disabled={busy === link.id}
                            onClick={() =>
                              void act(
                                link.id,
                                () =>
                                  api.setLinkStatus(
                                    link.id,
                                    link.status === 'active' ? 'paused' : 'active',
                                  ),
                                link.status === 'active'
                                  ? `${link.name} is paused: it sends people to your website without counting them`
                                  : `${link.name} is active again`,
                              )
                            }
                          >
                            {link.status === 'active' ? (
                              <Pause size={18} aria-hidden="true" />
                            ) : (
                              <Play size={18} aria-hidden="true" />
                            )}
                          </button>
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {data && data.hosts.length > 1 && (
        <p className="mc-muted mc-attr-note">
          Links work on every live domain: {data.hosts.join(', ')}.
        </p>
      )}
      <ShareDialog link={sharing} onClose={() => setSharing(null)} />
    </>
  )
}

// Sharing ------------------------------------------------------------------------------------------

function ShareDialog({ link, onClose }: { link: AttributionLink | null; onClose: () => void }) {
  return (
    <Dialog
      open={Boolean(link)}
      onOpenChange={(open) => !open && onClose()}
      title={link ? `Share ${link.name}` : 'Share'}
      description="Use the link in ads, bios and messages, or print the QR code."
    >
      {link?.url && <ShareLink key={link.id} link={link} url={link.url} />}
    </Dialog>
  )
}

function ShareLink({ link, url }: { link: AttributionLink; url: string }) {
  const [qr, setQr] = useState<{ value: string; image: string } | null>(null)
  const [campaign, setCampaign] = useState('')
  const [ad, setAd] = useState('')
  const shared = linkWithOverrides(url, { cmp: campaign, ad })
  // The code is drawn for the address as it is now; an older one is not shown.
  const image = qr?.value === shared ? qr.image : null

  useEffect(() => {
    let stale = false
    qrDataUrl(shared)
      .then((data) => {
        if (!stale) setQr({ value: shared, image: data })
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [shared])

  return (
    <div className="mc-form-stack">
      <div className="mc-attr-share-url">
        <span className="mc-mono">{shared}</span>
        <CopyButton value={shared} label="link" />
      </div>
      <div className="mc-attr-qr">
        {image ? (
          <img src={image} alt={`QR code for ${shared}`} width={180} height={180} />
        ) : (
          <Skeleton width={180} height={180} />
        )}
        {image && (
          <a className="mc-btn mc-btn-secondary" href={image} download={`${link.path}-qr.png`}>
            <Download size={16} aria-hidden="true" /> Download QR code
          </a>
        )}
      </div>
      <details className="mc-attr-details">
        <summary>Set the campaign or ad for one use</summary>
        <p className="mc-muted">
          Added to the end of the link, these replace the link's own for clicks on that address. Ad
          platforms can fill them with their own macros.
        </p>
        <div className="mc-form-grid">
          <Field label="Campaign">
            {(props) => (
              <input
                {...props}
                value={campaign}
                placeholder={link.campaign ?? 'october_launch'}
                onChange={(event) => setCampaign(event.target.value)}
              />
            )}
          </Field>
          <Field label="Ad">
            {(props) => (
              <input
                {...props}
                value={ad}
                placeholder={link.ad ?? 'video_1'}
                onChange={(event) => setAd(event.target.value)}
              />
            )}
          </Field>
        </div>
      </details>
    </div>
  )
}

// Making and changing a link ------------------------------------------------------------------------

type Draft = Record<
  | 'name'
  | 'path'
  | 'source'
  | 'campaign'
  | 'channel'
  | 'adset'
  | 'ad'
  | 'deep_link_value'
  | 'web_url'
  | 'ios_url'
  | 'android_url'
  | 'social_title'
  | 'social_description'
  | 'social_image',
  string
>

function draftOf(link: AttributionLink | null): Draft {
  return {
    name: link?.name ?? '',
    path: link?.path ?? '',
    source: link?.source ?? '',
    campaign: link?.campaign ?? '',
    channel: link?.channel ?? '',
    adset: link?.adset ?? '',
    ad: link?.ad ?? '',
    deep_link_value: link?.deep_link_value ?? '',
    web_url: link?.web_url ?? '',
    ios_url: link?.ios_url ?? '',
    android_url: link?.android_url ?? '',
    social_title: link?.social_title ?? '',
    social_description: link?.social_description ?? '',
    social_image: link?.social_image ?? '',
  }
}

function checkDraft(draft: Draft): Partial<Record<keyof Draft, string>> {
  const found: Partial<Record<keyof Draft, string>> = {}
  if (!draft.name.trim()) found.name = 'Give the link a name.'
  const source = draft.source.trim().toLowerCase().replace(/\s+/g, '_')
  if (!/^[a-z0-9][a-z0-9_.-]{0,59}$/.test(source))
    found.source = 'Name the source in letters, numbers and _ . -, such as tiktok.'
  const path = draft.path
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
  if (path && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(path))
    found.path = 'Use lowercase letters, numbers, hyphens and underscores.'
  for (const key of ['web_url', 'ios_url', 'android_url', 'social_image'] as const) {
    const value = draft[key].trim()
    if (value && /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https:\/\//i.test(value))
      found[key] = 'Use an address that starts with https://.'
  }
  return found
}

function LinkEditor({
  project,
  view,
  host,
  link,
  onClose,
  onSaved,
}: {
  project: Project
  view: Attribution
  host: string | null
  link: AttributionLink | null
  onClose: () => void
  onSaved: (link: AttributionLink, created: boolean) => Promise<void>
}) {
  const { notify } = useStore()
  const listId = useId()
  const [draft, setDraft] = useState(() => draftOf(link))
  const [pathTouched, setPathTouched] = useState(Boolean(link))
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const settings = view.settings
  const hasIos = Boolean(settings?.ios_app_store_id) || project.platforms.includes('ios')
  const hasAndroid = Boolean(settings?.android_package) || project.platforms.includes('android')

  const set = (key: keyof Draft, value: string) =>
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === 'name' && !pathTouched) next.path = suggestedPath(value)
      return next
    })

  const save = (event: FormEvent) => {
    event.preventDefault()
    const found = checkDraft(draft)
    setErrors(found)
    setProblem(undefined)
    if (Object.keys(found).length) return
    const fields: AttributionLinkFields = {}
    const before = draftOf(link)
    for (const key of Object.keys(draft) as Array<keyof Draft>) {
      if (!link || draft[key] !== before[key]) fields[key] = draft[key].trim()
    }
    if (!link && !fields.path) delete fields.path
    setBusy(true)
    api
      .saveLink(project.id, link?.id ?? null, fields)
      .then(async (saved) => {
        notify(link ? `${saved.name} saved` : `${saved.name} is ready to share`)
        await onSaved(saved, !link)
      })
      .catch((error) => setProblem(error instanceof Error ? error.message : 'That did not work.'))
      .finally(() => setBusy(false))
  }

  const remove = () => {
    if (!link) return
    setBusy(true)
    api
      .deleteLink(link.id)
      .then(async () => {
        notify(`${link.name} deleted`)
        await onSaved(link, false)
      })
      .catch((error) => {
        setConfirmDelete(false)
        setProblem(error instanceof Error ? error.message : 'That did not work.')
      })
      .finally(() => setBusy(false))
  }

  const text = (
    key: keyof Draft,
    label: string,
    options: { hint?: string; placeholder?: string; maxLength?: number; list?: string } = {},
  ) => (
    <Field label={label} hint={options.hint} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          value={draft[key]}
          placeholder={options.placeholder}
          maxLength={options.maxLength ?? 200}
          list={options.list}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </Field>
  )

  return (
    <form className="mc-attr-editor" onSubmit={save} noValidate>
      <div className="mc-attr-editor-head">
        <button type="button" className="mc-btn mc-btn-quiet" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" /> All links
        </button>
        <h2>{link ? `Edit ${link.name}` : 'New link'}</h2>
      </div>

      <section className="mc-panel" aria-labelledby={`${listId}-what`}>
        <div className="mc-panel-head">
          <div>
            <h3 id={`${listId}-what`}>The link</h3>
            <p>A name for you, and the address people see.</p>
          </div>
        </div>
        <div className="mc-form-grid">
          {text('name', 'Name', { placeholder: 'October launch on TikTok', maxLength: 120 })}
          <Field
            label="Address"
            hint={
              link
                ? 'Changing it stops the old address working.'
                : 'Leave it empty for a short random one.'
            }
            error={errors.path}
          >
            {(props) => (
              <div className="mc-affix is-prefix">
                <span className="mc-mono" aria-hidden="true">
                  {host ?? view.link_root}/
                </span>
                <input
                  {...props}
                  value={draft.path}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setPathTouched(true)
                    set('path', event.target.value)
                  }}
                />
              </div>
            )}
          </Field>
        </div>
      </section>

      <section className="mc-panel" aria-labelledby={`${listId}-source`}>
        <div className="mc-panel-head">
          <div>
            <h3 id={`${listId}-source`}>Where it is shared</h3>
            <p>Reports group visits and conversions by these, in this order.</p>
          </div>
        </div>
        <div className="mc-form-grid">
          {text('source', 'Media source', {
            hint: 'Who sends the people: tiktok, instagram, influencer, email.',
            placeholder: 'tiktok',
            maxLength: 60,
            list: `${listId}-sources`,
          })}
          <datalist id={`${listId}-sources`}>
            {SOURCE_SUGGESTIONS.map((source) => (
              <option key={source} value={source} />
            ))}
          </datalist>
          {text('campaign', 'Campaign', { placeholder: 'october_launch' })}
          {text('channel', 'Channel', { placeholder: 'paid_social', maxLength: 100 })}
          {text('adset', 'Ad set', { placeholder: 'lagos_18_24' })}
          {text('ad', 'Ad', { placeholder: 'video_1' })}
        </div>
      </section>

      <section className="mc-panel" aria-labelledby={`${listId}-where`}>
        <div className="mc-panel-head">
          <div>
            <h3 id={`${listId}-where`}>Where it leads</h3>
            <p>Leave these empty to use your app store pages and website.</p>
          </div>
        </div>
        <div className="mc-form-grid">
          {text('web_url', 'Website page', {
            hint: 'For computers, and phones when there is no app.',
            placeholder: settings?.web_url ?? 'https://yourbrand.com/start',
            maxLength: 2000,
          })}
          {hasIos &&
            text('ios_url', 'iPhone', {
              hint: settings?.ios_app_store_id
                ? 'Your App Store page unless you set another.'
                : 'Add your App Store ID in Setup to send iPhones to the App Store.',
              placeholder: settings?.ios_app_store_id
                ? `https://apps.apple.com/app/id${settings.ios_app_store_id}`
                : 'https://apps.apple.com/app/id…',
              maxLength: 2000,
            })}
          {hasAndroid &&
            text('android_url', 'Android', {
              hint: settings?.android_package
                ? 'Google Play, with the click passed to your app, unless you set another.'
                : 'Add your package name in Setup to send Android phones to Google Play.',
              placeholder: settings?.android_package
                ? `https://play.google.com/store/apps/details?id=${settings.android_package}`
                : 'https://play.google.com/store/apps/details?id=…',
              maxLength: 2000,
            })}
          {text('deep_link_value', 'Screen in the app', {
            hint: 'Your app gets it in onDeepLink, also right after an install. Needs SDK 1.1.',
            placeholder: 'lesson_4',
            maxLength: 500,
          })}
        </div>
      </section>

      <section className="mc-panel" aria-labelledby={`${listId}-preview`}>
        <div className="mc-panel-head">
          <div>
            <h3 id={`${listId}-preview`}>Preview in chats and feeds</h3>
            <p>Empty, a shared link shows your website's own preview.</p>
          </div>
        </div>
        <div className="mc-form-grid">
          {text('social_title', 'Title', { placeholder: project.name, maxLength: 120 })}
          {text('social_image', 'Image address', {
            placeholder: 'https://yourbrand.com/share.png',
            maxLength: 2000,
          })}
        </div>
        <Field label="Description" error={errors.social_description}>
          {(props) => (
            <textarea
              {...props}
              rows={2}
              value={draft.social_description}
              maxLength={300}
              onChange={(event) => set('social_description', event.target.value)}
            />
          )}
        </Field>
      </section>

      {problem && <p className="mc-field-error">{problem}</p>}
      <div className="mc-form-actions mc-attr-editor-actions">
        {link &&
          (confirmDelete ? (
            <span className="mc-attr-confirm">
              <span>Delete {link.name}? A link with clicks can only be paused.</span>
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                onClick={() => setConfirmDelete(false)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="mc-btn mc-btn-danger-solid"
                disabled={busy}
                onClick={remove}
              >
                Delete
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="mc-btn mc-btn-danger"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={16} aria-hidden="true" /> Delete link
            </button>
          ))}
        <span className="mc-attr-editor-spacer" />
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
          {link ? 'Save link' : 'Make link'}
        </button>
      </div>
    </form>
  )
}
