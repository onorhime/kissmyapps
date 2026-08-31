import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Copy,
  GitBranch,
  Link2,
  MousePointer2,
  Plus,
  QrCode,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { Dialog } from '../../components/Dialog'
import { EmptyState, ErrorState, LoadingState, PartialNotice } from '../../components/States'
import { mainPreviewUrl, money, number, previewSources, sumMetric, trackedPreviewUrl } from './data'
import type { PreviewLink, PreviewState } from './data'
import { linkStatus, sourceSnapshot } from './linkData'
import { LinkForm } from './LinkForm'
import { LinkQr } from './LinkQr'

type Props = {
  state: PreviewState
  links: PreviewLink[]
  onAdd: (link: PreviewLink) => void
  onStatusChange: (id: string, action: 'toggle' | 'archive' | 'restore') => void
  onViewPerformance: (link: PreviewLink) => void
  notify: (message: string) => void
  onRetry: () => void
}
type Panel =
  | { kind: 'create'; parentId?: string }
  | { kind: 'details' | 'qr' | 'archive'; id: string; focusHeading?: boolean }
  | { kind: 'main' | 'guide' }
  | null

export function Links(props: Props) {
  return <LinksWorkspace key={props.state === 'partial' ? 'sample' : props.state} {...props} />
}

