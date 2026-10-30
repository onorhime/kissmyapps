import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { CircleAlert, LoaderCircle, MailCheck, Play } from 'lucide-react'
import { href, navigate } from '../routes'
import type { AuthRoute } from '../routes'
import { useStore } from '../store'
import { Avatar, Field } from '../ui/Primitives'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function FormError({ message }: { message?: string }) {
  return message ? (
    <p className="mc-form-error" role="alert">
      {message}
    </p>
  ) : null
}

function Submit({ busy, idle, working }: { busy: boolean; idle: string; working: string }) {
  return (
    <button type="submit" className="mc-btn mc-btn-primary mc-btn-wide" disabled={busy}>
      {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
      {busy ? working : idle}
    </button>
  )
}

function SignIn() {
  const { signIn } = useStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const { busy, error, run } = useSubmit()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      email: emailPattern.test(email.trim())
        ? undefined
        : 'Enter the email you use for your merchant account.',
      password: password ? undefined : 'Enter your password.',
    }
    setErrors(next)
    if (next.email || next.password) return
    void run(() => signIn(email.trim(), password))
  }

  return (
    <form className="mc-auth-form" onSubmit={submit} noValidate>
      <div className="mc-auth-intro">
        <h1>Sign in to your merchant workspace</h1>
        <p>See who uses your apps, where they are, what they do, and watch their sessions.</p>
      </div>
      <FormError message={error} />
      <Field label="Work email" error={errors.email}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field label="Password" error={errors.password}>
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      {error?.startsWith('Confirm your email first') && emailPattern.test(email.trim()) && (
        <ResendConfirmation email={email.trim()} label="Send the confirmation email again" />
      )}
      <a className="mc-link mc-auth-forgot" href={href({ name: 'recover' })}>
        Forgot your password?
      </a>
      <Submit busy={busy} idle="Sign in" working="Signing in" />
      <p className="mc-auth-switch">
        New to KissMyApps Merchant?{' '}
        <a className="mc-link" href={href({ name: 'sign-up' })}>
          Create an account
        </a>
      </p>
    </form>
  )
}

/** Sends the sign-up confirmation email again, for a link that expired or never arrived. */
function ResendConfirmation({
  email,
  label = 'Send the email again',
}: {
  email: string
  label?: string
}) {
  const { resendConfirmation } = useStore()
  const [sent, setSent] = useState(false)
  const { busy, error, run } = useSubmit()
  return (
    <div className="mc-auth-resend">
      <FormError message={error} />
      {sent ? (
        <p className="mc-muted" role="status">
          Sent again to <strong>{email}</strong>. The newest link is the one that works.
        </p>
      ) : (
        <button
          type="button"
          className="mc-btn mc-btn-secondary mc-btn-wide"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await resendConfirmation(email)
              setSent(true)
            })
          }
        >
          {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
          {busy ? 'Sending' : label}
        </button>
      )}
    </div>
  )
}

function CheckInbox({
  email,
  children,
  resend = false,
}: {
  email: string
  children: ReactNode
  resend?: boolean
}) {
  return (
    <div className="mc-auth-form">
      <MailCheck size={28} className="mc-auth-icon" aria-hidden="true" />
      <div className="mc-auth-intro">
        <h1 tabIndex={-1} id="mc-page-title">
          Check your inbox
        </h1>
        <p>
          We sent an email to <strong>{email}</strong>. {children}
        </p>
      </div>
      {resend && <ResendConfirmation email={email} label="Did not get it? Send it again" />}
      <a className="mc-btn mc-btn-secondary mc-btn-wide" href={href({ name: 'sign-in' })}>
        Back to sign in
      </a>
    </div>
  )
}

