import { useState } from 'react'
import { requireSupabaseClient } from '../../lib/supabase'
import { inviteLink } from '../creators'
import { useRpc } from '../ui/useRpc'
type Readiness = {
  published: boolean
  slug: string | null
  destination: string | null
  status: string
  stripe_connected: boolean
  available_minor: number | null
  currency: string
  payouts_enabled: boolean
  last_click: string | null
  last_sale: string | null
  events: {
    key: string
    label: string
    test_at: string | null
    live_at: string | null
    awarded_at: string | null
  }[]
}
const at = (date: string | null) => (date ? new Date(date).toLocaleString() : 'No receipt yet')
export function ProgramReadiness({ workspace }: { workspace: string }) {
  const [open, setOpen] = useState(false)
  const report = useRpc(
    'program-readiness:' + workspace,
    async () => {
      const { data, error } = await requireSupabaseClient().rpc('workspace_program_readiness', {
        p_workspace: workspace,
      })
      if (error) throw new Error('Readiness could not load.')
      return data as Readiness
    },
    { enabled: open },
  )
  const r = report.data
  return (
    <section className="mc-panel">
      <button
        className="mc-btn mc-btn-secondary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Check program readiness
      </button>
      {open && (
        <>
          {report.error && <p role="alert">{report.error}</p>}
          {report.loading && <p role="status">Checking program…</p>}
          {r && (
            <>
              <dl>
                <dt>Published terms</dt>
                <dd>{r.published ? 'Published' : 'Awaiting publication'}</dd>
                <dt>Merchant Stripe connection</dt>
                <dd>{r.stripe_connected ? 'Connected' : 'Connect Stripe in Connections'}</dd>
                <dt>Commission funding</dt>
                <dd>
                  {r.available_minor == null
                    ? 'No funding account yet'
                    : new Intl.NumberFormat(undefined, {
                        style: 'currency',
                        currency: r.currency,
                      }).format(r.available_minor / 100)}
                </dd>
                <dt>Creator payouts</dt>
                <dd>{r.payouts_enabled ? 'Enabled' : 'Awaiting platform activation'}</dd>
                <dt>Latest observed creator click</dt>
                <dd>{at(r.last_click)}</dd>
                <dt>Latest attributed sale</dt>
                <dd>{at(r.last_sale)}</dd>
              </dl>
              {r.slug && r.published && (
                <p>
                  <a href={inviteLink(r.slug)} target="_blank" rel="noreferrer">
                    Open invitation
                  </a>{' '}
                  {r.destination && (
                    <a href={r.destination} target="_blank" rel="noreferrer">
                      Open customer destination
                    </a>
                  )}
                </p>
              )}
              {r.events?.length > 0 && (
                <table>
                  <caption>Reward event evidence in this workspace</caption>
                  <thead>
                    <tr>
                      {[
                        'Event',
                        'Latest test receipt',
                        'Latest production receipt',
                        'Latest qualifying reward',
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.events.map((e) => (
                      <tr key={e.key}>
                        <th>
                          {e.label} · {e.key}
                        </th>
                        <td>{at(e.test_at)}</td>
                        <td>{at(e.live_at)}</td>
                        <td>{at(e.awarded_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          <button type="button" disabled={report.loading} onClick={() => void report.refresh()}>
            Refresh evidence
          </button>
        </>
      )}
    </section>
  )
}
