import { useEffect, useRef, useState } from 'react'
import { requireSupabaseClient } from '../../../lib/supabase'
import { downloadCsv } from '../../../merchant/csv'
type Kind = 'ledger' | 'commissions' | 'payouts'
type Entry = {
  id: string
  at_time: string
  label: string
  program: string | null
  amount_minor: number
  currency: string
  reference: string
}
async function read(kind: Kind, until: string, after?: Entry) {
  const { data, error } = await requireSupabaseClient().rpc('partner_program_statement', {
    p_kind: kind,
    p_before_at: after?.at_time ?? null,
    p_before_id: after?.id ?? null,
    p_until: until,
  })
  if (error || !Array.isArray(data?.rows)) throw new Error('Statement data could not be loaded.')
  return data as { rows: Entry[]; more: boolean }
}
const labels: Record<Kind, string> = {
  ledger: 'Balance activity',
  commissions: 'Commissions and rewards',
  payouts: 'Payout history',
}
const amount = (row: Entry) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: row.currency }).format(
    row.amount_minor / 100,
  )
export function StatementHistory() {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<Kind>('ledger'),
    [revision, setRevision] = useState(0)
  const [rows, setRows] = useState<Entry[]>([]),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState('')
  const until = useRef(''),
    request = useRef(0)
  useEffect(() => {
    const id = ++request.current
    setRows([])
    setMore(false)
    setNote('')
    if (!open) return
    until.current = new Date().toISOString()
    setBusy(true)
    read(kind, until.current)
      .then((page) => {
        if (id === request.current) {
          setRows(page.rows)
          setMore(page.more)
        }
      })
      .catch(() => {
        if (id === request.current) setNote('Statement data could not be loaded.')
      })
      .finally(() => {
        if (id === request.current) setBusy(false)
      })
    return () => {
      request.current = id + 1
    }
  }, [open, kind, revision])
  async function pageOrExport(exportAll: boolean) {
    if (busy) return
    const id = request.current
    setBusy(true)
    setNote('')
    try {
      let list = rows.slice(),
        hasMore = more
      while (hasMore && id === request.current) {
        const last = list.at(-1),
          page = await read(kind, until.current, last)
        if (!last || page.rows.some((r) => r.id === last.id) || (!page.rows.length && page.more))
          throw new Error('Statement cursor did not advance.')
        list.push(...page.rows)
        hasMore = page.more
        if (!exportAll) break
      }
      if (id !== request.current) return
      if (exportAll) {
        downloadCsv('program-' + kind + '.csv', [
          [
            'Record ID',
            'UTC time',
            'Activity',
            'Program',
            'Amount (minor units)',
            'Currency',
            'Reference',
          ],
          ...list.map((r) => [
            r.id,
            r.at_time,
            r.label,
            r.program ?? '',
            r.amount_minor,
            r.currency,
            r.reference,
          ]),
        ])
        setNote(`Exported ${list.length} rows.`)
      } else {
        setRows(list)
        setMore(hasMore)
      }
    } catch {
      if (id === request.current) setNote('The statement could not finish loading. Try again.')
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  return (
    <div className="pe-list">
      <button type="button" className="pe-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        Statement history
      </button>
      {open && (
        <>
          <label>
            Statement{' '}
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {Object.entries(labels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {rows.length > 0 && (
            <>
              <table aria-label={labels[kind]}>
                <thead>
                  <tr>
                    {['Date', 'Activity', 'Amount', 'Reference'].map((head) => (
                      <th key={head}>{head}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.at_time).toLocaleDateString()}</td>
                      <td>
                        {r.label === 'paid'
                          ? 'Transferred to Stripe'
                          : r.label.replaceAll('_', ' ')}
                        {r.program && ' · ' + r.program}
                      </td>
                      <td>{amount(r)}</td>
                      <td>{r.reference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" disabled={busy} onClick={() => void pageOrExport(true)}>
                Download full statement CSV
              </button>
            </>
          )}
          {more && (
            <button type="button" disabled={busy} onClick={() => void pageOrExport(false)}>
              Older activity
            </button>
          )}
          {busy && <p role="status">Loading statement…</p>}
          {!busy && !rows.length && !note && <p>No activity for this statement.</p>}
          {note && (
            <p role="status">
              {note}{' '}
              {!rows.length && (
                <button type="button" onClick={() => setRevision((n) => n + 1)}>
                  Retry
                </button>
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
