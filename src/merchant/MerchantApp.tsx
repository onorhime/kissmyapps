import { useEffect, useState } from 'react'
import { href, isAuthRoute, navigate, parseRoute } from './routes'
import type { Route } from './routes'
import { MerchantStoreProvider, useStore } from './store'
import type { Session } from './store'
import { AuthScreen } from './screens/Auth'
import { EventDetailScreen, EventsScreen } from './screens/Events'
import { ExploreScreen } from './screens/Explore'
import { InstallScreen } from './screens/Install'
import { LiveEventsScreen } from './screens/LiveEvents'
import { OverviewScreen } from './screens/Overview'
import { ProjectsScreen } from './screens/Projects'
import { SettingsScreen } from './screens/Settings'
import { UsersScreen } from './screens/Users'
import { Shell } from './ui/Shell'
import { PageHeader, Toasts } from './ui/Primitives'
import './merchant.css'

const titles: Record<Route['name'], string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create account',
  recover: 'Reset password',
  projects: 'Projects',
  overview: 'Overview',
  live: 'Live events',
  events: 'Events',
  event: 'Event',
  explore: 'Explore',
  users: 'Users',
  install: 'Install the SDK',
  settings: 'Settings',
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

function Screens() {
  const route = useRoute()
  const { session, projects } = useStore()
  const signedIn = Boolean(session)
  const project =
    'projectId' in route ? projects.find((item) => item.id === route.projectId) : undefined

  // Signed-out visitors land on sign-in; signed-in ones skip the auth screens.
  useEffect(() => {
    if (!signedIn && !isAuthRoute(route)) navigate({ name: 'sign-in' }, true)
    if (signedIn && isAuthRoute(route)) navigate({ name: 'projects' }, true)
  }, [signedIn, route])

  const missing = 'projectId' in route && !project
  const pageTitle = missing
    ? 'Project not found'
    : route.name === 'event'
      ? route.eventName
      : titles[route.name]
  useEffect(() => {
    document.title = `${project ? `${pageTitle} · ${project.name}` : pageTitle} · KissMyApps Merchant`
    document.querySelector<HTMLElement>('#mc-page-title')?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [pageTitle, project])

  if (!signedIn || isAuthRoute(route)) {
    return isAuthRoute(route) ? <AuthScreen route={route} /> : null
  }

  let content
  if (route.name === 'projects') content = <ProjectsScreen />
  else if (!project) {
    content = (
      <div className="mc-page">
        <PageHeader
          title="Project not found"
          description="It may have been deleted, or the link is wrong."
        />
        <a className="mc-btn mc-btn-primary mc-self-start" href={href({ name: 'projects' })}>
          See all projects
        </a>
      </div>
    )
  } else {
    switch (route.name) {
      case 'overview':
        content = <OverviewScreen key={project.id} project={project} />
        break
      case 'live':
        content = <LiveEventsScreen key={project.id} project={project} />
        break
      case 'events':
        content = <EventsScreen key={project.id} project={project} />
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
      case 'explore':
        content = (
          <ExploreScreen
            key={`${project.id}:${route.eventName ?? ''}`}
            project={project}
            initialEvent={route.eventName}
          />
        )
        break
      case 'users':
        content = <UsersScreen key={project.id} project={project} userId={route.userId} />
        break
      case 'install':
        content = <InstallScreen key={project.id} project={project} platform={route.platform} />
        break
      case 'settings':
        content = <SettingsScreen key={project.id} project={project} section={route.section} />
        break
    }
  }

  return (
    <Shell route={route} project={project} pageTitle={pageTitle}>
      {content}
    </Shell>
  )
}

export function MerchantApp({ initialSession }: { initialSession?: Session | null }) {
  return (
    <MerchantStoreProvider initialSession={initialSession}>
      <div className="mc-app">
        <Screens />
        <Toasts />
      </div>
    </MerchantStoreProvider>
  )
}
