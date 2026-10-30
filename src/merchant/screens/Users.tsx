import { useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { userTimeline } from '../data/live'
import type { SampleUser } from '../data/live'
import type { Project } from '../data/sample'
import { platformLabels } from '../data/sample'
import { formatAgo, formatClock, formatCount, formatDate, formatLongDate } from '../format'
import { href } from '../routes'
import { useNow, useSampleUsers, useStore } from '../store'
import { CopyButton, PageHeader, Pill } from '../ui/Primitives'

const planTone = { Free: 'neutral', Trial: 'info', Pro: 'positive' } as const

function dayLabel(time: number, now: number) {
  const day = new Date(time)
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)
  if (day.toDateString() === today.toDateString()) return 'Today'
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return formatDate(time)
}

function Profile({ project, user, now }: { project: Project; user: SampleUser; now: number }) {
  const sessions = userTimeline(project, user)
  return (
    <section className="mc-panel mc-profile" aria-labelledby="mc-profile-title">
      <div className="mc-profile-head">
        <div>
          <h2 id="mc-profile-title" className="mc-mono">
            {user.id}
          </h2>
          <p className="mc-muted">
            {platformLabels[user.platform]} · {user.country} · last seen{' '}
            {formatAgo(user.lastSeen, now)}
          </p>
        </div>
        <div className="mc-profile-actions">
          <Pill tone={planTone[user.plan]}>{user.plan}</Pill>
          <CopyButton value={user.id} label="user ID" compact />
        </div>
      </div>
      <dl className="mc-facts">
        <div>
          <dt>First seen</dt>
          <dd className="mc-num">{formatLongDate(user.firstSeen)}</dd>
        </div>
        <div>
          <dt>Sessions, 30 days</dt>
          <dd className="mc-num">{formatCount(user.sessions30d)}</dd>
        </div>
        <div>
          <dt>Events, 30 days</dt>
          <dd className="mc-num">{formatCount(user.events30d)}</dd>
        </div>
        <div>
          <dt>App version</dt>
          <dd className="mc-num">{user.appVersion === 'web' ? 'Web' : user.appVersion}</dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>
            {user.deviceModel}, {user.osVersion}
          </dd>
        </div>
        <div>
          <dt>Device ID</dt>
          <dd className="mc-mono mc-truncate">{user.deviceId}</dd>
        </div>
      </dl>
      <h3>Recent activity</h3>
      <ol className="mc-timeline">
        {sessions.map((session) => (
          <li key={session.start}>
            <p className="mc-timeline-head">
              <strong>{dayLabel(session.start, now)}</strong>
              <span className="mc-muted mc-num">
                Session at {formatClock(session.start).slice(0, 5)} on{' '}
                {platformLabels[session.platform]}
              </span>
            </p>
            <ol>
              {session.events.map((event, index) => (
                <li key={`${event.name}-${index}`}>
                  <span className="mc-num mc-muted">{formatClock(event.time)}</span>
                  <span className="mc-mono">{event.name}</span>
                  <span className="mc-muted mc-truncate">{event.detail}</span>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function UsersScreen({ project, userId }: { project: Project; userId?: string }) {
  const users = useSampleUsers(project)
  const { testEvents } = useStore()
  const now = useNow(30_000)
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const matches = term
    ? users.filter((user) => user.id.includes(term) || user.deviceId.toLowerCase().includes(term))
    : users
  const shown = matches.slice(0, 12)
  const selected = users.find((user) => user.id === userId) ?? (userId ? undefined : shown[0])
  const activeToday = users.filter((user) => now - user.lastSeen < 86_400_000).length

  if (!project.sample) {
    const tested = (testEvents[project.id] ?? []).length > 0
    return (
      <div className="mc-page">
        <PageHeader
          title="Users"
          description="People appear here once your app sends events with a user ID."
        />
        <section className="mc-panel">
          <div className="mc-empty">
            <p>
              {tested
                ? 'Test events are anonymous. Call identify after sign-in so events carry your user IDs.'
                : `No one has sent an event to ${project.name} yet.`}
            </p>
            <a
              className="mc-btn mc-btn-primary"
              href={href({ name: 'install', projectId: project.id })}
            >
              See how to identify users
            </a>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={userId ? 'mc-page mc-users has-selection' : 'mc-page mc-users'}>
      <PageHeader
        title="Users"
        description={`${formatCount(activeToday)} of the ${formatCount(users.length)} most recent people were active in the last 24 hours. Look anyone up by user or device ID.`}
      />
      <div className="mc-users-layout">
        <section
          className="mc-panel mc-panel-flush mc-users-list"
          aria-labelledby="mc-users-list-title"
        >
          <h2 id="mc-users-list-title" className="sr-only">
            People
          </h2>
          <label className="mc-search is-inset">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Find a person by user or device ID</span>
            <input
              value={query}
              placeholder="User or device ID"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {shown.length ? (
            <ul>
              {shown.map((user) => (
                <li key={user.id}>
                  <a
                    href={href({ name: 'users', projectId: project.id, userId: user.id })}
                    aria-current={user.id === selected?.id ? 'true' : undefined}
                  >
                    <span className="mc-users-line">
                      <span className="mc-mono">{user.id}</span>
                      <span className="mc-num mc-muted">{formatAgo(user.lastSeen, now)}</span>
                    </span>
                    <span className="mc-sub">
                      {platformLabels[user.platform]} · {user.country} · {user.plan}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mc-empty">
              <p>No one matches “{query.trim()}”. Check the ID, or search part of it.</p>
              <button
                type="button"
                className="mc-btn mc-btn-secondary"
                onClick={() => setQuery('')}
              >
                Clear search
              </button>
            </div>
          )}
          <p className="mc-panel-foot mc-muted is-padded">
            {matches.length > shown.length
              ? `Showing ${shown.length} of ${formatCount(matches.length)}. Search to narrow it down.`
              : `${formatCount(matches.length)} ${matches.length === 1 ? 'person' : 'people'}`}
          </p>
        </section>
        <div className="mc-users-detail">
          {userId && (
            <a
              className="mc-back mc-users-back"
              href={href({ name: 'users', projectId: project.id })}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              All users
            </a>
          )}
          {selected ? (
            <Profile project={project} user={selected} now={now} />
          ) : (
            <section className="mc-panel">
              <div className="mc-empty">
                <p>No one with the ID {userId} has sent an event in the last 30 days.</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
