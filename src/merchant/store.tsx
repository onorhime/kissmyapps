/* eslint-disable react/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { initialKeys, initialMembers, initialProjects, merchant } from './data/sample'
import type {
  ApiEnvironment,
  ApiKey,
  ApiKeyKind,
  EventStatus,
  Member,
  MemberRole,
  Platform,
  Project,
  ProjectHue,
} from './data/sample'
import { getDataset, rangeTotals } from './data/model'
import type { Dataset } from './data/model'
import { backfill, nextEvent, perSecond, sampleUsers } from './data/live'
import type { SampleUser, TrackedEvent } from './data/live'
import { secureToken, seededRandom } from './data/random'

export type Session = { name: string; email: string; merchant: string }

type Toast = { id: number; message: string }

type Store = {
  session: Session | null
  projects: Project[]
  keys: ApiKey[]
  members: Member[]
  toasts: Toast[]
  minute: number
  signIn: (email: string) => void
  signUp: (details: { name: string; email: string; company: string }) => void
  signOut: () => void
  createProject: (details: { name: string; platforms: Platform[]; timezone: string }) => string
  updateProject: (
    id: string,
    patch: Partial<Pick<Project, 'name' | 'platforms' | 'timezone' | 'allowedOrigins'>>,
  ) => void
  deleteProject: (id: string) => void
  createKey: (details: {
    projectId: string
    name: string
    kind: ApiKeyKind
    environment: ApiEnvironment
  }) => string
  revokeKey: (id: string) => void
  inviteMember: (email: string, role: MemberRole) => void
  removeMember: (id: string) => void
  setMemberRole: (id: string, role: MemberRole) => void
  eventStatus: (projectId: string, name: string, initial: EventStatus) => EventStatus
  setEventStatus: (projectId: string, name: string, status: EventStatus) => void
  testEvents: Record<string, TrackedEvent[]>
  sendTestEvent: (projectId: string, platform: Platform) => void
  notify: (message: string) => void
  dismissToast: (id: number) => void
}

const StoreContext = createContext<Store | null>(null)
const sessionKey = 'kma:merchant-session'

function readSession(): Session | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null')
    return saved && typeof saved.email === 'string' ? (saved as Session) : null
  } catch {
    return null
  }
}

function writeSession(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session))
    else sessionStorage.removeItem(sessionKey)
  } catch {
    /* Private browsing can disable storage; the session then lasts for this page only. */
  }
}

const hues: ProjectHue[] = ['blue', 'yellow', 'pink', 'green']

function slugFor(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'project'
  let slug = base
  for (let index = 2; taken.includes(slug); index += 1) slug = `${base}-${index}`
  return slug
}