function SignUp({ email: invitedEmail, invited = false }: { email?: string; invited?: boolean }) {
  const { signUp } = useStore()
  const [values, setValues] = useState({
    name: '',
    company: '',
    email: invitedEmail ?? '',
    password: '',
  })
  const [errors, setErrors] = useState<Partial<Record<keyof typeof values, string>>>({})
  const [confirmTo, setConfirmTo] = useState<string>()
  const { busy, error, run } = useSubmit()
  const set = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }))

  if (confirmTo) {
    return (
      <CheckInbox email={confirmTo} resend>
        Open the link in it to confirm your address and open your workspace. It works on any device
        and for one hour.
      </CheckInbox>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next: typeof errors = {
      name: values.name.trim() ? undefined : 'Enter your name.',
      // Invited people join the inviter's workspace, so they do not name one.
      company: invited || values.company.trim() ? undefined : 'Enter your company or studio name.',
      email: emailPattern.test(values.email.trim()) ? undefined : 'Enter a valid work email.',
      password: values.password.length >= 10 ? undefined : 'Use at least 10 characters.',
    }
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    void run(async () => {
      const result = await signUp({
        name: values.name.trim(),
        company: values.company.trim(),
        email: values.email.trim(),
        password: values.password,
      })
      if (result === 'confirm-email') setConfirmTo(values.email.trim())
    })
  }

  return (
    <form className="mc-auth-form" onSubmit={submit} noValidate>
      <div className="mc-auth-intro">
        {invited ? (
          <>
            <h1>Join your team</h1>
            <p>
              Create your account with the invited email. You join the workspace as soon as you
              confirm it.
            </p>
          </>
        ) : (
          <>
            <h1>Create your merchant account</h1>
            <p>
              Add a project for each app, get its key and see your first users in a few minutes.
            </p>
          </>
        )}
      </div>
      <FormError message={error} />
      <Field label="Your name" error={errors.name}>
        {(props) => (
          <input
            {...props}
            autoComplete="name"
            value={values.name}
            onChange={(event) => set('name', event.target.value)}
          />
        )}
      </Field>
      {!invited && (
        <Field
          label="Company or studio"
          hint="Your workspace is named after it."
          error={errors.company}
        >
          {(props) => (
            <input
              {...props}
              autoComplete="organization"
              value={values.company}
              onChange={(event) => set('company', event.target.value)}
            />
          )}
        </Field>
      )}
      <Field label="Work email" error={errors.email}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => set('email', event.target.value)}
          />
        )}
      </Field>
      <Field label="Password" hint="At least 10 characters." error={errors.password}>
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => set('password', event.target.value)}
          />
        )}
      </Field>
      <Submit busy={busy} idle="Create account" working="Creating your account" />
      <p className="mc-auth-switch">
        Already have an account?{' '}
        <a className="mc-link" href={href({ name: 'sign-in' })}>
          Sign in
        </a>
      </p>
    </form>
  )
}

function Recover() {
  const { recover } = useStore()
  const [email, setEmail] = useState('')
  const [invalid, setInvalid] = useState<string>()
  const [sentTo, setSentTo] = useState<string>()
  const { busy, error, run } = useSubmit()

  if (sentTo) {
    return (
      <CheckInbox email={sentTo}>
        If it belongs to a merchant account, the link in it lets you choose a new password.
      </CheckInbox>
    )
  }

  return (
    <form
      className="mc-auth-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!emailPattern.test(email.trim())) {
          setInvalid('Enter the email you sign in with.')
          return
        }
        setInvalid(undefined)
        void run(async () => {
          await recover(email.trim())
          setSentTo(email.trim())
        })
      }}
    >
      <div className="mc-auth-intro">
        <h1>Reset your password</h1>
        <p>
          Enter the email you sign in with and we will send you a link to choose a new password.
        </p>
      </div>
      <FormError message={error} />
      <Field label="Work email" error={invalid}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Submit busy={busy} idle="Send reset link" working="Sending" />
      <p className="mc-auth-switch">
        Remembered it?{' '}
        <a className="mc-link" href={href({ name: 'sign-in' })}>
          Sign in
        </a>
      </p>
    </form>
  )
}

function NewPassword() {
  const { updatePassword, status, notify } = useStore()
  const [password, setPassword] = useState('')
  const [invalid, setInvalid] = useState<string>()
  const { busy, error, run } = useSubmit()

  if (status === 'signed-out') {
    return (
      <div className="mc-auth-form">
        <div className="mc-auth-intro">
          <h1 tabIndex={-1} id="mc-page-title">
            This reset link has expired
          </h1>
          <p>Reset links work once and for a short time. Ask for a new one.</p>
        </div>
        <a className="mc-btn mc-btn-primary mc-btn-wide" href={href({ name: 'recover' })}>
          Send a new link
        </a>
      </div>
    )
  }

  return (
    <form
      className="mc-auth-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (password.length < 10) {
          setInvalid('Use at least 10 characters.')
          return
        }
        setInvalid(undefined)
        void run(async () => {
          await updatePassword(password)
          notify('Password changed')
          navigate({ name: 'home' }, true)
        })
      }}
    >
      <div className="mc-auth-intro">
        <h1>Choose a new password</h1>
        <p>You will stay signed in on this device.</p>
      </div>
      <FormError message={error} />
      <Field label="New password" hint="At least 10 characters." error={invalid}>
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <Submit busy={busy} idle="Save password" working="Saving" />
    </form>
  )
}

