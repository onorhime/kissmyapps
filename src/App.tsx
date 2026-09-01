import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session, SupabaseClient, User } from '@supabase/supabase-js'
import {
  ArrowRight,
  Bell,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  Files,
  FlaskConical,
  LifeBuoy,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  WalletCards,
  X,
} from 'lucide-react'
import { Dialog } from './components/Dialog'
import { Brand } from './components/Brand'
import { Performance } from './features/partner/Performance'
import { WorkspaceContext } from './features/partner/WorkspaceContext'
import { Payouts } from './features/partner/Payouts'
import { Links } from './features/partner/Links'
import { Profile } from './features/partner/Profile'
import { AuthPreview } from './features/auth/AuthPreview'
import { useAuthSession } from './features/auth/authSession'
import {
  authErrorMessage,
  createPartnerAuthService,
  partnerAuth,
} from './features/auth/authService'
import type { PartnerActivationStatus, PartnerAuthService } from './features/auth/authService'
import {
  authScreenFromHash,
  inviteCallbackClearedUrl,
  inviteCallbackFromSearch,
  signupCallbackClearedUrl,
  signupCallbackFromSearch,
} from './features/auth/preview'
import type { AuthScreen } from './features/auth/preview'
import { defaultProfile, previewLinks } from './features/partner/data'
import type { PortalPage, PreviewLink, PreviewState, ProfileSection } from './features/partner/data'
import { changeLinkStatus } from './features/partner/linkData'
import type { PartnerDataGateway } from './features/partner/api'
import { LivePartnerPortal, PartnerLiveWorkspaceProvider } from './features/partner/live'
import { AdminPortalApp } from './features/admin'
import type { AdminGateway, AdminRoute } from './features/admin'
import {
  canonicalWorkspaceHash,
  initialWorkspace,
  productionWorkspaceForHostname,
  productionWorkspaceUrl,
} from './routing/workspace'
import type { Workspace } from './routing/workspace'
import './App.css'
import './features/partner/Reporting.css'
import './features/partner/Payouts.css'
import './features/partner/PartnerManagement.css'
import './brand.css'

const navigation = [
  { id: 'performance', label: 'Performance', icon: ChartNoAxesCombined },
  { id: 'payouts', label: 'Payouts', icon: WalletCards },
  { id: 'links', label: 'Links & Sources', icon: Link2 },
  { id: 'profile', label: 'Profile & Documents', icon: Files },
] as const

function currentPage(): PortalPage {
  const hash = window.location.hash.slice(1).split('/')[0]
  return navigation.some((item) => item.id === hash) ? (hash as PortalPage) : 'performance'
}

function currentProfileSection(): ProfileSection {
  const section = window.location.hash.slice(1).split('/')[1]
  return ['payment', 'terms', 'documents', 'security'].includes(section)
    ? (section as ProfileSection)
    : 'details'
}

function currentAdminRoute(): AdminRoute {
  const segments = window.location.hash.slice(1).split('/')
  if (segments[0] !== 'admin') return 'overview'
  if (segments[1] === 'products' && segments[2] && segments[3] === 'configuration') {
    return 'product-configuration'
  }
  if (segments[1] === 'affiliates' && segments[2]) {
    return currentAdminAffiliateId() ? 'affiliate-detail' : 'affiliates'
  }
  if (segments[1] === 'affiliates') return 'affiliates'
  if (segments[1] === 'funnels-links') return 'funnels-links'
  return segments[1] === 'products' ? 'products' : 'overview'
}

function currentAdminProductId(): string | null {
  const segments = window.location.hash.slice(1).split('/')
  if (
    segments[0] !== 'admin' ||
    segments[1] !== 'products' ||
    !segments[2] ||
    segments[3] !== 'configuration'
  ) {
    return null
  }
  try {
    return decodeURIComponent(segments[2])
  } catch {
    return null
  }
}