function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function MerchantStoreProvider({
  children,
  initialSession,
}: {
  children: ReactNode
  initialSession?: Session | null
}) {
  const [session, setSession] = useState<Session | null>(() =>
    initialSession !== undefined ? initialSession : readSession(),
  )
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys)
  const [members, setMembers] = useState<Member[]>(initialMembers)
  const [statuses, setStatuses] = useState<Record<string, EventStatus>>({})
  const [testEvents, setTestEvents] = useState<Record<string, TrackedEvent[]>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000) * 60_000)
  const toastId = useRef(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = Math.floor(Date.now() / 60_000) * 60_000
      setMinute((current) => (current === next ? current : next))
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const notify = useCallback((message: string) => {
    toastId.current += 1
    const id = toastId.current
    setToasts((current) => [...current.slice(-2), { id, message }])
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      4_000,
    )
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const signIn = useCallback((email: string) => {
    const next = { name: merchant.owner, email, merchant: merchant.name }
    writeSession(next)
    setSession(next)
  }, [])

  const signUp = useCallback((details: { name: string; email: string; company: string }) => {
    const next = { name: details.name, email: details.email, merchant: details.company }
    writeSession(next)
    setSession(next)
  }, [])

  const signOut = useCallback(() => {
    writeSession(null)
    setSession(null)
  }, [])

  const createProject = useCallback(
    (details: { name: string; platforms: Platform[]; timezone: string }) => {
      const id = slugFor(
        details.name,
        projects.map((project) => project.id),
      )
      const project: Project = {
        id,
        name: details.name.trim(),
        description: '',
        hue: hues[projects.length % hues.length],
        platforms: details.platforms,
        timezone: details.timezone,
        createdAt: today(),
        sdk: {},
        sample: false,
        dau: 0,
        newUsers: 0,
        countries: [],
        versions: { current: '1.0.0', previous: '1.0.0', older: '1.0.0' },
        allowedOrigins: [],
      }
      const token = `kma_pk_live_${secureToken(20)}`
      setProjects((current) => [...current, project])
      setKeys((current) => [
        ...current,
        {
          id: `key_${secureToken(8)}`,
          projectId: id,
          name: 'Default client key',
          kind: 'client',
          environment: 'production',
          token,
          suffix: token.slice(-4),
          createdAt: today(),
          createdBy: session?.name ?? merchant.owner,
          lastUsedMinutesAgo: null,
          revokedAt: null,
        },
      ])
      return id
    },
    [projects, session],
  )

  const updateProject: Store['updateProject'] = useCallback((id, patch) => {
    setProjects((current) =>
      current.map((project) => (project.id === id ? { ...project, ...patch } : project)),
    )
  }, [])

  const deleteProject = useCallback((id: string) => {
    setProjects((current) => current.filter((project) => project.id !== id))
    setKeys((current) => current.filter((key) => key.projectId !== id))
  }, [])

  const createKey: Store['createKey'] = useCallback(
    ({ projectId, name, kind, environment }) => {
      const prefix = `kma_${kind === 'client' ? 'pk' : 'sk'}_${environment === 'production' ? 'live' : 'test'}_`
      const token = `${prefix}${secureToken(kind === 'client' ? 20 : 32)}`
      setKeys((current) => [
        {
          id: `key_${secureToken(8)}`,
          projectId,
          name: name.trim(),
          kind,
          environment,
          // Server keys are shown once, then only their last four characters are kept.
          token: kind === 'client' ? token : null,
          suffix: token.slice(-4),
          createdAt: today(),
          createdBy: session?.name ?? merchant.owner,
          lastUsedMinutesAgo: null,
          revokedAt: null,
        },
        ...current,
      ])
      return token
    },
    [session],
  )

  const revokeKey = useCallback((id: string) => {
    setKeys((current) =>
      current.map((key) => (key.id === id ? { ...key, revokedAt: today() } : key)),
    )
  }, [])

  const inviteMember = useCallback((email: string, role: MemberRole) => {
    const name = email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
    setMembers((current) => [
      ...current,
      {
        id: `m_${secureToken(6)}`,
        name,
        email,
        role,
        status: 'invited',
        lastActive: 'Invited just now',
      },
    ])
  }, [])

  const removeMember = useCallback((id: string) => {
    setMembers((current) => current.filter((member) => member.id !== id))
  }, [])

  const setMemberRole = useCallback((id: string, role: MemberRole) => {
    setMembers((current) =>
      current.map((member) => (member.id === id ? { ...member, role } : member)),
    )
  }, [])

  const eventStatus = useCallback(
    (projectId: string, name: string, initial: EventStatus) =>
      statuses[`${projectId}:${name}`] ?? initial,
    [statuses],
  )

  const setEventStatus = useCallback((projectId: string, name: string, status: EventStatus) => {
    setStatuses((current) => ({ ...current, [`${projectId}:${name}`]: status }))
  }, [])

  const sendTestEvent = useCallback((projectId: string, platform: Platform) => {
    const time = Date.now()
    const event: TrackedEvent = {
      id: `evt_${secureToken(12)}`,
      name: 'kma_test_event',
      time,
      receivedAt: time + 180,
      userId: 'usr_test',
      deviceId: `dev_${secureToken(10)}`,
      platform,
      properties: { sent_from: 'Install page' },
      context: {
        platform: { ios: 'iOS', android: 'Android', web: 'Web', server: 'Server' }[platform],
        library: 'kma-js 1.3.1',
        country: 'Nigeria',
      },
      test: true,
    }
    setTestEvents((current) => ({
      ...current,
      [projectId]: [event, ...(current[projectId] ?? [])],
    }))
    setKeys((current) =>
      current.map((key) =>
        key.projectId === projectId && key.kind === 'client' && !key.revokedAt
          ? { ...key, lastUsedMinutesAgo: 0 }
          : key,
      ),
    )
  }, [])

  const value = useMemo<Store>(
    () => ({
      session,
      projects,
      keys,
      members,
      toasts,
      minute,
      signIn,
      signUp,
      signOut,
      createProject,
      updateProject,
      deleteProject,
      createKey,
      revokeKey,
      inviteMember,
      removeMember,
      setMemberRole,
      eventStatus,
      setEventStatus,
      testEvents,
      sendTestEvent,
      notify,
      dismissToast,
    }),
    [
      session,
      projects,
      keys,
      members,
      toasts,
      minute,
      signIn,
      signUp,
      signOut,
      createProject,
      updateProject,
      deleteProject,
      createKey,
      revokeKey,
      inviteMember,
      removeMember,
      setMemberRole,
      eventStatus,
      setEventStatus,
      testEvents,
      sendTestEvent,
      notify,
      dismissToast,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside MerchantStoreProvider')
  return store
}

export function useDataset(project: Project | undefined): Dataset | null {
  const { minute } = useStore()
  return useMemo(() => (project ? getDataset(project, minute) : null), [project, minute])
}

export function useSampleUsers(project: Project | undefined): SampleUser[] {
  const { minute } = useStore()
  return useMemo(() => (project ? sampleUsers(project, minute) : []), [project, minute])
}

/** A ticking clock for "12 s ago" labels, scoped to the component that needs it. */
export function useNow(interval = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval])
  return now
}

/**
 * Events arriving for one project. Sample projects stream generated traffic at their real
 * daily rate; new projects only show test events sent from the install page.
 */
export function useLiveEvents(
  project: Project | undefined,
  paused = false,
  limit = 200,
): TrackedEvent[] {
  const { testEvents, minute } = useStore()
  const dataset = useDataset(project)
  const users = useSampleUsers(project)
  const rate = useMemo(() => {
    if (!project || !dataset) return 0
    return perSecond(project, rangeTotals(dataset, '7d').events / 7)
  }, [project, dataset])
  const [stream, setStream] = useState<{ projectId: string; events: TrackedEvent[] }>({
    projectId: '',
    events: [],
  })
  const [random] = useState(() => seededRandom(Date.now() % 2_147_483_647))
  const projectId = project?.id ?? ''

  // Re-seed when the project changes; the backfill is deterministic per minute.
  const seeded =
    stream.projectId === projectId
      ? stream.events
      : project && dataset && rate > 0
        ? backfill(project, users, minute, rate)
        : []
  if (stream.projectId !== projectId) setStream({ projectId, events: seeded })

  useEffect(() => {
    if (!project || !dataset || rate === 0 || paused) return
    const silent = project.quietSource ? [project.quietSource.platform] : []
    const timer = window.setInterval(() => {
      const now = Date.now()
      const arrivals: TrackedEvent[] = []
      let budget = rate
      while (budget > 0) {
        if (random() < Math.min(1, budget)) {
          const event = nextEvent(project, users, now - Math.floor(random() * 1000), random, {
            silent,
          })
          if (event) arrivals.push(event)
        }
        budget -= 1
      }
      if (arrivals.length) {
        arrivals.sort((a, b) => b.time - a.time)
        setStream((current) =>
          current.projectId === project.id
            ? { projectId: project.id, events: [...arrivals, ...current.events].slice(0, limit) }
            : current,
        )
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [project, dataset, users, rate, paused, limit, random])

  const tests = testEvents[projectId]
  return tests?.length
    ? [...tests, ...seeded].sort((a, b) => b.time - a.time).slice(0, limit)
    : seeded
}
