export type AuthRoute =
  | { name: 'sign-in' }
  | { name: 'sign-up'; email?: string; invited?: boolean }
  | { name: 'recover' }
  | { name: 'new-password' }
  | { name: 'confirm-email'; token?: string }

export type ProjectSettingsSection = 'general' | 'keys' | 'install'
export type WorkspaceSettingsSection = 'projects' | 'members'
export type AttributionSection = 'setup' | 'links' | 'sources' | 'settings'

export type ProjectRoute =
  | { name: 'overview'; projectId: string }
  | { name: 'users'; projectId: string }
  | { name: 'person'; projectId: string; personId: string }
  | { name: 'sessions'; projectId: string }
  | { name: 'session'; projectId: string; sessionId: string }
  | { name: 'funnels'; projectId: string }
  /** A saved funnel by its id, or 'new' for the builder. */
  | { name: 'funnel'; projectId: string; funnelId: string }
  | { name: 'retention'; projectId: string }
  | { name: 'events'; projectId: string }
  | { name: 'live'; projectId: string }
  | { name: 'event'; projectId: string; eventName: string }
  | { name: 'bots'; projectId: string }
  | { name: 'attribution'; projectId: string; section: AttributionSection }
  | { name: 'settings'; projectId: string; section: ProjectSettingsSection }

export type Route =
  | AuthRoute
  | { name: 'home' }
  | { name: 'workspace'; section: WorkspaceSettingsSection; projectId?: string; create?: boolean }
  /** The workspace's links to outside tools, Stripe first. */
  | { name: 'connections' }
  /** The workspace's affiliate program: what creators promote and what they earn. */
  | { name: 'program' }
  /** The creators of that program: who is waiting, who is promoting, who has left. */
  | { name: 'creators' }
  /** The sales creators sent, newest first; `creator` narrows the list to one member. */
  | { name: 'sales'; creator?: string }
  /** The rewards creators earned for events, to review; `creator` narrows them to one member. */
  | { name: 'rewards'; creator?: string }
  /**
   * The prepaid balance creators are paid from. Stripe's payment page sends the person back
   * here saying how it ended: a deposit, or a change of card, done or cancelled.
   */
  | { name: 'balance'; deposit?: StripeOutcome; card?: StripeOutcome }
  | ProjectRoute

export type StripeOutcome = 'done' | 'canceled'

function outcome(value: string | null): StripeOutcome | undefined {
  return value === 'done' || value === 'canceled' ? value : undefined
}

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
    case 'connections':
      return { name: 'connections' }
    case 'program':
      return { name: 'program' }
    case 'creators':
      return { name: 'creators' }
    case 'sales': {
      // The Creators page links here with the member whose sales to show.
      const creator = params.get('creator')?.trim()
      return creator ? { name: 'sales', creator } : { name: 'sales' }
    }
    case 'rewards': {
      // The creators table on the page links here with the member whose rewards to show.
      const creator = params.get('creator')?.trim()
      return creator ? { name: 'rewards', creator } : { name: 'rewards' }
    }
    case 'balance': {
      const deposit = outcome(params.get('deposit'))
      const card = outcome(params.get('card'))
      return { name: 'balance', ...(deposit ? { deposit } : {}), ...(card ? { card } : {}) }
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
    case 'funnels':
      return detail
        ? { name: 'funnel', projectId, funnelId: detail }
        : { name: 'funnels', projectId }
    case 'retention':
      return { name: 'retention', projectId }
    case 'live':
      return { name: 'live', projectId }
    case 'events':
      return detail
        ? { name: 'event', projectId, eventName: detail }
        : { name: 'events', projectId }
    case 'bots':
      return { name: 'bots', projectId }
    case 'attribution':
      return {
        name: 'attribution',
        projectId,
        section:
          segments[3] === 'settings' || segments[3] === 'links' || segments[3] === 'sources'
            ? segments[3]
            : 'setup',
      }
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
    case 'connections':
      return '#connections'
    case 'program':
      return '#program'
    case 'creators':
      return '#creators'
    case 'sales':
      return route.creator ? `#sales?creator=${encodeURIComponent(route.creator)}` : '#sales'
    case 'rewards':
      return route.creator ? `#rewards?creator=${encodeURIComponent(route.creator)}` : '#rewards'
    case 'balance': {
      const params = new URLSearchParams()
      if (route.deposit) params.set('deposit', route.deposit)
      if (route.card) params.set('card', route.card)
      const query = params.toString()
      return `#balance${query ? `?${query}` : ''}`
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
    case 'funnels':
      return `${base}/funnels`
    case 'funnel':
      return `${base}/funnels/${encodeURIComponent(route.funnelId)}`
    case 'retention':
      return `${base}/retention`
    case 'events':
      return `${base}/events`
    case 'live':
      return `${base}/live`
    case 'event':
      return `${base}/events/${encodeURIComponent(route.eventName)}`
    case 'bots':
      return `${base}/bots`
    case 'attribution':
      return `${base}/attribution${route.section === 'setup' ? '' : `/${route.section}`}`
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
