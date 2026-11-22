import { useState } from 'react'
import { requireSupabaseClient } from '../../lib/supabase'
import { useRpc } from '../ui/useRpc'
type Row = {
  network: string
  installs: number
  redownloads: number
  followups: number
  last_received: string
}
export function ApplePostbacks({ project }: { project: string }) {
  const [open, setOpen] = useState(false),
    [environment, setEnvironment] = useState('development')
  const endpoint =
    (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '') +
    '/functions/v1/attribution-skadnetwork'
  const report = useRpc(
    'skan:' + project + ':' + environment,
    async () => {
      const { data, error } = await requireSupabaseClient().rpc('attribution_skan_report', {
        p_project: project,
        p_environment: environment,
      })
      if (error || !Array.isArray(data)) throw new Error('Apple postbacks could not load.')
      return data as Row[]
    },
    { enabled: open },
  )
  return (
    <section className="mc-panel">
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Apple ad attribution · SKAdNetwork
      </button>
      {open && (
        <>
          <p>
            Receive aggregate counts from Apple-signed SKAdNetwork 2.1, 2.2, 3 and 4 postbacks. Set
            the App Store ID for this project in attribution settings.
          </p>
          <ol>
            <li>
              Set <code>NSAdvertisingAttributionReportEndpoint</code> in your iOS app to your own
              HTTPS domain.
            </li>
            <li>
              Accept Apple’s POST at <code>/.well-known/skadnetwork/report-attribution/</code> on
              the registrable domain. From your server, forward its original JSON by POST to{' '}
              <code>{endpoint}</code>. Use the project’s server key as a Bearer credential and set
              Content-Type to application/json.
            </li>
            <li>
              Return HTTP 200 to Apple once delivery succeeds or your server has durably queued the
              postback.
            </li>
          </ol>
          <label>
            Postback environment{' '}
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="development">Test</option>
              <option value="production">Live</option>
            </select>
          </label>
          <p>
            Last 30 days by receipt date. The first winning postback counts an install or
            redownload. Later windows appear separately.
          </p>
          {report.loading && <p role="status">Loading counts…</p>}
          {report.error && <p role="alert">{report.error}</p>}
          {!report.loading && report.data?.length === 0 && (
            <p>No verified postbacks received in this environment.</p>
          )}
          {!!report.data?.length && (
            <table>
              <thead>
                <tr>
                  {[
                    'Network',
                    'New installs',
                    'Redownloads',
                    'Later postbacks',
                    'Latest receipt',
                  ].map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.map((row) => (
                  <tr key={row.network}>
                    <td>{row.network}</td>
                    <td>{row.installs}</td>
                    <td>{row.redownloads}</td>
                    <td>{row.followups}</td>
                    <td>{new Date(row.last_received).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" disabled={report.loading} onClick={() => void report.refresh()}>
            Refresh postbacks
          </button>
        </>
      )}
    </section>
  )
}
