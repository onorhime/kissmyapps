import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChartLine,
  Check,
  ChevronDown,
  ChevronsUpDown,
  LogOut,
  Menu,
  Plus,
  Settings,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Project } from '../api'
import { formatCount } from '../format'
import { href } from '../routes'
import type { Route } from '../routes'
import { useStore } from '../store'
import { PlatformList, ProjectMark } from './Primitives'

type NavItem = { label: string; route: Route; match: (route: Route) => boolean; badge?: ReactNode }
type NavGroup = { label: string; icon: LucideIcon; items: NavItem[] }

function groups(project: Project | undefined): NavGroup[] {
  const projectId = project?.id
  const analytics: NavItem[] = projectId
    ? [
        {
          label: 'Overview',
          route: { name: 'overview', projectId },
          match: (r) => r.name === 'overview',
        },
        {
          label: 'Users',
          route: { name: 'users', projectId },
          match: (r) => r.name === 'users' || r.name === 'person',
          badge: project?.online_now ? (
            <span className="mc-nav-badge" aria-label={`${project.online_now} online now`}>
              <span className="mc-live-dot" aria-hidden="true" />
              {formatCount(project.online_now)}
            </span>
          ) : undefined,
        },
        {
          label: 'Sessions',
          route: { name: 'sessions', projectId },
          match: (r) => r.name === 'sessions' || r.name === 'session',
        },
        {
          label: 'Events',
          route: { name: 'events', projectId },
          match: (r) => r.name === 'events' || r.name === 'event' || r.name === 'live',
        },
        { label: 'Bots', route: { name: 'bots', projectId }, match: (r) => r.name === 'bots' },
      ]
    : []
  const settings: NavItem[] = [
    {
      label: 'Projects',
      route: { name: 'workspace', section: 'projects', projectId },
      match: (r) => r.name === 'workspace' && r.section === 'projects',
    },
    ...(projectId
      ? ([
          {
            label: 'Project settings',
            route: { name: 'settings', projectId, section: 'general' },
            match: (r) => r.name === 'settings' && r.section === 'general',
          },
          {
            label: 'API keys',
            route: { name: 'settings', projectId, section: 'keys' },
            match: (r) => r.name === 'settings' && r.section === 'keys',
          },
          {
            label: 'Install SDK',
            route: { name: 'settings', projectId, section: 'install' },
            match: (r) => r.name === 'settings' && r.section === 'install',
          },
        ] satisfies NavItem[])
      : []),
    {
      label: 'Members',
      route: { name: 'workspace', section: 'members', projectId },
      match: (r) => r.name === 'workspace' && r.section === 'members',
    },
  ]
  return [
    ...(analytics.length ? [{ label: 'Analytics', icon: ChartLine, items: analytics }] : []),
    { label: 'Settings', icon: Settings, items: settings },
  ]
}

function BrandLockup() {
  return (
    <a className="mc-brand" href={href({ name: 'home' })} aria-label="KissMyApps Merchant, home">
      <img src="/favicon.svg" alt="" width={32} height={32} />
      <span className="mc-brand-text">
        <span className="mc-brand-word">
          Kissmyapps<span>.dev</span>
        </span>
        <span className="mc-brand-context">Merchant</span>
      </span>
    </a>
  )
}

function ProjectSwitcher({
  current,
  route,
  onNavigate,
}: {
  current?: Project
  route: Route
  onNavigate?: () => void
}) {
  const { projects, workspaces, workspace, selectWorkspace } = useStore()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && root.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  // Switching project keeps the reader on the same kind of page where it exists.
  const target = (project: Project): Route => {
    switch (route.name) {
      case 'users':
      case 'sessions':
      case 'events':
      case 'live':
      case 'bots':
      case 'overview':
        return { name: route.name, projectId: project.id }
      case 'person':
        return { name: 'users', projectId: project.id }
      case 'session':
        return { name: 'sessions', projectId: project.id }
      case 'event':
        return { name: 'events', projectId: project.id }
      case 'settings':
        return { name: 'settings', projectId: project.id, section: route.section }
      case 'workspace':
        return { ...route, projectId: project.id }
      default:
        return { name: 'overview', projectId: project.id }
    }
  }
  const close = () => {
    setOpen(false)
    onNavigate?.()
  }

  return (
    <div className="mc-switcher" ref={root}>
      <button
        type="button"
        className="mc-switcher-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {current ? (
          <>
            <ProjectMark project={current} />
            <span className="mc-switcher-text">
              <strong>{current.name}</strong>
              <PlatformList platforms={current.platforms} />
            </span>
          </>
        ) : (
          <span className="mc-switcher-text">
            <strong>{workspace?.name ?? 'Workspace'}</strong>
            <span className="mc-platforms">
              {projects.length ? `${projects.length} projects` : 'No projects yet'}
            </span>
          </span>
        )}
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="mc-switcher-menu">
          {workspaces.length > 1 && (
            <div className="mc-switcher-workspaces" role="group" aria-label="Workspaces">
              {workspaces.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === workspace?.id}
                  onClick={() => {
                    selectWorkspace(item.id)
                    window.location.hash = href({ name: 'home' })
                    close()
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <p className="mc-switcher-label">{workspace?.name} projects</p>
          <ul>
            {projects.map((project) => (
              <li key={project.id}>
                <a
                  href={href(target(project))}
                  aria-current={project.id === current?.id ? 'page' : undefined}
                  onClick={close}
                >
                  <ProjectMark project={project} size={24} />
                  <span>{project.name}</span>
                  {project.id === current?.id && <Check size={16} aria-label="Current project" />}
                </a>
              </li>
            ))}
          </ul>
          <a
            className="mc-switcher-all"
            href={href({
              name: 'workspace',
              section: 'projects',
              projectId: current?.id,
              create: true,
            })}
            onClick={close}
          >
            <Plus size={16} aria-hidden="true" />
            New project
          </a>
        </div>
      )}
    </div>
  )
}

