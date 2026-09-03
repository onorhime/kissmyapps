import { useState, type FormEvent } from 'react'
import { CheckCircle2, ExternalLink, LoaderCircle, Pencil, Plus, Route } from 'lucide-react'
import type { AdminConfigurationGateway, AdminFunnel, AdminProductConfiguration } from '../api'
import {
  normalizeConfigurationKey,
  validateNameAndKey,
  validateOptionalProductionHttpsUrl,
} from './configurationValidation'
import type { ConfigurationActionRunner } from './actionTypes'

export function FunnelSection({
  configuration,
  gateway,
  canManage,
  pendingKey,
  runAction,
}: {
  configuration: AdminProductConfiguration
  gateway: AdminConfigurationGateway
  canManage: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
}) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [destination, setDestination] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<AdminFunnel | null>(null)
  const busy = pendingKey?.startsWith('funnel:') ?? false

  async function createFunnel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = { ...validateNameAndKey(name, key) }
    const destinationError = validateOptionalProductionHttpsUrl(destination)
    if (destinationError) nextErrors.destination = destinationError
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    const created = await runAction(
      'funnel:create',
      () =>
        gateway.createFunnel({
          productId: configuration.product.id,
          name: name.trim().replace(/\s+/g, ' '),
          key: normalizeConfigurationKey(key),
          destinationUrl: destination.trim(),
          isDefault,
        }),
      'Draft funnel created. Review it before setting it live.',
    )
    if (created) {
      setName('')
      setKey('')
      setDestination('')
      setIsDefault(false)
    }
  }

  async function updateFunnel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    const nextErrors: Record<string, string> = {}
    if (!editing.name.trim()) nextErrors.editName = 'Enter a funnel name.'
    const destinationError = validateOptionalProductionHttpsUrl(editing.destinationUrl ?? '')
    if (destinationError) nextErrors.editDestination = destinationError
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return

    const updated = await runAction(
      `funnel:update:${editing.id}`,
      () =>
        gateway.updateFunnel({
          funnelId: editing.id,
          name: editing.name.trim(),
          destinationUrl: editing.destinationUrl?.trim() ?? '',
          isDefault: editing.isDefault,
        }),
      'Funnel configuration updated.',
    )
    if (updated) setEditing(null)
  }

  function changeStatus(funnel: AdminFunnel, status: 'live' | 'paused' | 'archived') {
    return runAction(
      `funnel:status:${funnel.id}`,
      () => gateway.setFunnelStatus({ funnelId: funnel.id, status }),
      `${funnel.name} is now ${status}.`,
    )
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-funnels-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <Route size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">PROTECTED ROUTING</p>
          <h2 id="admin-funnels-title">Production funnels</h2>
          <p>
            A funnel is the production URL partner clicks land on. Destinations are admin-only —
            never accepted from a partner.
          </p>
        </div>
      </div>

      <div className="admin-config-split">
        <form className="admin-config-form" onSubmit={createFunnel} noValidate>
          <fieldset disabled={!canManage || busy}>
            <legend>Add a draft funnel</legend>
            <div className="admin-config-form-grid">
              <label className="admin-field">
                <span>Funnel name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-invalid={Boolean(errors.name)}
                />
                {errors.name && <small className="admin-field-error">{errors.name}</small>}
              </label>
              <label className="admin-field">
                <span>Funnel key</span>
                <input
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="web-checkout"
                  aria-invalid={Boolean(errors.key)}
                />
                {errors.key && <small className="admin-field-error">{errors.key}</small>}
              </label>
              <label className="admin-field admin-config-span-two">
                <span>Production destination URL (optional while draft)</span>
                <input
                  type="url"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="https://checkout.example.com/start"
                  aria-invalid={Boolean(errors.destination)}
                />
                {errors.destination ? (
                  <small className="admin-field-error">{errors.destination}</small>
                ) : (
                  <small className="admin-field-hint">
                    The live page clicks redirect to. Leave blank until it exists — a funnel cannot
                    go live without a production HTTPS destination.
                  </small>
                )}
              </label>
              <label className="admin-config-check admin-config-span-two">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(event) => setIsDefault(event.target.checked)}
                />
                Use as the product default funnel
              </label>
            </div>
            {!canManage && (
              <p className="admin-readonly-copy">
                Owner or Operations access is required to change routing.
              </p>
            )}
            <button className="admin-primary-button" type="submit">
              {pendingKey === 'funnel:create' ? (
                <LoaderCircle className="admin-spin" size={17} aria-hidden="true" />
              ) : (
                <Plus size={17} aria-hidden="true" />
              )}
              Create draft funnel
            </button>
          </fieldset>
        </form>

        <div className="admin-config-records">
          {configuration.funnels.length ? (
            configuration.funnels.map((funnel) => (
              <article className="admin-config-record" key={funnel.id}>
                <div className="admin-config-record-heading">
                  <div>
                    <h3>{funnel.name}</h3>
                    <code>{funnel.key}</code>
                  </div>
                  <span className={`admin-status-badge admin-status-${funnel.status}`}>
                    {funnel.status}
                  </span>
                </div>
                <div className="admin-config-tags">
                  {funnel.isDefault && (
                    <span>
                      <CheckCircle2 size={14} aria-hidden="true" /> Default
                    </span>
                  )}
                  <span>
                    {funnel.destinationConfigured
                      ? 'HTTPS destination configured'
                      : 'Destination missing'}
                  </span>
                </div>
                {canManage && funnel.destinationUrl && (
                  <a
                    className="admin-protected-url"
                    href={funnel.destinationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {funnel.destinationUrl}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                )}
                {editing?.id === funnel.id ? (
                  <form className="admin-inline-edit-form" onSubmit={updateFunnel} noValidate>
                    <label className="admin-field">
                      <span>Funnel name</span>
                      <input
                        value={editing.name}
                        onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        aria-invalid={Boolean(errors.editName)}
                      />
                      {errors.editName && (
                        <small className="admin-field-error">{errors.editName}</small>
                      )}
                    </label>
                    <label className="admin-field">
                      <span>Production destination URL (optional while draft)</span>
                      <input
                        type="url"
                        value={editing.destinationUrl ?? ''}
                        onChange={(event) =>
                          setEditing({ ...editing, destinationUrl: event.target.value })
                        }
                        aria-invalid={Boolean(errors.editDestination)}
                      />
                      {errors.editDestination && (
                        <small className="admin-field-error">{errors.editDestination}</small>
                      )}
                    </label>
                    <label className="admin-config-check">
                      <input
                        type="checkbox"
                        checked={editing.isDefault}
                        onChange={(event) =>
                          setEditing({ ...editing, isDefault: event.target.checked })
                        }
                      />
                      Use as default
                    </label>
                    <div className="admin-record-actions">
                      <button className="admin-primary-button" type="submit">
                        Save routing
                      </button>
                      <button
                        className="admin-secondary-button"
                        type="button"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : canManage && funnel.status !== 'live' && funnel.status !== 'archived' ? (
                  <div className="admin-record-actions">
                    <button
                      className="admin-secondary-button"
                      type="button"
                      onClick={() => setEditing(funnel)}
                    >
                      <Pencil size={15} aria-hidden="true" /> Edit
                    </button>
                    <button
                      className="admin-primary-button"
                      type="button"
                      disabled={!funnel.destinationConfigured || busy}
                      onClick={() => void changeStatus(funnel, 'live')}
                    >
                      Set live
                    </button>
                    <button
                      className="admin-text-button admin-danger-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void changeStatus(funnel, 'archived')}
                    >
                      Archive
                    </button>
                  </div>
                ) : canManage && funnel.status === 'live' ? (
                  <div className="admin-record-actions">
                    <button
                      className="admin-secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void changeStatus(funnel, 'paused')}
                    >
                      Pause routing
                    </button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <div className="admin-config-empty">
              <Route size={25} aria-hidden="true" />
              <h3>No funnels configured</h3>
              <p>
                Add the real production HTTPS destination when it is ready. No sample route is
                shown.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
