import { useEffect, useRef, useState } from 'react'
import { creators, type Creator, type CreatorAction } from '../creators'

export function CreatorDirectory({
  workspace,
  revision,
  onDecision,
  canManage,
  live,
  busy,
}: {
  workspace: string
  revision: number
  onDecision: (creator: Creator, action: CreatorAction) => void
  canManage: boolean
  live: boolean
  busy: boolean
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all')
  const [rows, setRows] = useState<Creator[]>([]),
    [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0)
  const version = useRef(0)
  useEffect(() => {
    const current = ++version.current
    setRows([])
    setNext(null)
    setError('')
    if (!open) return
    setLoading(true)
    const timer = setTimeout(() => {
      creators
        .directory(workspace, query, status, null)
        .then((page) => {
          if (current === version.current) {
            setRows(page.rows)
            setNext(page.next)
          }
        })
        .catch(() => {
          if (current === version.current) setError('The creator directory could not load.')
        })
        .finally(() => {
          if (current === version.current) setLoading(false)
        })
    }, 150)
    return () => {
      clearTimeout(timer)
      version.current = current + 1
    }
  }, [workspace, open, query, status, revision, retry])
  async function more() {
    const current = version.current
    if (!next || loading) return
    setLoading(true)
    setError('')
    try {
      const page = await creators.directory(workspace, query, status, next)
      if (current === version.current) {
        setRows((old) => [
          ...old,
          ...page.rows.filter((row) => !old.some((r) => r.member_id === row.member_id)),
        ])
        setNext(page.next)
      }
    } catch {
      if (current === version.current) setError('The next creators could not load.')
    } finally {
      if (current === version.current) setLoading(false)
    }
  }
  return (
    <section className="mc-panel">
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Search creator directory
      </button>
      {open && (
        <>
          <label>
            Creator name or handle{' '}
            <input value={query} maxLength={160} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label>
            Membership{' '}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {['all', 'pending', 'active', 'ended'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {rows.map((row) => (
            <div key={row.member_id}>
              <strong>{row.name}</strong> · {row.handle} · {row.status}
              {canManage && live && row.status === 'pending' && (
                <button type="button" disabled={busy} onClick={() => onDecision(row, 'approve')}>
                  Approve {row.name}
                </button>
              )}
              {canManage && row.status === 'pending' && (
                <button type="button" disabled={busy} onClick={() => onDecision(row, 'decline')}>
                  Decline {row.name}
                </button>
              )}
              {canManage && row.status === 'active' && (
                <button type="button" disabled={busy} onClick={() => onDecision(row, 'remove')}>
                  Remove {row.name}
                </button>
              )}
            </div>
          ))}
          {error && (
            <p role="alert">
              {error}{' '}
              <button type="button" onClick={() => (next ? void more() : setRetry((n) => n + 1))}>
                Retry
              </button>
            </p>
          )}
          {loading && <p role="status">Loading creators…</p>}
          {!loading && !rows.length && !error && <p>No creators match these filters.</p>}
          {next && !error && (
            <button type="button" disabled={loading} onClick={() => void more()}>
              Load more creators
            </button>
          )}
        </>
      )}
    </section>
  )
}