function currentAdminAffiliateId(): string | null {
  const segments = window.location.hash.slice(1).split('/')
  if (segments[0] !== 'admin' || segments[1] !== 'affiliates' || !segments[2]) return null
  try {
    return decodeURIComponent(segments[2])
  } catch {
    return null
  }
}

const fixtureAuth = createPartnerAuthService(null)

function partnerIdentity(user: User | null) {
  const fullName =
    typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : ''
  const publicName =
    typeof user?.user_metadata?.public_name === 'string' ? user.user_metadata.public_name : ''
  const name = publicName.trim() || fullName.trim() || 'Partner account'
  return {
    name,
    detail: user?.email ?? 'Authenticated partner',
    initial: name.slice(0, 1).toUpperCase() || 'P',
  }
}

type AppProps = {
  /** Explicitly injectable so App tests and the optional UI showroom never call Supabase. */
  previewMode?: boolean
  authClient?: SupabaseClient | null
  authService?: PartnerAuthService
  partnerGateway?: PartnerDataGateway
  adminGateway?: AdminGateway
  /** Injectable for hostname-routing tests without replacing jsdom's Location object. */
  workspaceHostname?: string
  /** Injectable so cross-origin production navigation is testable without leaving jsdom. */
  externalNavigate?: (url: string, mode: 'assign' | 'replace') => void
}

function navigateBrowser(url: string, mode: 'assign' | 'replace') {
  window.location[mode](url)
}

type InviteVerificationStatus = 'idle' | 'verifying' | 'ready' | 'error'
type SignupVerificationStatus = 'idle' | 'verifying' | 'error'
type ActivationStatus = PartnerActivationStatus | 'loading' | 'error'
type ActivationState = {
  userId: string | null
  status: ActivationStatus
}

