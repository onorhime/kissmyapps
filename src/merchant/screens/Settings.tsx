import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { KeyRound, Plus, Trash2, TriangleAlert, UserPlus } from 'lucide-react'
import type {
  ApiEnvironment,
  ApiKey,
  ApiKeyKind,
  MemberRole,
  Platform,
  Project,
} from '../data/sample'
import { timezones } from '../data/sample'
import { formatLongDate } from '../format'
import { href, navigate } from '../routes'
import type { SettingsSection } from '../routes'
import { useStore } from '../store'
import { CopyButton, Dialog, Field, PageHeader, Pill, Segmented, Select } from '../ui/Primitives'
import { PlatformChoices } from './Projects'

const sections: Array<{ value: SettingsSection; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'keys', label: 'API keys' },
  { value: 'members', label: 'Members' },
]

function SettingsRow({
  title,
  description,
  children,
}: {
  title: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mc-settings-row">
      <div className="mc-settings-label">
        <h2>{title}</h2>
        <div className="mc-muted">{description}</div>
      </div>
      <div className="mc-settings-panel">{children}</div>
    </section>
  )
}

function General({ project }: { project: Project }) {
  const { updateProject, deleteProject, notify } = useStore()
  const [name, setName] = useState(project.name)
  const [timezone, setTimezone] = useState(project.timezone)
  const [platforms, setPlatforms] = useState<Platform[]>(project.platforms)
  const [detailsError, setDetailsError] = useState<{ name?: string; platforms?: string }>({})
  const [savedDetails, setSavedDetails] = useState(false)
  const [origins, setOrigins] = useState(project.allowedOrigins)
  const [origin, setOrigin] = useState('')
  const [originError, setOriginError] = useState<string>()
  const [savedOrigins, setSavedOrigins] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [typed, setTyped] = useState('')
  const detailsChanged =
    name !== project.name ||
    timezone !== project.timezone ||
    platforms.join() !== project.platforms.join()
  const originsChanged = origins.join() !== project.allowedOrigins.join()

  const saveDetails = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      name: name.trim() ? undefined : 'A project needs a name.',
      platforms: platforms.length ? undefined : 'Keep at least one platform.',
    }
    setDetailsError(next)
    if (next.name || next.platforms) return
    updateProject(project.id, { name: name.trim(), timezone, platforms })
    setSavedDetails(true)
  }

  const addOrigin = () => {
    const value = origin
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(value)) {
      setOriginError('Enter a domain such as speaksix.app or app.example.org.')
      return
    }
    if (origins.includes(value)) {
      setOriginError(`${value} is already on the list.`)
      return
    }
    setOriginError(undefined)
    setOrigins([...origins, value])
    setOrigin('')
    setSavedOrigins(false)
  }

  return (
    <>
      <SettingsRow
        title="Project details"
        description="The name shows across your workspace. Reports count days in the reporting time zone."
      >
        <form className="mc-panel" onSubmit={saveDetails} noValidate>
          <div className="mc-form-stack">
            <Field label="Project name" error={detailsError.name}>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setSavedDetails(false)
                  }}
                />
              )}
            </Field>
            <Select
              label="Reporting time zone"
              value={timezone}
              options={timezones}
              onChange={(value) => {
                setTimezone(value)
                setSavedDetails(false)
              }}
            />
            <PlatformChoices
              value={platforms}
              error={detailsError.platforms}
              onChange={(value) => {
                setPlatforms(value)
                setSavedDetails(false)
              }}
            />
          </div>
          <div className="mc-form-actions">
            {savedDetails && !detailsChanged && <span className="mc-saved">Saved</span>}
            <button type="submit" className="mc-btn mc-btn-primary" disabled={!detailsChanged}>
              Save details
            </button>
          </div>
        </form>
      </SettingsRow>

      <SettingsRow
        title="Project ID"
        description="Support and the HTTP API refer to the project by this ID."
      >
        <div className="mc-panel mc-key-row">
          <span className="mc-key-value mc-mono">{project.id}</span>
          <CopyButton value={project.id} label="project ID" compact />
        </div>
      </SettingsRow>

      <SettingsRow
        title="Allowed websites"
        description="Client keys used on the web only send events from these sites, so a copied key cannot fill your project with junk. Leave the list empty to accept any site."
      >
        <div className="mc-panel">
          {origins.length ? (
            <ul className="mc-origin-list">
              {origins.map((item) => (
                <li key={item}>
                  <span className="mc-mono">{item}</span>
                  <button
                    type="button"
                    className="mc-icon-btn"
                    aria-label={`Remove ${item}`}
                    onClick={() => {
                      setOrigins(origins.filter((value) => value !== item))
                      setSavedOrigins(false)
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mc-empty-line">
              Any website can send events with this project’s client keys.
            </p>
          )}
          <div className="mc-inline-add">
            <Field label="Add a website" error={originError}>
              {(props) => (
                <input
                  {...props}
                  value={origin}
                  placeholder="app.example.org"
                  onChange={(event) => setOrigin(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addOrigin()
                    }
                  }}
                />
              )}
            </Field>
            <button type="button" className="mc-btn mc-btn-secondary" onClick={addOrigin}>
              <Plus size={16} aria-hidden="true" />
              Add
            </button>
          </div>
          <div className="mc-form-actions">
            {savedOrigins && !originsChanged && <span className="mc-saved">Saved</span>}
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              disabled={!originsChanged}
              onClick={() => {
                updateProject(project.id, { allowedOrigins: origins })
                setSavedOrigins(true)
              }}
            >
              Save websites
            </button>
          </div>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Delete project"
        description="Deletes every event, key and chart in this project. Apps still using its keys will have their events refused."
      >
        <div className="mc-panel mc-danger-panel">
          {confirmDelete ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (typed !== project.name) return
                deleteProject(project.id)
                notify(`${project.name} was deleted.`)
                navigate({ name: 'projects' })
              }}
            >
              <p>
                <TriangleAlert size={16} aria-hidden="true" /> This cannot be undone. Type{' '}
                <strong>{project.name}</strong> to confirm.
              </p>
              <Field label="Project name">
                {(props) => (
                  <input
                    {...props}
                    value={typed}
                    autoComplete="off"
                    onChange={(event) => setTyped(event.target.value)}
                  />
                )}
              </Field>
              <div className="mc-form-actions">
                <button
                  type="button"
                  className="mc-btn mc-btn-quiet"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="mc-btn mc-btn-danger-solid"
                  disabled={typed !== project.name}
                >
                  Delete {project.name}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="mc-btn mc-btn-danger"
              onClick={() => setConfirmDelete(true)}
            >
              Delete this project
            </button>
          )}
        </div>
      </SettingsRow>
    </>
  )
}