function LinksWorkspace({
  state,
  links,
  onAdd,
  onStatusChange,
  onViewPerformance,
  notify,
  onRetry,
}: Props) {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [status, setStatus] = useState('all')
  const [panel, setPanel] = useState<Panel>(null)
  const [notice, setNotice] = useState('')
  const [description, setDescription] = useState('Sample tracking details. This link is not live.')
  const generation = useRef(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const archiveCancel = useRef<HTMLButtonElement>(null)
  const restoreDetailFocus = useRef(false)
  useEffect(
    () => () => {
      generation.current += 1
    },
    [],
  )
  useEffect(() => {
    if (panel?.kind === 'archive') archiveCancel.current?.focus()
    if (restoreDetailFocus.current) {
      detailHeading.current?.focus()
      restoreDetailFocus.current = false
    }
  }, [panel])
  const available = state !== 'empty' && state !== 'loading' && state !== 'error'
  const allLinks = state === 'empty' ? [] : links
  const selected =
    panel && 'id' in panel ? allLinks.find((link) => link.id === panel.id) : undefined
  const parent =
    panel?.kind === 'create' ? allLinks.find((link) => link.id === panel.parentId) : undefined
  const isMain = panel?.kind === 'main' || (panel?.kind === 'qr' && panel.id === 'main')
  const filtered = allLinks.filter(
    (link) =>
      (source === 'all' || link.source === source) &&
      (status === 'all' || status === linkStatus(link)) &&
      `${link.name} ${link.source} ${link.campaign} ${link.funnel} ${link.subId} ${link.sub2} ${link.sub3}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  function open(next: Panel, message = '') {
    generation.current += 1
    setNotice('')
    setDescription(message || 'Sample tracking details. This link is not live.')
    setPanel(next)
  }
  function backToDetails(id: string) {
    restoreDetailFocus.current = true
    open(id === 'main' ? { kind: 'main' } : { kind: 'details', id })
  }
  async function copyLink(link?: PreviewLink) {
    const current = ++generation.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(link ? trackedPreviewUrl(link) : mainPreviewUrl)
      if (current !== generation.current) return
      const message = 'Sample link copied. This .invalid URL is not live.'
      if (panel) setNotice(message)
      else notify(message)
    } catch {
      if (current !== generation.current) return
      const message = 'Clipboard is unavailable. Select and copy the sample URL from link details.'
      if (panel) setNotice(message)
      else open(link ? { kind: 'details', id: link.id } : { kind: 'main' }, message)
    }
  }
  const details = (link?: PreviewLink) => (
    <>
      <h3 className="link-detail-heading" ref={detailHeading} tabIndex={-1}>
        {link ? 'Tracking details' : 'Your main sample link'}
      </h3>
      {link && (
        <dl className="definition-list link-definition">
          {[
            ['Source', link.source],
            ['Campaign', link.campaign],
            ['Funnel', link.funnel],
            ['Sub ID · sub1', link.subId],
            ['Sub 2', link.sub2 || 'Not set'],
            ['Sub 3', link.sub3 || 'Not set'],
            ['Status', linkStatus(link)],
            [
              'Based on',
              allLinks.find((value) => value.id === link.parentId)?.name || 'Original sample link',
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <label className="form-field">
        Sample tracked URL
        <textarea
          className="url-textarea"
          readOnly
          rows={4}
          value={link ? trackedPreviewUrl(link) : mainPreviewUrl}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <p className="inline-note">
        Share the tracked route, never a raw funnel destination. Sample identity is fixed; the real
        server will resolve partner, product, funnel, and commercial terms.
      </p>
      {link && (
        <p className="inline-note">
          {link.archived
            ? 'Archived in this preview. History is retained; restore as paused before using it again.'
            : !link.active
              ? 'Paused in this preview. Historical results remain available.'
              : 'Active sample only—not a live link.'}{' '}
          All history below is July 28–August 26, 2026 UTC.
        </p>
      )}
      {link && (
        <dl className="link-detail-metrics">
          {[
            ['Clicks', number(link.clicks)],
            ['Qualified leads', number(link.leads)],
            ['Confirmed installs', state === 'partial' ? '—' : number(link.installs)],
            ['New Paid Customers', number(link.purchases)],
            ['Earnings', money(link.earningsMinor)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="detail-notice" role="status">
        {notice}
      </p>
      <div className="link-action-grid">
        <button
          className="button button-green"
          disabled={link?.archived}
          onClick={() => void copyLink(link)}
        >
          <Copy size={15} />
          Copy sample URL
        </button>
        <button
          className="button button-white"
          disabled={link?.archived}
          onClick={() => open({ kind: 'qr', id: link?.id ?? 'main', focusHeading: true })}
        >
          <QrCode size={15} />
          Download QR
        </button>
        {link && (
          <>
            <button
              className="button button-white"
              onClick={() => open({ kind: 'create', parentId: link.id })}
            >
              <GitBranch size={15} />
              Create variant
            </button>
            <button className="button button-white" onClick={() => onViewPerformance(link)}>
              <ChartNoAxesCombined size={15} />
              View Performance
            </button>
            <button
              className="button button-white"
              onClick={() => {
                onStatusChange(link.id, link.archived ? 'restore' : 'toggle')
                setNotice(
                  `Sample link ${link.archived ? 'restored as paused' : link.active ? 'paused' : 'activated'} in this preview only. History is unchanged.`,
                )
              }}
            >
              {link.archived
                ? 'Restore as paused'
                : link.active
                  ? 'Pause sample link'
                  : 'Activate sample link'}
            </button>
            {!link.archived && (
              <button
                className="button button-white"
                onClick={() => open({ kind: 'archive', id: link.id })}
              >
                <Archive size={15} />
                Archive…
              </button>
            )}
          </>
        )}
      </div>
    </>
  )
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EVERY GREAT RESULT STARTS HERE</p>
          <h1>
            Links &amp; Sources<span className="heading-dot">.</span>
          </h1>
          <p>Your links. Your channels. A clearer picture of what works.</p>
        </div>
        <button
          className="button button-green"
          disabled={!available}
          onClick={() => open({ kind: 'create' })}
        >
          <Plus size={16} />
          Create sample link
        </button>
      </div>
      {state === 'loading' ? (
        <LoadingState label="Loading links preview" />
      ) : state === 'error' ? (
        <ErrorState onRetry={onRetry} />
      ) : (
        <>
          <section className="main-link-card" aria-label="Main partner link">
            <div>
              <span className="eyebrow">ONE STARTING POINT</span>
              <h2>Your main link</h2>
              <p>
                {available
                  ? 'The main tracked route for your example partnership. Use source links to distinguish placements.'
                  : 'Your main link will appear after a product and funnel are configured.'}
              </p>
              <label className="form-field">
                <span className="sr-only">Main sample link</span>
                <textarea
                  rows={2}
                  value={available ? mainPreviewUrl : 'No product or funnel configured'}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <div className="main-link-actions">
                <button
                  className="button button-green"
                  disabled={!available}
                  onClick={() => void copyLink()}
                >
                  <Copy size={15} />
                  Copy main link
                </button>
                <button
                  className="button button-white"
                  disabled={!available}
                  onClick={() => open({ kind: 'qr', id: 'main' })}
                >
                  <QrCode size={15} />
                  Download main QR
                </button>
                <button
                  className="button button-white"
                  disabled={!available}
                  onClick={() => open({ kind: 'create' })}
                >
                  <Plus size={15} />
                  Create source link
                </button>
              </div>
            </div>
            <aside>
              <ShieldCheck size={26} />
              <strong>Every conversion follows one journey.</strong>
              <p>
                All conversion CTAs enter the same tracked Web2App route. No product, funnel, or
                live tracking URL has been created.
              </p>
              <button className="text-button" onClick={() => open({ kind: 'guide' })}>
                How links work <ArrowUpRight size={14} />
              </button>
            </aside>
          </section>
          {state === 'partial' && <PartialNotice />}
          <section className="metric-grid payout-metric-grid" aria-label="Link summary">
            {[
              [
                'Active links',
                allLinks
                  .filter((link) => link.active && !link.archived)
                  .length.toString()
                  .padStart(2, '0'),
                `${allLinks.length} sample links · Includes archived history`,
                Link2,
              ],
              [
                'Attributed link clicks',
                number(allLinks.reduce((sum, link) => sum + link.clicks, 0)),
                'Jul 28–Aug 26, 2026 · UTC snapshot',
                MousePointer2,
              ],
              [
                'Connected sources',
                new Set(allLinks.map((link) => link.source)).size.toString().padStart(2, '0'),
                'Paused and archived sources retain their history',
                SlidersHorizontal,
              ],
            ].map(([label, value, note, Icon], index) => {
              const Symbol = Icon as typeof Link2
              return (
                <article
                  key={String(label)}
                  className={`metric-card ${index === 2 ? 'metric-featured' : ''}`}
                >
                  <div className="metric-top">
                    <span>{String(label)}</span>
                    <Symbol size={17} />
                  </div>
                  <strong className="metric-value">{String(value)}</strong>
                  <div className="metric-foot">
                    <span>{String(note)}</span>
                  </div>
                </article>
              )
            })}
          </section>
          <section className="panel links-table-panel">
            <div className="panel-heading">
              <div>
                <h2>
                  Your tracked links <span className="count-bubble">{allLinks.length}</span>
                </h2>
                <p>
                  July 28–August 26, 2026 · UTC · USD · Sample history, independent of report
                  filters.
                </p>
              </div>
            </div>
            <div className="table-toolbar links-toolbar">
              <label className="search-field">
                <Search size={16} />
                <span className="sr-only">Search links</span>
                <input
                  ref={searchInput}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search labels, campaigns, funnels, or Sub IDs…"
                />
              </label>
              <label className="filter-select">
                <span className="sr-only">Filter links by source</span>
                <select value={source} onChange={(event) => setSource(event.target.value)}>
                  <option value="all">All sources</option>
                  {previewSources.slice(0, 4).map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="filter-select">
                <span className="sr-only">Link status</span>
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="all">All statuses</option>
                  {['Active', 'Paused', 'Archived'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            {filtered.length ? (
              <div
                className="table-scroll links-history-scroll"
                role="region"
                tabIndex={0}
                aria-label="Tracked links table"
              >
                <table>
                  <caption className="sr-only">
                    Sample tracked links. URLs are not live; all historical amounts are USD.
                  </caption>
                  <thead>
                    <tr>
                      {[
                        'Link / QR',
                        'Source / Campaign',
                        'Funnel / Sub IDs',
                        'Clicks',
                        'Leads',
                        'Confirmed Installs',
                        'New Paid',
                        'Earnings',
                        'Status',
                        'Actions',
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((link) => (
                      <tr key={link.id}>
                        <th scope="row">
                          <span className="table-cell-primary link-table-name">{link.name}</span>
                          <span className="table-cell-secondary">
                            Example product{link.parentId ? ' · Variant' : ''}
                          </span>
                        </th>
                        <td>
                          <span className="table-cell-primary">{link.source}</span>
                          <span className="table-cell-secondary">{link.campaign}</span>
                        </td>
                        <td className="link-tracking-cell">
                          <span className="table-cell-primary">{link.funnel}</span>
                          <span className="table-cell-secondary">sub1: {link.subId}</span>
                          {link.sub2 && (
                            <span className="table-cell-secondary">sub2: {link.sub2}</span>
                          )}
                          {link.sub3 && (
                            <span className="table-cell-secondary">sub3: {link.sub3}</span>
                          )}
                        </td>
                        <td>{number(link.clicks)}</td>
                        <td>{number(link.leads)}</td>
                        <td>
                          {state === 'partial' ? (
                            <span aria-label="Confirmed installs unavailable">—</span>
                          ) : (
                            number(link.installs)
                          )}
                        </td>
                        <td>{number(link.purchases)}</td>
                        <td className="money-cell">{money(link.earningsMinor)}</td>
                        <td>
                          <span
                            className={`status-badge ${linkStatus(link) === 'Active' ? 'badge-green' : 'badge-neutral'}`}
                          >
                            {linkStatus(link)}
                          </span>
                        </td>
                        <td>
                          <div className="table-actions">
                            <button
                              className="icon-button"
                              aria-label={`Copy sample ${link.name} link`}
                              disabled={link.archived}
                              onClick={() => void copyLink(link)}
                            >
                              <Copy size={15} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Download QR for ${link.name}`}
                              disabled={link.archived}
                              onClick={() => open({ kind: 'qr', id: link.id })}
                            >
                              <QrCode size={15} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`View ${link.name} link details`}
                              onClick={() => open({ kind: 'details', id: link.id })}
                            >
                              <ArrowUpRight size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={<Link2 size={28} />}
                title={state === 'empty' ? 'Your first link is ahead of you' : 'No matching links'}
                description={
                  state === 'empty'
                    ? 'There are no products or funnels yet. When the first one is ready, your tracked links will live here.'
                    : 'Try another label, tracking value, source, or status.'
                }
                action={
                  <button
                    className="button button-white"
                    onClick={() => {
                      if (state === 'empty') open({ kind: 'guide' })
                      else {
                        setQuery('')
                        setSource('all')
                        setStatus('all')
                        searchInput.current?.focus()
                      }
                    }}
                  >
                    {state === 'empty' ? 'Learn how tracking works' : 'Clear search & filters'}
                    <ArrowRight size={14} />
                  </button>
                }
              />
            )}
            <div className="panel-footnote">
              <span>
                <ShieldCheck size={14} />
                Sample URLs use .invalid and cannot receive real traffic.
              </span>
              <span>
                {filtered.length} of {allLinks.length} links
              </span>
            </div>
          </section>
          <section className="source-cards-section">
            <div className="section-title">
              <h2>A closer look at your sources</h2>
              <span>Last 30 days · Sample data</span>
            </div>
            <div className="source-cards">
              {state === 'empty' ? (
                <div className="empty-source-card">
                  <Plus size={20} />
                  <span>Sources appear when links are available.</span>
                </div>
              ) : (
                previewSources.slice(0, 4).map((value, index) => {
                  const rows = sourceSnapshot.filter((row) => row.source === value)
                  return (
                    <article key={value}>
                      <span className={`source-symbol source-symbol-${index}`}>
                        <ArrowUpRight size={16} />
                      </span>
                      <h3>{value}</h3>
                      <strong>
                        {number(sumMetric(rows, 'clicks'))}
                        <small> clicks</small>
                      </strong>
                      <div className="source-card-track">
                        <span
                          style={{
                            width: `${(sumMetric(rows, 'clicks') / sumMetric(sourceSnapshot, 'clicks')) * 100}%`,
                          }}
                        />
                      </div>
                      <p>{money(sumMetric(rows, 'earningsMinor'))} in sample earnings</p>
                    </article>
                  )
                })
              )}
            </div>
          </section>
        </>
      )}
      <Dialog
        open={Boolean(panel)}
        onOpenChange={(value) => {
          if (!value) open(null)
        }}
        title={
          panel?.kind === 'create'
            ? parent
              ? 'Create a sample variant'
              : 'Create a sample link'
            : panel?.kind === 'qr'
              ? `QR · ${isMain ? 'Main link' : (selected?.name ?? 'Sample link')}`
              : panel?.kind === 'archive'
                ? `Archive ${selected?.name}?`
                : panel?.kind === 'guide'
                  ? 'From a link to a clear result'
                  : isMain
                    ? 'Main link details'
                    : (selected?.name ?? 'Link details')
        }
        description={
          panel?.kind === 'create'
            ? 'Explore the link-creation flow. Nothing is stored in Supabase or made live.'
            : description
        }
      >
        {panel?.kind === 'create' && (
          <LinkForm
            key={parent?.id ?? 'new'}
            links={allLinks}
            parent={parent}
            onCancel={() => (parent ? backToDetails(parent.id) : open(null))}
            onAdd={(link) => {
              onAdd(link)
              open(null)
              setQuery('')
              setSource('all')
              setStatus('all')
              notify('Sample link added to this preview only. No live link was created.')
            }}
          />
        )}
        {((panel?.kind === 'details' && selected) || panel?.kind === 'main') && details(selected)}
        {panel?.kind === 'qr' && (selected || isMain) && (
          <LinkQr
            key={panel.id}
            url={selected ? trackedPreviewUrl(selected) : mainPreviewUrl}
            name={selected?.name ?? 'your main link'}
            fileKey={selected?.id ?? 'partner-main'}
            autoFocusHeading={panel.focusHeading}
            onBack={() => backToDetails(panel.id)}
          />
        )}
        {panel?.kind === 'archive' && selected && (
          <div className="archive-confirmation">
            <p>
              Archive <strong>{selected.name}</strong> in this preview? Its clicks, conversions,
              earnings, and historical Performance remain unchanged.
            </p>
            <p>
              You can find it with the Archived filter and restore it as paused. No record is
              deleted and no live link is changed.
            </p>
            <div className="dialog-actions">
              <button
                ref={archiveCancel}
                className="button button-white"
                onClick={() => backToDetails(selected.id)}
              >
                Cancel
              </button>
              <button
                className="button button-green"
                onClick={() => {
                  onStatusChange(selected.id, 'archive')
                  backToDetails(selected.id)
                  setNotice('Sample link archived. Its historical results have been retained.')
                }}
              >
                Archive sample link
              </button>
            </div>
          </div>
        )}
        {panel?.kind === 'guide' && (
          <>
            <div className="guide-steps">
              <div>
                <span>01</span>
                <h3>Choose a product &amp; funnel</h3>
                <p>The first real product must be configured before a live link can be issued.</p>
              </div>
              <div>
                <span>02</span>
                <h3>Give every placement its own link</h3>
                <p>
                  Choose a configured source, campaign, and funnel. Sub IDs 1–3 distinguish content,
                  position, and creative.
                </p>
              </div>
              <div>
                <span>03</span>
                <h3>Follow verified outcomes</h3>
                <p>
                  The QR and copied URL enter the same tracked journey. Pausing or archiving never
                  deletes historical earnings.
                </p>
              </div>
            </div>
            <p className="inline-note">
              No product or funnel has been created as part of this UI preview. Real IDs and
              commercial rules are resolved server-side.
            </p>
          </>
        )}
      </Dialog>
    </>
  )
}
