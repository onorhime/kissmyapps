import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { Check, Copy, LoaderCircle, Plus } from 'lucide-react'
import { marketplaceHash } from '../../marketplace/routing'
import '../../marketplace/marketplace.css'
import type { PartnerDataGateway } from '../api'
import {
  COUNT_LABELS,
  conversionOf,
  countKinds,
  countOf,
  creditedFor,
  earnFromOf,
} from './earnFrom'
import {
  LINK_NAME_MAX,
  addedLink,
  conversionRate,
  customLinksLeft,
  customLinksUsed,
  displayAddress,
  formatCount,
  linkEarnings,
  linkErrorMessage,
  linkNameProblem,
  linkStatusLine,
  mainLink,
  otherLinks,
} from './links'
import type { LinkProgram, ProgramLink, ProgramLinks } from './links'
import { PromoCodeBody } from './PromoCode'
import { useProgramLinks } from './useProgramLinks'
import type { LinkChange } from './useProgramLinks'
import './ProgramLinks.css'

/**
 * The Links page of the partner dashboard: for each program the creator joined, the one main
 * link, the same link ready-made for each channel, the custom links they added, and what each
 * of them brought in over the last 30 days: sales, or events such as sign-ups in a program
 * that pays for those.
 */

/** Up to this many programs are picked from buttons side by side; more are picked from a list. */
const PROGRAM_BUTTONS = 4

export function ProgramLinksPage({
  gateway,
  legacyBelow = false,
}: {
  gateway: PartnerDataGateway
  /** The older product links follow on the same page, under their own "Links & Sources" title. */
  legacyBelow?: boolean
}) {
  const { state, retry, addLink, removeLink } = useProgramLinks(gateway)
  const [chosen, setChosen] = useState<string | null>(null)
  // With the older links below, a page that has no program links yet stays as it was.
  if (state.status === 'unavailable' && legacyBelow) return null

  const programs = state.status === 'ready' ? state.links.programs : []
  const program = programs.find((item) => item.program_id === chosen) ?? programs[0] ?? null

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            {legacyBelow ? 'Program links' : 'Links'}
            <span className="heading-dot">.</span>
          </h1>
          <p>
            One link per program. Copy it for each place you post, and results are sorted by channel
            for you.
          </p>
        </div>
        {program && programs.length > 1 && (
          <ProgramPicker programs={programs} value={program.program_id} onChange={setChosen} />
        )}
      </div>

      <div className="pl-page" aria-busy={state.status === 'loading'}>
        {state.status === 'loading' && <LinksSkeleton />}

        {state.status === 'error' && (
          <div className="mkt-state" role="alert">
            <h2>Your links did not load</h2>
            <p>{linkErrorMessage(state.error)}</p>
            {state.error?.code !== 'not_authenticated' && (
              <button type="button" className="mkt-btn mkt-btn-quiet" onClick={retry}>
                Try again
              </button>
            )}
          </div>
        )}

        {state.status === 'unavailable' && (
          <div className="mkt-state">
            <p>{linkErrorMessage(state.error)}</p>
          </div>
        )}

        {state.status === 'ready' && !program && (
          <div className="mkt-state">
            <h2>Join a program to get your link</h2>
            <a className="mkt-btn mkt-btn-primary" href={marketplaceHash()}>
              Open the marketplace
            </a>
          </div>
        )}

        {state.status === 'ready' && program && (
          <ProgramLinksView
            key={program.program_id}
            program={program}
            links={state.links}
            addLink={addLink}
            removeLink={removeLink}
          />
        )}
      </div>
    </>
  )
}

function ProgramPicker({
  programs,
  value,
  onChange,
}: {
  programs: LinkProgram[]
  value: string
  onChange: (programId: string) => void
}) {
  if (programs.length > PROGRAM_BUTTONS)
    return (
      <label className="pl-select">
        <span className="mkt-sr">Program</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {programs.map((program) => (
            <option key={program.program_id} value={program.program_id}>
              {program.name}
            </option>
          ))}
        </select>
      </label>
    )
  return (
    <div className="pl-picker" role="group" aria-label="Program">
      {programs.map((program) => (
        <button
          key={program.program_id}
          type="button"
          aria-pressed={program.program_id === value}
          onClick={() => onChange(program.program_id)}
        >
          {program.name}
        </button>
      ))}
    </div>
  )
}

