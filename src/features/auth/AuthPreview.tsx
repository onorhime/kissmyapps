import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  ChartNoAxesCombined,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  Leaf,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserPlus,
  WalletCards,
} from 'lucide-react'
import { Brand } from '../../components/Brand'
import { authErrorMessage, partnerAuth } from './authService'
import type { PartnerActivationStatus, PartnerAuthService } from './authService'
import { useAuthSession } from './authSession'
import type { AuthSessionState } from './authSession'
import { validateEmail, validateReset, validateSignIn, validateSignUp } from './preview'
import type { AuthErrors, AuthField, AuthScreen } from './preview'
import './AuthPreview.css'

type Props = {
  screen: AuthScreen
  workspace?: 'partner' | 'admin'
  onNavigate: (screen: AuthScreen) => void
  onOpenDashboard: () => void
  onActivationComplete?: (
    session: Session,
    activationStatus: Exclude<PartnerActivationStatus, 'pending'>,
  ) => void
  authService?: PartnerAuthService
  sessionClient?: SupabaseClient | null
  sessionState?: AuthSessionState
  inviteStatus?: 'idle' | 'verifying' | 'ready' | 'error'
  inviteError?: string
  activationStatus?: PartnerActivationStatus | 'loading' | 'error'
  signupStatus?: 'idle' | 'verifying' | 'error'
  signupError?: string
}

type SuccessResult = {
  title: string
  eyebrow: string
  message: string
}

const screenCopy = {
  'sign-in': {
    eyebrow: 'YOUR PARTNER WORKSPACE',
    title: 'Welcome back.',
    description: 'A clear view of your traffic, earnings, and next steps.',
  },
  'sign-up': {
    eyebrow: 'JOIN KISSMYAPPS PARTNERS',
    title: 'Create your partner account.',
    description: 'Start with a secure account. Products and partner opportunities can follow.',
  },
  recover: {
    eyebrow: 'A LITTLE HELP GETTING BACK',
    title: 'Forgot your password?',
    description: 'Request a secure recovery link for your partner workspace.',
  },
  reset: {
    eyebrow: 'A FRESH START',
    title: 'Choose a new password.',
    description: 'Use your verified recovery session to secure your account.',
  },
  invite: {
    eyebrow: 'WELCOME TO KISSMYAPPS',
    title: 'Create your password.',
    description: 'Finish securing your invitation before opening your partner workspace.',
  },
}

