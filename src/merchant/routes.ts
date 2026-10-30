export type AuthRoute =
  | { name: 'sign-in' }
  | { name: 'sign-up'; email?: string; invited?: boolean }
  | { name: 'recover' }
  | { name: 'new-password' }
  | { name: 'confirm-email'; token?: string }

export type ProjectSettingsSection = 'general' | 'keys' | 'install'
export type WorkspaceSettingsSection = 'projects' | 'members'

export type ProjectRoute =
  | { name: 'overview'; projectId: string }
  | { name: 'users'; projectId: string }
  | { name: 'person'; projectId: string; personId: string }
  | { name: 'sessions'; projectId: string }
  | { name: 'session'; projectId: string; sessionId: string }
  | { name: 'events'; projectId: string }
  | { name: 'live'; projectId: string }
  | { name: 'event'; projectId: string; eventName: string }
  | { name: 'bots'; projectId: string }
  | { name: 'settings'; projectId: string; section: ProjectSettingsSection }

export type Route =
  | AuthRoute
  | { name: 'home' }
  | { name: 'workspace'; section: WorkspaceSettingsSection; projectId?: string; create?: boolean }
  | ProjectRoute

function decode(segment: string | undefined): string | undefined {
  if (!segment) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  switch (segments[0]) {
    case 'sign-in':
    case 'recover':
    case 'new-password':
      return { name: segments[0] }
    case 'sign-up': {
      // An invite link names the invited address, so the form starts with it.
      const email = params.get('email')?.trim()
      return {
        name: 'sign-up',
        ...(email ? { email } : {}),
        ...(params.get('invite') === '1' ? { invited: true } : {}),
      }
    }
    case 'confirm-email': {
      // The confirmation email links here with the token Supabase Auth issued for the address.
      const token = params.get('token')?.trim()
      return token ? { name: 'confirm-email', token } : { name: 'confirm-email' }
    }
    case 'settings':
      return {
        name: 'workspace',
        section: segments[1] === 'members' ? 'members' : 'projects',
        projectId: params.get('project') ?? undefined,
        ...(params.get('new') === '1' ? { create: true } : {}),
      }
    case 'p':
      break
    default:
      return { name: 'home' }
  }
  const projectId = decode(segments[1])
  if (!projectId) return { name: 'home' }
  const detail = decode(segments[3])
  switch (segments[2]) {
    case 'users':
      return detail ? { name: 'person', projectId, personId: detail } : { name: 'users', projectId }
    case 'sessions':
      return detail
        ? { name: 'session', projectId, sessionId: detail }
        : { name: 'sessions', projectId }
    case 'live':
      return { name: 'live', projectId }
    case 'events':
      return detail
        ? { name: 'event', projectId, eventName: detail }
        : { name: 'events', projectId }
    case 'bots':
      return { name: 'bots', projectId }
    case 'settings':
      return {
        name: 'settings',
        projectId,
        section:
          segments[3] === 'keys' ? 'keys' : segments[3] === 'install' ? 'install' : 'general',
      }
    default:
      return { name: 'overview', projectId }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'sign-in':
    case 'recover':
    case 'new-password':
      return `#${route.name}`
    case 'sign-up': {
      const params = new URLSearchParams()
      if (route.email) params.set('email', route.email)
      if (route.invited) params.set('invite', '1')
      const query = params.toString()
      return `#sign-up${query ? `?${query}` : ''}`
    }
    case 'confirm-email':
      return route.token
        ? `#confirm-email?token=${encodeURIComponent(route.token)}`
        : '#confirm-email'
    case 'home':
      return '#'
    case 'workspace': {
      const params = new URLSearchParams()
      if (route.projectId) params.set('project', route.projectId)
      if (route.create) params.set('new', '1')
      const query = params.toString()
      return `#settings/${route.section}${query ? `?${query}` : ''}`
    }
  }
  const base = `#p/${encodeURIComponent(route.projectId)}`
  switch (route.name) {
    case 'overview':
      return `${base}/overview`
    case 'users':
      return `${base}/users`
    case 'person':
      return `${base}/users/${encodeURIComponent(route.personId)}`
    case 'sessions':
      return `${base}/sessions`
    case 'session':
      return `${base}/sessions/${encodeURIComponent(route.sessionId)}`
    case 'events':
      return `${base}/events`
    case 'live':
      return `${base}/live`
    case 'event':
      return `${base}/events/${encodeURIComponent(route.eventName)}`
    case 'bots':
      return `${base}/bots`
    case 'settings':
      return `${base}/settings/${route.section}`
  }
}

export function isAuthRoute(route: Route): route is AuthRoute {
  return ['sign-in', 'sign-up', 'recover', 'new-password', 'confirm-email'].includes(route.name)
}

export function navigate(route: Route, replace = false) {
  const next = href(route)
  if (replace) {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${next}`,
    )
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = next
  }
}
