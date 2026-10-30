import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { Project } from './api'
import { href, isAuthRoute, navigate, parseRoute } from './routes'
import type { Route } from './routes'
import { MerchantStoreProvider, useStore } from './store'
import { AuthScreen } from './screens/Auth'
import { BotsScreen } from './screens/Bots'
import { EventDetailScreen, EventsScreen } from './screens/Events'
import { OverviewScreen } from './screens/Overview'
import { SessionDetailScreen, SessionsScreen } from './screens/Sessions'
import { MembersScreen, ProjectSettingsScreen, ProjectsScreen } from './screens/Settings'
import { PersonScreen, UsersScreen } from './screens/Users'
import { Shell } from './ui/Shell'
import { ErrorNote, PageHeader, Toasts } from './ui/Primitives'
import './merchant.css'

const LAST_PROJECT = 'kma:merchant:project'

const titles: Record<Route['name'], string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create account',
  recover: 'Reset password',
  'new-password': 'Choose a new password',
  home: 'Home',
  workspace: 'Settings',
  overview: 'Overview',
  users: 'Users',
  person: 'User',
  sessions: 'Sessions',
  session: 'Session',
  events: 'Events',
  live: 'Live events',
  event: 'Event',
  bots: 'Bots',
  settings: 'Project settings',
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

function rememberedProject(projects: Project[]): Project | undefined {
  try {
    const id = localStorage.getItem(LAST_PROJECT)
    return projects.find((project) => project.id === id) ?? projects[0]
  } catch {
    return projects[0]
  }
}

function Screens() {
  const route = useRoute()
  const { status, error, projects, refreshContext } = useStore()
  const projectId = 'projectId' in route ? route.projectId : undefined
  const project = projectId ? projects.find((item) => item.id === projectId) : undefined

  useEffect(() => {
    if (status === 'signed-out' && !isAuthRoute(route)) navigate({ name: 'sign-in' }, true)
    if (status === 'ready' && isAuthRoute(route) && route.name !== 'new-password')
      navigate({ name: 'home' }, true)
    if (status === 'ready' && route.name === 'home') {
      const next = rememberedProject(projects)
      navigate(
        next
          ? { name: 'overview', projectId: next.id }
          : { name: 'workspace', section: 'projects', create: true },
        true,
      )
    }
  }, [status, route, projects])

  useEffect(() => {
    if (!project) return
    try {
      localStorage.setItem(LAST_PROJECT, project.id)
    } catch {
      /* Remembering the project is a convenience only. */
    }
  }, [project])

  const missing = route.name !== 'workspace' && Boolean(projectId) && !project
  const pageTitle = missing
    ? 'Project not found'
    : route.name === 'event'
      ? route.eventName
      : titles[route.name]
  useEffect(() => {
    document.title = `${project ? `${pageTitle} · ${project.name}` : pageTitle} · KissMyApps Merchant`
  }, [pageTitle, project])
  useEffect(() => {
    document.querySelector<HTMLElement>('#mc-page-title')?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [route.name, projectId])

  if (status === 'unconfigured') {
    return (
      <div className="mc-boot">
        <ErrorNote message={error ?? 'Sign-in is not configured for this site.'} />
      </div>
    )
  }
  if (isAuthRoute(route) || status === 'signed-out') {
    return status === 'loading' ? (
      <Booting />
    ) : isAuthRoute(route) ? (
      <AuthScreen route={route} />
    ) : null
  }
  if (status === 'loading' || route.name === 'home') return <Booting />
  if (status === 'error') {
    return (
      <div className="mc-boot">
        <ErrorNote
          message={error ?? 'Your workspace could not load.'}
          onRetry={() => void refreshContext()}
        />
      </div>
    )
  }

  const shellProject =
    project ??
    (route.name === 'workspace' ? projects.find((item) => item.id === route.projectId) : undefined)
  let content
  if (route.name === 'workspace') {
    content =
      route.section === 'members' ? <MembersScreen /> : <ProjectsScreen create={route.create} />
  } else if (!project) {
    content = (
      <div className="mc-page">
        <PageHeader
          title="Project not found"
          description="It may have been deleted, or you may not be a member of its workspace."
        />
        <a className="mc-btn mc-btn-primary mc-self-start" href={href({ name: 'home' })}>
          Go to your projects
        </a>
      </div>
    )
  } else {
    switch (route.name) {
      case 'overview':
        content = <OverviewScreen key={project.id} project={project} />
        break
      case 'users':
        content = <UsersScreen key={project.id} project={project} />
        break
      case 'person':
        content = <PersonScreen key={route.personId} project={project} personId={route.personId} />
        break
      case 'sessions':
        content = <SessionsScreen key={project.id} project={project} />
        break
      case 'session':
        content = (
          <SessionDetailScreen
            key={route.sessionId}
            project={project}
            sessionId={route.sessionId}
          />
        )
        break
      case 'events':
      case 'live':
        content = <EventsScreen key={project.id} project={project} live={route.name === 'live'} />
        break
      case 'event':
        content = (
          <EventDetailScreen
            key={`${project.id}:${route.eventName}`}
            project={project}
            eventName={route.eventName}
          />
        )
        break
      case 'bots':
        content = <BotsScreen key={project.id} project={project} />
        break
      case 'settings':
        content = (
          <ProjectSettingsScreen
            key={`${project.id}:${route.section}`}
            project={project}
            section={route.section}
          />
        )
        break
    }
  }

  return (
    <Shell route={route} project={shellProject} pageTitle={pageTitle}>
      {content}
    </Shell>
  )
}

function Booting() {
  return (
    <div className="mc-boot" role="status">
      <LoaderCircle className="mc-spin" size={20} aria-hidden="true" />
      <span>Opening your workspace</span>
    </div>
  )
}

export function MerchantApp() {
  return (
    <MerchantStoreProvider>
      <div className="mc-app">
        <Screens />
        <Toasts />
      </div>
    </MerchantStoreProvider>
  )
}
