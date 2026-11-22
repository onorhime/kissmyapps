import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { useRpc } from '../ui/useRpc'

export function AdAccounts({ project, canManage }: { project: string; canManage: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mc-panel">
      <button
        className="mc-btn mc-btn-secondary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Ad accounts
      </button>
      {open && <AccountsForm key={project} project={project} canManage={canManage} />}
    </section>
  )
}
function AccountsForm({ project, canManage }: { project: string; canManage: boolean }) {
  const accounts = useRpc('ad-accounts:' + project, () => api.adAccounts(project))
  const [provider, setProvider] = useState('meta'),
    [id, setId] = useState(''),
    [currency, setCurrency] = useState('USD'),
    [token, setToken] = useState('')
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  async function update(action: () => Promise<void>, success: string) {
    setBusy(true)
    setMessage('')
    try {
      await action()
      setToken('')
      setMessage(success)
      accounts.refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not update the connection.')
    } finally {
      setBusy(false)
    }
  }
  function connect(e: FormEvent) {
    e.preventDefault()
    void update(
      () => api.connectAds(project, provider, id.trim(), currency, token),
      'Connection saved. The next scheduled import will check it.',
    )
  }
  return (
    <>
      <p>
        Import campaign spend from Meta Ads and TikTok Ads. Each run reconciles the last seven
        completed days. Manual entries and CSV uploads take priority on matching rows.
      </p>
      {accounts.error && (
        <p role="alert">
          {accounts.error}{' '}
          <button type="button" onClick={accounts.refresh}>
            Retry
          </button>
        </p>
      )}
      {accounts.data?.length === 0 && <p>No advertiser connected.</p>}
      {accounts.data?.map((a) => (
        <div key={a.provider}>
          <strong>
            {a.provider === 'meta' ? 'Meta Ads' : 'TikTok Ads'} · {a.account_id}
          </strong>
          <p>
            {!a.enabled
              ? 'Disconnected'
              : a.last_error
                ? 'Last import failed: ' + a.last_error.replaceAll('_', ' ')
                : a.last_success
                  ? 'Last import ' + new Date(a.last_success).toLocaleString()
                  : 'Waiting for the first import'}
          </p>
          {canManage && a.enabled && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void update(
                  () => api.disconnectAds(project, a.provider),
                  'Connection removed. Imported spend is still available.',
                )
              }
            >
              Disconnect {a.provider}
            </button>
          )}
        </div>
      ))}
      {canManage && (
        <form className="mc-ad-account-form" onSubmit={connect}>
          <label>
            Ad network{' '}
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                setToken('')
                setId('')
              }}
            >
              <option value="meta">Meta Ads</option>
              <option value="tiktok">TikTok Ads</option>
            </select>
          </label>
          <label>
            Advertiser ID{' '}
            <input
              required
              inputMode="numeric"
              pattern="[0-9]{1,40}"
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            Account billing currency{' '}
            <input
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
          <label>
            Reporting access token{' '}
            <input
              required
              type="password"
              minLength={10}
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
            Save connection
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </>
  )
}
