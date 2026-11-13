import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  AgreementDocument,
  AgreementSkeleton,
  ProgramBrowser,
  ProgramGridSkeleton,
  ProgramLogo,
} from './components'
import { categoryLabel, programHeadline, programTermsLine } from './model'
import type { MarketplaceProgram, MarketplaceProgramDetail } from './model'
import { loadMarketplaceProgram, loadMarketplacePrograms } from './publicApi'
import type { MarketplaceFailure, MarketplaceLoad } from './publicApi'
import { marketplacePath, marketplaceRouteFromPath, partnerAppUrl } from './routing'
import type { MarketplaceRoute } from './routing'
import './marketplace.css'

/**
 * The marketplace anyone can open, signed out: the list of live programs and one page per
 * program. It reads the public function and nothing else. No session, analytics or cookies.
 */

export interface PublicMarketplaceApi {
  loadPrograms: () => Promise<MarketplaceLoad<MarketplaceProgram[]>>
  loadProgram: (slug: string) => Promise<MarketplaceLoad<MarketplaceProgramDetail>>
}

const liveApi: PublicMarketplaceApi = {
  loadPrograms: () => loadMarketplacePrograms(),
  loadProgram: (slug) => loadMarketplaceProgram(slug),
}

type Loading = { status: 'loading' }
type ListState = Loading | MarketplaceLoad<MarketplaceProgram[]>
type ProgramState = Loading | MarketplaceLoad<MarketplaceProgramDetail>

const failureWords: Record<MarketplaceFailure, string> = {
  offline: 'You are offline. Reconnect to the internet and try again.',
  unavailable: 'The marketplace could not be loaded. Try again in a moment.',
}

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