export function AuthPreview({
  screen,
  workspace = 'partner',
  onNavigate,
  onOpenDashboard,
  onActivationComplete,
  authService = partnerAuth,
  sessionClient,
  sessionState,
  inviteStatus = 'idle',
  inviteError = '',
  activationStatus = 'none',
  signupStatus = 'idle',
  signupError = '',
}: Props) {
  const observedSession = useAuthSession(sessionClient)
  const session = sessionState ?? observedSession
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [errors, setErrors] = useState<AuthErrors>({})
  const [serviceError, setServiceError] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<SuccessResult | null>(null)
  const [signedInByOperation, setSignedInByOperation] = useState(false)
  const errorFocus = useRef<AuthField | null>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const formHeading = useRef<HTMLHeadingElement>(null)
  const serviceErrorRef = useRef<HTMLParagraphElement>(null)
  const restoreFormFocus = useRef(false)
  const fields = useRef<Partial<Record<AuthField, HTMLInputElement | null>>>({})
  const copy =
    workspace === 'admin' && screen === 'sign-in'
      ? {
          eyebrow: 'YOUR ADMIN WORKSPACE',
          title: 'Welcome back.',
          description: 'Manage products and prepare the platform for what comes next.',
        }
      : workspace === 'admin' && screen === 'recover'
        ? {
            eyebrow: 'A SECURE WAY BACK',
            title: 'Forgot your password?',
            description: 'Request a secure recovery link for your admin account.',
          }
        : workspace === 'admin' && screen === 'reset'
          ? {
              eyebrow: 'SECURE ADMIN ACCESS',
              title: 'Choose a new password.',
              description: 'Use your verified recovery session to secure your admin account.',
            }
          : screenCopy[screen]
  const workspaceLabel = workspace === 'admin' ? 'admin' : 'partner'
  const workspaceLabelTitle = workspace === 'admin' ? 'Admin' : 'Partner'
  const isPasswordSetup = screen === 'reset' || screen === 'invite'
  const isSignUp = screen === 'sign-up'
  const isAuthenticated = session.status === 'authenticated' || signedInByOperation
  const sessionUnavailable = session.status === 'unconfigured' || session.status === 'error'
  const signedInResult =
    screen === 'sign-in' && isAuthenticated && !result
      ? {
          eyebrow: 'ACCOUNT READY',
          title: 'You’re signed in.',
          message: `Your secure ${workspaceLabel} session is ready. Continue to your dashboard.`,
        }
      : null
  const completedInviteResult =
    screen === 'invite' && activationStatus === 'active' && inviteStatus !== 'verifying' && !result
      ? {
          eyebrow: 'ACCOUNT READY',
          title: 'Your invitation is complete.',
          message: 'Your partner account is active. Continue to your dashboard.',
        }
      : null
  const visibleResult = result ?? signedInResult ?? completedInviteResult
  const setupPending = screen === 'invite' || (screen === 'reset' && activationStatus === 'pending')
  const showDashboardNavigation = isAuthenticated && (!setupPending || Boolean(visibleResult))

  useEffect(() => {
    if (errorFocus.current) {
      const field = fields.current[errorFocus.current]
      field?.focus({ preventScroll: true })
      field?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
      errorFocus.current = null
    }
  }, [errors])

  useEffect(() => {
    if (serviceError) {
      serviceErrorRef.current?.focus({ preventScroll: true })
      serviceErrorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
    }
  }, [serviceError])

  useEffect(() => {
    if (visibleResult) {
      resultHeading.current?.focus({ preventScroll: true })
      resultHeading.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
    } else if (restoreFormFocus.current) {
      formHeading.current?.focus({ preventScroll: true })
      formHeading.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' })
      restoreFormFocus.current = false
    }
  }, [visibleResult])

  function clearSecrets() {
    setPassword('')
    setConfirmation('')
    setShowPassword(false)
    setShowConfirmation(false)
  }

  function restart() {
    restoreFormFocus.current = true
    setEmail('')
    setFullName('')
    setAcceptedTerms(false)
    clearSecrets()
    setErrors({})
    setServiceError('')
    setResult(null)
  }

  function updateField(field: AuthField, value: string) {
    if (field === 'fullName') setFullName(value)
    if (field === 'email') setEmail(value)
    if (field === 'password') setPassword(value)
    if (field === 'confirmation') setConfirmation(value)
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
    if (serviceError) setServiceError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || sessionUnavailable) return

    const emailError = screen === 'recover' ? validateEmail(email) : undefined
    const nextErrors =
      screen === 'sign-in'
        ? validateSignIn(email, password)
        : screen === 'sign-up'
          ? validateSignUp({ fullName, email, password, confirmation, acceptedTerms })
          : isPasswordSetup
            ? validateReset(password, confirmation)
            : emailError
              ? { email: emailError }
              : {}
    const firstError = (['fullName', 'email', 'password', 'confirmation', 'terms'] as const).find(
      (field) => nextErrors[field],
    )
    if (firstError) {
      errorFocus.current = firstError
      setErrors(nextErrors)
      return
    }

    const passwordSessionReady =
      session.status === 'authenticated' &&
      ((screen === 'reset' && session.recoveryMode) ||
        (screen === 'invite' && (inviteStatus === 'ready' || activationStatus === 'pending')))
    if (isPasswordSetup && !passwordSessionReady) return

    setPending(true)
    setServiceError('')
    try {
      if (screen === 'sign-in') {
        const authenticated = await authService.signIn(email, password)
        clearSecrets()
        onActivationComplete?.(authenticated.session, authenticated.activationStatus)
        setSignedInByOperation(true)
        setResult({
          eyebrow: 'ACCOUNT READY',
          title: 'You’re signed in.',
          message: `Your secure ${workspaceLabel} session is ready. Continue to your dashboard.`,
        })
      } else if (screen === 'sign-up') {
        await authService.signUp({ fullName, email, password })
        clearSecrets()
        setResult({
          eyebrow: 'CONFIRMATION REQUESTED',
          title: 'Check your email.',
          message:
            'If this address can be registered, a confirmation link will arrive shortly. Open it to finish registration and enter your partner dashboard.',
        })
      } else if (screen === 'recover') {
        await authService.requestPasswordRecovery(email)
        setEmail('')
        setResult({
          eyebrow: 'REQUEST RECEIVED',
          title: 'Check your email.',
          message: `If that address belongs to an eligible ${workspaceLabel} account, a password-recovery link will arrive shortly.`,
        })
      } else {
        const authenticated = await authService.updatePassword(password)
        clearSecrets()
        onActivationComplete?.(authenticated.session, authenticated.activationStatus)
        setResult({
          eyebrow: screen === 'invite' ? 'ACCOUNT ACTIVATED' : 'PASSWORD UPDATED',
          title: screen === 'invite' ? 'Your partner account is ready.' : 'Your password is ready.',
          message:
            screen === 'invite'
              ? 'Your password was created securely. You can continue to your partner dashboard.'
              : `Your password was changed securely. You can continue to your ${workspaceLabel} dashboard.`,
        })
      }
    } catch (error) {
      setServiceError(authErrorMessage(error))
    } finally {
      setPending(false)
    }
  }

  function passwordField(field: 'password' | 'confirmation', label: string) {
    const revealed = field === 'password' ? showPassword : showConfirmation
    const toggle = field === 'password' ? setShowPassword : setShowConfirmation
    const usesNewPasswordRules = isPasswordSetup || isSignUp
    return (
      <div className="auth-field">
        <label htmlFor={`auth-${field}`}>{label}</label>
        <div className={`auth-password-field ${errors[field] ? 'auth-input-invalid' : ''}`}>
          <input
            id={`auth-${field}`}
            name={field}
            ref={(element) => {
              fields.current[field] = element
            }}
            type={revealed ? 'text' : 'password'}
            value={field === 'password' ? password : confirmation}
            onChange={(event) => updateField(field, event.target.value)}
            autoComplete={usesNewPasswordRules ? 'new-password' : 'current-password'}
            maxLength={128}
            placeholder={
              field === 'confirmation' ? 'Repeat your new password' : 'Enter your password'
            }
            disabled={pending}
            required
            aria-invalid={Boolean(errors[field])}
            aria-describedby={
              errors[field]
                ? `${field}-error`
                : usesNewPasswordRules && field === 'password'
                  ? 'password-rule'
                  : undefined
            }
          />
          <button
            type="button"
            className="auth-reveal"
            aria-label={`${revealed ? 'Hide' : 'Show'} ${field === 'confirmation' ? 'confirmation password' : 'password'}`}
            aria-pressed={revealed}
            disabled={pending}
            onClick={() => toggle(!revealed)}
          >
            {revealed ? <EyeOff size={19} /> : <Eye size={19} />}
          </button>
        </div>
        {errors[field] && (
          <p className="auth-field-error" id={`${field}-error`}>
            {errors[field]}
          </p>
        )}
        {usesNewPasswordRules && field === 'password' && (
          <p className="auth-field-hint" id="password-rule">
            Use at least 12 characters. A unique passphrase is easiest to remember.
          </p>
        )}
      </div>
    )
  }

  const resetBlocked =
    screen === 'reset' &&
    !pending &&
    !serviceError &&
    (session.status !== 'authenticated' || !session.recoveryMode)
  const resetFailedAfterRotation =
    screen === 'reset' &&
    Boolean(serviceError) &&
    session.status === 'authenticated' &&
    !session.recoveryMode
  const inviteReady =
    screen === 'invite' &&
    session.status === 'authenticated' &&
    (inviteStatus === 'ready' || activationStatus === 'pending')
  const inviteWaiting =
    screen === 'invite' &&
    (inviteStatus === 'verifying' ||
      (activationStatus === 'loading' && session.status === 'authenticated') ||
      (inviteStatus === 'ready' && session.status !== 'authenticated' && !sessionUnavailable))
  const inviteBlocked = screen === 'invite' && !inviteWaiting && !inviteReady
  const signupWaiting = screen === 'sign-up' && signupStatus === 'verifying'
  const signupBlocked = screen === 'sign-up' && signupStatus === 'error'

  return (
    <div className="auth-shell">
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
      <header className="auth-header">
        <a
          className="brand auth-brand"
          href={showDashboardNavigation ? '#performance' : '#auth/sign-in'}
          onClick={(event) => {
            if (!showDashboardNavigation) return
            event.preventDefault()
            onOpenDashboard()
          }}
          aria-label={`KissMyApps ${workspaceLabelTitle}`}
        >
          <Brand context={workspace === 'admin' ? 'Admin' : 'Partners'} />
        </a>
        {showDashboardNavigation ? (
          <a
            className="auth-dashboard-link"
            href="#performance"
            onClick={(event) => {
              event.preventDefault()
              onOpenDashboard()
            }}
          >
            <ArrowLeft size={16} />
            Open {workspaceLabel} dashboard
          </a>
        ) : (
          <span className="auth-access-label">
            <ShieldCheck size={16} />{' '}
            {workspace === 'admin' ? 'Protected admin access' : 'Secure partner access'}
          </span>
        )}
      </header>
      <main id="main-content" className="auth-layout" tabIndex={-1}>
        <aside className="auth-story" aria-label={`About your ${workspaceLabel} workspace`}>
          <span className="auth-story-label">
            <span />
            {workspace === 'admin'
              ? 'THE PLATFORM SIDE OF POSSIBILITY'
              : 'THE PARTNER SIDE OF POSSIBILITY'}
          </span>
          <h2>
            {workspace === 'admin' ? 'Clear operations.' : 'Good partnerships.'}
            <br />
            {workspace === 'admin' ? 'Better launches' : 'Clear possibilities'}
            <span>.</span>
          </h2>
          <p>
            {workspace === 'admin'
              ? 'Create the product foundation now, then connect funnels, partners, and data when each part is ready.'
              : 'Your work deserves a clear picture. Bring your links, results, and rewards into one workspace.'}
          </p>
          <div className="auth-story-visual" aria-hidden="true">
            <div className="auth-orbit auth-orbit-one" />
            <div className="auth-orbit auth-orbit-two" />
            <div className="auth-orbit-center">
              <Leaf size={46} strokeWidth={1.4} />
            </div>
            <span className="auth-orbit-tag auth-orbit-tag-one">
              <ChartNoAxesCombined size={17} />
              {workspace === 'admin' ? 'Product catalog' : 'Your progress'}
            </span>
            <span className="auth-orbit-tag auth-orbit-tag-two">
              <WalletCards size={17} />
              {workspace === 'admin' ? 'Protected actions' : 'Your rewards'}
            </span>
            <span className="auth-orbit-tag auth-orbit-tag-three">
              <Link2 size={17} />
              {workspace === 'admin' ? 'Launch readiness' : 'Your connections'}
            </span>
          </div>
          <div className="auth-story-footer">
            <BadgeCheck size={20} />
            <span>
              {workspace === 'admin'
                ? 'Built for focused operations.'
                : 'Built for better partnerships.'}
              <br />
              <small>
                {workspace === 'admin'
                  ? 'Protected tools. Deliberate releases.'
                  : 'Thoughtful tools. A shared direction.'}
              </small>
            </span>
          </div>
        </aside>
        <section className="auth-form-panel" aria-label={`${workspaceLabelTitle} account access`}>
          <div className="auth-preview-notice" id="auth-security-notice">
            <ShieldCheck size={20} />
            <div>
              <strong>Secure {workspaceLabel} access</strong>
              <p>
                Registration, sign-in sessions, and password recovery are protected by Supabase
                Auth.
              </p>
            </div>
          </div>

          {visibleResult ? (
            <div className="auth-result" role="status">
              <span className="auth-result-icon">
                {screen === 'recover' || screen === 'sign-up' ? (
                  <Mail size={27} />
                ) : (
                  <Check size={27} />
                )}
              </span>
              <p className="eyebrow">{visibleResult.eyebrow}</p>
              <h1 ref={resultHeading} tabIndex={-1}>
                {visibleResult.title}
              </h1>
              <p>{visibleResult.message}</p>
              {screen === 'recover' || screen === 'sign-up' ? (
                <button
                  className="button button-green auth-primary"
                  onClick={() => onNavigate('sign-in')}
                >
                  Back to sign in <ArrowRight size={17} />
                </button>
              ) : (
                <button className="button button-green auth-primary" onClick={onOpenDashboard}>
                  Open {workspaceLabel} dashboard <ArrowRight size={17} />
                </button>
              )}
              {(screen === 'recover' || screen === 'sign-up') && (
                <button className="auth-text-link" onClick={restart}>
                  {screen === 'sign-up'
                    ? 'Start another registration'
                    : 'Try another email address'}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="auth-heading">
                <span className="auth-heading-icon">
                  {screen === 'recover' ? (
                    <Mail size={23} />
                  ) : screen === 'sign-up' ? (
                    <UserPlus size={23} />
                  ) : isPasswordSetup ? (
                    <KeyRound size={23} />
                  ) : (
                    <LockKeyhole size={23} />
                  )}
                </span>
                <p className="eyebrow">{copy.eyebrow}</p>
                <h1 ref={formHeading} tabIndex={-1}>
                  {copy.title}
                </h1>
                <p>{copy.description}</p>
              </div>

              {session.status === 'loading' && (
                <p className="auth-session-status" role="status">
                  <LoaderCircle size={18} className="auth-spinner" /> Verifying your session…
                </p>
              )}

              {sessionUnavailable && (
                <p className="auth-service-error" role="alert">
                  <CircleAlert size={18} />
                  <span>
                    {session.message ??
                      `${workspaceLabelTitle} sign-in is temporarily unavailable.`}
                  </span>
                </p>
              )}

              {signupWaiting ? (
                <div className="auth-reset-blocked" role="status">
                  <LoaderCircle size={26} className="auth-spinner" />
                  <h2>Confirming your email…</h2>
                  <p>Keep this page open while we securely prepare your partner dashboard.</p>
                </div>
              ) : signupBlocked ? (
                <div className="auth-reset-blocked" role="alert">
                  <CircleAlert size={26} />
                  <h2>This confirmation link can’t be used.</h2>
                  <p>
                    {signupError ||
                      'The link may have expired or already been used. Start a new registration, or sign in if your email is already confirmed.'}
                  </p>
                  <button className="button button-white" onClick={() => onNavigate('sign-up')}>
                    Start a new registration <ArrowRight size={15} />
                  </button>
                </div>
              ) : inviteWaiting ? (
                <div className="auth-reset-blocked" role="status">
                  <LoaderCircle size={26} className="auth-spinner" />
                  <h2>Verifying your invitation…</h2>
                  <p>Keep this page open while we securely prepare your partner account.</p>
                </div>
              ) : inviteBlocked ? (
                <div className="auth-reset-blocked" role={inviteError ? 'alert' : 'status'}>
                  <CircleAlert size={26} />
                  <h2>This invitation link can’t be used.</h2>
                  <p>
                    {inviteError ||
                      'The invitation may have expired or already been accepted. Use password recovery if this is your account.'}
                  </p>
                  <button className="button button-white" onClick={() => onNavigate('recover')}>
                    Use password recovery <ArrowRight size={15} />
                  </button>
                </div>
              ) : resetFailedAfterRotation ? (
                <div className="auth-reset-blocked" role="alert">
                  <CircleAlert size={26} />
                  <h2>Sign in with your new password.</h2>
                  <p>{serviceError}</p>
                  <button className="button button-white" onClick={() => onNavigate('sign-in')}>
                    Back to sign in <ArrowRight size={15} />
                  </button>
                </div>
              ) : resetBlocked ? (
                session.status !== 'loading' && (
                  <div className="auth-reset-blocked" role="status">
                    <ShieldCheck size={26} />
                    <h2>A recovery link is required.</h2>
                    <p>
                      Open the latest password-recovery link sent to your email. If it has expired,
                      request a new one.
                    </p>
                    <button className="button button-white" onClick={() => onNavigate('recover')}>
                      Request a recovery link <ArrowRight size={15} />
                    </button>
                  </div>
                )
              ) : (
                <form className="auth-form" onSubmit={submit} noValidate aria-busy={pending}>
                  {Object.values(errors).some(Boolean) && (
                    <p className="auth-error-summary" role="alert">
                      <CircleAlert size={17} />
                      Check the highlighted fields to continue.
                    </p>
                  )}
                  {serviceError && (
                    <p
                      className="auth-service-error"
                      role="alert"
                      tabIndex={-1}
                      ref={serviceErrorRef}
                    >
                      <CircleAlert size={18} />
                      <span>{serviceError}</span>
                    </p>
                  )}
                  {isSignUp && (
                    <div className="auth-field">
                      <label htmlFor="auth-full-name">Full name</label>
                      <input
                        id="auth-full-name"
                        name="fullName"
                        type="text"
                        autoComplete="name"
                        ref={(element) => {
                          fields.current.fullName = element
                        }}
                        value={fullName}
                        onChange={(event) => updateField('fullName', event.target.value)}
                        placeholder="Your full name"
                        maxLength={120}
                        disabled={pending || sessionUnavailable}
                        required
                        aria-invalid={Boolean(errors.fullName)}
                        aria-describedby={errors.fullName ? 'full-name-error' : undefined}
                      />
                      {errors.fullName && (
                        <p className="auth-field-error" id="full-name-error">
                          {errors.fullName}
                        </p>
                      )}
                    </div>
                  )}
                  {!isPasswordSetup && (
                    <div className="auth-field">
                      <label htmlFor="auth-email">Email address</label>
                      <input
                        id="auth-email"
                        name="email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        ref={(element) => {
                          fields.current.email = element
                        }}
                        value={email}
                        onChange={(event) => updateField('email', event.target.value)}
                        placeholder="partner@example.com"
                        maxLength={254}
                        disabled={pending || sessionUnavailable}
                        required
                        aria-invalid={Boolean(errors.email)}
                        aria-describedby={errors.email ? 'email-error' : undefined}
                      />
                      {errors.email && (
                        <p className="auth-field-error" id="email-error">
                          {errors.email}
                        </p>
                      )}
                    </div>
                  )}
                  {screen !== 'recover' &&
                    passwordField('password', isPasswordSetup ? 'New password' : 'Password')}
                  {(isPasswordSetup || isSignUp) &&
                    passwordField(
                      'confirmation',
                      isPasswordSetup ? 'Confirm new password' : 'Confirm password',
                    )}
                  {isSignUp && (
                    <div className="auth-consent-field">
                      <label className="auth-consent" htmlFor="auth-terms">
                        <input
                          id="auth-terms"
                          name="terms"
                          type="checkbox"
                          ref={(element) => {
                            fields.current.terms = element
                          }}
                          checked={acceptedTerms}
                          onChange={(event) => {
                            setAcceptedTerms(event.target.checked)
                            if (errors.terms) {
                              setErrors((current) => ({ ...current, terms: undefined }))
                            }
                            if (serviceError) setServiceError('')
                          }}
                          disabled={pending}
                          required
                          aria-invalid={Boolean(errors.terms)}
                          aria-describedby={errors.terms ? 'terms-error' : 'terms-detail'}
                        />
                        <span id="terms-detail">
                          I confirm that I am at least 18 and agree to the{' '}
                          <a href="https://kissmyapps.dev/terms" target="_blank" rel="noreferrer">
                            Terms and Conditions
                          </a>{' '}
                          and acknowledge the{' '}
                          <a href="https://kissmyapps.dev/privacy" target="_blank" rel="noreferrer">
                            Privacy Policy
                          </a>
                          .
                        </span>
                      </label>
                      {errors.terms && (
                        <p className="auth-field-error" id="terms-error">
                          {errors.terms}
                        </p>
                      )}
                    </div>
                  )}
                  {screen === 'sign-in' && (
                    <a
                      className="auth-forgot-link"
                      href="#auth/recover"
                      onClick={(event) => {
                        event.preventDefault()
                        onNavigate('recover')
                      }}
                    >
                      Forgot password?
                    </a>
                  )}
                  <button
                    type="submit"
                    className="button button-green auth-primary"
                    disabled={pending || session.status === 'loading' || sessionUnavailable}
                  >
                    {pending ? (
                      <>
                        <LoaderCircle size={17} className="auth-spinner" />
                        {screen === 'sign-in'
                          ? 'Signing in…'
                          : screen === 'sign-up'
                            ? 'Creating account…'
                            : screen === 'recover'
                              ? 'Sending recovery link…'
                              : screen === 'invite'
                                ? 'Setting password…'
                                : 'Updating password…'}
                      </>
                    ) : (
                      <>
                        {screen === 'sign-in'
                          ? 'Sign in'
                          : screen === 'sign-up'
                            ? 'Create partner account'
                            : screen === 'recover'
                              ? 'Send recovery link'
                              : screen === 'invite'
                                ? 'Set password'
                                : 'Update password'}
                        <ArrowRight size={17} />
                      </>
                    )}
                  </button>
                </form>
              )}
              {screen !== 'sign-in' && screen !== 'invite' && (
                <a
                  className="auth-back-link"
                  href="#auth/sign-in"
                  onClick={(event) => {
                    event.preventDefault()
                    onNavigate('sign-in')
                  }}
                >
                  <ArrowLeft size={15} />
                  Back to sign in
                </a>
              )}
              {screen === 'sign-in' && (
                <p className="auth-invite-note">
                  {workspace === 'admin'
                    ? 'Admin accounts are provisioned by the KissMyApps team. There is no public sign-up.'
                    : 'New to KissMyApps? '}
                  {workspace === 'partner' && (
                    <a
                      href="#auth/sign-up"
                      onClick={(event) => {
                        event.preventDefault()
                        onNavigate('sign-up')
                      }}
                    >
                      Create a partner account
                    </a>
                  )}
                </p>
              )}
            </>
          )}
          <div className="auth-preview-footer">
            <span>
              <LockKeyhole size={14} />
              Protected account session
            </span>
          </div>
        </section>
      </main>
      <footer className="auth-page-footer">
        <span>© 2026 KissMyApps</span>
        <span>{workspaceLabelTitle} workspace · Secure access</span>
      </footer>
    </div>
  )
}
