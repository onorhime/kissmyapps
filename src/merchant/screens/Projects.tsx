import { useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, Plus } from 'lucide-react'
import { getDataset, rangeTotals } from '../data/model'
import type { Platform, Project } from '../data/sample'
import { platformLabels, timezones } from '../data/sample'
import { formatCount, formatLongDate, plural } from '../format'
import { href, navigate } from '../routes'
import { useStore } from '../store'
import { Field, PageHeader, Pill, PlatformList, ProjectMark, Select } from '../ui/Primitives'

const allPlatforms: Platform[] = ['ios', 'android', 'web', 'server']

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

function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const { createProject, notify } = useStore()
  const [name, setName] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>(['ios', 'android'])
  const [timezone, setTimezone] = useState('UTC')
  const [errors, setErrors] = useState<{ name?: string; platforms?: string }>({})

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      name: name.trim() ? undefined : 'Name the project, usually after the app.',
      platforms: platforms.length ? undefined : 'Pick at least one platform.',
    }
    setErrors(next)
    if (next.name || next.platforms) return
    const id = createProject({ name, platforms, timezone })
    notify(`${name.trim()} is ready. Its client key is on the install page.`)
    navigate({ name: 'install', projectId: id })
  }

  return (
    <form
      className="mc-panel mc-new-project"
      onSubmit={submit}
      noValidate
      aria-labelledby="mc-new-project-title"
    >
      <div className="mc-panel-head">
        <h2 id="mc-new-project-title">New project</h2>
        <p>One project per app. Its web, iOS and Android builds can share it.</p>
      </div>
      <div className="mc-form-grid">
        <Field label="Project name" error={errors.name}>
          {(props) => (
            <input
              {...props}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Select
          label="Reporting time zone"
          value={timezone}
          options={timezones}
          onChange={setTimezone}
        />
        <PlatformChoices value={platforms} onChange={setPlatforms} error={errors.platforms} />
      </div>
      <div className="mc-form-actions">
        <button type="button" className="mc-btn mc-btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="mc-btn mc-btn-primary">
          Create project
        </button>
      </div>
    </form>
  )
}

function projectStatus(project: Project, hasTestEvents: boolean) {
  if (!project.sample) {
    return hasTestEvents
      ? { tone: 'positive' as const, text: 'Receiving test events' }
      : { tone: 'neutral' as const, text: 'Waiting for first event' }
  }
  if (project.quietSource) {
    return {
      tone: 'warning' as const,
      text: `${platformLabels[project.quietSource.platform]} quiet for ${project.quietSource.minutes} min`,
    }
  }
  return { tone: 'positive' as const, text: 'Receiving' }
}

export function ProjectsScreen() {
  const { projects, minute, testEvents } = useStore()
  const [creating, setCreating] = useState(false)
  const rows = projects.map((project) => {
    const dataset = getDataset(project, minute)
    const totals = dataset ? rangeTotals(dataset, 'today') : null
    const tests = testEvents[project.id]?.length ?? 0
    return {
      project,
      events: totals ? totals.events : tests,
      people: totals ? totals.activeUsers : tests ? 1 : 0,
      status: projectStatus(project, tests > 0),
    }
  })
  const eventsToday = rows.reduce((sum, row) => sum + row.events, 0)
  const waiting = rows.filter((row) => row.events === 0)
  const description = `${formatCount(eventsToday)} events so far today across ${plural(rows.length - waiting.length, 'project')}.${
    waiting.length
      ? ` ${waiting.map((row) => row.project.name).join(' and ')} ${waiting.length === 1 ? 'is' : 'are'} waiting for a first event.`
      : ''
  }`

  return (
    <div className="mc-page">
      <PageHeader
        title="Projects"
        description={description}
        actions={
          !creating && (
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} aria-hidden="true" />
              New project
            </button>
          )
        }
      />
      {creating && <NewProjectForm onCancel={() => setCreating(false)} />}
      <section className="mc-panel mc-panel-flush" aria-labelledby="mc-projects-title">
        <h2 id="mc-projects-title" className="sr-only">
          All projects
        </h2>
        <table className="mc-table mc-projects-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Platforms</th>
              <th scope="col" className="is-num">
                Events today
              </th>
              <th scope="col" className="is-num">
                People today
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="is-num">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ project, events, people, status }) => (
              <tr key={project.id} className="mc-row-link">
                <td>
                  <a
                    className="mc-project-cell"
                    href={href({ name: 'overview', projectId: project.id })}
                  >
                    <ProjectMark project={project} size={36} />
                    <span>
                      <strong>{project.name}</strong>
                      <span className="mc-sub">{project.description || 'New project'}</span>
                    </span>
                  </a>
                </td>
                <td>
                  <PlatformList platforms={project.platforms} />
                </td>
                <td className="is-num mc-num">{formatCount(events)}</td>
                <td className="is-num mc-num">{formatCount(people)}</td>
                <td>
                  <Pill tone={status.tone}>{status.text}</Pill>
                </td>
                <td className="is-num mc-num mc-muted">{formatLongDate(project.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mc-projects-list">
          {rows.map(({ project, events, status }) => (
            <li key={project.id}>
              <a href={href({ name: 'overview', projectId: project.id })}>
                <ProjectMark project={project} size={36} />
                <span className="mc-projects-list-text">
                  <strong>{project.name}</strong>
                  <span className="mc-sub">
                    <PlatformList platforms={project.platforms} /> · {formatCount(events)} events
                    today
                  </span>
                  <Pill tone={status.tone}>{status.text}</Pill>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