function NavLinks({
  route,
  project,
  onNavigate,
}: {
  route: Route
  project?: Project
  onNavigate?: () => void
}) {
  const sections = groups(project)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <nav className="mc-nav" aria-label="Sections">
      {sections.map((section) => {
        const Icon = section.icon
        const active = section.items.some((item) => item.match(route))
        const expanded = !(collapsed[section.label] ?? false) || active
        const listId = `mc-nav-${section.label.toLowerCase()}`
        return (
          <div key={section.label} className="mc-nav-group">
            <button
              type="button"
              className={active ? 'mc-nav-parent is-active' : 'mc-nav-parent'}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setCollapsed((current) => ({ ...current, [section.label]: expanded }))}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{section.label}</span>
              <ChevronDown size={16} aria-hidden="true" className="mc-nav-chevron" />
            </button>
            {expanded && (
              <ul id={listId} className="mc-nav-sub">
                {section.items.map((item) => (
                  <li key={item.label}>
                    <a
                      href={href(item.route)}
                      aria-current={item.match(route) ? 'page' : undefined}
                      onClick={onNavigate}
                    >
                      <span>{item.label}</span>
                      {item.badge}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      {!project && (
        <p className="mc-nav-note">Create a project to see its users, sessions and events.</p>
      )}
    </nav>
  )
}

function Account() {
  const { user, workspace, signOut } = useStore()
  if (!user) return null
  return (
    <div className="mc-account">
      <span className="mc-avatar" aria-hidden="true">
        {user.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="mc-account-text">
        <strong>{user.name}</strong>
        <span>
          {workspace
            ? `${workspace.name} · ${workspace.role[0].toUpperCase()}${workspace.role.slice(1)}`
            : user.email}
        </span>
      </span>
      <button
        type="button"
        className="mc-icon-btn"
        aria-label="Sign out"
        onClick={() => void signOut()}
      >
        <LogOut size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

export function Shell({
  route,
  project,
  pageTitle,
  children,
}: {
  route: Route
  project?: Project
  pageTitle: string
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { refreshContext } = useStore()

  // Keeps the online counts in the menu and the project list current.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshContext()
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [refreshContext])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  return (
    <div className="mc-shell">
      <a className="mc-skip" href="#mc-main">
        Skip to content
      </a>
      <aside className="mc-sidebar" aria-label="Merchant navigation">
        <BrandLockup />
        <ProjectSwitcher current={project} route={route} />
        <NavLinks route={route} project={project} />
        <Account />
      </aside>

      <header className="mc-topbar">
        <button
          type="button"
          className="mc-icon-btn"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <span className="mc-topbar-title">{pageTitle}</span>
        {project ? (
          <a
            href={href({ name: 'overview', projectId: project.id })}
            aria-label={`${project.name} overview`}
          >
            <ProjectMark project={project} size={28} />
          </a>
        ) : (
          <img src="/favicon.svg" alt="" width={28} height={28} />
        )}
      </header>

      {menuOpen && (
        <div className="mc-sheet" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="mc-sheet-head">
            <BrandLockup />
            <button
              type="button"
              className="mc-icon-btn"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <ProjectSwitcher current={project} route={route} onNavigate={() => setMenuOpen(false)} />
          <NavLinks route={route} project={project} onNavigate={() => setMenuOpen(false)} />
          <Account />
        </div>
      )}

      <main id="mc-main" className="mc-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
