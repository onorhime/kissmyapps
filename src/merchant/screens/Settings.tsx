import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowRight,
  KeyRound,
  LoaderCircle,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  UserPlus,
} from 'lucide-react'
import { api } from '../api'
import type { ApiKey, KeyEnvironment, KeyKind, Members, Platform, Project, Role } from '../api'
import { ANALYTICS_ENDPOINT, SDK_URL } from '../config'
import { formatAgo, formatCount, platformLabels, plural, timeIn } from '../format'
import { href, navigate } from '../routes'
import type { ProjectSettingsSection } from '../routes'
import { canDo, useStore } from '../store'
import {
  CodeBlock,
  CopyButton,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  PageHeader,
  Pill,
  PlatformList,
  ProjectMark,
  Segmented,
  Select,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

const allPlatforms: Platform[] = ['web', 'ios', 'android', 'server']

function timezoneOptions(current?: string): Array<{ value: string; label: string }> {
  let zones: string[]
  try {
    zones = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
      'timeZone',
    )
  } catch {
    zones = ['UTC', 'Africa/Lagos', 'Europe/London', 'America/New_York', 'Asia/Kolkata']
  }
  const list = ['UTC', ...zones.filter((zone) => zone !== 'UTC')]
  if (current && !list.includes(current)) list.unshift(current)
  return list.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function PlatformChoices({
  value,
  onChange,
  error,
}: {
  value: Platform[]
  onChange: (value: Platform[]) => void
  error?: string
}) {
  return (
    <fieldset
      className={error ? 'mc-choices has-error' : 'mc-choices'}
      aria-describedby={error ? 'mc-platform-error' : undefined}
    >
      <legend>Platforms</legend>
      <div>
        {allPlatforms.map((platform) => (
          <label key={platform} className="mc-choice">
            <input
              type="checkbox"
              checked={value.includes(platform)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? allPlatforms.filter((item) => item === platform || value.includes(item))
                    : value.filter((item) => item !== platform),
                )
              }
            />
            <span>{platformLabels[platform]}</span>
          </label>
        ))}
      </div>
      {error && (
        <p id="mc-platform-error" className="mc-field-error">
          {error}
        </p>
      )}
    </fieldset>
  )
}

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

// Projects (workspace) ------------------------------------------------------------------------

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { workspace, refreshContext, notify } = useStore()
  const [name, setName] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>(['web'])
  const [timezone, setTimezone] = useState(browserTimezone)
  const [errors, setErrors] = useState<{ name?: string; platforms?: string }>({})
  const { busy, error, run } = useAction()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      name: name.trim() ? undefined : 'Name the project, usually after the app or site.',
      platforms: platforms.length ? undefined : 'Pick at least one platform.',
    }
    setErrors(next)
    if (next.name || next.platforms || !workspace) return
    void run(async () => {
      const created = await api.createProject(workspace.id, name.trim(), platforms, timezone)
      await refreshContext()
      notify(`${created.project.name} is ready with its own key`)
      onDone()
      navigate({ name: 'settings', projectId: created.project.id, section: 'install' })
    })
  }

  return (
    <form
      className="mc-panel mc-new-project"
      onSubmit={submit}
      noValidate
      aria-labelledby="mc-new-project-title"
    >
      <div className="mc-panel-head">
        <div>
          <h2 id="mc-new-project-title">New project</h2>
          <p>One project per app or website. Each gets its own API key, users and reports.</p>
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="mc-form-grid">
        <Field label="Project name" error={errors.name}>
          {(props) => (
            <input
              {...props}
              autoFocus
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="SpeakSix"
            />
          )}
        </Field>
        <Select
          label="Time zone for reports"
          value={timezone}
          onChange={setTimezone}
          options={timezoneOptions(timezone)}
        />
      </div>
      <PlatformChoices value={platforms} onChange={setPlatforms} error={errors.platforms} />
      <div className="mc-form-actions">
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
          {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
          Create project
        </button>
      </div>
    </form>
  )
}

function WorkspaceName() {
  const { workspace, refreshContext, notify } = useStore()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(workspace?.name ?? '')
  const { busy, run } = useAction()
  if (!workspace) return null
  if (!editing) {
    return canDo(workspace.role, 'admin') ? (
      <button
        type="button"
        className="mc-btn mc-btn-secondary"
        onClick={() => {
          setName(workspace.name)
          setEditing(true)
        }}
      >
        Rename workspace
      </button>
    ) : null
  }
  return (
    <form
      className="mc-inline-add"
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          await api.renameWorkspace(workspace.id, name)
          await refreshContext()
          notify('Workspace renamed')
          setEditing(false)
        })
      }}
    >
      <label htmlFor="mc-workspace-name" className="sr-only">
        Workspace name
      </label>
      <input
        id="mc-workspace-name"
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
        autoFocus
      />
      <button type="submit" className="mc-btn mc-btn-primary" disabled={busy || !name.trim()}>
        Save
      </button>
      <button type="button" className="mc-btn mc-btn-quiet" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  )
}

