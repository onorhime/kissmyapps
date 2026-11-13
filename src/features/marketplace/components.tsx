import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BadgePercent, Search, ShoppingCart } from 'lucide-react'
import type { AgreementDoc, Category } from '../../merchant/programs'
import {
  buyerOfferLines,
  categoriesPresent,
  categoryLabel,
  filterPrograms,
  programHeadline,
  programHeadlineClass,
  programInitials,
  programLogoUrl,
  programRewardsLine,
  programTermsLine,
  projectBaseUrl,
  sectionParts,
} from './model'
import type { MarketplaceProgram } from './model'
import './marketplace.css'

/**
 * The pieces the public marketplace and the partner dashboard's Marketplace page both draw:
 * a program's logo, its card, the browsable grid and the agreement.
 */

const TILE_TONES = 6

function tone(name: string): number {
  let sum = 0
  for (const character of name) sum = (sum + character.codePointAt(0)!) % 997
  return sum % TILE_TONES
}

/** The uploaded logo, or the program's initials on a brand colour until there is one. */
export function ProgramLogo({
  name,
  logoPath,
  size = 'medium',
  baseUrl = projectBaseUrl(),
}: {
  name: string
  logoPath: string | null
  size?: 'small' | 'medium' | 'large'
  baseUrl?: string | null
}) {
  const url = programLogoUrl(baseUrl, logoPath)
  const [failed, setFailed] = useState<string | null>(null)
  const showImage = url !== null && failed !== url
  return (
    <span
      className={`mkt-logo mkt-logo-${size} ${showImage ? '' : `mkt-logo-tone-${tone(name)}`}`}
      aria-hidden="true"
    >
      {showImage ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(url)} />
      ) : (
        programInitials(name)
      )}
    </span>
  )
}

export function StatusPill({
  tone: pillTone,
  children,
}: {
  tone: 'good' | 'waiting' | 'quiet'
  children: ReactNode
}) {
  return <span className={`mkt-pill mkt-pill-${pillTone}`}>{children}</span>
}

/**
 * What buyers get, a line each: where a checkout link leads and the discount with a creator's
 * code. Nothing for a program on its own checkout with no discount. `discount={false}` leaves
 * the discount out where the creator's own code says it instead.
 */
