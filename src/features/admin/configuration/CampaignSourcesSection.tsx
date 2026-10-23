import { useState, type FormEvent } from 'react'
import { CalendarRange, LoaderCircle, Megaphone, Plus, Tags } from 'lucide-react'
import type {
  AdminCampaign,
  AdminConfigurationGateway,
  AdminProductConfiguration,
  AdminSource,
} from '../api'
import {
  normalizeConfigurationKey,
  nullableIsoDate,
  validateCampaignDates,
  validateNameAndKey,
} from './configurationValidation'
import type { ConfigurationActionRunner } from './actionTypes'

export function CampaignSourcesSection({
  configuration,
  sources,
  gateway,
  canManage,
  pendingKey,
  runAction,
}: {
  configuration: AdminProductConfiguration
  sources: readonly AdminSource[]
  gateway: AdminConfigurationGateway
  canManage: boolean
  pendingKey: string | null
  runAction: ConfigurationActionRunner
}) {
  const [sourceName, setSourceName] = useState('')
  const [sourceKey, setSourceKey] = useState('')
  const [campaignName, setCampaignName] = useState('')
  const [campaignKey, setCampaignKey] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const busy = Boolean(pendingKey)

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validateNameAndKey(sourceName, sourceKey)
    const nextErrors: Record<string, string> = {}
    if (validation.name) nextErrors.sourceName = validation.name
    if (validation.key) nextErrors.sourceKey = validation.key
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const created = await runAction(
      'dimension:source:create',
      () =>
        gateway.createSource({
          name: sourceName.trim().replace(/\s+/g, ' '),
          key: normalizeConfigurationKey(sourceKey),
        }),
      'Source created for production tracking.',
    )
    if (created) {
      setSourceName('')
      setSourceKey('')
    }
  }

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const validation = validateNameAndKey(campaignName, campaignKey)
    const dateValidation = validateCampaignDates(startsAt, endsAt)
    const nextErrors: Record<string, string> = {}
    if (validation.name) nextErrors.campaignName = validation.name
    if (validation.key) nextErrors.campaignKey = validation.key
    if (dateValidation.startsAt) nextErrors.startsAt = dateValidation.startsAt
    if (dateValidation.endsAt) nextErrors.endsAt = dateValidation.endsAt
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    const created = await runAction(
      'dimension:campaign:create',
      () =>
        gateway.createCampaign({
          productId: configuration.product.id,
          name: campaignName.trim().replace(/\s+/g, ' '),
          key: normalizeConfigurationKey(campaignKey),
          startsAt: nullableIsoDate(startsAt),
          endsAt: nullableIsoDate(endsAt),
        }),
      'Draft campaign created.',
    )
    if (created) {
      setCampaignName('')
      setCampaignKey('')
      setStartsAt('')
      setEndsAt('')
    }
  }

  function changeCampaignStatus(
    campaign: AdminCampaign,
    status: 'active' | 'completed' | 'archived',
  ) {
    return runAction(
      `dimension:campaign:status:${campaign.id}`,
      () => gateway.setCampaignStatus({ campaignId: campaign.id, status }),
      `${campaign.name} is now ${status}.`,
    )
  }

  return (
    <section className="admin-config-section" aria-labelledby="admin-dimensions-title">
      <div className="admin-config-section-heading">
        <span className="admin-panel-icon">
          <Megaphone size={20} aria-hidden="true" />
        </span>
        <div>
          <p className="admin-eyebrow">ATTRIBUTION DIMENSIONS</p>
          <h2 id="admin-dimensions-title">Sources and campaigns</h2>
          <p>
            Labels that tag clicks for reporting. They never change where a click lands — partners
            attach them when creating link variants.
          </p>
        </div>
      </div>

      <div className="admin-config-two-columns">
        <article className="admin-config-subpanel">
          <div className="admin-subpanel-heading">
            <Tags size={18} aria-hidden="true" />
            <div>
              <h3>Global sources</h3>
              <p>
                Standard channels — TikTok, Instagram, YouTube, newsletter and more — are preloaded
                for every product. Add a custom one only if you need it. A source tags which channel
                a click came from.
              </p>
            </div>
          </div>
          <form className="admin-compact-form" onSubmit={createSource} noValidate>
            <fieldset disabled={!canManage || busy}>
              <label className="admin-field">
                <span>Source name</span>
                <input
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                  aria-invalid={Boolean(errors.sourceName)}
                />
                {errors.sourceName && (
                  <small className="admin-field-error">{errors.sourceName}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Source key</span>
                <input
                  value={sourceKey}
                  onChange={(event) => setSourceKey(event.target.value)}
                  placeholder="newsletter"
                  aria-invalid={Boolean(errors.sourceKey)}
                />
                {errors.sourceKey && (
                  <small className="admin-field-error">{errors.sourceKey}</small>
                )}
              </label>
              <button className="admin-secondary-button" type="submit">
                {pendingKey === 'dimension:source:create' ? (
                  <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}{' '}
                Add source
              </button>
            </fieldset>
          </form>
          {sources.length ? (
            <ul className="admin-simple-record-list">
              {sources.map((source) => (
                <li key={source.id}>
                  <span>
                    <strong>{source.name}</strong>
                    <code>{source.key}</code>
                  </span>
                  <span
                    className={`admin-status-badge ${source.active ? 'admin-status-active' : 'admin-status-archived'}`}
                  >
                    {source.active ? 'active' : 'archived'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="admin-config-empty admin-config-empty-small">
              <Tags size={21} aria-hidden="true" />
              <h3>No sources configured</h3>
              <p>No fallback sources are inserted.</p>
            </div>
          )}
        </article>

        <article className="admin-config-subpanel">
          <div className="admin-subpanel-heading">
            <CalendarRange size={18} aria-hidden="true" />
            <div>
              <h3>Product campaigns</h3>
              <p>
                Named pushes for this product, e.g. “launch-week”. Dates are optional reporting
                windows; campaigns stay draft until you activate them.
              </p>
            </div>
          </div>
          <form className="admin-compact-form" onSubmit={createCampaign} noValidate>
            <fieldset disabled={!canManage || busy}>
              <label className="admin-field">
                <span>Campaign name</span>
                <input
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  aria-invalid={Boolean(errors.campaignName)}
                />
                {errors.campaignName && (
                  <small className="admin-field-error">{errors.campaignName}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Campaign key</span>
                <input
                  value={campaignKey}
                  onChange={(event) => setCampaignKey(event.target.value)}
                  placeholder="launch-week"
                  aria-invalid={Boolean(errors.campaignKey)}
                />
                {errors.campaignKey && (
                  <small className="admin-field-error">{errors.campaignKey}</small>
                )}
              </label>
              <label className="admin-field">
                <span>Starts (optional)</span>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  aria-invalid={Boolean(errors.startsAt)}
                />
                {errors.startsAt && <small className="admin-field-error">{errors.startsAt}</small>}
              </label>
              <label className="admin-field">
                <span>Ends (optional)</span>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                  aria-invalid={Boolean(errors.endsAt)}
                />
                {errors.endsAt && <small className="admin-field-error">{errors.endsAt}</small>}
              </label>
              <button className="admin-secondary-button" type="submit">
                {pendingKey === 'dimension:campaign:create' ? (
                  <LoaderCircle className="admin-spin" size={16} aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}{' '}
                Create draft campaign
              </button>
            </fieldset>
          </form>
          {configuration.campaigns.length ? (
            <ul className="admin-simple-record-list">
              {configuration.campaigns.map((campaign) => (
                <li key={campaign.id}>
                  <span>
                    <strong>{campaign.name}</strong>
                    <code>{campaign.key}</code>
                  </span>
                  <span className={`admin-status-badge admin-status-${campaign.status}`}>
                    {campaign.status}
                  </span>
                  {canManage && campaign.status === 'draft' && (
                    <span className="admin-record-actions">
                      <button
                        type="button"
                        className="admin-text-button"
                        disabled={busy}
                        onClick={() => void changeCampaignStatus(campaign, 'active')}
                      >
                        Activate
                      </button>
                      <button
                        type="button"
                        className="admin-text-button admin-danger-button"
                        disabled={busy}
                        onClick={() => void changeCampaignStatus(campaign, 'archived')}
                      >
                        Archive
                      </button>
                    </span>
                  )}
                  {canManage && campaign.status === 'active' && (
                    <span className="admin-record-actions">
                      <button
                        type="button"
                        className="admin-text-button"
                        disabled={busy}
                        onClick={() => void changeCampaignStatus(campaign, 'completed')}
                      >
                        Complete
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="admin-config-empty admin-config-empty-small">
              <CalendarRange size={21} aria-hidden="true" />
              <h3>No campaigns configured</h3>
              <p>Campaigns are optional for product activation.</p>
            </div>
          )}
        </article>
      </div>
    </section>
  )
}