function LinksSkeleton() {
  return (
    <>
      <p className="mkt-sr" role="status">
        Loading your links
      </p>
      <div className="panel pl-panel" aria-hidden="true">
        <span className="pl-bar" style={{ width: 190, height: 22 }} />
        <span className="pl-bar" style={{ width: '100%', height: 56 }} />
        <span className="pl-bar" style={{ width: 150, height: 18 }} />
        <div className="pl-chips">
          {[82, 104, 96, 102, 48, 114].map((width) => (
            <span key={width} className="pl-bar" style={{ width, height: 44 }} />
          ))}
        </div>
      </div>
      <div className="panel pl-panel" aria-hidden="true">
        <span className="pl-bar" style={{ width: 170, height: 22 }} />
        <span className="pl-bar" style={{ width: '100%', height: 40 }} />
        <span className="pl-bar" style={{ width: '100%', height: 40 }} />
        <span className="pl-bar" style={{ width: '100%', height: 40 }} />
      </div>
    </>
  )
}

/** A long address wraps after a slash rather than in the middle of a word. */
function Address({ url }: { url: string }) {
  return (
    <>
      {url.split(/(?<=[^/]\/)(?=[^/])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  )
}

/** Which link was copied last, and whether the clipboard took it or it must be copied by hand. */
type Copied = { link: ProgramLink; how: 'copied' | 'by-hand' } | null

function ProgramLinksView({
  program,
  links,
  addLink,
  removeLink,
}: {
  program: LinkProgram
  links: ProgramLinks
  addLink: (slug: string, name: string) => Promise<LinkChange>
  removeLink: (linkId: string) => Promise<LinkChange>
}) {
  const id = useId()
  const main = mainLink(program)
  const others = otherLinks(program)
  const left = customLinksLeft(program, links.max_custom_links)
  const [copied, setCopied] = useState<Copied>(null)
  const [adding, setAdding] = useState(false)
  /** Said to a screen reader; what happened is also on the page. */
  const [said, setSaid] = useState('')
  const chips = useRef(new Map<string, HTMLButtonElement>())
  /** The link whose chip takes the focus once it is on the page. */
  const focusNext = useRef<string | null>(null)
  const addChip = useRef<HTMLButtonElement>(null)
  const resultsTitle = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (copied?.how !== 'copied') return
    const timeout = setTimeout(() => setCopied(null), 4000)
    return () => clearTimeout(timeout)
  }, [copied])

  // A link that was just added is the next thing to copy.
  useEffect(() => {
    const chip = focusNext.current && chips.current.get(focusNext.current)
    if (!chip) return
    chip.focus()
    focusNext.current = null
  })

  async function copy(link: ProgramLink) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(link.url)
      setCopied({ link, how: 'copied' })
      setSaid(`${link.name} copied`)
    } catch {
      setCopied({ link, how: 'by-hand' })
      setSaid('')
    }
  }

  function closeAdd() {
    setAdding(false)
    addChip.current?.focus()
  }

  function added(after: LinkProgram) {
    const link = addedLink(program, after)
    setAdding(false)
    if (!link) return
    setSaid(`${link.name} added`)
    focusNext.current = link.link_id
  }

  const mainCopied = copied?.how === 'copied' && copied.link.link_id === main.link_id

  return (
    <>
      <section className="panel pl-panel" aria-labelledby={`${id}-main`}>
        <header className="pl-head">
          <h2 id={`${id}-main`}>Your {program.name} link</h2>
          <p className={program.working ? 'pl-status' : 'pl-status pl-status-paused'}>
            {linkStatusLine(program)}
          </p>
        </header>

        <div className="pl-main">
          <p className="pl-url">
            <span className="mkt-sr">Main link: </span>
            <span>
              <Address url={displayAddress(main.url)} />
            </span>
          </p>
          <button type="button" className="mkt-btn mkt-btn-primary" onClick={() => void copy(main)}>
            {mainCopied ? (
              <Check size={18} aria-hidden="true" />
            ) : (
              <Copy size={18} aria-hidden="true" />
            )}
            {mainCopied ? 'Copied' : 'Copy link'}
          </button>
        </div>

        <div className="pl-channels">
          <h3 id={`${id}-channels`}>Copy for a channel</h3>
          <p>
            Same link, tagged so you can compare where your {creditedFor(earnFromOf(program))} come
            from.
          </p>
          <ul className="pl-chips" aria-labelledby={`${id}-channels`}>
            {others.map((link) => {
              const done = copied?.how === 'copied' && copied.link.link_id === link.link_id
              return (
                <li key={link.link_id}>
                  <button
                    type="button"
                    className={done ? 'mkt-chip pl-chip pl-chip-copied' : 'mkt-chip pl-chip'}
                    title={link.name}
                    ref={(node) => {
                      if (node) chips.current.set(link.link_id, node)
                      else chips.current.delete(link.link_id)
                    }}
                    onClick={() => void copy(link)}
                  >
                    <span>{link.name}</span>
                    {/* The space keeps the two words apart when the name is read out. */}
                    {done && (
                      <>
                        {' '}
                        <span className="pl-chip-done">copied</span>
                      </>
                    )}
                  </button>
                </li>
              )
            })}
            <li>
              {left > 0 ? (
                <button
                  type="button"
                  className="mkt-chip pl-chip pl-chip-add"
                  ref={addChip}
                  aria-expanded={adding}
                  aria-controls={adding ? `${id}-add` : undefined}
                  onClick={() => setAdding((open) => !open)}
                >
                  <Plus size={16} aria-hidden="true" />
                  <span>Add a custom link</span>
                </button>
              ) : (
                <p className="pl-limit">
                  {customLinksUsed(program, links.max_custom_links)}. That is the most a program can
                  have.
                </p>
              )}
            </li>
          </ul>

          {copied?.how === 'by-hand' && (
            <p className="pl-by-hand" role="status">
              Copying did not work here. Select the {copied.link.name} link and copy it:{' '}
              <span className="pl-by-hand-url">{copied.link.url}</span>
            </p>
          )}

          {adding && left > 0 && (
            <AddLinkForm
              id={`${id}-add`}
              program={program}
              used={customLinksUsed(program, links.max_custom_links)}
              onAdd={(name) => addLink(program.slug, name)}
              onAdded={added}
              onClose={closeAdd}
            />
          )}
        </div>
      </section>

      {program.promo_code && (
        <section className="panel pl-panel p8-promo" aria-labelledby={`${id}-promo`}>
          <header className="pl-head">
            <h2 id={`${id}-promo`}>Promo code</h2>
          </header>
          <PromoCodeBody promo={program.promo_code} />
        </section>
      )}

      <Results
        id={id}
        program={program}
        days={links.stats_days}
        titleRef={resultsTitle}
        removeLink={removeLink}
        onRemoved={(link) => {
          setSaid(`${link.name} removed`)
          resultsTitle.current?.focus()
        }}
      />

      <p className="mkt-sr" role="status">
        {said}
      </p>
    </>
  )
}

