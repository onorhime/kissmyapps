import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { FunnelJourneyConfiguration, FunnelMetricsGateway } from '../types'

/** Classifies future tracked clicks only. No financial or provider setting is changed. */
export function JourneyConfiguration({
  funnelId,
  canManage,
  gateway,
}: {
  funnelId: string
  canManage: boolean
  gateway: FunnelMetricsGateway
}) {
  const [configuration, setConfiguration] = useState<FunnelJourneyConfiguration | null>(null)
  const [environment, setEnvironment] = useState<'' | 'test' | 'live'>('')
  const [windowDays, setWindowDays] = useState('30')
  const [busy, setBusy] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [revision, setRevision] = useState(0)
  const scope = useRef(0)
  useEffect(() => {
    const current = ++scope.current
    // Clear the previous remote funnel scope while its replacement is being read.
    // eslint-disable-next-line react/set-state-in-effect
    setConfiguration(null)
    setEnvironment('')
    setLoaded(false)
    setBusy(true)
    setError('')
    setNotice('')
    setConflict(false)
    if (!gateway.getJourneyConfiguration) {
      setBusy(false)
      return
    }
    void gateway
      .getJourneyConfiguration(funnelId)
      .then((result) => {
        if (scope.current !== current) return
        if (result.status === 'ready') {
          setConfiguration(result.data)
          setEnvironment(result.data?.environment ?? '')
          setWindowDays(String(result.data?.conversionWindowDays ?? 30))
          setLoaded(true)
        } else setError(result.error?.message || 'Journey configuration could not be loaded.')
        setBusy(false)
      })
      .catch(() => {
        if (scope.current === current) {
          setError('Journey configuration could not be loaded.')
          setBusy(false)
        }
      })
    return () => {
      scope.current += 1
    }
  }, [funnelId, gateway, revision])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (
      !loaded ||
      busy ||
      !canManage ||
      !environment ||
      conflict ||
      !gateway.saveJourneyConfiguration
    )
      return
    const days = Number(windowDays)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError('Choose a reporting window from 1 to 365 days.')
      return
    }
    const current = scope.current
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await gateway.saveJourneyConfiguration({
        funnelId,
        environment,
        conversionWindowDays: days,
        ...(configuration ? { expectedUpdatedAt: configuration.updatedAt } : {}),
      })
      if (scope.current !== current) return
      if (result.data) {
        setConfiguration(result.data)
        setNotice(
          'Journey settings saved. Only future clicks use this environment; previous unclassified clicks remain excluded.',
        )
      } else {
        setError(result.error?.message || 'Journey settings could not be saved.')
        setConflict(result.error?.code === 'conflict')
      }
    } catch {
      if (scope.current === current) setError('Journey settings could not be saved. Try again.')
    } finally {
      if (scope.current === current) setBusy(false)
    }
  }
  return (
    <details className="admin-config-subpanel funnel-journey-configuration">
      <summary>Journey tracking settings</summary>
      <p>
        Choose the environment for future creator-link clicks, including visitors who leave before
        signing up. This lets EPC include those classified clicks. Historical clicks without an
        environment stay unclassified.
      </p>
      {!gateway.getJourneyConfiguration ? (
        <p role="status">Journey configuration is not available in this environment.</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {busy && !loaded && <p role="status">Loading journey settings…</p>}
          {loaded && (
            <form onSubmit={save}>
              <fieldset disabled={!canManage || busy || conflict}>
                <legend>Future click classification</legend>
                <div className="admin-config-form-grid">
                  <label className="admin-field">
                    Tracked-click environment
                    <select
                      value={environment}
                      onChange={(e) => {
                        setEnvironment(e.target.value as typeof environment)
                        setNotice('')
                      }}
                      required
                    >
                      <option value="">Choose Test or Live</option>
                      <option value="test">Test</option>
                      <option value="live">Live</option>
                    </select>
                  </label>
                  <label className="admin-field">
                    Default reporting window (days)
                    <input
                      type="number"
                      min={1}
                      max={365}
                      required
                      value={windowDays}
                      onChange={(e) => {
                        setWindowDays(e.target.value)
                        setNotice('')
                      }}
                    />
                  </label>
                </div>
                <p>
                  This reporting window does not change commission rates, commercial attribution,
                  refund cutoffs or payout eligibility. Test and Live results remain separate.
                  Checkout and payouts are not enabled here.
                </p>
                <button type="submit" className="admin-secondary-button" disabled={!environment}>
                  {busy ? 'Saving journey settings…' : 'Save journey settings'}
                </button>
              </fieldset>
            </form>
          )}
          <button
            type="button"
            className="admin-text-button"
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            Reload journey settings
          </button>
        </>
      )}
    </details>
  )
}
