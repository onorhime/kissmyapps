export type AuthRoute = { name: 'sign-in' } | { name: 'sign-up' } | { name: 'recover' }

export type SettingsSection = 'general' | 'keys' | 'members'
export type InstallPlatform = 'web' | 'ios' | 'android' | 'react-native' | 'flutter' | 'http'

export type ProjectRoute =
  | { name: 'overview'; projectId: string }
  | { name: 'live'; projectId: string }
  | { name: 'events'; projectId: string }
  | { name: 'event'; projectId: string; eventName: string }
  | { name: 'explore'; projectId: string; eventName?: string }
  | { name: 'users'; projectId: string; userId?: string }
  | { name: 'install'; projectId: string; platform?: InstallPlatform }
  | { name: 'settings'; projectId: string; section: SettingsSection }

export type Route = AuthRoute | { name: 'projects' } | ProjectRoute

export const installPlatforms: InstallPlatform[] = [
  'web',
  'ios',
  'android',
  'react-native',
  'flutter',
  'http',
]
const settingsSections: SettingsSection[] = ['general', 'keys', 'members']

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
  if (segments[0] === 'sign-up') return { name: 'sign-up' }
  if (segments[0] === 'recover') return { name: 'recover' }
  if (segments[0] === 'sign-in') return { name: 'sign-in' }
  if (segments[0] !== 'p' || !segments[1]) return { name: 'projects' }

  const projectId = decode(segments[1]) ?? ''
  const page = segments[2]
  const detail = decode(segments[3])
  switch (page) {
    case 'live':
      return { name: 'live', projectId }
    case 'events':
      return detail
        ? { name: 'event', projectId, eventName: detail }
        : { name: 'events', projectId }
    case 'explore':
      return { name: 'explore', projectId, eventName: params.get('event') ?? undefined }
    case 'users':
      return { name: 'users', projectId, userId: detail }
    case 'install':
      return {
        name: 'install',
        projectId,
        platform: installPlatforms.find((platform) => platform === detail),
      }
    case 'settings':
      return {
        name: 'settings',
        projectId,
        section: settingsSections.find((section) => section === detail) ?? 'general',
      }
    default:
      return { name: 'overview', projectId }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'sign-in':
    case 'sign-up':
    case 'recover':
    case 'projects':
      return `#${route.name}`
    case 'overview':
      return `#p/${route.projectId}/overview`
    case 'live':
      return `#p/${route.projectId}/live`
    case 'events':
      return `#p/${route.projectId}/events`
    case 'event':
      return `#p/${route.projectId}/events/${encodeURIComponent(route.eventName)}`
    case 'explore':
      return `#p/${route.projectId}/explore${route.eventName ? `?event=${encodeURIComponent(route.eventName)}` : ''}`
    case 'users':
      return `#p/${route.projectId}/users${route.userId ? `/${encodeURIComponent(route.userId)}` : ''}`
    case 'install':
      return `#p/${route.projectId}/install${route.platform ? `/${route.platform}` : ''}`
    case 'settings':
      return `#p/${route.projectId}/settings/${route.section}`
  }
}

export function isAuthRoute(route: Route): route is AuthRoute {
  return route.name === 'sign-in' || route.name === 'sign-up' || route.name === 'recover'
}

export function navigate(route: Route, replace = false) {
  const next = href(route)
  if (replace) window.history.replaceState(null, '', next)
  else window.location.hash = next
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}
