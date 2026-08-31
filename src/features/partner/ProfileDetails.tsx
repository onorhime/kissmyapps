import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, Bell, Check } from 'lucide-react'
import type { PreviewProfile } from './data'
import {
  normalizeProfile,
  notificationOptions,
  partnerCategories,
  professionalChannels,
  profileCountries,
  profileCurrencies,
  profileTimezones,
  validateProfile,
} from './profileData'
import type { ProfileErrors } from './profileData'

export function ProfileDetails({
  profile,
  draft,
  onDraftChange,
  onSave,
  notify,
}: {
  profile: PreviewProfile
  draft: PreviewProfile
  onDraftChange: (value: PreviewProfile) => void
  onSave: (value: PreviewProfile) => void
  notify: (message: string) => void
}) {
  const [errors, setErrors] = useState<ProfileErrors>({})
  const refs = useRef<
    Partial<Record<keyof PreviewProfile, HTMLInputElement | HTMLTextAreaElement | null>>
  >({})
  const focusNext = useRef<keyof PreviewProfile | null>(null)
  useEffect(() => {
    const key = focusNext.current
    if (key) {
      refs.current[key]?.focus({ preventScroll: true })
      refs.current[key]?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
      focusNext.current = null
    }
  }, [errors])
  const dirty = JSON.stringify(profile) !== JSON.stringify(draft)
  const update = <K extends keyof PreviewProfile>(key: K, value: PreviewProfile[K]) =>
    onDraftChange({ ...draft, [key]: value })
  const textProps = (key: keyof PreviewProfile) => ({
    id: `profile-${key}`,
    ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      refs.current[key] = node
    },
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': errors[key] ? `profile-${key}-error` : undefined,
    autoComplete: 'off',
  })
  const error = (key: keyof PreviewProfile) =>
    errors[key] && (
      <span id={`profile-${key}-error`} className="form-error" role="alert">
        {errors[key]}
      </span>
    )
  return (
    <div className="profile-grid">
      <form
        className="panel profile-form-panel"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const next = validateProfile(draft)
          focusNext.current = (Object.keys(next)[0] as keyof PreviewProfile | undefined) ?? null
          setErrors(next)
          if (Object.keys(next).length) return
          const normalized = normalizeProfile(draft)
          onSave(normalized)
          onDraftChange(normalized)
          notify('Preview profile updated for this session. No account changes were saved.')
        }}
      >
        <div className="panel-heading">
          <div>
            <h2>Partner details</h2>
            <p>
              Use fictitious details while exploring this preview. Do not enter real personal or
              company information.
            </p>
          </div>
        </div>
        <div className="form-grid padded-form">
          <div className="form-field">
            <label htmlFor="profile-fullName">Full name</label>
            <input
              {...textProps('fullName')}
              value={draft.fullName}
              onChange={(event) => update('fullName', event.target.value)}
              maxLength={80}
              required
            />
            <span className="field-hint">Primary contact for this partnership.</span>
            {error('fullName')}
          </div>
          <div className="form-field">
            <label htmlFor="profile-publicName">Public partner name</label>
            <input
              {...textProps('publicName')}
              value={draft.publicName}
              onChange={(event) => update('publicName', event.target.value)}
              maxLength={100}
              required
            />
            {error('publicName')}
          </div>
          <label className="form-field">
            Legal entity type
            <select
              value={draft.entityType}
              onChange={(event) =>
                update('entityType', event.target.value as PreviewProfile['entityType'])
              }
            >
              <option>Individual</option>
              <option>Company</option>
            </select>
          </label>
          <div className="form-field">
            <label htmlFor="profile-legalName">Legal individual / company name</label>
            <input
              {...textProps('legalName')}
              value={draft.legalName}
              onChange={(event) => update('legalName', event.target.value)}
              maxLength={120}
              required
            />
            {error('legalName')}
          </div>
          <label className="form-field full-width">
            Primary contact email
            <input value="partner@example.invalid" readOnly />
            <span className="field-hint">
              Account email is read-only here. Real changes require account verification.
            </span>
          </label>
          <label className="form-field">
            Country
            <select
              value={draft.country}
              onChange={(event) => update('country', event.target.value)}
            >
              {profileCountries.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            Preferred timezone (preview)
            <select
              value={draft.timezone}
              onChange={(event) => update('timezone', event.target.value)}
            >
              {profileTimezones.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <span className="field-hint">
              Preference only. Reports and payout cycles remain in UTC.
            </span>
          </label>
          <label className="form-field">
            Preferred currency
            <select
              value={draft.preferredCurrency}
              onChange={(event) => update('preferredCurrency', event.target.value)}
            >
              {profileCurrencies.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <span className="field-hint">
              Preference only. Report/payout amounts remain USD; no exchange rates are applied.
            </span>
          </label>
          <label className="form-field">
            Website category
            <select
              value={draft.category}
              onChange={(event) => update('category', event.target.value)}
            >
              {partnerCategories.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <div className="form-field full-width">
            <label htmlFor="profile-website">Website</label>
            <input
              {...textProps('website')}
              value={draft.website}
              onChange={(event) => update('website', event.target.value)}
              inputMode="url"
              maxLength={200}
              placeholder="https://studio.example.invalid"
            />
            <span className="field-hint">
              Optional fictional .invalid URL. It is never opened or fetched.
            </span>
            {error('website')}
          </div>
        </div>
        <section className="profile-audience-section">
          <h3>Your audience &amp; channels</h3>
          <div className="form-grid">
            <div className="form-field full-width">
              <label htmlFor="profile-audienceDescription">Audience description</label>
              <textarea
                {...textProps('audienceDescription')}
                rows={4}
                value={draft.audienceDescription}
                maxLength={1000}
                onChange={(event) => update('audienceDescription', event.target.value)}
              />
              <span className="field-hint">
                {draft.audienceDescription.length}/1,000 characters · Fictional audience only.
              </span>
              {error('audienceDescription')}
            </div>
            <fieldset className="profile-choice-group full-width">
              <legend>Primary audience countries</legend>
              <div>
                {profileCountries.map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={draft.audienceCountries.includes(value)}
                      onChange={(event) =>
                        update(
                          'audienceCountries',
                          event.target.checked
                            ? [...draft.audienceCountries, value]
                            : draft.audienceCountries.filter((country) => country !== value),
                        )
                      }
                    />
                    <span>{value}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="profile-choice-group full-width">
              <legend>Professional channels</legend>
              <div>
                {professionalChannels.map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={draft.channels.includes(value)}
                      onChange={(event) =>
                        update(
                          'channels',
                          event.target.checked
                            ? [...draft.channels, value]
                            : draft.channels.filter((channel) => channel !== value),
                        )
                      }
                    />
                    <span>{value}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="form-field full-width">
              <label htmlFor="profile-channelDetails">Channel names / example URLs</label>
              <textarea
                {...textProps('channelDetails')}
                rows={3}
                value={draft.channelDetails}
                maxLength={1000}
                onChange={(event) => update('channelDetails', event.target.value)}
              />
              <span className="field-hint">
                Optional fictional names or .invalid URLs. Plain text only; no accounts are
                connected.
              </span>
              {error('channelDetails')}
            </div>
          </div>
        </section>
        <section className="preferences-form-section">
          <h3>Notification preferences</h3>
          <p className="profile-section-note">
            Only partnership events—no performance summaries or marketing emails. These switches do
            not send messages or change live delivery.
          </p>
          {notificationOptions.map((option) => (
            <label className="switch-row" key={option.id}>
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <input
                type="checkbox"
                aria-label={option.label}
                checked={draft.notifications[option.id]}
                onChange={(event) =>
                  update('notifications', {
                    ...draft.notifications,
                    [option.id]: event.target.checked,
                  })
                }
              />
              <span className="switch-visual" aria-hidden="true" />
            </label>
          ))}
        </section>
        <div className="form-footer">
          <span>{dirty ? 'Unsaved preview changes' : 'No unsaved preview changes'}</span>
          <div>
            <button
              type="button"
              className="button button-white"
              disabled={!dirty}
              onClick={() => {
                onDraftChange(profile)
                setErrors({})
              }}
            >
              Discard
            </button>
            <button type="submit" className="button button-green" disabled={!dirty}>
              <Check size={15} />
              Save preview changes
            </button>
          </div>
        </div>
      </form>
      <aside className="profile-aside">
        <div className="panel profile-aside-card">
          <span className="outlined-icon">
            <BadgeCheck size={22} />
          </span>
          <h3>A partnership built on trust.</h3>
          <p>
            Your public identity, contact details, commercial agreement, and payment destination are
            separate.
          </p>
          <ul>
            <li>
              <Check size={13} />
              Session-only profile preview
            </li>
            <li>
              <Check size={13} />
              Read-only agreement versions
            </li>
            <li>
              <Check size={13} />
              Protected payment changes
            </li>
          </ul>
          <p>Editing your display name does not rewrite historical agreements or statements.</p>
        </div>
        <div className="preview-note-card">
          <Bell size={19} />
          <strong>Nothing is being sent</strong>
          <p>
            Changes stay in this browser session and reset on reload. No emails, documents, or
            account updates are submitted.
          </p>
        </div>
      </aside>
    </div>
  )
}