function lastUsed(key: ApiKey): string {
  if (key.lastUsedMinutesAgo === null) return 'Never'
  if (key.lastUsedMinutesAgo === 0) return 'Just now'
  if (key.lastUsedMinutesAgo < 60) return `${key.lastUsedMinutesAgo} min ago`
  if (key.lastUsedMinutesAgo < 1440) return `${Math.round(key.lastUsedMinutesAgo / 60)} h ago`
  return `${Math.round(key.lastUsedMinutesAgo / 1440)} days ago`
}

/** Client keys are safe to show, but the table only needs enough to tell them apart. */
function shortKey(token: string) {
  const prefix = token.match(/^kma_[ps]k_(?:live|test)_/)?.[0] ?? ''
  const secret = token.slice(prefix.length)
  return secret.length > 10 ? `${prefix}${secret.slice(0, 4)}…${secret.slice(-4)}` : token
}

function maskedKey(key: ApiKey) {
  const prefix = `kma_${key.kind === 'client' ? 'pk' : 'sk'}_${key.environment === 'production' ? 'live' : 'test'}_`
  return `${prefix}••••${key.suffix}`
}

function ApiKeys({ project }: { project: Project }) {
  const { keys, createKey, revokeKey, notify } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ApiKeyKind>('client')
  const [environment, setEnvironment] = useState<ApiEnvironment>('production')
  const [nameError, setNameError] = useState<string>()
  const [created, setCreated] = useState<{ token: string; kind: ApiKeyKind; name: string } | null>(
    null,
  )
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const projectKeys = keys.filter((key) => key.projectId === project.id)
  const active = projectKeys.filter((key) => !key.revokedAt)
  const revoked = projectKeys.filter((key) => key.revokedAt)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setNameError('Name the key after where it is used, such as “iOS app” or “Billing webhooks”.')
      return
    }
    const token = createKey({ projectId: project.id, name, kind, environment })
    setCreated({ token, kind, name: name.trim() })
    setCreating(false)
    setName('')
    setNameError(undefined)
  }

  return (
    <>
      <SettingsRow
        title="Keys for this project"
        description={
          <>
            <p>Client keys go in apps and web pages. They can only send events.</p>
            <p>
              Server keys can also import history. Keep them on your servers; they are shown once.
            </p>
          </>
        }
      >
        <div className="mc-keys">
          {created && (
            <div className="mc-panel mc-reveal" role="status">
              <div className="mc-panel-head">
                <h3>
                  <KeyRound size={16} aria-hidden="true" /> {created.name} is ready
                </h3>
                <p className="mc-muted">
                  {created.kind === 'server'
                    ? 'Copy it now and store it in your server’s secrets. For your security it will not be shown again.'
                    : 'Paste it into your SDK setup. You can copy it again from the install page.'}
                </p>
              </div>
              <div className="mc-key-row">
                <span className="mc-key-value mc-mono">{created.token}</span>
                <CopyButton value={created.token} label="new key" />
              </div>
              <div className="mc-form-actions">
                <button
                  type="button"
                  className="mc-btn mc-btn-secondary"
                  onClick={() => setCreated(null)}
                >
                  {created.kind === 'server' ? 'I have stored it' : 'Done'}
                </button>
              </div>
            </div>
          )}

          {creating ? (
            <form
              className="mc-panel"
              onSubmit={submit}
              noValidate
              aria-labelledby="mc-create-key-title"
            >
              <div className="mc-panel-head">
                <h3 id="mc-create-key-title">New key</h3>
              </div>
              <div className="mc-form-stack">
                <Field label="Name" error={nameError}>
                  {(props) => (
                    <input
                      {...props}
                      value={name}
                      autoFocus
                      onChange={(event) => setName(event.target.value)}
                    />
                  )}
                </Field>
                <div className="mc-control">
                  <span className="mc-control-label">Type</span>
                  <Segmented
                    label="Key type"
                    value={kind}
                    onChange={setKind}
                    options={[
                      { value: 'client', label: 'Client key' },
                      { value: 'server', label: 'Server key' },
                    ]}
                  />
                  <p className="mc-field-hint">
                    {kind === 'client'
                      ? 'For iOS, Android, React Native, Flutter and web.'
                      : 'For your backend and the HTTP API only.'}
                  </p>
                </div>
                <div className="mc-control">
                  <span className="mc-control-label">Environment</span>
                  <Segmented
                    label="Environment"
                    value={environment}
                    onChange={setEnvironment}
                    options={[
                      { value: 'production', label: 'Production' },
                      { value: 'development', label: 'Development' },
                    ]}
                  />
                  <p className="mc-field-hint">
                    {environment === 'production'
                      ? 'Events count in every report.'
                      : 'Events show in Live events but stay out of reports.'}
                  </p>
                </div>
              </div>
              <div className="mc-form-actions">
                <button
                  type="button"
                  className="mc-btn mc-btn-quiet"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="mc-btn mc-btn-primary">
                  Create key
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="mc-btn mc-btn-primary mc-self-start"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} aria-hidden="true" />
              New key
            </button>
          )}

          <div className="mc-panel mc-panel-flush">
            {active.length ? (
              <table className="mc-table mc-keys-table mc-stack-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Key</th>
                    <th scope="col">Environment</th>
                    <th scope="col" className="is-num">
                      Last used
                    </th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((key) => (
                    <tr key={key.id}>
                      <td>
                        <strong>{key.name}</strong>
                        <span className="mc-sub">
                          {key.kind === 'client' ? 'Client key' : 'Server key'} ·{' '}
                          {formatLongDate(key.createdAt)} by {key.createdBy}
                        </span>
                      </td>
                      <td>
                        <span className="mc-id">
                          <span className="mc-mono" title={key.token ?? undefined}>
                            {key.token ? shortKey(key.token) : maskedKey(key)}
                          </span>
                          {key.token && (
                            <CopyButton value={key.token} label={`${key.name} key`} compact />
                          )}
                        </span>
                      </td>
                      <td>
                        <Pill tone={key.environment === 'production' ? 'info' : 'neutral'}>
                          {key.environment === 'production' ? 'Production' : 'Development'}
                        </Pill>
                      </td>
                      <td className="is-num mc-num mc-muted">{lastUsed(key)}</td>
                      <td className="is-action">
                        <button
                          type="button"
                          className="mc-text-btn is-danger"
                          onClick={() => setRevoking(key)}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="mc-empty">
                <p>No active keys. Apps cannot send events until you create one.</p>
              </div>
            )}
          </div>

          {revoked.length > 0 && (
            <details className="mc-revoked">
              <summary>
                {revoked.length} revoked {revoked.length === 1 ? 'key' : 'keys'}
              </summary>
              <ul>
                {revoked.map((key) => (
                  <li key={key.id}>
                    <span>{key.name}</span>
                    <span className="mc-mono mc-muted">{maskedKey(key)}</span>
                    <span className="mc-muted mc-num">
                      Revoked {formatLongDate(key.revokedAt ?? key.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </SettingsRow>

      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'key'}?`}
        description="Anything still using this key stops sending events straight away. This cannot be undone."
      >
        {revoking && (
          <>
            <p className="mc-dialog-body">
              <span className="mc-mono">{revoking.token ?? maskedKey(revoking)}</span>
              <br />
              Last used {lastUsed(revoking).toLowerCase()}.
            </p>
            <div className="mc-form-actions">
              <button
                type="button"
                className="mc-btn mc-btn-quiet"
                onClick={() => setRevoking(null)}
              >
                Keep key
              </button>
              <button
                type="button"
                className="mc-btn mc-btn-danger-solid"
                onClick={() => {
                  revokeKey(revoking.id)
                  notify(`${revoking.name} was revoked.`)
                  setRevoking(null)
                }}
              >
                Revoke key
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  )
}

const roles: Array<{ value: MemberRole; label: string }> = [
  { value: 'Admin', label: 'Admin' },
  { value: 'Developer', label: 'Developer' },
  { value: 'Analyst', label: 'Analyst' },
]

function Members() {
  const { members, inviteMember, removeMember, setMemberRole, notify, session } = useStore()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('Developer')
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState<string | null>(null)
  const target = members.find((member) => member.id === removing)

  return (
    <>
      <SettingsRow
        title="People in your workspace"
        description={
          <ul className="mc-role-notes">
            <li>
              <strong>Admins</strong> manage everything, including keys and people.
            </li>
            <li>
              <strong>Developers</strong> manage keys, install and events.
            </li>
            <li>
              <strong>Analysts</strong> read reports and explore data.
            </li>
          </ul>
        }
      >
        <div className="mc-keys">
          <form
            className="mc-panel mc-invite"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                setError('Enter their work email.')
                return
              }
              if (members.some((member) => member.email === email.trim().toLowerCase())) {
                setError('That person is already in the workspace.')
                return
              }
              inviteMember(email.trim().toLowerCase(), role)
              notify(`Invitation sent to ${email.trim()}.`)
              setEmail('')
              setError(undefined)
            }}
          >
            <Field label="Invite by email" error={error}>
              {(props) => (
                <input
                  {...props}
                  type="email"
                  value={email}
                  placeholder="name@company.com"
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
            <Select label="Role" value={role} options={roles} onChange={setRole} />
            <button type="submit" className="mc-btn mc-btn-primary">
              <UserPlus size={16} aria-hidden="true" />
              Send invite
            </button>
          </form>
          <div className="mc-panel mc-panel-flush">
            <table className="mc-table mc-members-table mc-stack-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Last active</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <strong>
                        {member.name}
                        {member.email === session?.email ? ' (you)' : ''}
                      </strong>
                      <span className="mc-sub">{member.email}</span>
                    </td>
                    <td>
                      {member.role === 'Owner' ? (
                        <span>Owner</span>
                      ) : (
                        <Select
                          label={`Role for ${member.name}`}
                          hideLabel
                          value={member.role}
                          options={roles}
                          onChange={(value) => {
                            setMemberRole(member.id, value)
                            notify(
                              `${member.name} is now ${value === 'Admin' ? 'an' : 'a'} ${value}.`,
                            )
                          }}
                        />
                      )}
                    </td>
                    <td className="mc-muted">
                      {member.status === 'invited' ? (
                        <Pill tone="warning">Invite pending</Pill>
                      ) : (
                        member.lastActive
                      )}
                    </td>
                    <td className="is-action">
                      {member.role !== 'Owner' && (
                        <button
                          type="button"
                          className="mc-text-btn is-danger"
                          onClick={() => setRemoving(member.id)}
                        >
                          {member.status === 'invited' ? 'Cancel invite' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsRow>
      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          target?.status === 'invited'
            ? `Cancel the invite for ${target?.email}?`
            : `Remove ${target?.name}?`
        }
        description={
          target?.status === 'invited'
            ? 'The link in their email will stop working.'
            : 'They lose access to every project in this workspace straight away. Keys they created keep working.'
        }
      >
        <div className="mc-form-actions">
          <button type="button" className="mc-btn mc-btn-quiet" onClick={() => setRemoving(null)}>
            Keep
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger-solid"
            onClick={() => {
              if (target) {
                removeMember(target.id)
                notify(
                  target.status === 'invited'
                    ? `Invite for ${target.email} cancelled.`
                    : `${target.name} was removed.`,
                )
              }
              setRemoving(null)
            }}
          >
            {target?.status === 'invited' ? 'Cancel invite' : 'Remove'}
          </button>
        </div>
      </Dialog>
    </>
  )
}

export function SettingsScreen({
  project,
  section,
}: {
  project: Project
  section: SettingsSection
}) {
  return (
    <div className="mc-page">
      <PageHeader
        title={sections.find((item) => item.value === section)?.label ?? 'Settings'}
        description={
          section === 'general'
            ? `Settings for ${project.name}.`
            : section === 'keys'
              ? `Keys that let ${project.name}’s apps and servers send events.`
              : 'Everyone here can open every project in the workspace.'
        }
      />
      <nav className="mc-tabs" aria-label="Settings sections">
        {sections.map((item) => (
          <a
            key={item.value}
            href={href({ name: 'settings', projectId: project.id, section: item.value })}
            aria-current={item.value === section ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {section === 'general' && <General key={project.id} project={project} />}
      {section === 'keys' && <ApiKeys project={project} />}
      {section === 'members' && <Members />}
    </div>
  )
}