export function ProjectsScreen({ create = false }: { create?: boolean }) {
  const { workspace, projects, now } = useStore()
  const [adding, setAdding] = useState(create || projects.length === 0)
  const canCreate = canDo(workspace?.role, 'admin')
  return (
    <div className="mc-page">
      <PageHeader
        title="Projects"
        description={
          projects.length
            ? `${workspace?.name ?? 'Your workspace'} has ${plural(projects.length, 'project')}. Each one has its own API keys, users and reports.`
            : `Create a project for each app or website. Each one has its own API keys, users and reports.`
        }
        actions={
          <>
            <WorkspaceName />
            {canCreate && !adding && (
              <button
                type="button"
                className="mc-btn mc-btn-primary"
                onClick={() => setAdding(true)}
              >
                <Plus size={16} aria-hidden="true" /> New project
              </button>
            )}
          </>
        }
      />
      {adding && canCreate && <NewProjectForm onDone={() => setAdding(false)} />}
      {!canCreate && !projects.length && (
        <Empty>Ask an admin of {workspace?.name} to create the first project.</Empty>
      )}
      {projects.length > 0 && (
        <section className="mc-panel mc-panel-flush" aria-label="Projects">
          <table className="mc-table mc-projects-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col" className="mc-num-col">
                  Online now
                </th>
                <th scope="col" className="mc-num-col">
                  Users today
                </th>
                <th scope="col">Last event</th>
                <th scope="col">Time zone</th>
                <th scope="col">Settings</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id} className="mc-row-link">
                  <td data-label="Project">
                    <a
                      className="mc-project-cell"
                      href={href({ name: 'overview', projectId: project.id })}
                    >
                      <ProjectMark project={project} />
                      <span>
                        <strong>{project.name}</strong>
                        <PlatformList platforms={project.platforms} />
                      </span>
                    </a>
                  </td>
                  <td data-label="Online now" className="mc-num mc-num-col">
                    {formatCount(project.online_now ?? 0)}
                  </td>
                  <td data-label="Users today" className="mc-num mc-num-col">
                    {formatCount(project.users_today ?? 0)}
                  </td>
                  <td data-label="Last event">
                    {project.last_event_at ? (
                      formatAgo(
                        project.last_event_at,
                        Math.max(now, Date.parse(project.last_event_at)),
                      )
                    ) : (
                      <Pill tone="warning">Waiting for first event</Pill>
                    )}
                  </td>
                  <td data-label="Time zone">{project.timezone}</td>
                  <td data-label="Settings">
                    <a
                      className="mc-link"
                      href={href({ name: 'settings', projectId: project.id, section: 'general' })}
                    >
                      Settings
                    </a>
                    {' · '}
                    <a
                      className="mc-link"
                      href={href({ name: 'settings', projectId: project.id, section: 'keys' })}
                    >
                      Keys
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

// Members (workspace) --------------------------------------------------------------------------

const roleNotes: Record<Exclude<Role, 'owner'>, string> = {
  admin: 'Everything, including projects, members and deleting projects.',
  developer: 'Reports, API keys, install, bot rules and blocking events.',
  analyst: 'Reports only: users, sessions, replays and events.',
}

/** Opens sign-up with the invited address; the invite is accepted once that address is confirmed. */
function inviteLink(email: string): string {
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}${href({ name: 'sign-up', email, invited: true })}`
}

export function MembersScreen() {
  const { workspace, notify, now } = useStore()
  const members = useRpc(`members:${workspace?.id}`, () => api.members(workspace!.id), {
    enabled: Boolean(workspace),
  })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Exclude<Role, 'owner'>>('analyst')
  const [invalid, setInvalid] = useState<string>()
  // A change returns the new list, which wins over the loaded one for this workspace.
  const [changed, setChanged] = useState<{ workspaceId: string; members: Members }>()
  const { busy, run } = useAction()
  if (!workspace) return null
  const data = changed?.workspaceId === workspace.id ? changed.members : members.data
  const admin = canDo(data?.role ?? workspace.role, 'admin')
  const update = (action: () => Promise<Members>, message: string) =>
    run(async () => {
      setChanged({ workspaceId: workspace.id, members: await action() })
      notify(message)
    })

  return (
    <div className="mc-page">
      <PageHeader
        title="Members"
        description={`People who can open ${workspace.name}. Invited people join when they sign in with the invited email.`}
      />
      {members.error && !data && (
        <ErrorNote message={members.error} onRetry={() => void members.refresh()} />
      )}
      {admin && (
        <form
          className="mc-panel mc-invite"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
              setInvalid('Enter a valid email address.')
              return
            }
            setInvalid(undefined)
            void update(
              () => api.inviteMember(workspace.id, email.trim(), role),
              `Invited ${email.trim()}. Copy their invite link and send it to them.`,
            ).then(() => setEmail(''))
          }}
        >
          <Field
            label="Invite by email"
            error={invalid}
            hint="No email is sent: after inviting, copy their invite link and send it to them."
          >
            {(props) => (
              <input
                {...props}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@studio.com"
              />
            )}
          </Field>
          <Select
            label="Role"
            value={role}
            onChange={setRole}
            options={(['admin', 'developer', 'analyst'] as const).map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
            }))}
          />
          <button type="submit" className="mc-btn mc-btn-primary" disabled={busy}>
            <UserPlus size={16} aria-hidden="true" /> Invite
          </button>
          <p className="mc-field-hint mc-role-note">{roleNotes[role]}</p>
        </form>
      )}
      <section className="mc-panel mc-panel-flush" aria-label="Members">
        <table className="mc-table mc-members-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Last signed in</th>
              {admin && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {!data &&
              [0, 1].map((index) => (
                <tr key={index} aria-hidden="true">
                  <td>
                    <Skeleton width={180} />
                  </td>
                  <td>
                    <Skeleton width={80} />
                  </td>
                  <td>
                    <Skeleton width={80} />
                  </td>
                </tr>
              ))}
            {data?.members.map((member) => (
              <tr key={member.user_id}>
                <td data-label="Member">
                  <strong>{member.name}</strong> {member.is_you && <Pill>You</Pill>}
                  <span className="mc-sub">{member.email}</span>
                </td>
                <td data-label="Role">
                  {admin && member.role !== 'owner' && !member.is_you ? (
                    <Select
                      label={`Role of ${member.name}`}
                      hideLabel
                      value={member.role}
                      onChange={(next) =>
                        void update(
                          () => api.setMemberRole(workspace.id, member.user_id, next),
                          `${member.name} is now ${next}`,
                        )
                      }
                      options={(['admin', 'developer', 'analyst'] as const).map((value) => ({
                        value,
                        label: value[0].toUpperCase() + value.slice(1),
                      }))}
                    />
                  ) : (
                    <span className="mc-role">
                      {member.role[0].toUpperCase() + member.role.slice(1)}
                    </span>
                  )}
                </td>
                <td data-label="Last signed in">
                  {member.last_sign_in_at ? (
                    formatAgo(member.last_sign_in_at, now)
                  ) : (
                    <span className="mc-muted">—</span>
                  )}
                </td>
                {admin && (
                  <td data-label="Action">
                    {member.role !== 'owner' && !member.is_you && (
                      <button
                        type="button"
                        className="mc-text-btn is-danger"
                        disabled={busy}
                        onClick={() =>
                          void update(
                            () => api.removeMember(workspace.id, member.user_id),
                            `${member.name} removed`,
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {data?.invites.map((invite) => (
              <tr key={invite.id}>
                <td data-label="Member">
                  <strong>{invite.email}</strong> <Pill tone="warning">Invited</Pill>
                  <span className="mc-sub">Invited {formatAgo(invite.created_at, now)}</span>
                </td>
                <td data-label="Role">{invite.role[0].toUpperCase() + invite.role.slice(1)}</td>
                <td data-label="Last signed in">
                  <span className="mc-muted">Not joined yet</span>
                </td>
                {admin && (
                  <td data-label="Action">
                    <div className="mc-invite-actions">
                      <CopyButton
                        value={inviteLink(invite.email)}
                        label={`invite link for ${invite.email}`}
                        text="Copy invite link"
                      />
                      <button
                        type="button"
                        className="mc-text-btn is-danger"
                        disabled={busy}
                        onClick={() =>
                          void update(
                            () => api.cancelInvite(invite.id),
                            `Invite to ${invite.email} cancelled`,
                          )
                        }
                      >
                        Cancel invite
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <dl className="mc-role-notes">
        <div>
          <dt>Owner</dt>
          <dd>Created the workspace. Everything admins can do; cannot be removed.</dd>
        </div>
        {(Object.keys(roleNotes) as Array<keyof typeof roleNotes>).map((key) => (
          <div key={key}>
            <dt>{key[0].toUpperCase() + key.slice(1)}</dt>
            <dd>{roleNotes[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// Project settings -----------------------------------------------------------------------------

function General({ project, role }: { project: Project; role: Role }) {
  const { refreshContext, notify } = useStore()
  const [name, setName] = useState(project.name)
  const [timezone, setTimezone] = useState(project.timezone)
  const [platforms, setPlatforms] = useState<Platform[]>(project.platforms)
  const [errors, setErrors] = useState<{ name?: string; platforms?: string }>({})
  const [origins, setOrigins] = useState(project.allowed_origins)
  const [origin, setOrigin] = useState('')
  const [originError, setOriginError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [typed, setTyped] = useState('')
  const details = useAction()
  const sites = useAction()
  const replay = useAction()
  const removal = useAction()
  const canEdit = canDo(role, 'developer')
  const canDelete = canDo(role, 'admin')
  const detailsChanged =
    name !== project.name ||
    timezone !== project.timezone ||
    platforms.join() !== project.platforms.join()
  const originsChanged = origins.join() !== project.allowed_origins.join()

  const saveDetails = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      name: name.trim() ? undefined : 'A project needs a name.',
      platforms: platforms.length ? undefined : 'Keep at least one platform.',
    }
    setErrors(next)
    if (next.name || next.platforms) return
    void details.run(async () => {
      await api.updateProject(project.id, { name: name.trim(), timezone, platforms })
      await refreshContext()
      notify('Project details saved')
    })
  }

  const addOrigin = () => {
    let value = origin.trim().toLowerCase().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(value)) value = `https://${value}`
    if (!/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(value)) {
      setOriginError('Enter a website such as https://speaksix.app, without a path.')
      return
    }
    if (origins.includes(value)) {
      setOriginError(`${value} is already on the list.`)
      return
    }
    setOriginError(undefined)
    setOrigins([...origins, value])
    setOrigin('')
  }

  return (
    <>
      <SettingsRow
        title="Project details"
        description="The name shows across your workspace. Reports count days in this time zone."
      >
        <form className="mc-panel" onSubmit={saveDetails} noValidate>
          {/* Analysts see the settings but cannot change them. */}
          <fieldset className="mc-form-stack" disabled={!canEdit}>
            <Field label="Project name" error={errors.name}>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  maxLength={60}
                  disabled={!canEdit}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <Select
              label="Time zone for reports"
              value={timezone}
              onChange={setTimezone}
              options={timezoneOptions(timezone)}
            />
            <PlatformChoices value={platforms} onChange={setPlatforms} error={errors.platforms} />
          </fieldset>
          {canEdit && (
            <div className="mc-form-actions">
              <button
                type="submit"
                className="mc-btn mc-btn-primary"
                disabled={!detailsChanged || details.busy}
              >
                Save details
              </button>
            </div>
          )}
        </form>
      </SettingsRow>

      <SettingsRow
        title="Allowed websites"
        description="When the list has websites, live client keys only work on them, so nobody can send data to your project from another site. Leave it empty to allow any site. Development keys work anywhere."
      >
        <div className="mc-panel">
          {origins.length ? (
            <ul className="mc-origin-list">
              {origins.map((item) => (
                <li key={item}>
                  <span className="mc-mono">{item}</span>
                  {canEdit && (
                    <button
                      type="button"
                      className="mc-icon-btn"
                      aria-label={`Remove ${item}`}
                      onClick={() => setOrigins(origins.filter((value) => value !== item))}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mc-muted">Any website can use this project's client keys.</p>
          )}
          {canEdit && (
            <>
              <div className="mc-inline-add">
                <label htmlFor="mc-origin" className="sr-only">
                  Website address
                </label>
                <input
                  id="mc-origin"
                  value={origin}
                  placeholder="https://speaksix.app"
                  aria-invalid={originError ? true : undefined}
                  aria-describedby={originError ? 'mc-origin-error' : undefined}
                  onChange={(event) => setOrigin(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addOrigin()
                    }
                  }}
                />
                <button type="button" className="mc-btn mc-btn-secondary" onClick={addOrigin}>
                  <Plus size={16} aria-hidden="true" /> Add
                </button>
              </div>
              {originError && (
                <p id="mc-origin-error" className="mc-field-error">
                  {originError}
                </p>
              )}
              <div className="mc-form-actions">
                <button
                  type="button"
                  className="mc-btn mc-btn-primary"
                  disabled={!originsChanged || sites.busy}
                  onClick={() =>
                    void sites.run(async () => {
                      await api.updateProject(project.id, { allowed_origins: origins })
                      await refreshContext()
                      notify('Allowed websites saved')
                    })
                  }
                >
                  Save websites
                </button>
              </div>
            </>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Session replay"
        description="Records what visitors see on your website so you can watch their sessions. Every input is masked in the browser before anything is sent. Replays are kept for 30 days."
      >
        <div className="mc-panel mc-toggle-row">
          <div>
            <strong>
              {project.replay_enabled ? 'Recording website sessions' : 'Not recording'}
            </strong>
            <span className="mc-sub">Apps send events only; replays are recorded on websites.</span>
          </div>
          <label className="mc-switch">
            <input
              type="checkbox"
              role="switch"
              checked={project.replay_enabled}
              disabled={!canEdit || replay.busy}
              onChange={(event) =>
                void replay.run(async () => {
                  await api.updateProject(project.id, { replay_enabled: event.target.checked })
                  await refreshContext()
                  notify(
                    event.target.checked
                      ? 'Session replay is on'
                      : 'Session replay is off: browsers stop recording within a day',
                  )
                })
              }
            />
            <span className="sr-only">Record session replays</span>
            <span aria-hidden="true" className="mc-switch-track" />
          </label>
        </div>
      </SettingsRow>

      {canDelete && (
        <SettingsRow
          title="Delete project"
          description="Deletes its keys, users, sessions, events and replays. Apps still sending to it get an error."
        >
          <div className="mc-panel mc-danger-panel">
            {!confirmDelete ? (
              <button
                type="button"
                className="mc-btn mc-btn-danger"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={16} aria-hidden="true" /> Delete {project.name}
              </button>
            ) : (
              <form
                className="mc-form-stack"
                onSubmit={(event) => {
                  event.preventDefault()
                  void removal.run(async () => {
                    await api.deleteProject(project.id, typed)
                    notify(`${project.name} deleted`)
                    await refreshContext()
                    navigate({ name: 'home' }, true)
                  })
                }}
              >
                <p className="mc-warning-text">
                  <TriangleAlert size={16} aria-hidden="true" /> This cannot be undone.
                </p>
                <Field label={`Type ${project.name} to confirm`} error={removal.error}>
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
                    className="mc-btn mc-btn-secondary"
                    onClick={() => {
                      setConfirmDelete(false)
                      setTyped('')
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="mc-btn mc-btn-danger-solid"
                    disabled={typed !== project.name || removal.busy}
                  >
                    Delete project
                  </button>
                </div>
              </form>
            )}
          </div>
        </SettingsRow>
      )}
    </>
  )
}

function maskedKey(key: ApiKey): string {
  return key.token ?? `${key.prefix}${'•'.repeat(8)}${key.last4}`
}

function Keys({
  project,
  role,
  keys,
  onChange,
}: {
  project: Project
  role: Role
  keys: ApiKey[]
  onChange: () => Promise<void>
}) {
  const { notify, now } = useStore()
  const time = timeIn(project.timezone)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<KeyKind>('client')
  const [environment, setEnvironment] = useState<KeyEnvironment>('production')
  const [created, setCreated] = useState<(ApiKey & { token: string }) | null>(null)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const { busy, error, run } = useAction()
  const canEdit = canDo(role, 'developer')
  const active = keys.filter((key) => !key.revoked_at)
  const revoked = keys.filter((key) => key.revoked_at)

  return (
    <>
      <div className="mc-section-head">
        <p className="mc-muted">
          Client keys go in apps and web pages and can be shown again. Server keys are for your own
          servers: they can import history and are shown only once.
        </p>
        {canEdit && (
          <button
            type="button"
            className="mc-btn mc-btn-primary"
            onClick={() => {
              setName('')
              setKind('client')
              setEnvironment('production')
              setCreating(true)
            }}
          >
            <KeyRound size={16} aria-hidden="true" /> New key
          </button>
        )}
      </div>
      {created && (
        <section className="mc-panel mc-reveal" aria-labelledby="mc-reveal-title">
          <div className="mc-panel-head">
            <div>
              <h2 id="mc-reveal-title">
                {created.kind === 'server' ? 'Copy this server key now' : 'Your new key'}
              </h2>
              <p>
                {created.kind === 'server'
                  ? 'It will not be shown again. Store it in your server’s secrets.'
                  : 'You can copy it again from this page any time.'}
              </p>
            </div>
          </div>
          <div className="mc-key-row">
            <code className="mc-key-value mc-mono">{created.token}</code>
            <CopyButton value={created.token} label="key" />
          </div>
          <button
            type="button"
            className="mc-btn mc-btn-secondary mc-self-start"
            onClick={() => setCreated(null)}
          >
            I have stored it
          </button>
        </section>
      )}
      <section className="mc-panel mc-panel-flush" aria-label="Active keys">
        <table className="mc-table mc-keys-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Key</th>
              <th scope="col">Last used</th>
              <th scope="col">Created</th>
              {canEdit && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {active.map((key) => (
              <tr key={key.id}>
                <td data-label="Name">
                  <strong>{key.name}</strong>
                  <span className="mc-sub">
                    {key.kind === 'client' ? 'Client' : 'Server'} ·{' '}
                    {key.environment === 'production' ? 'Live' : 'Development'}
                  </span>
                </td>
                <td data-label="Key">
                  <span className="mc-key-row">
                    <code className="mc-mono mc-key-value">{maskedKey(key)}</code>
                    {key.token && (
                      <CopyButton value={key.token} label={`${key.name} key`} compact />
                    )}
                  </span>
                </td>
                <td data-label="Last used">
                  {key.last_used_at ? (
                    formatAgo(key.last_used_at, Math.max(now, Date.parse(key.last_used_at)))
                  ) : (
                    <span className="mc-muted">Never</span>
                  )}
                </td>
                <td data-label="Created">
                  {time.longDate(key.created_at)}
                  {key.created_by && <span className="mc-sub">by {key.created_by}</span>}
                </td>
                {canEdit && (
                  <td data-label="Action">
                    <button
                      type="button"
                      className="mc-text-btn is-danger"
                      onClick={() => setRevoking(key)}
                    >
                      Revoke
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!active.length && <Empty>No active keys. Create one to start sending events.</Empty>}
      </section>
      {revoked.length > 0 && (
        <details className="mc-revoked">
          <summary>{plural(revoked.length, 'revoked key')}</summary>
          <ul>
            {revoked.map((key) => (
              <li key={key.id}>
                <span>{key.name}</span>{' '}
                <code className="mc-mono">
                  {key.prefix}…{key.last4}
                </code>{' '}
                <span className="mc-muted">revoked {time.longDate(key.revoked_at!)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New API key"
        description={`For ${project.name}. Name it after where it will be used.`}
      >
        <form
          className="mc-form-stack"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            void run(async () => {
              const key = await api.createKey(project.id, name.trim(), kind, environment)
              setCreating(false)
              setCreated(key)
              notify(`${key.name} created`)
              await onChange()
            })
          }}
        >
          {error && <ErrorNote message={error} />}
          <Field label="Name" hint="For example: iOS app, Website, Backend import.">
            {(props) => (
              <input
                {...props}
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                autoFocus
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
          </div>
          <div className="mc-control">
            <span className="mc-control-label">Environment</span>
            <Segmented
              label="Environment"
              value={environment}
              onChange={setEnvironment}
              options={[
                { value: 'production', label: 'Live' },
                { value: 'development', label: 'Development' },
              ]}
            />
          </div>
          <p className="mc-field-hint">
            Development traffic shows in the live feed but is kept out of reports.
          </p>
          <div className="mc-form-actions">
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button type="submit" className="mc-btn mc-btn-primary" disabled={busy || !name.trim()}>
              Create key
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? ''}?`}
        description="Apps and servers using it are refused straight away. This cannot be undone."
      >
        <div className="mc-form-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            onClick={() => setRevoking(null)}
          >
            Keep key
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-danger-solid"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!revoking) return
                await api.revokeKey(revoking.id)
                notify(`${revoking.name} revoked`)
                setRevoking(null)
                await onChange()
              })
            }
          >
            Revoke key
          </button>
        </div>
      </Dialog>
    </>
  )
}

function snippets(key: string) {
  return {
    web: `<!-- In the <head> of every page -->
<script>
  window.kma = window.kma || function () { (kma.q = kma.q || []).push(arguments) }
</script>
<script async src="${SDK_URL}"
  data-key="${key}"
  data-endpoint="${ANALYTICS_ENDPOINT}"></script>`,
    identify: `// After someone signs in
kma('identify', 'user-42', { email: 'amaka@example.com', name: 'Amaka Obi', plan: 'annual' })

// Anything they do
kma('track', 'plan_selected', { plan: 'annual', price: 59.99 })

// When they sign out
kma('reset')`,
    http: `curl ${ANALYTICS_ENDPOINT}/v1/events \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "anonymous_id": "4c1f2b9e-…",
    "user_id": "user-42",
    "session": { "id": "9b2e…", "started_at": "2026-10-30T09:59:00Z" },
    "context": { "platform": "ios", "app_version": "2.4.0", "os_name": "iOS",
                 "os_version": "18.1", "device_model": "iPhone 15", "timezone": "Africa/Lagos" },
    "events": [{ "name": "lesson_completed", "insert_id": "e-1",
                 "time": "2026-10-30T10:00:00Z", "properties": { "lesson": 3 } }]
  }'`,
  }
}

/** Install steps with the project's own key filled in, and a live check that data arrives. */
export function InstallGuide({
  project,
  compact = false,
}: {
  project: Project
  compact?: boolean
}) {
  const { now, notify, workspace } = useStore()
  const settings = useRpc(`settings:${project.id}`, () => api.projectSettings(project.id))
  const status = useRpc(`status:${project.id}`, () => api.status(project.id), { pollMs: 5_000 })
  const [tab, setTab] = useState<'web' | 'apps'>(project.platforms.includes('web') ? 'web' : 'apps')
  const [sending, setSending] = useState(false)
  const keys = settings.data?.keys.filter((key) => !key.revoked_at && key.kind === 'client') ?? []
  const live = keys.find((key) => key.environment === 'production')
  const development = keys.find((key) => key.environment === 'development')
  const key = live?.token ?? development?.token ?? 'kma_pk_live_YOUR_CLIENT_KEY'
  const code = snippets(key)
  const canEdit = canDo(workspace?.role, 'developer')

  const sendTest = async () => {
    setSending(true)
    try {
      let token = development?.token
      if (!token) {
        const created = await api.createKey(project.id, 'Console tests', 'client', 'development')
        token = created.token
        void settings.refresh()
      }
      const response = await fetch(`${ANALYTICS_ENDPOINT}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          anonymous_id: 'console-test',
          traits: { name: 'Console test' },
          context: { platform: 'server', sdk: 'merchant-console' },
          events: [
            {
              name: 'test_event_sent',
              insert_id: crypto.randomUUID(),
              time: new Date().toISOString(),
              properties: { from: 'merchant console' },
            },
          ],
        }),
      })
      if (!response.ok)
        throw new Error(
          ((await response.json().catch(() => ({}))) as { message?: string }).message ??
            `The endpoint answered ${response.status}.`,
        )
      notify('Test event sent with a development key: it shows in Live events')
      void status.refresh()
    } catch (problem) {
      notify(
        problem instanceof Error
          ? `The test event failed: ${problem.message}`
          : 'The test event failed.',
      )
    } finally {
      setSending(false)
    }
  }

  const sources = status.data?.sources ?? []
  return (
    <div className={compact ? 'mc-install is-compact' : 'mc-install'}>
      <div className="mc-install-steps">
        <Segmented
          label="Where you send from"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'web', label: 'Website' },
            { value: 'apps', label: 'Apps and servers' },
          ]}
        />
        {tab === 'web' ? (
          <>
            <section aria-labelledby="mc-step-1">
              <h2 id="mc-step-1">1. Add the script</h2>
              <p className="mc-muted">
                It records sessions, page views, errors and a replay of each visit, with every input
                masked.
              </p>
              {settings.data ? (
                <CodeBlock code={code.web} label="HTML" />
              ) : (
                <Skeleton width="100%" height={120} />
              )}
            </section>
            <section aria-labelledby="mc-step-2">
              <h2 id="mc-step-2">2. Name your users and their actions</h2>
              <p className="mc-muted">
                Optional, but it turns anonymous visitors into the people you know.
              </p>
              <CodeBlock code={code.identify} label="JavaScript" />
            </section>
            <p className="mc-muted">
              Mark private text with <code className="mc-mono">data-kma-mask</code> or hide an
              element from replays with <code className="mc-mono">data-kma-block</code>.
            </p>
          </>
        ) : (
          <section aria-labelledby="mc-step-http">
            <h2 id="mc-step-http">Send events over HTTP</h2>
            <p className="mc-muted">
              iOS, Android, React Native, Flutter and servers post JSON to the events endpoint. Keep
              one anonymous ID per install, start a new session ID after 30 idle minutes, and send
              your user ID once people sign in. Server keys may import history up to 400 days back.
            </p>
            {settings.data ? (
              <CodeBlock code={code.http} label="HTTP" />
            ) : (
              <Skeleton width="100%" height={160} />
            )}
          </section>
        )}
      </div>
      <aside className="mc-install-rail" aria-labelledby="mc-check-title">
        <section className="mc-panel">
          <div className="mc-panel-head">
            <div>
              <h2 id="mc-check-title">Check your setup</h2>
              <p>Updates every 5 seconds</p>
            </div>
          </div>
          {status.error && <ErrorNote message={status.error} />}
          {sources.length ? (
            <ul className="mc-check-list">
              {sources.map((source) => (
                <li key={`${source.platform}:${source.environment}`}>
                  <span
                    className={
                      now - Date.parse(source.last_seen) < 10 * 60_000
                        ? 'mc-status-dot is-on'
                        : 'mc-status-dot'
                    }
                    aria-hidden="true"
                  />
                  <span>
                    {platformLabels[source.platform]}
                    {source.environment === 'development' ? ' (development)' : ''}
                  </span>
                  <span className="mc-muted">
                    {formatAgo(source.last_seen, Math.max(now, Date.parse(source.last_seen)))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mc-arriving-wait">
              <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />
              {/* A test event or a server import has no session, so it is not a source yet. */}
              {!status.data?.events_total
                ? ` Waiting for the first event from ${project.name}`
                : tab === 'web'
                  ? ` Events are getting through. Waiting for the first visit from ${project.name}: open a page that has the script.`
                  : ` Events are getting through. Waiting for the first app session from ${project.name}.`}
            </p>
          )}
          {status.data && status.data.events_total > 0 && (
            <p className="mc-muted">{plural(status.data.events_total, 'event')} received so far.</p>
          )}
          {canEdit && (
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => void sendTest()}
              disabled={sending}
            >
              <Send size={16} aria-hidden="true" /> Send a test event
            </button>
          )}
          {sources.length > 0 && (
            <a className="mc-link" href={href({ name: 'overview', projectId: project.id })}>
              Go to the overview <ArrowRight size={14} aria-hidden="true" />
            </a>
          )}
        </section>
        <section className="mc-panel">
          <div className="mc-panel-head">
            <div>
              <h2>Your keys</h2>
            </div>
          </div>
          <dl className="mc-facts">
            <div>
              <dt>Client key</dt>
              <dd className="mc-mono mc-break">
                {settings.data ? (live?.token ?? 'No live client key') : <Skeleton height={16} />}
              </dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd className="mc-mono mc-break">{ANALYTICS_ENDPOINT}</dd>
            </div>
          </dl>
          <a
            className="mc-link"
            href={href({ name: 'settings', projectId: project.id, section: 'keys' })}
          >
            Manage keys
          </a>
        </section>
      </aside>
    </div>
  )
}

const sectionTabs: Array<{ value: ProjectSettingsSection; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'keys', label: 'API keys' },
  { value: 'install', label: 'Install SDK' },
]

export function ProjectSettingsScreen({
  project,
  section,
}: {
  project: Project
  section: ProjectSettingsSection
}) {
  const settings = useRpc(`settings:${project.id}`, () => api.projectSettings(project.id))
  const data = settings.data
  const titles: Record<ProjectSettingsSection, { title: string; description: string }> = {
    general: {
      title: 'Project settings',
      description: `How ${project.name} is named, counted and protected.`,
    },
    keys: {
      title: 'API keys',
      description: `Keys that let your apps and servers send to ${project.name}. Each project has its own.`,
    },
    install: {
      title: 'Install the SDK',
      description: `Send ${project.name}'s first events. Your key is already filled in.`,
    },
  }
  return (
    <div className="mc-page">
      <PageHeader title={titles[section].title} description={titles[section].description} />
      <nav className="mc-tabs" aria-label="Project settings">
        {sectionTabs.map((tab) => (
          <a
            key={tab.value}
            href={href({ name: 'settings', projectId: project.id, section: tab.value })}
            aria-current={tab.value === section ? 'page' : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      {settings.error && !data && (
        <ErrorNote message={settings.error} onRetry={() => void settings.refresh()} />
      )}
      {section === 'install' ? (
        <InstallGuide project={project} />
      ) : !data ? (
        <Skeleton width="100%" height={240} />
      ) : section === 'keys' ? (
        <Keys project={project} role={data.role} keys={data.keys} onChange={settings.refresh} />
      ) : (
        <General project={project} role={data.role} />
      )}
    </div>
  )
}
