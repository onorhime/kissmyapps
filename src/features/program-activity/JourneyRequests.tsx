import './ProgramActivity.css'
import { useEffect, useState, type FormEvent } from 'react'
import { requireSupabaseClient } from '../../lib/supabase'
type RequestRow = {
  id: string
  source_name: string
  requested_at: string
  program: string
  environment: string
  outcome: string
  steps: unknown[]
  window_seconds: number
  response: string | null
  published_version: number | null
  funnel_id: string
}
async function read(source: string | null, after?: RequestRow) {
  const { data, error } = await requireSupabaseClient().rpc('creator_journey_requests_page', {
    p_source: source,
    p_before_at: after?.requested_at ?? null,
    p_before_id: after?.id ?? null,
  })
  if (error || !Array.isArray(data?.rows)) throw new Error('Journey requests could not load.')
  return data as { rows: RequestRow[]; more: boolean }
}
export function JourneyRequests({
  source = null,
  canRequest = false,
}: {
  source?: string | null
  canRequest?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="program-activity">
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {source ? 'Share this funnel with creators' : 'Creator journey requests'}
      </button>
      {open && (
        <JourneyReview key={source ?? 'operations'} source={source} canRequest={canRequest} />
      )}
    </section>
  )
}
function JourneyReview({ source, canRequest }: { source: string | null; canRequest: boolean }) {
  const [rows, setRows] = useState<RequestRow[]>([]),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(true)
  const [error, setError] = useState(''),
    [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setError('')
    setBusy(true)
    read(source)
      .then((p) => {
        if (current) {
          setRows(p.rows)
          setMore(p.more)
        }
      })
      .catch(() => {
        if (current) setError('Journey requests could not load.')
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [source, revision])
  async function submit(e: FormEvent<HTMLFormElement>, request?: string) {
    e.preventDefault()
    if (busy) return
    const values = new FormData(e.currentTarget),
      db = requireSupabaseClient()
    setBusy(true)
    setError('')
    try {
      const result = source
        ? await db.rpc('workspace_request_journey', {
            p_source: source,
            p_environment: values.get('environment'),
          })
        : await db.rpc('admin_review_creator_journey', {
            p_request: request,
            p_outcome: values.get('outcome'),
            p_response: values.get('response'),
          })
      if (result.error)
        throw new Error(
          result.error.code === '22023' ? result.error.message : 'Could not submit the review.',
        )
      setRevision((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit this request.')
      setBusy(false)
    }
  }
  async function older() {
    setBusy(true)
    setError('')
    try {
      const page = await read(source, rows.at(-1))
      setRows((old) => [...old, ...page.rows])
      setMore(page.more)
    } catch {
      setError('Could not load older requests.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      {source && (
        <p>
          A saved funnel measures activity in this analytics project. To share a journey with
          creators, send the saved steps to the platform team for review and publication under your
          affiliate program.
        </p>
      )}
      {source && canRequest && !busy && !error && !rows.some((r) => r.outcome === 'pending') && (
        <form onSubmit={(e) => void submit(e)}>
          <label>
            Journey environment{' '}
            <select name="environment">
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
          </label>
          <button type="submit">Request publication review</button>
        </form>
      )}
      {rows.map((r) => (
        <article key={r.id}>
          <h3>
            {r.source_name} · {r.program}
          </h3>
          <p>
            {r.environment} · {r.outcome.replaceAll('_', ' ')}
            {r.published_version && ' · Version ' + r.published_version}
          </p>
          <time dateTime={r.requested_at}>{new Date(r.requested_at).toLocaleString()}</time>
          {r.response && <p>{r.response}</p>}
          {!source && r.outcome === 'pending' && (
            <>
              <p>
                Commercial funnel {r.funnel_id} · Conversion window {r.window_seconds / 3600} hours
              </p>
              <details>
                <summary>Requested steps</summary>
                <pre>{JSON.stringify(r.steps, null, 2)}</pre>
              </details>
              <p>
                Open Funnels &amp; Links to configure and publish the commercial journey for the
                requested environment.
              </p>
              <form onSubmit={(e) => void submit(e, r.id)}>
                <label>
                  Decision{' '}
                  <select name="outcome">
                    <option value="changes_requested">Request changes</option>
                    <option value="published">Confirm published version</option>
                  </select>
                </label>
                <label>
                  Message to merchant{' '}
                  <textarea required minLength={5} maxLength={1000} name="response" />
                </label>
                <button type="submit" disabled={busy}>
                  Record decision
                </button>
              </form>
            </>
          )}
        </article>
      ))}
      {!busy && !error && !rows.length && <p>No publication requests yet.</p>}
      {busy && <p role="status">Loading…</p>}
      {more && (
        <button type="button" disabled={busy} onClick={() => void older()}>
          Older requests
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Refresh
          </button>
        </p>
      )}
    </div>
  )
}
