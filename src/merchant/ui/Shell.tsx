import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChartLine,
  Check,
  ChevronsUpDown,
  CodeXml,
  LayoutDashboard,
  ListTree,
  LogOut,
  Menu,
  Plus,
  Radio,
  Settings,
  UserRound,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Project } from '../data/sample'
import { href } from '../routes'
import type { Route } from '../routes'
import { useStore } from '../store'
import { PlatformList, ProjectMark } from './Primitives'

type NavItem = { label: string; icon: LucideIcon; route: Route; match: Route['name'][] }

function projectNav(projectId: string): Array<{ group?: string; items: NavItem[] }> {
  return [
    {
      items: [
        {
          label: 'Overview',
          icon: LayoutDashboard,
          route: { name: 'overview', projectId },
          match: ['overview'],
        },
        { label: 'Live events', icon: Radio, route: { name: 'live', projectId }, match: ['live'] },
        {
          label: 'Events',
          icon: ListTree,
          route: { name: 'events', projectId },
          match: ['events', 'event'],
        },
        {
          label: 'Explore',
          icon: ChartLine,
          route: { name: 'explore', projectId },
          match: ['explore'],
        },
        { label: 'Users', icon: UserRound, route: { name: 'users', projectId }, match: ['users'] },
      ],
    },
    {
      group: 'Set up',
      items: [
        {
          label: 'Install SDK',
          icon: CodeXml,
          route: { name: 'install', projectId },
          match: ['install'],
        },
        {
          label: 'Settings',
          icon: Settings,
          route: { name: 'settings', projectId, section: 'general' },
          match: ['settings'],
        },
      ],
    },
  ]
}

function BrandLockup() {
  return (
    <a
      className="mc-brand"
      href={href({ name: 'projects' })}
      aria-label="KissMyApps Merchant, all projects"
    >
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

function ProjectSwitcher({ current, onNavigate }: { current?: Project; onNavigate?: () => void }) {
  const { projects } = useStore()
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
            <strong>All projects</strong>
            <span className="mc-platforms">{projects.length} in this workspace</span>
          </span>
        )}
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="mc-switcher-menu">
          <ul>
            {projects.map((project) => (
              <li key={project.id}>
                <a
                  href={href({ name: 'overview', projectId: project.id })}
                  aria-current={project.id === current?.id ? 'page' : undefined}
                  onClick={() => {
                    setOpen(false)
                    onNavigate?.()
                  }}
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
            href={href({ name: 'projects' })}
            onClick={() => {
              setOpen(false)
              onNavigate?.()
            }}
          >
            <Plus size={16} aria-hidden="true" />
            All projects and new project
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
  if (!project) {
    return (
      <nav className="mc-nav" aria-label="Workspace">
        <ul>
          <li>
            <a href={href({ name: 'projects' })} aria-current="page" onClick={onNavigate}>
              <LayoutDashboard size={16} aria-hidden="true" />
              Projects
            </a>
          </li>
        </ul>
      </nav>
    )
  }
  return (
    <nav className="mc-nav" aria-label={`${project.name} sections`}>
      {projectNav(project.id).map((section, index) => (
        <div key={index} className="mc-nav-group">
          {section.group && <p className="mc-nav-label">{section.group}</p>}
          <ul>
            {section.items.map((item) => {
              const Icon = item.icon
              const active = item.match.includes(route.name)
              return (
                <li key={item.label}>
                  <a
                    href={href(item.route)}
                    aria-current={active ? 'page' : undefined}
                    onClick={onNavigate}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {item.label}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function Account() {
  const { session, signOut } = useStore()
  if (!session) return null
  return (
    <div className="mc-account">
      <span className="mc-avatar" aria-hidden="true">
        {session.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="mc-account-text">
        <strong>{session.name}</strong>
        <span>{session.merchant}</span>
      </span>
      <button type="button" className="mc-icon-btn" aria-label="Sign out" onClick={signOut}>
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
        <ProjectSwitcher current={project} />
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
          <ProjectSwitcher current={project} onNavigate={() => setMenuOpen(false)} />
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