export function PublicMarketplace({ api = liveApi }: { api?: PublicMarketplaceApi }) {
  const [route, setRoute] = useState<MarketplaceRoute>(() =>
    marketplaceRouteFromPath(window.location.pathname),
  )
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [listAttempt, setListAttempt] = useState(0)
  const [program, setProgram] = useState<{ slug: string; state: ProgramState } | null>(null)
  const [programAttempt, setProgramAttempt] = useState(0)
  const slug = route.name === 'program' ? route.slug : null
  const wantsList = route.name === 'list'
  const listLoaded = list.status === 'ready'

  useEffect(() => {
    const onPop = () => setRoute(marketplaceRouteFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = useCallback((path: string, event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return
    event.preventDefault()
    window.history.pushState(null, '', path)
    setRoute(marketplaceRouteFromPath(path))
    window.scrollTo({ top: 0, behavior: 'auto' })
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [])

  // The list is fetched once and kept while the visitor moves between programs.
  useEffect(() => {
    if (!wantsList || listLoaded) return
    let current = true
    void api.loadPrograms().then(
      (answer) => current && setList(answer),
      () => current && setList({ status: 'error', reason: 'unavailable' }),
    )
    return () => {
      current = false
    }
  }, [api, wantsList, listLoaded, listAttempt])

  useEffect(() => {
    if (!slug) return
    let current = true
    void api.loadProgram(slug).then(
      (answer) => current && setProgram({ slug, state: answer }),
      () => current && setProgram({ slug, state: { status: 'error', reason: 'unavailable' } }),
    )
    return () => {
      current = false
    }
  }, [api, slug, programAttempt])

  const programState: ProgramState =
    slug && program?.slug === slug ? program.state : { status: 'loading' }
  const shownProgram = programState.status === 'ready' ? programState.data : null

  useEffect(() => {
    const title =
      route.name === 'list'
        ? 'Marketplace'
        : shownProgram
          ? `${shownProgram.name} affiliate program`
          : route.name === 'not-found' || programState.status === 'not-found'
            ? 'Program not found'
            : 'Marketplace'
    document.title = `${title} · KissMyApps`
  }, [route.name, shownProgram, programState.status])

  const home = marketplacePath()
  const backToList = (
    <a className="mkt-btn mkt-btn-quiet" href={home} onClick={(event) => open(home, event)}>
      Back to the marketplace
    </a>
  )

  return (
    <div className="mkt-public">
      <header className="mkt-top">
        <div className="mkt-top-inner">
          <a
            className="mkt-brand"
            href={home}
            onClick={(event) => open(home, event)}
            aria-label="KissMyApps marketplace"
          >
            <img src="/favicon.svg" alt="" aria-hidden="true" />
            <span>
              Kissmyapps<span>.dev</span>
            </span>
          </a>
          <nav className="mkt-top-actions" aria-label="Creator account">
            <a
              className="mkt-top-link"
              href={partnerAppUrl(window.location, { screen: 'sign-in', join: slug })}
            >
              Sign in
            </a>
            <a
              className="mkt-btn mkt-btn-primary"
              href={partnerAppUrl(window.location, { screen: 'sign-up', join: slug })}
            >
              Become a creator
            </a>
          </nav>
        </div>
      </header>

      <main className="mkt-main" id="main-content" tabIndex={-1}>
        {route.name === 'list' && (
          <>
            <div className="mkt-title">
              <h1>Marketplace</h1>
              <p>
                Apps and products you can promote. Pick a program, accept its agreement and get your
                link.
              </p>
            </div>
            {list.status === 'loading' && <ProgramGridSkeleton />}
            {list.status === 'error' && (
              <div className="mkt-state" role="alert">
                <h2>The marketplace did not load</h2>
                <p>{failureWords[list.reason]}</p>
                <button
                  type="button"
                  className="mkt-btn mkt-btn-quiet"
                  onClick={() => {
                    setList({ status: 'loading' })
                    setListAttempt((attempt) => attempt + 1)
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            {list.status === 'ready' && list.data.length === 0 && (
              <div className="mkt-state">
                <h2>No programs yet</h2>
                <p>Programs appear here as soon as a business publishes one. Check back soon.</p>
              </div>
            )}
            {list.status === 'ready' && list.data.length > 0 && (
              <ProgramBrowser
                programs={list.data}
                hrefFor={(item) => marketplacePath(item.slug)}
                onOpen={(item, event) => open(marketplacePath(item.slug), event)}
              />
            )}
          </>
        )}

        {route.name === 'program' && programState.status === 'loading' && (
          <div className="mkt-program">
            <div className="mkt-program-head" role="status" aria-label="Loading the program">
              <span className="mkt-logo mkt-logo-large mkt-bar" aria-hidden="true" />
              <div aria-hidden="true">
                <span className="mkt-bar" style={{ width: 220, maxWidth: '100%', height: 32 }} />
                <span className="mkt-bar" style={{ width: 150, height: 14, marginTop: 10 }} />
              </div>
            </div>
            <AgreementSkeleton />
          </div>
        )}

        {route.name === 'program' && programState.status === 'error' && (
          <div className="mkt-state" role="alert">
            <h1>This program did not load</h1>
            <p>{failureWords[programState.reason]}</p>
            <button
              type="button"
              className="mkt-btn mkt-btn-quiet"
              onClick={() => {
                setProgram(null)
                setProgramAttempt((attempt) => attempt + 1)
              }}
            >
              Try again
            </button>
          </div>
        )}

        {(route.name === 'not-found' ||
          (route.name === 'program' && programState.status === 'not-found')) && (
          <div className="mkt-state">
            <h1>Program not found</h1>
            <p>This program does not exist or is no longer open. The link may be out of date.</p>
            {backToList}
          </div>
        )}

        {route.name === 'program' && shownProgram && (
          <ProgramPage
            program={shownProgram}
            crumbs={
              <nav className="mkt-crumbs" aria-label="Breadcrumb">
                <a href={home} onClick={(event) => open(home, event)}>
                  Marketplace
                </a>
                <span aria-hidden="true">/</span>
                <span aria-current="page">{shownProgram.name}</span>
              </nav>
            }
          />
        )}
      </main>

      <footer className="mkt-foot">© 2026 KissMyApps</footer>
    </div>
  )
}

function ProgramPage({
  program,
  crumbs,
}: {
  program: MarketplaceProgramDetail
  crumbs: React.ReactNode
}) {
  const brand = program.brand_name ?? program.name
  const category = categoryLabel(program.category)
  const headline = programHeadline(program)
  const open = program.status === 'live'
  return (
    <>
      {crumbs}
      <div className="mkt-program">
        <header className="mkt-program-head">
          <ProgramLogo name={program.name} logoPath={program.logo_path} size="large" />
          <div>
            <h1>{program.name}</h1>
            <p className="mkt-program-meta">
              {[category, program.brand_name !== program.name ? program.brand_name : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {program.tagline && <p className="mkt-program-tagline">{program.tagline}</p>}
          </div>
        </header>

        <aside className="mkt-side" aria-label="Join this program">
          {headline && <p className="mkt-side-headline">{headline}</p>}
          <p>{programTermsLine(program)}</p>
          {open ? (
            <>
              <a
                className="mkt-btn mkt-btn-primary mkt-btn-wide"
                href={partnerAppUrl(window.location, { join: program.slug })}
              >
                Join program
              </a>
              <p>
                {program.approval_mode === 'manual'
                  ? `You accept the agreement in your creator dashboard. ${brand} then approves each creator before a link is issued.`
                  : 'You accept the agreement in your creator dashboard and get your link straight away.'}
              </p>
            </>
          ) : (
            <p role="status">
              <strong>Not taking new creators.</strong> {brand} has paused this program. Check back
              later.
            </p>
          )}
        </aside>

        <AgreementDocument
          doc={program.agreement}
          subline={`Between you and ${program.agreement.brand_name || brand} · Version ${program.terms_version}`}
          headingId="mkt-agreement-title"
        />
      </div>
    </>
  )
}