function AddLinkForm({
  id,
  program,
  used,
  onAdd,
  onAdded,
  onClose,
}: {
  id: string
  program: LinkProgram
  used: string
  onAdd: (name: string) => Promise<LinkChange>
  onAdded: (program: LinkProgram) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const wrong = linkNameProblem(name, program)
    if (wrong) {
      setProblem(wrong)
      field.current?.focus()
      return
    }
    setBusy(true)
    setProblem(null)
    const change = await onAdd(name.trim())
    if (change.error) {
      setBusy(false)
      setProblem(linkErrorMessage(change.error, 'change'))
      field.current?.focus()
      return
    }
    onAdded(change.program)
  }

  return (
    <form
      id={id}
      className="pl-add"
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose()
      }}
    >
      <label htmlFor={`${id}-name`}>Name of the link</label>
      <div className="pl-add-row">
        <input
          id={`${id}-name`}
          ref={field}
          type="text"
          value={name}
          maxLength={LINK_NAME_MAX}
          autoComplete="off"
          placeholder="Podcast"
          readOnly={busy}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="mkt-btn mkt-btn-primary" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
              Adding
            </>
          ) : (
            'Add link'
          )}
        </button>
      </div>
      <div id={`${id}-hint`}>
        {problem && (
          <p className="pl-error" role="alert">
            {problem}
          </p>
        )}
        <p className="pl-hint">It gets its own address and its own row of results. {used}.</p>
      </div>
    </form>
  )
}

