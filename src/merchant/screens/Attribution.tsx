import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, ExternalLink, LoaderCircle, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { Attribution, AttributionPatch, Project, Role, SubdomainCheck } from '../api'
import {
  CURRENCIES,
  androidIntentFilter,
  associatedDomains,
  fingerprintList,
  kmaDomain,
  liveHosts,
  subdomainOf,
  suggestedSubdomain,
  validFingerprint,
} from '../attribution'
import { formatAgo } from '../format'
import { href } from '../routes'
import type { AttributionSection } from '../routes'
import { canDo, useStore } from '../store'
import {
  CodeBlock,
  CopyButton,
  ErrorNote,
  Field,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'
import { SettingsRow } from './Settings'

const MAX_CUSTOM_DOMAINS = 5

function useAction() {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : 'That did not work.'
      setError(message)
      notify(message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

type Props = {
  project: Project
  view: Attribution
  role?: Role
  onChange: () => Promise<void>
}

export function AttributionScreen({
  project,
  section,
}: {
  project: Project
  section: AttributionSection
}) {
  const { workspace } = useStore()
  const role = workspace?.role
  const state = useRpc(`attribution:${project.id}`, () => api.attribution(project.id))
  const view = state.data
  const on = view?.enabled ?? project.attribution_enabled ?? false

  return (
    <div className="mc-page">
      <PageHeader
        title={section === 'settings' && on ? 'Attribution settings' : 'Attribution'}
        description={`Which links, ads and partners bring the people who install ${project.name} and sign up.`}
      />
      {on && (
        <nav className="mc-tabs" aria-label="Attribution">
          {(
            [
              ['setup', 'Setup'],
              ['settings', 'Settings'],
            ] as const
          ).map(([value, label]) => (
            <a
              key={value}
              href={href({ name: 'attribution', projectId: project.id, section: value })}
              aria-current={value === section ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      )}
      {state.error && !view ? (
        <ErrorNote message={state.error} onRetry={() => void state.refresh()} />
      ) : !view ? (
        <div className="mc-install" aria-busy="true">
          <Skeleton width="100%" height={320} />
          <Skeleton width="100%" height={200} />
        </div>
      ) : !view.enabled ? (
        <TurnOn project={project} view={view} role={role} onChange={state.refresh} />
      ) : section === 'settings' ? (
        <AttributionSettings project={project} view={view} role={role} onChange={state.refresh} />
      ) : (
        <Setup project={project} view={view} role={role} onChange={state.refresh} />
      )}
    </div>
  )
}

// Turning it on ----------------------------------------------------------------------------------

function TurnOn({ project, view, role, onChange }: Props) {
  const { refreshContext, notify } = useStore()
  const canTurnOn = canDo(role, 'admin')
  const [label, setLabel] = useState(() => suggestedSubdomain(project.name))
  const [check, setCheck] = useState<SubdomainCheck | null>(null)
  const action = useAction()
  const typed = label.trim().toLowerCase()
  const current = check?.subdomain === typed ? check : null

  // Ask whether the name is free once typing pauses.
  useEffect(() => {
    if (view.ever_enabled || !typed) return
    let stale = false
    const timer = window.setTimeout(() => {
      api
        .checkSubdomain(project.id, typed)
        .then((result) => {
          if (!stale) setCheck(result)
        })
        .catch(() => {
          if (!stale) setCheck(null)
        })
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [project.id, typed, view.ever_enabled])

  const turnOn = (event: FormEvent) => {
    event.preventDefault()
    void action.run(async () => {
      await api.enableAttribution(project.id, view.ever_enabled ? null : typed)
      await Promise.all([onChange(), refreshContext()])
      notify('Attribution is on')
    })
  }

  if (view.ever_enabled) {
    const host = kmaDomain(view)?.host
    return (
      <section className="mc-panel mc-attr-off" aria-labelledby="mc-attr-off-title">
        <div className="mc-panel-head">
          <div>
            <h2 id="mc-attr-off-title">Attribution is off for {project.name}</h2>
            <p>
              {host ? `Links on ${host} show that they are turned off. ` : ''}
              Your apps, website and domains are kept, so turning it on again carries on where you
              left off.
            </p>
          </div>
        </div>
        {canTurnOn ? (
          <form onSubmit={turnOn} className="mc-form-actions is-start">
            <button type="submit" className="mc-btn mc-btn-primary" disabled={action.busy}>
              Turn attribution on again
            </button>
          </form>
        ) : (
          <p className="mc-muted">A workspace owner or admin can turn it on again.</p>
        )}
      </section>
    )
  }

  const problem = typed && current && !current.available ? current.reason : null
  return (
    <div className="mc-install mc-attr-layout">
      <div className="mc-attr-main">
        <form className="mc-panel" onSubmit={turnOn} noValidate aria-labelledby="mc-attr-on-title">
          <div className="mc-panel-head">
            <div>
              <h2 id="mc-attr-on-title">Turn on attribution for {project.name}</h2>
              <p>
                {project.name} gets its own link address, and the files Apple and Android check
                before a link may open your app. Smart links, install matching and reports come
                next, on the same address.
              </p>
            </div>
          </div>
          <Field
            label="Link address"
            hint={
              problem
                ? undefined
                : `Lowercase letters, numbers and hyphens. Links will look like ${typed || 'yourbrand'}.${view.link_root}/spring-sale.`
            }
            error={problem ?? undefined}
          >
            {(props) => (
              <div className="mc-affix">
                <input
                  {...props}
                  value={label}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canTurnOn}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <span className="mc-mono" aria-hidden="true">
                  .{view.link_root}
                </span>
              </div>
            )}
          </Field>
          <p className="mc-attr-available" aria-live="polite">
            {typed && current?.available ? (
              <>
                <Check size={16} aria-hidden="true" />
                <span>
                  <span className="mc-mono">{current.host}</span> is free.
                </span>
              </>
            ) : null}
          </p>
          {canTurnOn ? (
            <div className="mc-form-actions is-start">
              <button
                type="submit"
                className="mc-btn mc-btn-primary"
                disabled={!current?.available || action.busy}
              >
                {action.busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
                Turn on attribution
              </button>
            </div>
          ) : (
            <p className="mc-muted">Only a workspace owner or admin can turn attribution on.</p>
          )}
        </form>
        <StepList project={project} view={null} />
      </div>
      <aside className="mc-install-rail" aria-label="How attribution works">
        <HowItWorks />
      </aside>
    </div>
  )
}

function HowItWorks() {
  return (
    <section className="mc-panel" aria-labelledby="mc-attr-how">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-attr-how">How it works</h2>
        </div>
      </div>
      <ol className="mc-attr-how">
        <li>
          <strong>Someone taps your link</strong>
          <span className="mc-muted">in an ad, a post or a creator's bio. We note the tap.</span>
        </li>
        <li>
          <strong>They install or sign up</strong>
          <span className="mc-muted">from the App Store, Google Play or your website.</span>
        </li>
        <li>
          <strong>We match the two</strong>
          <span className="mc-muted">
            when your app or site first sends events, and credit the link, ad or partner that
            brought them.
          </span>
        </li>
      </ol>
    </section>
  )
}

// Setup ------------------------------------------------------------------------------------------

const LATER_STEPS: Array<{ key: string; title: string; text: string; ios?: boolean }> = [
  {
    key: 'sdk',
    title: 'SDK and a test device',
    text: 'Update the SDK, tap a test link on your phone, and watch the install arrive.',
  },
  {
    key: 'conversions',
    title: 'Conversions and revenue',
    text: 'Choose the events that count, such as a sign-up or a purchase, and their revenue.',
  },
  {
    key: 'partners',
    title: 'Ad partners',
    text: 'Connect Meta and TikTok so their ads are credited with the installs they bring.',
  },
  {
    key: 'skan',
    title: 'SKAdNetwork',
    text: "Apple's private install counts for iPhone ads, for people who do not allow tracking.",
    ios: true,
  },
]

function StepList({ project, view }: { project: Project; view: Attribution | null }) {
  const later = LATER_STEPS.filter((step) => !step.ios || project.platforms.includes('ios'))
  return (
    <section className="mc-panel" aria-labelledby="mc-attr-plan">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-attr-plan">{view ? 'Coming next' : 'What you will set up'}</h2>
          {!view && <p>The first two steps are ready now; the rest arrive with links.</p>}
        </div>
      </div>
      <ol className="mc-check-list mc-attr-plan">
        {!view && (
          <>
            <li>
              <span className="mc-status-dot is-on" aria-hidden="true" />
              <span className="mc-attr-plan-text">
                <strong>Your apps and website</strong>
              </span>
              <span className="mc-muted">Ready now</span>
            </li>
            <li>
              <span className="mc-status-dot is-on" aria-hidden="true" />
              <span className="mc-attr-plan-text">
                <strong>Link domain</strong>
              </span>
              <span className="mc-muted">Ready now</span>
            </li>
          </>
        )}
        {later.map((step) => (
          <li key={step.key}>
            <span className="mc-status-dot" aria-hidden="true" />
            <span className="mc-attr-plan-text">
              <strong>{step.title}</strong>
              {view && <span className="mc-muted">{step.text}</span>}
            </span>
            <span className="mc-muted">Coming soon</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Setup({ project, view, role, onChange }: Props) {
  const done = [view.setup.apps, view.setup.domain].filter(Boolean).length
  return (
    <div className="mc-install mc-attr-layout">
      <div className="mc-attr-main">
        <div className="mc-attr-progress">
          <p>
            <strong>{done} of 2 steps done</strong>
            <span className="mc-muted">
              {done === 2
                ? ' · Your link domain is ready for the next release.'
                : ' · Both can be set up now.'}
            </span>
          </p>
          <span className="mc-meter" aria-hidden="true">
            <span style={{ width: `${(done / 2) * 100}%` }} />
          </span>
        </div>
        <Step number={1} title="Your apps and website" done={view.setup.apps}>
          <AppsForm project={project} view={view} role={role} onChange={onChange} />
        </Step>
        <Step number={2} title="Link domain" done={view.setup.domain}>
          <Domains project={project} view={view} role={role} onChange={onChange} />
        </Step>
        <StepList project={project} view={view} />
      </div>
      <aside className="mc-install-rail" aria-label="What your link domain answers">
        <Answers view={view} />
      </aside>
    </div>
  )
}

function Step({
  number,
  title,
  done,
  children,
}: {
  number: number
  title: string
  done: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="mc-attr-step" aria-labelledby={id}>
      <div className="mc-attr-step-head">
        <span className={done ? 'mc-attr-mark is-done' : 'mc-attr-mark'} aria-hidden="true">
          {done ? <Check size={14} /> : number}
        </span>
        <h2 id={id}>{title}</h2>
        <Pill tone={done ? 'positive' : 'neutral'}>{done ? 'Done' : 'To do'}</Pill>
      </div>
      {children}
    </section>
  )
}

type AppFields = {
  ios_app_store_id: string
  ios_bundle_id: string
  ios_team_id: string
  android_package: string
  android_sha256: string
  web_url: string
}

function appFields(view: Attribution): AppFields {
  const s = view.settings
  return {
    ios_app_store_id: s?.ios_app_store_id ?? '',
    ios_bundle_id: s?.ios_bundle_id ?? '',
    ios_team_id: s?.ios_team_id ?? '',
    android_package: s?.android_package ?? '',
    android_sha256: (s?.android_sha256 ?? []).join('\n'),
    web_url: s?.web_url ?? '',
  }
}

function checkApps(fields: AppFields): Partial<Record<keyof AppFields, string>> {
  const errors: Partial<Record<keyof AppFields, string>> = {}
  const id = fields.ios_app_store_id.trim().replace(/^id/i, '')
  if (id && !/^\d{6,12}$/.test(id))
    errors.ios_app_store_id = 'Use the number in your App Store address, such as 1234567890.'
  if (
    fields.ios_bundle_id.trim() &&
    !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(fields.ios_bundle_id.trim())
  )
    errors.ios_bundle_id = 'A bundle ID looks like com.yourcompany.app.'
  if (fields.ios_team_id.trim() && !/^[A-Za-z0-9]{10}$/.test(fields.ios_team_id.trim()))
    errors.ios_team_id = 'A Team ID is 10 letters and numbers.'
  if (
    fields.android_package.trim() &&
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(fields.android_package.trim())
  )
    errors.android_package = 'A package name looks like com.yourcompany.app.'
  const prints = fingerprintList(fields.android_sha256)
  if (prints.some((value) => !validFingerprint(value)))
    errors.android_sha256 =
      'Each fingerprint is SHA-256: 64 hex characters, with or without colons.'
  else if (prints.length > 10) errors.android_sha256 = 'List up to 10 fingerprints.'
  const web = fields.web_url.trim()
  if (web && /^http:\/\//i.test(web)) errors.web_url = 'Use an address that starts with https://.'
  else if (web && !/^(https:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?(\/\S*)?$/i.test(web))
    errors.web_url = 'Enter a full website address, such as https://speaksix.app.'
  return errors
}

function AppsForm({ project, view, role, onChange }: Props) {
  const { notify } = useStore()
  const canEdit = canDo(role, 'developer')
  const saved = appFields(view)
  const [fields, setFields] = useState(saved)
  const [errors, setErrors] = useState<Partial<Record<keyof AppFields, string>>>({})
  const action = useAction()
  const set = (key: keyof AppFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }))
  const changed = (Object.keys(fields) as Array<keyof AppFields>).filter(
    (key) => fields[key].trim() !== saved[key].trim(),
  )
  const platforms = project.platforms
  const showIos =
    platforms.includes('ios') || Boolean(saved.ios_bundle_id || saved.ios_app_store_id)
  const showAndroid = platforms.includes('android') || Boolean(saved.android_package)
  const showWeb = platforms.includes('web') || Boolean(saved.web_url)
  const hosts = liveHosts(view)
  const iosReady = Boolean(view.settings?.ios_bundle_id && view.settings?.ios_team_id)
  const androidReady = Boolean(
    view.settings?.android_package && view.settings.android_sha256.length,
  )

  const save = (event: FormEvent) => {
    event.preventDefault()
    const found = checkApps(fields)
    setErrors(found)
    if (Object.keys(found).length) return
    const patch: AttributionPatch = {}
    for (const key of changed) {
      if (key === 'android_sha256') patch.android_sha256 = fingerprintList(fields.android_sha256)
      else patch[key] = fields[key].trim()
    }
    void action.run(async () => {
      const next = await api.updateAttribution(project.id, patch)
      setFields(appFields(next))
      await onChange()
      notify('Apps and website saved')
    })
  }

  const input = (
    key: keyof AppFields,
    extra: { placeholder?: string; mono?: boolean; inputMode?: 'numeric' } = {},
  ) =>
    function Control(props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) {
      return (
        <input
          {...props}
          value={fields[key]}
          placeholder={extra.placeholder}
          inputMode={extra.inputMode}
          className={extra.mono ? 'mc-mono' : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={!canEdit}
          onChange={(event) => set(key)(event.target.value)}
        />
      )
    }

  return (
    <form className="mc-panel" onSubmit={save} noValidate>
      {!showIos && !showAndroid && !showWeb && (
        <p className="mc-muted">
          {project.name} lists no app or website.{' '}
          <a
            className="mc-link"
            href={href({ name: 'settings', projectId: project.id, section: 'general' })}
          >
            Add its platforms in Project settings
          </a>
          .
        </p>
      )}
      <fieldset className="mc-form-stack" disabled={!canEdit}>
        {showIos && (
          <fieldset className="mc-attr-group">
            <legend>iOS app</legend>
            <div className="mc-form-grid">
              <Field
                label="App Store ID"
                hint="The number in your app's App Store address, after id."
                error={errors.ios_app_store_id}
              >
                {input('ios_app_store_id', { placeholder: '1234567890', inputMode: 'numeric' })}
              </Field>
              <Field label="Bundle ID" error={errors.ios_bundle_id}>
                {input('ios_bundle_id', { placeholder: 'com.yourcompany.app', mono: true })}
              </Field>
              <Field
                label="Team ID"
                hint="10 characters, under Membership in your Apple Developer account."
                error={errors.ios_team_id}
              >
                {input('ios_team_id', { placeholder: 'A1B2C3D4E5', mono: true })}
              </Field>
            </div>
          </fieldset>
        )}
        {showAndroid && (
          <fieldset className="mc-attr-group">
            <legend>Android app</legend>
            <Field label="Package name" error={errors.android_package}>
              {input('android_package', { placeholder: 'com.yourcompany.app', mono: true })}
            </Field>
            <Field
              label="Signing certificate fingerprints (SHA-256)"
              hint="One per line. Google Play shows them under Setup, App signing; add your upload key's too if you test builds you sign yourself."
              error={errors.android_sha256}
            >
              {(props) => (
                <textarea
                  {...props}
                  className="mc-mono"
                  rows={3}
                  value={fields.android_sha256}
                  placeholder="14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
                  spellCheck={false}
                  disabled={!canEdit}
                  onChange={(event) => set('android_sha256')(event.target.value)}
                />
              )}
            </Field>
          </fieldset>
        )}
        {showWeb && (
          <fieldset className="mc-attr-group">
            <legend>Website</legend>
            <Field
              label="Website address"
              hint="Where your link address sends people on a computer, and anyone without the app."
              error={errors.web_url}
            >
              {input('web_url', { placeholder: 'https://speaksix.app' })}
            </Field>
          </fieldset>
        )}
      </fieldset>
      {canEdit && (
        <div className="mc-form-actions">
          {action.error && (
            <p className="mc-field-error mc-attr-form-error" role="alert">
              {action.error}
            </p>
          )}
          <button
            type="submit"
            className="mc-btn mc-btn-primary"
            disabled={!changed.length || action.busy}
          >
            Save apps and website
          </button>
        </div>
      )}
      {(iosReady || androidReady) && hosts.length > 0 && (
        <div className="mc-attr-snippets">
          <h3>Then let your app open these links</h3>
          {iosReady && (
            <div>
              <p className="mc-muted">
                In Xcode, under Signing &amp; Capabilities, add Associated Domains with:
              </p>
              <CodeBlock label="Associated Domains" code={associatedDomains(hosts)} />
            </div>
          )}
          {androidReady && (
            <div>
              <p className="mc-muted">
                In AndroidManifest.xml, inside the activity that opens links:
              </p>
              <CodeBlock label="Intent filter" code={androidIntentFilter(hosts)} />
            </div>
          )}
        </div>
      )}
    </form>
  )
}

function Domains({ project, view, role, onChange }: Props) {
  const { notify, now } = useStore()
  const canEdit = canDo(role, 'developer')
  const [host, setHost] = useState('')
  const [hostError, setHostError] = useState<string>()
  const adding = useAction()
  const removing = useAction()
  const custom = view.domains.filter((domain) => domain.kind === 'custom')
  const waiting = custom.some((domain) => domain.status === 'waiting')

  // A domain goes live once a request for it reaches us; look again while one waits.
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void onChange()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [waiting, onChange])

  const add = (event: FormEvent) => {
    event.preventDefault()
    const value = host
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[/?#:].*$/, '')
      .replace(/\.$/, '')
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value)) {
      setHostError('Enter a domain such as go.yourbrand.com.')
      return
    }
    setHostError(undefined)
    void adding.run(async () => {
      await api.addDomain(project.id, value)
      setHost('')
      await onChange()
      notify(`${value} added: point its DNS here to finish`)
    })
  }

  return (
    <div className="mc-panel">
      <ul className="mc-attr-domains">
        {view.domains.map((domain) => (
          <li key={domain.id}>
            <div className="mc-attr-domain">
              <span className="mc-mono mc-truncate">{domain.host}</span>
              <span className="mc-sub">
                {domain.kind === 'kma'
                  ? 'Your KissMyApps address'
                  : domain.status === 'live'
                    ? `Your domain · went live ${formatAgo(domain.verified_at ?? domain.created_at, now)}`
                    : 'Your domain · waiting for its DNS record'}
              </span>
            </div>
            <Pill tone={domain.status === 'live' ? 'positive' : 'warning'}>
              {domain.status === 'live' ? 'Live' : 'Waiting'}
            </Pill>
            <CopyButton value={`https://${domain.host}`} label={domain.host} compact />
            {domain.kind === 'custom' && canEdit && (
              <button
                type="button"
                className="mc-icon-btn"
                aria-label={`Remove ${domain.host}`}
                disabled={removing.busy}
                onClick={() =>
                  void removing.run(async () => {
                    await api.removeDomain(domain.id)
                    await onChange()
                    notify(`${domain.host} removed`)
                  })
                }
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            )}
            {domain.status === 'waiting' && (
              <div className="mc-attr-dns">
                <p>
                  At your DNS provider, add a CNAME record for{' '}
                  <span className="mc-mono">{domain.host}</span> that points to{' '}
                  <span className="mc-mono">{view.cname_target}</span>. Once it works, open the
                  domain once and it turns live here.
                </p>
                <div className="mc-key-row">
                  <span className="mc-key-value mc-mono">{view.cname_target}</span>
                  <CopyButton value={view.cname_target} label="CNAME target" compact />
                  <a
                    className="mc-btn mc-btn-quiet"
                    href={`https://${domain.host}/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open {domain.host} <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canEdit &&
        (custom.length < MAX_CUSTOM_DOMAINS ? (
          <form onSubmit={add} noValidate>
            <div className="mc-inline-add">
              <label htmlFor="mc-attr-domain" className="sr-only">
                Your own domain
              </label>
              <input
                id="mc-attr-domain"
                value={host}
                placeholder="go.yourbrand.com"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={hostError ? true : undefined}
                aria-describedby="mc-attr-domain-hint"
                onChange={(event) => setHost(event.target.value)}
              />
              <button type="submit" className="mc-btn mc-btn-secondary" disabled={adding.busy}>
                <Plus size={16} aria-hidden="true" /> Add domain
              </button>
            </div>
            <p
              id="mc-attr-domain-hint"
              className={hostError ? 'mc-field-error' : 'mc-field-hint'}
              role={hostError ? 'alert' : undefined}
            >
              {hostError ??
                'Optional. Use a subdomain you keep for links, such as go.speaksix.app, so links carry your brand.'}
            </p>
          </form>
        ) : (
          <p className="mc-muted">
            A project can have up to {MAX_CUSTOM_DOMAINS} domains of its own.
          </p>
        ))}
    </div>
  )
}

function Answers({ view }: { view: Attribution }) {
  const host = kmaDomain(view)?.host
  const s = view.settings
  const iosApp = s?.ios_team_id && s.ios_bundle_id ? `${s.ios_team_id}.${s.ios_bundle_id}` : null
  return (
    <section className="mc-panel" aria-labelledby="mc-attr-answers">
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-attr-answers">What your address answers</h2>
          <p>Apple and Android read these files before they let a link open your app.</p>
        </div>
      </div>
      <dl className="mc-facts">
        <div>
          <dt>Address</dt>
          <dd className="mc-mono">{host ?? '—'}</dd>
        </div>
        <div>
          <dt>Apple file</dt>
          <dd>
            {iosApp ? (
              <>
                Lets <span className="mc-mono">{iosApp}</span> open links
              </>
            ) : (
              <span className="mc-muted">Add your iOS app's bundle and Team IDs</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Android file</dt>
          <dd>
            {s?.android_package && s.android_sha256.length ? (
              <>
                Lets <span className="mc-mono">{s.android_package}</span> open links
              </>
            ) : (
              <span className="mc-muted">Add your package name and a fingerprint</span>
            )}
          </dd>
        </div>
        <div>
          <dt>The address itself</dt>
          <dd>
            {s?.web_url ? (
              <>
                Opens <span className="mc-mono">{s.web_url}</span>
              </>
            ) : (
              <span className="mc-muted">Says links live here</span>
            )}
          </dd>
        </div>
      </dl>
      {host && iosApp && (
        <a
          className="mc-link"
          href={`https://${host}/.well-known/apple-app-site-association`}
          target="_blank"
          rel="noreferrer"
        >
          View the Apple file <ExternalLink size={14} aria-hidden="true" />
        </a>
      )}
    </section>
  )
}

// Settings ---------------------------------------------------------------------------------------

type Windows = {
  click_lookback_days: string
  view_lookback_hours: string
  reengagement_days: string
  reattribution_days: string
}

const WINDOW_LIMITS: Record<keyof Windows, [number, number, string]> = {
  click_lookback_days: [1, 30, 'The click window is 1 to 30 days.'],
  view_lookback_hours: [1, 168, 'The view window is 1 to 168 hours.'],
  reengagement_days: [1, 90, 'The re-engagement window is 1 to 90 days.'],
  reattribution_days: [1, 365, 'The reinstall window is 1 to 365 days.'],
}

function windowsOf(view: Attribution): Windows {
  const s = view.settings
  return {
    click_lookback_days: String(s?.click_lookback_days ?? 7),
    view_lookback_hours: String(s?.view_lookback_hours ?? 24),
    reengagement_days: String(s?.reengagement_days ?? 30),
    reattribution_days: String(s?.reattribution_days ?? 90),
  }
}

function AttributionSettings({ project, view, role, onChange }: Props) {
  const { notify, refreshContext } = useStore()
  const canEdit = canDo(role, 'developer')
  const isAdmin = canDo(role, 'admin')
  const saved = windowsOf(view)
  const [windows, setWindows] = useState(saved)
  const [views, setViews] = useState(view.settings?.view_through_enabled ?? false)
  const [errors, setErrors] = useState<Partial<Record<keyof Windows, string>>>({})
  const [currency, setCurrency] = useState(view.settings?.currency ?? 'USD')
  const [label, setLabel] = useState(subdomainOf(view))
  const [confirmOff, setConfirmOff] = useState(false)
  const windowsAction = useAction()
  const currencyAction = useAction()
  const rename = useAction()
  const off = useAction()
  const windowsChanged =
    (Object.keys(windows) as Array<keyof Windows>).some((key) => windows[key] !== saved[key]) ||
    views !== (view.settings?.view_through_enabled ?? false)
  const host = kmaDomain(view)?.host

  const saveWindows = (event: FormEvent) => {
    event.preventDefault()
    const found: Partial<Record<keyof Windows, string>> = {}
    const patch: AttributionPatch = { view_through_enabled: views }
    for (const key of Object.keys(windows) as Array<keyof Windows>) {
      const [min, max, message] = WINDOW_LIMITS[key]
      const value = Number(windows[key])
      if (!/^\d+$/.test(windows[key].trim()) || value < min || value > max) found[key] = message
      else patch[key] = value
    }
    setErrors(found)
    if (Object.keys(found).length) return
    void windowsAction.run(async () => {
      const next = await api.updateAttribution(project.id, patch)
      setWindows(windowsOf(next))
      await onChange()
      notify('Attribution windows saved')
    })
  }

  const windowField = (key: keyof Windows, label: string, hint: string, disabled = false) => (
    <Field label={label} hint={hint} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          type="number"
          inputMode="numeric"
          min={WINDOW_LIMITS[key][0]}
          max={WINDOW_LIMITS[key][1]}
          value={windows[key]}
          disabled={!canEdit || disabled}
          onChange={(event) => setWindows((current) => ({ ...current, [key]: event.target.value }))}
        />
      )}
    </Field>
  )

  return (
    <>
      <SettingsRow
        title="Attribution windows"
        description={
          <>
            <p>
              How long after someone taps a link, or sees an ad, an install still counts for it.
            </p>
            <p>They apply once links and matching arrive in the next release.</p>
          </>
        }
      >
        <form className="mc-panel" onSubmit={saveWindows} noValidate>
          <fieldset className="mc-form-grid" disabled={!canEdit}>
            {windowField('click_lookback_days', 'Click window, in days', 'The usual is 7.')}
            {windowField(
              'reengagement_days',
              'Re-engagement window, in days',
              'An app opened from a link within this time counts for the link.',
            )}
            {windowField(
              'reattribution_days',
              'Reinstall window, in days',
              'A reinstall within this time is the same user, not a new install.',
            )}
            {windowField(
              'view_lookback_hours',
              'View window, in hours',
              views ? 'The usual is 24.' : 'Used when ad views count.',
              !views,
            )}
          </fieldset>
          <label className="mc-check">
            <input
              type="checkbox"
              checked={views}
              disabled={!canEdit}
              onChange={(event) => setViews(event.target.checked)}
            />
            <span>
              Count ad views
              <span className="mc-sub">
                Credit an ad someone saw but did not tap, when no link was tapped.
              </span>
            </span>
          </label>
          {canEdit && (
            <div className="mc-form-actions">
              <button
                type="submit"
                className="mc-btn mc-btn-primary"
                disabled={!windowsChanged || windowsAction.busy}
              >
                Save windows
              </button>
            </div>
          )}
        </form>
      </SettingsRow>

      <SettingsRow
        title="Revenue currency"
        description="Revenue and return on ad spend are shown in this currency."
      >
        <div className="mc-panel">
          <fieldset className="mc-form-stack" disabled={!canEdit}>
            <Select
              label="Currency"
              value={currency}
              onChange={setCurrency}
              options={
                CURRENCIES.some((item) => item.value === currency)
                  ? CURRENCIES
                  : [{ value: currency, label: currency }, ...CURRENCIES]
              }
            />
          </fieldset>
          {canEdit && (
            <div className="mc-form-actions">
              <button
                type="button"
                className="mc-btn mc-btn-primary"
                disabled={currency === (view.settings?.currency ?? 'USD') || currencyAction.busy}
                onClick={() =>
                  void currencyAction.run(async () => {
                    await api.updateAttribution(project.id, { currency })
                    await onChange()
                    notify('Currency saved')
                  })
                }
              >
                Save currency
              </button>
            </div>
          )}
        </div>
      </SettingsRow>

      {isAdmin && (
        <SettingsRow
          title="Link address"
          description="Renaming it moves your links and app files to the new address at once."
        >
          <form
            className="mc-panel"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const next = label.trim().toLowerCase()
              void rename.run(async () => {
                await api.setSubdomain(project.id, next)
                await onChange()
                notify(`Your link address is now ${next}.${view.link_root}`)
              })
            }}
          >
            <Field label="Link address" error={rename.error}>
              {(props) => (
                <div className="mc-affix">
                  <input
                    {...props}
                    value={label}
                    maxLength={40}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  <span className="mc-mono" aria-hidden="true">
                    .{view.link_root}
                  </span>
                </div>
              )}
            </Field>
            {label.trim().toLowerCase() !== subdomainOf(view) && (
              <p className="mc-warning-text mc-attr-warning">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>
                  Links on {host} stop working, and your apps need the new address in their
                  Associated Domains and intent filter.
                </span>
              </p>
            )}
            <div className="mc-form-actions">
              <button
                type="submit"
                className="mc-btn mc-btn-secondary"
                disabled={label.trim().toLowerCase() === subdomainOf(view) || rename.busy}
              >
                Rename address
              </button>
            </div>
          </form>
        </SettingsRow>
      )}

      {isAdmin && (
        <SettingsRow
          title="Turn off attribution"
          description="Links on your domains stop working. Your apps, website and domains are kept, so you can turn it on again and carry on."
        >
          <div className="mc-panel mc-danger-panel">
            {!confirmOff ? (
              <button
                type="button"
                className="mc-btn mc-btn-danger"
                onClick={() => setConfirmOff(true)}
              >
                Turn off attribution
              </button>
            ) : (
              <div className="mc-form-stack">
                <p className="mc-warning-text">
                  <TriangleAlert size={16} aria-hidden="true" /> Links for {project.name} stop
                  working until it is on again.
                </p>
                <div className="mc-form-actions">
                  <button
                    type="button"
                    className="mc-btn mc-btn-secondary"
                    onClick={() => setConfirmOff(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="mc-btn mc-btn-danger-solid"
                    disabled={off.busy}
                    onClick={() =>
                      void off.run(async () => {
                        await api.disableAttribution(project.id)
                        await Promise.all([onChange(), refreshContext()])
                        notify('Attribution is off')
                      })
                    }
                  >
                    Turn off
                  </button>
                </div>
              </div>
            )}
          </div>
        </SettingsRow>
      )}
    </>
  )
}