export function BuyerOffer({
  program,
  discount = true,
}: {
  program: MarketplaceProgram
  discount?: boolean
}) {
  const lines = buyerOfferLines(program).filter((line) => discount || line.key !== 'discount')
  if (lines.length === 0) return null
  return (
    <ul className="p8-offer" aria-label="What buyers get">
      {lines.map((line) => (
        <li key={line.key}>
          {line.key === 'checkout' ? (
            <ShoppingCart size={16} aria-hidden="true" />
          ) : (
            <BadgePercent size={16} aria-hidden="true" />
          )}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  )
}

export function ProgramCard({
  program,
  href,
  status,
  onOpen,
}: {
  program: MarketplaceProgram
  href: string
  /** The signed-in creator's standing with this program, when there is one. */
  status?: ReactNode
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>) => void
}) {
  const headline = programHeadline(program)
  const rewards = programRewardsLine(program)
  const category = categoryLabel(program.category)
  return (
    <article className="mkt-card">
      <header className="mkt-card-head">
        <ProgramLogo name={program.name} logoPath={program.logo_path} />
        <div className="mkt-card-title">
          <h3>{program.name}</h3>
          {category && <p>{category}</p>}
        </div>
        {status}
      </header>
      {program.tagline && <p className="mkt-card-tagline">{program.tagline}</p>}
      {headline && (
        <p className={`mkt-card-headline${programHeadlineClass(program)}`}>{headline}</p>
      )}
      {rewards && <p className="mkt-card-rewards">{rewards}</p>}
      <BuyerOffer program={program} />
      <footer className="mkt-card-foot">
        <span>{programTermsLine(program)}</span>
        <a
          className="mkt-btn mkt-btn-quiet"
          href={href}
          onClick={onOpen}
          aria-label={`View program: ${program.name}`}
        >
          View program
        </a>
      </footer>
    </article>
  )
}

/** The grid while the programs load: cards of the final size, with nothing in them yet. */
export function ProgramGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="mkt-grid" role="status" aria-label="Loading programs">
      {Array.from({ length: count }, (_, index) => (
        <div className="mkt-card mkt-card-skeleton" key={index} aria-hidden="true">
          <div className="mkt-card-head">
            <span className="mkt-logo mkt-logo-medium mkt-bar" />
            <div className="mkt-card-title">
              <span className="mkt-bar" style={{ width: 120, height: 16 }} />
              <span className="mkt-bar" style={{ width: 72, height: 12 }} />
            </div>
          </div>
          <span className="mkt-bar" style={{ width: '88%', height: 14 }} />
          <span className="mkt-bar" style={{ width: '62%', height: 18 }} />
          <div className="mkt-card-foot">
            <span className="mkt-bar" style={{ width: 150, height: 12 }} />
            <span className="mkt-bar" style={{ width: 112, height: 38 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Category chips, a search box and the grid they filter. The filtering happens here. */
export function ProgramBrowser({
  programs,
  hrefFor,
  statusFor,
  onOpen,
}: {
  programs: readonly MarketplaceProgram[]
  hrefFor: (program: MarketplaceProgram) => string
  statusFor?: (program: MarketplaceProgram) => ReactNode
  onOpen?: (program: MarketplaceProgram, event: React.MouseEvent<HTMLAnchorElement>) => void
}) {
  const [category, setCategory] = useState<Category | null>(null)
  const [query, setQuery] = useState('')
  const searchId = useId()
  const categories = useMemo(() => categoriesPresent(programs), [programs])
  // A category can disappear when the list is reloaded; fall back to all of them.
  const activeCategory = category && categories.includes(category) ? category : null
  const shown = useMemo(
    () => filterPrograms(programs, activeCategory, query),
    [programs, activeCategory, query],
  )
  const filtered = activeCategory !== null || query.trim() !== ''

  return (
    <div className="mkt-browser">
      <div className="mkt-filters">
        {categories.length > 1 ? (
          <div className="mkt-chips" role="group" aria-label="Category">
            <button
              type="button"
              className="mkt-chip"
              aria-pressed={activeCategory === null}
              onClick={() => setCategory(null)}
            >
              All
            </button>
            {categories.map((key) => (
              <button
                type="button"
                className="mkt-chip"
                key={key}
                aria-pressed={activeCategory === key}
                onClick={() => setCategory(key)}
              >
                {categoryLabel(key)}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <label className="mkt-search" htmlFor={searchId}>
          <Search size={16} aria-hidden="true" />
          <span className="mkt-sr">Search programs</span>
          <input
            id={searchId}
            type="search"
            placeholder="Search programs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
          />
        </label>
      </div>

      {shown.length > 0 ? (
        <div className="mkt-grid">
          {shown.map((program) => (
            <ProgramCard
              key={program.slug}
              program={program}
              href={hrefFor(program)}
              status={statusFor?.(program)}
              onOpen={onOpen ? (event) => onOpen(program, event) : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="mkt-state">
          <h3>No programs match</h3>
          <p>
            {query.trim()
              ? `Nothing matches “${query.trim()}”${activeCategory ? ` in ${categoryLabel(activeCategory)}` : ''}.`
              : 'There are no programs in this category.'}
          </p>
          <button
            type="button"
            className="mkt-btn mkt-btn-quiet"
            onClick={() => {
              setCategory(null)
              setQuery('')
            }}
          >
            Show all programs
          </button>
        </div>
      )}

      <p className="mkt-count" role="status">
        {filtered
          ? `${shown.length} of ${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`
          : `${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`}
      </p>
    </div>
  )
}

/** The generated agreement as the creator reads it: title, the four facts, every section. */
export function AgreementDocument({
  doc,
  logoPath,
  subline,
  headingId,
}: {
  doc: AgreementDoc
  /** Leave out where the page already shows the logo beside the program's name. */
  logoPath?: string | null
  /** Who it is between and which version, under the title. */
  subline: string
  headingId?: string
}) {
  return (
    <article className="mkt-doc" aria-labelledby={headingId}>
      <header className="mkt-doc-head">
        {logoPath !== undefined && (
          <ProgramLogo name={doc.program_name || doc.title} logoPath={logoPath} size="large" />
        )}
        <div>
          <h2 id={headingId}>{doc.title}</h2>
          <p>{subline}</p>
        </div>
      </header>
      {doc.summary.length > 0 && (
        <dl className="mkt-doc-facts">
          {doc.summary.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mkt-doc-sections">
        {doc.sections.map((section) => {
          const parts = sectionParts(section.heading)
          return (
            <section key={section.heading}>
              <h3>
                {parts.number && <span className="mkt-doc-number">{parts.number}</span>}
                {/* The space is for anyone hearing the heading: "2 Commission", not "2Commission". */}
                {parts.number && ' '}
                {parts.title}
              </h3>
              {section.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </section>
          )
        })}
        {/* The last section already introduces these, so they follow it with no heading. */}
        {doc.extra_terms && <p className="mkt-doc-extra">{doc.extra_terms}</p>}
      </div>
    </article>
  )
}

/** The agreement page while it loads. */
export function AgreementSkeleton() {
  return (
    <div className="mkt-doc" role="status" aria-label="Loading the agreement">
      <div className="mkt-doc-head" aria-hidden="true">
        <span className="mkt-logo mkt-logo-large mkt-bar" />
        <div>
          <span className="mkt-bar" style={{ width: 260, maxWidth: '100%', height: 22 }} />
          <span className="mkt-bar" style={{ width: 180, height: 13, marginTop: 8 }} />
        </div>
      </div>
      <div className="mkt-doc-sections" aria-hidden="true">
        {[92, 100, 84, 96, 70].map((width, index) => (
          <span className="mkt-bar" key={index} style={{ width: `${width}%`, height: 14 }} />
        ))}
      </div>
    </div>
  )
}