function Results({
  id,
  program,
  days,
  titleRef,
  removeLink,
  onRemoved,
}: {
  id: string
  program: LinkProgram
  days: number
  titleRef: RefObject<HTMLHeadingElement | null>
  removeLink: (linkId: string) => Promise<LinkChange>
  onRemoved: (link: ProgramLink) => void
}) {
  /** The link whose removal is being asked about, and the one being removed. */
  const [asking, setAsking] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  /** The link whose Remove button takes the focus back when the question goes away. */
  const focusBack = useRef<string | null>(null)

  useEffect(() => {
    if (asking) confirm.current?.focus()
  }, [asking])

  useEffect(() => {
    const button = focusBack.current && removeButtons.current.get(focusBack.current)
    if (!button) return
    button.focus()
    focusBack.current = null
  })

  async function remove(link: ProgramLink) {
    setRemoving(link.link_id)
    setProblem(null)
    const change = await removeLink(link.link_id)
    setRemoving(null)
    setAsking(null)
    if (change.error) {
      setProblem(`${link.name}: ${linkErrorMessage(change.error, 'change')}`)
      focusBack.current = link.link_id
      return
    }
    onRemoved(link)
  }

  const counts = countKinds(earnFromOf(program))
  /** What a click turns into for the Conversion column: a sale, or an event. */
  const turnsInto = conversionOf(earnFromOf(program))

  return (
    <section
      className={
        counts.length > 1
          ? 'panel pl-panel pl-results pl-results-wide'
          : 'panel pl-panel pl-results'
      }
      aria-labelledby={`${id}-results`}
    >
      <header className="pl-head">
        <h2 id={`${id}-results`} ref={titleRef} tabIndex={-1}>
          Results by channel
        </h2>
        <p>Last {days} days</p>
      </header>

      <table aria-labelledby={`${id}-results`}>
        <thead>
          <tr>
            <th scope="col">Channel</th>
            <th scope="col">Link</th>
            <th scope="col" className="pl-num">
              Clicks
            </th>
            {counts.map((column) => (
              <th key={column} scope="col" className="pl-num">
                {COUNT_LABELS[column]}
              </th>
            ))}
            <th scope="col" className="pl-num">
              Conversion
            </th>
            <th scope="col" className="pl-num">
              Earnings
            </th>
          </tr>
        </thead>
        <tbody>
          {program.links.map((link) => (
            <tr key={link.link_id}>
              <th scope="row">{link.name}</th>
              <td className="pl-address">
                <span>
                  <Address url={displayAddress(link.url)} />
                </span>
                {link.removable && (
                  <span className="pl-action">
                    {asking === link.link_id ? (
                      <span
                        className="pl-confirm"
                        role="group"
                        aria-label={`Remove ${link.name}?`}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape' || removing !== null) return
                          focusBack.current = link.link_id
                          setAsking(null)
                        }}
                      >
                        <button
                          type="button"
                          className="mkt-link pl-remove pl-remove-yes"
                          ref={confirm}
                          disabled={removing !== null}
                          onClick={() => void remove(link)}
                        >
                          {removing === link.link_id ? 'Removing' : 'Yes, remove'}
                        </button>
                        <button
                          type="button"
                          className="mkt-link mkt-link-quiet pl-remove"
                          disabled={removing !== null}
                          onClick={() => {
                            focusBack.current = link.link_id
                            setAsking(null)
                          }}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="mkt-link mkt-link-quiet pl-remove"
                        aria-label={`Remove ${link.name}`}
                        ref={(node) => {
                          if (node) removeButtons.current.set(link.link_id, node)
                          else removeButtons.current.delete(link.link_id)
                        }}
                        disabled={removing !== null}
                        onClick={() => {
                          setProblem(null)
                          setAsking(link.link_id)
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                )}
              </td>
              <td className={quiet('pl-num pl-clicks', link.clicks === 0)}>
                {formatCount(link.clicks)}
              </td>
              {counts.map((column) => (
                <td
                  key={column}
                  className={quiet(`pl-num pl-${column}`, countOf(link, column) === 0)}
                >
                  {formatCount(countOf(link, column))}
                </td>
              ))}
              <td className={quiet('pl-num pl-rate', countOf(link, turnsInto) === 0)}>
                {conversionRate(link.clicks, countOf(link, turnsInto))}
              </td>
              <td className={quiet('pl-num pl-earnings', link.earnings_minor === 0)}>
                {linkEarnings(link, program.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {problem && (
        <p className="pl-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  )
}

/** A count that is nothing yet is printed in grey, so the rows with results stand out. */
function quiet(className: string, nothing: boolean): string {
  return nothing ? `${className} pl-zero` : className
}
