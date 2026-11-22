import './ProgramActivity.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { requireSupabaseClient } from '../../lib/supabase'
type Row = {
  id: string
  created_at: string
  label: string
  reference: string
  program?: string
  action?: string | null
}
type Mode = 'activity' | 'exceptions' | 'history'
const titles: Record<Mode, string> = {
  activity: 'Program notifications',
  exceptions: 'Reconciliation exceptions',
  history: 'Search review history',
}
function activityLink(action: string | null | undefined, merchant: boolean) {
  if (!action) return null
  if (merchant) {
    if (action === 'membership') return ['#creators', 'View creators']
    if (action === 'sales' || action === 'refund') return ['#sales', 'View sales and inquiries']
    if (action === 'balance') return ['#balance', 'View balance']
    if (action === 'program') return ['#program', 'View program']
  } else {
    if (action.startsWith('terms/'))
      return ['#marketplace/' + encodeURIComponent(action.slice(6)), 'Read the published terms']
    if (action === 'membership') return ['#marketplace', 'View marketplace']
    if (action === 'earnings' || action === 'refund')
      return ['#payouts', 'View earnings and inquiries']
  }
  return null
}
export function ProgramActivity({
  workspace = null,
  mode = 'activity',
}: {
  workspace?: string | null
  mode?: Mode
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [retry, setRetry] = useState(0)
  const [rows, setRows] = useState<Row[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const version = useRef(0)
  const page = useCallback(
    async (after?: Row) => {
      const args = {
        p_workspace: workspace,
        p_before_at: after?.created_at ?? null,
        p_before_id: after?.id ?? null,
      }
      const db = requireSupabaseClient()
      const { data, error } =
        mode === 'activity'
          ? await db.rpc('program_activity_page', args)
          : await db.rpc('program_reconciliation_page', { ...args, p_kind: mode, p_search: search })
      if (error || !Array.isArray(data?.rows)) throw new Error('Could not load this activity.')
      return data as { rows: Row[]; more: boolean }
    },
    [workspace, mode, search],
  )
  useEffect(() => {
    const id = ++version.current
    if (!open) return
    setRows([])
    setMore(false)
    setError('')
    setLoading(true)
    const timer = setTimeout(() => {
      page()
        .then((data) => {
          if (id === version.current) {
            setRows(data.rows)
            setMore(data.more)
          }
        })
        .catch(() => {
          if (id === version.current) setError('Could not load this activity.')
        })
        .finally(() => {
          if (id === version.current) setLoading(false)
        })
    }, 150)
    return () => {
      clearTimeout(timer)
      version.current = id + 1
    }
  }, [open, page, retry])
  async function next() {
    if (loading) return
    const id = version.current
    setLoading(true)
    setError('')
    try {
      const data = await page(rows.at(-1))
      if (id === version.current) {
        setRows((old) => [...old, ...data.rows])
        setMore(data.more)
      }
    } catch {
      if (id === version.current) setError('Older activity could not load.')
    } finally {
      if (id === version.current) setLoading(false)
    }
  }
  return (
    <section className="program-activity">
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {titles[mode]}
      </button>
      {open && (
        <>
          {mode !== 'activity' && (
            <label>
              Search by program, outcome or reference{' '}
              <input
                type="search"
                maxLength={200}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          )}
          {rows.length > 0 && (
            <ul>
              {rows.map((row) => {
                const link = activityLink(row.action, !!workspace)
                return (
                  <li key={row.id}>
                    <time dateTime={row.created_at}>
                      {new Date(row.created_at).toLocaleString()}
                    </time>{' '}
                    · {row.program && row.program + ' · '}
                    {row.label}
                    <br />
                    <small>Reference {row.reference}</small>{' '}
                    {link && <a href={link[0]}>{link[1]}</a>}
                  </li>
                )
              })}
            </ul>
          )}
          {loading && <p role="status">Loading activity…</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <button
                type="button"
                onClick={() => (rows.length ? void next() : setRetry((r) => r + 1))}
              >
                Retry
              </button>
            </p>
          )}
          {!rows.length && !loading && !error && (
            <p>
              {mode === 'exceptions'
                ? 'No matching exceptions.'
                : mode === 'history'
                  ? 'No matching reviews.'
                  : 'No program notifications yet.'}
            </p>
          )}
          {more && (
            <button type="button" disabled={loading} onClick={() => void next()}>
              Older activity
            </button>
          )}
        </>
      )}
    </section>
  )
}
