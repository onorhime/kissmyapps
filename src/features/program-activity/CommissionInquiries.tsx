import './ProgramActivity.css'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { requireSupabaseClient } from '../../lib/supabase'

type Inquiry = {
  id: string
  created_at: string
  program: string
  reference: string
  question: string
  response: string | null
}
type Page = { rows: Inquiry[]; more: boolean; programs: { id: string; name: string }[] }
async function loadPage(workspace: string | null, after?: Inquiry): Promise<Page> {
  const { data, error } = await requireSupabaseClient().rpc('program_inquiries_page', {
    p_workspace: workspace,
    p_before_at: after?.created_at ?? null,
    p_before_id: after?.id ?? null,
  })
  if (error || !Array.isArray(data?.rows)) throw new Error('Could not load commission inquiries.')
  return data
}
export function CommissionInquiries({ workspace = null }: { workspace?: string | null }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="program-activity">
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {workspace ? 'Creator commission inquiries' : 'Ask about a missing commission'}
      </button>
      {open && <InquiryForm key={workspace ?? 'partner'} workspace={workspace} />}
    </section>
  )
}
function InquiryForm({ workspace }: { workspace: string | null }) {
  const [page, setPage] = useState<Page | null>(null),
    [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(true),
    [message, setMessage] = useState(''),
    [error, setError] = useState('')
  const active = useRef(false)
  useEffect(() => {
    let current = true
    active.current = true
    setBusy(true)
    setError('')
    loadPage(workspace)
      .then((data) => {
        if (current) setPage(data)
      })
      .catch(() => {
        if (current) setError('Could not load commission inquiries.')
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      active.current = false
    }
  }, [workspace, revision])
  async function submit(event: FormEvent<HTMLFormElement>, inquiry?: string) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget,
      values = new FormData(form),
      db = requireSupabaseClient()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = workspace
        ? await db.rpc('workspace_answer_commission', {
            p_workspace: workspace,
            p_inquiry: inquiry,
            p_response: values.get('response'),
          })
        : await db.rpc('partner_ask_commission', {
            p_program: values.get('program'),
            p_reference: values.get('reference'),
            p_question: values.get('question'),
          })
      if (result.error) throw result.error
      if (active.current) {
        form.reset()
        setMessage(
          workspace
            ? 'Your answer was sent to the creator.'
            : 'Inquiry recorded. Your merchant’s answer will appear here.',
        )
        setRevision((n) => n + 1)
      }
    } catch {
      if (active.current) {
        setError('Could not save this inquiry. Refresh and try again.')
        setBusy(false)
      }
    }
  }
  async function older() {
    if (busy || !page) return
    setBusy(true)
    setError('')
    try {
      const next = await loadPage(workspace, page.rows.at(-1))
      if (active.current) setPage({ ...next, rows: [...page.rows, ...next.rows] })
    } catch {
      if (active.current) setError('Older inquiries could not load.')
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return (
    <div>
      {!workspace && !!page?.programs.length && (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Program{' '}
            <select required name="program">
              {page.programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order or transaction reference <input name="reference" required maxLength={160} />
          </label>
          <label>
            What earnings did you expect?{' '}
            <textarea name="question" required minLength={5} maxLength={1000} />
          </label>
          <p>Use the order reference and omit customer contact, card and bank details.</p>
          <button type="submit" disabled={busy}>
            Send inquiry
          </button>
        </form>
      )}
      {page?.rows.map((row) => (
        <article key={row.id}>
          <h3>
            {row.program} · {row.reference}
          </h3>
          <time dateTime={row.created_at}>{new Date(row.created_at).toLocaleDateString()}</time>
          <p>{row.question}</p>
          {row.response ? (
            <p>Merchant response · {row.response}</p>
          ) : workspace ? (
            <form onSubmit={(e) => void submit(e, row.id)}>
              <label>
                Answer for the creator{' '}
                <textarea name="response" required minLength={5} maxLength={1000} />
              </label>
              <button type="submit" disabled={busy}>
                Send answer
              </button>
            </form>
          ) : (
            <p>Awaiting the merchant’s answer.</p>
          )}
        </article>
      ))}
      {page && !page.rows.length && <p>No commission inquiries yet.</p>}
      {page?.more && (
        <button type="button" disabled={busy} onClick={() => void older()}>
          Older inquiries
        </button>
      )}
      {busy && <p role="status">Loading…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Refresh inquiries
          </button>
        </p>
      )}
    </div>
  )
}