function App({
  previewMode = import.meta.env.MODE === 'test' ||
    import.meta.env.VITE_ENABLE_UI_PREVIEW === 'true',
  authClient,
  authService = partnerAuth,
  partnerGateway,
  adminGateway,
  workspaceHostname = window.location.hostname,
  externalNavigate = navigateBrowser,
}: AppProps = {}) {
  const session = useAuthSession(previewMode ? null : authClient)
  const [initialInvite] = useState(() =>
    previewMode ? null : inviteCallbackFromSearch(window.location.search),
  )
  const [initialSignup] = useState(() =>
    previewMode ? null : signupCallbackFromSearch(window.location.search),
  )
  const transferSignupToPartner =
    !previewMode &&
    Boolean(initialSignup) &&
    productionWorkspaceForHostname(workspaceHostname) === 'admin'
  const inviteVerification = useRef<Promise<Session> | null>(null)
  const signupVerification = useRef<Promise<Session> | null>(null)
  const [authScreen, setAuthScreen] = useState<AuthScreen | null>(() =>
    initialInvite ? 'invite' : initialSignup ? 'sign-up' : authScreenFromHash(window.location.hash),
  )
  const [inviteStatus, setInviteStatus] = useState<InviteVerificationStatus>(() =>
    initialInvite ? 'verifying' : 'idle',
  )
  const [inviteError, setInviteError] = useState('')
  const [signupStatus, setSignupStatus] = useState<SignupVerificationStatus>(() =>
    initialSignup ? 'verifying' : 'idle',
  )
  const [signupError, setSignupError] = useState('')
  const [recoveryComplete, setRecoveryComplete] = useState(false)
  const [activationState, setActivationState] = useState<ActivationState>(() => ({
    userId: null,
    status: previewMode ? 'active' : 'loading',
  }))
  const [page, setPage] = useState<PortalPage>(currentPage)
  const [profileSection, setProfileSection] = useState<ProfileSection>(currentProfileSection)
  const [workspaceMode, setWorkspaceMode] = useState<Workspace>(() =>
    initialWorkspace({
      hash: window.location.hash,
      hostname: workspaceHostname,
      previewMode,
    }),
  )
  const [adminRoute, setAdminRoute] = useState<AdminRoute>(currentAdminRoute)
  const [adminProductId, setAdminProductId] = useState<string | null>(currentAdminProductId)
  const [adminAffiliateId, setAdminAffiliateId] = useState<string | null>(currentAdminAffiliateId)
  const [previewState, setPreviewState] = useState<PreviewState>(() =>
    previewMode ? 'sample' : 'error',
  )
  const [product, setProduct] = useState('sample-product')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [links, setLinks] = useState(previewLinks)
  const [reportLink, setReportLink] = useState<PreviewLink | null>(null)
  const [profile, setProfile] = useState(defaultProfile)
  const [toast, setToast] = useState('')
  const [signOutPending, setSignOutPending] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const previousView = useRef<string>(authScreen ?? page)
  const previewToolbar = useRef<HTMLDivElement>(null)
  const signOutErrorRef = useRef<HTMLDivElement>(null)
  const identity = useMemo(
    () =>
      previewMode
        ? { name: 'Preview partner', detail: 'UI preview account', initial: 'P' }
        : partnerIdentity(session.user),
    [previewMode, session.user],
  )
  const contextState = previewMode ? previewState : 'empty'
  const activationStatus = previewMode
    ? 'active'
    : session.status === 'authenticated' && activationState.userId === session.user?.id
      ? activationState.status
      : 'loading'
  const liveReporting = useMemo(() => {
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - 29)
    return {
      startsOn: start.toISOString().slice(0, 10),
      endsOn: end.toISOString().slice(0, 10),
      timezone: 'UTC',
      grain: 'day' as const,
      breakdown: 'date' as const,
    }
  }, [])
  const forcedPasswordScreen =
    !previewMode && session.status === 'authenticated' && session.recoveryMode && !recoveryComplete
      ? 'reset'
      : !previewMode &&
          session.status === 'authenticated' &&
          workspaceMode === 'partner' &&
          activationStatus !== 'active' &&
          authScreen !== 'reset' &&
          authScreen !== 'sign-up'
        ? 'invite'
        : null
  const requestedAuthScreen =
    forcedPasswordScreen ??
    authScreen ??
    (!previewMode && !['loading', 'authenticated'].includes(session.status) ? 'sign-in' : null)
  const effectiveAuthScreen =
    workspaceMode === 'admin' && requestedAuthScreen === 'sign-up' ? 'sign-in' : requestedAuthScreen

  useEffect(() => {
    if (previewMode || !initialInvite) return
    let active = true

    const verification =
      inviteVerification.current ?? authService.acceptInvite(initialInvite.tokenHash)
    inviteVerification.current = verification
    void verification
      .then(() => {
        if (!active) return
        setInviteStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        setInviteStatus('error')
        setInviteError(authErrorMessage(error))
      })
      .finally(() => {
        if (!active) return
        window.history.replaceState(null, '', inviteCallbackClearedUrl(window.location))
        setAuthScreen('invite')
      })

    return () => {
      active = false
    }
  }, [authService, initialInvite, previewMode])

  useEffect(() => {
    if (!transferSignupToPartner) return

    externalNavigate(productionWorkspaceUrl('partner', window.location), 'replace')
  }, [externalNavigate, transferSignupToPartner])

  useEffect(() => {
    if (previewMode || !initialSignup || transferSignupToPartner) return
    let active = true

    const verification =
      signupVerification.current ?? authService.confirmSignUp(initialSignup.tokenHash)
    signupVerification.current = verification
    void verification
      .then((confirmedSession) => {
        if (!active) return
        setWorkspaceMode('partner')
        setPage('performance')
        setActivationState({ userId: confirmedSession.user.id, status: 'active' })
        setAuthScreen(null)
        window.history.replaceState(
          null,
          '',
          signupCallbackClearedUrl(window.location, 'performance'),
        )
      })
      .catch((error) => {
        if (!active) return
        setSignupStatus('error')
        setSignupError(authErrorMessage(error))
        setAuthScreen('sign-up')
        window.history.replaceState(null, '', signupCallbackClearedUrl(window.location, 'sign-up'))
      })

    return () => {
      active = false
    }
  }, [authService, initialSignup, previewMode, transferSignupToPartner])

  useEffect(() => {
    if (
      previewMode ||
      session.status !== 'authenticated' ||
      !session.user?.id ||
      (initialSignup && signupStatus === 'verifying')
    ) {
      return
    }

    let active = true
    const authenticatedUserId = session.user?.id
    if (!authenticatedUserId) return
    void authService
      .getPartnerActivationStatus()
      .then((status) => {
        if (!active) return
        setActivationState({ userId: authenticatedUserId, status })
      })
      .catch((error) => {
        if (!active) return
        setActivationState({ userId: authenticatedUserId, status: 'error' })
        setInviteError(authErrorMessage(error))
      })

    return () => {
      active = false
    }
  }, [authService, initialSignup, previewMode, session.status, session.user?.id, signupStatus])

  useEffect(() => {
    if (
      previewMode ||
      transferSignupToPartner ||
      workspaceMode !== 'admin' ||
      authScreen !== 'sign-up'
    ) {
      return
    }
    window.history.replaceState(null, '', `${window.location.pathname}#auth/sign-in`)
  }, [authScreen, previewMode, transferSignupToPartner, workspaceMode])

  useEffect(() => {
    const replacement = canonicalWorkspaceHash({
      hash: window.location.hash,
      hostname: workspaceHostname,
    })
    if (!replacement) return

    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${replacement}`,
    )
  }, [previewMode, workspaceHostname])

  useEffect(() => {
    const onHashChange = () => {
      const replacement = canonicalWorkspaceHash({
        hash: window.location.hash,
        hostname: workspaceHostname,
      })
      if (replacement) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${replacement}`,
        )
      }
      const nextAuthScreen = authScreenFromHash(window.location.hash)
      setAuthScreen(nextAuthScreen)
      if (nextAuthScreen === 'reset') setRecoveryComplete(false)
      if (!nextAuthScreen) {
        const nextWorkspace = initialWorkspace({
          hash: window.location.hash,
          hostname: workspaceHostname,
          previewMode,
        })
        if (nextWorkspace === 'admin') {
          setWorkspaceMode('admin')
          setAdminRoute(currentAdminRoute())
          setAdminProductId(currentAdminProductId())
          setAdminAffiliateId(currentAdminAffiliateId())
        } else {
          setWorkspaceMode('partner')
          setPage(currentPage())
          setProfileSection(currentProfileSection())
        }
      }
      setMobileMenu(false)
      setHelpOpen(false)
      setNotificationsOpen(false)
      if (currentPage() !== 'performance') setReportLink(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [previewMode, workspaceHostname])

  useEffect(() => {
    const title = effectiveAuthScreen
      ? {
          'sign-in': previewMode ? 'Sign-in preview' : 'Sign in',
          'sign-up': previewMode ? 'Registration preview' : 'Create partner account',
          recover: previewMode ? 'Recovery preview' : 'Password recovery',
          reset: previewMode ? 'Password-reset preview' : 'Reset password',
          invite: previewMode ? 'Invitation preview' : 'Create password',
        }[effectiveAuthScreen]
      : workspaceMode === 'admin'
        ? adminRoute === 'overview'
          ? 'Admin overview'
          : adminRoute === 'products'
            ? 'Admin products'
            : adminRoute === 'affiliates'
              ? 'Admin affiliates'
              : adminRoute === 'funnels-links'
                ? 'Admin funnels & links'
                : adminRoute === 'affiliate-detail'
                  ? 'Affiliate details'
                  : 'Product configuration'
        : navigation.find((item) => item.id === page)?.label
    document.title = `${title} · KissMyApps ${workspaceMode === 'admin' ? 'Admin' : 'Partners'}`
    const view = effectiveAuthScreen ?? (workspaceMode === 'admin' ? `admin/${adminRoute}` : page)
    if (previousView.current !== view) {
      document.getElementById('main-content')?.focus({ preventScroll: true })
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    previousView.current = view
  }, [adminRoute, effectiveAuthScreen, page, previewMode, workspaceMode])

  useEffect(() => {
    const toolbar = previewToolbar.current
    if (!toolbar) return
    const updateHeight = () =>
      document.documentElement.style.setProperty(
        '--preview-toolbar-height',
        `${Math.ceil(toolbar.getBoundingClientRect().height)}px`,
      )
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(toolbar)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--preview-toolbar-height')
    }
  }, [effectiveAuthScreen])

  useEffect(() => {
    if (previewMode || authScreen || ['loading', 'authenticated'].includes(session.status)) return
    window.location.hash = 'auth/sign-in'
  }, [authScreen, previewMode, session.status])

  useEffect(() => {
    if (!signOutError) return
    signOutErrorRef.current?.focus({ preventScroll: true })
  }, [signOutError])

  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(''), 6000)
    return () => clearTimeout(timeout)
  }, [toast])

  function navigate(nextPage: PortalPage, section: ProfileSection = 'details') {
    setReportLink(null)
    setAuthScreen(null)
    setWorkspaceMode('partner')
    setPage(nextPage)
    setProfileSection(section)
    setMobileMenu(false)
    window.location.hash =
      nextPage === 'profile' && section !== 'details' ? `profile/${section}` : nextPage
  }

  function navigateAdmin(nextRoute: AdminRoute) {
    setAuthScreen(null)
    setWorkspaceMode('admin')
    setAdminRoute(nextRoute)
    if (nextRoute !== 'product-configuration') setAdminProductId(null)
    if (nextRoute !== 'affiliate-detail') setAdminAffiliateId(null)
    setMobileMenu(false)
    setHelpOpen(false)
    setNotificationsOpen(false)
    const routeHash =
      nextRoute === 'product-configuration'
        ? 'products'
        : nextRoute === 'affiliate-detail'
          ? adminAffiliateId
            ? `affiliates/${encodeURIComponent(adminAffiliateId)}`
            : 'affiliates'
          : nextRoute
    window.location.hash = `admin/${routeHash}`
  }

  function openAdminProductConfiguration(productId: string) {
    setAuthScreen(null)
    setWorkspaceMode('admin')
    setAdminRoute('product-configuration')
    setAdminProductId(productId)
    setMobileMenu(false)
    setHelpOpen(false)
    setNotificationsOpen(false)
    window.location.hash = `admin/products/${encodeURIComponent(productId)}/configuration`
  }

  function openAdminAffiliate(affiliateId: string) {
    setAuthScreen(null)
    setWorkspaceMode('admin')
    setAdminRoute('affiliate-detail')
    setAdminAffiliateId(affiliateId)
    setAdminProductId(null)
    setMobileMenu(false)
    setHelpOpen(false)
    setNotificationsOpen(false)
    window.location.hash = `admin/affiliates/${encodeURIComponent(affiliateId)}`
  }

  function openRequestedWorkspace() {
    if (workspaceMode === 'admin') navigateAdmin(adminRoute)
    else navigate('performance')
  }

  function switchToPartnerWorkspace() {
    if (productionWorkspaceForHostname(workspaceHostname) === 'admin') {
      externalNavigate(productionWorkspaceUrl('partner'), 'assign')
      return
    }
    navigate('performance')
  }

  function navigateAuth(screen: AuthScreen) {
    if (screen === 'recover' || screen === 'reset') setRecoveryComplete(false)
    if (screen === 'sign-up') {
      setSignupStatus('idle')
      setSignupError('')
    }
    setAuthScreen(screen)
    setMobileMenu(false)
    setHelpOpen(false)
    setNotificationsOpen(false)
    window.location.hash = `auth/${screen}`
  }

  async function signOut() {
    if (previewMode || signOutPending) return
    setSignOutPending(true)
    setSignOutError('')
    try {
      await authService.signOut()
      navigateAuth('sign-in')
    } catch (error) {
      setSignOutError(authErrorMessage(error))
    } finally {
      setSignOutPending(false)
    }
  }

  if (transferSignupToPartner) {
    return (
      <main className="session-loading" id="main-content" tabIndex={-1}>
        <LoaderCircle size={24} aria-hidden="true" />
        <p role="status">Opening secure Partner confirmation…</p>
      </main>
    )
  }

  if (!previewMode && !effectiveAuthScreen && session.status === 'loading') {
    return (
      <main className="session-loading" id="main-content" tabIndex={-1}>
        <LoaderCircle size={24} aria-hidden="true" />
        <p role="status">Checking your partner session…</p>
      </main>
    )
  }

  if (effectiveAuthScreen) {
    const effectiveInviteError =
      inviteError ||
      (activationStatus === 'none'
        ? 'This account does not have an active partner workspace. Contact KissMyApps for help.'
        : activationStatus === 'error'
          ? 'We could not verify this partner workspace. Refresh the page or contact KissMyApps for help.'
          : '')
    return (
      <AuthPreview
        key={effectiveAuthScreen}
        screen={effectiveAuthScreen}
        workspace={workspaceMode}
        onNavigate={navigateAuth}
        onOpenDashboard={openRequestedWorkspace}
        onActivationComplete={(activatedSession, activatedStatus) => {
          if (effectiveAuthScreen === 'reset') setRecoveryComplete(true)
          setActivationState({
            userId: workspaceMode === 'partner' ? activatedSession.user.id : null,
            status: workspaceMode === 'partner' ? activatedStatus : 'loading',
          })
          setInviteStatus('ready')
        }}
        authService={previewMode ? fixtureAuth : authService}
        sessionClient={previewMode ? null : authClient}
        sessionState={session}
        inviteStatus={inviteStatus}
        inviteError={effectiveInviteError}
        activationStatus={activationStatus}
        signupStatus={signupStatus}
        signupError={signupError}
      />
    )
  }

  if (workspaceMode === 'admin') {
    return (
      <AdminPortalApp
        route={adminRoute}
        productId={adminProductId}
        affiliateId={adminAffiliateId}
        sessionUserId={session.user?.id ?? null}
        gateway={adminGateway}
        identity={{
          name:
            typeof session.user?.user_metadata?.full_name === 'string'
              ? session.user.user_metadata.full_name
              : null,
          email: session.user?.email ?? null,
        }}
        onNavigate={navigateAdmin}
        onOpenProductConfiguration={openAdminProductConfiguration}
        onOpenAffiliate={openAdminAffiliate}
        onSwitchToPartner={switchToPartnerWorkspace}
        onSignOut={async () => {
          await authService.signOut()
          navigateAuth('sign-in')
        }}
      />
    )
  }

  const navContent = (
    <>
      <a
        className="brand"
        href="#performance"
        onClick={() => navigate('performance')}
        aria-label="KissMyApps Partners home"
      >
        <Brand context="Partners" />
      </a>
      <div className="workspace-switcher">
        <div className="workspace-monogram">P</div>
        <div>
          <strong>Partner workspace</strong>
          <span>Your space to grow</span>
        </div>
      </div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="Partner navigation">
        {navigation.map((item) => (
          <a
            href={`#${item.id}`}
            key={item.id}
            onClick={() => navigate(item.id)}
            className={`nav-item ${page === item.id ? 'nav-item-active' : ''}`}
            aria-current={page === item.id ? 'page' : undefined}
          >
            <item.icon size={18} strokeWidth={1.7} />
            <span>{item.label}</span>
            {page === item.id && <span className="nav-active-dot" />}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-help">
          <span className="help-orbit">
            <LifeBuoy size={20} />
          </span>
          <h3>Let’s grow together.</h3>
          <p>A little guidance goes a long way.</p>
          <button onClick={() => setHelpOpen(true)}>
            Partner guide <ArrowRight size={15} />
          </button>
        </div>
        <button className="sidebar-profile" onClick={() => navigate('profile')}>
          <span className="avatar avatar-sidebar">{identity.initial}</span>
          <span>
            <strong>{identity.name}</strong>
            <small>{identity.detail}</small>
          </span>
          <ChevronRight size={16} />
        </button>
      </div>
    </>
  )

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar desktop-sidebar" aria-label="Partner workspace sidebar">
        {navContent}
      </aside>
      <Dialog
        open={mobileMenu}
        onOpenChange={setMobileMenu}
        title="Partner workspace"
        description="Navigate your partner dashboard."
      >
        <nav className="mobile-navigation" aria-label="Mobile partner navigation">
          {navigation.map((item) => (
            <a
              href={`#${item.id}`}
              key={item.id}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <item.icon size={20} />
              {item.label}
              <ChevronRight size={16} />
            </a>
          ))}
        </nav>
      </Dialog>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu-button"
              onClick={() => setMobileMenu(true)}
              aria-label="Open navigation"
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb">
              <span className="breadcrumb-root">Workspace</span>
              <ChevronRight className="breadcrumb-separator" size={13} />{' '}
              <strong>{navigation.find((item) => item.id === page)?.label}</strong>
            </span>
          </div>
          <div className="topbar-actions">
            {previewMode && (
              <span className="preview-chip">
                <span />
                UI preview
              </span>
            )}
            <button
              className="icon-button notification-button"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen(true)}
            >
              <Bell size={19} />
            </button>
            <span className="header-divider" />
            <button
              className="avatar"
              aria-label="Open partner profile"
              onClick={() => navigate('profile')}
            >
              {identity.initial}
            </button>
            {!previewMode && (
              <button
                className="sign-out-button"
                aria-label={signOutPending ? 'Signing out' : 'Sign out'}
                onClick={() => void signOut()}
                disabled={signOutPending}
              >
                {signOutPending ? (
                  <LoaderCircle className="spin" size={17} aria-hidden="true" />
                ) : (
                  <LogOut size={17} aria-hidden="true" />
                )}
                <span>{signOutPending ? 'Signing out…' : 'Sign out'}</span>
              </button>
            )}
          </div>
        </header>
        <main
          className={`page-content ${previewMode ? '' : 'page-content-live'}`}
          id="main-content"
          tabIndex={-1}
        >
          {!previewMode ? (
            <PartnerLiveWorkspaceProvider
              sessionUserId={session.user?.id ?? null}
              reporting={liveReporting}
              gateway={partnerGateway}
              client={import.meta.env.MODE === 'test' && !partnerGateway ? null : undefined}
            >
              <LivePartnerPortal page={page} />
            </PartnerLiveWorkspaceProvider>
          ) : (
            <>
              <WorkspaceContext
                state={contextState}
                publicName={profile.publicName}
                product={product}
                onProductChange={setProduct}
              />
              {page === 'performance' && (
                <Performance
                  key={reportLink?.id ?? 'all-performance'}
                  state={previewState}
                  link={reportLink}
                  onClearLink={() => {
                    setReportLink(null)
                    document.getElementById('main-content')?.focus({ preventScroll: true })
                    window.scrollTo({ top: 0, behavior: 'auto' })
                  }}
                  navigate={navigate}
                  onRetry={() => setPreviewState('sample')}
                />
              )}
              {page === 'payouts' && (
                <Payouts
                  state={previewState}
                  navigate={navigate}
                  onRetry={() => setPreviewState('sample')}
                />
              )}
              {page === 'links' && (
                <Links
                  state={previewState}
                  links={links}
                  onAdd={(link) => setLinks((current) => [...current, link])}
                  onStatusChange={(id, action) =>
                    setLinks((current) =>
                      current.map((link) =>
                        link.id === id ? changeLinkStatus(link, action) : link,
                      ),
                    )
                  }
                  onViewPerformance={(link) => {
                    navigate('performance')
                    setReportLink(link)
                  }}
                  notify={setToast}
                  onRetry={() => setPreviewState('sample')}
                />
              )}
              {page === 'profile' && (
                <Profile
                  state={previewState}
                  profile={profile}
                  onSave={setProfile}
                  notify={setToast}
                  onRetry={() => setPreviewState('sample')}
                  section={profileSection}
                  onSectionChange={(section) => navigate('profile', section)}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>© 2026 KissMyApps</span>
            <span>
              Built for better partnerships.<span className="footer-dot">✳</span>
            </span>
          </footer>
        </main>
        {previewMode && (
          <div
            className="preview-toolbar"
            role="region"
            aria-label="UI preview controls"
            ref={previewToolbar}
          >
            <div className="preview-toolbar-copy">
              <FlaskConical size={17} />
              <span>
                <strong>Design preview</strong>
                <span>Sample data only. Not connected to Supabase.</span>
                <a
                  className="dashboard-auth-preview-link"
                  href="#auth/sign-in"
                  onClick={(event) => {
                    event.preventDefault()
                    navigateAuth('sign-in')
                  }}
                >
                  Explore sign-in preview <ArrowRight size={12} />
                </a>
              </span>
            </div>
            <div className="preview-toolbar-controls">
              <div className="preview-mode-toggle" aria-label="Preview dataset">
                <button
                  className={previewState === 'sample' ? 'selected' : ''}
                  aria-pressed={previewState === 'sample'}
                  onClick={() => setPreviewState('sample')}
                >
                  Sample data
                </button>
                <button
                  className={previewState === 'empty' ? 'selected' : ''}
                  aria-pressed={previewState === 'empty'}
                  onClick={() => setPreviewState('empty')}
                >
                  Empty account
                </button>
              </div>
              <label className="preview-state-select">
                <span className="sr-only">Preview data state</span>
                <select
                  value={
                    ['loading', 'error', 'partial'].includes(previewState)
                      ? previewState
                      : 'default'
                  }
                  onChange={(event) => setPreviewState(event.target.value as PreviewState)}
                >
                  <option value="default" disabled>
                    More states
                  </option>
                  <option value="loading">Loading</option>
                  <option value="error">Unavailable</option>
                  <option value="partial">Partial data</option>
                </select>
                <ChevronDown size={12} />
              </label>
            </div>
          </div>
        )}
      </div>
      <Dialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Your partner guide"
        description="A quick tour of your KissMyApps workspace."
      >
        <div className="guide-list">
          {navigation.map((item, index) => (
            <button
              key={item.id}
              onClick={() => {
                navigate(item.id)
                setHelpOpen(false)
              }}
            >
              <span>0{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                <p>
                  {
                    [
                      'Understand traffic, conversions, and partner earnings.',
                      'Follow earnings through review, approval, and payment.',
                      'Find your tracked links and compare traffic sources.',
                      'Keep your details and partnership documents together.',
                    ][index]
                  }
                </p>
              </div>
              <ArrowRight size={17} />
            </button>
          ))}
        </div>
        {previewMode && (
          <p className="inline-note">
            This is a UI preview. No support requests or account changes are submitted.
          </p>
        )}
      </Dialog>
      <Dialog
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        title="Notifications"
        description="Account updates will be collected here."
      >
        <div className="table-empty">
          <Bell size={28} />
          <h3>You’re all caught up</h3>
          <p>Payout and document updates will appear here when they are available.</p>
        </div>
      </Dialog>
      <div className={`toast-region ${previewMode ? '' : 'toast-region-live'}`}>
        {signOutError && (
          <div className="toast toast-error" role="alert" ref={signOutErrorRef} tabIndex={-1}>
            <X size={17} aria-hidden="true" />
            <span>{signOutError}</span>
            <button
              className="icon-button"
              onClick={() => setSignOutError('')}
              aria-label="Dismiss sign-out error"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={17} />
            <span>{toast}</span>
            <button
              className="icon-button"
              onClick={() => setToast('')}
              aria-label="Dismiss notification"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
