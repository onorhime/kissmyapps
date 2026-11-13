import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { formatAmount } from '../balance'
import { formatWhen } from '../connections'
import { creators } from '../creators'
import { formatCount, plural } from '../format'
import { href, navigate } from '../routes'
import {
  describeProblem,
  hasCommission,
  refundLine,
  sales,
  saleStatus,
  summaryLine,
  withNextPage,
} from '../sales'
import type { Sale, SalesProblem, SalesState, SalesSummary } from '../sales'
import { useStore } from '../store'
import { PageHeader, Pill, Skeleton } from '../ui/Primitives'

const REFRESH_MS = 60_000
const PROGRAM = href({ name: 'program' })
const CREATORS = href({ name: 'creators' })
const ALL_SALES = href({ name: 'sales' })

export function SalesScreen({ creator }: { creator?: string }) {
  const { workspace } = useStore()
  return workspace ? (
    <SalesPage workspaceId={workspace.id} workspaceName={workspace.name} memberId={creator} />
  ) : null
}

function SalesPage({
  workspaceId,
  workspaceName,
  memberId,
}: {
  workspaceId: string
  workspaceName: string
  memberId?: string
}) {
  const { signOut, now } = useStore()
  const listId = useId()
  const [state, setState] = useState<SalesState>()
  const [loadProblem, setLoadProblem] = useState<SalesProblem>()
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreProblem, setMoreProblem] = useState<SalesProblem>()
  // Once "Show more" has added a page, the list is the person's own and is not refreshed under them.
  const [pages, setPages] = useState(1)
  // The filtered creator's name when no sale on the page carries it.
  const [lookedUp, setLookedUp] = useState<string>()
  // The first sale of the page "Show more" just added: focus follows the list down.
  const added = useRef<string | null>(null)
  const [addedCount, setAddedCount] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const run = ++latest.current
      let next: SalesState
      try {
        next = await sales.list(workspaceId, { memberId })
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return
        setLoadProblem(describeProblem(problem, 'load'))
        return
      }
      if (run !== latest.current) return
      setState(next)
      setLoadProblem(undefined)
    },
    [workspaceId, memberId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Sales arrive without the person doing anything, so the first page looks for them itself.
  const settled = Boolean(state) && pages === 1 && !moreBusy
  useEffect(() => {
    if (!settled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true)
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [settled, load])

  // Back online: read the list again without being asked.
  useEffect(() => {
    if (!loadProblem) return
    const retry = () => void load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [loadProblem, load])

  useEffect(() => {
    if (!addedCount) return
    const rows = root.current?.querySelectorAll<HTMLElement>('[data-sale]') ?? []
    for (const row of rows) if (row.dataset.sale === added.current) row.focus()
  }, [addedCount])

  const nameOnPage = memberId
    ? (state?.sales.find((sale) => sale.member_id === memberId)?.creator_name ?? undefined)
    : undefined
  // A creator with no sales is on no row, so their name comes from the list of creators.
  const nameless = Boolean(memberId && state?.program && !nameOnPage)
  useEffect(() => {
    if (!nameless) return
    let current = true
    creators
      .list(workspaceId)
      .then((list) => {
        const found = list.creators.find((item) => item.member_id === memberId)
        if (current && found) setLookedUp(found.name)
      })
      .catch(() => {
        /* The filter still works without the name. */
      })
    return () => {
      current = false
    }
  }, [nameless, workspaceId, memberId])

  const more = async () => {
    const before = state?.next_before
    if (moreBusy || !state || !before) return
    setMoreProblem(undefined)
    setMoreBusy(true)
    try {
      const next = await sales.list(workspaceId, { before, memberId })
      // A refresh that was already on its way would put the first page back alone.
      latest.current += 1
      const known = new Set(state.sales.map((sale) => sale.sale_id))
      added.current = next.sales.find((sale) => !known.has(sale.sale_id))?.sale_id ?? null
      setState((current) => current && withNextPage(current, next))
      setPages((count) => count + 1)
      setAddedCount((count) => count + 1)
    } catch (problem) {
      setMoreProblem(describeProblem(problem, 'more'))
    } finally {
      setMoreBusy(false)
    }
  }

  const program = state?.program ?? null
  const currency = state?.currency ?? 'USD'
  const rows = state?.sales ?? []
  const summary = state?.summary ?? null
  const filterName = memberId ? (nameOnPage ?? lookedUp) : undefined
  const open = program?.status === 'live' || program?.status === 'paused'

  return (
    <div className="mc-page mc-sales" ref={root}>
      <PageHeader title="Sales" description="What your creators sold through their links." />

      {!state && !loadProblem && <Loading />}

      {loadProblem && !state && (
        <section className="mc-panel mc-sales-failed" aria-label="Sales">
          {memberId && <Chip name={filterName} />}
          <Problem
            problem={loadProblem}
            onRetry={() => {
              setLoadProblem(undefined)
              void load()
            }}
            onSignIn={() => void signOut()}
          />
        </section>
      )}

      {state && !program && (
        <section className="mc-panel" aria-label="Sales">
          <p className="mc-sales-none">
            {workspaceName} has no affiliate program yet.{' '}
            <a className="mc-link" href={PROGRAM}>
              Open Program
            </a>
          </p>
        </section>
      )}

      {state && program && (
        <>
          {summary && (summary.sales > 0 || rows.length > 0) && (
            <Summary summary={summary} currency={currency} filtered={Boolean(memberId)} />
          )}

          <section className="mc-panel mc-panel-flush" aria-labelledby={listId}>
            <div className="mc-panel-head is-padded mc-sales-head">
              <h2 id={listId}>{memberId ? 'Sales from' : 'All sales'}</h2>
              {memberId && <Chip name={filterName} />}
            </div>

            {rows.length === 0 ? (
              <p className="mc-empty-line">
                {memberId ? (
                  <>
                    {filterName ? `No sales from ${filterName} yet.` : 'No sales from them yet.'}{' '}
                    <a className="mc-link" href={ALL_SALES}>
                      Show all sales
                    </a>
                  </>
                ) : open ? (
                  <>
                    No sales yet. A sale appears here when someone buys through a creator&rsquo;s
                    link.{' '}
                    <a className="mc-link" href={CREATORS}>
                      Open Creators
                    </a>
                  </>
                ) : (
                  <>
                    Creators can sell once your program is live.{' '}
                    <a className="mc-link" href={PROGRAM}>
                      Open Program
                    </a>
                  </>
                )}
              </p>
            ) : (
              <table className="mc-table mc-sales-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Creator</th>
                    <th scope="col">Channel</th>
                    <th scope="col" className="mc-num-col">
                      Amount
                    </th>
                    <th scope="col" className="mc-num-col">
                      Commission
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sale) => (
                    <Row
                      key={sale.sale_id}
                      sale={sale}
                      currency={currency}
                      now={now}
                      linked={!memberId}
                    />
                  ))}
                </tbody>
              </table>
            )}

            {moreProblem && (
              <Problem
                problem={moreProblem}
                onRetry={() => void more()}
                onSignIn={() => void signOut()}
              />
            )}

            {rows.length > 0 && (state.next_before || pages > 1) && (
              <div className="mc-list-foot mc-sales-more">
                <span className="mc-muted mc-num">
                  {state.next_before
                    ? `Showing the latest ${formatCount(rows.length)}`
                    : `All ${plural(rows.length, 'sale')} shown`}
                </span>
                {state.next_before && (
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    disabled={moreBusy}
                    onClick={() => void more()}
                  >
                    {moreBusy ? <Working>Loading</Working> : 'Show more'}
                  </button>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** One sale: when, who sent it and through which link, what was paid, what it earned. */
function Row({
  sale,
  currency,
  now,
  linked,
}: {
  sale: Sale
  currency: string
  now: number
  linked: boolean
}) {
  const status = saleStatus(sale)
  // A buyer can pay in another currency than the program's; the amount is shown as paid.
  const paidIn = sale.currency ?? currency
  const refund = refundLine(sale, paidIn)
  const earned = hasCommission(sale)
  return (
    <tr data-sale={sale.sale_id} tabIndex={-1}>
      <td className="mc-sales-when mc-num">
        {formatWhen(sale.paid_at, Math.max(now, Date.parse(sale.paid_at)))}
      </td>
      <td className="mc-sales-who">
        {!sale.creator_name ? (
          <Dash label="Not known" />
        ) : linked && sale.member_id ? (
          <a
            href={href({ name: 'sales', creator: sale.member_id })}
            aria-label={`${sale.creator_name}: show only their sales`}
          >
            {sale.creator_name}
          </a>
        ) : (
          sale.creator_name
        )}
      </td>
      <td className="mc-sales-channel">
        {sale.link_name ?? <span className="mc-muted">No link</span>}
      </td>
      <td className="mc-num-col mc-num mc-sales-amount">
        {formatAmount(sale.amount_minor, paidIn)}
        {refund && <span className="mc-sub">{refund}</span>}
      </td>
      <td className="mc-num-col mc-num mc-sales-commission">
        {/* On a phone the refund is said here, so the name and its link stay together. */}
        {refund && <span className="mc-sales-label is-line">{refund}</span>}
        {earned ? (
          <>
            <span className="mc-sales-label">Commission </span>
            {formatAmount(sale.commission_minor ?? 0, currency)}
          </>
        ) : (
          <span className="mc-sales-dash">
            <Dash label="None" />
          </span>
        )}
      </td>
      <td className="mc-sales-status">
        <Pill tone={status.tone}>{status.label}</Pill>
        {status.detail && <span className="mc-sub">{status.detail}</span>}
      </td>
    </tr>
  )
}

/** The last 30 days in four figures, and one sentence on what they count. */
function Summary({
  summary,
  currency,
  filtered,
}: {
  summary: SalesSummary
  currency: string
  filtered: boolean
}) {
  const figures = [
    { label: 'Sales', value: formatCount(summary.sales) },
    { label: 'Sales amount', value: formatAmount(summary.sales_amount_minor, currency) },
    { label: 'Commission', value: formatAmount(summary.commission_minor, currency) },
    { label: 'KissMyApps fee', value: formatAmount(summary.fee_minor, currency) },
  ]
  return (
    <div
      className="mc-kpis mc-kpis-4"
      role="group"
      aria-label={`Last ${plural(summary.days, 'day')}`}
    >
      {figures.map((figure) => (
        <div className="mc-kpi" key={figure.label}>
          <span className="mc-kpi-label">{figure.label}</span>
          <strong className="mc-kpi-value mc-num">{figure.value}</strong>
        </div>
      ))}
      <p className="mc-kpis-note mc-muted">{summaryLine(summary, filtered)}</p>
    </div>
  )
}

/** The one creator the list is narrowed to. Its button shows everyone's sales again. */
function Chip({ name }: { name?: string }) {
  const label = name ?? 'One creator'
  return (
    <span className="mc-sales-chip">
      <span className="mc-truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        onClick={() => navigate({ name: 'sales' })}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </span>
  )
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** A value a sale does not have: no link, no commission. */
function Dash({ label }: { label: string }) {
  return (
    <span className="mc-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** A failure where it happened, with the one thing that gets past it. */
function Problem({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: SalesProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-sales-problem" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{problem.message}</span>
      {problem.recovery === 'retry' && onRetry && (
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      {problem.recovery === 'sign-in' && (
        <button type="button" className="mc-text-btn" onClick={onSignIn}>
          Sign in again
        </button>
      )}
    </p>
  )
}

function Loading() {
  return (
    <div className="mc-sales-loading" role="status" aria-label="Loading your sales">
      <div className="mc-kpis mc-kpis-4">
        {['Sales', 'Sales amount', 'Commission', 'KissMyApps fee'].map((label) => (
          <div className="mc-kpi" key={label}>
            <span className="mc-kpi-label">{label}</span>
            <span className="mc-kpi-value">
              <Skeleton width={96} height={26} />
            </span>
          </div>
        ))}
      </div>
      <div className="mc-panel">
        <Skeleton width={96} height={18} />
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} width="100%" height={36} />
        ))}
      </div>
    </div>
  )
}