/** Where the sign-up confirmation email lands: confirms the address and opens the workspace. */
function ConfirmEmail({ token }: { token?: string }) {
  const { confirmEmail, resendConfirmation, status } = useStore()
  const [state, setState] = useState<'checking' | 'failed'>(token ? 'checking' : 'failed')
  const [message, setMessage] = useState<string>()
  const [email, setEmail] = useState('')
  const [invalid, setInvalid] = useState<string>()
  const [resentTo, setResentTo] = useState<string>()
  const resend = useSubmit()
  const started = useRef(false)

  useEffect(() => {
    // A token works once, so a second render must not spend it again.
    if (!token || started.current) return
    started.current = true
    confirmEmail(token)
      .then(() => navigate({ name: 'home' }, true))
      .catch((problem: unknown) => {
        setMessage(problem instanceof Error ? problem.message : undefined)
        setState('failed')
      })
  }, [confirmEmail, token])

  if (state === 'checking') {
    return (
      <div className="mc-auth-form" role="status">
        <LoaderCircle className="mc-spin mc-auth-icon" size={28} aria-hidden="true" />
        <div className="mc-auth-intro">
          <h1 tabIndex={-1} id="mc-page-title">
            Confirming your email
          </h1>
          <p>Your workspace opens in a moment.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mc-auth-form">
      <CircleAlert size={28} className="mc-auth-icon is-warning" aria-hidden="true" />
      <div className="mc-auth-intro">
        <h1 tabIndex={-1} id="mc-page-title">
          This link did not work
        </h1>
        <p>
          {message ?? 'This confirmation link has expired or was already used.'} If you already
          confirmed your email, sign in. Otherwise we can send a new link.
        </p>
      </div>
      {status === 'ready' ? (
        <a className="mc-btn mc-btn-primary mc-btn-wide" href={href({ name: 'home' })}>
          Open your workspace
        </a>
      ) : (
        <>
          <a className="mc-btn mc-btn-primary mc-btn-wide" href={href({ name: 'sign-in' })}>
            Sign in
          </a>
          <form
            className="mc-auth-resend-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (!emailPattern.test(email.trim())) {
                setInvalid('Enter the email you signed up with.')
                return
              }
              setInvalid(undefined)
              void resend.run(async () => {
                await resendConfirmation(email.trim())
                setResentTo(email.trim())
              })
            }}
          >
            <FormError message={resend.error} />
            {resentTo ? (
              <p className="mc-muted" role="status">
                Sent a new link to <strong>{resentTo}</strong>.
              </p>
            ) : (
              <>
                <Field label="Email for a new link" error={invalid}>
                  {(props) => (
                    <input
                      {...props}
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  )}
                </Field>
                <button
                  type="submit"
                  className="mc-btn mc-btn-secondary mc-btn-wide"
                  disabled={resend.busy}
                >
                  {resend.busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
                  {resend.busy ? 'Sending' : 'Send a new link'}
                </button>
              </>
            )}
          </form>
        </>
      )}
    </div>
  )
}

/** What a merchant gets, drawn as the product draws it. Labelled as an example. */
function ProfileExample() {
  return (
    <section className="mc-auth-fragment" data-ui aria-label="Example of a user profile">
      <p className="mc-fragment-label">Example</p>
      <div className="mc-fragment-person">
        <span className="mc-person-avatar-wrap">
          <Avatar id="example-amaka" name="Amaka Obi" size={40} />
          <span className="mc-online-badge" aria-label="Online now" />
        </span>
        <div>
          <strong>Amaka Obi</strong>
          <span className="mc-muted">Online now · on Lesson 4</span>
        </div>
      </div>
      <dl className="mc-fragment-facts">
        <div>
          <dt>Where</dt>
          <dd>Lagos, Nigeria · 14:32 local</dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>iPhone 15 · iOS 18.1 · app 2.4.0</dd>
        </div>
        <div>
          <dt>Came from</dt>
          <dd>Instagram ad, 12 days ago</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>9 sessions · 1 h 12 m in total</dd>
        </div>
      </dl>
      <ol className="mc-fragment-timeline">
        <li>
          <span className="mc-num">14:29</span>
          <span className="mc-mono">lesson_started</span>
        </li>
        <li>
          <span className="mc-num">14:31</span>
          <span className="mc-mono">answer_recorded</span>
        </li>
        <li>
          <span className="mc-num">14:32</span>
          <span className="mc-mono">streak_extended</span>
        </li>
      </ol>
      <p className="mc-fragment-replay">
        <Play size={14} aria-hidden="true" /> Session replay, 6 m 40 s
      </p>
    </section>
  )
}

export function AuthScreen({ route }: { route: AuthRoute }) {
  return (
    <div className="mc-auth">
      <div className="mc-auth-column">
        <a className="mc-brand" href={href({ name: 'sign-in' })} aria-label="KissMyApps Merchant">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <span className="mc-brand-text">
            <span className="mc-brand-word">
              Kissmyapps<span>.dev</span>
            </span>
            <span className="mc-brand-context">Merchant</span>
          </span>
        </a>
        <main id="mc-main" className="mc-auth-main">
          {route.name === 'sign-up' ? (
            <SignUp email={route.email} invited={route.invited} />
          ) : route.name === 'confirm-email' ? (
            <ConfirmEmail key={route.token ?? 'none'} token={route.token} />
          ) : route.name === 'recover' ? (
            <Recover />
          ) : route.name === 'new-password' ? (
            <NewPassword />
          ) : (
            <SignIn />
          )}
        </main>
      </div>
      <div className="mc-auth-aside">
        <ProfileExample />
      </div>
    </div>
  )
}
